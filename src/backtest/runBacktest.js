const { connectMongo, getDb } = require("../db");
const { collectionName } = require("../market/candleStore");
const { env } = require("../config");
const {
  evaluateSignalSetOnCandles,
  resetSignalLayerState,
} = require("../strategy/replayEngine");
const { estimateRoundTripCostInr } = require("../trading/costModel");
const { computeDynamicExitPlan } = require("../trading/dynamicExitManager");
const { createBacktestClock } = require("./clock");
const { buildOptionBacktestProvider } = require("./optionBacktest");
const { applyExecutionRealism, calibrateFromRecentTrades, seeded } = require("./executionRealism");
const { simulateOrderLifecycle } = require("./eventBrokerSimulator");
const { evaluateAcceptance } = require("./acceptanceEvaluator");
const { validateBacktestData, hasHardFailures } = require("./dataValidation");
const { buildMetrics, normalizeBacktestTrade } = require("./analytics");
const { classifyRegimeTags, primaryRegime } = require("./regimeClassifier");
const { buildReasonFlags, normalizeReasonCode, toReasonSummary } = require("./reasonCodes");
const { writeReportPack } = require("./reportWriter");
const { createRiskGovernor } = require("./riskGovernor");
const {
  buildBacktestTradePlan,
  buildCalibrationFallback,
  clamp01,
  createRunId,
  evaluateEodBoundary,
  gitHash,
  instrumentFromContract,
  isTargetEnabledForMode,
  pickEnvSnapshot,
  resolveExitPrice,
  upsertOptionManagedCandles,
} = require("./helpers");
const { createSignalCapture } = require("./signalCapture");

function buildQuery(config) {
  const query = { instrument_token: Number(config.data.token) };
  const from = new Date(config.data.from);
  const to = new Date(config.data.to);
  if (Number.isFinite(from.getTime()) || Number.isFinite(to.getTime())) {
    query.ts = {};
    if (Number.isFinite(from.getTime())) query.ts.$gte = from;
    if (Number.isFinite(to.getTime())) query.ts.$lte = to;
  }
  return query;
}

async function loadUnderlyingCandles({ db, config }) {
  const cursor = db.collection(collectionName(config.data.interval)).find(buildQuery(config)).sort({ ts: 1 });
  if (Number(config.data.limit || 0) > 0) cursor.limit(Number(config.data.limit));
  return cursor.toArray();
}

function latencyBars(config, calibration) {
  const delayMs = Math.max(Number(config.execution.delayMs || 0), Number(calibration?.avgFillLatencyMs || 0));
  return Math.max(0, Math.round(delayMs / (config.data.interval * 60 * 1000)));
}

function buildExecutionModel(config, calibration, tickSize, barLatency) {
  return {
    spreadBps: Number(config.execution.spreadBps || calibration?.avgSpreadBps || 0),
    slippageBps: Number(config.execution.slippageBps || 0) + Number(calibration?.avgEntrySlipBps || 0),
    partialFillProbability: clamp01(config.execution.partialFillProbability),
    minPartialFillRatio: clamp01(config.execution.minPartialFillRatio),
    eventBroker: Boolean(config.execution.eventBroker),
    latencyBars: Number(barLatency || 0),
    tickSize: Number(tickSize || 0.05),
  };
}

function buildSelectionRecord({ ts, sig, selectedContract, signalCandle }) {
  return {
    ts,
    strategyId: sig?.strategyId || null,
    signalOutcomeKey: sig?.signalOutcomeKey || null,
    selectedContractToken: selectedContract?.selectedToken || null,
    selectedStrike: selectedContract?.selected?.strike ?? null,
    selectedExpiry: selectedContract?.selected?.expiryISO || selectedContract?.selected?.expiry || null,
    selectedInstrument: selectedContract?.selected?.instrument || null,
    contractSelectionModel:
      selectedContract?.snapshot?.selectionModel ||
      selectedContract?.selected?.selectionModel ||
      null,
    contractSelectionParity:
      selectedContract?.snapshot?.parity ||
      (selectedContract?.snapshot?.liveEquivalent === false
        ? "NON_LIVE_EQUIVALENT"
        : null),
    usedCandleTs: signalCandle?.ts || null,
  };
}

function updateTradeExcursions(trade, candle) {
  const entry = Number(trade.entryPrice);
  const initialStop = Number(trade.initialStopLoss);
  const riskPoints = Math.abs(entry - initialStop);
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const close = Number(candle?.close);
  if (!(Number.isFinite(entry) && Number.isFinite(high) && Number.isFinite(low))) return;

  let favorablePoints = 0;
  let adversePoints = 0;
  if (trade.side === "BUY") {
    favorablePoints = Math.max(0, high - entry);
    adversePoints = Math.max(0, entry - low);
  } else {
    favorablePoints = Math.max(0, entry - low);
    adversePoints = Math.max(0, high - entry);
  }

  trade.MFE = Math.max(Number(trade.MFE || 0), favorablePoints);
  trade.MAE = Math.max(Number(trade.MAE || 0), adversePoints);
  const currentR =
    Number.isFinite(close) && riskPoints > 0
      ? trade.side === "BUY"
        ? (close - entry) / riskPoints
        : (entry - close) / riskPoints
      : 0;
  const peakR = riskPoints > 0 ? favorablePoints / riskPoints : 0;
  trade.peakR = Math.max(Number(trade.peakR || 0), peakR);
  trade.givebackR = Math.max(Number(trade.givebackR || 0), Number(trade.peakR || 0) - currentR);
}

function buildFallbackPlan({ side, entryPrice, rrTarget, slPct }) {
  const fallbackRiskPts = Math.max(0.05, entryPrice * (slPct / 100));
  const stopLoss = side === "BUY" ? entryPrice - fallbackRiskPts : entryPrice + fallbackRiskPts;
  const targetPrice = side === "BUY" ? entryPrice + rrTarget * fallbackRiskPts : entryPrice - rrTarget * fallbackRiskPts;
  return { stopLoss, targetPrice };
}

async function scanSignalSelections({ candles, config, optionProvider }) {
  resetSignalLayerState();
  const replaySlice = [];
  const selections = [];
  const intervalMin = Number(config.data.interval);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    replaySlice.push(candle);
    if (index < Number(config.data.warmup || 0)) continue;
    const signalSet = evaluateSignalSetOnCandles({
      candles: replaySlice,
      intervalMin,
      instrument_token: Number(config.data.token),
      now: new Date(candle.ts),
      recordTelemetry: false,
    });
    const sig = signalSet?.selectedSignal;
    if (!sig) continue;
    const selectedContract =
      config.data.mode === "OPT" && optionProvider?.ready
        ? optionProvider.selectContract({
            ts: candle.ts,
            underlyingPrice: Number(candle.close),
          })
        : null;
    const signalCandle =
      config.data.mode === "OPT" && selectedContract?.selectedToken
        ? optionProvider?.getCandleAtTs?.(selectedContract.selectedToken, candle.ts) || null
        : candle;
    selections.push(
      buildSelectionRecord({
        ts: candle.ts,
        sig,
        selectedContract,
        signalCandle,
      }),
    );
  }
  resetSignalLayerState();
  return selections;
}

function buildDataQualityDayMap(dataQualityReport = {}) {
  const map = new Map();
  for (const row of dataQualityReport.continuityByDay || []) map.set(String(row.day), row);
  return map;
}

async function prepareBacktestContext({ config, db, includeSignalScan = false }) {
  const candles = await loadUnderlyingCandles({ db, config });
  if (!candles.length) throw new Error("No candles found for query");

  const tokenInstrument = await db.collection("instruments_cache").findOne({
    instrument_token: Number(config.data.token),
  });

  const optionProvider =
    config.data.mode === "OPT" && config.data.dynamicContracts
      ? await buildOptionBacktestProvider({
          db,
          intervalMin: config.data.interval,
          from: new Date(config.data.from),
          to: new Date(config.data.to),
          underlyingToken: config.data.token,
          underlyingTradingsymbol: config.data.underlying,
          optionType: config.data.optionType,
          strikeStep: config.data.strikeStep,
          scanSteps: config.data.scanSteps,
          greeks: {
            enabled: config.data.greeksFilter,
            minDelta: config.data.minDelta,
            maxDelta: config.data.maxDelta,
            ivMax: config.data.ivMax,
          },
        })
      : null;

  const signalSelections = includeSignalScan ? await scanSignalSelections({ candles, config, optionProvider }) : [];
  const dataQualityReport =
    config.validation.dataQualityMode === "off"
      ? {
          generatedAt: new Date().toISOString(),
          hardFail: false,
          settings: {
            lookAheadGuardEnabled: Boolean(config.validation.lookAheadGuard),
          },
          summary: { totalIssues: 0, info: 0, warn: 0, fail: 0, byCode: {}, hardFail: false },
          continuityByDay: [],
          underlyingCoverage: {
            dayCount: 0,
            totalCandles: candles.length,
            expectedBars: 0,
            missingBars: 0,
            continuityPct: 100,
          },
          optionCoverageByDay: [],
          optionDatasetSummary: {},
          issues: [],
          samples: [],
        }
      : validateBacktestData({
          candles,
          intervalMin: config.data.interval,
          timezone: config.market.timezone,
          range: { from: config.data.from, to: config.data.to },
          underlyingToken: config.data.token,
          tokenInstrument,
          optionProvider,
          signalSelections,
          lookAheadGuard: config.validation.lookAheadGuard,
        });

  return {
    candles,
    tokenInstrument,
    optionProvider,
    signalSelections,
    dataQualityReport,
    dataQualityDayMap: buildDataQualityDayMap(dataQualityReport),
  };
}

function buildSignalLogRows({ config, ts, signalSet, selectedContract = null, regime = null }) {
  return (signalSet?.signals || []).map((signal) => ({
    ts,
    signalEventTs: signal.signalEventTs || signal.ts || ts,
    signalCreatedAt: signal.signalCreatedAt || null,
    signalOutcomeKey: signal.signalOutcomeKey || null,
    underlyingToken: Number(config.data.token),
    underlyingSymbol: config.data.underlying || null,
    strategyId: signal.strategyId || null,
    side: signal.side || null,
    regime: regime || signalSet?.regime || null,
    confidence: Number(signal.confidence ?? 0),
    selectedAsBestSignal: Boolean(signal.selectedAsBestSignal),
    consideredForEntry: Boolean(signal.selectedAsBestSignal),
    strategyStyle: signal.strategyStyle || null,
    strategyFamily: signal.strategyFamily || null,
    reason: signal.reason || null,
    setupId: signal.setupId || signal.meta?.setupId || null,
    selectedContractToken: signal.selectedAsBestSignal ? selectedContract?.selectedToken || null : null,
  }));
}

function buildAdmissionRow({ config, ts, signal, regime, selectedContract, reasonCode, preview, haltState }) {
  const summary = toReasonSummary(reasonCode);
  const admitted = summary.reasonCode === "ACCEPTED";
  const sizing = preview?.sizing || preview?.details || null;
  return {
    ts,
    signalOutcomeKey: signal.signalOutcomeKey || null,
    underlyingToken: Number(config.data.token),
    underlyingSymbol: config.data.underlying || null,
    strategyId: signal.strategyId || null,
    strategyStyle: signal.strategyStyle || null,
    side: signal.side || null,
    regime: regime || signal.regime || null,
    confidence: Number(signal.confidence ?? 0),
    admitted,
    rejectionReasonCode: admitted ? null : summary.reasonCode,
    rejectionReasonText: admitted ? null : summary.reasonText,
    ...buildReasonFlags(summary.reasonCode),
    intendedQty: sizing ? Number(sizing.requestedQty ?? sizing.allowedQty ?? sizing.qty ?? 0) : null,
    allowedQty: sizing ? Number(sizing.allowedQty ?? sizing.qty ?? 0) : 0,
    intendedRisk: sizing ? Number(sizing.intendedRisk ?? sizing.allowedRisk ?? sizing.riskInr ?? 0) : null,
    allowedRisk: sizing ? Number(sizing.allowedRisk ?? sizing.riskInr ?? 0) : 0,
    riskBudget: sizing ? Number(sizing.riskBudget ?? 0) : null,
    capitalBudget: sizing ? Number(sizing.capitalBudget ?? 0) : null,
    selectedContractToken: selectedContract?.selectedToken || null,
    selectedStrike: selectedContract?.selected?.strike ?? null,
    selectedExpiry: selectedContract?.selected?.expiryISO || selectedContract?.selected?.expiry || null,
    currentEquity: Number(haltState?.currentEquity ?? 0),
    freeCapital: Number(haltState?.freeCapital ?? 0),
    openRisk: Number(haltState?.openRisk ?? 0),
    tradesToday: Number(haltState?.tradesToday ?? 0),
    dailyPnL: Number(haltState?.dailyPnL ?? 0),
  };
}

function determineAdmissionReason({
  config,
  signal,
  selectedContract,
  signalCandle,
  preview,
  cooldownBlocked,
  staleSignal,
  dataQualityBlocked,
  liquidityBlocked,
}) {
  const allowedStrategies = config.strategy.allowedStrategies || [];
  if (allowedStrategies.length && !allowedStrategies.includes(signal.strategyId)) return "ALLOWED_STRATEGIES_BLOCK";
  if (Number(signal?.confidence || 0) < Number(config.strategy.confidenceMin || 0)) return "CONFIDENCE_TOO_LOW";
  if (cooldownBlocked) return "COOLDOWN_BLOCK";
  if (staleSignal) return "STALE_SIGNAL_BLOCK";
  if (config.data.mode === "OPT" && config.data.dynamicContracts && !selectedContract?.selectedToken) return "MISSING_OPTION_CONTRACT";
  if (!signalCandle) return "MISSING_TRADED_CANDLE";
  if (dataQualityBlocked) return "DATA_QUALITY_BLOCK";
  if (liquidityBlocked) return "MISSING_LIQUIDITY";
  if (!preview?.ok) return normalizeReasonCode(preview?.rejectionReason || "CAPITAL_OR_RISK_FIT_FAILED");
  return "ACCEPTED";
}

async function runBacktest({ config, db: providedDb = null } = {}) {
  if (!providedDb) await connectMongo();
  const db = providedDb || getDb();
  const context = await prepareBacktestContext({
    config,
    db,
    includeSignalScan: config.data.mode === "OPT" && config.data.dynamicContracts,
  });

  if (config.validation.dataQualityMode === "strict" && hasHardFailures(context.dataQualityReport)) {
    throw new Error(`Data quality validation failed with ${context.dataQualityReport.summary.fail} hard issues.`);
  }

  const runId = createRunId(config.runMeta.name, config.runMeta.seed);
  const calibration =
    config.execution.execRealism && config.execution.calibrationMode === "recent"
      ? { ...(await calibrateFromRecentTrades({ db, days: config.execution.calibrationDays })), source: "recent_trades" }
      : buildCalibrationFallback();
  const rng = seeded(config.runMeta.seed);
  const governor = createRiskGovernor({
    ...config.capital,
    ...config.risk,
    initialCapital: config.capital.startingCapital,
    timezone: config.market.timezone,
  });
  const clock = createBacktestClock(context.candles[0].ts);
  const fillLatencyBars = latencyBars(config, calibration);
  resetSignalLayerState();
  const signalCapture = createSignalCapture();

  const pendingEntries = [];
  let openTrades = [];
  const closedTrades = [];
  const signalLog = [];
  const admissionLog = [];
  const rejectionLog = [];
  const cooldownUntilByKey = new Map();
  const replaySlice = [];
  let tradeCounter = 0;

  for (let index = 0; index < context.candles.length; index += 1) {
    const candle = context.candles[index];
    replaySlice.push(candle);
    if (index < Number(config.data.warmup || 0)) continue;
    clock.set(candle.ts);
    const nowMs = clock.nowMs();

    const dueEntries = pendingEntries.filter((entry) => entry.executeAtIdx <= index);
    for (const pendingEntry of dueEntries) {
      const tradedCandle =
        config.data.mode === "OPT" && pendingEntry.selectedContract?.selectedToken
          ? context.optionProvider?.getCandleAtTs?.(pendingEntry.selectedContract.selectedToken, candle.ts) || null
          : candle;
      if (!tradedCandle) {
        governor.cancelReservation(pendingEntry.reservationId);
        continue;
      }

      const rawEntry = Number(tradedCandle.close);
      const execModel = buildExecutionModel(
        config,
        calibration,
        pendingEntry.instrument?.tick_size || pendingEntry.selectedContract?.selected?.instrument?.tick_size || 0.05,
        fillLatencyBars,
      );
      const exec = config.execution.execRealism
        ? config.execution.eventBroker
          ? simulateOrderLifecycle({
              side: pendingEntry.side,
              intent: { type: "MARKET", price: rawEntry },
              candle: tradedCandle,
              qty: pendingEntry.qty,
              nowTs: nowMs,
              model: execModel,
              rand: rng,
            })
          : applyExecutionRealism({
              side: pendingEntry.side,
              intendedPrice: rawEntry,
              candle: tradedCandle,
              qty: pendingEntry.qty,
              rand: rng,
              model: execModel,
            })
        : null;

      const entryPrice = Number(exec?.avgFillPrice ?? rawEntry);
      const filledQty = Number(exec?.filledQty ?? pendingEntry.qty);
      if (!(filledQty > 0 && Number.isFinite(entryPrice) && entryPrice > 0)) {
        governor.cancelReservation(pendingEntry.reservationId);
        continue;
      }

      const plan = buildBacktestTradePlan({
        mode: config.data.mode,
        config,
        intervalMin: config.data.interval,
        replaySlice,
        baseCandle: candle,
        pendingEntry,
        optionProvider: context.optionProvider,
        tradedCandle,
      });
      const fallback = buildFallbackPlan({
        side: pendingEntry.side,
        entryPrice,
        rrTarget: config.strategy.rrTarget,
        slPct: config.strategy.slPctFallback,
      });
      const stopLoss = Number.isFinite(Number(plan?.stopLoss)) ? Number(plan.stopLoss) : fallback.stopLoss;
      const targetPrice = isTargetEnabledForMode(config.data.mode, config)
        ? Number.isFinite(Number(plan?.targetPrice))
          ? Number(plan.targetPrice)
          : fallback.targetPrice
        : null;
      const riskInr = Math.abs(entryPrice - stopLoss) * filledQty;
      const capitalUsed = entryPrice * filledQty * Number(config.capital.marginMultiplier || 1);
      const tradeId = `${runId}_t${String(++tradeCounter).padStart(4, "0")}`;
      governor.activatePosition(pendingEntry.reservationId, tradeId, {
        capitalUsed,
        riskInr,
        ts: candle.ts,
      });

      openTrades.push({
        tradeId,
        signalOutcomeKey: pendingEntry.sig.signalOutcomeKey || null,
        side: pendingEntry.side,
        qty: filledQty,
        initialQty: filledQty,
        requestedQty: pendingEntry.previewSizing?.requestedQty ?? pendingEntry.qty,
        signalTs: pendingEntry.signalTs,
        entryPlacedAt: pendingEntry.signalTs,
        entryFilledAt: candle.ts,
        entryTs: candle.ts,
        entryIdx: index,
        plannedEntryPrice: pendingEntry.expectedEntryPrice,
        expectedEntryPrice: pendingEntry.expectedEntryPrice,
        entryPrice,
        lastLtp: entryPrice,
        stopLoss,
        initialStopLoss: stopLoss,
        targetPrice,
        initialTargetPrice: targetPrice,
        rr: Number.isFinite(Number(plan?.rr)) ? Number(plan.rr) : config.strategy.rrTarget,
        planMeta: plan?.meta || null,
        planOk: Boolean(plan?.ok),
        strategyId: pendingEntry.sig.strategyId,
        strategyStyle: pendingEntry.sig.strategyStyle || null,
        regime: pendingEntry.primaryRegime,
        regimeTags: pendingEntry.regimeTags,
        confidence: Number(pendingEntry.sig.confidence ?? 0),
        signalReason: pendingEntry.sig.reason || null,
        mode: config.data.mode,
        contractToken: pendingEntry.selectedContract?.selectedToken || Number(config.data.token),
        optionSnapshot: pendingEntry.selectedContract?.snapshot || null,
        option_meta:
          config.data.mode === "OPT"
            ? {
                optType: config.data.optionType,
                strike: Number(pendingEntry.selectedContract?.selected?.strike ?? 0) || null,
                expiry: pendingEntry.selectedContract?.selected?.expiryISO || pendingEntry.selectedContract?.selected?.expiry || null,
                underlyingToken: Number(config.data.token),
                underlyingLtp: Number(candle.close),
              }
            : null,
        executionModel: exec || null,
        entryExecutionModel: exec || null,
        instrument: pendingEntry.instrument,
        exitFills: [],
        realizedGrossPnl: 0,
        realizedCostInr: 0,
        realizedNetPnl: 0,
        riskInr,
        underlying_ltp: Number(candle.close),
        MAE: 0,
        MFE: 0,
        peakR: 0,
        givebackR: 0,
        beLockHit: false,
        greenLockActive: false,
        mfeLockTier: 0,
        trailHit: false,
        earlyFailArmed: false,
        earlyFailReason: null,
      });
    }

    pendingEntries.splice(
      0,
      pendingEntries.length,
      ...pendingEntries.filter((entry) => entry.executeAtIdx > index),
    );

    const nextOpenTrades = [];
    for (const trade of openTrades) {
      const tradedCandle =
        config.data.mode === "OPT" && trade.contractToken
          ? context.optionProvider?.getCandleAtTs?.(trade.contractToken, candle.ts) || null
          : candle;
      const managedCandles =
        config.data.mode === "OPT" && trade.contractToken
          ? upsertOptionManagedCandles({
              optionProvider: context.optionProvider,
              token: trade.contractToken,
              ts: candle.ts,
              trade,
            })
          : replaySlice;
      const ltp = Number(tradedCandle?.close);
      if (Number.isFinite(ltp) && ltp > 0) trade.lastLtp = ltp;

      const excursionCandle =
        tradedCandle ||
        (Number.isFinite(trade.lastLtp)
          ? {
              open: trade.lastLtp,
              high: trade.lastLtp,
              low: trade.lastLtp,
              close: trade.lastLtp,
              ts: candle.ts,
            }
          : null);
      if (excursionCandle) updateTradeExcursions(trade, excursionCandle);

      const plan = computeDynamicExitPlan({
        trade,
        ltp: Number.isFinite(ltp) && ltp > 0 ? ltp : Number(trade.lastLtp),
        candles: managedCandles,
        nowTs: nowMs,
        env,
        underlyingLtp: Number(candle.close),
      });
      if (plan?.tradePatch && Object.keys(plan.tradePatch).length) Object.assign(trade, plan.tradePatch);
      if (Number.isFinite(Number(plan?.sl?.stopLoss))) trade.stopLoss = Number(plan.sl.stopLoss);
      if (Number.isFinite(Number(plan?.target?.targetPrice))) trade.targetPrice = Number(plan.target.targetPrice);

      const pathExit = resolveExitPrice({
        side: trade.side,
        candle: excursionCandle,
        stopLoss: trade.stopLoss,
        targetPrice: isTargetEnabledForMode(config.data.mode, config) ? trade.targetPrice : null,
        conservative: Boolean(config.market.conservativePathExit),
      });

      if (!trade.pendingExit) {
        const forceExit = plan?.action?.exitNow;
        const eodBoundary = evaluateEodBoundary({
          candles: context.candles,
          idx: index,
          intervalMin: config.data.interval,
          timezone: config.market.timezone,
          forceEodExit: config.market.forceEodExit,
        });
        if (pathExit.hit || forceExit || eodBoundary.shouldExitNow) {
          const exitBasePx =
            eodBoundary.shouldExitNow && !pathExit.hit && !forceExit
              ? Number.isFinite(ltp) && ltp > 0
                ? ltp
                : Number(trade.lastLtp ?? candle.close)
              : forceExit
                ? Number.isFinite(ltp) && ltp > 0
                  ? ltp
                  : Number(trade.lastLtp ?? candle.close)
                : pathExit.price;
          trade.pendingExit = {
            executeAtIdx: index + fillLatencyBars,
            basePx: exitBasePx,
            reason: forceExit
              ? String(plan?.action?.reason || "DYNAMIC_EXIT")
              : eodBoundary.shouldExitNow && !pathExit.hit
                ? eodBoundary.reason
                : pathExit.reason,
          };
        }
      }

      if (trade.pendingExit && trade.pendingExit.executeAtIdx <= index) {
        const execModel = buildExecutionModel(config, calibration, trade.instrument?.tick_size || 0.05, fillLatencyBars);
        const exec = config.execution.execRealism
          ? config.execution.eventBroker
            ? simulateOrderLifecycle({
                side: trade.side === "BUY" ? "SELL" : "BUY",
                intent: { type: "MARKET", price: trade.pendingExit.basePx },
                candle: excursionCandle || candle,
                qty: trade.qty,
                nowTs: nowMs,
                model: execModel,
                rand: rng,
              })
            : applyExecutionRealism({
                side: trade.side === "BUY" ? "SELL" : "BUY",
                intendedPrice: trade.pendingExit.basePx,
                candle: excursionCandle || candle,
                qty: trade.qty,
                rand: rng,
                model: execModel,
              })
          : null;

        const exitPrice = Number(exec?.avgFillPrice ?? trade.pendingExit.basePx);
        const filledQty = Math.max(0, Math.min(Number(trade.qty || 0), Number(exec?.filledQty ?? trade.qty)));
        if (filledQty > 0 && Number.isFinite(exitPrice)) {
          const signed = trade.side === "BUY" ? 1 : -1;
          const grossPnl = (exitPrice - trade.entryPrice) * filledQty * signed;
          const costs = estimateRoundTripCostInr({
            entryPrice: (trade.entryPrice + exitPrice) / 2,
            qty: filledQty,
            spreadBps: 0,
            env,
            instrument: trade.instrument,
          });
          const netPnl = grossPnl - Number(costs.estCostInr ?? 0);

          trade.qty -= filledQty;
          trade.realizedGrossPnl += grossPnl;
          trade.realizedCostInr += Number(costs.estCostInr ?? 0);
          trade.realizedNetPnl += netPnl;
          trade.exitFills.push({
            ts: candle.ts,
            qty: filledQty,
            price: exitPrice,
            reason: trade.pendingExit.reason,
            executionModel: exec || null,
          });

          if (trade.qty <= 0) {
            governor.closePosition(trade.tradeId, { ts: candle.ts, netPnl: trade.realizedNetPnl });
            const finalized = {
              ...trade,
              qty: Number(trade.initialQty ?? 0),
              remainingQty: 0,
              exitTs: candle.ts,
              exitReason: normalizeReasonCode(trade.pendingExit.reason),
              exitPrice,
              grossPnl: Number(trade.realizedGrossPnl ?? 0),
              estCostInr: Number(trade.realizedCostInr ?? 0),
              netPnl: Number(trade.realizedNetPnl ?? 0),
              holdCandles: index - trade.entryIdx,
            };
            delete finalized._managedCandles;
            delete finalized._lastManagedTs;
            delete finalized.pendingExit;
            closedTrades.push(finalized);
            signalCapture.recordTradeOutcome({
              trade: finalized,
              signalOutcomeKey: finalized.signalOutcomeKey,
            });

            const cooldownKey = `${config.data.token}|${trade.strategyId}`;
            if (Number(config.risk.cooldownCandles || 0) > 0 && Number(finalized.netPnl || 0) < 0) {
              cooldownUntilByKey.set(cooldownKey, index + Number(config.risk.cooldownCandles));
            }
            continue;
          }
        }
        trade.pendingExit = null;
      }

      nextOpenTrades.push(trade);
    }
    openTrades = nextOpenTrades;
    governor.markToMarket(candle.ts, openTrades);

    const signalSet = evaluateSignalSetOnCandles({
      candles: replaySlice,
      intervalMin: config.data.interval,
      instrument_token: Number(config.data.token),
      now: clock.nowDate(),
      recordTelemetry: false,
      signalCapture,
    });
    if (!signalSet) continue;

    const selectedSignal = signalSet.selectedSignal;
    const selectedContract =
      config.data.mode === "OPT" && context.optionProvider?.ready
        ? context.optionProvider.selectContract({
            ts: candle.ts,
            underlyingPrice: Number(candle.close),
          })
        : null;
    signalLog.push(
      ...buildSignalLogRows({
        config,
        ts: candle.ts,
        signalSet,
        selectedContract,
        regime: signalSet.regime || "UNKNOWN",
      }),
    );
    if (!selectedSignal) continue;

    const side = String(selectedSignal.side || "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") continue;

    const signalCandle =
      config.data.mode === "OPT" && selectedContract?.selectedToken
        ? context.optionProvider?.getCandleAtTs?.(selectedContract.selectedToken, candle.ts) || null
        : candle;

    const pendingStub = {
      side,
      sig: selectedSignal,
      selectedContract,
    };
    const prePlan = signalCandle
      ? buildBacktestTradePlan({
          mode: config.data.mode,
          config,
          intervalMin: config.data.interval,
          replaySlice,
          baseCandle: candle,
          pendingEntry: pendingStub,
          optionProvider: context.optionProvider,
          tradedCandle: signalCandle,
        })
      : null;
    const fallback = buildFallbackPlan({
      side,
      entryPrice: Number(signalCandle?.close || candle.close),
      rrTarget: config.strategy.rrTarget,
      slPct: config.strategy.slPctFallback,
    });
    const plannedStopLoss = Number.isFinite(Number(prePlan?.stopLoss)) ? Number(prePlan.stopLoss) : fallback.stopLoss;
    const plannedEntryPrice = Number(signalCandle?.close || candle.close);
    const instrument = instrumentFromContract({
      fallbackToken: Number(config.data.token),
      fallbackInstrument: context.tokenInstrument,
      selected: selectedContract?.selected,
      mode: config.data.mode,
    });
    const preview = signalCandle
      ? governor.previewPosition({
          ts: candle.ts,
          entryPrice: plannedEntryPrice,
          stopLoss: plannedStopLoss,
          instrument,
          qtyMode: config.strategy.qtyMode,
          defaultQty: config.strategy.defaultQty,
          fixedQty: config.strategy.fixedQty,
          lotQty: config.strategy.lotQty,
        })
      : { ok: false, rejectionReason: "MISSING_TRADED_CANDLE" };
    const haltState = governor.getHaltState(candle.ts);
    const cooldownKey = `${config.data.token}|${selectedSignal.strategyId}`;
    const cooldownBlocked = Number(cooldownUntilByKey.get(cooldownKey) || -1) >= index;
    const staleSignalMs = Number(config.risk.staleSignalMs || config.risk.staleSignalBars * config.data.interval * 60 * 1000);
    const staleSignal = fillLatencyBars * config.data.interval * 60 * 1000 > staleSignalMs;
    const dayKey = new Date(candle.ts).toISOString().slice(0, 10);
    const dayQuality = context.dataQualityDayMap.get(dayKey) || null;
    const dataQualityBlocked =
      config.validation.dataQualityMode !== "off" && Boolean(dayQuality && (dayQuality.sessionViolations > 0 || dayQuality.missingBars > 0));
    const liquidityBlocked =
      config.data.mode === "OPT" &&
      Boolean(selectedContract?.selectedToken) &&
      (Number(selectedContract?.selected?.volume || 0) <= Number(config.execution.minOptionVolume || 0) ||
        Number(selectedContract?.selected?.close || 0) <= 0);
    const regimeTags = classifyRegimeTags({
      candles: replaySlice,
      currentCandle: candle,
      signal: selectedSignal,
      selectedContract,
      timezone: config.market.timezone,
    });
    const regime = primaryRegime(regimeTags, signalSet.regime || selectedSignal.regime || "UNKNOWN");
    const reasonCode = determineAdmissionReason({
      config,
      signal: selectedSignal,
      selectedContract,
      signalCandle,
      preview,
      cooldownBlocked,
      staleSignal,
      dataQualityBlocked,
      liquidityBlocked,
    });

    const decisionRow = buildAdmissionRow({
      config,
      ts: candle.ts,
      signal: selectedSignal,
      regime,
      selectedContract,
      reasonCode,
      preview,
      haltState,
    });
    admissionLog.push(decisionRow);
    if (!decisionRow.admitted) {
      signalCapture.recordRoutingDecision({
        signal: selectedSignal,
        accepted: false,
        routed: false,
        rejectionReason: decisionRow.rejectionReasonCode || reasonCode,
        selectedContract,
        decisionStage: "backtest_admission",
        decisionOutcome: "REJECTED",
        mode: config.data.mode,
        underlying: config.data.underlying,
      });
      rejectionLog.push(decisionRow);
      continue;
    }

    const reservationId = `${runId}_r${index}_${pendingEntries.length}`;
    governor.reservePosition(reservationId, preview);
    signalCapture.recordRoutingDecision({
      signal: selectedSignal,
      accepted: true,
      routed: true,
      rejectionReason: null,
      selectedContract,
      decisionStage: "backtest_admission",
      decisionOutcome: "ROUTED",
      mode: config.data.mode,
      underlying: config.data.underlying,
    });
    pendingEntries.push({
      executeAtIdx: index + fillLatencyBars,
      reservationId,
      signalTs: candle.ts,
      side,
      qty: preview.sizing.qty,
      previewSizing: preview.sizing,
      sig: selectedSignal,
      selectedContract,
      instrument,
      expectedEntryPrice: plannedEntryPrice,
      regimeTags,
      primaryRegime: regime,
    });
  }

  for (const pendingEntry of pendingEntries) governor.cancelReservation(pendingEntry.reservationId);

  const lastCandle = context.candles[context.candles.length - 1] || null;
  if (lastCandle) {
    for (const trade of openTrades) {
      const exitPrice = Number(lastCandle.close ?? trade.lastLtp ?? trade.entryPrice);
      const filledQty = Number(trade.qty ?? 0);
      if (!(filledQty > 0 && Number.isFinite(exitPrice) && exitPrice > 0)) continue;
      const signed = trade.side === "BUY" ? 1 : -1;
      const grossPnl = (exitPrice - trade.entryPrice) * filledQty * signed;
      const costs = estimateRoundTripCostInr({
        entryPrice: (trade.entryPrice + exitPrice) / 2,
        qty: filledQty,
        spreadBps: 0,
        env,
        instrument: trade.instrument,
      });
      const netPnl = grossPnl - Number(costs.estCostInr ?? 0);
      trade.realizedGrossPnl += grossPnl;
      trade.realizedCostInr += Number(costs.estCostInr ?? 0);
      trade.realizedNetPnl += netPnl;
      trade.exitFills.push({
        ts: lastCandle.ts,
        qty: filledQty,
        price: exitPrice,
        reason: "FORCE_EOD_END",
        executionModel: null,
      });
      governor.closePosition(trade.tradeId, { ts: lastCandle.ts, netPnl: trade.realizedNetPnl });
      const finalized = {
        ...trade,
        qty: Number(trade.initialQty ?? 0),
        remainingQty: 0,
        exitTs: lastCandle.ts,
        exitReason: "FORCE_EOD_END",
        exitPrice,
        grossPnl: Number(trade.realizedGrossPnl ?? 0),
        estCostInr: Number(trade.realizedCostInr ?? 0),
        netPnl: Number(trade.realizedNetPnl ?? 0),
        holdCandles: context.candles.length - 1 - Number(trade.entryIdx ?? 0),
      };
      delete finalized._managedCandles;
      delete finalized._lastManagedTs;
      delete finalized.pendingExit;
      closedTrades.push(finalized);
      signalCapture.recordTradeOutcome({
        trade: finalized,
        signalOutcomeKey: finalized.signalOutcomeKey,
      });
    }
    governor.markToMarket(lastCandle.ts, []);
  }

  const signalCaptureRows = signalCapture.getRows();

  const normalizedTrades = closedTrades.map((trade) =>
    normalizeBacktestTrade(trade, {
      mode: config.data.mode,
      underlying: config.data.underlying,
      underlyingToken: config.data.token,
    }),
  );
  const portfolioSummary = governor.getPortfolioStats(lastCandle?.ts || null);
  const analytics = buildMetrics(normalizedTrades, {
    startingCapital: config.capital.startingCapital,
    signalLog,
    admissionLog,
    rejectionLog,
    portfolioCurve: governor.getEquityCurve(),
    portfolioSummary,
  });
  const acceptanceReport = evaluateAcceptance({
    summary: analytics.summary,
    monthlyReport: analytics.monthlyReport,
    acceptanceConfig: config.validation.acceptance,
    rejectionLog,
    trades: normalizedTrades,
  });

  const reportPack = writeReportPack({
    runId,
    resolvedConfig: config,
    rawTrades: closedTrades,
    normalizedTrades,
    signalLog,
    admissionLog,
    rejectionLog,
    analytics,
    dataQualityReport: context.dataQualityReport,
    acceptanceReport,
    outputDir: config.reporting.outputDir,
  });

  if (config.reporting.persistMongo) {
    await db.collection("bt_runs").insertOne({
      runId,
      runAt: new Date().toISOString(),
      token: config.data.token,
      intervalMin: config.data.interval,
      range: {
        from: config.data.from,
        to: config.data.to,
        loadedCandles: context.candles.length,
      },
      gitHash: gitHash(),
      configSnapshot: pickEnvSnapshot(),
      resolvedConfig: config,
      dataQuality: context.dataQualityReport,
      summary: analytics.summary,
      executionReport: analytics.executionReport,
      acceptanceReport,
      signalLog,
      admissionLog,
      rejectionLog,
      signalCaptureRows,
      trades: closedTrades,
      normalizedTrades,
      artifactDir: reportPack.runDir,
    });
  }

  return {
    runId,
    artifactDir: reportPack.runDir,
    reportPack,
    summary: analytics.summary,
    metrics: analytics,
    acceptanceReport,
    dataQualityReport: context.dataQualityReport,
    signalLog,
    admissionLog,
    rejectionLog,
    signalCaptureRows,
    calibrationRecords: signalCapture.buildCalibrationRecords(),
    rawTrades: closedTrades,
    normalizedTrades,
    portfolioSummary,
    context,
  };
}

module.exports = {
  loadUnderlyingCandles,
  prepareBacktestContext,
  runBacktest,
  scanSignalSelections,
};
