// dynamicExitManager.js
// Computes dynamic SL/Target updates for an open trade.
//
// Pro upgrades:
// - "True breakeven": move SL to entry +/- estimated per-share costs (so BE exits aren't fee-negative)
// - Start trailing only after the trade has earned enough (reduces noise stopouts)
// - Options-aware fallbacks: premium % model + time-stop + coarse IV spike/crush heuristics
//
// Design goals:
// - Cash equities: never loosen risk (SL only trails in the direction of profit).
// - Options: allow *controlled* early widening if the initial SL is unrealistically tight for premium noise.
// - Update infrequently (throttle in TradeManager) to avoid rate-limits.
// - Keep broker validity constraints in mind (tick size, SL trigger relationships).

const { roundToTick } = require("./priceUtils");
const { atr, rollingVWAP, maxHigh, minLow } = require("../strategy/utils");
const {
  estimateTrueBreakEven,
} = require("./costModel");
const { applyLossContainmentExitRules } = require("./lossContainmentExit");
const { enrichDynamicExitPlan } = require("./proExitLayers");
const { resolveStrategyStopLoss } = require("./stopRiskSemantics");

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return n;
  if (Number.isFinite(lo)) n = Math.max(lo, n);
  if (Number.isFinite(hi)) n = Math.min(hi, n);
  return n;
}

function safeNum(v, fb = null) {
  if (v === null || v === undefined || v === "") return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function toFiniteOrNaN(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function tsFrom(v) {
  if (!v) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function isOptionTrade(trade) {
  if (!trade) return false;
  if (trade.option_meta || trade.optionMeta || trade.option) return true;

  const seg = String(trade.instrument?.segment || "").toUpperCase();
  if (seg.includes("OPT")) return true;

  const sym = String(trade.instrument?.tradingsymbol || "").toUpperCase();
  if (/\d(?:CE|PE)$/.test(sym)) return true;

  return false;
}

function optionType(trade) {
  const t =
    trade?.option_meta?.optType ||
    trade?.optionMeta?.optType ||
    trade?.option?.optType ||
    null;
  const s = String(t || "").toUpperCase();
  if (s === "CE" || s === "CALL") return "CE";
  if (s === "PE" || s === "PUT") return "PE";

  const sym = String(trade?.instrument?.tradingsymbol || "").toUpperCase();
  if (/\dCE$/.test(sym)) return "CE";
  if (/\dPE$/.test(sym)) return "PE";

  return null;
}

function computeBaseRisk(trade) {
  const entry = Number(trade.entryPrice ?? trade.candle?.close);
  const sl0 = Number(resolveStrategyStopLoss(trade));
  const risk = Math.abs(entry - sl0);
  return { entry, sl0, risk: Number.isFinite(risk) ? risk : 0 };
}

function resolveExecutionRiskState({ trade, entry, sl0, qty }) {
  const liveQty = Math.max(
    0,
    safeNum(qty, safeNum(trade?.qty, safeNum(trade?.initialQty, 0))),
  );
  const strategyStop = safeNum(resolveStrategyStopLoss(trade), NaN);
  const explicitRiskPts = safeNum(trade?.executionRiskPts, NaN);
  const actualRiskPts = safeNum(
    trade?.actualRiskPts ??
      trade?.riskStopPts ??
      trade?.initialStrategyRiskPts,
    NaN,
  );
  const priceRisk = Math.abs(safeNum(entry, NaN) - safeNum(sl0, NaN));
  const resolvedRiskPts = Number.isFinite(explicitRiskPts)
    ? explicitRiskPts
    : Number.isFinite(actualRiskPts)
      ? actualRiskPts
      : Number.isFinite(strategyStop) && Number.isFinite(entry)
        ? Math.abs(Number(entry) - strategyStop)
        : priceRisk;
  const storedRiskQty = Math.max(
    0,
    safeNum(trade?.executionRiskQty ?? trade?.riskQty, liveQty),
  );
  const storedRiskInr = safeNum(trade?.executionRiskInr, NaN);
  const riskInr =
    Number.isFinite(storedRiskInr) &&
    storedRiskInr > 0 &&
    storedRiskQty > 0 &&
    Math.abs(storedRiskQty - liveQty) < 0.5
      ? storedRiskInr
      : Number.isFinite(resolvedRiskPts) && resolvedRiskPts > 0 && liveQty > 0
        ? resolvedRiskPts * liveQty
        : safeNum(trade?.postFillTrueRiskInr, NaN) > 0 &&
            storedRiskQty > 0 &&
            liveQty > 0
          ? (safeNum(trade?.postFillTrueRiskInr, 0) / storedRiskQty) * liveQty
          : safeNum(trade?.riskInr, priceRisk * liveQty);

  return {
    riskPts: Number.isFinite(resolvedRiskPts) ? resolvedRiskPts : null,
    riskInr: Number.isFinite(riskInr) ? riskInr : null,
    riskQty: liveQty,
    source: Number.isFinite(explicitRiskPts)
      ? "EXECUTION_RISK_FIELDS"
      : Number.isFinite(actualRiskPts)
        ? "ACTUAL_RISK_FIELDS"
        : Number.isFinite(strategyStop)
          ? "STRATEGY_STOP_DISTANCE"
          : "PRICE_RISK_FALLBACK",
    budgetRiskInr: safeNum(trade?.riskInr, null),
  };
}

function profitR({ side, entry, ltp, risk }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !(risk > 0)) return 0;
  return side === "BUY" ? (ltp - entry) / risk : (entry - ltp) / risk;
}

function bestPeakLtp({ trade, ltp, side }) {
  const dbPeak = toFiniteOrNaN(trade?.peakLtp);
  if (Number.isFinite(dbPeak)) {
    if (side === "BUY") return Number.isFinite(ltp) ? Math.max(dbPeak, ltp) : dbPeak;
    if (side === "SELL") return Number.isFinite(ltp) ? Math.min(dbPeak, ltp) : dbPeak;
  }
  return Number.isFinite(ltp) ? ltp : null;
}

function profitPct({ side, entry, ltp }) {
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return 0;
  const raw = side === "BUY" ? (ltp - entry) / entry : (entry - ltp) / entry;
  return raw * 100;
}

function unrealizedPnlInr({ side, entry, ltp, qty }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !Number.isFinite(qty))
    return 0;
  if (side === "BUY") return (ltp - entry) * qty;
  return (entry - ltp) * qty;
}

function quoteTimestampMs(quote) {
  const raw =
    quote?.timestamp ??
    quote?.exchangeTimestamp ??
    quote?.last_trade_time ??
    quote?.exchange_timestamp ??
    quote?.fetchedAtMs ??
    null;
  return tsFrom(raw);
}

function spreadBpsFromQuote(quote) {
  const bid = safeNum(quote?.bid, NaN);
  const ask = safeNum(quote?.ask, NaN);
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid)) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 10000;
}

function optionAdverseUnderlyingBps({ trade, underlyingLtp }) {
  const moveBps = underlyingMoveBps({ trade, underlyingLtp });
  if (!Number.isFinite(moveBps)) return null;
  const opt = optionType(trade);
  if (opt === "PE") return moveBps > 0 ? moveBps : 0;
  return moveBps < 0 ? Math.abs(moveBps) : 0;
}

function resolveOptionWidenStructureState({ trade, ltp, underlyingLtp, sl0, env }) {
  const tick = Math.max(0.01, safeNum(trade?.instrument?.tick_size, 0.05));
  const underlyingStop = safeNum(trade?.planMeta?.underlying?.stop, NaN);
  const underlyingObserved = safeNum(underlyingLtp, NaN);
  if (Number.isFinite(underlyingStop) && Number.isFinite(underlyingObserved)) {
    const breach =
      String(trade?.side || "BUY").toUpperCase() === "SELL"
        ? underlyingObserved - underlyingStop
        : underlyingStop - underlyingObserved;
    const buffer =
      Math.max(
        0,
        safeNum(
          env.OPT_EXIT_WIDEN_STRUCTURE_BUFFER_POINTS,
          safeNum(env.EARLY_STRUCTURE_FAIL_BUFFER_POINTS, 0),
        ),
      ) +
      Math.max(
        0,
        safeNum(
          env.OPT_EXIT_WIDEN_STRUCTURE_BUFFER_TICKS,
          safeNum(env.EARLY_STRUCTURE_FAIL_BUFFER_TICKS, 6),
        ),
      ) *
        tick;
    return {
      failing: Number.isFinite(breach) && breach > buffer,
      referenceKind: "UNDERLYING",
      breachAmount: Number.isFinite(breach) ? breach : null,
      bufferUsed: buffer,
    };
  }

  const premiumStop = safeNum(resolveStrategyStopLoss(trade) ?? sl0, NaN);
  const premiumObserved = safeNum(ltp, NaN);
  const breach =
    String(trade?.side || "BUY").toUpperCase() === "SELL"
      ? premiumObserved - premiumStop
      : premiumStop - premiumObserved;
  const buffer =
    Math.max(
      0,
      safeNum(
        env.OPT_EXIT_WIDEN_STRUCTURE_BUFFER_POINTS,
        safeNum(env.EARLY_STRUCTURE_FAIL_BUFFER_POINTS, 0),
      ),
    ) +
    Math.max(
      0,
      safeNum(
        env.OPT_EXIT_WIDEN_STRUCTURE_BUFFER_TICKS,
        safeNum(env.EARLY_STRUCTURE_FAIL_BUFFER_TICKS, 6),
      ),
    ) *
      tick;
  return {
    failing:
      Number.isFinite(premiumStop) &&
      Number.isFinite(premiumObserved) &&
      Number.isFinite(breach) &&
      breach > buffer,
    referenceKind: "PREMIUM",
    breachAmount: Number.isFinite(breach) ? breach : null,
    bufferUsed: buffer,
  };
}

function evaluateOptionWidenEligibility({
  trade,
  holdMin,
  env,
  ltp,
  underlyingLtp,
  marketQuote,
  sl0,
  nowTs = Date.now(),
}) {
  const enabled =
    String(env.OPT_EXIT_ALLOW_WIDEN_SL || "true") === "true" &&
    holdMin <= Number(env.OPT_EXIT_WIDEN_WINDOW_MIN ?? 2);
  if (!enabled) {
    return {
      allowed: false,
      reason: "WIDEN_WINDOW_CLOSED",
      spreadBps: spreadBpsFromQuote(marketQuote),
      adverseUnderlyingBps: optionAdverseUnderlyingBps({ trade, underlyingLtp }),
      structureFailing: false,
      referenceKind: null,
      breachAmount: null,
      bufferUsed: null,
      quoteFreshnessMs: null,
    };
  }

  const persistedEarlyFail =
    Boolean(trade?.earlyFailReason) ||
    Boolean(trade?.earlyFailCandidateReason) ||
    ["CONFIRMING", "EXIT_AUTHORIZED"].includes(
      String(trade?.earlyFailDecisionState || "").toUpperCase(),
    );
  const adverseUnderlyingBps = optionAdverseUnderlyingBps({ trade, underlyingLtp });
  const maxAdverseUnderlyingBps = Number(
    env.OPT_EXIT_WIDEN_MAX_ADVERSE_UNDERLYING_BPS ?? 18,
  );
  const structureState = resolveOptionWidenStructureState({
    trade,
    ltp,
    underlyingLtp,
    sl0,
    env,
  });
  const spreadBps = spreadBpsFromQuote(marketQuote);
  const maxSpreadBps = Number(
    env.OPT_EXIT_WIDEN_MAX_EXEC_SPREAD_BPS ??
      env.DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS ??
      120,
  );
  const quoteFreshnessMs = (() => {
    const ts = quoteTimestampMs(marketQuote);
    if (!Number.isFinite(ts)) return null;
    return Math.max(0, Number(nowTs) - ts);
  })();
  const freshnessLimitMs = Math.max(
    0,
    Number(env.OPT_EXIT_WIDEN_MAX_QUOTE_AGE_MS ?? 2_500),
  );
  const bookUsable =
    Number.isFinite(safeNum(marketQuote?.bid, NaN)) &&
    Number.isFinite(safeNum(marketQuote?.ask, NaN)) &&
    safeNum(marketQuote?.bid, 0) > 0 &&
    safeNum(marketQuote?.ask, 0) >= safeNum(marketQuote?.bid, 0) &&
    Number.isFinite(spreadBps) &&
    spreadBps <= maxSpreadBps &&
    (!Number.isFinite(quoteFreshnessMs) || quoteFreshnessMs <= freshnessLimitMs);

  let reason = null;
  if (persistedEarlyFail) reason = "EARLY_FAIL_ACTIVE";
  else if (structureState.failing) reason = "THESIS_INVALIDATING_STRUCTURE_BREAK";
  else if (
    Number.isFinite(adverseUnderlyingBps) &&
    adverseUnderlyingBps > maxAdverseUnderlyingBps
  ) {
    reason = "ADVERSE_UNDERLYING_DRIFT";
  } else if (!bookUsable) {
    reason = "EXECUTION_BOOK_UNACCEPTABLE";
  }

  return {
    allowed: reason == null,
    reason,
    spreadBps,
    adverseUnderlyingBps,
    structureFailing: Boolean(structureState.failing),
    referenceKind: structureState.referenceKind,
    breachAmount: structureState.breachAmount,
    bufferUsed: structureState.bufferUsed,
    quoteFreshnessMs,
  };
}

function meetsThreshold(value, threshold, epsilon = 0) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) {
    return false;
  }
  const eps = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0;
  return value + eps >= threshold;
}

function computeTargetFromRisk({ side, entry, risk, rr, tick }) {
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(risk) ||
    risk <= 0
  )
    return null;
  const raw = side === "BUY" ? entry + rr * risk : entry - rr * risk;
  return roundToTick(raw, tick, side === "BUY" ? "up" : "down");
}

function improvesStop(side, candidate, reference, epsilon = 0) {
  if (!Number.isFinite(candidate)) return false;
  if (!Number.isFinite(reference)) return true;
  const eps = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0;
  return side === "BUY"
    ? candidate > reference + eps
    : candidate < reference - eps;
}

function betterStop(side, current, candidate) {
  if (!Number.isFinite(candidate)) return current;
  if (!Number.isFinite(current)) return candidate;
  return side === "BUY"
    ? Math.max(current, candidate)
    : Math.min(current, candidate);
}

function pickStopCandidate(side, candidates = []) {
  let price = null;
  let source = null;
  for (const candidate of candidates) {
    const next = Number(candidate?.price);
    if (!Number.isFinite(next)) continue;
    if (!Number.isFinite(price) || improvesStop(side, next, price)) {
      price = next;
      source = candidate?.source ?? null;
    }
  }
  return {
    price: Number.isFinite(price) ? price : null,
    source,
  };
}

function estimateTrueBreakeven({ trade, entry, side, tick, env }) {
  const qty = Number(trade.qty ?? trade.initialQty ?? 0);
  const spreadBps = Number(trade?.quoteAtEntry?.bps ?? 0);
  const mult = Number(env.DYN_BE_COST_MULT ?? 1.0);
  const out = estimateTrueBreakEven({
    entryPrice: entry,
    qty,
    side,
    tick,
    spreadBps,
    env,
    instrument: trade?.instrument || null,
    costMultiplier: mult,
  });

  const be = Number.isFinite(out?.price)
    ? out.price
    : roundToTick(entry, tick, side === "BUY" ? "up" : "down");
  return {
    be,
    meta: {
      qty,
      estCostInr: Number(out?.estCostInr ?? 0),
      costPerShare:
        Number.isFinite(out?.estCostInr) && qty > 0
          ? Number(out.estCostInr) / qty
          : 0,
      spreadBps,
      mult,
      costMeta: out?.meta || null,
    },
  };
}

function patchIfChanged(patch, trade, key, value, epsilon = 0) {
  if (value === undefined) return;
  const current = trade?.[key];
  if (value instanceof Date) {
    if (String(current || "") !== value.toISOString()) patch[key] = value;
    return;
  }
  if (typeof value === "boolean") {
    if (Boolean(current) !== value) patch[key] = value;
    return;
  }
  if (typeof value === "string") {
    if (String(current || "") !== value) patch[key] = value;
    return;
  }
  if (Number.isFinite(value)) {
    const curNum = Number(current);
    if (!Number.isFinite(curNum) || Math.abs(curNum - value) > Math.max(0, epsilon)) {
      patch[key] = value;
    }
    return;
  }
  if (current !== value) patch[key] = value;
}

function applyMinGreenExitRules({
  trade,
  ltp,
  underlyingLtp,
  marketQuote,
  now,
  env,
  basePlan,
  entry,
  sl0,
  side,
  tick,
}) {
  const qty = Number(trade?.qty ?? trade?.initialQty ?? 0);
  const minGreenEnabled = String(env.MIN_GREEN_ENABLED || "true") === "true";
  const minGreenInr = minGreenEnabled ? Number(trade?.minGreenInr ?? 0) : 0;
  const minGreenPts = minGreenEnabled ? Number(trade?.minGreenPts ?? 0) : 0;
  const minGreenRequired =
    minGreenEnabled && Number.isFinite(minGreenInr) && minGreenInr > 0;

  const curSL = Number(trade?.stopLoss ?? sl0);
  let newSL =
    basePlan?.sl?.stopLoss && Number.isFinite(basePlan.sl.stopLoss)
      ? Number(basePlan.sl.stopLoss)
      : curSL;

  const tradePatch = { ...(basePlan?.tradePatch || {}) };

  const pnlInr = unrealizedPnlInr({ side, entry, ltp, qty });
  const executionRisk = resolveExecutionRiskState({ trade, entry, sl0, qty });
  const riskPerTradeInr = Number(
    executionRisk?.riskInr ?? trade?.riskInr ?? env.RISK_PER_TRADE_INR ?? 0,
  );
  const pnlR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? pnlInr / riskPerTradeInr
      : null;
  const priceRisk = Math.abs(entry - sl0);
  const pnlPriceR = profitR({ side, entry, ltp, risk: priceRisk });
  const peakLtpNow = bestPeakLtp({ trade, ltp, side });
  const peakPnlFromPriceInr = Number.isFinite(peakLtpNow)
    ? unrealizedPnlInr({ side, entry, ltp: peakLtpNow, qty })
    : null;
  const prevPeakPnlInr = toFiniteOrNaN(trade?.peakPnlInr);
  const peakPnlInr = Number.isFinite(prevPeakPnlInr)
    ? Math.max(prevPeakPnlInr, pnlInr, toFiniteOrNaN(peakPnlFromPriceInr))
    : Math.max(pnlInr, toFiniteOrNaN(peakPnlFromPriceInr));
  const peakPnlR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? peakPnlInr / riskPerTradeInr
      : null;
  const peakPriceR = Number.isFinite(peakLtpNow)
    ? profitR({ side, entry, ltp: peakLtpNow, risk: priceRisk })
    : null;
  const mfeR = Math.max(toFiniteOrNaN(peakPnlR), toFiniteOrNaN(peakPriceR));
  const peakRForRules = Number.isFinite(mfeR)
    ? mfeR
    : Number.isFinite(peakPnlR)
      ? peakPnlR
      : peakPriceR;
  const pnlRForRules = Number.isFinite(pnlR) ? pnlR : pnlPriceR;
  const minGreenSatisfied =
    !minGreenRequired ||
    (Number.isFinite(pnlInr) && pnlInr >= minGreenInr);
  if (!Number.isFinite(prevPeakPnlInr) || Math.abs(peakPnlInr - prevPeakPnlInr) >= Math.max(1, tick * qty)) {
    tradePatch.peakPnlInr = peakPnlInr;
  }

  const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
  const noProgressMin = Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0);
  const noProgressMfeR = Number(env.TIME_STOP_NO_PROGRESS_MFE_R ?? 0.2);
  const noProgressUnderlyingConfirm =
    String(
      env.TIME_STOP_NO_PROGRESS_REQUIRE_UL_CONFIRM ||
        env.TIME_STOP_NO_PROGRESS_UNDERLYING_CONFIRM ||
        "true",
    ) === "true";
  const noProgressUnderlyingConfirmEffective =
    noProgressUnderlyingConfirm && isOptionTrade(trade);
  const noProgressUnderlyingMode = String(
    env.TIME_STOP_NO_PROGRESS_UL_MODE || "STRICT",
  )
    .trim()
    .toUpperCase();
  const noProgressUnderlyingBps = Number(
    env.TIME_STOP_NO_PROGRESS_UL_BPS ??
      env.TIME_STOP_NO_PROGRESS_UNDERLYING_MFE_BPS ??
      12,
  );
  const maxHoldMin = Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0);
  const maxHoldSkipIfPnlR = Number(env.TIME_STOP_MAX_HOLD_SKIP_IF_PNL_R ?? 0.8);
  const maxHoldSkipIfPeakR = Number(
    env.TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_R ?? env.TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_PNL_R ?? 1.0,
  );
  const maxHoldSkipIfLocked =
    String(env.TIME_STOP_MAX_HOLD_SKIP_IF_LOCKED || "true") !== "false";
  const proTimeStopsEnabled =
    (Number.isFinite(noProgressMin) && noProgressMin > 0) ||
    (Number.isFinite(maxHoldMin) && maxHoldMin > 0);
  const entryTs =
    tsFrom(trade?.entryFilledAt) ||
    tsFrom(trade?.createdAt || trade?.updatedAt) ||
    now;
  const holdMin = Math.max(0, (now - entryTs) / (60 * 1000));
  const timeStopAtMs =
    Number.isFinite(timeStopMin) && timeStopMin > 0
      ? entryTs + timeStopMin * 60 * 1000
      : null;
  const timeStopLatched = Boolean(trade?.timeStopTriggeredAt);

  const beArmR = Number(env.BE_ARM_R ?? 0.6);
  const beArmCostMult = Number(env.BE_ARM_COST_MULT ?? 2.0);
  const trailArmR = Number(env.TRAIL_ARM_R ?? 1.0);
  const earlyWinnerEnabled =
    String(env.EARLY_WINNER_RETENTION_ENABLED ?? "true") === "true";
  const pnlStepInr = Number.isFinite(qty) && qty > 0 && Number.isFinite(tick) && tick > 0
    ? qty * tick
    : 0;
  const estCostInr = toFiniteOrNaN(basePlan?.meta?.trueBEMeta?.estCostInr);
  const beLockAtFromR =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 ? beArmR * riskPerTradeInr : null;
  const beLockAtFromCost =
    Number.isFinite(estCostInr) && estCostInr > 0 && Number.isFinite(beArmCostMult) && beArmCostMult > 0
      ? beArmCostMult * estCostInr
      : null;
  const beLockAtFallback = Number(env.BE_LOCK_AT_PROFIT_INR ?? 0);
  const beLockAt = Math.max(
    Number.isFinite(beLockAtFromR) ? beLockAtFromR : 0,
    Number.isFinite(beLockAtFromCost) ? beLockAtFromCost : 0,
    Number.isFinite(beLockAtFallback) ? beLockAtFallback : 0,
  );
  const trailStartInr =
    Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0
      ? trailArmR * riskPerTradeInr
      : Number(env.DYN_TRAIL_START_PROFIT_INR ?? 0);
  const beArmEpsInr = pnlStepInr;
  const trailArmEpsInr = pnlStepInr;

  const underlyingMoveBpsNow = underlyingMoveBps({ trade, underlyingLtp });
  const absUnderlyingMoveBps = Number.isFinite(underlyingMoveBpsNow)
    ? Math.abs(underlyingMoveBpsNow)
    : null;
  const prevPeakUnderlyingMoveBps = toFiniteOrNaN(trade?.peakUnderlyingMoveBps);
  const peakUnderlyingMoveBps = Number.isFinite(prevPeakUnderlyingMoveBps)
    ? Math.max(prevPeakUnderlyingMoveBps, toFiniteOrNaN(absUnderlyingMoveBps))
    : absUnderlyingMoveBps;
  const hasUnderlyingMove = Number.isFinite(absUnderlyingMoveBps);
  const noProgressUnderlyingSatisfied =
    !noProgressUnderlyingConfirmEffective ||
    !Number.isFinite(noProgressUnderlyingBps) ||
    (hasUnderlyingMove && absUnderlyingMoveBps < noProgressUnderlyingBps) ||
    (!hasUnderlyingMove &&
      noProgressUnderlyingMode === "PRICE_ONLY_ON_UNKNOWN");
  if (
    Number.isFinite(peakUnderlyingMoveBps) &&
    (!Number.isFinite(prevPeakUnderlyingMoveBps) ||
      Math.abs(peakUnderlyingMoveBps - prevPeakUnderlyingMoveBps) >= 0.5)
  ) {
    tradePatch.peakUnderlyingMoveBps = peakUnderlyingMoveBps;
  }

  if (
    !timeStopLatched &&
    !proTimeStopsEnabled &&
    Number.isFinite(timeStopAtMs) &&
    now >= timeStopAtMs &&
    pnlInr < minGreenInr
  ) {
    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopAtMs,
        pnlInr,
        minGreenInr,
        timeStopKind: "LEGACY",
        holdMin,
        peakPnlInr,
        peakPnlR,
      },
    };
  }

  if (
    !timeStopLatched &&
    proTimeStopsEnabled &&
    Number.isFinite(noProgressMin) &&
    noProgressMin > 0 &&
    holdMin >= noProgressMin &&
    Number.isFinite(noProgressMfeR) &&
    Number.isFinite(mfeR) &&
    mfeR < noProgressMfeR &&
    noProgressUnderlyingSatisfied
  ) {
    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP_NO_PROGRESS" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopKind: "NO_PROGRESS",
        holdMin,
        noProgressMin,
        noProgressMfeR,
        noProgressUnderlyingConfirm: noProgressUnderlyingConfirmEffective,
        noProgressUnderlyingBps,
        noProgressUnderlyingStatus: noProgressUnderlyingConfirmEffective
          ? hasUnderlyingMove
            ? "KNOWN"
            : "UNKNOWN"
          : "BYPASSED",
        noProgressUnderlyingMode,
        mfeR,
        underlyingMoveBps: underlyingMoveBpsNow,
        absUnderlyingMoveBps,
        peakUnderlyingMoveBps,
        peakPnlInr,
        peakPnlR,
        peakPriceR,
        pnlInr,
        pnlR,
        pnlPriceR,
      },
    };
  }

  const maxHoldActive =
    !timeStopLatched &&
    proTimeStopsEnabled &&
    Number.isFinite(maxHoldMin) &&
    maxHoldMin > 0 &&
    holdMin >= maxHoldMin;

  const beThresholdHit = meetsThreshold(pnlInr, beLockAt, beArmEpsInr);
  const trailThresholdHit = meetsThreshold(pnlInr, trailStartInr, trailArmEpsInr);
  const beEligible = Boolean(minGreenSatisfied && beThresholdHit);
  const trailEligible = Boolean(minGreenSatisfied && trailThresholdHit);
  const beAppliedAtTs = tsFrom(trade?.beAppliedAt);
  const beAppliedStopLoss = toFiniteOrNaN(trade?.beAppliedStopLoss);
  const persistedBeApplied =
    Number.isFinite(beAppliedAtTs) && Number.isFinite(beAppliedStopLoss);
  let beApplied = false;
  const skipReasons = [];

  if (beEligible && !trade?.beLocked) {
    tradePatch.beLocked = true;
    tradePatch.beLockedAt = new Date(now);
  }
  if (trailEligible && !trade?.trailLocked) {
    tradePatch.trailLocked = true;
    tradePatch.trailLockedAt = new Date(now);
  }

  // Latched behaviour: once armed, these states must remain active until trade closes.
  const beArmedNow = Boolean(tradePatch.beLocked || trade?.beLocked || beEligible);
  const trailArmedNow = Boolean(
    tradePatch.trailLocked || trade?.trailLocked || trailEligible,
  );
  const tp1TrailOverride = Boolean(trade?.tp1Done);

  const trailGapPreBePct = Number(env.TRAIL_GAP_PRE_BE_PCT ?? 0.08);
  const trailGapPostBePct = Number(env.TRAIL_GAP_POST_BE_PCT ?? 0.04);
  const trailTightenR = Number(env.TRAIL_TIGHTEN_R ?? 1.5);
  const trailGapPostBePctTight = Number(env.TRAIL_GAP_POST_BE_PCT_TIGHT ?? trailGapPostBePct);
  const trailGapMinPts = Number(env.TRAIL_GAP_MIN_PTS ?? 2);
  const trailGapMaxPts = Number(env.TRAIL_GAP_MAX_PTS ?? 10);
  const beBufferTicks = safeNum(env.BE_BUFFER_TICKS, safeNum(env.DYN_BE_BUFFER_TICKS, 1));
  const triggerBufferTicks = Number(env.TRIGGER_BUFFER_TICKS ?? 1);

  const trueBE = toFiniteOrNaN(basePlan?.meta?.trueBE);
  const trueBeFloor =
    beArmedNow && Number.isFinite(trueBE)
      ? roundToTick(
          side === "BUY"
            ? trueBE + beBufferTicks * tick
            : trueBE - beBufferTicks * tick,
          tick,
          side === "BUY" ? "up" : "down",
        )
      : null;
  const minGreenFloor =
    beArmedNow &&
    minGreenSatisfied &&
    Number.isFinite(entry) &&
    Number.isFinite(minGreenPts) &&
    minGreenPts > 0
      ? roundToTick(
          side === "BUY" ? entry + minGreenPts : entry - minGreenPts,
          tick,
          side === "BUY" ? "up" : "down",
        )
      : null;
  let beProfitLockFloor = null;

  if (beArmedNow && Number.isFinite(entry) && Number.isFinite(qty) && qty > 0) {
    const beLockKeepR = Number(env.BE_PROFIT_LOCK_KEEP_R ?? env.PROFIT_LOCK_KEEP_R ?? 0.25);
    const beLockCostMult = Number(env.BE_PROFIT_LOCK_COST_MULT ?? env.PROFIT_LOCK_COST_MULT ?? 1.0);
    const beLockMinInr = Number(env.BE_PROFIT_LOCK_MIN_INR ?? env.PROFIT_LOCK_MIN_INR ?? 0);
    const lockByR =
      Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 && Number.isFinite(beLockKeepR) && beLockKeepR > 0
        ? beLockKeepR * riskPerTradeInr
        : 0;
    const lockByCost =
      Number.isFinite(estCostInr) && estCostInr > 0 && Number.isFinite(beLockCostMult) && beLockCostMult > 0
        ? beLockCostMult * estCostInr
        : 0;
    const lockInr = Math.max(lockByR, lockByCost, Number.isFinite(beLockMinInr) ? beLockMinInr : 0);
    if (Number.isFinite(lockInr) && lockInr > 0) {
      const lockPts = lockInr / qty;
      const raw = side === "BUY" ? entry + lockPts : entry - lockPts;
      beProfitLockFloor = roundToTick(raw, tick, side === "BUY" ? "up" : "down");
      tradePatch.beProfitLockInr = lockInr;
      tradePatch.beProfitLockKeepR = beLockKeepR;
      tradePatch.beProfitLockCostMult = beLockCostMult;
    }
  }

  const beFloorCandidate = beArmedNow
    ? pickStopCandidate(side, [
        { price: trueBeFloor, source: "TRUE_BE" },
        { price: minGreenFloor, source: "MIN_GREEN" },
        ...(!earlyWinnerEnabled && Number.isFinite(beProfitLockFloor)
          ? [{ price: beProfitLockFloor, source: "BE_PROFIT_LOCK" }]
          : []),
      ])
    : { price: null, source: null };
  const beFloor = Number.isFinite(beFloorCandidate?.price)
    ? Number(beFloorCandidate.price)
    : null;
  const beFloorSource =
    beArmedNow && Number.isFinite(beFloorCandidate?.price)
      ? beFloorCandidate?.source ?? null
      : null;
  let protectedStopSource = null;

  if (beArmedNow && Number.isFinite(beFloor)) {
    if (improvesStop(side, beFloor, newSL, tick / 2)) {
      protectedStopSource = beFloorSource;
    }
    newSL = betterStop(side, newSL, beFloor);
    patchIfChanged(tradePatch, trade, "beLockedAtPrice", beFloor, tick / 2);
  }

  if (beArmedNow && Number.isFinite(beFloor)) {
    const brokerProtectedStop = Number.isFinite(beAppliedStopLoss)
      ? beAppliedStopLoss
      : curSL;
    if (Number.isFinite(brokerProtectedStop)) {
      beApplied = side === "BUY"
        ? brokerProtectedStop >= beFloor
        : brokerProtectedStop <= beFloor;
    } else {
      beApplied = persistedBeApplied;
    }
  } else {
    beApplied = persistedBeApplied;
  }

  const profitLockEnabled = String(env.PROFIT_LOCK_ENABLED || "false") === "true";
  const profitLockR = Number(env.PROFIT_LOCK_R ?? 1.0);
  const profitLockKeepR = Number(env.PROFIT_LOCK_KEEP_R ?? 0.25);
  const profitLockMinInr = Number(env.PROFIT_LOCK_MIN_INR ?? 0);
  const profitLockArmed =
    profitLockEnabled && Number.isFinite(mfeR) && mfeR >= profitLockR;
  let profitLockFloor = null;
  if (profitLockArmed && !trade?.profitLockArmedAt) {
    tradePatch.profitLockArmedAt = new Date(now);
  }
  if (profitLockArmed && Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0 && qty > 0) {
    const lockInr = Math.max(profitLockMinInr, profitLockKeepR * riskPerTradeInr);
    if (Number.isFinite(lockInr) && lockInr > 0) {
      const lockPts = lockInr / qty;
      const lockSlRaw = side === "BUY" ? entry + lockPts : entry - lockPts;
      profitLockFloor = roundToTick(lockSlRaw, tick, side === "BUY" ? "up" : "down");
      if (improvesStop(side, profitLockFloor, newSL, tick / 2)) {
        protectedStopSource = "PROFIT_LOCK";
      }
      newSL = betterStop(side, newSL, profitLockFloor);
      tradePatch.profitLockInr = lockInr;
      tradePatch.profitLockR = profitLockKeepR;
    }
  }

  const trailAllowedNow = Boolean(
    minGreenSatisfied && (beApplied || trailArmedNow || tp1TrailOverride),
  );
  let trailGap = null;
  let trailSl = null;
  let trailActive = false;
  let trailBlockReason = null;
  const trailPeakStartedAtTs = tsFrom(trade?.trailPeakStartedAt);
  const priorTrailPeakLive = Boolean(
    Number.isFinite(trailPeakStartedAtTs) ||
      trade?.trailActive,
  );
  const prevPeak = priorTrailPeakLive ? toFiniteOrNaN(trade?.peakLtp) : NaN;
  let peakLtp = prevPeak;
  const shouldTrackTrailPeak = Boolean(trailAllowedNow);
  if (shouldTrackTrailPeak && Number.isFinite(ltp)) {
    if (!Number.isFinite(trailPeakStartedAtTs)) {
      tradePatch.trailPeakStartedAt = new Date(now);
    }
    if (side === "BUY") {
      peakLtp = Number.isFinite(prevPeak) ? Math.max(prevPeak, ltp) : ltp;
    } else {
      peakLtp = Number.isFinite(prevPeak) ? Math.min(prevPeak, ltp) : ltp;
    }
    if (!Number.isFinite(prevPeak) || peakLtp !== prevPeak) {
      tradePatch.peakLtp = peakLtp;
    }
  }

  if (!minGreenSatisfied) {
    trailBlockReason = "MIN_GREEN_NOT_SATISFIED";
  } else if (!beApplied && !trailArmedNow && !tp1TrailOverride) {
    trailBlockReason = "WAITING_FOR_BE_APPLY_OR_TRAIL_ARM";
  }

  if (maxHoldActive) {
    const persistedTrailAllowed = Boolean(trade?.trailAllowed);
    const persistedTrailActive = Boolean(trade?.trailActive);
    const maxHoldProtectionSource =
      beApplied ? "BE_APPLIED"
      : trailAllowedNow ? "TRAIL_ALLOWED"
      : persistedTrailAllowed ? "TRAIL_ALLOWED"
      : persistedTrailActive ? "TRAIL_ACTIVE"
      : null;
    const maxHoldProtectionActive = Boolean(maxHoldProtectionSource);
    let maxHoldSkipReason = null;
    if (Number.isFinite(pnlRForRules) && pnlRForRules >= maxHoldSkipIfPnlR) {
      maxHoldSkipReason = "PNL_R";
    } else if (Number.isFinite(peakRForRules) && peakRForRules >= maxHoldSkipIfPeakR) {
      maxHoldSkipReason = "PEAK_R";
    } else if (maxHoldSkipIfLocked && maxHoldProtectionActive) {
      maxHoldSkipReason = "LIVE_PROTECTION";
    }

    if (maxHoldSkipReason) {
      return {
        ...basePlan,
        meta: {
          ...(basePlan?.meta || {}),
          maxHoldSkipReason,
          maxHoldProtectionActive,
          maxHoldProtectionSource,
          maxHoldMin,
          maxHoldSkipIfPnlR,
          maxHoldSkipIfPeakR,
          maxHoldSkipIfLocked,
          holdMin,
          pnlRForRules,
          peakPnlR,
          peakRForRules,
          beApplied,
          trailAllowed: trailAllowedNow || persistedTrailAllowed,
          trailActive: persistedTrailActive,
        },
      };
    }

    return {
      ...basePlan,
      ok: true,
      action: { exitNow: true, reason: "TIME_STOP_MAX_HOLD" },
      tradePatch: {
        ...tradePatch,
        ...(trade?.timeStopTriggeredAt
          ? {}
          : { timeStopTriggeredAt: new Date(now) }),
      },
      meta: {
        ...(basePlan?.meta || {}),
        timeStopKind: "MAX_HOLD",
        holdMin,
        maxHoldMin,
        maxHoldSkipIfPnlR,
        maxHoldSkipIfPeakR,
        maxHoldSkipIfLocked,
        maxHoldProtectionActive,
        maxHoldProtectionSource,
        pnlInr,
        pnlR,
        pnlPriceR,
        pnlRForRules,
        peakPnlInr,
        peakPnlR,
        peakRForRules,
        peakPriceR,
        beApplied,
        trailAllowed: trailAllowedNow || persistedTrailAllowed,
        trailActive: persistedTrailActive,
      },
    };
  }

  if (trailAllowedNow && Number.isFinite(peakLtp)) {
    const shouldTightenTrail =
      Number.isFinite(peakRForRules) &&
      Number.isFinite(trailTightenR) &&
      peakRForRules >= trailTightenR;
    const gapPct = beApplied
      ? shouldTightenTrail
        ? trailGapPostBePctTight
        : trailGapPostBePct
      : trailGapPreBePct;
    const rawGap = clamp(peakLtp * gapPct, trailGapMinPts, trailGapMaxPts);
    trailGap = roundToTick(rawGap, tick, "nearest");
    if (!(Number.isFinite(trailGap) && trailGap > 0)) {
      trailGap = null;
    }

    trailSl =
      Number.isFinite(trailGap) && trailGap > 0
        ? side === "BUY"
          ? peakLtp - trailGap
          : peakLtp + trailGap
        : null;
    const curTrailSl = Number(trade?.trailSl);
    if (
      Number.isFinite(trailSl) &&
      (!Number.isFinite(curTrailSl) || Math.abs(trailSl - curTrailSl) >= tick / 2)
    ) {
      tradePatch.trailSl = trailSl;
    }

    if (Number.isFinite(trailSl)) {
      if (improvesStop(side, trailSl, newSL, tick / 2)) {
        trailActive = true;
        protectedStopSource = "TRAIL";
      }
      newSL = betterStop(side, newSL, trailSl);
    } else {
      trailBlockReason = "TRAIL_GAP_DISABLED";
    }
  }

  // Never loosen beyond initial SL (unless controlled early widen for options)
  const widenGate =
    isOptionTrade(trade) && Number.isFinite(entry)
      ? evaluateOptionWidenEligibility({
          trade,
          holdMin,
          env,
          ltp,
          underlyingLtp,
          marketQuote,
          sl0,
          nowTs: now,
        })
      : {
          allowed: false,
          reason: "NOT_OPTION_TRADE",
          spreadBps: null,
          adverseUnderlyingBps: null,
          structureFailing: false,
          referenceKind: null,
          breachAmount: null,
          bufferUsed: null,
          quoteFreshnessMs: null,
        };
  const allowWiden = Boolean(widenGate.allowed);

  const baseRiskInr = Number(
    executionRisk?.riskInr ?? trade?.riskInr ?? env.RISK_PER_TRADE_INR ?? 0,
  );
  const widenMult = Number(env.OPT_EXIT_WIDEN_MAX_RISK_MULT ?? 1.3);
  const maxRiskInr =
    allowWiden && Number.isFinite(baseRiskInr) && baseRiskInr > 0
      ? baseRiskInr * Math.max(1, widenMult)
      : null;
  const maxRiskPts =
    Number.isFinite(maxRiskInr) && qty > 0 ? maxRiskInr / qty : null;

  if (Number.isFinite(sl0)) {
    if (side === "BUY") {
      const minAllowed =
        allowWiden && Number.isFinite(maxRiskPts)
          ? Math.min(sl0, entry - maxRiskPts)
          : sl0;
      newSL = Math.max(newSL, minAllowed);
    } else {
      const maxAllowed =
        allowWiden && Number.isFinite(maxRiskPts)
          ? Math.max(sl0, entry + maxRiskPts)
          : sl0;
      newSL = Math.min(newSL, maxAllowed);
    }
  }

  // Broker-valid guard: SL should not be beyond market
  const buffer = tick;
  if (Number.isFinite(ltp)) {
    if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
    else newSL = clamp(newSL, ltp + buffer, undefined);
  }

  newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

  const stepTicks = Number(
    beApplied
      ? env.DYN_STEP_TICKS_POST_BE ?? env.DYN_TRAIL_STEP_TICKS ?? 10
      : env.DYN_STEP_TICKS_PRE_BE ?? env.DYN_TRAIL_STEP_TICKS ?? 20,
  );
  const step = stepTicks * tick;
  const curSlRounded = roundToTick(curSL, tick, side === "BUY" ? "down" : "up");
  const newSlRounded = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");
  const slMove = side === "BUY" ? newSlRounded - curSlRounded : curSlRounded - newSlRounded;
  const curSlBelowBeFloor =
    Number.isFinite(curSlRounded) &&
    Number.isFinite(beFloor) &&
    (side === "BUY" ? curSlRounded < beFloor : curSlRounded > beFloor);
  const forceBePriorityMove = Boolean(
    !beApplied && beArmedNow && curSlBelowBeFloor,
  );
  const shouldMoveSL = (Number.isFinite(slMove) && slMove >= step) || forceBePriorityMove;

  if (!beArmedNow) {
    if (!minGreenSatisfied) skipReasons.push("be_blocked:min_green_not_satisfied");
    else if (!(Number.isFinite(beLockAt) && beLockAt > 0)) skipReasons.push("be_lock_disabled");
    else if (!beThresholdHit)
      skipReasons.push(
        `pnlInr=${Number(pnlInr ?? 0).toFixed(2)} < beLockAt=${beLockAt} (eps=${Number(beArmEpsInr ?? 0).toFixed(2)})`,
      );
  }

  if (!trailAllowedNow) {
    skipReasons.push(`trail_blocked:${trailBlockReason ?? "NOT_ALLOWED"}`);
  } else if (!(Number.isFinite(trailGap) && trailGap > 0)) {
    skipReasons.push("trail_gap_disabled");
  }

  const trackedPeakLtp =
    Number.isFinite(tradePatch?.peakLtp) ? Number(tradePatch.peakLtp)
    : Number.isFinite(peakLtp) ? Number(peakLtp)
    : null;

  if (!trailArmedNow) {
    if (!minGreenSatisfied) skipReasons.push("trail_blocked:min_green_not_satisfied");
    if (!(Number.isFinite(trailStartInr) && trailStartInr > 0)) skipReasons.push("trail_arm_disabled");
    else if (!trailThresholdHit) {
      skipReasons.push(`pnlInr=${Number(pnlInr ?? 0).toFixed(2)} < trailStartInr=${trailStartInr}`);
    }
  }

  const desiredStopLoss = newSlRounded;
  let finalStopLoss = shouldMoveSL
    ? roundToTick(
        side === "BUY"
          ? desiredStopLoss + triggerBufferTicks * tick
          : desiredStopLoss - triggerBufferTicks * tick,
        tick,
        side === "BUY" ? "up" : "down",
      )
    : null;

  // Keep post-buffer trigger broker-valid relative to live LTP.
  if (shouldMoveSL && Number.isFinite(ltp) && Number.isFinite(finalStopLoss)) {
    if (side === "BUY") {
      finalStopLoss = Math.min(finalStopLoss, ltp - tick);
      finalStopLoss = roundToTick(finalStopLoss, tick, "down");
    } else {
      finalStopLoss = Math.max(finalStopLoss, ltp + tick);
      finalStopLoss = roundToTick(finalStopLoss, tick, "up");
    }
  }

  if (forceBePriorityMove) {
    skipReasons.push("be_priority_sl_move");
  } else if (!shouldMoveSL) {
    skipReasons.push(`sl_move_below_step (move=${Number(slMove ?? 0).toFixed(2)}, step=${Number(step ?? 0).toFixed(2)})`);
  }

  return {
    ...basePlan,
    ok: true,
    sl: shouldMoveSL ? { stopLoss: finalStopLoss } : basePlan?.sl || null,
    tradePatch,
    meta: {
      ...(basePlan?.meta || {}),
      pnlInr,
      minGreenInr,
      minGreenPts,
      pnlR,
      pnlPriceR,
      pnlRForRules,
      peakPnlInr,
      peakPnlR,
      peakPriceR,
      mfeR,
      minGreenEnabled,
      beLockAt,
      beLockAtFromR: Number.isFinite(beLockAtFromR) ? beLockAtFromR : null,
      beLockAtFromCost: Number.isFinite(beLockAtFromCost) ? beLockAtFromCost : null,
      beArmCostMult,
      beArmEpsInr,
      trailGap,
      trailSl,
      trailStartInr: Number.isFinite(trailStartInr) ? trailStartInr : null,
      trailArmEpsInr,
      allowTrail: trailAllowedNow,
      minGreenSatisfied,
      beEligible,
      beArmed: beArmedNow,
      beApplied,
      // Legacy compatibility alias only; do not use as live protection truth.
      beLockHit: beArmedNow,
      trailEligible,
      trailArmed: trailArmedNow,
      trailAllowed: trailAllowedNow,
      trailActive,
      // Legacy compatibility alias only; do not use as live protection truth.
      trailHit: trailArmedNow,
      beArmR,
      trailArmR,
      riskPerTradeInr,
      trueBE: Number.isFinite(trueBE) ? trueBE : null,
      trueBeFloor,
      minGreenFloor,
      beFloor,
      beFloorSource,
      beProfitLockFloor,
      beProfitLockDeferredToEarlyWinner:
        Boolean(earlyWinnerEnabled && Number.isFinite(beProfitLockFloor)),
      estCostInr: Number.isFinite(estCostInr) ? estCostInr : null,
      desiredStopLoss,
      finalStopLoss,
      protectedStopSource,
      trailBlockReason,
      forceBePriorityMove,
      triggerBufferTicks,
      peakLtp: trackedPeakLtp,
      trailPeakStartedAt:
        tradePatch?.trailPeakStartedAt instanceof Date
          ? tradePatch.trailPeakStartedAt.toISOString()
          : Number.isFinite(trailPeakStartedAtTs)
            ? new Date(trailPeakStartedAtTs).toISOString()
            : null,
      skipReason: skipReasons.join(" | ") || null,
      holdMin,
      allowWiden,
      executionRiskInr:
        Number.isFinite(executionRisk?.riskInr) ? executionRisk.riskInr : null,
      executionRiskPts:
        Number.isFinite(executionRisk?.riskPts) ? executionRisk.riskPts : null,
      executionRiskQty:
        Number.isFinite(executionRisk?.riskQty) ? executionRisk.riskQty : null,
      executionRiskSource: executionRisk?.source ?? null,
      profitLockArmed,
      profitLockFloor,
      profitLockR,
      profitLockKeepR,
      profitLockMinInr,
      trailTightenR,
      trailGapPostBePctTight,
      widenMult: Number.isFinite(widenMult) ? widenMult : null,
      maxRiskInr: Number.isFinite(maxRiskInr) ? maxRiskInr : null,
      maxRiskPts: Number.isFinite(maxRiskPts) ? maxRiskPts : null,
      optionWidenBlockedReason: widenGate?.reason ?? null,
      optionWidenSpreadBps:
        Number.isFinite(widenGate?.spreadBps) ? widenGate.spreadBps : null,
      optionWidenAdverseUnderlyingBps:
        Number.isFinite(widenGate?.adverseUnderlyingBps)
          ? widenGate.adverseUnderlyingBps
          : null,
      optionWidenStructureFailing: Boolean(widenGate?.structureFailing),
      optionWidenReferenceKind: widenGate?.referenceKind ?? null,
      optionWidenBreachAmount:
        Number.isFinite(widenGate?.breachAmount) ? widenGate.breachAmount : null,
      optionWidenBufferUsed:
        Number.isFinite(widenGate?.bufferUsed) ? widenGate.bufferUsed : null,
      optionWidenQuoteFreshnessMs:
        Number.isFinite(widenGate?.quoteFreshnessMs)
          ? widenGate.quoteFreshnessMs
          : null,
    },
  };
}

const EXPLICIT_PROTECTION_STATE_KEYS = [
  "minGreenEnabled",
  "minGreenInr",
  "minGreenPts",
  "minGreenSatisfied",
  "beEligible",
  "beArmed",
  "beApplied",
  "beFloor",
  "beFloorSource",
  "trueBeFloor",
  "minGreenFloor",
  "beProfitLockFloor",
  "trailEligible",
  "trailArmed",
  "trailAllowed",
  "trailActive",
  "trailGap",
  "trailSl",
  "trailBlockReason",
  "profitLockFloor",
  "protectedStopSource",
  "forceBePriorityMove",
];

function explicitProtectionStateFromPlan(plan) {
  const meta = plan?.meta || {};
  return EXPLICIT_PROTECTION_STATE_KEYS.reduce((state, key) => {
    if (Object.prototype.hasOwnProperty.call(meta, key)) {
      state[key] = meta[key];
    }
    return state;
  }, {});
}

function mergeExplicitProtectionState({ trade, plan, state }) {
  if (!plan?.ok || !state || !Object.keys(state).length) return plan;
  const tradePatch = { ...(plan?.tradePatch || {}) };
  if (Object.prototype.hasOwnProperty.call(state, "trailActive")) {
    tradePatch.trailActive = Boolean(state.trailActive);
  }
  const mergedState = { ...state };
  if (
    Object.prototype.hasOwnProperty.call(mergedState, "protectedStopSource") &&
    (mergedState.protectedStopSource === null ||
      mergedState.protectedStopSource === undefined ||
      mergedState.protectedStopSource === "")
  ) {
    delete mergedState.protectedStopSource;
  }
  const meta = {
    ...(plan?.meta || {}),
    ...mergedState,
    allowTrail: Boolean(mergedState.trailAllowed),
    // Legacy compatibility aliases only; live consumers must use beApplied/trailAllowed/trailActive.
    beLockHit: Boolean(mergedState.beArmed),
    trailHit: Boolean(mergedState.trailArmed),
    trailActive: Boolean(mergedState.trailActive),
  };
  return {
    ...plan,
    tradePatch,
    beApplied: Boolean(mergedState.beApplied),
    trailAllowed: Boolean(mergedState.trailAllowed),
    trailActive: Boolean(mergedState.trailActive),
    meta,
  };
}

function premiumVolPct(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < 4) return null;
  const n = Math.max(4, Math.min(Number(lookback ?? 20), 120));
  const tail = candles.slice(-n);
  const rets = [];
  for (let i = 1; i < tail.length; i += 1) {
    const a = safeNum(tail[i - 1]?.close);
    const b = safeNum(tail[i]?.close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) continue;
    const r = Math.abs(b - a) / a;
    if (Number.isFinite(r)) rets.push(r);
  }
  if (!rets.length) return null;
  // mean absolute return per candle (percent)
  const avg = (rets.reduce((x, y) => x + y, 0) / rets.length) * 100;
  return Number.isFinite(avg) ? avg : null;
}

function underlyingMoveBps({ trade, underlyingLtp }) {
  const uEntry = safeNum(
    trade?.underlying_ltp ?? trade?.option_meta?.underlyingLtp,
  );
  const uNow = safeNum(underlyingLtp);
  if (!(uEntry > 0) || !(uNow > 0)) return null;
  return ((uNow - uEntry) / uEntry) * 10000;
}

function optionExitFallback({
  trade,
  ltp,
  candles,
  nowTs,
  env,
  underlyingLtp,
  marketQuote,
  beInfo,
}) {
  const side = String(trade.side || "").toUpperCase();
  const tick = Number(trade.instrument?.tick_size ?? 0.05);

  const { entry, sl0 } = computeBaseRisk(trade);
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return { ok: false, reason: "missing_prices" };
  if (side !== "BUY" && side !== "SELL")
    return { ok: false, reason: "invalid_side" };

  const now = Number(nowTs ?? Date.now());
  const refTs =
    tsFrom(trade.entryFilledAt) ||
    tsFrom(trade.createdAt) ||
    tsFrom(trade.updatedAt) ||
    now;
  const holdMin = Math.max(0, (now - refTs) / (60 * 1000));

  // ===== Time-based exit (hard stop) =====
  const globalMaxHold = Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0);
  const proMaxHoldEnabled = Number.isFinite(globalMaxHold) && globalMaxHold > 0;
  const maxHold = Number(env.OPT_EXIT_MAX_HOLD_MIN ?? 25);
  if (!proMaxHoldEnabled && Number.isFinite(maxHold) && maxHold > 0 && holdMin >= maxHold) {
    return {
      ok: true,
      action: { exitNow: true, reason: `OPT_TIME_EXIT (>=${maxHold}m)` },
      meta: { holdMin, maxHold },
    };
  }

  // ===== Coarse "IV crush" protection =====
  // If premium is falling sharply while underlying hasn't moved much, it's often IV crush / theta bleed.
  const neutralBps = Number(env.OPT_IV_NEUTRAL_BPS ?? 12);
  const crushPct = Number(env.OPT_IV_CRUSH_PREMIUM_PCT ?? 18);
  const crushMinHold = Number(env.OPT_IV_CRUSH_MIN_HOLD_MIN ?? 3);

  const pPct = profitPct({ side, entry, ltp }); // BUY positive == profit
  const uBps = underlyingMoveBps({ trade, underlyingLtp });
  const absUBps = Number.isFinite(uBps) ? Math.abs(uBps) : null;

  if (
    Number.isFinite(absUBps) &&
    absUBps <= neutralBps &&
    Number.isFinite(crushPct) &&
    crushPct > 0 &&
    holdMin >= crushMinHold &&
    pPct <= -Math.abs(crushPct)
  ) {
    return {
      ok: true,
      action: {
        exitNow: true,
        reason: `OPT_IV_CRUSH (prem ${pPct.toFixed(1)}% | und ${uBps.toFixed(
          1,
        )}bps)`,
      },
      meta: { holdMin, pPct, uBps, neutralBps, crushPct, crushMinHold },
    };
  }

  // ===== Premium % model (w/ volatility-aware widening) =====
  const baseSlPct = Number(env.OPT_EXIT_BASE_SL_PCT ?? 18);
  const baseTpPct = Number(env.OPT_EXIT_BASE_TARGET_PCT ?? 35);
  const minSlPct = Number(env.OPT_EXIT_MIN_SL_PCT ?? 8);
  const maxSlPct = Number(env.OPT_EXIT_MAX_SL_PCT ?? env.OPT_MAX_SL_PCT ?? 35);

  const volLookback = Number(env.OPT_EXIT_VOL_LOOKBACK ?? 20);
  const volRef = Number(env.OPT_EXIT_VOL_REF_PCT ?? 6);
  const vfMin = Number(env.OPT_EXIT_WIDEN_FACTOR_MIN ?? 0.75);
  const vfMax = Number(env.OPT_EXIT_WIDEN_FACTOR_MAX ?? 1.8);

  const volPct = premiumVolPct(candles, volLookback);
  const volFactor =
    Number.isFinite(volPct) && Number.isFinite(volRef) && volRef > 0
      ? clamp(volPct / volRef, vfMin, vfMax)
      : 1.0;

  const slPct = clamp(baseSlPct * volFactor, minSlPct, maxSlPct);
  const tpPct = clamp(
    baseTpPct * volFactor,
    Math.max(10, baseTpPct * 0.6),
    120,
  );

  // Recommended model levels
  const modelSL =
    side === "BUY"
      ? roundToTick(entry * (1 - slPct / 100), tick, "down")
      : roundToTick(entry * (1 + slPct / 100), tick, "up");

  const modelTP =
    side === "BUY"
      ? roundToTick(entry * (1 + tpPct / 100), tick, "up")
      : roundToTick(entry * (1 - tpPct / 100), tick, "down");

  // Current stop/target in DB (may already be trailed)
  const curSL = safeNum(trade.stopLoss || sl0);
  const curTarget = safeNum(trade.targetPrice || 0, 0);

  let newSL = Number.isFinite(curSL) ? curSL : modelSL;
  let newTarget = curTarget > 0 ? curTarget : modelTP;

  // ===== Controlled early widening (options only) =====
  const widenGate = evaluateOptionWidenEligibility({
    trade,
    holdMin,
    env,
    ltp,
    underlyingLtp,
    marketQuote,
    sl0,
    nowTs: now,
  });
  const allowWiden = Boolean(widenGate.allowed);

  if (allowWiden && Number.isFinite(curSL)) {
    // If current SL is much tighter than the model, widen it to reduce early noise stop-outs.
    // NOTE: This is the only case where we allow loosening (options-only, early window, capped).
    if (side === "BUY" && curSL > modelSL) newSL = modelSL;
    if (side === "SELL" && curSL < modelSL) newSL = modelSL;
  }

  // ===== Premium trailing (after profit threshold) =====
  const trailStartPct = Number(env.OPT_EXIT_TRAIL_START_PROFIT_PCT ?? 15);
  const baseTrailPct = Number(env.OPT_EXIT_TRAIL_PCT_BASE ?? 12);
  const trailMin = Number(env.OPT_EXIT_TRAIL_PCT_MIN ?? 6);
  const trailMax = Number(env.OPT_EXIT_TRAIL_PCT_MAX ?? 22);

  const trailPct = clamp(baseTrailPct * volFactor, trailMin, trailMax);

  if (Number.isFinite(trailStartPct) && pPct >= trailStartPct) {
    if (side === "BUY") {
      const trailSL = roundToTick(ltp * (1 - trailPct / 100), tick, "down");
      newSL = Math.max(newSL, trailSL);
    } else {
      const trailSL = roundToTick(ltp * (1 + trailPct / 100), tick, "up");
      newSL = Math.min(newSL, trailSL);
    }
  }

  // ===== IV spike heuristic: premium up a lot while underlying "neutral" =====
  // Lock profits aggressively: tighten SL and optionally place a marketable target to hit bid/ask.
  const spikePct = Number(env.OPT_IV_SPIKE_PREMIUM_PCT ?? 25);
  if (
    Number.isFinite(absUBps) &&
    absUBps <= neutralBps &&
    Number.isFinite(spikePct) &&
    pPct >= spikePct
  ) {
    const spikeTrailPct = Number(env.OPT_IV_SPIKE_TRAIL_PCT ?? 10);
    if (side === "BUY") {
      const lockSL = roundToTick(ltp * (1 - spikeTrailPct / 100), tick, "down");
      newSL = Math.max(newSL, lockSL);

      if (String(env.OPT_IV_SPIKE_TP_TO_BID || "true") === "true") {
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS ?? 1);
        const mktable = roundToTick(
          ltp - Math.max(1, bidTicks) * tick,
          tick,
          "down",
        );
        // Keep it profit-side & fee-safe if possible
        const minOk = Math.max(entry + tick, safeNum(beInfo?.be, entry + tick));
        newTarget = Math.min(newTarget, Math.max(mktable, minOk));
      }
    } else {
      const lockSL = roundToTick(ltp * (1 + spikeTrailPct / 100), tick, "up");
      newSL = Math.min(newSL, lockSL);

      if (String(env.OPT_IV_SPIKE_TP_TO_BID || "true") === "true") {
        const bidTicks = Number(env.OPT_IV_SPIKE_TP_BID_TICKS ?? 1);
        const mktable = roundToTick(
          ltp + Math.max(1, bidTicks) * tick,
          tick,
          "up",
        );
        const maxOk = Math.min(entry - tick, safeNum(beInfo?.be, entry - tick));
        newTarget = Math.max(newTarget, Math.min(mktable, maxOk));
      }
    }
  }

  // ===== Ensure SL doesn't cross market (avoid invalid trigger) =====
  const buffer = tick;
  if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
  else newSL = clamp(newSL, ltp + buffer, undefined);
  newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

  // ===== Never loosen beyond the "allowed floor" =====
  // For options, if early widening happened, the floor becomes the widened stop; afterwards, only tighten.
  const floorSL = allowWiden ? modelSL : sl0;
  if (side === "BUY") newSL = Math.max(newSL, floorSL);
  else newSL = Math.min(newSL, floorSL);

  // ===== Decide whether to send modifications =====
  const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS ?? 20);
  const step = stepTicks * tick;

  const slMove = Number.isFinite(curSL)
    ? side === "BUY"
      ? newSL - curSL
      : curSL - newSL
    : Infinity;

  const shouldMoveSL = Number.isFinite(slMove) && slMove >= step;

  // Target: for options fallback, allow tightening (or the IV-spike "mktable" quick-exit) even if DYN_TARGET_MODE=STATIC.
  let shouldMoveTarget = false;
  if (Number.isFinite(newTarget) && newTarget > 0) {
    // ensure target stays on profitable side of entry
    if (side === "BUY") newTarget = Math.max(newTarget, entry + tick);
    else newTarget = Math.min(newTarget, entry - tick);

    const tMove = curTarget > 0 ? Math.abs(newTarget - curTarget) : Infinity;
    shouldMoveTarget = tMove >= step;
  } else {
    newTarget = null;
  }

  return {
    ok: true,
    sl: shouldMoveSL ? { stopLoss: newSL } : null,
    target: shouldMoveTarget ? { targetPrice: newTarget } : null,
    meta: {
      model: "OPT_PREMIUM_PCT",
      holdMin,
      entry,
      ltp,
      profitPct: pPct,
      volPct: Number.isFinite(volPct) ? volPct : null,
      volFactor,
      slPct,
      tpPct,
      modelSL,
      modelTP,
      curSL: Number.isFinite(curSL) ? curSL : null,
      newSL,
      curTarget: curTarget > 0 ? curTarget : null,
      newTarget,
      uBps: Number.isFinite(uBps) ? uBps : null,
      allowWiden,
      optionWidenBlockedReason: widenGate?.reason ?? null,
      optionWidenSpreadBps:
        Number.isFinite(widenGate?.spreadBps) ? widenGate.spreadBps : null,
      optionWidenAdverseUnderlyingBps:
        Number.isFinite(widenGate?.adverseUnderlyingBps)
          ? widenGate.adverseUnderlyingBps
          : null,
      optionWidenStructureFailing: Boolean(widenGate?.structureFailing),
      optionWidenReferenceKind: widenGate?.referenceKind ?? null,
      optionWidenBreachAmount:
        Number.isFinite(widenGate?.breachAmount) ? widenGate.breachAmount : null,
    },
  };
}

function computeDynamicExitPlan({
  trade,
  ltp,
  candles,
  nowTs,
  env,
  marketQuote = undefined,
  underlyingLtp = undefined,
}) {
  const side = String(trade?.side || "").toUpperCase();
  const tick = Number(trade?.instrument?.tick_size ?? 0.05);

  const { entry, sl0, risk } = computeBaseRisk(trade);
  const rr = Number(trade?.rr ?? env.RR_TARGET ?? 1.0);

  // Required
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(ltp) ||
    ltp <= 0
  )
    return { ok: false, reason: "missing_prices" };

  const now = Number(nowTs ?? Date.now());
  const beInfo = estimateTrueBreakeven({ trade, entry, side, tick, env });

  let basePlan = null;

  // -----------------------
  // OPTIONS-AWARE FALLBACKS
  // -----------------------
  if (isOptionTrade(trade)) {
    const plan = optionExitFallback({
      trade,
      ltp,
      candles,
      nowTs: now,
      env,
      underlyingLtp,
      marketQuote,
      beInfo,
    });
    if (plan?.ok) {
      basePlan = {
        ...plan,
        meta: {
          ...(plan.meta || {}),
          at: new Date(now).toISOString(),
          side,
          tick,
          optionType: optionType(trade),
          trueBE: beInfo?.be,
          trueBEMeta: beInfo?.meta || null,
        },
      };
    }
    // If fallback couldn't build, still continue to equity-style logic below as a last resort.
  }

  // -----------------------
  // CASH / DEFAULT LOGIC
  // -----------------------
  if (!basePlan) {
    if (!candles || candles.length < 20)
      return { ok: false, reason: "not_enough_candles" };

    const pr = profitR({ side, entry, ltp, risk });

    // ---------- trailing stop ----------
    const atrPeriod = Number(env.DYN_ATR_PERIOD ?? 14);
    const a = atr(candles, atrPeriod);
    const atrMult = Number(env.DYN_TRAIL_ATR_MULT ?? 1.2);

    // Start ATR trailing only after X R in profit
    const trailStartR = Number(env.DYN_TRAIL_START_R ?? 1.0);

    // Move SL to "true breakeven" after Y R in profit
    const beAtR = Number(env.DYN_MOVE_SL_TO_BE_AT_R ?? 0.8);

    const stepTicks = Number(env.DYN_TRAIL_STEP_TICKS ?? 20); // minimum move before modifying
    const step = stepTicks * tick;

    // candles since entry
    const entryTs = tsFrom(trade.createdAt || trade.updatedAt) || Date.now();
    const since = candles.filter((c) => {
      const ts = tsFrom(c?.ts) || tsFrom(c?.time) || null;
      return Number.isFinite(ts) && ts >= entryTs;
    });
    const slice = since.length ? since : candles.slice(-60);

    const hi = maxHigh(slice);
    const lo = minLow(slice);

    // Current stop in DB (may already be trailed)
    const curSL = Number(trade.stopLoss ?? sl0);
    let newSL = curSL;

    // Break-even move (fee-safe BE)
    if (risk > 0 && Number.isFinite(beAtR) && pr >= beAtR) {
      if (side === "BUY") newSL = Math.max(newSL, beInfo.be);
      else newSL = Math.min(newSL, beInfo.be);
    }

    // ATR trail from swing extremes (conservative) - only after trailStartR
    if (risk > 0 && pr >= trailStartR && Number.isFinite(a) && a > 0) {
      if (side === "BUY") newSL = Math.max(newSL, hi - atrMult * a);
      else newSL = Math.min(newSL, lo + atrMult * a);
    }

    // Never loosen beyond initial SL
    if (side === "BUY") newSL = Math.max(newSL, sl0);
    else newSL = Math.min(newSL, sl0);

    // Broker-valid guard: SL should not be beyond market (avoid immediate invalid trigger)
    const buffer = tick; // keep at least 1 tick away
    if (side === "BUY") newSL = clamp(newSL, undefined, ltp - buffer);
    else newSL = clamp(newSL, ltp + buffer, undefined);

    newSL = roundToTick(newSL, tick, side === "BUY" ? "down" : "up");

    const slMove = side === "BUY" ? newSL - curSL : curSL - newSL;
    const shouldMoveSL = Number.isFinite(slMove) && slMove >= step;

    // ---------- dynamic target ----------
    const mode = String(env.DYN_TARGET_MODE || "STATIC").toUpperCase(); // STATIC|FOLLOW_RR|TIGHTEN_VWAP
    const rrFollow = Number(env.DYN_TARGET_RR ?? rr);
    const tightenVwapFrac = Number(env.DYN_TARGET_TIGHTEN_FRAC ?? 0.6); // how aggressively to pull target in

    const curTarget = Number(trade.targetPrice ?? 0);
    let newTarget = curTarget > 0 ? curTarget : null;

    const allowTargetTighten =
      String(env.DYN_ALLOW_TARGET_TIGHTEN || "false") === "true" ||
      pr >= Number(env.DYN_TARGET_TIGHTEN_AFTER_R ?? 1.5);

    if (mode === "FOLLOW_RR" && allowTargetTighten) {
      // Keep RR aligned to the *current* stop (as SL trails up, target tightens too)
      const riskNow = Math.abs(entry - newSL);
      const t = computeTargetFromRisk({
        side,
        entry,
        risk: riskNow,
        rr: rrFollow,
        tick,
      });
      if (t != null) newTarget = t;
    }

    if (mode === "TIGHTEN_VWAP" && allowTargetTighten) {
      // If price comes back to VWAP, tighten target to get out quicker (only after enough profit).
      const vwap = rollingVWAP(candles, Number(env.DYN_VWAP_LOOKBACK ?? 120));
      if (Number.isFinite(vwap) && vwap > 0) {
        const dist = Math.abs(ltp - vwap);
        // If we're close to VWAP relative to initial risk, reduce target to secure profit.
        if (risk > 0 && dist <= risk) {
          if (side === "BUY") {
            const desired = ltp + tightenVwapFrac * risk;
            newTarget = roundToTick(
              Math.max(curTarget || 0, desired),
              tick,
              "up",
            );
          } else {
            const desired = ltp - tightenVwapFrac * risk;
            newTarget = roundToTick(
              Math.min(curTarget || desired, desired),
              tick,
              "down",
            );
          }
        }
      }
    }

    // Ensure target stays on profitable side of entry
    if (newTarget != null && Number.isFinite(newTarget)) {
      if (side === "BUY") newTarget = Math.max(newTarget, entry + tick);
      else newTarget = Math.min(newTarget, entry - tick);
    } else {
      newTarget = null;
    }

    const tMove =
      newTarget != null && curTarget > 0
        ? Math.abs(newTarget - curTarget)
        : newTarget != null
          ? Infinity
          : 0;

    const shouldMoveTarget =
      mode !== "STATIC" &&
      allowTargetTighten &&
      newTarget != null &&
      tMove >= step;

    basePlan = {
      ok: true,
      sl: shouldMoveSL ? { stopLoss: newSL } : null,
      target: shouldMoveTarget ? { targetPrice: newTarget } : null,
      meta: {
        at: new Date(now).toISOString(),
        side,
        ltp,
        entry,
        sl0,
        curSL,
        newSL,
        atr: a,
        hi,
        lo,
        risk,
        profitR: pr,
        rr,
        mode,
        allowTargetTighten,
        curTarget: curTarget || null,
        newTarget,
        trueBE: beInfo?.be,
        trueBEMeta: beInfo?.meta || null,
        trailStartR,
        beAtR,
      },
    };
  }

  const plan = applyMinGreenExitRules({
    trade,
    ltp,
    underlyingLtp,
    marketQuote,
    now,
    env,
    basePlan,
    entry,
    sl0,
    side,
    tick,
  });
  const explicitProtectionState = explicitProtectionStateFromPlan(plan);
  const lossContainmentPlan = applyLossContainmentExitRules({
    trade,
    plan,
    ltp,
    underlyingLtp,
    now,
    env,
    entry,
    sl0,
    side,
  });

  const enrichedPlan = enrichDynamicExitPlan({
    trade,
    plan: lossContainmentPlan,
    ltp,
    candles,
    underlyingLtp,
    marketQuote,
    now,
    env,
    entry,
    sl0,
    side,
    tick,
  });
  return mergeExplicitProtectionState({
    trade,
    plan: enrichedPlan,
    state: explicitProtectionState,
  });
}

module.exports = { computeDynamicExitPlan };
