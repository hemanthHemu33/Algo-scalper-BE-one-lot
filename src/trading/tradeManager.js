// TradeManager.js
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { env } = require("../config");
const {
  getTradingEnabled,
  getTradingEnabledSource,
} = require("../runtime/tradingEnabled");
const { logger } = require("../logger");
const { telemetry } = require("../telemetry/signalTelemetry");
const { tradeTelemetry } = require("../telemetry/tradeTelemetry");
const { marginAwareSizing } = require("./marginSizer");
const { alert } = require("../alerts/alertService");
const { halt, isHalted } = require("../runtime/halt");
const { getDb } = require("../db");
const {
  ensureInstrument,
} = require("../instruments/instrumentRepo");
const { getLastFnoUniverse, buildFnoUniverse } = require("../fno/fnoUniverse");
const {
  pickOptionContractForSignal,
  buildOptionSubscriptionCandidates,
  getPremiumBandForUnderlying,
} = require("../fno/optionsRouter");
const { computePacingPolicy } = require("../policy/pacingPolicy");
const { buildTradePlan } = require("./planBuilder");
const { roundToTick } = require("./priceUtils");
const {
  reportFault,
  reportWindowedFault,
  snapshotFaults,
} = require("../runtime/errorBus");
const {
  fitStopLossToLotRiskCap,
  computeTargetFromRR,
} = require("./optionSlFitter");
const {
  buildEntryUrgencyProfile,
  evaluateExecutionGate,
  evaluatePendingEntryState,
  evaluateStopFitCompression,
} = require("./entryExecutionPolicy");
const { evaluateEntrySlippageGuard } = require("./entrySlippageGuard");
const {
  evaluateMinTradableRiskFit,
} = require("../risk/evaluateMinTradableRiskFit");
const { getRecentCandles } = require("../market/candleStore");
const {
  isQuoteGuardBreakerOpen,
  getQuoteGuardStats,
} = require("../kite/quoteGuard");
const { OrderRateLimiter } = require("./orderRateLimiter");
const { computeDynamicExitPlan } = require("./dynamicExitManager");
const { planRunnerTarget } = require("./targetPlanner");
const {
  adverseDriftPct,
  buildMissingTradeLifecyclePatch,
  deriveStopExitReasonCode,
  resolveExitLifecycle,
} = require("./tradeLifecycleState");
const {
  buildMissingWinnerProtectionPatch,
} = require("./winnerProtectionState");
const {
  resolveStrategyStopLoss,
  resolveSizingStopLoss,
  resolveBrokerStopLoss,
  buildStrategyStopLossBackfillPatch,
  computeActualRiskFromStrategyStop,
  classifyPostFillRiskBreach,
} = require("./stopRiskSemantics");
const { detectRegime } = require("../strategy/selector");
const {
  buildSignalLifecycleId,
  buildRouteConfidenceAssessment,
  buildSignalConversionSummary,
  freezeSignalRegimeSnapshot,
  isStrategyStyleAllowedForRegime,
  resolveSignalRegimeSnapshot,
} = require("../strategy/signalLifecycle");
const {
  costGate,
  estimateRoundTripCostInr,
  estimateMinGreen,
} = require("./costModel");
const { costCalibrator } = require("./costCalibrator");
const { buildEntryPipelineLatency } = require("./entryPipelineLatency");
const { optimizer } = require("../optimizer/adaptiveOptimizer");
const { equityService } = require("../account/equityService");
const { buildPositionsSnapshot } = require("./positionService");
const { getRiskLimits } = require("../risk/riskLimits");
const { resolvePlanPremiumCandles } = require("./planPremiumCache");
const {
  ensureTradeIndexes,
  insertTrade,
  updateTrade: storeUpdateTrade,
  getTrade,
  getActiveTrades,
  linkOrder,
  findTradeByOrder,
  saveOrphanOrderUpdate,
  popOrphanOrderUpdates,
  deadLetterOrphanOrderUpdates,
  appendOrderLog,
  upsertLiveOrderSnapshot,
  getLiveOrderSnapshotsByTradeIds,
  upsertDailyRisk,
  getDailyRisk,
  upsertRiskState,
  getRiskState,
} = require("./tradeStore");
const { ExecutionCoordinator } = require("./executionCoordinator");

const STATUS = {
  ENTRY_PLACED: "ENTRY_PLACED",
  ENTRY_OPEN: "ENTRY_OPEN",
  ENTRY_REPLACED: "ENTRY_REPLACED",
  ENTRY_CANCELLED: "ENTRY_CANCELLED",
  ENTRY_FILLED: "ENTRY_FILLED",
  LIVE: "LIVE",
  SL_PLACED: "SL_PLACED",
  SL_OPEN: "SL_OPEN",
  SL_CONFIRMED: "SL_CONFIRMED",
  EXIT_PLACED: "EXIT_PLACED",
  EXIT_OPEN: "EXIT_OPEN",
  EXIT_PARTIAL: "EXIT_PARTIAL",
  EXIT_FILLED: "EXIT_FILLED",
  PANIC_EXIT_PLACED: "PANIC_EXIT_PLACED",
  PANIC_EXIT_CONFIRMED: "PANIC_EXIT_CONFIRMED",
  RECOVERY_REHYDRATED: "RECOVERY_REHYDRATED",
  EXITED_TARGET: "EXITED_TARGET",
  EXITED_SL: "EXITED_SL",
  ENTRY_FAILED: "ENTRY_FAILED",
  GUARD_FAILED: "GUARD_FAILED",
  CLOSED: "CLOSED",
};
const PANIC_EXIT_STATE_PENDING = "PANIC_EXIT_PENDING";
const EXEC_COMMAND = Object.freeze({
  APPLY_ORDER_UPDATE: "APPLY_ORDER_UPDATE",
  FINALIZE_ENTRY_FILL: "FINALIZE_ENTRY_FILL",
  PLACE_OR_CONFIRM_PROTECTION: "PLACE_OR_CONFIRM_PROTECTION",
  ADJUST_PROTECTION: "ADJUST_PROTECTION",
  HANDLE_TARGET_QTY_RECOVERY: "HANDLE_TARGET_QTY_RECOVERY",
  PANIC_EXIT: "PANIC_EXIT",
  FLATTEN_POSITION: "FLATTEN_POSITION",
  RECONCILE_DIFF_RESOLUTION: "RECONCILE_DIFF_RESOLUTION",
  HANDLE_TIMEOUT: "HANDLE_TIMEOUT",
  HANDLE_RECOVERY_ADOPTION: "HANDLE_RECOVERY_ADOPTION",
  FINALIZE_CLOSE: "FINALIZE_CLOSE",
  DIRECT_PATCH: "DIRECT_PATCH",
});

function todayKey() {
  return DateTime.now()
    .setZone(env.CANDLE_TZ || "Asia/Kolkata")
    .toFormat("yyyy-LL-dd");
}

function dayRange() {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const start = DateTime.now().setZone(tz).startOf("day");
  const end = start.plus({ days: 1 });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

function hasPanicExitStarted(trade) {
  const panicState = String(trade?.panicExitState || "").toUpperCase();
  return Boolean(
    trade?.panicExitPending === true ||
    trade?.panicExitOrderId ||
    panicState === PANIC_EXIT_STATE_PENDING,
  );
}

function toFiniteOrNaN(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitterMs(baseMs, jitterPct = 0) {
  const base = Math.max(0, Number(baseMs ?? 0));
  const pct = Math.max(0, Number(jitterPct ?? 0));
  if (!(base > 0) || !(pct > 0)) return base;
  const delta = base * pct;
  return Math.max(0, Math.round(base - delta + Math.random() * delta * 2));
}

function toFiniteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampMetric(value, lo, hi) {
  let out = Number(value);
  if (!Number.isFinite(out)) return lo;
  if (Number.isFinite(lo)) out = Math.max(lo, out);
  if (Number.isFinite(hi)) out = Math.min(hi, out);
  return out;
}

function withSignalLifecycleMeta(signal, meta = {}) {
  return {
    signalId: signal?.signalId || signal?.signalLifecycleId || null,
    regimeSnapshotId:
      signal?.regimeSnapshotId || signal?.regimeSnapshot?.snapshotId || null,
    ...meta,
  };
}

function resolveSignalEventTs(signal, fallback = null) {
  return (
    signal?.signalEventTs ||
    signal?.candle?.ts ||
    signal?.ts ||
    fallback ||
    null
  );
}

function markEntryPipelineStage(signal, stage, nowMs = Date.now()) {
  if (!signal || typeof signal !== "object" || !stage) return null;
  const timeline = {
    ...(signal.entryPipeline || {}),
    [stage]: new Date(Number(nowMs) || Date.now()).toISOString(),
  };
  signal.entryPipeline = timeline;
  return timeline;
}

function emitEntryPipelineLatency({
  signal,
  logger,
  env,
  extraMeta = {},
  level = null,
}) {
  const latency = buildEntryPipelineLatency({
    timeline: signal?.entryPipeline || {},
    totalBudgetMs: Number(
      env?.MAX_EXECUTION_AGE_MS ?? env?.EXEC_SIGNAL_MAX_AGE_MS ?? 5000,
    ),
  });
  const method =
    level ||
    (latency.culpritStage || latency.totalBudgetExceeded ? "warn" : "info");
  logger[method](
    withSignalLifecycleMeta(signal, {
      ...latency,
      ...extraMeta,
    }),
    "ENTRY_PIPELINE_LATENCY",
  );
  return latency;
}

function observeBackgroundTask(promise, onError) {
  if (!promise || typeof promise.then !== "function") return promise;
  promise.catch((error) => {
    if (typeof onError === "function") onError(error);
  });
  return promise;
}

const DEFAULT_OPT_PRE_ROUTE_MAX_CONF_BOOST = 14;
const HARD_MAX_OPT_PRE_ROUTE_MAX_CONF_BOOST = 22;

function envFlagEnabled(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return String(value).trim().toLowerCase() === "true";
}

function resolvePreRouteConfidenceAllowance(config = env) {
  const allowance = Number(config?.OPT_PRE_ROUTE_MAX_CONF_BOOST);
  if (Number.isFinite(allowance)) {
    return Math.max(
      0,
      Math.min(HARD_MAX_OPT_PRE_ROUTE_MAX_CONF_BOOST, allowance),
    );
  }
  return DEFAULT_OPT_PRE_ROUTE_MAX_CONF_BOOST;
}

function resolvePreRouteMode({ isOptMode, isIndexUnderlying }) {
  if (isOptMode) return "OPT";
  if (isIndexUnderlying) return "INDEX_TO_FNO";
  return null;
}

function evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption,
  conf,
  minConf,
  preRouteAllowanceUsed,
  signal = null,
  env: config = env,
  routeConfidence = null,
}) {
  const confidence = Number(conf);
  const minConfidence = Number(minConf);
  const allowance = Number(preRouteAllowanceUsed);
  const hardRejectScore = Math.max(
    0,
    Number(config?.PRE_ROUTE_ESTIMATE_HARD_REJECT_SCORE ?? 40),
  );
  const assessment =
    routeConfidence ||
    (signal
      ? buildRouteConfidenceAssessment({
          signal,
          baseConfidence: confidence,
          env: config,
          estimated: true,
          positiveAdjustmentCap: allowance,
        })
      : null);
  const projectedConfidence =
    Number.isFinite(Number(assessment?.routedScore))
      ? Number(assessment.routedScore)
      : Number.isFinite(confidence) && Number.isFinite(allowance)
        ? confidence + allowance
        : NaN;
  const softPenaltyApplied =
    mustRouteUnderlyingToOption &&
    Number.isFinite(minConfidence) &&
    minConfidence > 0 &&
    Number.isFinite(projectedConfidence) &&
    projectedConfidence < minConfidence &&
    projectedConfidence >= hardRejectScore
      ? Math.max(2, Math.min(5, Math.ceil((minConfidence - projectedConfidence) / 2)))
      : 0;
  const blocked =
    mustRouteUnderlyingToOption &&
    Number.isFinite(minConfidence) &&
    minConfidence > 0 &&
    Number.isFinite(projectedConfidence) &&
    projectedConfidence < Math.min(minConfidence, hardRejectScore);
  const routeConfidenceDecision = blocked
    ? "HARD_REJECT"
    : softPenaltyApplied > 0
      ? "SOFT_PENALTY"
      : "PASS";

  return {
    blocked,
    conf: Number.isFinite(confidence) ? confidence : null,
    minConf: Number.isFinite(minConfidence) ? minConfidence : null,
    preRouteAllowanceUsed: Number.isFinite(allowance) ? allowance : null,
    preRouteScore:
      Number.isFinite(Number(assessment?.preRouteScore))
        ? Number(assessment.preRouteScore)
        : Number.isFinite(confidence)
          ? confidence
          : null,
    expectedRouteAdjustment:
      Number.isFinite(Number(assessment?.expectedRouteAdjustment))
        ? Number(assessment.expectedRouteAdjustment)
        : Number.isFinite(allowance)
          ? allowance
          : null,
    routedScore: Number.isFinite(projectedConfidence) ? projectedConfidence : null,
    routeConfidence: assessment || null,
    routeConfidenceStage: "PRE",
    routeConfidenceDecision,
    estimateUsed: assessment != null,
    actualUsed: false,
    softPenaltyApplied,
    hardRejectScore,
  };
}

function resolveMinLotRiskPolicyDecision({
  config = env,
  lotSize,
  riskBudgetInr,
  strategyRiskFit,
  sizingRiskFit = null,
  riskFitMode = "FIT",
  minLotPolicy = "STRICT",
}) {
  const lot = Number(lotSize ?? 0);
  const budget = Number(riskBudgetInr ?? 0);
  const originalRiskInr = toFiniteOrNull(
    strategyRiskFit?.oneLotAllInRiskInr,
  );
  const effectiveRiskFit = sizingRiskFit || strategyRiskFit;
  const adjustedRiskInr = toFiniteOrNull(
    effectiveRiskFit?.oneLotAllInRiskInr ?? strategyRiskFit?.oneLotAllInRiskInr,
  );
  const riskBreachPct = toFiniteOrNull(
    effectiveRiskFit?.breachPct ?? strategyRiskFit?.breachPct,
  );
  const allowedBufferPct = Math.max(
    0,
    Number(config?.ALLOW_ONE_LOT_RISK_BUFFER_PCT ?? 0),
  );
  const forceOneLotRequireTag = Boolean(config?.FNO_FORCE_ONE_LOT_REQUIRE_TAG);
  const forceOneLotBreachPct = Math.max(
    0,
    Number(config?.FNO_FORCE_ONE_LOT_MAX_BREACH_PCT ?? 8),
  );
  const allowLegacyOneLot =
    lot > 1 &&
    (minLotPolicy === "FORCE_ONE_LOT_WITH_BREACH_TAG" ||
      (minLotPolicy === "FORCE_ONE_LOT" && !forceOneLotRequireTag));

  if (effectiveRiskFit?.fitsMinTradable) {
    return {
      allowOneLot: false,
      hardReject: false,
      riskFitDecision:
        riskFitMode === "COMPRESSED_FIT" ? "COMPRESSED" : "FIT",
      riskFitMode:
        riskFitMode === "COMPRESSED_FIT" ? "COMPRESSED_FIT" : "FIT",
      riskBreachState: "NONE",
      originalRiskInr,
      adjustedRiskInr,
      riskBreachPct,
      riskBreachTag: null,
      bufferPctAllowed: allowedBufferPct,
    };
  }

  if (
    allowedBufferPct > 0 &&
    adjustedRiskInr != null &&
    adjustedRiskInr > 0 &&
    riskBreachPct != null &&
    riskBreachPct <= allowedBufferPct
  ) {
    return {
      allowOneLot: true,
      hardReject: false,
      riskFitDecision: "BREACH_ALLOWED",
      riskFitMode: "BUFFER_ALLOWED",
      riskBreachState: "SOFT",
      originalRiskInr,
      adjustedRiskInr,
      riskBreachPct,
      riskBreachTag: "RISK_BREACH_ALLOWED",
      bufferPctAllowed: allowedBufferPct,
    };
  }

  const legacyForceCeilingInr =
    budget > 0 ? budget * (1 + forceOneLotBreachPct / 100) : 0;
  if (
    allowLegacyOneLot &&
    adjustedRiskInr != null &&
    adjustedRiskInr > 0 &&
    adjustedRiskInr <= legacyForceCeilingInr
  ) {
    return {
      allowOneLot: true,
      hardReject: false,
      riskFitDecision: "BREACH_ALLOWED",
      riskFitMode: "FORCE_ONE_LOT_BREACH",
      riskBreachState: "SOFT",
      originalRiskInr,
      adjustedRiskInr,
      riskBreachPct,
      riskBreachTag: "RISK_BREACH_ALLOWED",
      bufferPctAllowed: forceOneLotBreachPct,
    };
  }

  return {
    allowOneLot: false,
    hardReject: true,
    riskFitDecision: "REJECT",
    riskFitMode:
      riskFitMode === "COMPRESSED_FIT" ? "COMPRESSED_FIT" : "FIT",
    riskBreachState: "NONE",
    originalRiskInr,
    adjustedRiskInr,
    riskBreachPct,
    riskBreachTag: null,
    bufferPctAllowed: allowedBufferPct,
  };
}

function resolveSignalRiskBudgetInr({
  signalStyle,
  config = env,
}) {
  const style = String(signalStyle || "").toUpperCase();
  const openMult = style.includes("OPEN")
    ? Number(config.OPEN_RISK_MULT ?? 0.7)
    : 1.0;
  const riskPerTradeInr = Number(config.RISK_PER_TRADE_INR ?? 0);
  if (!(Number.isFinite(riskPerTradeInr) && riskPerTradeInr > 0)) return null;
  return riskPerTradeInr * openMult;
}

function estimateOptionStopRiskPts({
  config = env,
  estimatedPremium,
}) {
  const stopModeRaw = String(
    config.OPT_SL_MODE || config.OPT_STOP_MODE || "PREMIUM_PCT",
  )
    .toUpperCase()
    .trim();
  const stopMode = stopModeRaw === "PCT" ? "PREMIUM_PCT" : stopModeRaw;

  if (
    stopMode === "POINTS" ||
    stopMode === "PREMIUM_POINTS" ||
    stopMode === "PRICE"
  ) {
    const points = Number(config.OPT_STOP_POINTS ?? config.OPT_SL_POINTS ?? 0);
    return Number.isFinite(points) && points > 0 ? points : null;
  }

  if (stopMode === "UNDERLYING_ATR") {
    return null;
  }

  const slPct = Number(config.OPT_STOP_PCT ?? config.OPT_SL_PCT ?? 12);
  if (!(Number.isFinite(estimatedPremium) && estimatedPremium > 0)) return null;
  if (!(Number.isFinite(slPct) && slPct > 0)) return null;
  return estimatedPremium * (slPct / 100);
}

function evaluatePreRouteTradability({
  signal,
  underlying,
  lotSize,
  riskBudgetInr,
  config = env,
}) {
  const normalizedLotSize = Number(lotSize ?? 0);
  const budget = Number(riskBudgetInr ?? 0);
  const minLotPolicy = String(config.FNO_MIN_LOT_POLICY || "STRICT").toUpperCase();
  if (!(normalizedLotSize > 1) || !(budget > 0) || minLotPolicy !== "STRICT") {
    return {
      blocked: false,
      reasonCode: null,
      tradabilityState: "SKIPPED",
      meta: {
        lotSize: Number.isFinite(normalizedLotSize) ? normalizedLotSize : null,
        riskBudgetInr: Number.isFinite(budget) ? budget : null,
        minLotPolicy,
      },
    };
  }

  const premiumBand = getPremiumBandForUnderlying(underlying || signal?.underlying_symbol);
  const minPrem = Number(premiumBand?.minPrem ?? NaN);
  const maxPrem = Number(premiumBand?.maxPrem ?? NaN);
  if (!(Number.isFinite(minPrem) && minPrem > 0 && Number.isFinite(maxPrem) && maxPrem >= minPrem)) {
    return {
      blocked: false,
      reasonCode: null,
      tradabilityState: "INSUFFICIENT_BAND_CONTEXT",
      meta: {
        premiumBand: premiumBand || null,
        lotSize: normalizedLotSize,
        riskBudgetInr: budget,
        minLotPolicy,
      },
    };
  }

  const deltaMin = Number(config.OPT_DELTA_BAND_MIN ?? 0.35);
  const deltaMax = Number(config.OPT_DELTA_BAND_MAX ?? 0.65);
  const deltaTarget = Number(config.OPT_DELTA_TARGET ?? 0.5);
  const deltaSpan =
    Number.isFinite(deltaMax) && Number.isFinite(deltaMin) && deltaMax > deltaMin
      ? deltaMax - deltaMin
      : 0.3;
  const expectedPremium =
    minPrem +
    (maxPrem - minPrem) *
      clampMetric((deltaTarget - deltaMin) / deltaSpan, 0.15, 0.85);
  const minimumRiskPts = estimateOptionStopRiskPts({
    config,
    estimatedPremium: minPrem,
  });
  const expectedRiskPts = estimateOptionStopRiskPts({
    config,
    estimatedPremium: expectedPremium,
  });
  if (!(Number.isFinite(minimumRiskPts) && minimumRiskPts > 0 && Number.isFinite(expectedRiskPts) && expectedRiskPts > 0)) {
    return {
      blocked: false,
      reasonCode: null,
      tradabilityState: "INSUFFICIENT_STOP_CONTEXT",
      meta: {
        premiumBand,
        expectedPremium: Number.isFinite(expectedPremium) ? expectedPremium : null,
        lotSize: normalizedLotSize,
        riskBudgetInr: budget,
        minLotPolicy,
      },
    };
  }

  const expectedSlippagePts = Number(config.EXPECTED_SLIPPAGE_POINTS ?? 0);
  const feePerLotInr = Number(config.EXPECTED_FEES_PER_LOT_INR ?? 0);
  const minimumOneLotRiskInr =
    (minimumRiskPts + Math.max(0, expectedSlippagePts)) * normalizedLotSize +
    Math.max(0, feePerLotInr);
  const estimatedOneLotRiskInr =
    (expectedRiskPts + Math.max(0, expectedSlippagePts)) * normalizedLotSize +
    Math.max(0, feePerLotInr);
  const impossible = minimumOneLotRiskInr > budget;
  const likelyReject = estimatedOneLotRiskInr > budget * 1.08;

  return {
    blocked: impossible || likelyReject,
    reasonCode: impossible
      ? "OPTION_EXPRESSION_IMPOSSIBLE"
      : likelyReject
        ? "OPTION_EXPRESSION_NOT_TRADABLE"
        : null,
    tradabilityState: impossible
      ? "IMPOSSIBLE"
      : likelyReject
        ? "LIKELY_UNTRADABLE"
        : "LIKELY_TRADABLE",
    meta: {
      underlying: underlying || null,
      lotSize: normalizedLotSize,
      riskBudgetInr: budget,
      minLotPolicy,
      premiumBand: {
        minPrem,
        maxPrem,
        enforced: premiumBand?.enforce === true,
      },
      expectedPremium: Math.round(expectedPremium * 10) / 10,
      minimumOneLotRiskInr: Math.round(minimumOneLotRiskInr * 10) / 10,
      estimatedOneLotRiskInr: Math.round(estimatedOneLotRiskInr * 10) / 10,
      stopRiskPts: Math.round(expectedRiskPts * 100) / 100,
      minimumRiskPts: Math.round(minimumRiskPts * 100) / 100,
    },
  };
}

function resolvePreEntrySlFitDecision({
  config = env,
  optionMeta,
  lotSize,
  strategyRiskFit,
}) {
  const slFitEnabled = envFlagEnabled(
    config?.ENABLE_SL_COMPRESSION_WHEN_BLOCKED,
    envFlagEnabled(config?.PRE_ENTRY_SL_COMPRESSION_ENABLED, false) ||
      envFlagEnabled(config?.OPT_SL_FIT_ENABLED, false),
  );
  const slFitWhenCapBlocks = envFlagEnabled(
    config?.OPT_SL_FIT_WHEN_CAP_BLOCKS,
    slFitEnabled,
  );
  const strategyFitsMinTradable = Boolean(strategyRiskFit?.fitsMinTradable);

  let compressionSkipReason = null;
  if (!optionMeta) {
    compressionSkipReason = "NOT_OPTION_PREMIUM";
  } else if (!(Number(lotSize) > 1)) {
    compressionSkipReason = "LOT_SIZE_NOT_COMPRESSIBLE";
  } else if (!slFitEnabled) {
    compressionSkipReason = "SL_FIT_DISABLED";
  } else if (strategyFitsMinTradable) {
    compressionSkipReason = "STRATEGY_ALREADY_FITS";
  } else if (!slFitWhenCapBlocks) {
    // Current scope is cap-block-only; no proactive compression path exists here.
    compressionSkipReason = "CAP_BLOCK_COMPRESSION_DISABLED";
  }

  return {
    strategyFitsMinTradable,
    slFitEnabled,
    slFitWhenCapBlocks,
    compressionAttempted: compressionSkipReason == null,
    compressionSkipReason,
  };
}

function buildCompressionTelemetryMeta(meta = {}) {
  return {
    compressionPts: toFiniteOrNull(meta?.compressionPts),
    maxCompressionPct: toFiniteOrNull(meta?.maxCompressionPct),
    maxCompressionTicks: toFiniteOrNull(meta?.maxCompressionTicks),
    maxCompressionPoints: toFiniteOrNull(meta?.maxCompressionPoints),
    maxCompressionPtsByTick: toFiniteOrNull(meta?.maxCompressionPtsByTick),
    maxCompressionPtsEffective: toFiniteOrNull(
      meta?.maxCompressionPtsEffective,
    ),
    limitSourceUsed:
      typeof meta?.limitSourceUsed === "string" && meta.limitSourceUsed.trim()
        ? meta.limitSourceUsed
        : null,
  };
}

function buildEarlyFailRuntimeTelemetry({
  plan,
  trade,
  verbose = true,
}) {
  const meta = plan?.meta || {};
  const patch = plan?.tradePatch || {};
  const base = {
    earlyFailArmed: Boolean(meta?.earlyFailArmed ?? patch?.earlyFailArmed),
    earlyFailMode: meta?.earlyFailMode ?? patch?.earlyFailMode ?? null,
    earlyFailReason: meta?.earlyFailReason ?? patch?.earlyFailReason ?? null,
    earlyFailEligible: Boolean(
      meta?.earlyFailEligible ?? patch?.earlyFailEligible,
    ),
    earlyFailAuthority:
      meta?.earlyFailAuthority ?? patch?.earlyFailAuthority ?? null,
    earlyFailDecisionState:
      meta?.earlyFailDecisionState ?? patch?.earlyFailDecisionState ?? null,
    earlyFailTradeAgeMs: toFiniteOrNull(
      meta?.earlyFailTradeAgeMs ?? patch?.earlyFailTradeAgeMs,
    ),
    earlyFailConfirmTicks: toFiniteOrNull(
      meta?.earlyFailConfirmTicks ?? patch?.earlyFailConfirmTicks,
    ),
    earlyFailConfirmMs: toFiniteOrNull(
      meta?.earlyFailConfirmMs ?? patch?.earlyFailConfirmMs,
    ),
    earlyFailReferenceLevel: toFiniteOrNull(
      meta?.earlyFailReferenceLevel ?? patch?.earlyFailReferenceLevel,
    ),
    earlyFailReferenceSource:
      meta?.earlyFailReferenceSource ??
      patch?.earlyFailReferenceSource ??
      null,
    earlyFailBreachAmount: toFiniteOrNull(
      meta?.earlyFailBreachAmount ?? patch?.earlyFailBreachAmount,
    ),
  };
  if (!verbose) return base;

  return {
    ...base,
    earlyFailCandidateReason:
      meta?.earlyFailCandidateReason ?? patch?.earlyFailCandidateReason ?? null,
    earlyFailSinceTs: meta?.earlyFailSinceTs ?? patch?.earlyFailSinceTs ?? null,
    earlyFailBarsSinceEntry: toFiniteOrNull(
      meta?.earlyFailBarsSinceEntry ?? patch?.earlyFailBarsSinceEntry,
    ),
    earlyFailConfirmTarget: toFiniteOrNull(
      meta?.earlyFailConfirmTarget ?? patch?.earlyFailConfirmTarget,
    ),
    earlyFailConfirmTargetMs: toFiniteOrNull(
      meta?.earlyFailConfirmTargetMs ?? patch?.earlyFailConfirmTargetMs,
    ),
    earlyFailBufferUsed: toFiniteOrNull(
      meta?.earlyFailBufferUsed ?? patch?.earlyFailBufferUsed,
    ),
    earlyFailMfeAtDecision: toFiniteOrNull(
      meta?.earlyFailMfeAtDecision ?? patch?.earlyFailMfeAtDecision,
    ),
    earlyFailAdverseRAtDecision: toFiniteOrNull(
      meta?.earlyFailAdverseRAtDecision ?? patch?.earlyFailAdverseRAtDecision,
    ),
    earlyFailMaeAtDecision: toFiniteOrNull(
      meta?.earlyFailMaeAtDecision ?? patch?.earlyFailMaeAtDecision,
    ),
    earlyFailHoldReason:
      meta?.earlyFailHoldReason ?? patch?.earlyFailHoldReason ?? null,
    earlyFailAdverseUnderlyingBps: toFiniteOrNull(
      meta?.earlyFailAdverseUnderlyingBps,
    ),
  };
}

function resolveOptimizerAdmission({
  env,
  optimizerResult,
  confidenceRaw,
  minConf,
}) {
  const confidenceMult = Number(optimizerResult?.meta?.confidenceMult ?? 1);
  const qtyMult = Number(optimizerResult?.meta?.qtyMult ?? 1);
  const confidenceUsedForTelemetry =
    Number.isFinite(Number(confidenceRaw)) && Number.isFinite(confidenceMult)
      ? Number(confidenceRaw) * confidenceMult
      : Number(confidenceRaw);
  const compatibilityMode =
    String(env?.OPT_RECHECK_CONF_AFTER_DEWEIGHT || "false").toLowerCase() ===
    "true";

  if (
    compatibilityMode &&
    Number.isFinite(Number(minConf)) &&
    Number(minConf) > 0 &&
    Number.isFinite(confidenceUsedForTelemetry) &&
    confidenceUsedForTelemetry < Number(minConf)
  ) {
    return {
      ok: false,
      reason: "LOW_CONFIDENCE_AFTER_OPT_COMPAT",
      compatibilityMode,
      confidenceMult,
      qtyMult,
      confidenceUsedForTelemetry,
    };
  }

  return {
    ok: true,
    compatibilityMode,
    confidenceMult,
    qtyMult,
    confidenceUsedForTelemetry,
  };
}

function resolveOptimizerRrTarget({ plan, optimizerResult, rrBase }) {
  const base = Number.isFinite(Number(rrBase)) ? Number(rrBase) : 1;
  const planRr =
    plan?.ok && Number.isFinite(Number(plan?.rr)) ? Number(plan.rr) : null;
  const optimizerRr = Number.isFinite(Number(optimizerResult?.meta?.rrUsed))
    ? Number(optimizerResult.meta.rrUsed)
    : null;

  if (planRr != null && optimizerRr != null) {
    return Math.max(planRr, optimizerRr);
  }
  if (planRr != null) return planRr;
  if (optimizerRr != null) return optimizerRr;
  return base;
}

function buildFrozenOptimizerContext({
  optimizerResult,
  confidenceRaw,
  rrBase,
}) {
  const meta = optimizerResult?.meta || {};
  return {
    schemaVersion: 2,
    keySchemaVersion: meta.keySchemaVersion ?? "NORMALIZED_V2",
    underlying: meta.underlying ?? null,
    optType: meta.optType ?? null,
    strategyId: meta.strategyId ?? null,
    bucket: meta.bucket ?? null,
    dteBand: meta.dteBand ?? null,
    deltaBand: meta.deltaBand ?? null,
    styleBand: meta.styleBand ?? null,
    keyKey: meta.keyKey ?? null,
    stratKey: meta.stratKey ?? null,
    confidenceRaw: toFiniteOrNull(confidenceRaw),
    confidenceMult: toFiniteOrNull(meta.confidenceMult) ?? 1,
    qtyMult: toFiniteOrNull(meta.qtyMult) ?? 1,
    rrBase: toFiniteOrNull(rrBase),
    rrUsed: toFiniteOrNull(meta.rrUsed),
    spreadBps: toFiniteOrNull(meta.spreadBps),
    spreadRegime: meta.spreadRegime ?? null,
    action: optimizerResult?.action ?? "PASS",
    reason: optimizerResult?.reason ?? null,
  };
}

const ORDER_STATUS_RANK = Object.freeze({
  OPEN: 1,
  TRIGGER_PENDING: 2,
  MODIFY_PENDING: 2,
  AMO_REQ_RECEIVED: 2,
  PARTIAL: 3,
  COMPLETE: 4,
  CANCELLED: 4,
  CANCELED: 4,
  REJECTED: 4,
  LAPSED: 4,
});

function orderStatusRank(status) {
  const s = String(status || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return ORDER_STATUS_RANK[s] || 0;
}

function isOrderStatusRegression(prevStatus, nextStatus) {
  const prev = orderStatusRank(prevStatus);
  const next = orderStatusRank(nextStatus);
  return prev > 0 && next > 0 && next < prev;
}

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(0, Math.min(1, Number(p ?? 0.95)));
  const idx = Math.min(
    sorted.length - 1,
    Math.floor(rank * (sorted.length - 1)),
  );
  return sorted[idx];
}

function parseOrderTimestampMs(order) {
  const raw =
    order?.order_timestamp ||
    order?.exchange_timestamp ||
    order?.exchange_update_timestamp ||
    order?.created_at ||
    order?.updated_at ||
    null;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function parseOrderUpdateTimestampMs(order) {
  const raw =
    order?.exchange_update_timestamp ||
    order?.exchange_timestamp ||
    order?.order_timestamp ||
    order?.updated_at ||
    order?.created_at ||
    null;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function buildOrderUpdateSignature(order) {
  return JSON.stringify({
    status: String(order?.status || "").toUpperCase(),
    filledQuantity: Number(order?.filled_quantity ?? 0),
    averagePrice: Number(order?.average_price ?? 0),
    pendingQuantity: Number(order?.pending_quantity ?? 0),
    updatedAtMs: parseOrderUpdateTimestampMs(order),
  });
}

const ORDER_UPDATE_SIGNATURE_CACHE_LIMIT = 12;
const ENTRY_REPLAY_BLOCKED_STATUSES = new Set([
  STATUS.ENTRY_FILLED,
  STATUS.SL_PLACED,
  STATUS.SL_OPEN,
  STATUS.SL_CONFIRMED,
  STATUS.LIVE,
  STATUS.EXITED_TARGET,
  STATUS.EXITED_SL,
  STATUS.ENTRY_FAILED,
  STATUS.ENTRY_CANCELLED,
  STATUS.PANIC_EXIT_PLACED,
  STATUS.PANIC_EXIT_CONFIRMED,
  STATUS.GUARD_FAILED,
  STATUS.CLOSED,
]);
const STOP_IMPROVE_BLOCKED_REASON_TAGS = Object.freeze(
  new Set([
    "STRUCTURE_TRAIL_GATED",
    "MIN_HOLD_BLOCK",
    "EXEC_SPREAD_BLOCK",
    "EXEC_DISTANCE_BLOCK",
  ]),
);
const LOSS_CONTAINMENT_STOP_AUTHORITIES = Object.freeze(
  new Set(["EARLY_FAIL_ENGINE", "TIME_STOP_ENGINE", "POST_FILL_RISK_ENGINE"]),
);

function getOrderUpdateSignatureHistory(signatureMap, orderId) {
  const raw = signatureMap.get(orderId);
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw) return [raw];
  return [];
}

function hasSeenOrderUpdateSignature(signatureMap, orderId, signature) {
  if (!signature) return false;
  return getOrderUpdateSignatureHistory(signatureMap, orderId).includes(
    signature,
  );
}

function rememberOrderUpdateSignature(signatureMap, orderId, signature) {
  if (!orderId || !signature) return;
  const history = getOrderUpdateSignatureHistory(signatureMap, orderId);
  if (history.includes(signature)) return;
  const next = [...history, signature].slice(-ORDER_UPDATE_SIGNATURE_CACHE_LIMIT);
  signatureMap.set(orderId, next);
}

function isBetterStopForTradeSide(side, next, prev) {
  if (!Number.isFinite(next) || !Number.isFinite(prev)) return false;
  return String(side || "BUY").toUpperCase() === "SELL" ? next < prev : next > prev;
}

function stopImproveDistance(side, next, prev) {
  if (!Number.isFinite(next) || !Number.isFinite(prev)) return 0;
  return String(side || "BUY").toUpperCase() === "SELL" ? prev - next : next - prev;
}

function bestStopForTradeSide(side, levels = []) {
  let best = null;
  for (const level of levels) {
    const candidate = Number(level);
    if (!Number.isFinite(candidate)) continue;
    if (best == null || isBetterStopForTradeSide(side, candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

function hasOnlyBlockedStopReasonTags(tags = []) {
  return (
    Array.isArray(tags) &&
    tags.length > 0 &&
    tags.every((tag) =>
      STOP_IMPROVE_BLOCKED_REASON_TAGS.has(String(tag || "")),
    )
  );
}

function evaluateDynamicSlModifyAuthority({ trade, plan }) {
  const side = String(trade?.side || "BUY").toUpperCase();
  const tick = Math.max(Number(trade?.instrument?.tick_size ?? 0.05) || 0.05, 0.01);
  const minImproveTicks = Math.max(
    1,
    Number(env.DYNAMIC_EXIT_BROKER_AUTH_MIN_TICKS ?? 1),
  );
  const minImproveDistance = tick * minImproveTicks;
  const currentBrokerStopLoss =
    toFiniteOrNull(trade?.brokerStopLoss) ??
    toFiniteOrNull(trade?.stopLoss) ??
    toFiniteOrNull(trade?.slTrigger);
  const desiredStopLoss = toFiniteOrNull(plan?.meta?.desiredStopLoss);
  const finalStopLoss =
    toFiniteOrNull(plan?.meta?.finalStopLoss) ??
    toFiniteOrNull(plan?.finalStop) ??
    toFiniteOrNull(plan?.sl?.stopLoss);
  const hardFloor =
    toFiniteOrNull(plan?.meta?.executableHardFloor) ??
    toFiniteOrNull(plan?.meta?.hardFloor) ??
    toFiniteOrNull(plan?.hardFloor);
  const telemetryProposalFloor =
    toFiniteOrNull(plan?.meta?.telemetryProposalFloor) ??
    toFiniteOrNull(plan?.telemetryProposalFloor);
  const structureTrailSource = plan?.meta?.structureTrailSource ?? null;
  const structureTrailAllowed = Boolean(plan?.meta?.structureTrailAllowed);
  const protectionGateOpen = Boolean(plan?.meta?.protectionGateOpen);
  const winnerModeActive = Boolean(plan?.meta?.winnerModeActive);
  const mfeLockTier = Number(plan?.meta?.mfeLockTier ?? plan?.mfeLockTier ?? 0);
  const reasonTags = Array.isArray(plan?.meta?.reasonTags) ? plan.meta.reasonTags : [];
  const exitAuthority = String(
    plan?.meta?.exitAuthority ??
      plan?.tradePatch?.exitAuthority ??
      trade?.exitAuthority ??
      "",
  ).toUpperCase();
  const explicitLossContainmentAuthority =
    LOSS_CONTAINMENT_STOP_AUTHORITIES.has(exitAuthority) &&
    Boolean(
      plan?.meta?.earlyFailArmed ||
        plan?.tradePatch?.earlyFailArmed ||
        plan?.action?.exitNow,
    );
  const safePreBeStopCompressionEnabled =
    env.DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION === true;
  const onlyBlockedReasonTags = hasOnlyBlockedStopReasonTags(reasonTags);
  const liveProtectionAuthorityActive = Boolean(
    plan?.meta?.beApplied ||
      plan?.meta?.trailAllowed ||
      plan?.meta?.trailActive ||
      plan?.meta?.greenLockActive ||
      plan?.meta?.profitLockArmed ||
      mfeLockTier > 0 ||
      plan?.meta?.tightenActive ||
      plan?.meta?.hardGivebackExitArmed ||
      plan?.meta?.shadowExitActive,
  );
  const derivedAuthorityActive = Boolean(
    liveProtectionAuthorityActive ||
      plan?.meta?.forceBePriorityMove ||
      explicitLossContainmentAuthority ||
      safePreBeStopCompressionEnabled,
  );
  const stopImproveAuthorized =
    plan?.meta?.stopImproveAuthorized === true ||
    plan?.stopImproveAuthorized === true;
  const proposalStopLoss = bestStopForTradeSide(side, [
    telemetryProposalFloor,
    desiredStopLoss,
    finalStopLoss,
  ]);
  const proposalImprovesBrokerStop = Boolean(
    Number.isFinite(currentBrokerStopLoss) &&
      Number.isFinite(proposalStopLoss) &&
      isBetterStopForTradeSide(side, proposalStopLoss, currentBrokerStopLoss) &&
      stopImproveDistance(side, proposalStopLoss, currentBrokerStopLoss) >=
        minImproveDistance,
  );
  const finalStopImprovesBrokerStop = Boolean(
    Number.isFinite(currentBrokerStopLoss) &&
      Number.isFinite(finalStopLoss) &&
      isBetterStopForTradeSide(side, finalStopLoss, currentBrokerStopLoss) &&
      stopImproveDistance(side, finalStopLoss, currentBrokerStopLoss) >=
        minImproveDistance,
  );
  let blockedReason = String(
    plan?.meta?.stopImproveBlockedReason || "",
  ).trim() || null;
  if (!blockedReason && proposalImprovesBrokerStop && !stopImproveAuthorized) {
    blockedReason = "NO_AUTHORITY";
  } else if (
    !blockedReason &&
    proposalImprovesBrokerStop &&
    onlyBlockedReasonTags
  ) {
    blockedReason = "BLOCKED_REASON_TAGS_ONLY";
  } else if (
    !blockedReason &&
    proposalImprovesBrokerStop &&
    !finalStopImprovesBrokerStop
  ) {
    blockedReason = "NO_MEANINGFUL_IMPROVEMENT";
  }

  return {
    allowed:
      finalStopImprovesBrokerStop &&
      stopImproveAuthorized &&
      derivedAuthorityActive &&
      !onlyBlockedReasonTags,
    proposalImprovesBrokerStop,
    finalStopImprovesBrokerStop,
    stopImproveAuthorized,
    derivedAuthorityActive,
    blockedReason,
    currentBrokerStopLoss,
    desiredStopLoss,
    finalStopLoss,
    hardFloor,
    telemetryProposalFloor,
    structureTrailSource,
    structureTrailAllowed,
    protectionGateOpen,
    winnerModeActive,
    mfeLockTier,
    exitAuthority: exitAuthority || null,
    reasonTags,
  };
}

function isTerminalOrderStatus(status) {
  const s = String(status || "").toUpperCase();
  return ["COMPLETE", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"].includes(
    s,
  );
}

function worseSlippageBps({ side, expected, actual, leg }) {
  const exp = Number(expected);
  const act = Number(actual);
  if (!(exp > 0) || !(act > 0)) return null;

  const s = String(side || "BUY").toUpperCase();
  const isExit = String(leg || "ENTRY").toUpperCase() === "EXIT";

  // For BUY: entry worse if act > exp, exit worse if act < exp
  // For SELL: entry worse if act < exp, exit worse if act > exp
  let worse = 0;

  if (s === "BUY") {
    worse = isExit ? exp - act : act - exp;
  } else {
    worse = isExit ? act - exp : exp - act;
  }

  if (worse <= 0) return 0;
  return (worse / exp) * 10000;
}

function worseSlippageInr({ side, expected, actual, qty, leg }) {
  const exp = Number(expected);
  const act = Number(actual);
  const q = Number(qty ?? 0);
  if (!(exp > 0) || !(act > 0) || !(q > 0)) return null;

  const bps = worseSlippageBps({ side, expected: exp, actual: act, leg });
  if (!Number.isFinite(bps) || bps <= 0) return 0;

  const s = String(side || "BUY").toUpperCase();
  const isExit = String(leg || "ENTRY").toUpperCase() === "EXIT";

  let diff = 0;
  if (s === "BUY") diff = isExit ? exp - act : act - exp;
  else diff = isExit ? act - exp : exp - act;

  return diff > 0 ? diff * q : 0;
}

function hasMaterialOrderSnapshotChange(prev, next) {
  if (!prev) return true;
  const keys = [
    "status",
    "filled_quantity",
    "pending_quantity",
    "average_price",
    "price",
    "trigger_price",
    "quantity",
    "order_type",
  ];
  for (const key of keys) {
    const a = prev?.[key];
    const b = next?.[key];
    if (String(a ?? "") !== String(b ?? "")) return true;
  }
  return false;
}

function inferExecutionRiskPts(trade = {}, fallbackEntry = NaN, fallbackStop = NaN) {
  const explicit = toFiniteOrNull(trade?.executionRiskPts);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const actual = toFiniteOrNull(
    trade?.actualRiskPts ??
      trade?.riskStopPts ??
      trade?.initialStrategyRiskPts,
  );
  if (Number.isFinite(actual) && actual > 0) return actual;
  const strategyStop = toFiniteOrNull(
    trade?.strategyStopLoss ?? trade?.initialStopLoss ?? fallbackStop,
  );
  const entry = toFiniteOrNull(trade?.entryPrice ?? fallbackEntry);
  if (Number.isFinite(strategyStop) && Number.isFinite(entry)) {
    const riskPts = Math.abs(entry - strategyStop);
    if (riskPts > 0) return riskPts;
  }
  return null;
}

function buildExecutionRiskPatch({
  trade,
  qty,
  entryPrice,
  stopLoss,
}) {
  const liveQty = Math.max(
    0,
    Number(qty ?? trade?.qty ?? trade?.initialQty ?? 0),
  );
  const riskPts = inferExecutionRiskPts(trade, entryPrice, stopLoss);
  const riskInr =
    Number.isFinite(riskPts) && liveQty > 0 ? riskPts * liveQty : null;
  return {
    executionRiskPts: Number.isFinite(riskPts) ? riskPts : null,
    executionRiskQty: liveQty > 0 ? liveQty : null,
    executionRiskInr: Number.isFinite(riskInr) ? riskInr : null,
  };
}

function protectionUpgradeStatePatch({
  proposedStopLoss,
  fallbackMode = null,
  pending = false,
  softFailed = false,
  reason = null,
  now = new Date(),
}) {
  return {
    protectionUpgradePending: Boolean(pending),
    protectionUpgradeSoftFailed: Boolean(softFailed),
    protectionUpgradeFallbackMode: fallbackMode || null,
    protectionUpgradeUnconfirmedSince: pending ? now : null,
    shadowProtectionActiveReason: pending ? reason || null : null,
    protectionUpgradeTargetStopLoss: Number.isFinite(Number(proposedStopLoss))
      ? Number(proposedStopLoss)
      : null,
  };
}

function clearProtectionUpgradeStatePatch() {
  return {
    protectionUpgradePending: false,
    protectionUpgradeSoftFailed: false,
    protectionUpgradeFallbackMode: null,
    protectionUpgradeUnconfirmedSince: null,
    shadowProtectionActiveReason: null,
    protectionUpgradeTargetStopLoss: null,
  };
}

function isSoftBrokerModifyError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("gateway") ||
    msg.includes("timeout")
  );
}

function protectionUpgradeReason({
  trade,
  source,
  protectedStopSource = null,
}) {
  if (source === "TP1_BE_REPRICE") return "TP1_BE_REPRICE";
  const label = String(protectedStopSource || source || "")
    .trim()
    .toUpperCase();
  if (label) return label;
  if (trade?.tp1Done) return "RUNNER_PROTECTION";
  return "PROTECTION_UPGRADE";
}

function buildRunnerRebasePatch({
  trade,
  remainingQty,
  runnerPrice,
  executablePrice,
  realizedTp1PnlInr,
  source = "TP1",
  now = new Date(),
}) {
  const qty = Math.max(0, Number(remainingQty ?? trade?.qty ?? 0));
  const entry = Number(trade?.entryPrice ?? 0);
  const side = String(trade?.side || "BUY").toUpperCase();
  const markPrice = Number.isFinite(Number(runnerPrice))
    ? Number(runnerPrice)
    : entry;
  const execPrice = Number.isFinite(Number(executablePrice))
    ? Number(executablePrice)
    : markPrice;
  const executionRisk = buildExecutionRiskPatch({
    trade,
    qty,
    entryPrice: entry,
    stopLoss:
      trade?.strategyStopLoss ??
      trade?.initialStopLoss ??
      trade?.stopLoss,
  });
  const riskInr = Number(executionRisk?.executionRiskInr ?? 0);
  const peakPnlInr =
    side === "SELL" ? (entry - markPrice) * qty : (markPrice - entry) * qty;
  const peakExecutablePnlInr =
    side === "SELL" ? (entry - execPrice) * qty : (execPrice - entry) * qty;
  const peakPnlR = riskInr > 0 ? peakPnlInr / riskInr : null;
  const peakExecutableR = riskInr > 0 ? peakExecutablePnlInr / riskInr : null;
  const protectedPeakR = Number.isFinite(peakExecutableR)
    ? peakExecutableR
    : peakPnlR;

  return {
    ...executionRisk,
    runnerQty: qty,
    runnerRebasedAt: now,
    runnerRebaseSource: source,
    runnerBaselineQty: qty,
    runnerBaselineLtp: markPrice,
    runnerBaselineExecutablePrice: execPrice,
    runnerBaselinePnlInr: peakPnlInr,
    runnerBaselineExecutablePnlInr: peakExecutablePnlInr,
    runnerRealizedPnlInr: Number.isFinite(Number(realizedTp1PnlInr))
      ? Number(realizedTp1PnlInr)
      : null,
    peakLtp: markPrice,
    peakPnlInr,
    peakPnlR,
    peakExecutablePnlInr,
    peakExecutableR,
    currentExecutableR: peakExecutableR,
    protectedPeakR,
    protectedCurrentR: protectedPeakR,
    mfeLockTier: 0,
    mfeLockFloorR: 0,
    mfeLockFloorPrice: null,
    tightenActive: false,
    tightenActivatedAtR: null,
    post1RTrailGapR: null,
    post1RTrailFloorPrice: null,
    givebackR: 0,
    givebackPct: 0,
    hardGivebackExitArmed: false,
    hardGivebackRule: null,
    hardGivebackThresholdR: null,
    hardGivebackThresholdPct: null,
    hardGivebackConfirmTicks: 0,
    givebackConfirmMs: 0,
    hardGivebackArmedAt: null,
    shouldExitNowReason: null,
    greenLockActive: false,
    greenLockFloorPrice: null,
    profitLockArmed: false,
    profitLockArmedAt: null,
    profitLockInr: null,
    profitLockR: null,
    lastProtectedR: protectedPeakR,
    lastProtectedInr: peakExecutablePnlInr,
    lastExitPlanReason: null,
  };
}

const PROTECTION_SAFETY_SOURCE_TAGS = Object.freeze(
  new Set([
    "TRUE_BE",
    "MIN_GREEN",
    "BE_PROFIT_LOCK",
    "PROFIT_LOCK",
    "GREEN_LOCK",
    "TP1_BE_REPRICE",
  ]),
);

class TradeManager {
  constructor({ kite, riskEngine }) {
    this.kite = kite;
    this.risk = riskEngine;
    if (this.risk?.setStateChangeHandler) {
      this.risk.setStateChangeHandler((state) => {
        this._persistRiskState(state).catch((err) => {
          reportFault({
            code: "TRADING_TRADEMANAGER_ASYNC",
            err,
            message: "[src/trading/tradeManager.js] async task failed",
          });
        });
      });
    }

    this.lastPriceByToken = new Map(); // token -> ltp
    this.lastTickAtByToken = new Map(); // token -> ts
    this.activeTradeId = null; // single-stock mode
    this.recoveredPosition = null; // set when positions exist but trade state missing
    this._initPromise = null;
    this._initialized = false;
    this._stopped = false;
    this._stopPromise = null;
    this._activeTradeDbMarker = null;
    this._liveOrderSnapshotsHydrated = false;

    // OCO race safety: remember the most recently closed trade for a short window
    // so we can detect and clean up late exit fills (double-fill) and leftover exit orders.
    this.lastClosedTradeId = null;
    this.lastClosedToken = null;
    this.lastClosedAt = 0;

    // Prevent overlapping OCO reconcile ticks
    this._ocoReconcileInFlight = false;

    // Prevent duplicate SL/TARGET placement (concurrent calls)
    this.exitPlacementLocks = new Set(); // tradeId -> locked?

    // Ignore expected OCO cancels
    this.expectedCancelOrderIds = new Set(); // orderId strings

    // Throttle expensive DB-based checks (avoid per-tick Mongo hammering)
    this._lastDailyLossCheckAt = 0;
    this._dailyLossInFlight = false;
    this._lastFlattenCheckAt = 0;
    this._lastEodConvertCheckAt = 0;
    this._eodConvertAttempted = new Set();

    // Optional fallback LTP fetch throttle (helps OPT mode when ticks are sparse)
    this._lastLtpFetchAtByToken = new Map(); // token -> ts

    // Order rate limits + daily count
    this.orderLimiter = new OrderRateLimiter({
      maxPerSec: Number(env.MAX_ORDERS_PER_SEC ?? 10),
      maxPerMin: Number(env.MAX_ORDERS_PER_MIN ?? 200),
      maxPerDay: Number(env.MAX_ORDERS_PER_DAY ?? 3000),
    });
    this.brokerOrderLimiter = new OrderRateLimiter({
      maxPerSec: Number(
        env.BROKER_MAX_ORDERS_PER_SEC ?? env.MAX_ORDERS_PER_SEC ?? 10,
      ),
      maxPerMin: Number(
        env.BROKER_MAX_ORDERS_PER_MIN ?? env.MAX_ORDERS_PER_MIN ?? 200,
      ),
    });
    this.ordersPlacedToday = 0;

    // Dynamic exit adjustments (trail SL / adjust target)
    this._dynExitLastAt = new Map(); // tradeId -> last modify ts
    this._dynExitLastEvalAt = new Map(); // tradeId -> last eval ts
    this._lastOrdersById = new Map(); // last broker order map (reconcile)
    this._terminalOrderStatusById = new Map(); // orderId -> terminal status
    this._processedOrderUpdateSignatureById = new Map(); // orderId -> recent linked update signatures
    this._orphanOrderUpdateSignatureById = new Map(); // orderId -> recent pre-link orphan signatures
    this._lastModifyAttemptAtByOrder = new Map(); // orderId -> ts
    this._exitQtyLastSyncedByOrderId = new Map(); // orderId -> { qty, syncedAt }
    this._exitLoopTimer = null;
    this._exitLoopInFlight = false;
    this._dynExitFailCount = new Map(); // tradeId -> failure count
    this._dynExitDisabled = new Set(); // tradeId -> disable trailing
    this._dynExitInFlight = new Set(); // tradeId -> lock for dynamic exit
    this._dynExitFailBackoffUntil = new Map(); // tradeId -> ts backoff
    this._dynPeakLtpByTrade = new Map(); // tradeId -> peak ltp (tick-driven)
    this._dynExitCadenceStats = {
      attempts: 0,
      skippedEvalThrottle: 0,
      skippedModifyThrottle: 0,
      skippedBackoff: 0,
      skippedInFlight: 0,
      evalRuns: 0,
      evalNoPlan: 0,
      modifyRuns: 0,
      planExitNow: 0,
      errors: 0,
      burstWindowMs: 10_000,
      evalTs: [],
      modifyTs: [],
      evalIntervalsMs: [],
      modifyIntervalsMs: [],
      maxEvalBurst: 0,
      maxModifyBurst: 0,
      lastEvalAt: null,
      lastModifyAt: null,
    };
    this._orphanReplayStats = {
      queued: 0,
      replayedPayloads: 0,
      retriesScheduled: 0,
      retriesExhausted: 0,
      deadLettered: 0,
      popFailures: 0,
      replayFailures: 0,
      lastReplayAt: null,
      lastDeadLetterAt: null,
    };
    this._activeTradeToken = null;
    this._activeTradeSide = null;
    this._entryTimeoutRecoveryInFlight = new Set();

    // Injected by pipeline: runtime token subscription (needed for OPT mode correctness)
    this.runtimeAddTokens = null;
    this.runtimeGetCandles = null;

    // SL fill watchdog state (SL-L can remain OPEN in fast moves)
    this._slWatch = new Map(); // tradeId -> state
    this._slWatchdogInFlight = false;

    // TARGET fill watchdog state (LIMIT target can remain OPEN after touch)
    this._targetWatch = new Map(); // tradeId -> state
    this._targetWatchdogInFlight = new Set(); // tradeId -> in-flight

    // Virtual target watcher (used when broker rejects target due to margin)
    this._virtualTargetWatch = new Map(); // tradeId -> state

    // ENTRY limit fallback timers (tradeId -> timeout)
    this._entryFallbackTimers = new Map();
    this._entryFallbackInFlight = new Set();
    this._entryPendingCancelInFlight = new Set();

    // PANIC exit watchdog (tradeId -> timeout)
    this._panicExitTimers = new Map();
    this._panicExitRetryCount = new Map();
    this._panicExitInFlight = new Set();
    this._timeStopEscalationAt = new Map();
    this._timeStopFallbackTimers = new Map();
    this._slSafetyTimers = new Map();

    // Reconcile debouncer (order-update driven)
    this._reconcileTimer = null;
    this._reconcileScheduledAt = 0;

    this._virtualTargetFetchInFlight = new Set(); // tradeId -> in-flight

    // Portfolio risk checks
    this._lastPortfolioRiskCheckAt = 0;
    this._portfolioRiskInFlight = false;

    // Execution quality feedback loop
    this._slippageCooldownUntil = 0;
    this._slippageStats = {
      entryBps: [],
      exitInr: [],
      size: Math.max(5, Number(env.SLIPPAGE_FEEDBACK_SAMPLE ?? 25)),
    };

    // Rolling circuit breakers (5-minute window)
    this._cbEvents = {
      rejects: [],
      spreadSpikes: [],
      staleTicks: [],
      quoteGuard: [],
    };
    this._cbCooldownUntil = 0;

    // Strategy-level loss throttling
    this._strategyLossStreak = new Map();
    this._strategyCooldownUntil = new Map();

    // Hard flat (restart policy)
    this._hardFlatHandled = false;
    this._executionCoordinator = new ExecutionCoordinator();
    this._tradeCommandContexts = new Map();
  }

  setRuntimeAddTokens(fn) {
    this.runtimeAddTokens = typeof fn === "function" ? fn : null;
  }

  setRuntimeGetCandles(fn) {
    this.runtimeGetCandles = typeof fn === "function" ? fn : null;
  }

  async _runTradeCommand(
    tradeId,
    type,
    handler,
    { seedTrade = undefined, allowMissing = false } = {},
  ) {
    const tradeKey = String(tradeId || "");
    if (!tradeKey) {
      return typeof handler === "function" ? handler(null) : undefined;
    }
    return this._executionCoordinator.run(
      { key: tradeKey, type, meta: { tradeId: tradeKey } },
      async (command) => {
        const existingContext = this._tradeCommandContexts.get(tradeKey);
        if (existingContext?.command === command) {
          return handler(existingContext);
        }

        let latestTrade = null;
        try {
          latestTrade = await getTrade(tradeKey);
        } catch (err) {
          if (seedTrade === undefined) throw err;
        }
        const initialTrade =
          latestTrade != null ? latestTrade : seedTrade !== undefined ? seedTrade : null;
        if (!initialTrade && !allowMissing) {
          return null;
        }

        const context = {
          tradeId: tradeKey,
          type: String(type || EXEC_COMMAND.DIRECT_PATCH),
          trade: initialTrade || null,
          version: Number(initialTrade?.version ?? 0) || 0,
          command,
        };
        this._tradeCommandContexts.set(tradeKey, context);
        try {
          return await handler(context);
        } finally {
          if (this._tradeCommandContexts.get(tradeKey) === context) {
            this._tradeCommandContexts.delete(tradeKey);
          }
        }
      },
    );
  }

  async _updateTrade(tradeId, patch, options = {}) {
    const tradeKey = String(tradeId || "");
    const currentCommand = this._executionCoordinator.getCurrentCommand();
    const context = this._tradeCommandContexts.get(tradeKey) || null;
    const executeWrite = async () => {
      const currentTrade = options?.currentTrade || context?.trade || null;
      const expectedVersion = Number.isInteger(Number(options?.expectedVersion))
        ? Number(options.expectedVersion)
        : context
          ? Number(context.version ?? 0) || 0
          : undefined;
      const result = await storeUpdateTrade(tradeKey, patch, {
        ...options,
        currentTrade,
        expectedVersion,
      });

      if (
        !result ||
        typeof result !== "object" ||
        (!Object.prototype.hasOwnProperty.call(result, "status") &&
          !Object.prototype.hasOwnProperty.call(result, "ok"))
      ) {
        if (context) {
          context.trade = { ...(context.trade || {}), ...(patch || {}) };
          context.version = Math.max(0, Number(context.version ?? 0)) + 1;
        }
        return {
          ok: true,
          status: "APPLIED",
          trade: context?.trade || null,
          version: context?.version ?? null,
          legacyResult: true,
        };
      }

      if (result.status === "APPLIED" && context) {
        context.trade = result.trade || { ...(context.trade || {}), ...(patch || {}) };
        context.version = Number(result.version ?? context.version ?? 0) || 0;
      } else if (result.trade && context) {
        context.trade = result.trade;
        context.version = Number(result.trade?.version ?? context.version ?? 0) || 0;
      }

      if (result.status === "CONFLICT") {
        const err = new Error(
          `[trade] version conflict tradeId=${tradeKey} command=${String(
            options?.commandType || context?.type || EXEC_COMMAND.DIRECT_PATCH,
          )}`,
        );
        err.code = "TRADE_VERSION_CONFLICT";
        err.result = result;
        throw err;
      }
      if (result.status === "MISSING") {
        const err = new Error(
          `[trade] missing trade row tradeId=${tradeKey}`,
        );
        err.code = "TRADE_ROW_MISSING";
        err.result = result;
        throw err;
      }
      return result;
    };

    if (!tradeKey) {
      return executeWrite();
    }

    if (currentCommand?.key === tradeKey) {
      return executeWrite();
    }

    return this._runTradeCommand(
      tradeKey,
      options?.commandType || EXEC_COMMAND.DIRECT_PATCH,
      async () => executeWrite(),
      {
        seedTrade: options?.currentTrade,
        allowMissing: Boolean(options?.allowMissing),
      },
    );
  }

  _collectTrackedTradeIds() {
    const ids = new Set();
    const collect = (container) => {
      if (!container) return;
      if (typeof container.keys === "function") {
        for (const key of container.keys()) {
          const id = String(key || "");
          if (id) ids.add(id);
        }
        return;
      }
      for (const value of container) {
        const id = String(value || "");
        if (id) ids.add(id);
      }
    };

    collect(this.exitPlacementLocks);
    collect(this._eodConvertAttempted);
    collect(this._dynExitLastAt);
    collect(this._dynExitLastEvalAt);
    collect(this._dynExitFailCount);
    collect(this._dynExitDisabled);
    collect(this._dynExitInFlight);
    collect(this._dynExitFailBackoffUntil);
    collect(this._dynPeakLtpByTrade);
    collect(this._slWatch);
    collect(this._targetWatch);
    collect(this._targetWatchdogInFlight);
    collect(this._virtualTargetWatch);
    collect(this._entryFallbackTimers);
    collect(this._entryFallbackInFlight);
    collect(this._entryPendingCancelInFlight);
    collect(this._panicExitTimers);
    collect(this._panicExitRetryCount);
    collect(this._panicExitInFlight);
    collect(this._timeStopEscalationAt);
    collect(this._timeStopFallbackTimers);
    collect(this._virtualTargetFetchInFlight);
    collect(this._slSafetyTimers);

    if (this.activeTradeId) {
      ids.add(String(this.activeTradeId));
    }

    return ids;
  }

  _cleanupTradeRuntimeState(tradeId) {
    const id = String(tradeId || "");
    if (!id) return;

    this._clearSlWatch(id);
    this._clearTargetWatch(id);
    this._clearVirtualTarget(id);
    this._clearEntryLimitFallbackTimer(id);
    this._clearPanicExitWatch(id);
    this._clearTimeStopFallback(id);
    this._clearStopLossSlaTimer(id);

    this.exitPlacementLocks.delete(id);
    this._eodConvertAttempted.delete(id);
    this._dynExitLastAt.delete(id);
    this._dynExitLastEvalAt.delete(id);
    this._dynExitFailCount.delete(id);
    this._dynExitDisabled.delete(id);
    this._dynExitInFlight.delete(id);
    this._dynExitFailBackoffUntil.delete(id);
    this._dynPeakLtpByTrade.delete(id);
    this._targetWatchdogInFlight.delete(id);
    this._entryFallbackInFlight.delete(id);
    this._entryPendingCancelInFlight.delete(id);
    this._panicExitRetryCount.delete(id);
    this._panicExitInFlight.delete(id);
    this._timeStopEscalationAt.delete(id);
    this._virtualTargetFetchInFlight.delete(id);
  }

  _cleanupAllRuntimeState() {
    for (const tradeId of this._collectTrackedTradeIds()) {
      this._cleanupTradeRuntimeState(tradeId);
    }
    this.exitPlacementLocks.clear();
    this._eodConvertAttempted.clear();
    this._slWatch.clear();
    this._targetWatch.clear();
    this._targetWatchdogInFlight.clear();
    this._virtualTargetWatch.clear();
    this._entryFallbackTimers.clear();
    this._entryFallbackInFlight.clear();
    this._entryPendingCancelInFlight.clear();
    this._panicExitTimers.clear();
    this._panicExitRetryCount.clear();
    this._panicExitInFlight.clear();
    this._timeStopEscalationAt.clear();
    this._timeStopFallbackTimers.clear();
    this._slSafetyTimers.clear();
    this._dynExitLastAt.clear();
    this._dynExitLastEvalAt.clear();
    this._dynExitFailCount.clear();
    this._dynExitDisabled.clear();
    this._dynExitInFlight.clear();
    this._dynExitFailBackoffUntil.clear();
    this._dynPeakLtpByTrade.clear();
    this._virtualTargetFetchInFlight.clear();
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;

    this._stopped = true;
    this._stopPromise = (async () => {
      if (this._exitLoopTimer) {
        clearInterval(this._exitLoopTimer);
        this._exitLoopTimer = null;
      }
      if (this._reconcileTimer) {
        clearTimeout(this._reconcileTimer);
        this._reconcileTimer = null;
      }
      this._reconcileScheduledAt = 0;
      this._cleanupAllRuntimeState();
      logger.info("[trade_manager] stopped");
    })();

    return this._stopPromise;
  }

  _pushCircuitEvent(kind) {
    const k = String(kind || "");
    if (!this._cbEvents[k]) return;
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const arr = this._cbEvents[k];
    arr.push(now);
    while (arr.length && now - arr[0] > windowMs) arr.shift();
  }

  _checkCircuitBreakers() {
    if (!Boolean(env.CIRCUIT_BREAKERS_ENABLED ?? true)) {
      return { ok: true, reason: "DISABLED" };
    }
    const now = Date.now();
    if (this._cbCooldownUntil && now < this._cbCooldownUntil) {
      return { ok: false, reason: "COOLDOWN", until: this._cbCooldownUntil };
    }
    const caps = {
      rejects: Number(env.CB_MAX_REJECTS_5M ?? 5),
      spreadSpikes: Number(env.CB_MAX_SPREAD_SPIKES_5M ?? 8),
      staleTicks: Number(env.CB_MAX_STALE_TICKS_5M ?? 12),
      quoteGuard: Number(env.CB_MAX_QUOTE_GUARD_HITS_5M ?? 4),
    };
    for (const [k, maxN] of Object.entries(caps)) {
      const cnt = this._cbEvents[k]?.length || 0;
      if (Number.isFinite(maxN) && maxN > 0 && cnt >= maxN) {
        const cd = Math.max(30, Number(env.CB_COOLDOWN_SEC ?? 180));
        this._cbCooldownUntil = now + cd * 1000;
        logger.error(
          { kind: k, count: cnt, max: maxN, cooldownSec: cd },
          "[guard] circuit breaker tripped",
        );
        return {
          ok: false,
          reason: `CIRCUIT_${k.toUpperCase()}`,
          until: this._cbCooldownUntil,
        };
      }
    }
    return { ok: true, reason: "OK" };
  }

  _isFnoEnabled() {
    return String(env.FNO_ENABLED || "false").toLowerCase() === "true";
  }

  _finalOptionSignalConfidence({ baseConfidence, pick, liqMeta }) {
    const assessment = buildRouteConfidenceAssessment({
      baseConfidence,
      pick,
      liqMeta,
      env,
    });
    return Number.isFinite(Number(assessment?.routedScore))
      ? Number(assessment.routedScore)
      : baseConfidence;
  }

  _getPreRouteConfidenceAllowance() {
    return resolvePreRouteConfidenceAllowance(env);
  }

  _isOptMode() {
    return (
      this._isFnoEnabled() &&
      String(env.FNO_MODE || "FUT").toUpperCase() === "OPT"
    );
  }

  _normalizeQtyToLot(qty, instrument) {
    const q = Math.floor(Number(qty ?? 0));
    if (!Number.isFinite(q) || q <= 0) return 0;

    const lot = Number(instrument?.lot_size ?? 1);
    if (!Number.isFinite(lot) || lot <= 1) return q;

    const rounded = Math.floor(q / lot) * lot;
    if (rounded >= lot) return rounded;

    // For derivatives: sizing can produce < 1 lot. Policy decides what to do.
    const policy = String(env.FNO_MIN_LOT_POLICY || "STRICT").toUpperCase();
    if (policy === "FORCE_ONE_LOT") return lot;
    return 0;
  }

  _resolveFreezeQty(instrument) {
    const instFreeze = Number(instrument?.freeze_qty ?? 0);
    const envFreeze = Number(env.FNO_FREEZE_QTY ?? 0);
    if (Number.isFinite(instFreeze) && instFreeze > 0) return instFreeze;
    if (Number.isFinite(envFreeze) && envFreeze > 0) return envFreeze;
    return 0;
  }

  _applyFreezeQty(qty, instrument) {
    const freeze = this._resolveFreezeQty(instrument);
    if (!Number.isFinite(freeze) || freeze <= 0) {
      return { ok: true, qty, freeze: null };
    }
    if (qty <= freeze) return { ok: true, qty, freeze };

    const adjusted = this._normalizeQtyToLot(Math.min(qty, freeze), instrument);
    if (adjusted < 1) {
      return { ok: false, reason: "FREEZE_QTY_TOO_LOW", freeze };
    }
    return { ok: true, qty: adjusted, freeze };
  }

  // ---------------------------
  // Stop-loss order helpers (F&O safe)
  // ---------------------------
  _isDerivativesExchange(exchange) {
    const ex = String(exchange || "").toUpperCase();
    return ["NFO", "BFO", "CDS", "BCD", "MCX"].includes(ex);
  }

  _getMaxSpreadBps(instrument) {
    const base = Number(env.MAX_SPREAD_BPS ?? 15);
    const ex = String(instrument?.exchange || "").toUpperCase();
    const seg = String(instrument?.segment || "").toUpperCase();
    const ts = String(instrument?.tradingsymbol || "").toUpperCase();
    const it = String(instrument?.instrument_type || "").toUpperCase();

    const isDeriv =
      this._isDerivativesExchange(ex) ||
      seg.includes("NFO") ||
      seg.includes("BFO");
    const isOpt =
      isDeriv &&
      (it === "CE" ||
        it === "PE" ||
        /(?:CE|PE)$/.test(ts) ||
        seg.includes("OPT"));
    const isFut =
      isDeriv && !isOpt && (seg.includes("FUT") || ts.includes("FUT"));

    if (isOpt)
      return Number(env.MAX_SPREAD_BPS_OPT ?? env.OPT_MAX_SPREAD_BPS ?? base);
    if (isFut) return Number(env.MAX_SPREAD_BPS_FUT ?? base);
    return Number(env.MAX_SPREAD_BPS_EQ ?? base);
  }

  _getStopLossOrderType(instrument) {
    const ex = String(instrument?.exchange || "").toUpperCase();
    const isDeriv = this._isDerivativesExchange(ex);

    const raw = String(
      isDeriv ? env.STOPLOSS_ORDER_TYPE_FO : env.STOPLOSS_ORDER_TYPE_EQ,
    )
      .toUpperCase()
      .trim();

    if (raw === "SL" || raw === "SL-M") return raw;

    // Fallbacks
    return isDeriv ? "SL" : "SL-M";
  }

  _buildStopLossLimitPrice({ triggerPrice, exitSide, instrument }) {
    const tick = Number(instrument?.tick_size ?? 0.05);
    const trig = Number(triggerPrice);

    const bps = Math.max(0, Number(env.SL_LIMIT_BUFFER_BPS ?? 50));
    const ticks = Math.max(0, Number(env.SL_LIMIT_BUFFER_TICKS ?? 10));
    const abs = Math.max(0, Number(env.SL_LIMIT_BUFFER_ABS ?? 0));
    const maxBps = Math.max(0, Number(env.SL_LIMIT_BUFFER_MAX_BPS ?? 500));

    let buf = 0;
    if (Number.isFinite(trig) && trig > 0) buf = (trig * bps) / 10000;
    if (Number.isFinite(tick) && tick > 0) buf = Math.max(buf, tick * ticks);
    buf = Math.max(buf, abs);

    // Cap buffer to avoid extreme limit prices
    if (
      Number.isFinite(trig) &&
      trig > 0 &&
      Number.isFinite(maxBps) &&
      maxBps > 0
    ) {
      buf = Math.min(buf, (trig * maxBps) / 10000);
    }

    const side = String(exitSide || "SELL").toUpperCase();
    let px = side === "SELL" ? trig - buf : trig + buf;

    // Keep SL-L logically valid: SELL price <= trigger, BUY price >= trigger
    if (side === "SELL") px = Math.min(px, trig);
    else px = Math.max(px, trig);

    // Round to tick (SELL down, BUY up) and keep positive
    px = roundToTick(px, tick, side === "SELL" ? "down" : "up");
    if (!Number.isFinite(px) || px <= 0)
      px = Number.isFinite(tick) && tick > 0 ? tick : 0.05;

    return px;
  }

  _computeRiskStopLoss({ entryPrice, side, instrument, qty, riskInr }) {
    const entry = Number(entryPrice);
    const baseRisk = Number(riskInr ?? env.RISK_PER_TRADE_INR ?? 0);
    const riskQty = Number(
      qty ?? instrument?.lot_size ?? instrument?.lotSize ?? 1,
    );
    const safeQty = Number.isFinite(riskQty) && riskQty > 0 ? riskQty : 1;
    const riskPts = safeQty > 0 ? baseRisk / safeQty : 0;
    const tick = Number(instrument?.tick_size ?? 0.05);
    const raw =
      String(side || "BUY").toUpperCase() === "BUY"
        ? entry - riskPts
        : entry + riskPts;
    const stopLoss = roundToTick(
      raw,
      tick,
      String(side || "BUY").toUpperCase() === "BUY" ? "down" : "up",
    );

    return {
      stopLoss,
      riskPts,
      riskInr: riskPts * safeQty,
      lotSize: safeQty,
      riskQty: safeQty,
      tick,
    };
  }

  _strategyStopLossFromTrade(trade) {
    return resolveStrategyStopLoss(trade);
  }

  _sizingStopLossFromTrade(trade) {
    return resolveSizingStopLoss(trade);
  }

  _brokerStopLossFromTrade(trade) {
    return resolveBrokerStopLoss(trade);
  }

  _riskBudgetInr(trade) {
    return Number(
      trade?.riskBudgetInr ??
        trade?.risk_budget_inr ??
        trade?.riskInr ??
        env.RISK_PER_TRADE_INR ??
        0,
    );
  }

  _computeActualRiskFromStrategyStop(args) {
    return computeActualRiskFromStrategyStop(args);
  }

  _classifyPostFillRiskBreach({ trueRiskInr, capInr }) {
    return classifyPostFillRiskBreach({
      trueRiskInr,
      capInr,
      softBreachPct: Number(env.POST_FILL_RISK_SOFT_BREACH_PCT ?? 5),
      hardBreachPct: Number(env.POST_FILL_RISK_HARD_BREACH_PCT ?? 12),
    });
  }

  _evaluateMinTradableRiskFit(args = {}) {
    if (this.risk?.evaluateMinTradableRiskFit) {
      return this.risk.evaluateMinTradableRiskFit(args);
    }
    return evaluateMinTradableRiskFit(args);
  }

  _buildStopSemanticsPatch({
    strategyStopLoss,
    sizingStopLoss,
    brokerStopLoss,
    patch = {},
  }) {
    const nextStrategy = Number.isFinite(Number(strategyStopLoss))
      ? Number(strategyStopLoss)
      : null;
    const nextSizing = Number.isFinite(Number(sizingStopLoss))
      ? Number(sizingStopLoss)
      : nextStrategy;
    const nextBroker = Number.isFinite(Number(brokerStopLoss))
      ? Number(brokerStopLoss)
      : (nextSizing ?? nextStrategy);

    return {
      strategyStopLoss: nextStrategy,
      sizingStopLoss: nextSizing,
      brokerStopLoss: nextBroker,
      stopLoss: nextBroker,
      initialStopLoss: nextStrategy,
      slTrigger: nextBroker,
      ...patch,
    };
  }

  _isSlmBlockedError(msg) {
    const s = String(msg || "").toLowerCase();
    return (
      s.includes("sl-m") &&
      (s.includes("blocked") ||
        s.includes("discontinued") ||
        s.includes("not allowed") ||
        s.includes("rejected"))
    );
  }

  _isInsufficientMarginError(msg) {
    const s = String(msg || "").toLowerCase();
    return (
      s.includes("insufficient funds") ||
      s.includes("insufficient margin") ||
      s.includes("margin exceeds") ||
      s.includes("rms:margin") ||
      (s.includes("required") &&
        s.includes("margin") &&
        s.includes("available"))
    );
  }

  _isOrderConflictError(msg) {
    const s = String(msg || "").toLowerCase();
    return (
      s.includes("order exceeds holdings") ||
      s.includes("insufficient holdings") ||
      s.includes("insufficient position") ||
      s.includes("position insufficient") ||
      s.includes("order conflict") ||
      s.includes("rms:order") ||
      s.includes("rms order")
    );
  }

  _isOptionInstrument(instrument) {
    const segment = String(instrument?.segment || "").toUpperCase();
    const type = String(instrument?.instrument_type || "").toUpperCase();
    const symbol = String(instrument?.tradingsymbol || "").toUpperCase();

    return (
      segment.includes("-OPT") ||
      ["CE", "PE", "OPT"].includes(type) ||
      /(?:CE|PE)$/.test(symbol)
    );
  }

  _isOptTargetModeVirtual(trade) {
    const optTargetMode = String(env.OPT_TARGET_MODE || "BROKER").toUpperCase();
    return (
      optTargetMode === "VIRTUAL" && this._isOptionInstrument(trade?.instrument)
    );
  }

  async _enforceOptVirtualTargetMode(trade, source = "opt_mode") {
    try {
      if (!this._isOptTargetModeVirtual(trade)) return { applied: false };

      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return { applied: false };

      const qty = Number(trade?.qty ?? 0);
      if (!Number.isFinite(qty) || qty <= 0) return { applied: false };

      const targetOrderId = trade?.targetOrderId
        ? String(trade.targetOrderId)
        : null;
      const targetOrderType = String(
        trade?.targetOrderType || "",
      ).toUpperCase();
      const targetIsVirtualMarket =
        trade?.targetVirtual && targetOrderId && targetOrderType === "MARKET";

      let changed = false;
      let targetOrderCleared = false;

      if (targetOrderId && !targetIsVirtualMarket) {
        try {
          this.expectedCancelOrderIds.add(String(targetOrderId));
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
        try {
          await this._safeCancelOrder(
            env.DEFAULT_ORDER_VARIETY,
            targetOrderId,
            {
              purpose: "OPT_TARGET_MODE_VIRTUAL_CANCEL",
              tradeId,
            },
          );
        } catch (e) {
          logger.warn(
            { tradeId, targetOrderId, e: e?.message || String(e) },
            "[opt_mode] failed to cancel broker target; continuing with virtual target",
          );
        }
        await this._updateTrade(tradeId, {
          targetOrderId: null,
          targetOrderType: null,
        });
        this._clearTargetWatch(tradeId);
        changed = true;
        targetOrderCleared = true;
      }

      if (!trade?.targetVirtual) {
        await this._enableVirtualTarget(trade, {
          reason: "OPT_TARGET_MODE_VIRTUAL",
          source,
        });
        changed = true;
      } else {
        this._registerVirtualTargetFromTrade(trade);
      }

      return { applied: changed, targetOrderCleared };
    } catch (e) {
      logger.warn(
        { tradeId: trade?.tradeId, e: e?.message || String(e), source },
        "[opt_mode] enforce virtual target failed",
      );
      return { applied: false, error: e?.message || String(e) };
    }
  }

  _normalizeUnderlyingName(value) {
    const raw = String(value || "")
      .trim()
      .toUpperCase();
    if (!raw) return "";
    const cleaned = raw.replace(/\s+/g, "");
    const m = cleaned.match(/[A-Z]+/);
    return m ? m[0] : cleaned;
  }

  _buildRiskKey({ strategyId, underlying, token }) {
    const base = this._normalizeUnderlyingName(underlying);
    if (base) {
      const strat = String(strategyId || "").trim();
      return strat ? `${base}:${strat}` : base;
    }
    const n = Number(token);
    return Number.isFinite(n) && n > 0 ? String(n) : String(token || "UNKNOWN");
  }

  _riskKeyForTrade(trade) {
    return this._buildRiskKey({
      strategyId: trade?.strategyId,
      underlying:
        trade?.underlying_symbol ||
        trade?.option_meta?.underlying ||
        trade?.instrument?.name ||
        trade?.instrument?.tradingsymbol,
      token: trade?.instrument_token,
    });
  }

  _tradeNeedsFactRecovery(trade) {
    const status = String(trade?.status || "").toUpperCase();
    const liveStatuses = new Set([
      STATUS.ENTRY_FILLED,
      STATUS.SL_PLACED,
      STATUS.SL_OPEN,
      STATUS.SL_CONFIRMED,
      STATUS.LIVE,
      STATUS.EXIT_PLACED,
      STATUS.EXIT_OPEN,
      STATUS.EXIT_PARTIAL,
      STATUS.PANIC_EXIT_PLACED,
      STATUS.RECOVERY_REHYDRATED,
      STATUS.GUARD_FAILED,
    ]);
    if (!liveStatuses.has(status)) return false;

    const entryPrice = Number(
      trade?.entryPrice ?? trade?.expectedEntryPrice ?? 0,
    );
    const qty = Number(trade?.qty ?? trade?.initialQty ?? 0);
    return !(entryPrice > 0 && qty > 0);
  }

  _buildTradeFactPatch(trade, order) {
    if (!trade || !order) return null;

    const patch = {};
    const entryPrice = Number(order?.average_price ?? order?.price ?? 0);
    const qty = Number(
      order?.filled_quantity ?? order?.filledQty ?? order?.quantity ?? 0,
    );
    const entryTsRaw =
      order?.exchange_timestamp ||
      order?.order_timestamp ||
      order?.exchange_update_timestamp ||
      null;
    const entryTs = entryTsRaw ? new Date(entryTsRaw) : null;

    if (!(Number(trade?.entryPrice ?? 0) > 0) && entryPrice > 0) {
      patch.entryPrice = entryPrice;
    }
    if (!(Number(trade?.qty ?? 0) > 0) && qty > 0) {
      patch.qty = qty;
    }
    if (!(Number(trade?.initialQty ?? 0) > 0) && qty > 0) {
      patch.initialQty = qty;
    }
    if (
      !trade?.entryFilledAt &&
      entryTs &&
      Number.isFinite(entryTs.getTime())
    ) {
      patch.entryFilledAt = entryTs;
    }

    return Object.keys(patch).length ? patch : null;
  }

  async _getActiveTradesForFactGate() {
    return getActiveTrades();
  }

  async _updateTradeFacts(tradeId, patch) {
    if (!tradeId || !patch || !Object.keys(patch).length) return null;
    await this._updateTrade(tradeId, patch);
    return patch;
  }

  async _globalFactRecoveryGate(
    byId = new Map(),
    { actives = null, scheduleRetry = true } = {},
  ) {
    const rows = Array.isArray(actives)
      ? actives
      : await this._getActiveTradesForFactGate();
    const blockers = [];

    for (const trade of rows || []) {
      if (!this._tradeNeedsFactRecovery(trade)) continue;

      const tradeId = String(trade?.tradeId || "");
      const entryOrderId = String(trade?.entryOrderId || "");
      const order = entryOrderId ? byId.get(entryOrderId) : null;
      const patch = this._buildTradeFactPatch(trade, order);

      if (patch) {
        await this._updateTradeFacts(tradeId, patch);
        Object.assign(trade, patch);
        continue;
      }

      blockers.push({
        tradeId: tradeId || null,
        status: trade?.status || null,
        entryOrderId: entryOrderId || null,
      });
    }

    if (!blockers.length) return { ok: true, blockers: [] };

    if (scheduleRetry && typeof this.reconcile === "function") {
      Promise.resolve()
        .then(() => this.reconcile())
        .catch((err) => {
          logger.warn(
            { err: err?.message || String(err), blockers },
            "[reconcile] fact recovery retry failed",
          );
        });
    }

    return { ok: false, blockers };
  }

  _shouldFallbackToVirtualTarget(msg) {
    const s = String(msg || "").toLowerCase();
    return (
      this._isInsufficientMarginError(msg) ||
      this._isOrderConflictError(msg) ||
      s.includes("rms") ||
      s.includes("margin required") ||
      s.includes("available margin")
    );
  }

  async init() {
    if (this._stopped) return;
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      await ensureTradeIndexes();
      // Patch-6: load persisted cost calibration multipliers (if enabled)
      try {
        await costCalibrator.start();
      } catch (err) {
        reportFault({
          code: "COST_CALIBRATOR_START_FAILED",
          err,
          message:
            "[init] cost calibrator start failed; continuing in degraded mode",
        });
      }
      await this._ensureDailyRisk();
      await this._hydrateRiskStateFromDb();
      if (String(env.RESET_FAILURES_ON_START || "false") === "true") {
        this.risk.resetFailures();
        this.risk.setKillSwitch(false);
        logger.warn(
          "[risk] RESET_FAILURES_ON_START enabled: cleared consecutive failures and kill switch",
        );
      }
      await this.refreshRiskLimits();
      await this._hydrateRiskFromDb();
      await this._loadActiveTradeId();
      await this._hydrateLiveOrderSnapshotsFromDb();
      await this._hydrateOpenPositionFromActiveTrade();
      if (this._stopped) return;
      this._startExitLoop();
      this._initialized = true;
    })();

    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  _rememberLiveOrder(orderId, order) {
    const oid = String(orderId || "");
    if (!oid) return;
    const status = String(order?.status || "").toUpperCase();
    const prev = this._lastOrdersById.get(oid) || null;
    const prevStatus = String(prev?.status || "").toUpperCase();
    const nextOrder = order || { order_id: oid };

    if (
      isOrderStatusRegression(prevStatus, status) &&
      isTerminalOrderStatus(prevStatus)
    ) {
      this._lastOrdersById.set(oid, { ...nextOrder, status: prevStatus });
      this._terminalOrderStatusById.set(oid, prevStatus);
      return;
    }

    this._lastOrdersById.set(oid, nextOrder);
    if (isTerminalOrderStatus(status)) {
      this._terminalOrderStatusById.set(oid, status);
    } else if (!this._terminalOrderStatusById.has(oid)) {
      this._terminalOrderStatusById.delete(oid);
    }
  }

  async _hydrateLiveOrderSnapshotsFromDb({ force = false } = {}) {
    if (this._liveOrderSnapshotsHydrated && !force) return;
    try {
      const actives = await getActiveTrades();
      const tradeIds = (actives || []).map((t) => t?.tradeId).filter(Boolean);
      if (!tradeIds.length) {
        this._liveOrderSnapshotsHydrated = true;
        return;
      }

      const rows = await getLiveOrderSnapshotsByTradeIds(tradeIds);
      const rowByTradeId = new Map(
        (rows || []).map((row) => [String(row?.tradeId || ""), row]),
      );
      let hydrated = 0;
      for (const trade of actives || []) {
        const snap = rowByTradeId.get(String(trade?.tradeId || ""));
        if (!snap) continue;
        const allowed = new Set(
          this._extractTradeOrderRefs(trade)
            .map((ref) => String(ref.orderId || ""))
            .filter(Boolean),
        );
        const byOrderId = snap?.byOrderId || {};
        for (const [orderId, entry] of Object.entries(byOrderId)) {
          if (allowed.size && !allowed.has(String(orderId || ""))) continue;
          if (!orderId) continue;
          this._rememberLiveOrder(
            orderId,
            entry?.order || { order_id: orderId, status: entry?.status },
          );
          hydrated += 1;
        }
      }

      if ((rows || []).length) {
        logger.info(
          {
            tradeCount: tradeIds.length,
            snapshotCount: rows.length,
            ordersHydrated: hydrated,
          },
          "[init] hydrated persisted live order snapshots",
        );
      }
      this._liveOrderSnapshotsHydrated = true;
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e) },
        "[init] hydrate live order snapshots failed",
      );
    }
  }

  _extractTradeOrderRefs(trade) {
    const refs = [];
    for (const [k, v] of Object.entries(trade || {})) {
      if (!/OrderId$/.test(String(k || ""))) continue;
      const oid = String(v || "");
      if (!oid) continue;
      const role =
        String(k)
          .replace(/OrderId$/, "")
          .toUpperCase() || "UNKNOWN";
      refs.push({ orderId: oid, role });
    }
    return refs;
  }

  async _persistLiveOrderSnapshotsForTrades(
    trades,
    byId,
    source = "reconcile",
  ) {
    for (const trade of trades || []) {
      const tradeId = trade?.tradeId;
      if (!tradeId) continue;
      for (const ref of this._extractTradeOrderRefs(trade)) {
        const order = byId?.get?.(String(ref.orderId));
        if (!order) continue;
        const prev = this._lastOrdersById.get(String(ref.orderId)) || null;
        const changed = hasMaterialOrderSnapshotChange(prev, order);
        this._rememberLiveOrder(ref.orderId, order);
        if (source === "reconcile" && !changed) continue;
        await upsertLiveOrderSnapshot({
          tradeId,
          orderId: ref.orderId,
          role: ref.role,
          order,
          source,
        });
      }
    }
  }

  _startExitLoop() {
    if (this._stopped) return;
    if (this._exitLoopTimer) return;
    const everyMs = Number(env.EXIT_LOOP_MS ?? 0);
    if (!Number.isFinite(everyMs) || everyMs <= 0) return;

    this._exitLoopTimer = setInterval(
      () => {
        this._exitLoopTick().catch((err) =>
          reportFault({
            code: "EXIT_LOOP_TICK_FAILED",
            err,
            message: "[exit] exit loop tick failed",
          }),
        );
      },
      Math.max(250, everyMs),
    );
  }

  async _exitLoopTick() {
    if (this._stopped) return;
    if (this._exitLoopInFlight) return;
    this._exitLoopInFlight = true;
    try {
      if (!this.activeTradeId) return;
      const trade = await getTrade(this.activeTradeId);
      if (!trade) return;
      if (
        ![
          STATUS.ENTRY_FILLED,
          STATUS.SL_PLACED,
          STATUS.SL_OPEN,
          STATUS.SL_CONFIRMED,
          STATUS.RECOVERY_REHYDRATED,
          STATUS.LIVE,
        ].includes(trade.status)
      )
        return;
      this._syncActiveTradeState(trade);

      await this._maybeDynamicAdjustExits(trade, this._lastOrdersById);
    } finally {
      this._exitLoopInFlight = false;
    }
  }

  _isTargetRequired() {
    return String(env.OPT_TP_ENABLED || "false") === "true";
  }

  _eventPatch(event, meta) {
    if (!event) return {};
    return {
      lastEvent: String(event),
      lastEventAt: new Date(),
      lastEventMeta: meta || null,
    };
  }

  async _ensureDailyRisk() {
    const key = todayKey();
    const cur = await getDailyRisk(key);
    if (!cur) {
      await upsertDailyRisk(key, {
        realizedPnl: 0,
        kill: false,
        reason: null,
        ordersPlaced: 0,
        state: "RUNNING",
        stateReason: null,
      });
      return;
    }
    // Backfill newer fields
    const patch = {};
    if (cur.ordersPlaced == null) patch.ordersPlaced = 0;
    if (!cur.state) patch.state = "RUNNING";
    if (cur.stateReason === undefined) patch.stateReason = null;
    if (Object.keys(patch).length) await upsertDailyRisk(key, patch);
  }

  async _updateDailyPnlState({ realized, openPnl, total, prevState }) {
    const lossCap = Number(
      this.risk?.getLimits?.().dailyLossCapInr ?? env.DAILY_MAX_LOSS_INR ?? 0,
    );
    const profitGoal = Number(env.DAILY_PROFIT_GOAL_INR ?? 0);

    let state = "RUNNING";
    let reason = null;

    if (Number.isFinite(lossCap) && lossCap > 0 && total <= -lossCap) {
      state = "HARD_STOP";
      reason = "DAILY_MAX_LOSS";
    } else if (
      Number.isFinite(profitGoal) &&
      profitGoal > 0 &&
      total >= profitGoal
    ) {
      state = "SOFT_STOP";
      reason = "DAILY_PROFIT_GOAL";
    }

    const patch = {
      lastRealizedPnl: realized,
      lastOpenPnl: openPnl,
      lastTotal: total,
      state,
      stateReason: reason,
    };
    if (state !== String(prevState || "RUNNING")) {
      patch.stateUpdatedAt = new Date();
      logger.warn(
        { prevState: prevState || "RUNNING", state, reason },
        "[risk] daily state changed",
      );
      if (state === "SOFT_STOP") {
        alert("warn", "⚠️ Daily soft stop reached", {
          state,
          reason,
          total,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      } else if (state === "HARD_STOP") {
        alert("error", "🛑 Daily hard stop reached", {
          state,
          reason,
          total,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      } else if (state === "RUNNING") {
        alert("info", "✅ Daily risk state reset to RUNNING", {
          state,
          reason,
          total,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      }
    }

    await upsertDailyRisk(todayKey(), patch);

    return { state, reason };
  }

  async _hydrateRiskFromDb() {
    const db = getDb();
    const { start, end } = dayRange();

    // Count trades today (excluding recovery records)
    const tradesToday = await db.collection("trades").countDocuments({
      createdAt: { $gte: start, $lt: end },
      strategyId: { $ne: "recovery" },
    });

    this.risk.setTradesToday(tradesToday);

    // Persisted kill-switch (if set earlier)
    const dr = await getDailyRisk(todayKey());
    if (dr?.kill) {
      this.risk.setKillSwitch(true);
    }
    this.ordersPlacedToday = Number(dr?.ordersPlaced ?? 0);
  }

  async _hydrateRiskStateFromDb() {
    const rs = await getRiskState(todayKey());
    if (!rs) return;
    if (this.risk?.applyState) {
      this.risk.applyState({
        kill: rs.kill,
        consecutiveFailures: rs.consecutiveFailures,
        tradesToday: rs.tradesToday,
        openPositions: rs.openPositions,
        cooldownUntil: rs.cooldownUntil,
      });
    }
  }

  async _persistRiskState(state) {
    if (!state) return;
    await upsertRiskState(todayKey(), {
      kill: !!state.kill,
      consecutiveFailures: Number(state.consecutiveFailures ?? 0),
      tradesToday: Number(state.tradesToday ?? 0),
      openPositions: Array.isArray(state.openPositions)
        ? state.openPositions
        : [],
      cooldownUntil: state.cooldownUntil || {},
    });
  }

  async refreshRiskLimits() {
    const res = await getRiskLimits();
    const limits = res?.limits || res || {};
    if (this.risk?.setLimits) this.risk.setLimits(limits);
    return limits;
  }

  async _checkExposureLimits({ instrument, qty, entryPrice }) {
    const limits = this.risk?.getLimits ? this.risk.getLimits() : {};
    const maxPerSymbolExposureInr = Number(
      limits?.maxPerSymbolExposureInr ?? 0,
    );
    const maxPortfolioExposureInr = Number(
      limits?.maxPortfolioExposureInr ?? 0,
    );
    const maxLeverage = Number(limits?.maxLeverage ?? 0);

    if (
      maxPerSymbolExposureInr <= 0 &&
      maxPortfolioExposureInr <= 0 &&
      maxLeverage <= 0
    ) {
      return { ok: true };
    }

    const positions = await buildPositionsSnapshot({ kite: this.kite });
    const exposureBySymbol = {};
    let totalExposure = 0;
    for (const p of positions) {
      const key = p.tradingsymbol || String(p.instrument_token || "");
      const exp = Number(p.exposureInr ?? 0);
      if (Number.isFinite(exp) && exp > 0) {
        exposureBySymbol[key] = (exposureBySymbol[key] || 0) + exp;
        totalExposure += exp;
      }
    }

    const newExposure = Math.abs(Number(entryPrice ?? 0) * Number(qty ?? 0));
    const symbolKey =
      instrument?.tradingsymbol || String(instrument?.instrument_token || "");
    const nextSymbolExposure = (exposureBySymbol[symbolKey] || 0) + newExposure;
    const nextTotalExposure = totalExposure + newExposure;

    if (
      maxPerSymbolExposureInr > 0 &&
      nextSymbolExposure > maxPerSymbolExposureInr
    ) {
      return {
        ok: false,
        reason: "MAX_SYMBOL_EXPOSURE",
        meta: {
          symbol: symbolKey,
          nextSymbolExposure,
          maxPerSymbolExposureInr,
          newExposure,
        },
      };
    }

    if (
      maxPortfolioExposureInr > 0 &&
      nextTotalExposure > maxPortfolioExposureInr
    ) {
      return {
        ok: false,
        reason: "MAX_PORTFOLIO_EXPOSURE",
        meta: {
          nextTotalExposure,
          maxPortfolioExposureInr,
          newExposure,
        },
      };
    }

    if (maxLeverage > 0) {
      const equitySnap = await equityService.snapshot({ kite: this.kite });
      const equity = Number(equitySnap?.snapshot?.equity ?? 0);
      if (Number.isFinite(equity) && equity > 0) {
        const leverage = nextTotalExposure / equity;
        if (leverage > maxLeverage) {
          return {
            ok: false,
            reason: "MAX_LEVERAGE",
            meta: {
              leverage,
              maxLeverage,
              equity,
              nextTotalExposure,
            },
          };
        }
      }
    }

    return { ok: true };
  }

  async _recordOrdersPlaced(n = 1) {
    const inc = Number(n ?? 0);
    if (!Number.isFinite(inc) || inc <= 0) return;
    this.ordersPlacedToday += inc;
    await upsertDailyRisk(todayKey(), { ordersPlaced: this.ordersPlacedToday });
  }

  async _loadActiveTradeId() {
    const actives = await getActiveTrades();
    await this._restoreDynamicExitState(actives);
    if (actives.length) {
      const latest = actives.sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
      )[0];
      this.activeTradeId = latest.tradeId;
      this._syncActiveTradeState(latest);
      const nextMarker = `${String(latest.tradeId)}|${String(latest.status || "")}`;
      if (this._activeTradeDbMarker !== nextMarker) {
        logger.warn(
          { tradeId: latest.tradeId, status: latest.status },
          "[reconcile] found active trade in DB",
        );
        this._activeTradeDbMarker = nextMarker;
      }
      return;
    }
    this._activeTradeDbMarker = null;
  }

  async _restoreDynamicExitState(actives = []) {
    for (const trade of actives || []) {
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) continue;
      await this._runTradeCommand(
        tradeId,
        EXEC_COMMAND.HANDLE_RECOVERY_ADOPTION,
        async () => this._restoreDynamicExitTradeState(trade),
        {
          seedTrade: trade,
          allowMissing: true,
        },
      );
    }
  }

  async _restoreDynamicExitTradeState(trade) {
    const tradeId = String(trade?.tradeId || "");
    if (!tradeId) return;

    const patch = { ...buildMissingWinnerProtectionPatch(trade) };
    Object.assign(patch, buildMissingTradeLifecyclePatch(trade));
    Object.assign(
      patch,
      buildStrategyStopLossBackfillPatch(trade, {
        allowRecoveryBrokerFallback:
          String(trade?.status || "") === STATUS.RECOVERY_REHYDRATED ||
          String(trade?.strategyId || "") === "recovery" ||
          Boolean(trade?.recoveryReason),
      }),
    );
    if (!Object.prototype.hasOwnProperty.call(trade, "peakLtp")) {
      patch.peakLtp = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "peakPnlInr")) {
      patch.peakPnlInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "peakPnlR")) {
      patch.peakPnlR = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "peakExecutablePnlInr")) {
      patch.peakExecutablePnlInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "executionRiskPts")) {
      patch.executionRiskPts = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "executionRiskQty")) {
      patch.executionRiskQty = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "executionRiskInr")) {
      patch.executionRiskInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "beLocked")) {
      patch.beLocked = false;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "trueBePrice")) {
      patch.trueBePrice = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "costGreenFloorInr")) {
      patch.costGreenFloorInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "costGreenFloorPrice")) {
      patch.costGreenFloorPrice = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "greenLockActive")) {
      patch.greenLockActive = false;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "greenLockFloorPrice")) {
      patch.greenLockFloorPrice = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "beAppliedAt")) {
      patch.beAppliedAt = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "beAppliedStopLoss")) {
      patch.beAppliedStopLoss = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "beApplyFails")) {
      patch.beApplyFails = 0;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "trailLocked")) {
      patch.trailLocked = false;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "shadowExitActive")) {
      patch.shadowExitActive = false;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "protectionUpgradePending")) {
      patch.protectionUpgradePending = false;
    }
    if (
      !Object.prototype.hasOwnProperty.call(trade, "protectionUpgradeSoftFailed")
    ) {
      patch.protectionUpgradeSoftFailed = false;
    }
    if (
      !Object.prototype.hasOwnProperty.call(trade, "protectionUpgradeFallbackMode")
    ) {
      patch.protectionUpgradeFallbackMode = null;
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        trade,
        "protectionUpgradeUnconfirmedSince",
      )
    ) {
      patch.protectionUpgradeUnconfirmedSince = null;
    }
    if (
      !Object.prototype.hasOwnProperty.call(trade, "protectionUpgradeTargetStopLoss")
    ) {
      patch.protectionUpgradeTargetStopLoss = null;
    }
    if (
      !Object.prototype.hasOwnProperty.call(trade, "shadowProtectionActiveReason")
    ) {
      patch.shadowProtectionActiveReason = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerRebasedAt")) {
      patch.runnerRebasedAt = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerRebaseSource")) {
      patch.runnerRebaseSource = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerBaselineQty")) {
      patch.runnerBaselineQty = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerBaselineLtp")) {
      patch.runnerBaselineLtp = null;
    }
    if (
      !Object.prototype.hasOwnProperty.call(trade, "runnerBaselineExecutablePrice")
    ) {
      patch.runnerBaselineExecutablePrice = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerBaselinePnlInr")) {
      patch.runnerBaselinePnlInr = null;
    }
    if (
      !Object.prototype.hasOwnProperty.call(
        trade,
        "runnerBaselineExecutablePnlInr",
      )
    ) {
      patch.runnerBaselineExecutablePnlInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "runnerRealizedPnlInr")) {
      patch.runnerRealizedPnlInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "lastProtectedR")) {
      patch.lastProtectedR = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "lastProtectedInr")) {
      patch.lastProtectedInr = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "lastExitPlanReason")) {
      patch.lastExitPlanReason = null;
    }
    if (!Object.prototype.hasOwnProperty.call(trade, "timeStopTriggeredAt")) {
      patch.timeStopTriggeredAt = null;
    }

    if (Object.keys(patch).length) {
      try {
        await this._updateTrade(tradeId, patch);
        Object.assign(trade, patch);
      } catch (e) {
        logger.warn(
          {
            tradeId,
            e: e?.message || String(e),
            patchKeys: Object.keys(patch),
          },
          "[reconcile] failed restoring dynamic exit defaults",
        );
      }
    }

    const peakLtp = toFiniteOrNaN(trade?.peakLtp);
    if (Number.isFinite(peakLtp) && peakLtp > 0) {
      this._dynPeakLtpByTrade.set(tradeId, peakLtp);
    }
  }

  async _hydrateOpenPositionFromActiveTrade() {
    const actives = await getActiveTrades();
    if (!actives.length) return;

    for (const t of actives) {
      if (!t?.instrument_token) continue;
      this.risk.setOpenPosition(this._riskKeyForTrade(t), {
        tradeId: t.tradeId,
        side: t.side,
        qty: Number(t.qty ?? 0),
      });
      if (t?.targetVirtual && !t?.targetOrderId) {
        this._registerVirtualTargetFromTrade(t);
      }
    }
  }

  onTick(tick) {
    if (this._stopped) return;
    if (!tick?.instrument_token) return;
    const token = Number(tick.instrument_token);
    const ltp = Number(tick.last_price);
    if (Number.isFinite(ltp)) this.lastPriceByToken.set(token, ltp);

    const now = Date.now();
    this.lastTickAtByToken.set(token, now);

    const lossEveryMs = Number(env.DAILY_LOSS_CHECK_MS ?? 2000);
    if (
      Number.isFinite(lossEveryMs) &&
      lossEveryMs > 0 &&
      now - this._lastDailyLossCheckAt >= lossEveryMs
    ) {
      this._lastDailyLossCheckAt = now;
      if (!this._dailyLossInFlight) {
        this._dailyLossInFlight = true;
        this._checkDailyLoss()
          .catch((err) =>
            reportFault({
              code: "DAILY_LOSS_CHECK_FAILED",
              err,
              message: "[risk] daily loss check failed",
            }),
          )
          .finally(() => {
            this._dailyLossInFlight = false;
          });
      }
    }

    const flattenEveryMs = Number(env.FORCE_FLATTEN_CHECK_MS ?? 1000);
    if (
      Number.isFinite(flattenEveryMs) &&
      flattenEveryMs > 0 &&
      now - this._lastFlattenCheckAt >= flattenEveryMs
    ) {
      this._lastFlattenCheckAt = now;
      this._forceFlattenIfNeeded().catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });
    }

    if (!this._portfolioRiskInFlight) {
      this._portfolioRiskInFlight = true;
      this._monitorPortfolioRisk("tick")
        .catch((err) =>
          reportFault({
            code: "PORTFOLIO_RISK_CHECK_FAILED",
            err,
            message: "[risk] portfolio check failed",
          }),
        )
        .finally(() => {
          this._portfolioRiskInFlight = false;
        });
    }

    // Tick-accurate peak tracking for live trade
    try {
      this._maybeUpdatePeakFromTick(token, ltp);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // SL watchdog: track trigger crossings in fast moves (especially for SL-L fallback)
    try {
      this._maybeTriggerSlWatchFromTick(token, ltp, now);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // Virtual target watcher: exit when target price is hit without resting order
    try {
      this._maybeTriggerVirtualTargetFromTick(token, ltp, now);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // TARGET watchdog: if target touched but still OPEN -> chase fill
    try {
      this._maybeTriggerTargetWatchFromTick(token, ltp, now);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _syncActiveTradeState(trade) {
    if (!trade) return;
    const token = Number(trade.instrument_token);
    if (Number.isFinite(token) && token > 0) {
      this._activeTradeToken = token;
    }
    const side = String(trade.side || "").toUpperCase();
    if (side) {
      this._activeTradeSide = side;
    }
  }

  _maybeUpdatePeakFromTick(token, ltp) {
    if (!this.activeTradeId) return;
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    if (!Number.isFinite(this._activeTradeToken)) return;
    if (Number(token) !== Number(this._activeTradeToken)) return;
    const side = String(this._activeTradeSide || "").toUpperCase();
    if (side !== "BUY" && side !== "SELL") return;

    const tradeId = String(this.activeTradeId);
    const prev = toFiniteOrNaN(this._dynPeakLtpByTrade.get(tradeId));
    let next = prev;
    if (!Number.isFinite(prev)) next = ltp;
    else if (side === "BUY") next = Math.max(prev, ltp);
    else next = Math.min(prev, ltp);

    if (Number.isFinite(next)) {
      this._dynPeakLtpByTrade.set(tradeId, next);
    }
  }

  // =========================
  // SL fill watchdog (for SL-L fallback)
  // =========================
  _isSlWatchdogEnabled() {
    return String(env.SL_WATCHDOG_ENABLED || "true") !== "false";
  }

  _clearSlWatch(tradeId) {
    try {
      const id = String(tradeId || "");
      const st = this._slWatch.get(id);
      if (st?.timer) {
        clearTimeout(st.timer);
      }
      this._slWatch.delete(id);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _registerSlWatchFromTrade(trade) {
    try {
      if (!this._isSlWatchdogEnabled()) return;
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;

      const slOrderId = trade?.slOrderId ? String(trade.slOrderId) : null;
      if (!slOrderId) return;

      // Watch only stoploss-limit (SL) — SL-M becomes MARKET on trigger and should not remain OPEN.
      const ot = String(trade?.slOrderType || "").toUpperCase();
      if (ot && ot !== "SL") return;

      const token = Number(trade?.instrument_token);
      const triggerPrice = Number(trade?.stopLoss);
      if (
        !Number.isFinite(token) ||
        !Number.isFinite(triggerPrice) ||
        triggerPrice <= 0
      )
        return;

      const side = String(trade?.side || "BUY").toUpperCase();
      const exitSide = side === "BUY" ? "SELL" : "BUY";

      const existing = this._slWatch.get(tradeId) || {};
      this._slWatch.set(tradeId, {
        ...existing,
        tradeId,
        token,
        side,
        exitSide,
        triggerPrice,
        slOrderId,
        slOrderType: ot || "SL",
        triggeredAtMs: existing.triggeredAtMs || 0,
        firedAtMs: existing.firedAtMs || 0,
        lastLtp: existing.lastLtp || null,
        timer: existing.timer || null,
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _updateSlWatchTrigger(tradeId, triggerPrice) {
    try {
      const id = String(tradeId || "");
      const st = this._slWatch.get(id);
      const tp = Number(triggerPrice);
      if (!st || !Number.isFinite(tp) || tp <= 0) return;
      this._slWatch.set(id, { ...st, triggerPrice: tp });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _slWatchIsBreached(ltp, triggerPrice, exitSide) {
    const l = Number(ltp);
    const t = Number(triggerPrice);
    if (!Number.isFinite(l) || !Number.isFinite(t) || t <= 0) return false;

    const bufBps = Number(env.SL_WATCHDOG_TRIGGER_BPS_BUFFER ?? 5);
    const b = Number.isFinite(bufBps) ? bufBps : 0;
    const factor = b > 0 ? b / 10000 : 0;

    if (String(exitSide).toUpperCase() === "SELL") {
      // Long position stop: trigger when LTP <= trigger. Add buffer by requiring LTP slightly below trigger.
      return l <= t * (1 - factor);
    }
    // Short position stop: trigger when LTP >= trigger. Add buffer by requiring LTP slightly above trigger.
    return l >= t * (1 + factor);
  }

  _armSlWatchTriggered(tradeId, nowMs, source = "tick") {
    try {
      if (this._stopped) return;
      if (!this._isSlWatchdogEnabled()) return;
      const id = String(tradeId || "");
      if (!id) return;
      const st = this._slWatch.get(id);
      if (!st || st.triggeredAtMs) return;

      st.triggeredAtMs = Number(nowMs ?? Date.now());
      st.triggeredBy = String(source || "tick");
      this._slWatch.set(id, st);
      try {
        this._updateTrade(id, {
          slTriggeredAt: new Date(st.triggeredAtMs),
          slTriggeredSource: st.triggeredBy,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      const openSec = Number(env.SL_WATCHDOG_OPEN_SEC ?? 8);
      const ms = Math.max(1000, openSec * 1000);
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => {
        this._slWatchdogFire(id, "timeout").catch((err) => {
          reportFault({
            code: "TRADING_TRADEMANAGER_ASYNC",
            err,
            message: "[src/trading/tradeManager.js] async task failed",
          });
        });
      }, ms);
      this._slWatch.set(id, st);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _maybeTriggerSlWatchFromTick(token, ltp, nowMs) {
    if (!this._isSlWatchdogEnabled()) return;
    if (!this.activeTradeId) return;

    const tradeId = String(this.activeTradeId);
    const st = this._slWatch.get(tradeId);
    if (!st) return;

    if (Number(st.token) !== Number(token)) return;
    if (!Number.isFinite(Number(ltp))) return;

    // Update last seen LTP for diagnostics
    st.lastLtp = Number(ltp);
    this._slWatch.set(tradeId, st);

    const requireBreach =
      String(env.SL_WATCHDOG_REQUIRE_LTP_BREACH || "true") !== "false";
    const breached = this._slWatchIsBreached(ltp, st.triggerPrice, st.exitSide);

    if (requireBreach && !breached) return;

    // Mark triggered and arm timer once
    if (!st.triggeredAtMs) {
      this._armSlWatchTriggered(tradeId, nowMs, "tick");
    }
  }

  _virtualTargetIsHit(ltp, targetPrice, exitSide) {
    const l = Number(ltp);
    const t = Number(targetPrice);
    if (!Number.isFinite(l) || !Number.isFinite(t) || t <= 0) return false;
    if (String(exitSide).toUpperCase() === "SELL") return l >= t;
    return l <= t;
  }

  // =========================
  // TARGET fill watchdog (LIMIT target chase)
  // =========================
  _isTargetWatchdogEnabled() {
    return String(env.TARGET_WATCHDOG_ENABLED || "true") !== "false";
  }

  _clearTargetWatch(tradeId) {
    try {
      const id = String(tradeId || "");
      const st = this._targetWatch.get(id);
      if (st?.timer) clearTimeout(st.timer);
      this._targetWatch.delete(id);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _registerTargetWatchFromTrade(trade) {
    try {
      if (!this._isTargetWatchdogEnabled()) return;
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;
      if (trade?.targetVirtual) return;

      const targetOrderId = trade?.targetOrderId
        ? String(trade.targetOrderId)
        : null;
      if (!targetOrderId) return;

      const orderType = String(trade?.targetOrderType || "").toUpperCase();
      if (orderType && orderType === "MARKET") return;

      const token = Number(trade?.instrument_token);
      const targetPrice =
        Number(trade?.targetPrice) || this._computeTargetPrice(trade);
      if (
        !Number.isFinite(token) ||
        !Number.isFinite(targetPrice) ||
        targetPrice <= 0
      )
        return;

      const side = String(trade?.side || "BUY").toUpperCase();
      const exitSide = side === "BUY" ? "SELL" : "BUY";

      const existing = this._targetWatch.get(tradeId) || {};
      this._targetWatch.set(tradeId, {
        ...existing,
        tradeId,
        token,
        side,
        exitSide,
        targetPrice,
        targetOrderId,
        orderType: orderType || "LIMIT",
        triggeredAtMs: existing.triggeredAtMs || 0,
        lastActionAtMs: existing.lastActionAtMs || 0,
        retryCount: Number(existing.retryCount ?? 0),
        lastLtp: existing.lastLtp || null,
        timer: existing.timer || null,
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _targetWatchIsHit(ltp, targetPrice, exitSide) {
    const l = Number(ltp);
    const t = Number(targetPrice);
    if (!Number.isFinite(l) || !Number.isFinite(t) || t <= 0) return false;

    const bufBps = Number(env.TARGET_WATCHDOG_TRIGGER_BPS_BUFFER ?? 2);
    const b = Number.isFinite(bufBps) ? bufBps : 0;
    const factor = b > 0 ? b / 10000 : 0;

    if (String(exitSide).toUpperCase() === "SELL") {
      return l >= t * (1 + factor);
    }
    return l <= t * (1 - factor);
  }

  _refreshTargetWatchAfterAdjust(trade, targetPrice) {
    try {
      if (!this._isTargetWatchdogEnabled()) return;
      const tradeId = String(trade?.tradeId || "");
      const price = Number(targetPrice);
      if (!tradeId || !Number.isFinite(price) || price <= 0) return;

      this._registerTargetWatchFromTrade({ ...trade, targetPrice: price });
      const st = this._targetWatch.get(tradeId);
      if (!st) return;
      this._targetWatch.set(tradeId, { ...st, targetPrice: price });

      const ltp = this.lastPriceByToken.get(Number(st.token));
      if (Number.isFinite(Number(ltp))) {
        this._maybeTriggerTargetWatchFromTick(st.token, ltp, Date.now());
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _armTargetWatchTimer(tradeId, st, openSec) {
    if (this._stopped) return;
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    const ms = Math.max(500, Number(openSec ?? 2) * 1000);
    st.timer = setTimeout(() => {
      this._targetWatchdogFire(tradeId, "timeout").catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });
    }, ms);
    this._targetWatch.set(tradeId, st);
  }

  _maybeTriggerTargetWatchFromTick(token, ltp, nowMs) {
    if (!this._isTargetWatchdogEnabled()) return;
    if (!this.activeTradeId) return;

    const tradeId = String(this.activeTradeId);
    const st = this._targetWatch.get(tradeId);
    if (!st) return;
    if (Number(st.token) !== Number(token)) return;
    if (!Number.isFinite(Number(ltp))) return;

    st.lastLtp = Number(ltp);
    this._targetWatch.set(tradeId, st);

    const requireTouch =
      String(env.TARGET_WATCHDOG_REQUIRE_LTP_TOUCH || "true") !== "false";
    const hit = this._targetWatchIsHit(ltp, st.targetPrice, st.exitSide);

    if (requireTouch && !hit) return;

    if (!st.triggeredAtMs) {
      st.triggeredAtMs = Number(nowMs ?? Date.now());
      this._targetWatch.set(tradeId, st);
      try {
        this._updateTrade(tradeId, {
          targetTouchedAt: new Date(st.triggeredAtMs),
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      const openSec = Number(env.TARGET_WATCHDOG_OPEN_SEC ?? 2);
      this._armTargetWatchTimer(tradeId, st, openSec);
    }
  }

  _targetWatchdogHeartbeat(trade, netQty, source = "reconcile") {
    try {
      if (!this._isTargetWatchdogEnabled()) return;
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;

      if (!Number.isFinite(Number(netQty)) || Number(netQty) === 0) {
        this._clearTargetWatch(tradeId);
        return;
      }

      this._registerTargetWatchFromTrade(trade);
      const st = this._targetWatch.get(tradeId);
      if (!st) return;

      const openSec = Number(env.TARGET_WATCHDOG_OPEN_SEC ?? 2);
      const nowMs = Date.now();

      if (st.triggeredAtMs) {
        const overdue = nowMs - Number(st.triggeredAtMs) >= openSec * 1000;
        if (overdue) {
          this._targetWatchdogFire(tradeId, `heartbeat_${source}`).catch(
            () => {},
          );
          return;
        }
      }

      const ltp = this.lastPriceByToken.get(Number(st.token));
      if (!Number.isFinite(Number(ltp))) return;
      this._maybeTriggerTargetWatchFromTick(st.token, ltp, nowMs);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  async _getBestBidAsk(instrument) {
    const ex = instrument?.exchange || env.DEFAULT_EXCHANGE || "NSE";
    const sym = instrument?.tradingsymbol;
    if (!sym || typeof this.kite.getQuote !== "function") return null;
    const key = `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}`;
    try {
      const fetchedAtMs = Date.now();
      const resp = await this.kite.getQuote([key]);
      const q = resp?.[key];
      const bid = Number(q?.depth?.buy?.[0]?.price);
      const ask = Number(q?.depth?.sell?.[0]?.price);
      const bidQty = Number(q?.depth?.buy?.[0]?.quantity ?? 0);
      const askQty = Number(q?.depth?.sell?.[0]?.quantity ?? 0);
      const ltp = Number(q?.last_price);
      return {
        bid,
        ask,
        ltp,
        bidQty: Number.isFinite(bidQty) ? bidQty : null,
        askQty: Number.isFinite(askQty) ? askQty : null,
        fetchedAtMs,
        timestamp:
          q?.timestamp || q?.last_trade_time || q?.exchange_timestamp || null,
        timestampMs:
          parseOrderTimestampMs({
            order_timestamp:
              q?.timestamp || q?.last_trade_time || q?.exchange_timestamp,
          }) ?? fetchedAtMs,
      };
    } catch {
      return null;
    }
  }

  _isShadowStopBreached(trade, plan, marketPrice) {
    const stop = Number(
      plan?.finalStop ?? plan?.sl?.stopLoss ?? plan?.meta?.desiredStopLoss,
    );
    const px = Number(plan?.meta?.currentExecutablePrice ?? marketPrice);
    const side = String(trade?.side || "").toUpperCase();
    if (!(Number.isFinite(stop) && Number.isFinite(px))) return false;
    return side === "SELL" ? px >= stop : px <= stop;
  }

  async _activateDynamicShadowMode(
    trade,
    plan,
    { failCount, error, source } = {},
  ) {
    const tradeId = String(trade?.tradeId || "");
    if (!tradeId) return;
    const reason = String(
      plan?.reason || plan?.action?.reason || "SHADOW_EXIT",
    );
    const patch = {
      shadowExitActive: true,
      shadowProtectionActiveReason: reason,
      lastExitPlanReason: reason,
      ...this._eventPatch("SHADOW_EXIT", {
        tradeId,
        failCount: Number(failCount ?? 0),
        source: source || "modify_fail",
        stopLoss:
          Number(
            plan?.finalStop ??
              plan?.sl?.stopLoss ??
              plan?.meta?.desiredStopLoss ??
              0,
          ) || null,
        reason,
      }),
    };
    try {
      await this._updateTrade(tradeId, patch);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
    logger.error(
      {
        tradeId,
        failCount: Number(failCount ?? 0),
        source: source || "modify_fail",
        e: error ? String(error?.message || error) : null,
        reason,
      },
      "[dyn_exit] shadow exit mode active",
    );
  }

  async _replaceDynamicSlOrder(trade, nextStopLoss) {
    const tradeId = String(trade?.tradeId || "");
    if (!tradeId || !trade?.slOrderId || !Number.isFinite(Number(nextStopLoss)))
      return false;
    try {
      this.expectedCancelOrderIds.add(String(trade.slOrderId));
      await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, trade.slOrderId, {
        purpose: "DYN_CANCEL_REPLACE_SL",
        tradeId,
      });
      await this._updateTrade(tradeId, {
        slOrderId: null,
        slPlacedAt: null,
        stopLoss: Number(nextStopLoss),
        slTrigger: Number(nextStopLoss),
        shadowExitActive: false,
        ...clearProtectionUpgradeStatePatch(),
        ...this._eventPatch("CANCEL_REPLACE", {
          tradeId,
          stopLoss: Number(nextStopLoss),
        }),
      });
      await this._placeExitsIfMissing({
        ...trade,
        slOrderId: null,
        stopLoss: Number(nextStopLoss),
        slTrigger: Number(nextStopLoss),
      });
      return true;
    } catch (err) {
      logger.warn(
        {
          tradeId,
          stopLoss: Number(nextStopLoss),
          e: err?.message || String(err),
        },
        "[dyn_exit] cancel-replace SL failed",
      );
      return false;
    }
  }

  _entryUrgencyProfile(trade) {
    return buildEntryUrgencyProfile({ trade, env });
  }

  _signalTimestampMs(signal, fallbackNow = Date.now()) {
    const ts =
      Date.parse(signal?.signalEventTs || "") ||
      Date.parse(signal?.candle?.ts || "") ||
      Date.parse(signal?.ts || "") ||
      Date.parse(signal?.signalCreatedAt || "") ||
      Date.parse(signal?.signalTs || "") ||
      Date.parse(signal?.decisionAt || "") ||
      Date.parse(signal?.createdAt || "");
    return Number.isFinite(ts) ? ts : fallbackNow;
  }

  _buildSignalLikeFromTrade(trade = {}) {
    return {
      signalId: trade?.signalId || null,
      strategyId: trade?.strategyId || null,
      strategyStyle:
        trade?.strategyStyle ||
        trade?.planMeta?.style ||
        trade?.option_meta?.strategyStyle ||
        null,
      side: trade?.side || null,
      intervalMin: trade?.intervalMin || null,
      signalCreatedAt: trade?.signalCreatedAt || null,
      signalEventTs: trade?.signalEventTs || trade?.signalTs || null,
      regimeSnapshot: trade?.regimeSnapshot || null,
      regimeSnapshotId:
        trade?.regimeSnapshotId || trade?.regimeSnapshot?.snapshotId || null,
      instrument_token: trade?.instrument_token || null,
      option_meta: trade?.option_meta || null,
      conversionSummary: trade?.conversionSummary || null,
    };
  }

  _recordTradeDecision({
    signal = null,
    trade = null,
    token = null,
    outcome,
    stage,
    reason,
    meta = {},
  }) {
    const signalLike = signal || this._buildSignalLikeFromTrade(trade);
    const tokenCandidate =
      token ?? trade?.instrument_token ?? signalLike?.instrument_token;
    const finalToken = Number(tokenCandidate);
    const conversionSummary =
      meta?.conversionSummary ||
      signalLike?.conversionSummary ||
      trade?.conversionSummary ||
      null;
    const enrichedMeta = withSignalLifecycleMeta(signalLike, {
      ...(trade?.tradeId ? { tradeId: trade.tradeId } : {}),
      ...(conversionSummary ? { conversionSummary } : {}),
      ...meta,
    });

    telemetry.recordDecision({
      signal: signalLike,
      token:
        Number.isFinite(finalToken) && finalToken > 0 ? finalToken : null,
      outcome,
      stage,
      reason,
      meta: enrichedMeta,
    });

    tradeTelemetry.recordDecision({
      tradeId: trade?.tradeId || null,
      signalId: signalLike?.signalId || null,
      strategyId: trade?.strategyId || signalLike?.strategyId || null,
      side: trade?.side || signalLike?.side || null,
      token:
        Number.isFinite(finalToken) && finalToken > 0 ? finalToken : null,
      outcome,
      stage,
      reason,
      meta: enrichedMeta,
    });
  }

  _buildEntryFillMetrics({ trade, avgPrice, filledQty, eventName }) {
    const avg = Number(avgPrice ?? trade?.entryPrice ?? trade?.candle?.close ?? 0);
    const qty = Number(filledQty ?? trade?.qty ?? 0);
    const expected = Number(
      trade?.expectedEntryPrice ??
        trade?.quoteAtEntry?.ltp ??
        trade?.candle?.close ??
        0,
    );
    const entrySide = String(trade?.side || "BUY").toUpperCase();
    const entryType = String(
      trade?.entryOrderType || env.ENTRY_ORDER_TYPE || "MARKET",
    ).toUpperCase();
    const submittedLimitPriceRaw =
      entryType === "LIMIT"
        ? (trade?.expectedEntryPrice ?? trade?.entryPrice ?? null)
        : null;
    const submittedLimitPrice =
      Number.isFinite(Number(submittedLimitPriceRaw)) &&
      Number(submittedLimitPriceRaw) > 0
        ? Number(submittedLimitPriceRaw)
        : null;
    const slipInr = worseSlippageInr({
      side: trade?.side,
      expected,
      actual: avg,
      qty,
      leg: "ENTRY",
    });
    const guardForLimit =
      String(env.ENTRY_SLIPPAGE_GUARD_FOR_LIMIT || "false") === "true";

    const isOptContract =
      !!trade?.option_meta ||
      String(trade?.instrument?.instrument_type || "").toUpperCase() === "CE" ||
      String(trade?.instrument?.instrument_type || "").toUpperCase() === "PE" ||
      /(?:CE|PE)$/.test(
        String(trade?.instrument?.tradingsymbol || "").toUpperCase(),
      );

    const maxBps = Number(
      trade?.maxEntrySlippageBps ??
        (isOptContract
          ? (env.MAX_ENTRY_SLIPPAGE_BPS_OPT ?? 120)
          : (env.MAX_ENTRY_SLIPPAGE_BPS ?? 25)),
    );
    const killBpsBase = Number(
      trade?.maxEntrySlippageKillBps ??
        (isOptContract
          ? (env.MAX_ENTRY_SLIPPAGE_KILL_BPS_OPT ?? 250)
          : (env.MAX_ENTRY_SLIPPAGE_KILL_BPS ?? 60)),
    );

    const tick = Number(trade?.instrument?.tick_size ?? 0.05);
    const ticksAllowance = Number(
      isOptContract
        ? (env.MAX_ENTRY_SLIPPAGE_TICKS_OPT ?? 4)
        : (env.MAX_ENTRY_SLIPPAGE_TICKS ?? 2),
    );
    const tickBps =
      expected > 0 && tick > 0 ? (tick / expected) * 10000 : null;

    const effMaxBps =
      tickBps != null
        ? Math.max(maxBps, tickBps * Math.max(1, ticksAllowance))
        : maxBps;
    const effKillBps = Math.max(killBpsBase, effMaxBps * 2);

    const slippageGuard = evaluateEntrySlippageGuard({
      entrySide,
      entryType,
      expectedPrice: expected,
      avgFillPrice: avg,
      submittedLimitPrice,
      thresholdBps: effMaxBps,
      guardForLimit,
    });

    const plannedEntryForFill = Number(
      trade?.plannedEntry ?? trade?.expectedEntryPrice ?? expected ?? 0,
    );
    const actualEntryDriftPct = adverseDriftPct({
      side: trade?.side,
      plannedEntry: plannedEntryForFill,
      actualEntry: avg,
    });
    const entryAt = new Date();
    const entryFillPatch = {
      entryPrice: avg,
      actualEntry: avg,
      qty,
      entrySlippageBps: slippageGuard.rawSlipBps,
      entrySlippageInrWorse: slipInr,
      entryDriftPct: actualEntryDriftPct,
      entryFilledAt: entryAt,
      entryAt,
      entryFinalized: true,
      ...this._eventPatch(eventName, {
        avg,
        filledQty: qty,
        slipBps: slippageGuard.rawSlipBps,
      }),
    };

    return {
      avg,
      qty,
      slippageLog: {
        tradeId: trade?.tradeId,
        entrySide,
        entryType,
        expected,
        avg,
        submittedLimitPrice,
        rawSlipBps: slippageGuard.rawSlipBps,
        adverseSlipBps: slippageGuard.adverseSlipBps,
        favorableSlipBps: slippageGuard.favorableSlipBps,
        thresholdBps: effMaxBps,
        effMaxBps,
        isAtOrBetterThanLimit: slippageGuard.isAtOrBetterThanLimit,
        triggered: slippageGuard.triggered,
        reason: slippageGuard.reason,
        maxBps,
        tick,
        ticksAllowance,
      },
      adverseSlipBps: slippageGuard.adverseSlipBps,
      effKillBps,
      entryType,
      shouldPanicForSlippage: slippageGuard.triggered,
      entryFillPatch,
    };
  }

  _buildEntryRiskPatch({ trade, entryPrice, filledQty }) {
    const minGreenEnabled = String(env.MIN_GREEN_ENABLED || "true") === "true";
    const minGreen = minGreenEnabled
      ? estimateMinGreen({
          entryPrice,
          qty: filledQty,
          spreadBps: Number(trade?.quoteAtEntry?.bps ?? 0),
          env,
          instrument: trade.instrument,
        })
      : {
          estChargesInr: 0,
          slippageBufferInr: 0,
          minGreenInr: 0,
          minGreenPts: 0,
          meta: null,
        };

    const strategyStopLossAtFill = this._strategyStopLossFromTrade(trade);
    const sizingStopLossAtFill = this._sizingStopLossFromTrade(trade);
    const actualRisk = this._computeActualRiskFromStrategyStop({
      entryPrice,
      strategyStopLoss: strategyStopLossAtFill,
      qty: filledQty,
      side: trade.side,
    });
    const executionRisk = buildExecutionRiskPatch({
      trade,
      qty: filledQty,
      entryPrice,
      stopLoss: strategyStopLossAtFill,
    });
    const riskBudgetAtFill = this._riskBudgetInr(trade);

    const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
    const proTimeStopsEnabled =
      Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0) > 0 ||
      Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0) > 0;
    const timeStopAt =
      !proTimeStopsEnabled &&
      Number.isFinite(timeStopMin) &&
      timeStopMin > 0
        ? new Date(Date.now() + timeStopMin * 60 * 1000)
        : null;

    return {
      minGreen,
      actualRisk,
      riskBudgetAtFill,
      timeStopAt,
      patch: this._buildStopSemanticsPatch({
        strategyStopLoss: strategyStopLossAtFill,
        sizingStopLoss: sizingStopLossAtFill,
        brokerStopLoss: strategyStopLossAtFill,
        patch: {
          riskPts: actualRisk.riskPts,
          riskInr: riskBudgetAtFill,
          ...executionRisk,
          lotSize: filledQty,
          riskStopPrice: strategyStopLossAtFill,
          riskStopPts: actualRisk.riskPts,
          riskStopInr: actualRisk.riskInr,
          riskQty: filledQty,
          initialStrategyRiskPts:
            trade.initialStrategyRiskPts ?? actualRisk.riskPts,
          initialStrategyRiskInr:
            trade.initialStrategyRiskInr ?? actualRisk.riskInr,
          postFillTrueRiskInr: actualRisk.riskInr,
          postFillRiskCapInr: riskBudgetAtFill,
          postFillRiskAction: "NONE",
          riskBreachState: "NONE",
          actualRiskPts: actualRisk.riskPts,
          actualRiskInr: actualRisk.riskInr,
          estChargesInr: minGreen.estChargesInr,
          slippageBufferInr: minGreen.slippageBufferInr,
          minGreenInr: minGreen.minGreenInr,
          minGreenPts: minGreen.minGreenPts,
          timeStopAt,
        },
      }),
    };
  }

  async _finalizeEntryFill(args) {
    return this._runTradeCommand(
      args?.tradeId,
      EXEC_COMMAND.FINALIZE_ENTRY_FILL,
      async () => this._finalizeEntryFillImpl(args),
      {
        seedTrade: args?.trade,
        allowMissing: true,
      },
    );
  }

  async _finalizeEntryFillImpl({
    tradeId,
    trade,
    avgPrice,
    filledQty,
    source = "unknown",
    partial = false,
    reason = null,
  }) {
    const currentTrade = (await getTrade(tradeId)) || trade;
    if (!currentTrade) return { ok: false, reason: "MISSING_TRADE" };

    const metrics = this._buildEntryFillMetrics({
      trade: currentTrade,
      avgPrice,
      filledQty,
      eventName: partial ? "ENTRY_PARTIAL_FILL" : "ENTRY_FILLED",
    });

    if (
      !partial &&
      metrics.shouldPanicForSlippage &&
      Number.isFinite(metrics.adverseSlipBps)
    ) {
      await this._updateTrade(tradeId, {
        status: STATUS.GUARD_FAILED,
        closeReason: `ENTRY_SLIPPAGE (${metrics.adverseSlipBps.toFixed(
          1,
        )}bps > ${Number(metrics.slippageLog.effMaxBps).toFixed(1)})`,
        ...metrics.entryFillPatch,
      });
      logger.error(
        { ...metrics.slippageLog, source },
        "[guard] adverse entry slippage too high -> panic exit",
      );
      this._recordTradeDecision({
        trade: currentTrade,
        outcome: "BLOCKED",
        stage: "entry_fill",
        reason: "ENTRY_SLIPPAGE",
        meta: { source, ...metrics.slippageLog },
      });
      alert(
        "error",
        "ENTRY slippage too high -> panic exit",
        { source, ...metrics.slippageLog },
      ).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );

      if (
        metrics.adverseSlipBps >= metrics.effKillBps &&
        metrics.entryType === "MARKET"
      ) {
        this.risk.setKillSwitch(true);
      }

      await this._panicExit(
        {
          ...currentTrade,
          status: STATUS.GUARD_FAILED,
          entryPrice: metrics.avg,
          qty: metrics.qty,
        },
        "ENTRY_SLIPPAGE",
      );
      return { ok: false, exited: true, reason: "ENTRY_SLIPPAGE" };
    }

    const entryStatus = partial ? STATUS.ENTRY_OPEN : STATUS.ENTRY_FILLED;
    await this._updateTrade(tradeId, {
      status: entryStatus,
      ...metrics.entryFillPatch,
      ...(reason
        ? {
            entryPendingLastReason: reason,
            entryPendingLastCheckAt: new Date(),
          }
        : {}),
    });

    const patchedTrade = (await getTrade(tradeId)) || {
      ...currentTrade,
      ...metrics.entryFillPatch,
      status: entryStatus,
    };
    const riskPatch = this._buildEntryRiskPatch({
      trade: patchedTrade,
      entryPrice: metrics.avg,
      filledQty: metrics.qty,
    });

    logger.info(
      {
        tradeId,
        source,
        strategyStopLoss: this._strategyStopLossFromTrade(patchedTrade),
        actualRiskPts: riskPatch.actualRisk.riskPts,
        actualRiskInr: riskPatch.actualRisk.riskInr,
        minGreenInr: riskPatch.minGreen.minGreenInr,
        minGreenPts: riskPatch.minGreen.minGreenPts,
        timeStopAt: riskPatch.timeStopAt,
      },
      partial
        ? "[trade] strategy risk/min-green computed (partial)"
        : "[trade] strategy risk/min-green computed",
    );

    await this._updateTrade(tradeId, riskPatch.patch);
    this.risk.resetFailures();

    const afterRiskPatch = (await getTrade(tradeId)) || patchedTrade;
    await this._placeExitsIfMissing({
      ...afterRiskPatch,
      entryPrice: metrics.avg,
      qty: metrics.qty,
    });

    const postPlacementTrade = await getTrade(tradeId);
    if (!postPlacementTrade) {
      return { ok: false, reason: "TRADE_MISSING_AFTER_EXIT_PLACEMENT" };
    }
    if (
      [
        STATUS.GUARD_FAILED,
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.CLOSED,
      ].includes(postPlacementTrade.status) ||
      hasPanicExitStarted(postPlacementTrade)
    ) {
      return { ok: false, exited: true, reason: "EXIT_PLACEMENT_TERMINAL" };
    }

    const pf = await this._postFillRiskRecheckAndAdjust({
      tradeId,
      entryPrice: metrics.avg,
      qty: Number(postPlacementTrade.qty ?? metrics.qty),
    });
    if (pf && pf.exited) return pf;

    if (!partial) {
      await this._recalcTargetFromActualFill({
        tradeId,
        entryPrice: metrics.avg,
      });
    }

    const finalTrade = await getTrade(tradeId);
    const finalQty = Number(finalTrade?.qty ?? metrics.qty ?? 0);
    if (finalQty > 0) {
      await this._ensureExitQty(tradeId, finalQty);
    }

    this._recordTradeDecision({
      trade: finalTrade || afterRiskPatch,
      outcome: "ACCEPTED",
      stage: partial ? "entry_partial" : "entry_fill",
      reason: partial ? "ENTRY_PARTIAL_PROTECTED" : "ENTRY_FILLED_PROTECTED",
      meta: {
        source,
        qty: finalQty,
        entryPrice: metrics.avg,
        postFillRiskAction: finalTrade?.postFillRiskAction || "NONE",
      },
    });

    if (partial) {
      alert("warn", "ENTRY partial fill (protecting filled qty)", {
        tradeId,
        source,
        filledQty: finalQty,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
    } else {
      alert("info", "ENTRY filled", {
        tradeId,
        source,
        avg: metrics.avg,
        expected: metrics.slippageLog.expected,
        filledQty: finalQty,
        slipBps: metrics.slippageLog.rawSlipBps,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
    }

    return {
      ok: true,
      qty: finalQty,
      entryPrice: metrics.avg,
      partial,
    };
  }

  async _recoverAmbiguousEntryState(args) {
    return this._runTradeCommand(
      args?.tradeId,
      EXEC_COMMAND.HANDLE_TIMEOUT,
      async () => this._recoverAmbiguousEntryStateImpl(args),
      { allowMissing: true },
    );
  }

  async _recoverAmbiguousEntryStateImpl({
    tradeId,
    entryOrderId,
    source,
    reason = null,
  }) {
    const recoveryKey = `${String(tradeId || "")}:${String(entryOrderId || "")}`;
    if (!tradeId || !entryOrderId) {
      return { ok: false, reason: "BAD_INPUT" };
    }
    if (this._entryTimeoutRecoveryInFlight.has(recoveryKey)) {
      return { ok: false, reason: "IN_FLIGHT" };
    }

    this._entryTimeoutRecoveryInFlight.add(recoveryKey);
    try {
      const maxMs = Math.max(
        1000,
        Number(env.ENTRY_TIMEOUT_RECOVERY_MS ?? 12000),
      );
      const pollMs = Math.max(
        200,
        Number(env.ENTRY_TIMEOUT_RECOVERY_POLL_MS ?? 500),
      );
      const deadline = Date.now() + maxMs;
      let lastStatus = null;

      while (Date.now() < deadline) {
        const trade = await getTrade(tradeId);
        if (!trade) return { ok: false, reason: "MISSING_TRADE" };
        if (String(trade.entryOrderId || "") !== String(entryOrderId)) {
          return { ok: false, reason: "STALE_ORDER" };
        }

        const info = await this._getOrderStatus(entryOrderId);
        const status = String(info?.status || "").toUpperCase();
        const order = info?.order || {};
        lastStatus = status || lastStatus;
        const filledQty = Number(order?.filled_quantity ?? 0);
        const avgPrice = Number(
          order?.average_price ??
            trade.entryPrice ??
            trade.expectedEntryPrice ??
            trade.candle?.close ??
            0,
        );

        if (status === "COMPLETE") {
          return this._finalizeEntryFill({
            tradeId,
            trade,
            avgPrice,
            filledQty: Number(order?.filled_quantity ?? trade.qty ?? 0),
            source,
            partial: false,
            reason,
          });
        }

        if ((status === "PARTIAL" || status === "OPEN") && filledQty > 0) {
          return this._finalizeEntryFill({
            tradeId,
            trade,
            avgPrice,
            filledQty,
            source,
            partial: true,
            reason,
          });
        }

        if (isDead(status)) {
          const isRejected = status === "REJECTED";
          const msg =
            order?.status_message_raw || order?.status_message || null;
          await this._updateTrade(tradeId, {
            status: isRejected ? STATUS.ENTRY_FAILED : STATUS.ENTRY_CANCELLED,
            closeReason: `ENTRY_${status}${msg ? " | " + String(msg) : ""}`,
            ...this._eventPatch("ENTRY_TIMEOUT_RECOVERED", {
              source,
              status,
            }),
          });
          this._recordTradeDecision({
            trade,
            outcome: "BLOCKED",
            stage: "entry_timeout",
            reason: `ENTRY_${status}`,
            meta: { source, recovered: true },
          });
          await this._finalizeClosed(tradeId, trade.instrument_token);
          return { ok: true, cancelled: true, status };
        }

        if (typeof this.kite.getPositions === "function") {
          try {
            const positions = await this.kite.getPositions();
            const net = positions?.net || positions?.day || [];
            const pos = net.find(
              (x) =>
                Number(x?.instrument_token) ===
                Number(trade.instrument_token),
            );
            const netQty = Number(pos?.quantity ?? pos?.net_quantity ?? 0);
            if (Number.isFinite(netQty) && netQty !== 0) {
              return this._finalizeEntryFill({
                tradeId,
                trade,
                avgPrice,
                filledQty: Math.abs(netQty),
                source,
                partial:
                  Math.abs(netQty) < Number(trade.qty ?? Math.abs(netQty)),
                reason:
                  reason || "ENTRY_TIMEOUT_RECOVERY_POSITION_DETECTED",
              });
            }
          } catch {
            // ignore and keep polling
          }
        }

        await sleep(pollMs);
      }

      const fresh = await getTrade(tradeId);
      if (fresh) {
        await this._updateTrade(tradeId, {
          status: STATUS.GUARD_FAILED,
          closeReason: "ENTRY_TIMEOUT_RECOVERY_UNRESOLVED",
          ...this._eventPatch("ENTRY_TIMEOUT_RECOVERY_UNRESOLVED", {
            source,
            lastStatus,
          }),
        });
        this._recordTradeDecision({
          trade: fresh,
          outcome: "BLOCKED",
          stage: "entry_timeout",
          reason: "ENTRY_TIMEOUT_RECOVERY_UNRESOLVED",
          meta: { source, lastStatus },
        });
        this.risk.setKillSwitch(true);
      }

      return {
        ok: false,
        reason: "ENTRY_TIMEOUT_RECOVERY_UNRESOLVED",
        status: lastStatus,
      };
    } finally {
      this._entryTimeoutRecoveryInFlight.delete(recoveryKey);
    }
  }

  async _evaluateExecutionAdmission({
    signal,
    instrument,
    side,
    plannedEntry,
    signalTsMs,
    chaseStep = 0,
    candidateEntryPrice = undefined,
  }) {
    const signalEventIso = signalTsMs ? new Date(signalTsMs).toISOString() : null;
    const tradeLike = {
      side,
      instrument,
      plannedEntry,
      expectedEntryPrice: plannedEntry,
      signalTs: signalEventIso,
      signalCreatedAt: signal?.signalCreatedAt || null,
      signalDecisionTs: signal?.signalDecisionTs || null,
      signalEventTs: signal?.signalEventTs || signalEventIso,
      entryPipeline: signal?.entryPipeline || null,
      entryPipelineLatency: signal?.entryPipelineLatency || null,
      underlying_token: signal?.underlying_token ?? null,
      underlying_ltp: signal?.underlying_ltp ?? null,
      option_meta: signal?.option_meta ?? null,
    };
    const quote = await this._getBestBidAsk(instrument);
    const underlyingLtp = this._getPendingEntryUnderlyingLtp(tradeLike);
    let optionLiquidity = null;
    if (signal?.option_meta) {
      optionLiquidity = await this._preEntryOptionLiquidityCheck({
        instrument_token:
          instrument?.instrument_token ?? signal?.instrument_token ?? null,
        exchange: instrument?.exchange,
        tradingsymbol: instrument?.tradingsymbol,
      });
    }
    const gate = evaluateExecutionGate({
      signalTs: signalEventIso,
      trade: tradeLike,
      quote,
      underlyingLtp,
      optionLiquidity,
      nowTs: Date.now(),
      env,
      chaseStep,
      candidateEntryPrice,
    });
    return {
      ...gate,
      quote,
      underlyingLtp,
      optionLiquidity,
    };
  }

  _getPendingEntryUnderlyingLtp(trade) {
    const token = Number(trade?.underlying_token ?? 0);
    const cached = Number(this.lastPriceByToken.get(token));
    if (Number.isFinite(cached) && cached > 0) return cached;
    const fallback = Number(
      trade?.underlying_ltp ??
        trade?.planMeta?.underlying?.entry ??
        trade?.option_meta?.underlyingLtp ??
        trade?.optionMeta?.underlyingLtp ??
        0,
    );
    return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
  }

  async _getPendingEntryMarketState(trade) {
    let quote = null;
    try {
      quote = await this._getBestBidAsk(trade?.instrument);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
    return {
      quote,
      underlyingLtp: this._getPendingEntryUnderlyingLtp(trade),
    };
  }

  async _cancelOpenEntryOrder({
    tradeId,
    entryOrderId,
    reason,
    purpose = "ENTRY_CANCEL",
  }) {
    const tradeKey = `${String(tradeId || "")}:${String(entryOrderId || "")}`;
    if (!tradeKey || tradeKey === ":")
      return { ok: false, done: true, reason: "BAD_INPUT" };
    if (this._entryPendingCancelInFlight.has(tradeKey)) {
      return { ok: false, done: true, reason: "IN_FLIGHT" };
    }

    this._entryPendingCancelInFlight.add(tradeKey);
    try {
      const trade = await getTrade(tradeId);
      if (!trade) return { ok: false, done: true, reason: "MISSING_TRADE" };
      if (String(trade.entryOrderId || "") !== String(entryOrderId)) {
        return { ok: false, done: true, reason: "STALE_ORDER" };
      }
      if (
        [
          STATUS.LIVE,
          STATUS.SL_PLACED,
          STATUS.SL_OPEN,
          STATUS.SL_CONFIRMED,
          STATUS.ENTRY_FILLED,
          STATUS.EXITED_TARGET,
          STATUS.EXITED_SL,
          STATUS.ENTRY_FAILED,
          STATUS.ENTRY_CANCELLED,
          STATUS.CLOSED,
          STATUS.GUARD_FAILED,
        ].includes(trade.status)
      ) {
        return { ok: false, done: true, reason: "TERMINAL" };
      }

      this._clearEntryLimitFallbackTimer(tradeId);

      let cancelErr = null;
      try {
        this.expectedCancelOrderIds.add(String(entryOrderId));
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY || "regular",
          entryOrderId,
          { purpose, tradeId },
        );
        } catch (e) {
        cancelErr = e;
        logger.warn(
          { tradeId, entryOrderId, purpose, e: e?.message || String(e) },
          "[entry_cancel] cancel attempt failed; verifying status",
        );
      }

      const late = await this._checkLateFillAfterCancel(entryOrderId);
      const lateStatus = String(late?.status || "").toUpperCase();
      const lateOrder = late?.order || {};
      const filledQty = Number(lateOrder.filled_quantity ?? 0);
      const avgPx = Number(
        lateOrder.average_price ??
          trade.entryPrice ??
          trade.expectedEntryPrice ??
          trade.candle?.close ??
          0,
      );

      if (lateStatus === "COMPLETE") {
        const qty = Number(lateOrder.filled_quantity ?? trade.qty ?? 0);
        await this._finalizeEntryFill({
          tradeId,
          trade,
          avgPrice: avgPx > 0 ? avgPx : trade.entryPrice,
          filledQty: qty,
          source: purpose,
          partial: false,
          reason: reason || null,
        });
        return { ok: true, done: true, filled: true };
      }

      if (filledQty > 0) {
        await this._finalizeEntryFill({
          tradeId,
          trade,
          avgPrice: avgPx > 0 ? avgPx : trade.entryPrice,
          filledQty,
          source: purpose,
          partial: true,
          reason: reason || null,
        });
        return { ok: true, done: true, partial: true };
      }

      if (
        cancelErr &&
        (!lateStatus ||
          lateStatus === "OPEN" ||
          lateStatus === "TRIGGER PENDING")
      ) {
        const recovery = await this._recoverAmbiguousEntryState({
          tradeId,
          entryOrderId,
          source: purpose,
          reason: reason || "CANCEL_NOT_CONFIRMED",
        });
        return {
          ok: Boolean(recovery?.ok),
          done: false,
          reason: recovery?.reason || "CANCEL_NOT_CONFIRMED",
          error: cancelErr,
          recovery,
        };
      }

      if (lateStatus === "REJECTED") {
        const msg =
          lateOrder.status_message_raw || lateOrder.status_message || null;
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_FAILED,
          closeReason: `ENTRY_REJECTED${msg ? " | " + String(msg) : ""}`,
          entryPendingLastReason: reason || null,
          entryPendingLastCheckAt: new Date(),
        });
      } else {
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_CANCELLED,
          closeReason: reason || "ENTRY_CANCELLED",
          entryPendingLastReason: reason || null,
          entryPendingLastCheckAt: new Date(),
        });
      }
      await this._finalizeClosed(tradeId, trade.instrument_token);
      return { ok: true, done: true, cancelled: true };
    } finally {
      this._entryPendingCancelInFlight.delete(tradeKey);
    }
  }

  _buildEntryLadderPrices({ side, basePrice, tick, steps = undefined }) {
    const stepCount = Math.max(0, Number(steps ?? env.ENTRY_LADDER_TICKS ?? 2));
    const dir = String(side || "BUY").toUpperCase() === "BUY" ? 1 : -1;
    const out = [];
    for (let i = 0; i <= stepCount; i++) {
      out.push(
        roundToTick(
          Number(basePrice) + dir * i * tick,
          tick,
          dir > 0 ? "up" : "down",
        ),
      );
    }
    return Array.from(new Set(out.filter((n) => Number.isFinite(n) && n > 0)));
  }

  async _startEntryLadder({
    tradeId,
    entryOrderId,
    instrument,
    side,
    basePrice,
  }) {
    if (!Boolean(env.ENTRY_LADDER_ENABLED ?? true)) return;
    const tick = Number(instrument?.tick_size ?? 0.05);
    const seedTrade = await getTrade(tradeId);
    const profile = this._entryUrgencyProfile(
      seedTrade || { instrument, side },
    );
    const delayMs = Math.max(
      100,
      Number(profile?.stepDelayMs ?? env.ENTRY_LADDER_STEP_DELAY_MS ?? 350),
    );
    const ladder = this._buildEntryLadderPrices({
      side,
      basePrice,
      tick,
      steps: profile?.ladderSteps,
    });
    if (ladder.length <= 1) return;

    const startPx = Number(ladder[0]);
    const maxChaseBps = Math.max(
      0,
      Number(profile?.maxChaseBps ?? env.ENTRY_LADDER_MAX_CHASE_BPS ?? 35),
    );

    for (let i = 1; i < ladder.length; i++) {
      await sleep(delayMs);
      const fresh = await getTrade(tradeId);
      if (!fresh) return;
      if (String(fresh.status || "").toUpperCase() !== STATUS.ENTRY_OPEN)
        return;

      const st = await this._getOrderStatus(entryOrderId);
      const os = String(st?.status || "").toUpperCase();
      if (os !== "OPEN") return;

      const currentOrderPrice = Number(
        st?.order?.price ?? fresh.expectedEntryPrice ?? startPx,
      );
      const marketState =
        String(env.ENTRY_LADDER_USE_LIVE_QUOTE ?? "true") === "true"
          ? await this._getPendingEntryMarketState(fresh)
          : {
              quote: null,
              underlyingLtp: this._getPendingEntryUnderlyingLtp(fresh),
            };
      const pending = evaluatePendingEntryState({
        trade: fresh,
        quote: marketState.quote,
        underlyingLtp: marketState.underlyingLtp,
        nowTs: Date.now(),
        env,
        profile,
        currentOrderPrice,
      });

      if (
        !pending.ok &&
        String(env.ENTRY_PENDING_CANCEL_ON_EDGE_DECAY ?? "true") === "true"
      ) {
        await this._updateTrade(tradeId, {
          entryPendingLastReason: pending.cancelReason,
          entryPendingLastCheckAt: new Date(),
          executionGateReason: pending.cancelReason,
        });
        await this._cancelOpenEntryOrder({
          tradeId,
          entryOrderId,
          reason: pending.cancelReason,
          purpose: "ENTRY_EDGE_DECAY",
        });
        return;
      }

      const nextPx = Number(pending.targetPrice ?? ladder[i]);
      const driftBps =
        Number.isFinite(startPx) && startPx > 0
          ? (Math.abs(nextPx - startPx) / startPx) * 10000
          : 0;
      if (driftBps > maxChaseBps) {
        const reasonCode = "EXEC_ENTRY_DEVIATION_EXCEEDED";
        logger.warn(
          { tradeId, nextPx, startPx, driftBps, maxChaseBps, reasonCode },
          "[entry_ladder] stopped (max chase)",
        );
        await this._updateTrade(tradeId, {
          entryPendingLastReason: reasonCode,
          entryPendingLastCheckAt: new Date(),
          executionGateReason: reasonCode,
          entryDriftPct: driftBps / 100,
          spreadBpsAtExecution: pending.spreadBps ?? null,
        });
        await this._cancelOpenEntryOrder({
          tradeId,
          entryOrderId,
          reason: reasonCode,
          purpose: "ENTRY_EXEC_GATE",
        });
        return;
      }
      if (
        Number.isFinite(currentOrderPrice) &&
        ((String(side || "BUY").toUpperCase() === "BUY" &&
          nextPx <= currentOrderPrice) ||
          (String(side || "BUY").toUpperCase() === "SELL" &&
            nextPx >= currentOrderPrice))
      ) {
        continue;
      }

      const executionGate = await this._evaluateExecutionAdmission({
        signal: fresh,
        instrument: fresh.instrument,
        side,
        plannedEntry: Number(fresh.plannedEntry ?? startPx),
        signalTsMs:
          Date.parse(fresh.signalEventTs || "") ||
          Date.parse(fresh.signalTs || "") ||
          Date.parse(fresh.decisionAt || "") ||
          Date.parse(fresh.createdAt || "") ||
          Date.now(),
        chaseStep: Math.max(0, Number(fresh.entryRepriceCount ?? 0)) + 1,
        candidateEntryPrice: nextPx,
      });
      if (!executionGate.ok) {
        await this._updateTrade(tradeId, {
          entryPendingLastReason: executionGate.reasonCode,
          entryPendingLastCheckAt: new Date(),
          executionGateReason: executionGate.reasonCode,
          freshnessAccepted: Boolean(executionGate.freshnessAccepted),
          signalAgeMs: executionGate.signalAgeMs,
          spreadBpsAtExecution: executionGate.spreadBps,
          entryDriftPct: Number(executionGate.premiumDriftPct ?? 0),
        });
        await this._cancelOpenEntryOrder({
          tradeId,
          entryOrderId,
          reason: executionGate.reasonCode,
          purpose: "ENTRY_EXEC_GATE",
        });
        return;
      }

      try {
        await this._safeModifyOrder(
          env.DEFAULT_ORDER_VARIETY,
          entryOrderId,
          { price: nextPx },
          { purpose: "ENTRY_LADDER", tradeId },
        );
        await this._updateTrade(tradeId, {
          expectedEntryPrice: nextPx,
          entryRepriceCount:
            Math.max(0, Number(fresh.entryRepriceCount ?? 0)) + 1,
          entryPendingLastReason: pending.cancelReason || null,
          entryPendingLastCheckAt: new Date(),
          executionTs: new Date(),
          signalAgeMs: executionGate.signalAgeMs,
          freshnessAccepted: Boolean(executionGate.freshnessAccepted),
          executionGateReason: executionGate.reasonCode,
          spreadBpsAtExecution: executionGate.spreadBps,
          entryDriftPct: Number(executionGate.premiumDriftPct ?? 0),
          ...this._eventPatch("ENTRY_LADDER_STEP", {
            tradeId,
            price: nextPx,
            step: i,
            urgency: profile?.profileKey || "DEFAULT",
            spreadBps: pending.spreadBps,
            adverseDriftBps: pending.adverseDriftBps,
          }),
        });
      } catch (e) {
        logger.warn(
          { tradeId, entryOrderId, price: nextPx, e: e?.message || String(e) },
          "[entry_ladder] modify failed",
        );
        return;
      }
    }
  }

  _parseQuoteTimeMs(q) {
    const cands = [q?.timestamp, q?.last_trade_time, q?.exchange_timestamp];
    for (const v of cands) {
      if (!v) continue;
      const ms = new Date(v).getTime();
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return null;
  }

  async _preEntryOptionLiquidityCheck(contract) {
    const token = Number(contract?.instrument_token);
    if (!(token > 0)) return { ok: false, reason: "INVALID_TOKEN" };
    if (typeof this.kite.getQuote !== "function") {
      return { ok: false, reason: "NO_GETQUOTE_FN" };
    }

    const ex = String(contract?.exchange || "NFO").toUpperCase();
    const sym = String(contract?.tradingsymbol || "");
    if (!sym) return { ok: false, reason: "INVALID_SYMBOL" };

    const key = `${ex}:${sym.toUpperCase()}`;

    try {
      const resp = await this.kite.getQuote([key]);
      const q = resp?.[key];
      const minHealth = Number(env.OPT_HEALTH_SCORE_MIN ?? 45);
      const bid = Number(q?.depth?.buy?.[0]?.price);
      const ask = Number(q?.depth?.sell?.[0]?.price);
      const bidQty = Number(q?.depth?.buy?.[0]?.quantity ?? 0);
      const askQty = Number(q?.depth?.sell?.[0]?.quantity ?? 0);
      const ltp = Number(q?.last_price);

      if (
        !(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid)
      ) {
        return { ok: false, reason: "NO_DEPTH", meta: { bid, ask, ltp } };
      }

      const mid = (bid + ask) / 2;
      const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10000 : Number.NaN;
      const spreadPenalty = Number.isFinite(spreadBps)
        ? Math.min(35, Math.max(0, spreadBps / 2))
        : 35;
      const depthScore = Math.min(
        25,
        Math.log(Math.max(1, bidQty + askQty)) * 3,
      );
      const healthScore = Math.max(
        0,
        Math.min(100, 55 + depthScore - spreadPenalty),
      );
      if (Number.isFinite(minHealth) && healthScore < minHealth) {
        return {
          ok: false,
          reason: "HEALTH_SCORE_LOW",
          meta: { healthScore, minHealth, spreadBps, bidQty, askQty },
        };
      }
      const maxSpreadBps = Number(env.OPT_MAX_SPREAD_BPS ?? 35);
      if (!(Number.isFinite(spreadBps) && spreadBps <= maxSpreadBps)) {
        return {
          ok: false,
          reason: "SPREAD_TOO_WIDE",
          meta: { spreadBps, maxSpreadBps, bid, ask, ltp },
        };
      }

      const minDepthQty = Number(env.OPT_MIN_DEPTH_QTY ?? 0);
      if (minDepthQty > 0) {
        const topDepth = Math.min(
          Number.isFinite(bidQty) ? bidQty : 0,
          Number.isFinite(askQty) ? askQty : 0,
        );
        if (topDepth < minDepthQty) {
          return {
            ok: false,
            reason: "DEPTH_TOO_LOW",
            meta: { topDepth, minDepthQty, bidQty, askQty },
          };
        }
      }

      const quoteTsMs = this._parseQuoteTimeMs(q);
      const freshnessMaxMs = Number(env.STALE_TICK_MS ?? 3000);
      const ageMs = quoteTsMs
        ? Date.now() - quoteTsMs
        : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(ageMs) || ageMs > freshnessMaxMs) {
        return {
          ok: false,
          reason: "STALE_QUOTE",
          meta: { ageMs, freshnessMaxMs, quoteTsMs: quoteTsMs || null },
        };
      }

      return {
        ok: true,
        meta: {
          spreadBps,
          bid,
          ask,
          ltp,
          quoteTsMs,
          bidQty,
          askQty,
          healthScore,
        },
      };
    } catch (e) {
      return {
        ok: false,
        reason: "QUOTE_ERROR",
        meta: { message: e?.message || String(e) },
      };
    }
  }

  async _targetWatchdogFire(tradeId, cause = "timeout") {
    if (this._stopped) return;
    const id = String(tradeId || "");
    if (!id) return;
    if (this._targetWatchdogInFlight.has(id)) return;
    this._targetWatchdogInFlight.add(id);

    try {
      if (!this._isTargetWatchdogEnabled()) return;
      const st = this._targetWatch.get(id);
      if (!st) return;

      const fresh = await getTrade(id);
      if (!fresh) return;

      const terminal = [
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,
        STATUS.CLOSED,
      ];
      if (terminal.includes(fresh.status)) {
        this._clearTargetWatch(id);
        return;
      }

      const targetOrderId = fresh?.targetOrderId
        ? String(fresh.targetOrderId)
        : null;
      if (!targetOrderId) {
        this._clearTargetWatch(id);
        return;
      }

      const statusInfo = await this._getOrderStatus(targetOrderId);
      const order = statusInfo?.order || {};
      const stt = String(statusInfo?.status || "").toUpperCase();

      if (stt === "COMPLETE" || isDead(stt)) {
        this._clearTargetWatch(id);
        return;
      }

      const requireTouch =
        String(env.TARGET_WATCHDOG_REQUIRE_LTP_TOUCH || "true") !== "false";
      const breached =
        !requireTouch ||
        this._targetWatchIsHit(st.lastLtp, st.targetPrice, st.exitSide);

      if (!breached) {
        logger.warn(
          { tradeId: id, cause, lastLtp: st.lastLtp, target: st.targetPrice },
          "[target_watchdog] fired but touch not confirmed -> reset",
        );
        st.triggeredAtMs = 0;
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        this._targetWatch.set(id, st);
        return;
      }

      const retryCount = Number(st.retryCount ?? 0);
      const maxRetries = Math.max(
        0,
        Number(env.TARGET_WATCHDOG_MODIFY_RETRIES ?? 2),
      );
      const tick = Number(fresh.instrument?.tick_size ?? 0.05);

      if (retryCount >= maxRetries) {
        logger.warn(
          { tradeId: id, targetOrderId, stt, retryCount, cause },
          "[target_watchdog] retries exhausted -> cancel & MARKET exit",
        );

        alert("warn", "⚠️ Target watchdog: MARKET exit (retries exhausted)", {
          tradeId: id,
          targetOrderId,
          retryCount,
          cause,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );

        const filledQty = Number(order?.filled_quantity ?? 0);
        const totalQty = Number(order?.quantity ?? fresh.qty ?? 0);
        const remainingQty = Math.max(0, totalQty - filledQty);

        if (remainingQty < 1) {
          this._clearTargetWatch(id);
          return;
        }

        try {
          this.expectedCancelOrderIds.add(String(targetOrderId));
          await this._safeCancelOrder(
            env.DEFAULT_ORDER_VARIETY,
            targetOrderId,
            {
              purpose: "TARGET_WATCHDOG_CANCEL",
              tradeId: id,
            },
          );
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }

        const after = await this._getOrderStatus(targetOrderId);
        const afterStatus = String(after?.status || "").toUpperCase();
        if (afterStatus === "COMPLETE") {
          this._clearTargetWatch(id);
          return;
        }

        try {
          if (fresh.slOrderId) {
            this.expectedCancelOrderIds.add(String(fresh.slOrderId));
            await this._safeCancelOrder(
              env.DEFAULT_ORDER_VARIETY,
              fresh.slOrderId,
              {
                purpose: "TARGET_WATCHDOG_CANCEL_SL",
                tradeId: id,
              },
            );
          }
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }

        const out = await this._safePlaceOrder(
          env.DEFAULT_ORDER_VARIETY,
          {
            exchange: fresh.instrument.exchange,
            tradingsymbol: fresh.instrument.tradingsymbol,
            transaction_type: st.exitSide,
            quantity: remainingQty,
            product: env.DEFAULT_PRODUCT,
            order_type: "MARKET",
            validity: "DAY",
            tag: makeTag(id, "TARGET"),
          },
          { purpose: "TARGET_WATCHDOG_MARKET", tradeId: id },
        );

        const newOrderId = out.orderId;
        await this._updateTrade(id, {
          targetOrderId: newOrderId,
          targetOrderType: "MARKET",
          targetWatchdogConvertedAt: new Date(),
          targetWatchdogRetryCount: retryCount,
          targetWatchdogCause: String(cause || "timeout"),
        });
        await linkOrder({
          order_id: String(newOrderId),
          tradeId: id,
          role: "TARGET",
        });
        await this._replayOrphanUpdates(newOrderId);
        this._watchExitLeg(id, newOrderId, "TARGET").catch((err) => {
          reportFault({
            code: "TRADING_TRADEMANAGER_ASYNC",
            err,
            message: "[src/trading/tradeManager.js] async task failed",
          });
        });
        this._clearTargetWatch(id);
        return;
      }

      const quote = await this._getBestBidAsk(fresh.instrument);
      const bid = Number(quote?.bid);
      const ask = Number(quote?.ask);
      const ltp = Number(quote?.ltp ?? st.lastLtp ?? 0);

      let price = null;
      if (st.exitSide === "SELL") {
        const base = Number.isFinite(bid) ? bid : ltp;
        if (Number.isFinite(base)) price = base - tick;
        if (Number.isFinite(price)) {
          price = roundToTick(price, tick, "down");
        }
      } else {
        const base = Number.isFinite(ask) ? ask : ltp;
        if (Number.isFinite(base)) price = base + tick;
        if (Number.isFinite(price)) {
          price = roundToTick(price, tick, "up");
        }
      }

      if (!Number.isFinite(price) || price <= 0) {
        st.retryCount = retryCount + 1;
        this._targetWatch.set(id, st);
        logger.warn(
          { tradeId: id, targetOrderId, retryCount, cause },
          "[target_watchdog] unable to compute marketable price -> retry later",
        );
        const openSec = Number(env.TARGET_WATCHDOG_RETRY_SEC ?? 1);
        st.triggeredAtMs = Date.now();
        this._armTargetWatchTimer(id, st, openSec);
        return;
      }

      await this._safeModifyOrder(
        env.DEFAULT_ORDER_VARIETY,
        targetOrderId,
        { price },
        { purpose: "TARGET_WATCHDOG_CHASE", tradeId: id },
      );

      st.retryCount = retryCount + 1;
      st.lastActionAtMs = Date.now();
      this._targetWatch.set(id, st);

      await this._updateTrade(id, {
        targetWatchdogLastPrice: price,
        targetWatchdogRetryCount: st.retryCount,
        targetWatchdogLastAt: new Date(st.lastActionAtMs),
        targetWatchdogCause: String(cause || "timeout"),
      });

      logger.warn(
        { tradeId: id, targetOrderId, price, retryCount: st.retryCount, cause },
        "[target_watchdog] target touched -> aggressive modify",
      );

      const retrySec = Number(env.TARGET_WATCHDOG_RETRY_SEC ?? 1);
      st.triggeredAtMs = Date.now();
      this._armTargetWatchTimer(id, st, retrySec);
    } catch (e) {
      logger.error(
        { tradeId: String(tradeId || ""), e: e?.message || String(e) },
        "[target_watchdog] error",
      );
    } finally {
      this._targetWatchdogInFlight.delete(id);
    }
  }

  _registerVirtualTargetFromTrade(trade) {
    try {
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;

      const token = Number(trade?.instrument_token);
      const targetPrice =
        Number(trade?.targetPrice) || this._computeTargetPrice(trade);
      if (!Number.isFinite(token) || !Number.isFinite(targetPrice)) return;

      const side = String(trade?.side || "BUY").toUpperCase();
      const exitSide = side === "BUY" ? "SELL" : "BUY";

      const existing = this._virtualTargetWatch.get(tradeId) || {};
      this._virtualTargetWatch.set(tradeId, {
        ...existing,
        tradeId,
        token,
        side,
        exitSide,
        targetPrice,
        armedAtMs: existing.armedAtMs || Date.now(),
        firedAtMs: existing.firedAtMs || 0,
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _clearVirtualTarget(tradeId) {
    try {
      this._virtualTargetWatch.delete(String(tradeId || ""));
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  _maybeTriggerVirtualTargetFromTick(token, ltp, nowMs) {
    if (!this._virtualTargetWatch.size) return;
    const tok = Number(token);
    if (!Number.isFinite(tok)) return;

    for (const [tradeId, st] of this._virtualTargetWatch.entries()) {
      if (!st || st.firedAtMs) continue;
      if (Number(st.token) !== tok) continue;
      if (!this._virtualTargetIsHit(ltp, st.targetPrice, st.exitSide)) continue;

      st.firedAtMs = Number(nowMs ?? Date.now());
      this._virtualTargetWatch.set(tradeId, st);
      this._fireVirtualTarget(tradeId, st, ltp).catch((e) => {
        logger.error({ tradeId, e: e.message }, "[virtual_target] fire failed");
      });
    }
  }

  async _virtualTargetHeartbeat(trade, netQty, source = "reconcile") {
    try {
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;
      if (!trade?.targetVirtual || trade?.targetOrderId) return;

      if (!Number.isFinite(Number(netQty)) || Number(netQty) === 0) {
        this._clearVirtualTarget(tradeId);
        return;
      }

      const token = Number(trade?.instrument_token);
      if (!Number.isFinite(token)) return;

      this._registerVirtualTargetFromTrade(trade);

      const allowFetch =
        String(env.VIRTUAL_TARGET_LTP_FETCH_ENABLED || "true") === "true";
      if (!allowFetch) return;

      if (this._virtualTargetFetchInFlight.has(tradeId)) return;
      this._virtualTargetFetchInFlight.add(tradeId);

      try {
        const now = Date.now();
        const throttleMs = Math.max(
          500,
          Number(env.VIRTUAL_TARGET_LTP_FETCH_THROTTLE_MS ?? 1500),
        );
        const last = Number(this._lastLtpFetchAtByToken.get(token) ?? 0);
        if (now - last < throttleMs) return;
        this._lastLtpFetchAtByToken.set(token, now);

        const instrument =
          trade?.instrument || (await ensureInstrument(this.kite, token));
        const ltp = await this._getLtp(token, instrument);
        if (!Number.isFinite(ltp)) return;

        this._maybeTriggerVirtualTargetFromTick(token, ltp, now);
      } finally {
        this._virtualTargetFetchInFlight.delete(tradeId);
      }
    } catch (e) {
      logger.warn(
        { tradeId: trade?.tradeId, e: e.message, source },
        "[virtual_target] heartbeat failed",
      );
    }
  }

  async _fireVirtualTarget(tradeId, st, ltp) {
    const fresh = (await getTrade(tradeId)) || null;
    if (!fresh) return;

    if (
      [
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,
        STATUS.GUARD_FAILED,
        STATUS.CLOSED,
      ].includes(fresh.status)
    ) {
      return;
    }

    if (fresh?.targetOrderId) return;

    const qty = Number(fresh.qty ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) return;

    logger.warn(
      { tradeId, targetPrice: st.targetPrice, ltp },
      "[virtual_target] target hit -> placing MARKET exit",
    );
    alert("info", "🎯 Virtual target hit -> MARKET exit", {
      tradeId,
      targetPrice: st.targetPrice,
      ltp,
    }).catch((err) =>
      reportWindowedFault({
        code: "ALERT_SEND_FAILED",
        windowKey: "alert_send_failed",
        err,
        message: "[alert] failed to dispatch notification",
        meta: { context: "trade_manager" },
      }),
    );

    try {
      // Cancel SL to avoid margin blocks from overlapping exit orders
      if (fresh.slOrderId) {
        try {
          this.expectedCancelOrderIds.add(String(fresh.slOrderId));
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY,
          fresh.slOrderId,
          { purpose: "VIRTUAL_TARGET_CANCEL_SL", tradeId },
        );
      }
    } catch (e) {
      logger.warn(
        { tradeId, e: e.message },
        "[virtual_target] cancel SL failed",
      );
    }

    try {
      const out = await this._safePlaceOrder(
        env.DEFAULT_ORDER_VARIETY,
        {
          exchange: fresh.instrument.exchange,
          tradingsymbol: fresh.instrument.tradingsymbol,
          transaction_type: st.exitSide,
          quantity: qty,
          product: env.DEFAULT_PRODUCT,
          order_type: "MARKET",
          validity: "DAY",
          tag: makeTag(tradeId, "TARGET"),
        },
        { purpose: "VIRTUAL_TARGET", tradeId },
      );
      const targetOrderId = out.orderId;
      await this._updateTrade(tradeId, {
        targetOrderId,
        targetPrice: st.targetPrice,
        targetVirtual: true,
        exitPlacedAt: new Date(),
        targetVirtualFiredAt: new Date(),
        status: STATUS.LIVE,
      });
      await linkOrder({
        order_id: String(targetOrderId),
        tradeId,
        role: "TARGET",
      });
      await this._replayOrphanUpdates(targetOrderId);
      this._watchExitLeg(tradeId, targetOrderId, "TARGET").catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });
      this._clearVirtualTarget(tradeId);
    } catch (e) {
      const msg = String(e?.message || e);
      logger.error(
        { tradeId, e: msg },
        "[virtual_target] MARKET exit failed; panic exit fallback",
      );
      await this._updateTrade(tradeId, {
        targetVirtualError: msg,
        targetVirtualFailedAt: new Date(),
      });
      await this._panicExit(fresh, "VIRTUAL_TARGET_EXIT_FAILED", {
        allowWhenHalted: true,
      });
    }
  }

  async _enableVirtualTarget(trade, { reason, source } = {}) {
    const tradeId = String(trade?.tradeId || "");
    if (!tradeId) return;

    const targetPrice =
      Number(trade?.targetPrice) || this._computeTargetPrice(trade);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;

    await this._updateTrade(tradeId, {
      targetVirtual: true,
      targetPrice,
      targetVirtualReason: reason || null,
      targetVirtualSource: source || null,
      targetVirtualAt: new Date(),
    });
    this._registerVirtualTargetFromTrade({ ...trade, targetPrice });
    alert("warn", "⚠️ Target order blocked by margin; using virtual target", {
      tradeId,
      targetPrice,
      reason,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
  }

  _slWatchdogHeartbeat(trade, netQty, source = "reconcile") {
    try {
      if (!this._isSlWatchdogEnabled()) return;
      const tradeId = String(trade?.tradeId || "");
      if (!tradeId) return;

      // Only for active positions
      if (!Number.isFinite(Number(netQty)) || Number(netQty) === 0) {
        this._clearSlWatch(tradeId);
        return;
      }

      this._registerSlWatchFromTrade(trade);
      const st = this._slWatch.get(tradeId);
      if (!st) return;

      const openSec = Number(env.SL_WATCHDOG_OPEN_SEC ?? 8);
      const nowMs = Date.now();
      const slStatus = String(trade?.slOrderStatus || "").toUpperCase();

      if (
        !st.triggeredAtMs &&
        (slStatus === "OPEN" || slStatus === "TRIGGERED")
      ) {
        this._armSlWatchTriggered(tradeId, nowMs, `heartbeat_${source}_status`);
        return;
      }

      // If already triggered and overdue, fire immediately (handles restarts / missed timers)
      if (st.triggeredAtMs && !st.firedAtMs) {
        const overdue = nowMs - Number(st.triggeredAtMs) >= openSec * 1000;
        if (overdue) {
          this._slWatchdogFire(tradeId, `heartbeat_${source}`).catch((err) => {
            reportFault({
              code: "TRADING_TRADEMANAGER_ASYNC",
              err,
              message: "[src/trading/tradeManager.js] async task failed",
            });
          });
          return;
        }
      }

      // If not triggered, try using latest tick LTP we have
      const ltp = this.lastPriceByToken.get(Number(st.token));
      if (!Number.isFinite(Number(ltp))) return;

      this._maybeTriggerSlWatchFromTick(st.token, ltp, nowMs);
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
  }

  async _getOrderStatus(orderId) {
    const oid = String(orderId || "");
    if (!oid) return null;

    // 1) Try getOrderHistory(orderId) — best for a single order
    try {
      const hist = await this.kite.getOrderHistory(oid);
      const last = Array.isArray(hist) ? hist[hist.length - 1] : null;
      const st = String(last?.status || "").toUpperCase();
      return { status: st, order: last };
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // 2) Fallback to getOrders() and find by order_id
    try {
      const orders = await this.kite.getOrders();
      const o = Array.isArray(orders)
        ? orders.find((x) => String(x?.order_id) === oid)
        : null;
      const st = String(o?.status || "").toUpperCase();
      return { status: st, order: o };
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    return null;
  }

  async _checkLateFillAfterCancel(orderId) {
    const oid = String(orderId || "");
    if (!oid) return null;

    const attempts = Math.max(
      1,
      Number(env.ENTRY_TIMEOUT_LATE_FILL_ATTEMPTS ?? 2),
    );
    const delayMs = Math.max(
      0,
      Number(env.ENTRY_TIMEOUT_LATE_FILL_DELAY_MS ?? 400),
    );

    let latest = null;

    for (let i = 0; i < attempts; i += 1) {
      latest = await this._getOrderStatus(oid);
      const status = String(latest?.status || "").toUpperCase();
      if (status === "COMPLETE" || isDead(status)) return latest;
      if (i < attempts - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return latest;
  }

  _getKnownOrderStatus(orderId) {
    const oid = String(orderId || "");
    if (!oid) return { status: "", order: null };
    const known = this._lastOrdersById.get(oid);
    const st = String(known?.status || "").toUpperCase();
    return { status: st, order: known || null };
  }

  _isCancelProcessingError(e) {
    const msg = String(e?.message || e || "").toLowerCase();
    return (
      msg.includes("cannot be cancelled") &&
      (msg.includes("being processed") || msg.includes("try later"))
    );
  }

  async _isFlatStateLikelyExitInProgress(trade, byId = null) {
    const graceMs = Math.max(
      0,
      Number(env.OCO_FLAT_GRACE_MS ?? env.OCO_POSITION_FLAT_GRACE_MS ?? 3000),
    );
    const now = Date.now();
    const inGraceByTimestamp =
      graceMs > 0 &&
      [
        trade?.slOrderStatusUpdatedAt,
        trade?.targetOrderStatusUpdatedAt,
        trade?.panicExitAt,
        trade?.updatedAt,
      ]
        .map((x) => (x ? new Date(x).getTime() : 0))
        .some((ts) => Number.isFinite(ts) && now - ts <= graceMs);

    const exitOrderIds = [
      trade?.slOrderId,
      trade?.targetOrderId,
      trade?.tp1OrderId,
      trade?.panicExitOrderId,
    ]
      .map((x) => String(x || ""))
      .filter(Boolean);

    const inFlightStatuses = new Set([
      "OPEN",
      "TRIGGER PENDING",
      "TRIGGERED",
      "PARTIAL",
      "MODIFY PENDING",
      "CANCEL PENDING",
      "PUT ORDER REQ RECEIVED",
      "VALIDATION PENDING",
    ]);

    for (const oid of exitOrderIds) {
      const known = (byId && byId.get(oid)) || this._lastOrdersById.get(oid);
      const knownSt = String(known?.status || "").toUpperCase();
      if (knownSt === "COMPLETE")
        return { benign: true, reason: "exit_complete" };
      if (inGraceByTimestamp && inFlightStatuses.has(knownSt)) {
        return { benign: true, reason: `in_grace_${knownSt}` };
      }
    }

    for (const oid of exitOrderIds) {
      try {
        const latest = await this._getOrderStatus(oid);
        const st = String(latest?.status || "").toUpperCase();
        if (st === "COMPLETE")
          return { benign: true, reason: `history_complete_${oid}` };
        if (inGraceByTimestamp && inFlightStatuses.has(st)) {
          return { benign: true, reason: `history_in_grace_${st}` };
        }
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    }

    return {
      benign: false,
      reason: inGraceByTimestamp ? "grace_elapsed" : "no_exit_signal",
    };
  }

  _clearPanicExitWatch(tradeId) {
    const id = String(tradeId || "");
    if (!id) return;
    const timer = this._panicExitTimers.get(id);
    if (timer) clearTimeout(timer);
    this._panicExitTimers.delete(id);
  }

  _clearStopLossSlaTimer(tradeId) {
    const id = String(tradeId || "");
    if (!id) return;
    const timer = this._slSafetyTimers.get(id);
    if (timer) clearTimeout(timer);
    this._slSafetyTimers.delete(id);
  }

  _clearTimeStopFallback(tradeId) {
    const id = String(tradeId || "");
    if (!id) return;
    const timer = this._timeStopFallbackTimers.get(id);
    if (timer) clearTimeout(timer);
    this._timeStopFallbackTimers.delete(id);
  }

  _scheduleTimeStopPanicFallback({ tradeId, reason }) {
    const id = String(tradeId || "");
    if (!id) return;
    if (this._stopped) return;

    const timeoutMs = Math.max(
      1000,
      Number(env.PANIC_EXIT_FILL_TIMEOUT_MS ?? 2500),
    );
    this._clearTimeStopFallback(id);

    const timer = setTimeout(() => {
      this._timeStopPanicFallback({ tradeId: id, reason }).catch((e) => {
        logger.error(
          { tradeId: id, err: e?.message || String(e) },
          "[time_stop] panic fallback failed",
        );
      });
    }, timeoutMs);
    timer.unref?.();
    this._timeStopFallbackTimers.set(id, timer);
  }

  async _timeStopPanicFallback({ tradeId, reason }) {
    if (this._stopped) return;
    const id = String(tradeId || "");
    if (!id) return;

    const fresh = await getTrade(id);
    if (!fresh) {
      this._clearTimeStopFallback(id);
      return;
    }

    const terminal = new Set([
      STATUS.EXITED_TARGET,
      STATUS.EXITED_SL,
      STATUS.ENTRY_FAILED,
      STATUS.ENTRY_CANCELLED,
      STATUS.CLOSED,
    ]);
    if (terminal.has(fresh.status)) {
      this._clearTimeStopFallback(id);
      return;
    }

    let hasPosition = false;
    try {
      const token = Number(fresh.instrument_token);
      const positions = await this.kite.getPositions();
      const net = positions?.net || positions?.day || [];
      const p = Array.isArray(net)
        ? net.find((x) => Number(x.instrument_token) === token)
        : null;
      const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
      hasPosition = Number.isFinite(q) && q !== 0;
    } catch {
      hasPosition = true;
    }

    if (!hasPosition) {
      this._clearTimeStopFallback(id);
      return;
    }

    logger.warn(
      { tradeId: id, reason },
      "[time_stop] smart LIMIT pending; escalating to panic",
    );
    await this._panicExit(fresh, `${reason || "TIME_STOP"}_PANIC_FALLBACK`, {
      timeStop: true,
      force: true,
      preferLimit: false,
    });
    this._clearTimeStopFallback(id);
  }

  async _timeStopExit(trade, reason) {
    const policy = String(env.TIME_STOP_EXIT_POLICY || "SMART").toUpperCase();
    if (policy === "PANIC") {
      await this._panicExit(trade, reason, {
        timeStop: true,
        preferLimit: true,
      });
      return;
    }

    const fresh = (await getTrade(trade?.tradeId)) || trade;
    const tradeId = fresh?.tradeId;
    if (!tradeId) return;
    if (fresh?.panicExitOrderId) return;

    const instrument = fresh.instrument;
    const side = String(fresh?.side || "").toUpperCase();
    const exitSide = side === "SELL" ? "BUY" : "SELL";
    const qty = Math.abs(Number(fresh?.qty ?? 0));
    if (!Number.isFinite(qty) || qty < 1) {
      await this._panicExit(fresh, reason, {
        timeStop: true,
        preferLimit: true,
      });
      return;
    }

    try {
      const fb = await this._panicExitFallbackLimit({
        tradeId,
        instrument,
        exitSide,
        qty,
        reason,
        marketError: "TIME_STOP_SMART_LIMIT",
        product: this._activeTradeProduct(fresh),
        bufferTicks: Number(env.TIME_STOP_EXIT_LIMIT_BUFFER_TICKS ?? 2),
        maxBps: Number(env.TIME_STOP_EXIT_LIMIT_MAX_BPS ?? 200),
        orderTag: "TIME_STOP_EXIT",
      });

      const exitOrderId = fb?.orderId || null;
      if (!exitOrderId) {
        throw new Error("time_stop_smart_limit_not_placed");
      }

      await this._updateTrade(tradeId, {
        status: STATUS.PANIC_EXIT_PLACED,
        panicExitOrderId: exitOrderId,
        panicExitPlacedAt: new Date(),
        closeReason: `TIME_STOP_EXIT_SMART_PLACED | ${reason}`,
      });
      await linkOrder({
        order_id: exitOrderId,
        tradeId,
        role: "PANIC_EXIT",
      });
      await this._replayOrphanUpdates(exitOrderId);
      this._scheduleTimeStopPanicFallback({ tradeId, reason });
    } catch (e) {
      logger.warn(
        { tradeId, reason, e: String(e?.message || e) },
        "[time_stop] smart exit failed; using panic exit",
      );
      await this._panicExit(fresh, reason, {
        timeStop: true,
        preferLimit: true,
      });
    }
  }

  _schedulePanicExitWatch({
    tradeId,
    orderId,
    instrument,
    exitSide,
    qty,
    reason,
  }) {
    const id = String(tradeId || "");
    if (!id) return;
    if (this._stopped) return;

    const timeoutMs = Math.max(
      0,
      Number(env.PANIC_EXIT_FILL_TIMEOUT_MS ?? 2500),
    );
    if (timeoutMs <= 0) return;

    this._clearPanicExitWatch(id);

    const timer = setTimeout(() => {
      this._panicExitTimeoutCheck({
        tradeId: id,
        orderId,
        instrument,
        exitSide,
        qty,
        reason,
      }).catch((e) => {
        logger.error(
          { tradeId: id, orderId, err: e?.message || String(e) },
          "[panic] timeout check failed",
        );
      });
    }, timeoutMs);
    timer.unref?.();
    this._panicExitTimers.set(id, timer);
  }

  async _panicExitTimeoutCheck(args) {
    return this._runTradeCommand(
      args?.tradeId,
      EXEC_COMMAND.HANDLE_TIMEOUT,
      async () => this._panicExitTimeoutCheckImpl(args),
      { allowMissing: true },
    );
  }

  async _panicExitTimeoutCheckImpl({
    tradeId,
    orderId,
    instrument,
    exitSide,
    qty,
    reason,
  }) {
    if (this._stopped) return;
    const id = String(tradeId || "");
    const oid = String(orderId || "");
    if (!id || !oid) return;

    const latest = await this._getOrderStatus(oid);
    const status = String(latest?.status || "").toUpperCase();

    if (!status) {
      logger.warn(
        { tradeId: id, orderId: oid },
        "[panic] timeout check: no status",
      );
      return;
    }

    if (status === "COMPLETE" || isDead(status)) {
      this._clearPanicExitWatch(id);
      this._panicExitRetryCount.delete(id);
      return;
    }

    const retryCount = Number(this._panicExitRetryCount.get(id) ?? 0);
    const maxRetries = Math.max(0, Number(env.PANIC_EXIT_MAX_RETRIES ?? 1));

    if (retryCount >= maxRetries) {
      logger.warn(
        { tradeId: id, orderId: oid, status, retryCount, maxRetries },
        "[panic] timeout check: max retries reached",
      );
      return;
    }

    if (
      status === "OPEN" ||
      status === "PARTIAL" ||
      status === "TRIGGER PENDING"
    ) {
      logger.warn(
        { tradeId: id, orderId: oid, status, reason },
        "[panic] timeout reached; cancel + replace",
      );

      try {
        this.expectedCancelOrderIds.add(oid);
        await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, oid, {
          purpose: "PANIC_EXIT_TIMEOUT_CANCEL",
          tradeId: id,
        });
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      const after = await this._getOrderStatus(oid);
      const afterStatus = String(after?.status || "").toUpperCase();

      if (afterStatus === "COMPLETE") {
        this._clearPanicExitWatch(id);
        this._panicExitRetryCount.delete(id);
        return;
      }

      if (
        !isDead(afterStatus) &&
        afterStatus !== "CANCELLED" &&
        afterStatus !== "CANCELED"
      ) {
        logger.warn(
          { tradeId: id, orderId: oid, status: afterStatus },
          "[panic] timeout check: cancel not confirmed; skipping replace",
        );
        return;
      }

      const order = after?.order || latest?.order || {};
      const filledQty = Number(order?.filled_quantity ?? 0);
      const totalQty = Number(order?.quantity ?? qty ?? 0);
      const remainingQty = Math.max(0, totalQty - filledQty);

      if (remainingQty < 1) {
        this._clearPanicExitWatch(id);
        this._panicExitRetryCount.delete(id);
        return;
      }

      const fresh = (await getTrade(id)) || {};
      const inst = instrument || fresh.instrument;
      const side = exitSide || (Number(fresh.qty ?? 0) >= 0 ? "SELL" : "BUY");

      const fb = await this._panicExitFallbackLimit({
        tradeId: id,
        instrument: inst,
        exitSide: side,
        qty: remainingQty,
        reason: `${reason || "PANIC_EXIT"}_TIMEOUT_REPLACE`,
        marketError: "PANIC_EXIT_TIMEOUT",
        product: this._activeTradeProduct(fresh),
      });

      const newOrderId = fb?.orderId || null;
      if (newOrderId) {
        this._panicExitRetryCount.set(id, retryCount + 1);
        await this._updateTrade(id, {
          status: STATUS.GUARD_FAILED,
          panicExitOrderId: newOrderId,
          panicExitPlacedAt: new Date(),
          closeReason: `${fresh.closeReason || "PANIC_EXIT"} | REPLACED`,
        });
        await linkOrder({
          order_id: newOrderId,
          tradeId: id,
          role: "PANIC_EXIT",
        });
        await this._replayOrphanUpdates(newOrderId);
        this._schedulePanicExitWatch({
          tradeId: id,
          orderId: newOrderId,
          instrument: inst,
          exitSide: side,
          qty: remainingQty,
          reason,
        });
      }
    }
  }

  async _slWatchdogFire(tradeId, cause = "timeout") {
    if (this._stopped) return;
    if (this._slWatchdogInFlight) return;
    this._slWatchdogInFlight = true;

    try {
      if (!this._isSlWatchdogEnabled()) return;

      const id = String(tradeId || "");
      const st = this._slWatch.get(id);
      if (!st) return;

      // Mark fired (avoid re-entrant timers)
      if (st.firedAtMs) return;
      st.firedAtMs = Date.now();
      this._slWatch.set(id, st);

      const fresh = await getTrade(id);
      if (!fresh) return;

      // If already closed/terminal, stop watching
      const terminal = [
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,
        STATUS.CLOSED,
      ];
      if (terminal.includes(fresh.status)) {
        this._clearSlWatch(id);
        return;
      }

      // If SL order is already complete/dead, stop watching
      const slId = fresh?.slOrderId ? String(fresh.slOrderId) : null;
      if (!slId) {
        this._clearSlWatch(id);
        return;
      }

      const s = await this._getOrderStatus(slId);
      const stt = String(s?.status || "").toUpperCase();

      if (stt === "COMPLETE" || isDead(stt)) {
        this._clearSlWatch(id);
        return;
      }

      // Only act if we have evidence SL should have triggered (or requireBreach is disabled)
      const requireBreach =
        String(env.SL_WATCHDOG_REQUIRE_LTP_BREACH || "true") !== "false";
      const breached =
        !requireBreach ||
        this._slWatchIsBreached(st.lastLtp, st.triggerPrice, st.exitSide);

      if (!breached) {
        // False trigger; reset to avoid nuisance exits
        logger.warn(
          { tradeId: id, cause, lastLtp: st.lastLtp, trigger: st.triggerPrice },
          "[sl_watchdog] fired but breach not confirmed -> reset",
        );
        st.triggeredAtMs = 0;
        st.firedAtMs = 0;
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        this._slWatch.set(id, st);
        return;
      }

      // Persist watchdog event
      try {
        await this._updateTrade(id, {
          slWatchdogFiredAt: new Date(),
          slWatchdogCause: String(cause || "timeout"),
          slWatchdogSlOrderStatus: stt || null,
          slWatchdogLastLtp: Number.isFinite(Number(st.lastLtp))
            ? Number(st.lastLtp)
            : null,
        });
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      logger.error(
        {
          tradeId: id,
          token: st.token,
          slOrderId: slId,
          slStatus: stt,
          lastLtp: st.lastLtp,
          trigger: st.triggerPrice,
          cause,
        },
        "[sl_watchdog] SL triggered but not filled -> cancel & MARKET exit",
      );

      alert("error", "🛑 SL watchdog: cancel SL-L & MARKET exit", {
        tradeId: id,
        slOrderId: slId,
        slStatus: stt,
        ltp: st.lastLtp,
        trigger: st.triggerPrice,
        cause,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );

      // Optional kill-switch on watchdog fire (safest)
      const killOnFire =
        String(env.SL_WATCHDOG_KILL_SWITCH_ON_FIRE || "false") === "true";
      if (killOnFire) {
        await this.setKillSwitch(true, "SL_WATCHDOG");
      }

      // Cancel any remaining exits (best effort), then panic exit to guarantee flat
      try {
        await this._cancelRemainingExitsOnce(fresh, "SL_WATCHDOG");
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
      await this._panicExit(
        fresh,
        "SL_WATCHDOG_" + String(cause || "timeout"),
        {
          allowWhenHalted: true,
        },
      );

      this._clearSlWatch(id);
    } catch (e) {
      logger.error(
        { tradeId: String(tradeId || ""), e: e?.message || String(e) },
        "[sl_watchdog] error",
      );
    } finally {
      this._slWatchdogInFlight = false;
    }
  }
  async _getLtp(token, instrument) {
    const tok = Number(token);
    const cached = this.lastPriceByToken.get(tok);
    const staleMs = Number(env.STALE_TICK_MS ?? 0);
    const lastTickAt = Number(this.lastTickAtByToken.get(tok) ?? 0);
    const isStale =
      Number.isFinite(staleMs) &&
      staleMs > 0 &&
      lastTickAt > 0 &&
      Date.now() - lastTickAt > staleMs;

    if (isStale) this._pushCircuitEvent("staleTicks");

    if (Number.isFinite(cached) && !isStale) return cached;

    const ex = instrument?.exchange || env.DEFAULT_EXCHANGE || "NSE";
    const sym = instrument?.tradingsymbol;
    if (!sym) return cached;

    const key = `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}`;
    try {
      if (typeof this.kite.getLTP === "function") {
        const resp = await this.kite.getLTP([key]);
        const ltp = Number(resp?.[key]?.last_price);
        if (Number.isFinite(ltp)) {
          this.lastPriceByToken.set(tok, ltp);
          this.lastTickAtByToken.set(tok, Date.now());
          return ltp;
        }
      }
      if (typeof this.kite.getQuote === "function") {
        const resp = await this.kite.getQuote([key]);
        const ltp = Number(resp?.[key]?.last_price);
        if (Number.isFinite(ltp)) {
          this.lastPriceByToken.set(tok, ltp);
          this.lastTickAtByToken.set(tok, Date.now());
          return ltp;
        }
      }
    } catch (e) {
      logger.warn({ token: tok, key, e: e.message }, "[ltp] fetch failed");
    }
    return cached;
  }

  async _checkDailyLoss() {
    if (!this.activeTradeId) return;
    if (this.risk.getKillSwitch()) return;

    const trade = await getTrade(this.activeTradeId);
    if (!trade) return;
    if (
      ![STATUS.ENTRY_OPEN, STATUS.ENTRY_FILLED, STATUS.LIVE].includes(
        trade.status,
      )
    )
      return;

    const pnlToken = Number(
      trade?.option_meta?.instrument_token ?? trade.instrument_token,
    );
    if (!Number.isFinite(pnlToken) || pnlToken <= 0) return;

    const needBrokerPosition = trade.status === STATUS.ENTRY_OPEN;
    const filledStatuses = [STATUS.ENTRY_FILLED, STATUS.LIVE];
    if (!filledStatuses.includes(trade.status) && !needBrokerPosition) return;

    let ltp = this.lastPriceByToken.get(pnlToken);

    // OPT mode can have sparse ticks right after entry; allow a throttled quote fetch
    const allowFetch =
      String(env.DAILY_LOSS_ALLOW_LTP_FETCH || "true") === "true";
    if (!Number.isFinite(ltp) && allowFetch && Number.isFinite(pnlToken)) {
      const now = Date.now();
      const last = Number(this._lastLtpFetchAtByToken.get(pnlToken) ?? 0);
      if (now - last >= 1500) {
        this._lastLtpFetchAtByToken.set(pnlToken, now);
        try {
          const instrument = await ensureInstrument(this.kite, pnlToken);
          ltp = await this._getLtp(pnlToken, instrument);
        } catch (_) {
          // ignore
        }
      }
    }

    if (!Number.isFinite(ltp)) return;

    let effectiveQty = Number(trade.qty ?? 0);
    let entryPrice = Number(
      trade.entryPrice ??
        trade.expectedEntryPrice ??
        trade.quoteAtEntry?.ltp ??
        trade.candle?.close ??
        0,
    );
    let side = trade.side;
    if (needBrokerPosition) {
      if (!this.kite || typeof this.kite.getPositions !== "function") return;
      let positions = null;
      try {
        positions = await this.kite.getPositions();
      } catch {
        positions = null;
      }
      const net = positions?.net || positions?.day || [];
      const pos = (net || []).find(
        (p) => Number(p?.instrument_token) === pnlToken,
      );
      const netQty = Number(pos?.quantity ?? pos?.net_quantity ?? 0);
      if (!Number.isFinite(netQty) || netQty === 0) return;
      effectiveQty = Math.abs(netQty);
      side = netQty > 0 ? "BUY" : "SELL";
      const avg = Number(
        pos?.average_price ?? pos?.buy_price ?? pos?.sell_price ?? 0,
      );
      if (Number.isFinite(avg) && avg > 0) entryPrice = avg;
    }

    if (!Number.isFinite(effectiveQty) || effectiveQty <= 0) return;

    const openPnl = calcOpenPnl(
      { ...trade, qty: effectiveQty, entryPrice, side },
      ltp,
    );
    const day = await getDailyRisk(todayKey());
    const realized = Number(day?.realizedPnl ?? 0);
    const total = realized + openPnl;
    const maxPosVal = Number(env.MAX_POSITION_VALUE_INR ?? 0);
    if (Number.isFinite(maxPosVal) && maxPosVal > 0) {
      const maxAbs = Math.abs(Number(total ?? 0));
      if (Number.isFinite(maxAbs) && maxAbs > maxPosVal * 2) {
        logger.warn(
          { total, realized, openPnl, maxPosVal },
          "[risk] daily pnl sanity guard triggered; skipping update",
        );
        return;
      }
    }

    const prevState = day?.state || "RUNNING";
    const { state } = await this._updateDailyPnlState({
      realized,
      openPnl,
      total,
      prevState,
    });

    if (state === "HARD_STOP") {
      const lossCap = Number(
        this.risk?.getLimits?.().dailyLossCapInr ??
          env.DAILY_MAX_LOSS_INR ??
          1000,
      );
      logger.error(
        { total, realized, openPnl },
        "[risk] DAILY_MAX_LOSS hit -> kill switch",
      );
      if (prevState !== "HARD_STOP") {
        alert("error", "🛑 DAILY_MAX_LOSS hit -> kill switch", {
          total,
          realized,
          openPnl,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      }
      this.risk.setKillSwitch(true);
      await upsertDailyRisk(todayKey(), {
        kill: true,
        reason: "DAILY_MAX_LOSS",
        lastTotal: total,
      });

      if (String(env.AUTO_EXIT_ON_DAILY_LOSS) === "true") {
        await this._panicExit(trade, "DAILY_MAX_LOSS");
      }
    } else if (state === "SOFT_STOP") {
      if (prevState !== "SOFT_STOP") {
        logger.warn(
          { total, realized, openPnl },
          "[risk] DAILY_PROFIT_GOAL reached -> soft stop entries",
        );
        alert("info", "✅ DAILY_PROFIT_GOAL reached -> soft stop entries", {
          total,
          realized,
          openPnl,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      }
    }
  }

  _activeTradeProduct(trade) {
    const product = String(
      trade?.product || env.DEFAULT_PRODUCT || "MIS",
    ).toUpperCase();
    return product || "MIS";
  }

  async _maybeConvertMisToNrmlIfNeeded() {
    if (!this.activeTradeId) return;
    if (!env.EOD_MIS_TO_NRML_ENABLED) return;
    if (!env.EOD_CARRY_ALLOWED) return;
    if (!this.kite || typeof this.kite.convertPosition !== "function") return;

    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const now = DateTime.now().setZone(tz);
    const convertAt = DateTime.fromFormat(
      env.EOD_MIS_TO_NRML_AT || "15:18",
      "HH:mm",
      {
        zone: tz,
      },
    );
    if (!convertAt.isValid) return;

    const convertToday = now.set({
      hour: convertAt.hour,
      minute: convertAt.minute,
      second: 0,
      millisecond: 0,
    });
    if (now < convertToday) return;

    const trade = await getTrade(this.activeTradeId);
    if (!trade) return;
    const tradeId = String(trade.tradeId || "");
    if (!tradeId) return;
    if (this._eodConvertAttempted.has(tradeId)) return;

    if (
      ![
        STATUS.ENTRY_OPEN,
        STATUS.ENTRY_FILLED,
        STATUS.LIVE,
        STATUS.GUARD_FAILED,
      ].includes(trade.status)
    ) {
      return;
    }

    const product = this._activeTradeProduct(trade);
    if (product !== "MIS") {
      this._eodConvertAttempted.add(tradeId);
      return;
    }

    const qty = Math.abs(Number(trade.qty ?? 0));
    if (!Number.isFinite(qty) || qty < 1) return;

    const side = String(trade.side || "").toUpperCase();
    const transactionType = side === "SELL" ? "SELL" : "BUY";

    try {
      await this.kite.convertPosition({
        exchange: trade.instrument?.exchange,
        tradingsymbol: trade.instrument?.tradingsymbol,
        transaction_type: transactionType,
        position_type: "DAY",
        quantity: qty,
        old_product: "MIS",
        new_product: "NRML",
      });

      this._eodConvertAttempted.add(tradeId);
      await this._updateTrade(tradeId, {
        product: "NRML",
        eodCarryConvertedAt: new Date(),
      });

      logger.warn(
        { tradeId, qty, transactionType },
        "[time_guard] EOD MIS->NRML conversion successful",
      );
      alert("warn", "⏰ EOD carry conversion done (MIS → NRML)", {
        tradeId,
        qty,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
    } catch (e) {
      this._eodConvertAttempted.add(tradeId);
      logger.error(
        { tradeId, e: e?.message || String(e) },
        "[time_guard] EOD MIS->NRML conversion failed",
      );
      alert("error", "🛑 EOD MIS → NRML conversion failed", {
        tradeId,
        message: e?.message || String(e),
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
    }
  }

  async _forceFlattenIfNeeded() {
    if (!this.activeTradeId) return;

    await this._maybeConvertMisToNrmlIfNeeded();

    if (this.risk.getKillSwitch()) return;

    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const now = DateTime.now().setZone(tz);
    const flat = DateTime.fromFormat(env.FORCE_FLATTEN_AT || "15:20", "HH:mm", {
      zone: tz,
    });
    if (!flat.isValid) return;

    const flatToday = now.set({
      hour: flat.hour,
      minute: flat.minute,
      second: 0,
      millisecond: 0,
    });
    if (now < flatToday) return;

    const trade = await getTrade(this.activeTradeId);
    if (!trade) return;
    if (
      ![
        STATUS.ENTRY_OPEN,
        STATUS.ENTRY_FILLED,
        STATUS.SL_PLACED,
        STATUS.SL_CONFIRMED,
        STATUS.LIVE,
      ].includes(trade.status)
    )
      return;

    logger.warn(
      { tradeId: trade.tradeId },
      "[time_guard] FORCE_FLATTEN triggered",
    );
    alert("warn", "⏰ FORCE_FLATTEN triggered (closing position)", {
      tradeId: trade.tradeId,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
    this.risk.setKillSwitch(true);
    await upsertDailyRisk(todayKey(), {
      kill: true,
      reason: "FORCE_FLATTEN",
      lastTradeId: trade.tradeId,
    });
    await this._panicExit(
      { ...trade, product: this._activeTradeProduct(trade) },
      "FORCE_FLATTEN",
    );
  }

  _scheduleReconcile(reason = "order_update") {
    if (this._stopped) return;
    const enabled = String(env.RECONCILE_ON_ORDER_UPDATE || "true") === "true";
    if (!enabled) return;

    const debounceMs = Math.max(250, Number(env.RECONCILE_DEBOUNCE_MS ?? 1500));

    if (this._reconcileTimer) return;

    this._reconcileScheduledAt = Date.now();
    this._reconcileTimer = setTimeout(() => {
      this._reconcileTimer = null;
      this.reconcile()
        .then(() => {
          logger.info(
            { reason, waitedMs: Date.now() - this._reconcileScheduledAt },
            "[reconcile] debounced run complete",
          );
        })
        .catch((e) =>
          logger.warn(
            { reason, e: e?.message || String(e) },
            "[reconcile] debounced run failed",
          ),
        );
    }, debounceMs);
  }

  _syncRiskFromPositions(posQtyByToken, actives = []) {
    const activeByToken = new Map(
      (actives || []).map((t) => [Number(t.instrument_token), t]),
    );

    const state = this.risk?.getState ? this.risk.getState() : null;
    const currentTokens = new Set(
      Array.isArray(state?.openPositions)
        ? state.openPositions.map((p) => String(p.token))
        : [],
    );

    for (const [token, qtyRaw] of posQtyByToken.entries()) {
      const qty = Number(qtyRaw ?? 0);
      if (!Number.isFinite(qty) || qty === 0) continue;
      const trade = activeByToken.get(Number(token));
      const riskKey =
        trade?.riskKey || this._riskKeyForTrade(trade) || String(token);
      this.risk.setOpenPosition(riskKey, {
        tradeId: trade?.tradeId || null,
        side: qty > 0 ? "BUY" : "SELL",
        qty: Math.abs(qty),
      });
      currentTokens.delete(String(riskKey));
    }

    for (const token of currentTokens) {
      this.risk.clearOpenPosition(String(token));
    }
  }

  async _monitorPortfolioRisk(reason = "tick") {
    const everyMs = Math.max(1000, Number(env.PORTFOLIO_RISK_CHECK_MS ?? 5000));
    if (Date.now() - this._lastPortfolioRiskCheckAt < everyMs) return;
    this._lastPortfolioRiskCheckAt = Date.now();

    try {
      const limits = this.risk?.getLimits ? this.risk.getLimits() : {};
      const maxPerSymbolExposureInr = Number(
        limits?.maxPerSymbolExposureInr ?? 0,
      );
      const maxPortfolioExposureInr = Number(
        limits?.maxPortfolioExposureInr ?? 0,
      );
      const maxLeverage = Number(limits?.maxLeverage ?? 0);
      const maxMarginUtil = Number(limits?.maxMarginUtilization ?? 0);

      if (
        maxPerSymbolExposureInr <= 0 &&
        maxPortfolioExposureInr <= 0 &&
        maxLeverage <= 0 &&
        maxMarginUtil <= 0
      ) {
        return;
      }

      const positions = await buildPositionsSnapshot({ kite: this.kite });
      const exposureBySymbol = {};
      let totalExposure = 0;
      for (const p of positions) {
        const key = p.tradingsymbol || String(p.instrument_token || "");
        const exp = Number(p.exposureInr ?? 0);
        if (Number.isFinite(exp) && exp > 0) {
          exposureBySymbol[key] = (exposureBySymbol[key] || 0) + exp;
          totalExposure += exp;
        }
      }

      const equitySnap = await equityService.snapshot({ kite: this.kite });
      const equity = Number(equitySnap?.snapshot?.equity ?? 0);
      const utilized = Number(equitySnap?.snapshot?.utilized ?? 0);
      const available = Number(equitySnap?.snapshot?.available ?? 0);
      const utilization =
        utilized > 0 && available >= 0
          ? utilized / (utilized + available)
          : null;

      let breach = null;
      if (
        maxPortfolioExposureInr > 0 &&
        totalExposure > maxPortfolioExposureInr
      ) {
        breach = {
          reason: "MAX_PORTFOLIO_EXPOSURE",
          meta: { totalExposure, maxPortfolioExposureInr },
        };
      }

      if (!breach && maxLeverage > 0 && equity > 0) {
        const leverage = totalExposure / equity;
        if (leverage > maxLeverage) {
          breach = {
            reason: "MAX_LEVERAGE",
            meta: { leverage, maxLeverage, equity, totalExposure },
          };
        }
      }

      if (
        !breach &&
        maxMarginUtil > 0 &&
        utilization != null &&
        utilization > maxMarginUtil
      ) {
        breach = {
          reason: "MAX_MARGIN_UTILIZATION",
          meta: {
            utilization,
            maxMarginUtil,
            utilized,
            available,
          },
        };
      }

      if (!breach && maxPerSymbolExposureInr > 0) {
        const over = Object.entries(exposureBySymbol).find(
          ([, exp]) => exp > maxPerSymbolExposureInr,
        );
        if (over) {
          breach = {
            reason: "MAX_SYMBOL_EXPOSURE",
            meta: {
              symbol: over[0],
              exposure: over[1],
              maxPerSymbolExposureInr,
            },
          };
        }
      }

      if (!breach) return;

      logger.error({ reason, ...breach }, "[risk] portfolio risk breach");
      alert("error", "🛑 Portfolio risk breach", {
        reason: breach.reason,
        meta: breach.meta,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
      this.risk.setKillSwitch(true);
      await upsertDailyRisk(todayKey(), {
        kill: true,
        reason: breach.reason,
      });

      const autoFlatten =
        String(env.RISK_AUTO_FLATTEN_ON_BREACH || "false") === "true";
      if (autoFlatten) {
        await this._flattenNetPositions("PORTFOLIO_RISK_BREACH");
      }
    } catch (e) {
      logger.warn(
        { reason, e: e?.message || String(e) },
        "[risk] portfolio risk check failed",
      );
    }
  }

  async _flattenNetPositions(reason) {
    const positions = await this.kite.getPositions();
    const net = positions?.net || positions?.day || [];
    const open = (net || []).filter((p) => {
      const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
      return Number.isFinite(qty) && qty !== 0;
    });

    if (!open.length) return;

    for (const p of open) {
      const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
      const token = Number(p?.instrument_token);
      if (!Number.isFinite(qty) || qty === 0 || !Number.isFinite(token))
        continue;

      let instrument = null;
      try {
        instrument = await ensureInstrument(this.kite, token);
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      const exitSide = qty > 0 ? "SELL" : "BUY";
      const orderParams = {
        exchange: instrument?.exchange || p?.exchange || env.DEFAULT_EXCHANGE,
        tradingsymbol: instrument?.tradingsymbol || p?.tradingsymbol,
        transaction_type: exitSide,
        quantity: Math.abs(qty),
        product: env.DEFAULT_PRODUCT,
        order_type: "MARKET",
        validity: "DAY",
        tag: makeTag("HARD_FLAT", "X"),
      };

      try {
        await this._safePlaceOrder(env.DEFAULT_ORDER_VARIETY, orderParams, {
          purpose: reason || "HARD_FLAT",
          tradeId: null,
        });
      } catch (e) {
        logger.error(
          { token, e: e?.message || String(e), reason },
          "[risk] flatten order failed",
        );
      }
    }
  }

  _recordSlippageFeedback({ entrySlippageBps, pnlSlippageDeltaInr }) {
    const entry = Math.abs(Number(entrySlippageBps));
    const exit = Math.abs(Number(pnlSlippageDeltaInr));
    if (Number.isFinite(entry)) {
      this._slippageStats.entryBps.push(entry);
      if (this._slippageStats.entryBps.length > this._slippageStats.size) {
        this._slippageStats.entryBps.splice(
          0,
          this._slippageStats.entryBps.length - this._slippageStats.size,
        );
      }
    }
    if (Number.isFinite(exit)) {
      this._slippageStats.exitInr.push(exit);
      if (this._slippageStats.exitInr.length > this._slippageStats.size) {
        this._slippageStats.exitInr.splice(
          0,
          this._slippageStats.exitInr.length - this._slippageStats.size,
        );
      }
    }

    const avgEntry =
      this._slippageStats.entryBps.reduce((a, b) => a + b, 0) /
      (this._slippageStats.entryBps.length || 1);
    const avgExit =
      this._slippageStats.exitInr.reduce((a, b) => a + b, 0) /
      (this._slippageStats.exitInr.length || 1);

    const maxEntryBps = Number(env.SLIPPAGE_FEEDBACK_MAX_ENTRY_BPS ?? 0);
    const maxExitInr = Number(env.SLIPPAGE_FEEDBACK_MAX_EXIT_INR ?? 0);

    if (
      (maxEntryBps > 0 && avgEntry > maxEntryBps) ||
      (maxExitInr > 0 && avgExit > maxExitInr)
    ) {
      const cooldownMin = Math.max(
        1,
        Number(env.SLIPPAGE_COOLDOWN_MINUTES ?? 15),
      );
      this._slippageCooldownUntil = Date.now() + cooldownMin * 60 * 1000;
      const kill =
        String(env.SLIPPAGE_FEEDBACK_KILL_SWITCH || "true") === "true";
      if (kill) this.risk.setKillSwitch(true);
      alert("error", "🛑 Slippage feedback guard triggered", {
        avgEntryBps: avgEntry,
        avgExitInr: avgExit,
        maxEntryBps,
        maxExitInr,
        cooldownMin,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
      logger.error(
        {
          avgEntryBps: avgEntry,
          avgExitInr: avgExit,
          maxEntryBps,
          maxExitInr,
        },
        "[guard] slippage feedback triggered",
      );
    }
  }

  _isStrategyThrottled(strategyId) {
    if (!strategyId) return false;
    const until = this._strategyCooldownUntil.get(String(strategyId)) || 0;
    return Date.now() < until;
  }

  _updateStrategyLossStreak({ trade, pnl }) {
    const strategyId = String(trade?.strategyId || "").trim();
    if (!strategyId) return;
    const cur = this._strategyLossStreak.get(strategyId) || 0;
    const next = pnl < 0 ? cur + 1 : 0;
    this._strategyLossStreak.set(strategyId, next);

    const maxLosses = Math.max(
      1,
      Number(env.STRATEGY_MAX_CONSECUTIVE_LOSSES ?? 3),
    );
    if (pnl < 0 && next >= maxLosses) {
      const cooldownMin = Math.max(
        1,
        Number(env.STRATEGY_COOLDOWN_MINUTES ?? 20),
      );
      const until = Date.now() + cooldownMin * 60 * 1000;
      this._strategyCooldownUntil.set(strategyId, until);
      alert("warn", "⚠️ Strategy cooldown triggered", {
        strategyId,
        lossStreak: next,
        cooldownMin,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
      logger.warn(
        { strategyId, lossStreak: next, cooldownMin },
        "[strategy] cooldown triggered",
      );
    }
  }

  async _maybeHardFlatOnRestart(positionsNet = []) {
    if (this._hardFlatHandled) return;
    const enabled = String(env.HARD_FLAT_ON_RESTART || "false") === "true";
    if (!enabled) return;

    this._hardFlatHandled = true;
    const open = (positionsNet || []).filter((p) => {
      const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
      return Number.isFinite(qty) && qty !== 0;
    });

    if (!open.length) return;

    logger.error(
      { count: open.length },
      "[restart] HARD_FLAT_ON_RESTART enabled; flattening positions",
    );
    alert("error", "🛑 HARD_FLAT_ON_RESTART active; flattening positions", {
      count: open.length,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
    this.risk.setKillSwitch(true);
    await upsertDailyRisk(todayKey(), {
      kill: true,
      reason: "HARD_FLAT_ON_RESTART",
    });
    await this._flattenNetPositions("HARD_FLAT_ON_RESTART");
  }

  async _safePlaceOrder(variety, params, { purpose, tradeId } = {}) {
    const maxAttempts = Math.max(1, Number(env.ORDER_PLACE_RETRY_MAX ?? 1));
    const backoffMs = Math.max(
      0,
      Number(env.ORDER_PLACE_RETRY_BACKOFF_MS ?? 250),
    );

    const baseParams = { ...params };

    // Market protection (ENFORCED by default for scalping)
    const enforceMp =
      String(env.ENFORCE_MARKET_PROTECTION || "true") === "true";
    const ot = String(baseParams.order_type || "").toUpperCase();
    if (enforceMp && (ot === "MARKET" || ot === "SL-M")) {
      const mpRaw = env.MARKET_PROTECTION ?? "-1";
      const n = Number(mpRaw);
      if (Number.isFinite(n)) baseParams.market_protection = n;
      else baseParams.market_protection = mpRaw;
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const rate = this.orderLimiter.check({ count: 1 });
      if (!rate.ok) {
        throw new Error(
          `Order rate limit hit (${rate.reason}). Refusing to place order.`,
        );
      }
      const brokerRate = this.brokerOrderLimiter.check({ count: 1 });
      if (!brokerRate.ok) {
        throw new Error(
          `Broker rate limit hit (${brokerRate.reason}). Refusing to place order.`,
        );
      }
      if (this.ordersPlacedToday + 1 > Number(env.MAX_ORDERS_PER_DAY ?? 3000)) {
        this.risk.setKillSwitch(true);
        await upsertDailyRisk(todayKey(), {
          kill: true,
          reason: "MAX_ORDERS_PER_DAY_REACHED",
        });
        throw new Error("MAX_ORDERS_PER_DAY reached; kill-switch enabled.");
      }

      try {
        const resp = await this.kite.placeOrder(variety, baseParams);
        const orderId = String(resp?.order_id || resp?.orderId || resp || "");
        if (!orderId) throw new Error("placeOrder returned no order_id");

        this.orderLimiter.record({ count: 1 });
        this.brokerOrderLimiter.record({ count: 1 });
        await this._recordOrdersPlaced(1);

        logger.info(
          { tradeId, purpose, orderId, attempt },
          "[orders] placed successfully",
        );
        return { orderId, resp };
      } catch (e) {
        const msg = String(e?.message || e);
        const retryable = isRetryablePlaceError(e);
        this._handlePlaceOrderError({
          e,
          params: baseParams,
          tradeId,
          purpose,
        });

        // If retryable, attempt dedupe by tag before retrying
        if (retryable && attempt < maxAttempts) {
          const tag = String(baseParams.tag || "");
          if (tag) {
            const found = await this._findRecentOrderByTag(tag, baseParams);
            if (found?.order_id) {
              const orderId = String(found.order_id);
              logger.warn(
                { tradeId, purpose, orderId, attempt, msg },
                "[orders] place error but matching order exists; treating as success",
              );
              this.orderLimiter.record({ count: 1 });
              await this._recordOrdersPlaced(1);
              return { orderId, resp: { deduped: true, order_id: orderId } };
            }
          }

          logger.warn(
            { tradeId, purpose, attempt, msg },
            "[orders] retryable place error; retrying",
          );
          await sleep(backoffMs * attempt);
          continue;
        }

        // Non-retryable or attempts exhausted
        throw e;
      }
    }

    throw new Error("placeOrder failed after retries");
  }

  _handlePlaceOrderError({ e, params, tradeId, purpose }) {
    const msg = String(e?.message || e || "");
    const reason = detectCircuitBreakerReason(msg);
    if (!reason) return;

    const token = Number(params?.instrument_token ?? 0);
    const cooldownMin = Math.max(
      1,
      Number(env.CIRCUIT_BREAKER_COOLDOWN_MINUTES ?? 5),
    );
    if (Number.isFinite(token) && token > 0 && this.risk?.setCooldown) {
      const riskKey = this._buildRiskKey({
        strategyId: params?.strategyId,
        underlying: params?.underlying_symbol,
        token,
      });
      this.risk.setCooldown(riskKey, cooldownMin * 60, reason.code);
    }
    logger.warn(
      { tradeId, purpose, reason: reason.code, msg },
      "[orders] circuit breaker detected",
    );
  }

  _handleOrderRejection({ trade, order, role }) {
    const msg =
      order?.status_message_raw ||
      order?.status_message ||
      order?.message ||
      "";
    const reason = detectCircuitBreakerReason(msg);
    if (!reason) return;

    const token = Number(
      trade?.instrument_token ??
        order?.instrument_token ??
        order?.instrument_token ??
        0,
    );
    const cooldownMin = Math.max(
      1,
      Number(env.CIRCUIT_BREAKER_COOLDOWN_MINUTES ?? 5),
    );
    if (Number.isFinite(token) && token > 0 && this.risk?.setCooldown) {
      const riskKey = this._buildRiskKey({
        strategyId: trade?.strategyId,
        underlying:
          trade?.underlying_symbol ||
          trade?.option_meta?.underlying ||
          trade?.instrument?.name ||
          trade?.instrument?.tradingsymbol,
        token,
      });
      this.risk.setCooldown(riskKey, cooldownMin * 60, reason.code);
    }
    alert("warn", "⚠️ Circuit breaker / exchange protection detected", {
      tradeId: trade?.tradeId || null,
      role,
      reason: reason.code,
      message: msg || null,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
  }

  async _safeCancelOrder(variety, orderId, { purpose, tradeId } = {}) {
    const oid = String(orderId || "");
    if (!oid) throw new Error("cancelOrder missing orderId");

    const terminalStatus = String(
      this._terminalOrderStatusById.get(oid) || "",
    ).toUpperCase();
    if (terminalStatus) {
      logger.info(
        { tradeId, purpose, orderId: oid, status: terminalStatus },
        "[orders] cancel skipped (terminal order)",
      );
      return {
        skipped: true,
        reason: "terminal_order",
        status: terminalStatus,
      };
    }

    const rate = this.orderLimiter.check({ count: 1 });
    if (!rate.ok) {
      throw new Error(
        `Order rate limit hit (${rate.reason}). Refusing to cancel order.`,
      );
    }
    const brokerRate = this.brokerOrderLimiter.check({ count: 1 });
    if (!brokerRate.ok) {
      throw new Error(
        `Broker rate limit hit (${brokerRate.reason}). Refusing to cancel order.`,
      );
    }

    // ✅ enforce daily limit for cancel as well
    if (this.ordersPlacedToday + 1 > Number(env.MAX_ORDERS_PER_DAY ?? 3000)) {
      this.risk.setKillSwitch(true);
      await upsertDailyRisk(todayKey(), {
        kill: true,
        reason: "MAX_ORDERS_PER_DAY_REACHED",
      });
      throw new Error("MAX_ORDERS_PER_DAY reached; kill-switch enabled.");
    }

    try {
      const resp = await this.kite.cancelOrder(variety, oid);
      this.orderLimiter.record({ count: 1 });
      this.brokerOrderLimiter.record({ count: 1 });
      await this._recordOrdersPlaced(1);
      logger.info({ tradeId, purpose, orderId: oid }, "[orders] cancelled");
      return resp;
    } catch (e) {
      if (this._isCancelProcessingError(e)) {
        logger.warn(
          { tradeId, purpose, orderId: oid, e: e?.message || String(e) },
          "[orders] cancel deferred (broker processing)",
        );
        return { skipped: true, reason: "broker_processing" };
      }
      logger.error(
        { tradeId, purpose, orderId: oid, e: e.message },
        "[orders] cancel failed",
      );
      throw e;
    }
  }

  async _safeModifyOrder(
    variety,
    orderId,
    patch,
    { purpose, tradeId, retry, tickSize = 0.05, minIntervalMs = 0 } = {},
  ) {
    const oid = String(orderId || "");
    if (!oid) throw new Error("modifyOrder missing orderId");

    const now = Date.now();
    const terminalStatus = String(
      this._terminalOrderStatusById.get(oid) || "",
    ).toUpperCase();
    if (terminalStatus) {
      logger.info(
        { tradeId, purpose, orderId: oid, status: terminalStatus },
        "[orders] modify skipped (terminal order)",
      );
      return {
        skipped: true,
        reason: "terminal_order",
        status: terminalStatus,
      };
    }

    const cooldownMs = Math.max(0, Number(minIntervalMs ?? 0));
    const lastModifyAt = Number(this._lastModifyAttemptAtByOrder.get(oid) ?? 0);
    if (cooldownMs > 0 && now - lastModifyAt < cooldownMs) {
      logger.info(
        {
          tradeId,
          purpose,
          orderId: oid,
          waitedMs: now - lastModifyAt,
          cooldownMs,
        },
        "[orders] modify skipped (cooldown)",
      );
      return { skipped: true, reason: "cooldown" };
    }

    const currentOrder = this._lastOrdersById.get(oid);
    const nextPatch = { ...(patch || {}) };
    const tick = Math.max(0.000001, Number(tickSize ?? 0.05));
    const patchEntries = Object.entries(nextPatch);
    const patchComparisons = patchEntries.map(([k, v]) => {
      const cur = Number(currentOrder?.[k]);
      const nxt = Number(v);
      if (Number.isFinite(cur) && Number.isFinite(nxt)) {
        const delta = Math.abs(nxt - cur);
        return {
          key: k,
          numeric: true,
          delta,
          changed: delta >= tick,
        };
      }
      return {
        key: k,
        numeric: false,
        delta: null,
        changed: String(currentOrder?.[k] ?? "") !== String(v ?? ""),
      };
    });
    const hasMeaningfulChange = patchComparisons.some(
      (comparison) => comparison.changed,
    );
    const diffBelowTick = patchComparisons.some(
      (comparison) =>
        comparison.numeric &&
        Number.isFinite(comparison.delta) &&
        comparison.delta > 0 &&
        comparison.delta < tick,
    );
    const brokerAlreadyMatchesTarget =
      Boolean(currentOrder) &&
      patchEntries.some(
        ([key]) => key === "trigger_price" || key === "price",
      ) &&
      patchComparisons.every((comparison) => !comparison.changed) &&
      !diffBelowTick;
    if (!hasMeaningfulChange) {
      logger.info(
        {
          tradeId,
          purpose,
          orderId: oid,
          patch: nextPatch,
          currentTriggerPrice: currentOrder?.trigger_price ?? null,
          currentPrice: currentOrder?.price ?? null,
        },
        diffBelowTick
          ? "[orders] modify skipped (delta below tick)"
          : brokerAlreadyMatchesTarget
          ? "[orders] modify skipped (broker stop already matches target)"
          : "[orders] modify skipped (no effective change)",
      );
      return {
        skipped: true,
        reason: diffBelowTick
          ? "delta_below_tick"
          : brokerAlreadyMatchesTarget
          ? "broker_already_matches_target"
          : "no_effective_change",
      };
    }

    const attemptModify = async (nextPatch, label) => {
      const rate = this.orderLimiter.check({ count: 1 });
      if (!rate.ok) {
        throw new Error(
          `Order rate limit hit (${rate.reason}). Refusing to modify order.`,
        );
      }
      const brokerRate = this.brokerOrderLimiter.check({ count: 1 });
      if (!brokerRate.ok) {
        throw new Error(
          `Broker rate limit hit (${brokerRate.reason}). Refusing to modify order.`,
        );
      }

      // ✅ enforce daily limit for modify as well
      if (this.ordersPlacedToday + 1 > Number(env.MAX_ORDERS_PER_DAY ?? 3000)) {
        this.risk.setKillSwitch(true);
        await upsertDailyRisk(todayKey(), {
          kill: true,
          reason: "MAX_ORDERS_PER_DAY_REACHED",
        });
        throw new Error("MAX_ORDERS_PER_DAY reached; kill-switch enabled.");
      }

      this._lastModifyAttemptAtByOrder.set(oid, Date.now());
      const resp = await this.kite.modifyOrder(variety, oid, nextPatch);
      if (retry && !retry.appliedPatch) {
        retry.appliedPatch = nextPatch;
      }
      this.orderLimiter.record({ count: 1 });
      this.brokerOrderLimiter.record({ count: 1 });
      await this._recordOrdersPlaced(1);
      logger.info(
        { tradeId, purpose: label || purpose, orderId: oid, patch: nextPatch },
        "[orders] modified",
      );
      return resp;
    };

    try {
      return await attemptModify(patch);
    } catch (e) {
      const message = String(e?.message || "");
      if (/order parameters are not changed/i.test(message)) {
        logger.info(
          { tradeId, purpose, orderId: oid, patch },
          "[orders] modify skipped by broker (no change)",
        );
        return { skipped: true, reason: "broker_no_change" };
      }
      const retryable = /trigger|invalid|rejected|range|cross/i.test(message);
      if (
        retryable &&
        retry?.type === "DYN_SL" &&
        !retry?.attempted &&
        Number.isFinite(Number(patch?.trigger_price))
      ) {
        try {
          retry.attempted = true;
          const token = Number(retry?.token ?? 0);
          const instrument = retry?.instrument || null;
          const side = String(retry?.side || "").toUpperCase();
          const slType = String(retry?.slType || "").toUpperCase();
          const exitSide =
            String(retry?.exitSide || "").toUpperCase() ||
            (side === "BUY" ? "SELL" : "BUY");
          const currentStopLoss = Number(retry?.currentStopLoss ?? 0);

          const freshLtp = await this._getLtp(token, instrument);
          const tickSize = Number(instrument?.tick_size ?? 0.05);
          const bufferTicks = Number(env.DYN_SL_RETRY_BUFFER_TICKS ?? 2);
          const buffer =
            Math.max(1, Number.isFinite(bufferTicks) ? bufferTicks : 2) *
            tickSize;

          let nextStop = Number(patch.trigger_price ?? 0);
          if (Number.isFinite(freshLtp) && freshLtp > 0) {
            if (side === "BUY") {
              const cap = freshLtp - buffer;
              nextStop = Math.min(nextStop, cap);
              if (
                Number.isFinite(currentStopLoss) &&
                nextStop < currentStopLoss
              )
                nextStop = NaN;
            } else if (side === "SELL") {
              const cap = freshLtp + buffer;
              nextStop = Math.max(nextStop, cap);
              if (
                Number.isFinite(currentStopLoss) &&
                nextStop > currentStopLoss
              )
                nextStop = NaN;
            } else {
              nextStop = NaN;
            }
          } else {
            nextStop = NaN;
          }

          if (Number.isFinite(nextStop) && nextStop > 0) {
            const rounded = roundToTick(
              nextStop,
              tickSize,
              side === "BUY" ? "down" : "up",
            );
            const retryPatch = { trigger_price: rounded };
            if (slType === "SL") {
              retryPatch.price = this._buildStopLossLimitPrice({
                triggerPrice: rounded,
                exitSide,
                instrument,
              });
            }
            return await attemptModify(retryPatch, "DYN_SL_RETRY");
          }
        } catch (retryError) {
          logger.warn(
            { tradeId, purpose, orderId: oid, e: retryError?.message },
            "[orders] modify retry failed",
          );
        }
      }

      logger.error(
        { tradeId, purpose, orderId: oid, e: e.message },
        "[orders] modify failed",
      );
      throw e;
    }
  }

  async _findRecentOrderByTag(tag, params) {
    try {
      const orders = await this.kite.getOrders();
      const now = Date.now();
      const lookbackMs = Math.max(
        1000,
        Number(env.ORDER_DEDUP_LOOKBACK_SEC ?? 120) * 1000,
      );

      const want = normalizeOrderShapeForMatch(params);
      const tagU = String(tag || "").trim();

      for (const o of orders || []) {
        if (String(o.tag || "").trim() !== tagU) continue;
        const tsRaw = o.order_timestamp || o.exchange_timestamp || o.created_at;
        const ts = tsRaw ? new Date(tsRaw).getTime() : NaN;
        if (!Number.isFinite(ts) || now - ts > lookbackMs) continue;

        const got = normalizeOrderShapeForMatch(o);
        if (ordersMatch(want, got)) {
          return o;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  async _replayOrphanUpdates(orderId, opts = {}) {
    const oid = String(orderId || "");
    if (!oid) return;
    const attempt = Number(opts.attempt ?? 0);
    const maxAttempts = Math.max(
      1,
      Number(env.ORPHAN_REPLAY_MAX_ATTEMPTS ?? 4),
    );
    const baseDelayMs = Math.max(0, Number(env.ORPHAN_REPLAY_DELAY_MS ?? 250));
    const backoffFactor = Math.max(
      1,
      Number(env.ORPHAN_REPLAY_BACKOFF_FACTOR ?? 2),
    );
    const backoffMaxMs = Math.max(
      baseDelayMs,
      Number(env.ORPHAN_REPLAY_BACKOFF_MAX_MS ?? 10_000),
    );
    const jitterPct = Math.max(0, Number(env.ORPHAN_REPLAY_JITTER_PCT ?? 0.15));

    try {
      const linkCheck = await findTradeByOrder(oid);
      if (!linkCheck?.link) {
        if (attempt < maxAttempts) {
          const rawBackoff = Math.min(
            backoffMaxMs,
            baseDelayMs * Math.pow(backoffFactor, Math.max(0, attempt)),
          );
          const delayMs = jitterMs(rawBackoff, jitterPct);
          this._orphanReplayStats.retriesScheduled += 1;
          setTimeout(() => {
            this._replayOrphanUpdates(oid, { attempt: attempt + 1 }).catch(
              (e) => {
                this._orphanReplayStats.replayFailures += 1;
                logger.warn(
                  { orderId: oid, attempt: attempt + 1, e: e.message },
                  "[orphan] replay retry failed",
                );
              },
            );
          }, delayMs);
        } else {
          this._orphanReplayStats.retriesExhausted += 1;
          const dlqEnabled =
            String(env.ORPHAN_REPLAY_DEAD_LETTER_ENABLED || "true") === "true";
          if (dlqEnabled) {
            try {
              const moved = await deadLetterOrphanOrderUpdates({
                order_id: oid,
                reason: "LINK_NOT_READY_MAX_RETRIES",
                meta: {
                  attempt,
                  maxAttempts,
                  baseDelayMs,
                  backoffFactor,
                  backoffMaxMs,
                },
              });
              this._orphanReplayStats.deadLettered += Number(moved?.moved ?? 0);
              this._orphanReplayStats.lastDeadLetterAt = Date.now();
              logger.warn(
                {
                  orderId: oid,
                  moved: moved?.moved || 0,
                  attempt,
                  maxAttempts,
                },
                "[orphan] replay dead-lettered",
              );
            } catch (e) {
              logger.warn(
                { orderId: oid, e: e.message },
                "[orphan] dead-letter move failed",
              );
            }
          } else {
            logger.warn(
              { orderId: oid },
              "[orphan] replay skipped; link not ready",
            );
          }
        }
        return;
      }
    } catch (e) {
      logger.warn({ orderId: oid, e: e.message }, "[orphan] link check failed");
    }
    try {
      const payloads = await popOrphanOrderUpdates(oid);
      if (!payloads.length) return;
      this._orphanReplayStats.replayedPayloads += payloads.length;
      this._orphanReplayStats.lastReplayAt = Date.now();
      logger.warn(
        { orderId: oid, count: payloads.length },
        "[order_update] replaying orphan updates",
      );
      for (const p of payloads) {
        const payload = p?.payload || p; // ✅ handle {payload} wrapper
        try {
          await this.onOrderUpdate(payload);
        } catch (e) {
          this._orphanReplayStats.replayFailures += 1;
          logger.warn({ orderId: oid, e: e.message }, "[orphan] replay failed");
        }
      }
    } catch (e) {
      this._orphanReplayStats.popFailures += 1;
      logger.warn({ orderId: oid, e: e.message }, "[orphan] pop failed");
    }
  }

  async _matchUnlinkedBrokerExit(order) {
    const status = String(order?.status || "").toUpperCase();
    if (status !== "COMPLETE") return null;

    const symbol = String(order?.tradingsymbol || "").toUpperCase();
    const txnType = String(order?.transaction_type || "").toUpperCase();
    const qty = Math.abs(
      Number(order?.filled_quantity ?? order?.quantity ?? 0),
    );
    if (!symbol || !txnType || !(qty > 0)) return null;

    const ms = parseOrderTimestampMs(order) || Date.now();
    const winMs = Math.max(
      15_000,
      Number(env.RECONCILE_BROKER_SQOFF_MATCH_WINDOW_SEC ?? 300) * 1000,
    );

    const actives = await getActiveTrades();
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const t of actives || []) {
      const tSymbol = String(t?.instrument?.tradingsymbol || "").toUpperCase();
      const tQty = Math.abs(Number(t?.qty ?? 0));
      const tExitSide =
        String(t?.side || "").toUpperCase() === "BUY" ? "SELL" : "BUY";
      const tStatus = String(t?.status || "").toUpperCase();
      if (!symbol || symbol !== tSymbol) continue;
      if (tQty !== qty) continue;
      if (txnType !== tExitSide) continue;
      if (
        ![STATUS.ENTRY_FILLED, STATUS.LIVE, STATUS.GUARD_FAILED].includes(
          tStatus,
        )
      )
        continue;

      const touchMs =
        parseOrderTimestampMs(t) ||
        new Date(
          t?.slOrderStatusUpdatedAt ||
            t?.updatedAt ||
            t?.createdAt ||
            Date.now(),
        ).getTime();
      const delta = Math.abs(ms - touchMs);
      if (!Number.isFinite(delta) || delta > winMs) continue;
      if (delta < bestScore) {
        bestScore = delta;
        best = t;
      }
    }

    return best;
  }

  async _closeByBrokerSquareoff(trade, order, reason = "BROKER_SQUAREOFF") {
    if (!trade?.tradeId) return false;

    const tradeId = String(trade.tradeId);
    const exitPrice = Number(
      order?.average_price ?? order?.price ?? trade?.exitPrice ?? 0,
    );
    const exitLifecycle = resolveExitLifecycle(reason, {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: String(reason || "BROKER_SQUAREOFF").toUpperCase(),
      exitAuthority: "RECONCILER",
    });
    await this._updateTrade(tradeId, {
      status: STATUS.CLOSED,
      exitPrice: exitPrice > 0 ? exitPrice : trade?.exitPrice,
      closeReason: reason,
      exitReason: reason,
      exitFamily: exitLifecycle.exitFamily,
      exitReasonCode: exitLifecycle.exitReasonCode,
      exitAuthority: exitLifecycle.exitAuthority,
      brokerSquareoffOrderId: String(order?.order_id || "") || null,
      brokerSquareoffAt: new Date(),
      exitAt: new Date(),
      closedAt: new Date(),
    });

    logger.warn(
      {
        tradeId,
        reason,
        orderId: String(order?.order_id || ""),
        symbol: order?.tradingsymbol,
        qty: order?.filled_quantity || order?.quantity,
      },
      "[reconcile] broker square-off matched and trade closed",
    );

    await this._bookRealizedPnl(tradeId);
    await this._finalizeClosed(tradeId, trade.instrument_token);
    return true;
  }

  async _panicExit(trade, reason, opts = {}) {
    return this._runTradeCommand(
      trade?.tradeId,
      EXEC_COMMAND.PANIC_EXIT,
      async () => this._panicExitImpl(trade, reason, opts),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _panicExitImpl(trade, reason, opts = {}) {
    const tradeId = trade?.tradeId;
    const tradeKey = String(tradeId || "");
    const exitLifecycle = resolveExitLifecycle(reason);
    let panicExitPlaced = false;
    let pendingMarked = false;
    try {
      if (!tradeId) return;
      if (this._panicExitInFlight.has(tradeKey) && !opts.force) {
        logger.warn({ tradeId }, "[panic] already in-flight");
        return;
      }

      // prevent repeated panic exits
      const fresh = (await getTrade(tradeId)) || trade;
      if (fresh?.panicExitOrderId && !opts.force) {
        logger.warn(
          { tradeId, panicExitOrderId: fresh.panicExitOrderId },
          "[panic] already placed",
        );
        return;
      }

      const allowWhenHalted = !!opts.allowWhenHalted;
      if (isHalted() && !allowWhenHalted) {
        logger.warn({ tradeId }, "[panic] skipped (halted)");
        return;
      }

      this._panicExitInFlight.add(tradeKey);
      await this._updateTrade(tradeId, {
        panicExitPending: true,
        panicExitState: PANIC_EXIT_STATE_PENDING,
        panicExitStartedAt: new Date(),
        panicExitReason: reason,
        ...(exitLifecycle.exitReasonCode
          ? {
              exitFamily: exitLifecycle.exitFamily,
              exitReasonCode: exitLifecycle.exitReasonCode,
              exitAuthority: exitLifecycle.exitAuthority,
            }
          : {}),
      });
      pendingMarked = true;

      // Best-effort: cancel any working orders (ENTRY/SL/TARGET) so they don't fill after we start panic exit
      try {
        const variety = String(env.DEFAULT_ORDER_VARIETY || "regular");
        const toCancel = [
          ...(opts.force ? [fresh.panicExitOrderId] : []),
          fresh.entryOrderId,
          fresh.slOrderId,
          fresh.targetOrderId,
          fresh.tp1OrderId,
          fresh.tp2OrderId,
        ].filter(Boolean);

        const cancellableStatuses = new Set([
          "OPEN",
          "TRIGGER PENDING",
          "AMO REQ RECEIVED",
          "MODIFY VALIDATION PENDING",
          "MODIFY PENDING",
          "PUT ORDER REQ RECEIVED",
        ]);

        for (const oid of toCancel) {
          try {
            const id = String(oid);
            let status = String(
              this._lastOrdersById.get(id)?.status || "",
            ).toUpperCase();
            if (!status) {
              try {
                const st = await this._getOrderStatus(id);
                status = String(
                  st?.status || st?.order?.status || "",
                ).toUpperCase();
              } catch (err) {
                reportFault({
                  code: "TRADING_TRADEMANAGER_CATCH",
                  err,
                  message: "[src/trading/tradeManager.js] caught and continued",
                });
              }
            }

            if (status && !cancellableStatuses.has(status)) {
              logger.info(
                { tradeId, orderId: id, status },
                "[panic] cancel skipped (order not cancellable)",
              );
              continue;
            }

            try {
              this.expectedCancelOrderIds.add(id);
            } catch (err) {
              reportFault({
                code: "TRADING_TRADEMANAGER_CATCH",
                err,
                message: "[src/trading/tradeManager.js] caught and continued",
              });
            }
            await this._safeCancelOrder(variety, id, {
              purpose: "PANIC_CANCEL",
              tradeId,
            });
          } catch (err) {
            reportFault({
              code: "TRADING_TRADEMANAGER_CATCH",
              err,
              message: "[src/trading/tradeManager.js] caught and continued",
            });
          }
        }
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      // Use live net qty if possible to avoid over-exiting (which can flip the position)
      let netQty = Number(fresh.qty ?? 0);
      try {
        const positions = await this.kite.getPositions();
        const net = positions?.net || positions?.day || [];

        // Build a quick lookup: instrument_token -> net quantity
        const posQtyByToken = new Map();
        for (const p of net || []) {
          const tok = Number(p?.instrument_token);
          if (!Number.isFinite(tok)) continue;
          const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
          if (!Number.isFinite(q)) continue;
          posQtyByToken.set(tok, q);
        }

        const token = Number(fresh.instrument_token);
        const p = Array.isArray(net)
          ? net.find((x) => Number(x.instrument_token) === token)
          : null;
        const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
        if (Number.isFinite(q)) netQty = q;
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      if (!Number.isFinite(netQty) || netQty === 0) {
        // Nothing to exit -> close the trade record to unblock signals
        await this._updateTrade(tradeId, {
          status: STATUS.CLOSED,
          closeReason: `PANIC_EXIT_SKIPPED_NO_POSITION | ${reason}`,
          exitReason: "PANIC_EXIT",
          exitFamily: exitLifecycle.exitFamily ?? "LOSS_CONTAINMENT",
          exitReasonCode: exitLifecycle.exitReasonCode ?? "PANIC_EXIT",
          exitAuthority: exitLifecycle.exitAuthority ?? "PANIC_EXIT_ENGINE",
          panicExitPending: false,
          panicExitState: STATUS.PANIC_EXIT_CONFIRMED,
          closedAt: new Date(),
        });
        pendingMarked = false;
        await this._finalizeClosed(tradeId, Number(fresh.instrument_token));
        return;
      }

      const instrument = fresh.instrument;
      const exitSide = netQty > 0 ? "SELL" : "BUY";
      const qty = Math.abs(netQty);
      const exitProduct = this._activeTradeProduct(fresh);

      const isTimeStopReason =
        !!opts.timeStop ||
        String(reason || "")
          .toUpperCase()
          .startsWith("TIME_STOP");
      const preferLimit =
        !!opts.preferLimit ||
        (isTimeStopReason &&
          String(env.TIME_STOP_EXIT_PREFER_LIMIT || "true") !== "false");
      const allowLimitFallback =
        String(env.PANIC_EXIT_LIMIT_FALLBACK_ENABLED || "true") !== "false";
      const allowMarketFallback =
        !isTimeStopReason ||
        String(env.TIME_STOP_EXIT_ALLOW_MARKET_FALLBACK || "true") !== "false";

      logger.warn(
        { tradeId, reason, exitSide, qty, isTimeStopReason, preferLimit },
        "[panic] placing exit",
      );
      alert("warn", `PANIC EXIT: ${reason}`, { tradeId }).catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });

      let exitOrderId = null;
      const attemptLimit = async (marketError = "MARKET_SKIPPED") => {
        if (!allowLimitFallback || exitOrderId) return;
        const fb = await this._panicExitFallbackLimit({
          tradeId,
          instrument,
          exitSide,
          qty,
          reason,
          marketError,
          product: exitProduct,
        });
        exitOrderId = fb?.orderId || null;
      };

      if (preferLimit) {
        try {
          await attemptLimit("TIME_STOP_CONTROLLED_LIMIT");
        } catch (e) {
          logger.error(
            { tradeId, reason, e: String(e?.message || e) },
            "[panic] preferred LIMIT exit failed",
          );
        }
      }

      const canUseMarket =
        !isTimeStopReason ||
        (await this._allowTimeStopMarketExit({
          tradeId,
          instrument,
          exitSide,
        }));

      if (!exitOrderId && allowMarketFallback && canUseMarket) {
        try {
          const r = await this._safePlaceOrder(
            env.DEFAULT_ORDER_VARIETY,
            {
              exchange: instrument.exchange,
              tradingsymbol: instrument.tradingsymbol,
              transaction_type: exitSide,
              quantity: qty,
              product: exitProduct,
              order_type: "MARKET",
              validity: "DAY",
              tag: makeTag(tradeId, "PANIC_EXIT"),
            },
            { purpose: "PANIC_EXIT", tradeId },
          );
          exitOrderId = r?.orderId || null;
        } catch (e) {
          const msg = String(e?.message || e);
          logger.error(
            { tradeId, reason, exitSide, qty, e: msg },
            "[panic] MARKET exit failed; attempting LIMIT fallback",
          );
          try {
            await attemptLimit(msg);
          } catch (e2) {
            logger.error(
              { tradeId, reason, e: String(e2?.message || e2) },
              "[panic] LIMIT fallback failed",
            );
          }
          if (!exitOrderId) throw e;
        }
      }

      if (!exitOrderId && allowLimitFallback) {
        await attemptLimit("MARKET_DISABLED_OR_BLOCKED");
      }

      if (!exitOrderId) {
        throw new Error("panic_exit_not_placed");
      }

      if (exitOrderId) {
        panicExitPlaced = true;
        await this._updateTrade(tradeId, {
          status: STATUS.PANIC_EXIT_PLACED,
          panicExitPending: false,
          panicExitState: STATUS.PANIC_EXIT_PLACED,
          panicExitOrderId: exitOrderId,
          panicExitPlacedAt: new Date(),
          exitPlacedAt: new Date(),
          closeReason: `PANIC_EXIT_PLACED | ${reason}`,
          exitFamily: exitLifecycle.exitFamily ?? null,
          exitReasonCode: exitLifecycle.exitReasonCode ?? null,
          exitAuthority: exitLifecycle.exitAuthority ?? "PANIC_EXIT_ENGINE",
        });
        pendingMarked = false;
        await linkOrder({
          order_id: exitOrderId,
          tradeId,
          role: "PANIC_EXIT",
        });
        await this._replayOrphanUpdates(exitOrderId);
        this._clearTimeStopFallback(tradeId);
        this._schedulePanicExitWatch({
          tradeId,
          orderId: exitOrderId,
          instrument,
          exitSide,
          qty,
          reason,
        });
      }
    } catch (e) {
      logger.error({ tradeId, e: e.message }, "[panic] exit failed");
      if (pendingMarked && !panicExitPlaced) {
        try {
          await this._updateTrade(tradeId, {
            panicExitPending: false,
            panicExitState: null,
          });
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }
    } finally {
      if (!panicExitPlaced) {
        this._panicExitInFlight.delete(tradeKey);
      }
    }
  }

  async _allowTimeStopMarketExit({ tradeId, instrument, exitSide }) {
    try {
      if (!this.kite || typeof this.kite.getQuote !== "function") return false;
      const ex = instrument?.exchange || env.DEFAULT_EXCHANGE || "NSE";
      const sym = instrument?.tradingsymbol;
      const key = `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}`;
      const resp = await this.kite.getQuote([key]);
      const q = resp?.[key] || {};
      const bid = Number(q?.depth?.buy?.[0]?.price ?? 0);
      const ask = Number(q?.depth?.sell?.[0]?.price ?? 0);
      const ltp = Number(q?.last_price ?? 0);
      const ref =
        Number.isFinite(ltp) && ltp > 0 ? ltp : exitSide === "SELL" ? bid : ask;
      const spreadBps =
        Number.isFinite(ref) &&
        ref > 0 &&
        Number.isFinite(bid) &&
        bid > 0 &&
        Number.isFinite(ask) &&
        ask > 0
          ? ((ask - bid) / ref) * 10000
          : Infinity;
      const maxSpreadBps = Math.max(
        1,
        Number(env.TIME_STOP_EXIT_MARKET_MAX_SPREAD_BPS ?? 45),
      );
      const ok = spreadBps <= maxSpreadBps;
      if (!ok) {
        logger.warn(
          { tradeId, spreadBps, maxSpreadBps, bid, ask, ltp },
          "[panic] time-stop MARKET blocked by spread guard",
        );
      }
      return ok;
    } catch (e) {
      logger.warn(
        { tradeId, e: String(e?.message || e) },
        "[panic] time-stop MARKET guard failed; blocking MARKET",
      );
      return false;
    }
  }

  async _panicExitFallbackLimit({
    tradeId,
    instrument,
    exitSide,
    qty,
    reason,
    marketError,
    product = null,
    bufferTicks = null,
    maxBps = null,
    orderTag = "PANIC_EXIT",
  }) {
    if (!this.kite || typeof this.kite.getQuote !== "function") {
      throw new Error("no_getQuote_for_panic_fallback");
    }

    const ex = instrument?.exchange || env.DEFAULT_EXCHANGE || "NSE";
    const sym = instrument?.tradingsymbol;
    const key = `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}`;

    const tick = Number(instrument?.tick_size ?? 0.05);
    const bufTicks = Math.max(
      1,
      Number(
        bufferTicks == null
          ? (env.PANIC_EXIT_LIMIT_BUFFER_TICKS ?? 2)
          : bufferTicks,
      ),
    );
    const maxBpsCap = Math.max(
      50,
      Number(maxBps == null ? (env.PANIC_EXIT_LIMIT_MAX_BPS ?? 250) : maxBps),
    );

    const resp = await this.kite.getQuote([key]);
    const q = resp?.[key];
    const bid = Number(q?.depth?.buy?.[0]?.price);
    const ask = Number(q?.depth?.sell?.[0]?.price);
    const ltp = Number(q?.last_price);

    // Choose an aggressive LIMIT price that is very likely to execute immediately.
    // SELL -> at/under bid; BUY -> at/over ask.
    let pxBase = null;
    if (exitSide === "SELL") {
      if (Number.isFinite(bid) && bid > 0) pxBase = bid;
      else if (Number.isFinite(ltp) && ltp > 0) pxBase = ltp;
    } else {
      if (Number.isFinite(ask) && ask > 0) pxBase = ask;
      else if (Number.isFinite(ltp) && ltp > 0) pxBase = ltp;
    }

    if (!Number.isFinite(pxBase) || pxBase <= 0) {
      throw new Error("panic_fallback_no_price");
    }

    // Apply buffer (cross the spread + a little extra).
    const buf = bufTicks * tick;
    let price = exitSide === "SELL" ? pxBase - buf : pxBase + buf;

    // Guard against crazy prices (cap by maxBps vs base).
    const cap = (pxBase * maxBpsCap) / 10000;
    if (exitSide === "SELL") price = Math.max(pxBase - cap, price);
    else price = Math.min(pxBase + cap, price);

    // Round to tick size.
    price = roundToTick(price, tick);

    logger.warn(
      {
        tradeId,
        reason,
        marketError,
        exitSide,
        qty,
        bid,
        ask,
        ltp,
        price,
        tick,
        bufTicks,
      },
      "[panic] LIMIT fallback placing",
    );

    alert("warn", `🚨 PANIC EXIT fallback (LIMIT): ${reason}`, {
      tradeId,
      marketError,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    const { orderId } = await this._safePlaceOrder(
      env.DEFAULT_ORDER_VARIETY,
      {
        exchange: instrument.exchange,
        tradingsymbol: instrument.tradingsymbol,
        transaction_type: exitSide,
        quantity: qty,
        product: String(product || env.DEFAULT_PRODUCT || "MIS").toUpperCase(),
        order_type: "LIMIT",
        price,
        validity: "DAY",
        tag: makeTag(tradeId, orderTag),
      },
      { purpose: "PANIC_EXIT_LIMIT_FALLBACK", tradeId },
    );

    return { ok: !!orderId, orderId, price };
  }

  /**
   * Restart safety:
   * - fetch open orders + positions
   * - rebuild internal state
   * - ensure we don't double-place trades after restart
   *
   * NOTE: If an open position exists but we can't map it to an active trade,
   * we set kill-switch and create a "recovery" trade record (no new orders placed).
   */
  async reconcile(tokens = []) {
    if (this._stopped) return { ok: false, reason: "STOPPED" };
    await this.init();
    if (this._stopped) return { ok: false, reason: "STOPPED" };

    // 1) Read today's orders (used for mapping existing entry/sl/target)
    const orders = await this.kite.getOrders();
    const byId = new Map(
      (orders || []).map((o) => [String(o.order_id || o.orderId), o]),
    );
    this._lastOrdersById = byId;

    // 2) Read positions (net positions)
    let positions = null;
    try {
      positions = await this.kite.getPositions();
    } catch (e) {
      logger.warn(
        { e: e.message },
        "[reconcile] getPositions failed (continuing with orders only)",
      );
    }

    const net = positions?.net || positions?.day || [];

    // Build a quick lookup: instrument_token -> net quantity
    const posQtyByToken = new Map();
    for (const p of net || []) {
      const tok = Number(p?.instrument_token);
      if (!Number.isFinite(tok)) continue;
      const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
      if (!Number.isFinite(q)) continue;
      posQtyByToken.set(tok, q);
    }

    // 3) Fetch active trades first
    const actives = await getActiveTrades();
    const factGate = await this._globalFactRecoveryGate(byId, {
      actives,
      scheduleRetry: false,
    });
    if (!factGate.ok) {
      logger.warn(
        { blockers: factGate.blockers },
        "[reconcile] fact recovery gate blocked active-trade processing",
      );
      this._scheduleReconcile("fact_recovery_gate");
      return factGate;
    }
    await this._restoreDynamicExitState(actives);
    await this._persistLiveOrderSnapshotsForTrades(actives, byId, "reconcile");

    this._syncRiskFromPositions(posQtyByToken, actives);
    await this._monitorPortfolioRisk("reconcile");
    await this._maybeHardFlatOnRestart(net);

    // 4) If broker shows open positions but we have no active trade in DB -> kill-switch (institutional safety)
    // This is more robust than scanning only the configured "tokens" list.
    if (!this.activeTradeId && Array.isArray(net) && actives.length === 0) {
      const open = (net || []).filter((p) => {
        const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
        if (!Number.isFinite(qty) || qty === 0) return false;
        if (p?.product)
          return String(p.product) === String(env.DEFAULT_PRODUCT);
        return true;
      });

      if (open.length) {
        const p = open[0];
        const token = Number(p?.instrument_token);
        const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
        if (!Number.isFinite(token) || !Number.isFinite(qty) || qty === 0) {
          logger.error(
            { p },
            "[reconcile] open position found but token/qty invalid",
          );
        } else {
          let instrument = null;
          try {
            instrument = await ensureInstrument(this.kite, token);
          } catch (e) {
            logger.warn(
              { token, e: e?.message || String(e) },
              "[reconcile] ensureInstrument failed",
            );
          }

          const tradeId = crypto.randomUUID();
          const side = qty > 0 ? "BUY" : "SELL";
          const avg = Number(
            p?.average_price ?? p?.buy_price ?? p?.sell_price ?? 0,
          );

          this.recoveredPosition = {
            instrument_token: token,
            exchange: instrument?.exchange || String(p?.exchange || ""),
            tradingsymbol:
              instrument?.tradingsymbol || String(p?.tradingsymbol || ""),
            qty,
            avgPrice: avg,
            openPositionsCount: open.length,
          };

          logger.error(
            { ...this.recoveredPosition },
            "[reconcile] OPEN POSITION FOUND without active trade. Adopting recovery trade.",
          );
          alert(
            "error",
            "⚠️ OPEN POSITION FOUND without active trade (adopting recovery trade)",
            this.recoveredPosition,
          ).catch((err) => {
            reportFault({
              code: "TRADING_TRADEMANAGER_ASYNC",
              err,
              message: "[src/trading/tradeManager.js] async task failed",
            });
          });

          const recoveryRiskKey = this._buildRiskKey({
            strategyId: "recovery",
            underlying:
              instrument?.name || instrument?.tradingsymbol || p?.tradingsymbol,
            token,
          });

          this.risk.setOpenPosition(recoveryRiskKey, {
            tradeId,
            side,
            qty: Math.abs(qty),
          });
          this.activeTradeId = tradeId;

          const absQty = Math.abs(qty);
          const avgPrice = Number(avg ?? 0);
          const riskStop =
            Number.isFinite(avgPrice) && avgPrice > 0
              ? this._computeRiskStopLoss({
                  entryPrice: avgPrice,
                  side,
                  instrument,
                  qty: absQty,
                  riskInr: Number(env.RISK_PER_TRADE_INR ?? 0),
                })
              : null;
          const stopLoss = riskStop?.stopLoss || null;

          await insertTrade({
            tradeId,
            instrument_token: token,
            instrument,
            strategyId: "recovery",
            tradeType: "RECOVERY_TRADE",
            riskKey: recoveryRiskKey,
            underlying_symbol: instrument?.name || null,
            side,
            qty: absQty,
            candle: null,
            ...this._buildStopSemanticsPatch({
              strategyStopLoss: stopLoss,
              sizingStopLoss: stopLoss,
              brokerStopLoss: stopLoss,
            }),
            initialStrategyRiskPts: riskStop?.riskPts ?? null,
            initialStrategyRiskInr: riskStop?.riskInr ?? null,
            oneLotPlannedRiskInr: riskStop?.riskInr ?? null,
            riskBudgetInr: Number(env.RISK_PER_TRADE_INR ?? 0),
            riskFitMode: "RECOVERY",
            riskBreachState: "NONE",
            slCompressionPct: null,
            postFillTrueRiskInr: riskStop?.riskInr ?? null,
            postFillRiskCapInr: Number(env.RISK_PER_TRADE_INR ?? 0),
            postFillRiskAction: "NONE",
            beEligible: false,
            beLockHit: false,
            trailHit: false,
            profitLockArmed: false,
            greenLockActive: false,
            mfeLockTier: 0,
            trailActive: false,
            givebackActive: false,
            desiredStopLoss: null,
            finalStopLoss: null,
            hardFloor: null,
            structureTrailFloor: null,
            structureTrailSource: null,
            structureTrailAllowed: false,
            protectionGateOpen: false,
            winnerModeActive: false,
            exitFamily: null,
            exitReasonCode: null,
            exitAuthority: null,
            rr: null,
            status: STATUS.RECOVERY_REHYDRATED,
            entryOrderId: null,
            slOrderId: null,
            targetOrderId: null,
            entryPrice: avgPrice || null,
            exitPrice: null,
            decisionAt: new Date(),
            entryAt: new Date(),
            recoveryReason: "RECOVERY_ADOPTED_OPEN_POSITION",
            recoveredAt: new Date(),
          });

          if (Number.isFinite(stopLoss) && stopLoss > 0) {
            try {
              await this._placeExitsIfMissing({
                tradeId,
                instrument_token: token,
                instrument,
                side,
                qty: absQty,
                stopLoss,
                entryPrice: avgPrice || null,
              });
              await this._ensureExitQty(tradeId, absQty);
            } catch (e) {
              logger.warn(
                { tradeId, token, e: e.message },
                "[reconcile] recovery exits placement failed",
              );
            }
          }
        }
      }
    }

    // 5) Normal reconciliation for active trades from DB
    for (const t of actives) {
      await this._reconcileTrade(t, byId, posQtyByToken);
    }
  }

  async _cancelRemainingExitsOnce(trade, reason) {
    const tradeId = trade?.tradeId;
    if (!tradeId) return;

    // Avoid spamming cancel requests every tick
    if (trade.ocoCleanupAt) return;

    await this._updateTrade(tradeId, {
      ocoCleanupAt: new Date(),
      ocoCleanupReason: String(reason || "OCO_CLEANUP"),
    });

    const variety = String(env.DEFAULT_ORDER_VARIETY || "regular");
    const ids = [
      trade.slOrderId,
      trade.targetOrderId,
      trade.tp1OrderId,
      trade.tp2OrderId,
    ].filter(Boolean);

    for (const oid of ids) {
      try {
        this.expectedCancelOrderIds.add(String(oid));
        await this._safeCancelOrder(variety, oid, {
          purpose: "OCO_CLEANUP_CANCEL",
          tradeId,
          reason: String(reason || "OCO_CLEANUP"),
        });
      } catch {
        // ignore
      }
    }
  }

  async _handleOcoDoubleFill(trade, filledRole, order) {
    const tradeId = trade?.tradeId;
    const token = Number(trade?.instrument_token);
    const orderId = order?.order_id;

    logger.error(
      { tradeId, token, filledRole, orderId, status: trade?.status },
      "[oco] DOUBLE-FILL detected (both exits may have filled) -> emergency flatten + halt",
    );

    alert(
      "error",
      "🚨 OCO DOUBLE-FILL detected (exit race) -> flatten + halt",
      { tradeId, token, filledRole, orderId, status: trade?.status },
    ).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    try {
      await this._updateTrade(tradeId, {
        ocoDoubleFillDetected: true,
        ocoDoubleFillRole: String(filledRole || ""),
        ocoDoubleFillOrderId: orderId ? String(orderId) : null,
        ocoDoubleFillAt: new Date(),
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    await this.setKillSwitch(true, "OCO_DOUBLE_FILL");
    await this._panicExit(trade, "OCO_DOUBLE_FILL", { allowWhenHalted: true });
    await halt("OCO_DOUBLE_FILL", { tradeId, token, filledRole, orderId });
  }

  async positionFirstReconcile(source = "oco_tick") {
    if (this._stopped) return { ok: false, reason: "STOPPED" };
    // Position-first reconciler:
    // - if position is flat -> cancel remaining exits
    // - if position is reversed / over-exited -> emergency flatten + halt

    const enabled =
      String(env.OCO_POSITION_RECONCILER_ENABLED || "true") !== "false";
    if (!enabled) return;

    if (this._ocoReconcileInFlight) return;
    this._ocoReconcileInFlight = true;
    try {
      if (!this.kite || typeof this.kite.getPositions !== "function") return;

      const winSec = Number(env.OCO_RECENT_CLOSED_WINDOW_SEC ?? 120);
      const now = Date.now();

      const watchTradeIds = [];
      if (this.activeTradeId) watchTradeIds.push(this.activeTradeId);
      if (
        this.lastClosedTradeId &&
        this.lastClosedTradeId !== this.activeTradeId &&
        winSec > 0 &&
        now - Number(this.lastClosedAt ?? 0) <= winSec * 1000
      ) {
        watchTradeIds.push(this.lastClosedTradeId);
      }
      if (!watchTradeIds.length) return;

      // Fetch positions once
      let positions;
      try {
        positions = await this.kite.getPositions();
      } catch (e) {
        logger.warn(
          { e: e?.message || String(e) },
          "[oco] getPositions failed",
        );
        return;
      }

      const net = positions?.net || positions?.day || [];
      const posQtyByToken = new Map();
      for (const p of net || []) {
        const tok = Number(p?.instrument_token);
        if (!Number.isFinite(tok)) continue;
        const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
        if (!Number.isFinite(q)) continue;
        posQtyByToken.set(tok, q);
      }

      for (const tradeId of watchTradeIds) {
        const trade = await getTrade(tradeId);
        if (!trade) continue;
        const token = Number(trade.instrument_token);
        const netQty = Number(posQtyByToken.get(token) ?? 0);
        const expectedQty = Math.abs(Number(trade.qty ?? 0));
        const expectedSign =
          String(trade.side || "").toUpperCase() === "SELL" ? -1 : 1;

        // If trade is terminal, we expect broker position == 0
        const isTerminal = [
          STATUS.EXITED_TARGET,
          STATUS.EXITED_SL,
          STATUS.ENTRY_FAILED,
          STATUS.ENTRY_CANCELLED,
          STATUS.CLOSED,
        ].includes(trade.status);

        // SL watchdog heartbeat (handles restarts / tick gaps): if SL-L triggered but not filled -> flatten.
        try {
          this._slWatchdogHeartbeat(trade, netQty, source);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
        try {
          this._targetWatchdogHeartbeat(trade, netQty, source);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }

        if (netQty === 0) {
          // cancel any remaining exits ASAP (reduces accidental re-entry via dangling SL/TGT)
          if (
            trade.slOrderId ||
            trade.targetOrderId ||
            trade.tp1OrderId ||
            trade.tp2OrderId
          ) {
            await this._cancelRemainingExitsOnce(
              trade,
              `POSITION_FLAT_${source}`,
            );
          }

          // If trade still thinks it's active, verify exit state first (grace + history) before fatal mismatch.
          if (
            [STATUS.ENTRY_FILLED, STATUS.LIVE, STATUS.GUARD_FAILED].includes(
              trade.status,
            )
          ) {
            const flatCheck =
              await this._isFlatStateLikelyExitInProgress(trade);
            if (flatCheck?.benign) {
              logger.warn(
                {
                  tradeId,
                  token,
                  status: trade.status,
                  reason: flatCheck.reason,
                },
                "[oco] broker flat observed during exit processing; skipping fatal mismatch",
              );
              continue;
            }

            logger.error(
              { tradeId, token, status: trade.status },
              "[oco] broker position flat while trade is active (state mismatch)",
            );
            this._recordTradeDecision({
              trade,
              token,
              outcome: "BLOCKED",
              stage: "reconcile",
              reason: "OCO_BROKER_POSITION_FLAT",
              meta: { status: trade.status, source },
            });
            await this.setKillSwitch(true, "OCO_BROKER_POSITION_FLAT");
            await upsertDailyRisk(todayKey(), {
              kill: true,
              reason: "OCO_BROKER_POSITION_FLAT",
              lastTradeId: tradeId,
            });
            // Best-effort close record so engine does not keep thinking we have a position
            await this._updateTrade(tradeId, {
              status: STATUS.CLOSED,
              closeReason: "OCO_BROKER_POSITION_FLAT",
              exitReason: "RECONCILE_EXIT",
              exitFamily: "LOSS_CONTAINMENT",
              exitReasonCode: "RECONCILE_EXIT",
              exitAuthority: "RECONCILER",
              exitAt: new Date(),
              closedAt: new Date(),
            });
            await this._finalizeClosed(tradeId, token);
          }
          continue;
        }

        // Non-zero position: if trade is terminal, this is leftover exposure.
        if (isTerminal) {
          logger.error(
            { tradeId, token, netQty, status: trade.status },
            "[oco] broker position non-zero after trade is terminal (leftover exposure)",
          );
          await this.setKillSwitch(true, "OCO_LEFTOVER_POSITION_AFTER_CLOSE");
          await this._updateTrade(tradeId, {
            ocoResidualPosition: netQty,
            ocoResidualDetectedAt: new Date(),
          });
          await this._panicExit(trade, "OCO_LEFTOVER_POSITION_AFTER_CLOSE", {
            allowWhenHalted: true,
          });
          await halt("OCO_LEFTOVER_POSITION_AFTER_CLOSE", {
            tradeId,
            token,
            netQty,
            source,
          });
          continue;
        }

        // Active trade: detect sign flip (double-exit OCO race) or size anomaly
        const flipped = expectedSign * netQty < 0;
        const tooBig = expectedQty > 0 && Math.abs(netQty) > expectedQty;

        if (flipped || tooBig) {
          logger.error(
            {
              tradeId,
              token,
              netQty,
              expectedQty,
              expectedSign,
              status: trade.status,
            },
            "[oco] position mismatch (possible double-exit / over-exit)",
          );
          this._recordTradeDecision({
            trade,
            token,
            outcome: "BLOCKED",
            stage: "reconcile",
            reason: "OCO_POSITION_MISMATCH",
            meta: {
              netQty,
              expectedQty,
              expectedSign,
              source,
            },
          });
          await this.setKillSwitch(true, "OCO_POSITION_MISMATCH");
          await this._updateTrade(tradeId, {
            ocoMismatchDetectedAt: new Date(),
            ocoMismatchNetQty: netQty,
            ocoMismatchExpectedQty: expectedQty,
            ocoMismatchExpectedSign: expectedSign,
          });
          await this._panicExit(trade, "OCO_POSITION_MISMATCH", {
            allowWhenHalted: true,
          });
          await halt("OCO_POSITION_MISMATCH", {
            tradeId,
            token,
            netQty,
            expectedQty,
            expectedSign,
            source,
          });
          continue;
        }
      }
    } finally {
      this._ocoReconcileInFlight = false;
    }
  }

  async _reconcileTrade(trade, byId, posQtyByToken) {
    return this._runTradeCommand(
      trade?.tradeId,
      EXEC_COMMAND.RECONCILE_DIFF_RESOLUTION,
      async () => this._reconcileTradeImpl(trade, byId, posQtyByToken),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _reconcileTradeImpl(trade, byId, posQtyByToken) {
    const tradeId = trade.tradeId;
    const token = Number(trade.instrument_token);
    const hasPosInfo = posQtyByToken instanceof Map;
    const netQty = hasPosInfo ? Number(posQtyByToken.get(token) ?? 0) : null;

    await this._virtualTargetHeartbeat(trade, netQty, "reconcile");
    const optEnforced = await this._enforceOptVirtualTargetMode(
      trade,
      "reconcile",
    );
    if (optEnforced?.targetOrderCleared) {
      trade.targetOrderId = null;
      trade.targetOrderType = null;
    }
    if (optEnforced?.applied && !trade?.targetVirtual) {
      trade.targetVirtual = true;
    }

    const panic = trade.panicExitOrderId
      ? byId.get(String(trade.panicExitOrderId))
      : null;
    const entry = trade.entryOrderId
      ? byId.get(String(trade.entryOrderId))
      : null;
    const sl = trade.slOrderId ? byId.get(String(trade.slOrderId)) : null;
    const tgt = trade.targetOrderId
      ? byId.get(String(trade.targetOrderId))
      : null;
    const tp1 = trade.tp1OrderId ? byId.get(String(trade.tp1OrderId)) : null;

    // If broker shows NO position but trade thinks it's live/filled, someone manually exited
    // (or RMS square-off happened). Treat as a critical safety event: kill-switch + close trade.
    if (
      hasPosInfo &&
      netQty === 0 &&
      [STATUS.ENTRY_FILLED, STATUS.LIVE, STATUS.GUARD_FAILED].includes(
        trade.status,
      )
    ) {
      const flatCheck = await this._isFlatStateLikelyExitInProgress(
        trade,
        byId,
      );
      if (flatCheck?.benign) {
        logger.warn(
          { tradeId, token, status: trade.status, reason: flatCheck.reason },
          "[reconcile] broker flat observed during exit processing; waiting",
        );
        return;
      }

      logger.error(
        { tradeId, token, status: trade.status },
        "[reconcile] broker position flat while trade is active (manual exit / RMS?)",
      );
      alert(
        "error",
        "🛑 Broker position is flat but trade is active -> kill-switch",
        {
          tradeId,
          token,
          status: trade.status,
        },
      ).catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });
      this.risk.setKillSwitch(true);
      await upsertDailyRisk(todayKey(), {
        kill: true,
        reason: "BROKER_POSITION_FLAT_MANUAL_EXIT",
        lastTradeId: tradeId,
      });

      // Best-effort cancel any remaining legs
      for (const [role, oid] of [
        ["ENTRY", trade.entryOrderId],
        ["SL", trade.slOrderId],
        ["TP1", trade.tp1OrderId],
        ["TARGET", trade.targetOrderId],
        ["PANIC_EXIT", trade.panicExitOrderId],
      ]) {
        if (!oid) continue;
        try {
          const o = byId.get(String(oid));
          const st = String(o?.status || "").toUpperCase();
          if (st === "COMPLETE" || isDead(st)) continue;
          this.expectedCancelOrderIds.add(String(oid));
          await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, oid, {
            purpose: `CANCEL_${role}_ON_FLAT`,
            tradeId,
          });
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }

      await this._updateTrade(tradeId, {
        status: STATUS.CLOSED,
        closeReason: "BROKER_POSITION_FLAT_MANUAL_EXIT",
        exitReason: "RECONCILE_EXIT",
        exitFamily: "LOSS_CONTAINMENT",
        exitReasonCode: "RECONCILE_EXIT",
        exitAuthority: "RECONCILER",
        exitAt: new Date(),
        closedAt: new Date(),
      });
      await this._finalizeClosed(tradeId, token);
      return;
    }

    // If we are in GUARD_FAILED, keep reconciling PANIC exit order after restarts.
    if (trade.status === STATUS.GUARD_FAILED) {
      if (panic) {
        const ps = String(panic.status || "").toUpperCase();
        if (ps === "COMPLETE") {
          this._clearPanicExitWatch(tradeId);
          this._panicExitRetryCount.delete(String(tradeId));
          const exitPrice = Number(panic.average_price ?? panic.price ?? 0);
          await this._updateTrade(tradeId, {
            status: STATUS.CLOSED,
            exitPrice: exitPrice > 0 ? exitPrice : trade.exitPrice,
            closeReason:
              (trade.closeReason || "GUARD_FAILED") + " | PANIC_FILLED",
            exitReason: "PANIC_EXIT",
            exitAt: new Date(),
            closedAt: new Date(),
          });
          await this._bookRealizedPnl(tradeId);
          await this._finalizeClosed(tradeId, token);
          return;
        }

        if (isDead(ps)) {
          this._clearPanicExitWatch(tradeId);
          this._panicExitRetryCount.delete(String(tradeId));
          logger.error(
            { tradeId, token, status: ps },
            "[reconcile] PANIC_EXIT order is dead while in GUARD_FAILED",
          );
          // keep kill-switch; operator must intervene
          return;
        }

        // OPEN / TRIGGER PENDING / PARTIAL etc -> wait for updates
        return;
      }

      // No panic order id; if position still exists, try again
      if (hasPosInfo && netQty !== 0) {
        await this._panicExit(trade, "RECONCILE_GUARD_FAILED");
      }
      return;
    }

    // If ENTRY got rejected/cancelled/lapsed while we were offline (or we missed order_update),
    // close the trade so we don't keep treating it as "active" after restart.
    if (
      [STATUS.ENTRY_PLACED, STATUS.ENTRY_OPEN, STATUS.ENTRY_REPLACED].includes(
        trade.status,
      )
    ) {
      if (!trade.entryOrderId) {
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_FAILED,
          closeReason: "ENTRY_ORDER_ID_MISSING_ON_RESTART",
        });
        await this._finalizeClosed(tradeId, trade.instrument_token);
        return;
      }

      let entryStatus = entry?.status;
      let entryMsg = entry?.status_message_raw || entry?.status_message || null;

      // Sometimes getOrders() may not include a just-rejected order; try history as fallback.
      if (!entryStatus && typeof this.kite.getOrderHistory === "function") {
        try {
          const hist = await this.kite.getOrderHistory(trade.entryOrderId);
          const last = Array.isArray(hist) ? hist[hist.length - 1] : null;
          entryStatus = last?.status;
          entryMsg =
            last?.status_message_raw || last?.status_message || entryMsg;
        } catch {
          // ignore
        }
      }

      if (entryStatus && isDead(entryStatus)) {
        const entryStatusUpper = String(entryStatus).toUpperCase();
        const isRejected = entryStatusUpper === "REJECTED";
        await this._updateTrade(tradeId, {
          status: isRejected ? STATUS.ENTRY_FAILED : STATUS.ENTRY_CANCELLED,
          closeReason: `ENTRY_${entryStatusUpper}${
            entryMsg ? " | " + String(entryMsg) : ""
          }`,
        });
        await this._finalizeClosed(tradeId, trade.instrument_token);
        return;
      }
      // If ENTRY is partially filled (or OPEN with partial fills) while we were offline,
      // place/adjust protective exits for the filled quantity.
      const es = String(entryStatus || "").toUpperCase();
      const filledNow = Number(entry?.filled_quantity ?? 0);
      if ((es === "PARTIAL" || es === "OPEN") && filledNow > 0) {
        const avgNow = Number(
          entry?.average_price ?? trade.entryPrice ?? trade.candle?.close,
        );
        await this._finalizeEntryFill({
          tradeId,
          trade,
          avgPrice:
            Number.isFinite(avgNow) && avgNow > 0 ? avgNow : trade.entryPrice,
          filledQty: filledNow,
          source: "RECONCILE_ENTRY_PARTIAL",
          partial: true,
        });
        return;
      }
    }

    // Entry filled but exits missing -> place exits
    if (
      entry &&
      String(entry.status).toUpperCase() === "COMPLETE" &&
      trade.status !== STATUS.LIVE
    ) {
      const avg = Number(
        entry.average_price ?? trade.entryPrice ?? trade.candle?.close,
      );
      const filledQty = Number(entry.filled_quantity ?? trade.qty);
      await this._finalizeEntryFill({
        tradeId,
        trade,
        avgPrice: avg,
        filledQty,
        source: "RECONCILE_ENTRY_COMPLETE",
        partial: false,
      });
      return;
    }

    // TP1 filled -> transition to runner stage (scale-out)
    if (
      tp1 &&
      String(tp1.status).toUpperCase() === "COMPLETE" &&
      !trade.tp1Done
    ) {
      await this._onTp1Filled(tradeId, trade, tp1);
      return;
    }

    // TP1 dead -> abort scale-out and fallback to a single TARGET (SL still protects)
    if (
      tp1 &&
      isDead(tp1.status) &&
      String(tp1.status).toUpperCase() !== "COMPLETE" &&
      !trade.tp1Done
    ) {
      await this._updateTrade(tradeId, {
        tp1Aborted: true,
        tp1DeadReason: "TP1_" + String(tp1.status).toUpperCase(),
      });
      if (this._isTargetRequired() && !trade.targetOrderId) {
        try {
          await this._placeTargetOnly(trade);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }
      return;
    }

    // One leg filled -> OCO cancel other and close
    if (tgt && String(tgt.status).toUpperCase() === "COMPLETE") {
      await this._onTargetFilled(tradeId, trade, tgt);
      return;
    }
    if (sl && String(sl.status).toUpperCase() === "COMPLETE") {
      await this._onSlFilled(tradeId, trade, sl);
      return;
    }

    if (trade.status === STATUS.LIVE) {
      // SL dead => immediate guard fail + panic
      if (
        sl &&
        isDead(sl.status) &&
        String(sl.status).toUpperCase() !== "COMPLETE"
      ) {
        await this._guardFail(trade, "SL_" + String(sl.status).toUpperCase());
        return;
      }

      // TARGET dead => replace (do NOT panic; SL remains protection)
      if (
        tgt &&
        isDead(tgt.status) &&
        String(tgt.status).toUpperCase() !== "COMPLETE"
      ) {
        await this._handleDeadTarget(trade, tgt, "reconcile");
        return;
      }

      // If exits missing (rare), place them
      if (
        !trade.slOrderId ||
        (this._isTargetRequired() && !trade.targetOrderId)
      ) {
        await this._placeExitsIfMissing(trade);
      }

      // Dynamic trailing SL / target adjustments (throttled)
      await this._maybeDynamicAdjustExits(trade, byId);
    }
  }

  _trackDynExitCadence(kind, ts = Date.now()) {
    const st = this._dynExitCadenceStats;
    const arr = kind === "modify" ? st.modifyTs : st.evalTs;
    const iv = kind === "modify" ? st.modifyIntervalsMs : st.evalIntervalsMs;
    const lastKey = kind === "modify" ? "lastModifyAt" : "lastEvalAt";

    const prev = Number(st[lastKey] ?? 0);
    if (prev > 0 && ts >= prev) iv.push(ts - prev);
    st[lastKey] = ts;

    arr.push(ts);
    const cutoff = ts - st.burstWindowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();

    if (kind === "modify")
      st.maxModifyBurst = Math.max(st.maxModifyBurst, arr.length);
    else st.maxEvalBurst = Math.max(st.maxEvalBurst, arr.length);

    const maxSamples = 200;
    if (iv.length > maxSamples) iv.splice(0, iv.length - maxSamples);
  }

  _dynExitCadenceSnapshot() {
    const st = this._dynExitCadenceStats;
    return {
      attempts: st.attempts,
      evalRuns: st.evalRuns,
      modifyRuns: st.modifyRuns,
      planExitNow: st.planExitNow,
      evalNoPlan: st.evalNoPlan,
      errors: st.errors,
      skipped: {
        evalThrottle: st.skippedEvalThrottle,
        modifyThrottle: st.skippedModifyThrottle,
        backoff: st.skippedBackoff,
        inFlight: st.skippedInFlight,
      },
      evalCadenceMs: {
        p50: percentile(st.evalIntervalsMs, 0.5),
        p95: percentile(st.evalIntervalsMs, 0.95),
        samples: st.evalIntervalsMs.length,
      },
      modifyCadenceMs: {
        p50: percentile(st.modifyIntervalsMs, 0.5),
        p95: percentile(st.modifyIntervalsMs, 0.95),
        samples: st.modifyIntervalsMs.length,
      },
      burst: {
        windowMs: st.burstWindowMs,
        evalCurrent: st.evalTs.length,
        evalMax: st.maxEvalBurst,
        modifyCurrent: st.modifyTs.length,
        modifyMax: st.maxModifyBurst,
      },
      lastEvalAt: st.lastEvalAt,
      lastModifyAt: st.lastModifyAt,
    };
  }

  async _maybeDynamicAdjustExits(trade, byId) {
    return this._runTradeCommand(
      trade?.tradeId,
      EXEC_COMMAND.ADJUST_PROTECTION,
      async () => this._maybeDynamicAdjustExitsImpl(trade, byId),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _maybeDynamicAdjustExitsImpl(trade, byId) {
    if (String(env.DYNAMIC_EXITS_ENABLED) !== "true") return;
    const tradeId = String(trade?.tradeId || "");
    if (!tradeId) return;
    if (this._panicExitInFlight.has(tradeId) || hasPanicExitStarted(trade)) {
      return;
    }
    if (
      !trade ||
      ![
        STATUS.ENTRY_FILLED,
        STATUS.SL_PLACED,
        STATUS.SL_CONFIRMED,
        STATUS.LIVE,
      ].includes(trade.status)
    )
      return;
    if (!trade.slOrderId && !trade.targetOrderId) return;

    this._dynExitCadenceStats.attempts += 1;
    const scaleOutEnabled = this._scaleOutEligible(trade);
    const keepTp2Resting =
      scaleOutEnabled &&
      trade.tp1Done &&
      String(env.RUNNER_KEEP_TP2_RESTING) === "true";
    if (
      scaleOutEnabled &&
      String(env.DYNAMIC_EXITS_AFTER_TP1_ONLY) === "true" &&
      !trade.tp1Done
    )
      return;
    const disableOnFail =
      String(env.DYNAMIC_EXIT_DISABLE_ON_FAIL || "false") === "true";
    if (
      disableOnFail &&
      (trade?.dynExitDisabled || this._dynExitDisabled.has(tradeId))
    ) {
      this._dynExitDisabled.add(tradeId);
      return;
    }

    const minMs = Number(env.DYNAMIC_EXIT_MIN_INTERVAL_MS ?? 5000);
    const minModifyMs = Number(env.DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS ?? 1200);
    const now = Date.now();
    const lastEval = Number(this._dynExitLastEvalAt.get(tradeId) ?? 0);
    const lastModify = Number(this._dynExitLastAt.get(tradeId) ?? 0);
    if (now - lastEval < minMs) {
      this._dynExitCadenceStats.skippedEvalThrottle += 1;
      return;
    }

    const backoffUntil = Number(
      this._dynExitFailBackoffUntil.get(tradeId) ?? 0,
    );
    if (Number.isFinite(backoffUntil) && now < backoffUntil) {
      this._dynExitCadenceStats.skippedBackoff += 1;
      return;
    }

    if (this._dynExitInFlight.has(tradeId)) {
      this._dynExitCadenceStats.skippedInFlight += 1;
      return;
    }
    this._dynExitInFlight.add(tradeId);

    try {
      // Need a live price + candles for ATR trail
      const token = Number(trade.instrument_token);
      const ltp = await this._getLtp(token, trade.instrument);
      if (!Number.isFinite(ltp) || ltp <= 0) return;
      let marketQuote = null;
      if (trade?.option_meta || trade?.optionMeta || trade?.option) {
        try {
          marketQuote = await this._getBestBidAsk(trade.instrument);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }

      const intervalMin = Number(
        trade.intervalMin ?? trade.candle?.interval_min ?? 1,
      );
      let candles = [];
      try {
        candles = await getRecentCandles(token, intervalMin, 260);
      } catch {
        candles = [];
      }
      // For OPT trades we may not have full candle history immediately; exit model can fall back.
      let underlyingLtp;
      const uTok = Number(trade.underlying_token ?? 0);
      if (Number.isFinite(uTok) && uTok > 0 && uTok !== token) {
        const cachedU = this.lastPriceByToken.get(uTok);
        if (Number.isFinite(cachedU)) underlyingLtp = cachedU;

        const allowFetch =
          String(env.OPT_DYN_EXIT_ALLOW_UNDERLYING_LTP_FETCH || "false") ===
          "true";
        if (!Number.isFinite(underlyingLtp) && allowFetch) {
          const lastFetch = Number(this._lastLtpFetchAtByToken.get(uTok) ?? 0);
          if (now - lastFetch >= 2500) {
            this._lastLtpFetchAtByToken.set(uTok, now);
            try {
              const instU = await ensureInstrument(this.kite, uTok);
              const ul = await this._getLtp(uTok, instU);
              if (Number.isFinite(ul)) underlyingLtp = ul;
            } catch (err) {
              reportFault({
                code: "TRADING_TRADEMANAGER_CATCH",
                err,
                message: "[src/trading/tradeManager.js] caught and continued",
              });
            }
          }
        }
      }

      const timeStopLatched = Boolean(trade?.timeStopTriggeredAt);
      if (timeStopLatched && !trade?.panicExitOrderId) {
        const escCooldownMs = Math.max(
          500,
          Number(env.TIME_STOP_LATCH_ESCALATE_COOLDOWN_MS ?? 8000),
        );
        const lastEscAt = Number(
          this._timeStopEscalationAt.get(String(tradeId)) ?? 0,
        );
        if (now - lastEscAt >= escCooldownMs) {
          this._timeStopEscalationAt.set(String(tradeId), now);
          logger.warn(
            { tradeId, reason: "TIME_STOP_LATCH_ESCALATION" },
            "[dyn_exit] time-stop already latched; escalating panic exit",
          );
          await this._timeStopExit(trade, "TIME_STOP_LATCH_ESCALATION");
        }
        return;
      }

      const peakFromTick = toFiniteOrNaN(this._dynPeakLtpByTrade.get(tradeId));
      const tradeForPlan = Number.isFinite(peakFromTick)
        ? { ...trade, peakLtp: peakFromTick }
        : trade;

      const plan = computeDynamicExitPlan({
        trade: tradeForPlan,
        ltp,
        candles,
        nowTs: now,
        env,
        marketQuote,
        underlyingLtp: Number.isFinite(underlyingLtp)
          ? underlyingLtp
          : undefined,
      });
      if (!plan?.ok) {
        this._dynExitCadenceStats.evalNoPlan += 1;
        return;
      }
      this._dynExitCadenceStats.evalRuns += 1;
      this._trackDynExitCadence("eval", now);
      const earlyFailVerbose = envFlagEnabled(env.EARLY_FAIL_LOG_VERBOSE, true);
      const earlyFailTelemetry = buildEarlyFailRuntimeTelemetry({
        plan,
        trade,
        verbose: earlyFailVerbose,
      });

      logger.info(
        {
          tradeId,
          strategyStopLoss:
            Number(tradeForPlan?.strategyStopLoss ?? trade?.strategyStopLoss ?? 0) ||
            null,
          sizingStopLoss:
            Number(tradeForPlan?.sizingStopLoss ?? trade?.sizingStopLoss ?? 0) ||
            null,
          brokerStopLoss:
            Number(
              tradeForPlan?.brokerStopLoss ??
                tradeForPlan?.stopLoss ??
                trade?.brokerStopLoss ??
                trade?.stopLoss ??
                0,
            ) || null,
          pnlInr: plan?.meta?.pnlInr ?? null,
          currentR: plan?.meta?.currentExecutableR ?? plan?.meta?.pnlR ?? null,
          peakR: plan?.meta?.protectedPeakR ?? plan?.meta?.peakPnlR ?? null,
          peakExecutableR: plan?.meta?.peakExecutableR ?? null,
          executionRiskInr: plan?.meta?.executionRiskInr ?? trade?.executionRiskInr ?? null,
          executionRiskSource:
            plan?.meta?.executionRiskSource ?? null,
          givebackR: plan?.givebackR ?? plan?.meta?.givebackR ?? null,
          givebackPct: plan?.givebackPct ?? plan?.meta?.givebackPct ?? null,
          quoteQuality: plan?.meta?.quoteQuality ?? null,
          quoteFreshnessMs: plan?.meta?.quoteFreshnessMs ?? null,
          executablePriceSource: plan?.meta?.executablePriceSource ?? null,
          executablePriceConfidence:
            plan?.meta?.executablePriceConfidence ?? null,
          peakLtp: plan?.meta?.peakLtp ?? tradeForPlan?.peakLtp ?? null,
          ...earlyFailTelemetry,
          minGreenSatisfied: Boolean(plan?.meta?.minGreenSatisfied),
          beEligible: Boolean(plan?.meta?.beEligible),
          beArmed: Boolean(plan?.meta?.beArmed ?? plan?.meta?.beLockHit),
          beApplied: Boolean(plan?.meta?.beApplied),
          beLockHit: Boolean(plan?.meta?.beLockHit),
          beFloor: Number(plan?.meta?.beFloor ?? 0) || null,
          beFloorSource: plan?.meta?.beFloorSource ?? null,
          greenLockActive: Boolean(
            plan?.greenLockActive ??
            plan?.tradePatch?.greenLockActive ??
            trade?.greenLockActive,
          ),
          mfeLockTier:
            plan?.mfeLockTier ??
            plan?.tradePatch?.mfeLockTier ??
            trade?.mfeLockTier ??
            0,
          mfeLockFloorR:
            plan?.mfeLockFloorR ?? plan?.meta?.mfeLockFloorR ?? null,
          mfeLockFloorPrice:
            plan?.mfeLockFloorPrice ?? plan?.meta?.mfeLockFloorPrice ?? null,
          tightenActive: Boolean(
            plan?.tightenActive ?? plan?.meta?.tightenActive,
          ),
          hardGivebackExitArmed: Boolean(
            plan?.meta?.hardGivebackExitArmed ??
            plan?.tradePatch?.hardGivebackExitArmed,
          ),
          hardGivebackRule:
            plan?.meta?.hardGivebackRule ??
            plan?.tradePatch?.hardGivebackRule ??
            null,
          trailEligible: Boolean(plan?.meta?.trailEligible),
          trailArmed: Boolean(plan?.meta?.trailArmed ?? plan?.meta?.trailHit),
          trailAllowed: Boolean(plan?.meta?.trailAllowed),
          trailActive: Boolean(plan?.meta?.trailActive),
          trailHit: Boolean(plan?.meta?.trailHit),
          trailBlockReason: plan?.meta?.trailBlockReason ?? null,
          profitLockArmed: Boolean(plan?.meta?.profitLockArmed),
          protectedStopSource: plan?.meta?.protectedStopSource ?? null,
          telemetryProposalFloor:
            Number(plan?.meta?.telemetryProposalFloor ?? 0) || null,
          executableHardFloor:
            Number(plan?.meta?.executableHardFloor ?? 0) || null,
          desiredStopLoss:
            Number(plan?.meta?.desiredStopLoss ?? 0) || null,
          finalStopLoss:
            Number(plan?.meta?.finalStopLoss ?? plan?.finalStop ?? 0) || null,
          hardFloor: Number(plan?.meta?.hardFloor ?? plan?.hardFloor ?? 0) || null,
          structureTrailFloor:
            Number(plan?.meta?.structureTrailFloor ?? 0) || null,
          structureTrailSource: plan?.meta?.structureTrailSource ?? null,
          structureTrailAllowed: Boolean(plan?.meta?.structureTrailAllowed),
          protectionGateOpen: Boolean(plan?.meta?.protectionGateOpen),
          winnerModeActive: Boolean(plan?.meta?.winnerModeActive),
          stopImproveAuthorized: Boolean(plan?.meta?.stopImproveAuthorized),
          stopImproveBlockedReason:
            plan?.meta?.stopImproveBlockedReason ?? null,
          previousStop: Number(trade?.stopLoss ?? 0) || null,
          proposedStop:
            Number(
              plan?.meta?.desiredStopLoss ??
                plan?.finalStop ??
                plan?.sl?.stopLoss ??
                0,
            ) || null,
          finalStop: Number(plan?.finalStop ?? plan?.sl?.stopLoss ?? 0) || null,
          reasonTags: plan?.meta?.reasonTags ?? [],
          reason: plan?.reason || plan?.meta?.reasonTags?.join?.("|") || null,
          shouldExitNow: Boolean(plan?.shouldExitNow || plan?.action?.exitNow),
          shouldExitNowReason:
            plan?.shouldExitNowReason ??
            plan?.meta?.shouldExitNowReason ??
            null,
          exitFamily:
            plan?.meta?.exitFamily ?? plan?.tradePatch?.exitFamily ?? null,
          exitReasonCode:
            plan?.meta?.exitReasonCode ??
            plan?.tradePatch?.exitReasonCode ??
            null,
          exitAuthority:
            plan?.meta?.exitAuthority ??
            plan?.tradePatch?.exitAuthority ??
            null,
          shadowExitActive: Boolean(
            trade?.shadowExitActive || plan?.tradePatch?.shadowExitActive,
          ),
          protectionUpgradePending: Boolean(
            trade?.protectionUpgradePending,
          ),
          protectionUpgradeSoftFailed: Boolean(
            trade?.protectionUpgradeSoftFailed,
          ),
          protectionUpgradeFallbackMode:
            trade?.protectionUpgradeFallbackMode ?? null,
          shadowProtectionActiveReason:
            trade?.shadowProtectionActiveReason ?? null,
          skipReason: plan?.meta?.skipReason || null,
          hardGivebackConfirmTicks:
            plan?.meta?.hardGivebackConfirmTicks ??
            plan?.tradePatch?.hardGivebackConfirmTicks ??
            trade?.hardGivebackConfirmTicks ??
            0,
          hardGivebackConfirmTarget:
            plan?.meta?.hardGivebackConfirmTarget ?? null,
          givebackConfirmMs:
            plan?.meta?.givebackConfirmMs ??
            plan?.tradePatch?.givebackConfirmMs ??
            trade?.givebackConfirmMs ??
            0,
          hardGivebackArmedAt:
            plan?.meta?.hardGivebackArmedAt ??
            plan?.tradePatch?.hardGivebackArmedAt ??
            trade?.hardGivebackArmedAt ??
            null,
        },
        "[dyn_exit] eval",
      );

      if (
        Boolean(trade?.shadowExitActive) &&
        Boolean(
          plan?.finalStop || plan?.sl?.stopLoss || plan?.meta?.desiredStopLoss,
        ) &&
        this._isShadowStopBreached(trade, plan, ltp) &&
        String(env.DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH || "true") === "true" &&
        !trade?.panicExitOrderId
      ) {
        await this._panicExit(trade, "SHADOW_EXIT_BREACH", { timeStop: false });
        return;
      }

      if (plan?.action?.exitNow) {
        this._dynExitCadenceStats.planExitNow += 1;
        const exitReason = String(plan?.action?.reason || "DYN_EXIT_ACTION");
        if (exitReason === "GIVEBACK_CAP") {
          logger.warn(
            {
              tradeId,
              currentExecutableR: plan?.meta?.currentExecutableR ?? null,
              peakExecutableR: plan?.meta?.peakExecutableR ?? null,
              givebackR: plan?.meta?.givebackR ?? plan?.givebackR ?? null,
              givebackPct: plan?.meta?.givebackPct ?? plan?.givebackPct ?? null,
              mfeLockTier:
                plan?.mfeLockTier ??
                plan?.tradePatch?.mfeLockTier ??
                trade?.mfeLockTier ??
                0,
              previousStop: Number(trade?.stopLoss ?? 0) || null,
              proposedStop:
                Number(
                  plan?.meta?.desiredStopLoss ??
                    plan?.finalStop ??
                    plan?.sl?.stopLoss ??
                    0,
                ) || null,
              finalStop:
                Number(plan?.finalStop ?? plan?.sl?.stopLoss ?? 0) || null,
              shouldExitNowReason:
                plan?.shouldExitNowReason ??
                plan?.meta?.shouldExitNowReason ??
                exitReason,
              hardGivebackRule:
                plan?.meta?.hardGivebackRule ??
                plan?.tradePatch?.hardGivebackRule ??
                null,
              hardGivebackConfirmTicks:
                plan?.meta?.hardGivebackConfirmTicks ??
                plan?.tradePatch?.hardGivebackConfirmTicks ??
                null,
              hardGivebackConfirmTarget:
                plan?.meta?.hardGivebackConfirmTarget ?? null,
              givebackConfirmMs:
                plan?.meta?.givebackConfirmMs ??
                plan?.tradePatch?.givebackConfirmMs ??
                null,
              hardGivebackArmedAt:
                plan?.meta?.hardGivebackArmedAt ??
                plan?.tradePatch?.hardGivebackArmedAt ??
                null,
              exitFamily:
                plan?.meta?.exitFamily ?? plan?.tradePatch?.exitFamily ?? null,
              exitAuthority:
                plan?.meta?.exitAuthority ??
                plan?.tradePatch?.exitAuthority ??
                null,
            },
            "[dyn_exit] GIVEBACK_CAP_TRIGGERED",
          );
        }
        const timeStopReasonMap = {
          TIME_STOP: "LEGACY",
          TIME_STOP_NO_PROGRESS: "NO_PROGRESS",
          TIME_STOP_MAX_HOLD: "MAX_HOLD",
        };
        const isTimeStop = Object.prototype.hasOwnProperty.call(
          timeStopReasonMap,
          exitReason,
        );
        const isEarlyFailExit = /^EARLY_/.test(exitReason);
        const patch = {
          ...(plan?.tradePatch && Object.keys(plan.tradePatch).length
            ? plan.tradePatch
            : {}),
        };
        if (isEarlyFailExit) {
          logger.warn(
            {
              tradeId,
              exitReason,
              shouldExitNowReason:
                plan?.shouldExitNowReason ??
                plan?.meta?.shouldExitNowReason ??
                exitReason,
              exitFamily:
                plan?.meta?.exitFamily ?? plan?.tradePatch?.exitFamily ?? null,
              exitReasonCode:
                plan?.meta?.exitReasonCode ??
                plan?.tradePatch?.exitReasonCode ??
                null,
              exitAuthority:
                plan?.meta?.exitAuthority ??
                plan?.tradePatch?.exitAuthority ??
                null,
              ...earlyFailTelemetry,
            },
            "[dyn_exit] EARLY_FAIL_EXIT_AUTHORIZED",
          );
        }
        if (isTimeStop) {
          const dedupWindowMs =
            Math.max(0, Number(env.TIME_STOP_ALERT_DEDUP_MIN ?? 10)) *
            60 *
            1000;
          const triggeredAtMs = trade?.timeStopTriggeredAt
            ? new Date(trade.timeStopTriggeredAt).getTime()
            : NaN;
          const suppressTimeStopAlert =
            Number.isFinite(triggeredAtMs) &&
            dedupWindowMs > 0 &&
            now - triggeredAtMs < dedupWindowMs;

          if (!suppressTimeStopAlert) {
            Object.assign(
              patch,
              this._eventPatch("TIME_STOP_TRIGGERED", {
                tradeId,
                timeStopKind:
                  plan?.meta?.timeStopKind ||
                  timeStopReasonMap[exitReason] ||
                  null,
                holdMin: plan?.meta?.holdMin,
                timeStopAtMs: plan?.meta?.timeStopAtMs,
                pnlInr: plan?.meta?.pnlInr,
                pnlR: plan?.meta?.pnlR,
                pnlPriceR: plan?.meta?.pnlPriceR,
                peakPnlInr: plan?.meta?.peakPnlInr,
                peakPnlR: plan?.meta?.peakPnlR,
                peakPriceR: plan?.meta?.peakPriceR,
                mfeR: plan?.meta?.mfeR,
              }),
            );
            alert("warn", `Time stop triggered -> exit (${exitReason})`, {
              tradeId,
              timeStopKind:
                plan?.meta?.timeStopKind ||
                timeStopReasonMap[exitReason] ||
                null,
              holdMin: plan?.meta?.holdMin,
              timeStopAtMs: plan?.meta?.timeStopAtMs,
              pnlInr: plan?.meta?.pnlInr,
              pnlR: plan?.meta?.pnlR,
              pnlPriceR: plan?.meta?.pnlPriceR,
              peakPnlInr: plan?.meta?.peakPnlInr,
              peakPnlR: plan?.meta?.peakPnlR,
              peakPriceR: plan?.meta?.peakPriceR,
              mfeR: plan?.meta?.mfeR,
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
            logger.warn(
              { tradeId, reason: exitReason, meta: plan?.meta || null },
              "[dyn_exit] time stop triggered",
            );
          }
        }
        if (Object.keys(patch).length) {
          try {
            await this._updateTrade(tradeId, patch);
          } catch (err) {
            reportFault({
              code: "TRADING_TRADEMANAGER_CATCH",
              err,
              message: "[src/trading/tradeManager.js] caught and continued",
            });
          }
        }
        if (isTimeStop) await this._timeStopExit(trade, exitReason);
        else
          await this._panicExit(trade, exitReason, {
            timeStop: false,
          });
        return;
      }

      let peakPatch = null;
      if (Number.isFinite(peakFromTick)) {
        const dbPeak = toFiniteOrNaN(trade?.peakLtp);
        const side = String(trade?.side || "").toUpperCase();
        const isBetter =
          side === "BUY"
            ? !Number.isFinite(dbPeak) || peakFromTick > dbPeak
            : side === "SELL"
              ? !Number.isFinite(dbPeak) || peakFromTick < dbPeak
              : false;
        if (isBetter) peakPatch = { peakLtp: peakFromTick };
      }

      if (plan?.tradePatch && Object.keys(plan.tradePatch).length) {
        try {
          const patch = { ...plan.tradePatch, ...(peakPatch || {}) };
          const protectionLog = {
            tradeId,
            currentExecutableR: plan?.meta?.currentExecutableR ?? null,
            peakExecutableR: plan?.meta?.peakExecutableR ?? null,
            givebackR: plan?.meta?.givebackR ?? plan?.givebackR ?? null,
            givebackPct: plan?.meta?.givebackPct ?? plan?.givebackPct ?? null,
            mfeLockTier: patch.mfeLockTier ?? trade?.mfeLockTier ?? 0,
            previousStop: Number(trade?.stopLoss ?? 0) || null,
            proposedStop:
              Number(
                plan?.meta?.desiredStopLoss ??
                  plan?.finalStop ??
                  plan?.sl?.stopLoss ??
                  0,
              ) || null,
            finalStop:
              Number(plan?.finalStop ?? plan?.sl?.stopLoss ?? 0) || null,
            shouldExitNowReason:
              plan?.shouldExitNowReason ??
              plan?.meta?.shouldExitNowReason ??
              null,
            hardGivebackRule:
              patch.hardGivebackRule ?? plan?.meta?.hardGivebackRule ?? null,
          };
          if (
            Number(patch.mfeLockTier ?? 0) > Number(trade?.mfeLockTier ?? 0)
          ) {
            logger.info(protectionLog, "[dyn_exit] MFE_LOCK_TIER_UPGRADE");
          }
          if (patch.tightenActive && !trade?.tightenActive) {
            logger.info(
              {
                ...protectionLog,
                tightenActivatedAtR:
                  patch.tightenActivatedAtR ??
                  plan?.meta?.tightenActivatedAtR ??
                  null,
                post1RTrailGapR:
                  patch.post1RTrailGapR ?? plan?.meta?.post1RTrailGapR ?? null,
              },
              "[dyn_exit] POST_1R_TIGHTEN_ACTIVE",
            );
          }
          if (
            patch.hardGivebackExitArmed &&
            (!trade?.hardGivebackExitArmed ||
              String(patch.hardGivebackRule || "") !==
                String(trade?.hardGivebackRule || ""))
          ) {
            logger.warn(
              {
                ...protectionLog,
                hardGivebackThresholdR:
                  patch.hardGivebackThresholdR ??
                  plan?.meta?.hardGivebackThresholdR ??
                  null,
                hardGivebackThresholdPct:
                  patch.hardGivebackThresholdPct ??
                  plan?.meta?.hardGivebackThresholdPct ??
                  null,
                hardGivebackConfirmTicks:
                  patch.hardGivebackConfirmTicks ??
                  plan?.meta?.hardGivebackConfirmTicks ??
                  null,
                hardGivebackConfirmTarget:
                  plan?.meta?.hardGivebackConfirmTarget ?? null,
                givebackConfirmMs:
                  patch.givebackConfirmMs ??
                  plan?.meta?.givebackConfirmMs ??
                  null,
                hardGivebackArmedAt:
                  plan?.meta?.hardGivebackArmedAt ??
                  patch.hardGivebackArmedAt ??
                  null,
              },
              "[dyn_exit] HARD_GIVEBACK_EXIT_ARMED",
            );
          }
          if (patch.beLocked && !trade.beLocked) {
            Object.assign(
              patch,
              this._eventPatch("BE_LOCK_ACTIVE", {
                tradeId,
                beLockedAtPrice: patch.beLockedAtPrice,
                beFloorSource: plan?.meta?.beFloorSource ?? null,
                minGreenPts: trade?.minGreenPts,
                minGreenInr: trade?.minGreenInr,
              }),
            );
            alert("info", "BE armed", {
              tradeId,
              side: trade?.side,
              entryPrice: trade?.entryPrice,
              beLockedAtPrice: patch.beLockedAtPrice,
              beFloor: Number(plan?.meta?.beFloor ?? 0) || null,
              beFloorSource: plan?.meta?.beFloorSource ?? null,
              minGreenPts: trade?.minGreenPts,
              minGreenInr: trade?.minGreenInr,
              minGreenSatisfied: Boolean(plan?.meta?.minGreenSatisfied),
              beEligible: Boolean(plan?.meta?.beEligible),
              beArmed: true,
              beApplied: Boolean(plan?.meta?.beApplied),
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
            logger.info(
              {
                tradeId,
                beLockedAtPrice: patch.beLockedAtPrice,
                beFloorSource: plan?.meta?.beFloorSource ?? null,
                minGreenSatisfied: Boolean(plan?.meta?.minGreenSatisfied),
                beEligible: Boolean(plan?.meta?.beEligible),
                beArmed: true,
                beApplied: Boolean(plan?.meta?.beApplied),
              },
              "[dyn_exit] BE armed",
            );
          }
          await this._updateTrade(tradeId, patch);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      } else if (peakPatch) {
        try {
          await this._updateTrade(tradeId, peakPatch);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }

      const dynamicStopGuard = evaluateDynamicSlModifyAuthority({
        trade,
        plan,
      });
      const dynamicStopTick = Math.max(
        Number(trade?.instrument?.tick_size ?? 0.05) || 0.05,
        0.01,
      );
      const prevTelemetryProposalFloor = Number(trade?.telemetryProposalFloor);
      const nextTelemetryProposalFloor = Number(
        dynamicStopGuard.telemetryProposalFloor,
      );
      const telemetryProposalChanged =
        !Number.isFinite(prevTelemetryProposalFloor) ||
        !Number.isFinite(nextTelemetryProposalFloor)
          ? Number.isFinite(prevTelemetryProposalFloor) !==
            Number.isFinite(nextTelemetryProposalFloor)
          : Math.abs(
              nextTelemetryProposalFloor - prevTelemetryProposalFloor,
            ) >= dynamicStopTick / 2;
      const shouldLogBlockedDynamicStop =
        dynamicStopGuard.proposalImprovesBrokerStop &&
        !dynamicStopGuard.allowed &&
        (
          String(dynamicStopGuard.blockedReason || "") !==
            String(trade?.stopImproveBlockedReason || "") ||
          String(dynamicStopGuard.structureTrailSource || "") !==
            String(trade?.structureTrailSource || "") ||
          telemetryProposalChanged
        );

      if (shouldLogBlockedDynamicStop) {
        logger.info(
          {
            tradeId,
            brokerStopLoss: dynamicStopGuard.currentBrokerStopLoss,
            telemetryProposalFloor: dynamicStopGuard.telemetryProposalFloor,
            desiredStopLoss: dynamicStopGuard.desiredStopLoss,
            finalStopLoss: dynamicStopGuard.finalStopLoss,
            hardFloor: dynamicStopGuard.hardFloor,
            structureTrailSource: dynamicStopGuard.structureTrailSource,
            structureTrailAllowed: dynamicStopGuard.structureTrailAllowed,
            protectionGateOpen: dynamicStopGuard.protectionGateOpen,
            winnerModeActive: dynamicStopGuard.winnerModeActive,
            mfeLockTier: dynamicStopGuard.mfeLockTier,
            exitAuthority: dynamicStopGuard.exitAuthority,
            stopImproveAuthorized: dynamicStopGuard.stopImproveAuthorized,
            stopImproveBlockedReason: dynamicStopGuard.blockedReason,
            minGreenSatisfied: Boolean(plan?.meta?.minGreenSatisfied),
            beEligible: Boolean(plan?.meta?.beEligible),
            beArmed: Boolean(plan?.meta?.beArmed ?? plan?.meta?.beLockHit),
            beApplied: Boolean(plan?.meta?.beApplied),
            beFloor: Number(plan?.meta?.beFloor ?? 0) || null,
            beFloorSource: plan?.meta?.beFloorSource ?? null,
            trailEligible: Boolean(plan?.meta?.trailEligible),
            trailArmed: Boolean(plan?.meta?.trailArmed ?? plan?.meta?.trailHit),
            trailAllowed: Boolean(plan?.meta?.trailAllowed),
            trailActive: Boolean(plan?.meta?.trailActive),
            trailBlockReason: plan?.meta?.trailBlockReason ?? null,
            protectedStopSource: plan?.meta?.protectedStopSource ?? null,
            reasonTags: dynamicStopGuard.reasonTags,
          },
          dynamicStopGuard.blockedReason === "NO_AUTHORITY"
            ? "[dyn_exit] SL modify blocked (no authority)"
            : "[dyn_exit] SL modify blocked",
        );
      }

      let did = false;

      // ---- SL trail (SL / SL-M) ----
      if (dynamicStopGuard.allowed && plan.sl?.stopLoss && trade.slOrderId) {
        let sl = byId?.get(String(trade.slOrderId));
        if (!sl) {
          const statusInfo = await this._getOrderStatus(trade.slOrderId);
          sl = statusInfo?.order || null;
        }
        const slStatus = String(sl?.status || "").toUpperCase();
        const slType = String(sl?.order_type || "").toUpperCase();

        // Only modify while it's pending (OPEN means it likely triggered already).
        if (slStatus === "TRIGGER PENDING") {
          if (now - lastModify < minModifyMs) {
            this._dynExitCadenceStats.skippedModifyThrottle += 1;
            return;
          }
          const slSide = trade.side === "BUY" ? "SELL" : "BUY";

          const patch = { trigger_price: plan.sl.stopLoss };
          let nextLimitPrice = null;
          if (slType === "SL") {
            nextLimitPrice = this._buildStopLossLimitPrice({
              triggerPrice: plan.sl.stopLoss,
              exitSide: slSide,
              instrument: trade.instrument,
            });
            patch.price = nextLimitPrice;
          }

          const retryMeta = {
            type: "DYN_SL",
            token,
            instrument: trade.instrument,
            side: trade.side,
            slType,
            exitSide: slSide,
            currentStopLoss:
              Number(trade.stopLoss ?? sl?.trigger_price ?? 0) || 0,
          };

          try {
            await this._safeModifyOrder(
              env.DEFAULT_ORDER_VARIETY,
              trade.slOrderId,
              patch,
              {
                purpose: "DYN_TRAIL_SL",
                tradeId,
                retry: retryMeta,
                tickSize: Number(trade?.instrument?.tick_size ?? 0.05),
                minIntervalMs: Math.max(1000, Number(minModifyMs ?? 0)),
              },
            );
            const appliedTrigger = Number(
              retryMeta?.appliedPatch?.trigger_price ?? plan.sl.stopLoss,
            );
            const appliedLimit =
              retryMeta?.appliedPatch?.price ?? nextLimitPrice;
            const beFloor = Number(plan?.meta?.beFloor);
            const beArmedNow = Boolean(
              plan?.meta?.beArmed ??
                plan?.tradePatch?.beLocked ??
                trade?.beLocked,
            );
            const beAppliedNow =
              beArmedNow &&
              Number.isFinite(beFloor) &&
              (String(trade?.side || "").toUpperCase() === "BUY"
                ? appliedTrigger >= beFloor
                : appliedTrigger <= beFloor);
          const beFloorSource = plan?.meta?.beFloorSource ?? null;
          const protectedStopSource =
            plan?.meta?.protectedStopSource ??
            (beAppliedNow ? beFloorSource : null);
          const protectionUpgradeLabel = protectionUpgradeReason({
            trade,
            source: "DYN_TRAIL_SL",
            protectedStopSource,
          });
          const stopUpdateLogMessage =
            protectedStopSource === "TRAIL"
              ? "[dyn_exit] SL trailed"
                : protectedStopSource === "PROFIT_LOCK"
                  ? "[dyn_exit] SL moved to profit lock"
                  : beAppliedNow
                    ? "[dyn_exit] SL moved to BE floor"
                    : "[dyn_exit] SL updated";
            const stopUpdateAlertMessage =
              protectedStopSource === "TRAIL"
                ? "SL trailed"
                : protectedStopSource === "PROFIT_LOCK"
                  ? "SL moved to profit lock"
                  : beAppliedNow
                    ? "SL moved to BE floor"
                    : "SL updated";
            await this._updateTrade(tradeId, {
              stopLoss: appliedTrigger,
              slTrigger: appliedTrigger,
              shadowExitActive: false,
              ...clearProtectionUpgradeStatePatch(),
              ...(appliedLimit != null ? { slLimitPrice: appliedLimit } : {}),
              ...(beAppliedNow
                ? {
                    beAppliedAt: new Date(),
                    beAppliedStopLoss: appliedTrigger,
                    beApplyFails: 0,
                  }
                : {}),
              ...this._eventPatch("SL_TRAILED", {
                tradeId,
                stopLoss: appliedTrigger,
                trailSl: plan?.tradePatch?.trailSl ?? trade?.trailSl,
                beFloor: Number.isFinite(beFloor) ? beFloor : null,
                beFloorSource,
                protectedStopSource,
                beAppliedNow,
              }),
            });
            try {
              this._updateSlWatchTrigger(tradeId, appliedTrigger);
            } catch (err) {
              reportFault({
                code: "TRADING_TRADEMANAGER_CATCH",
                err,
                message: "[src/trading/tradeManager.js] caught and continued",
              });
            }
            did = true;
            logger.info(
              {
                tradeId,
                stopLoss: appliedTrigger,
                beFloor: Number.isFinite(beFloor) ? beFloor : null,
                beFloorSource,
                protectedStopSource,
                beAppliedNow,
                meta: plan.meta,
              },
              stopUpdateLogMessage,
            );
            alert("info", stopUpdateAlertMessage, {
              tradeId,
              side: trade?.side,
              prevStopLoss:
                Number(trade.stopLoss ?? sl?.trigger_price ?? 0) || null,
              stopLoss: appliedTrigger,
              beFloor: Number.isFinite(beFloor) ? beFloor : null,
              beFloorSource,
              protectedStopSource,
              minGreenSatisfied: Boolean(plan?.meta?.minGreenSatisfied),
              beEligible: Boolean(plan?.meta?.beEligible),
              beArmed: beArmedNow,
              beApplied: beAppliedNow,
              trailEligible: Boolean(plan?.meta?.trailEligible),
              trailArmed: Boolean(
                plan?.meta?.trailArmed ?? plan?.meta?.trailHit,
              ),
              trailAllowed: Boolean(plan?.meta?.trailAllowed),
              trailActive: Boolean(plan?.meta?.trailActive),
              trailBlockReason: plan?.meta?.trailBlockReason ?? null,
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
            this._dynExitFailCount.set(tradeId, 0);
            this._dynExitFailBackoffUntil.delete(tradeId);
          } catch (e) {
            // If SL triggered/cancelled between status check and modify, modify will fail.
            // Treat that as a normal race condition (don't penalize/disable trailing).
            try {
              const stNow = await this._getOrderStatus(trade.slOrderId);
              const sttNow = String(stNow?.status || "").toUpperCase();
              if (sttNow && sttNow !== "TRIGGER PENDING") {
                logger.warn(
                  {
                    tradeId,
                    slOrderId: trade.slOrderId,
                    slStatus: sttNow,
                    e: e.message,
                  },
                  "[dyn_exit] SL modify failed but SL not pending (race) -> ignore",
                );
                this._dynExitFailCount.set(tradeId, 0);
                this._dynExitFailBackoffUntil.delete(tradeId);
                return;
              }
            } catch (err) {
              reportFault({
                code: "TRADING_TRADEMANAGER_CATCH",
                err,
                message: "[src/trading/tradeManager.js] caught and continued",
              });
            }

            const msg = String(e?.message || e || "");
            const softFailure = isSoftBrokerModifyError(e);
            const protectedStopSource =
              plan?.meta?.protectedStopSource ??
              plan?.meta?.beFloorSource ??
              null;
            const protectionUpgradeLabel = protectionUpgradeReason({
              trade,
              source: "DYN_TRAIL_SL",
              protectedStopSource,
            });
            const meaningfulProtectionUpgrade = Boolean(
              PROTECTION_SAFETY_SOURCE_TAGS.has(protectionUpgradeLabel) ||
                Boolean(plan?.meta?.beArmed) ||
                Boolean(plan?.meta?.profitLockArmed) ||
                Boolean(plan?.meta?.greenLockActive),
            );
            if (softFailure) {
              const softBaseMs = meaningfulProtectionUpgrade
                ? Number(env.DYN_EXIT_PROTECTION_SOFT_RETRY_MS ?? 400)
                : Number(env.DYN_EXIT_FAIL_BACKOFF_MS ?? 2000);
              const softMaxMs = Number(
                env.DYN_EXIT_FAIL_BACKOFF_MAX_MS ?? 15000,
              );
              const nextBeApplyFails =
                Math.max(0, Number(trade?.beApplyFails ?? 0)) + 1;
              if (meaningfulProtectionUpgrade) {
                try {
                  await this._updateTrade(tradeId, {
                    beApplyFails: nextBeApplyFails,
                    ...protectionUpgradeStatePatch({
                      proposedStopLoss: plan?.sl?.stopLoss,
                      fallbackMode: "SHADOW_PENDING",
                      pending: true,
                      softFailed: true,
                      reason: protectionUpgradeLabel,
                      now: new Date(),
                    }),
                  });
                } catch (err) {
                  reportFault({
                    code: "TRADING_TRADEMANAGER_CATCH",
                    err,
                    message: "[src/trading/tradeManager.js] caught and continued",
                  });
                }
              } else if (
                Boolean(
                  plan?.meta?.beArmed ??
                    plan?.tradePatch?.beLocked ??
                    trade?.beLocked,
                )
              ) {
                try {
                  await this._updateTrade(tradeId, { beApplyFails: nextBeApplyFails });
                } catch (err) {
                  reportFault({
                    code: "TRADING_TRADEMANAGER_CATCH",
                    err,
                    message: "[src/trading/tradeManager.js] caught and continued",
                  });
                }
              }

              this._dynExitFailBackoffUntil.set(
                tradeId,
                Date.now() + Math.min(Math.max(500, softBaseMs), softMaxMs),
              );
              if (
                meaningfulProtectionUpgrade &&
                String(env.DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL || "true") === "true"
              ) {
                await this._activateDynamicShadowMode(
                  trade,
                  {
                    ...plan,
                    finalStop: plan?.sl?.stopLoss ?? plan?.finalStop,
                    reason: protectionUpgradeLabel,
                  },
                  {
                    failCount: nextBeApplyFails,
                    error: e,
                    source: "soft_protection_upgrade",
                  },
                );
                if (
                  this._isShadowStopBreached(trade, plan, ltp) &&
                  String(env.DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH || "true") ===
                    "true" &&
                  !trade?.panicExitOrderId
                ) {
                  await this._panicExit(trade, "SHADOW_EXIT_BREACH", {
                    timeStop: false,
                  });
                  return;
                }
              }
              logger.warn(
                {
                  tradeId,
                  e: msg,
                  stopLoss: plan.sl.stopLoss,
                  soft: true,
                  meaningfulProtectionUpgrade,
                  protectionUpgradeLabel,
                },
                meaningfulProtectionUpgrade
                  ? "[dyn_exit] protective SL upgrade soft-failed; shadow protection pending"
                  : "[dyn_exit] SL modify soft-failed (rate-limit/transient); backing off",
              );
              return;
            }

            const fails = Number(this._dynExitFailCount.get(tradeId) ?? 0) + 1;
            this._dynExitFailCount.set(tradeId, fails);
            const baseBackoff = Number(env.DYN_EXIT_FAIL_BACKOFF_MS ?? 2000);
            const maxBackoff = Number(
              env.DYN_EXIT_FAIL_BACKOFF_MAX_MS ?? 15000,
            );
            const nextBackoff = Math.max(500, baseBackoff) * Math.max(1, fails);
            this._dynExitFailBackoffUntil.set(
              tradeId,
              Date.now() + Math.min(nextBackoff, maxBackoff),
            );
            if (
              fails >= 2 &&
              String(env.DYNAMIC_EXIT_CANCEL_REPLACE_ON_FAIL || "true") ===
                "true"
            ) {
              const replaced = await this._replaceDynamicSlOrder(
                trade,
                plan.sl.stopLoss,
              );
              if (replaced) {
                this._dynExitFailCount.set(tradeId, 0);
                this._dynExitFailBackoffUntil.delete(tradeId);
                const modifiedAt = Date.now();
                this._dynExitLastAt.set(tradeId, modifiedAt);
                this._dynExitCadenceStats.modifyRuns += 1;
                this._trackDynExitCadence("modify", modifiedAt);
                logger.warn(
                  { tradeId, stopLoss: plan.sl.stopLoss, failCount: fails },
                  "[dyn_exit] SL recovered via cancel-replace",
                );
                return;
              }
            }
            if (
              String(env.DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL || "true") === "true"
            ) {
              await this._activateDynamicShadowMode(trade, plan, {
                failCount: fails,
                error: e,
                source: "modify_fail",
              });
              if (
                this._isShadowStopBreached(trade, plan, ltp) &&
                String(env.DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH || "true") ===
                  "true" &&
                !trade?.panicExitOrderId
              ) {
                await this._panicExit(trade, "SHADOW_EXIT_BREACH", {
                  timeStop: false,
                });
                return;
              }
            }
            if (
              disableOnFail &&
              String(env.DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL || "true") !==
                "true" &&
              fails >= 3
            ) {
              this._dynExitDisabled.add(tradeId);
              try {
                await this._updateTrade(tradeId, {
                  dynExitDisabled: true,
                  dynExitDisabledAt: new Date(),
                  ...this._eventPatch("TRAILING_DISABLED", {
                    tradeId,
                    failCount: fails,
                  }),
                });
              } catch (err) {
                reportFault({
                  code: "TRADING_TRADEMANAGER_CATCH",
                  err,
                  message: "[src/trading/tradeManager.js] caught and continued",
                });
              }
              alert("error", "🛑 Trailing disabled after modify failures", {
                tradeId,
                failCount: fails,
              }).catch((err) =>
                reportWindowedFault({
                  code: "ALERT_SEND_FAILED",
                  windowKey: "alert_send_failed",
                  err,
                  message: "[alert] failed to dispatch notification",
                  meta: { context: "trade_manager" },
                }),
              );
              logger.error(
                { tradeId, failCount: fails },
                "[dyn_exit] trailing disabled after failures",
              );
            }
            logger.warn(
              { tradeId, e: e.message, stopLoss: plan.sl.stopLoss },
              "[dyn_exit] SL modify failed",
            );
          }
        }
      }

      // ---- TARGET adjust (LIMIT) ----
      if (!keepTp2Resting && plan.target?.targetPrice && trade.targetOrderId) {
        let tgt = byId?.get(String(trade.targetOrderId));
        if (!tgt) {
          const statusInfo = await this._getOrderStatus(trade.targetOrderId);
          tgt = statusInfo?.order || null;
        }
        const tgtStatus = String(tgt?.status || "").toUpperCase();
        const tgtType = String(tgt?.order_type || "").toUpperCase();
        // Only modify an open LIMIT target (market targets can't be modified meaningfully)
        if (tgtStatus === "OPEN" && (tgtType === "LIMIT" || tgtType === "LM")) {
          if (now - lastModify < minModifyMs) {
            this._dynExitCadenceStats.skippedModifyThrottle += 1;
            return;
          }
          try {
            await this._safeModifyOrder(
              env.DEFAULT_ORDER_VARIETY,
              trade.targetOrderId,
              { price: plan.target.targetPrice },
              {
                purpose: "DYN_ADJUST_TARGET",
                tradeId,
                tickSize: Number(trade?.instrument?.tick_size ?? 0.05),
                minIntervalMs: Math.max(1000, Number(minModifyMs ?? 0)),
              },
            );
            await this._updateTrade(tradeId, {
              targetPrice: plan.target.targetPrice,
              ...this._eventPatch("TARGET_ADJUSTED", {
                tradeId,
                targetPrice: plan.target.targetPrice,
              }),
            });
            try {
              this._refreshTargetWatchAfterAdjust(
                { ...trade, targetPrice: plan.target.targetPrice },
                plan.target.targetPrice,
              );
            } catch (err) {
              reportFault({
                code: "TRADING_TRADEMANAGER_CATCH",
                err,
                message: "[src/trading/tradeManager.js] caught and continued",
              });
            }
            did = true;
            logger.info(
              {
                tradeId,
                targetPrice: plan.target.targetPrice,
                meta: plan.meta,
              },
              "[dyn_exit] TARGET adjusted",
            );
            alert("info", "🎯 TARGET adjusted", {
              tradeId,
              targetPrice: plan.target.targetPrice,
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
          } catch (e) {
            logger.warn(
              { tradeId, e: e.message, targetPrice: plan.target.targetPrice },
              "[dyn_exit] TARGET modify failed",
            );
          }
        }
      }

      if (did) {
        const modifiedAt = Date.now();
        this._dynExitLastAt.set(tradeId, modifiedAt);
        this._dynExitCadenceStats.modifyRuns += 1;
        this._trackDynExitCadence("modify", modifiedAt);
      }
    } catch (e) {
      this._dynExitCadenceStats.errors += 1;
      throw e;
    } finally {
      this._dynExitInFlight.delete(tradeId);
      this._dynExitLastEvalAt.set(tradeId, Date.now());
    }
  }

  async _watchEntryUntilDone(tradeId, entryOrderId) {
    if (this._stopped) return;
    const pollMs = Number(env.ENTRY_WATCH_POLL_MS ?? 1000);
    const seedTrade = await getTrade(tradeId);
    if (!seedTrade) return;
    const watchMs = Number(env.ENTRY_WATCH_MS ?? 30000);
    const profile = this._entryUrgencyProfile(seedTrade);
    const maxMs = Math.min(
      Math.max(1000, watchMs),
      Math.max(1000, Number(profile?.maxPendingMs ?? watchMs)),
    );
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      if (this._stopped) return;
      const t = await getTrade(tradeId);
      if (!t) return;
      if (String(t.entryOrderId || "") !== String(entryOrderId)) {
        return;
      }

      // already progressed
      if (
        [
          STATUS.LIVE,
          STATUS.EXITED_TARGET,
          STATUS.EXITED_SL,
          STATUS.ENTRY_FAILED,
          STATUS.ENTRY_CANCELLED,
          STATUS.CLOSED,
          STATUS.GUARD_FAILED,
        ].includes(t.status)
      ) {
        return;
      }

      let status = null;
      let avg = null;
      let filledQty = null;
      let msg = null;

      // Prefer order history (more reliable)
      if (typeof this.kite.getOrderHistory === "function") {
        try {
          const hist = await this.kite.getOrderHistory(entryOrderId);
          const last = Array.isArray(hist) ? hist[hist.length - 1] : null;
          status = last?.status;
          avg = last?.average_price;
          filledQty = last?.filled_quantity;
          msg = last?.status_message_raw || last?.status_message || null;
        } catch {
          // ignore and try getOrders fallback
        }
      }

      if (!status) {
        try {
          const orders = await this.kite.getOrders();
          const o = (orders || []).find(
            (x) => String(x.order_id || x.orderId) === String(entryOrderId),
          );
          status = o?.status;
          avg = o?.average_price;
          filledQty = o?.filled_quantity;
          msg = o?.status_message_raw || o?.status_message || null;
        } catch {
          // ignore
        }
      }

      status = String(status || "").toUpperCase();

      if (status === "COMPLETE") {
        const avgPx = Number(avg ?? t.entryPrice ?? t.candle?.close);
        const qty = Number(filledQty ?? t.qty);
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice: avgPx,
          filledQty: qty,
          source: "ENTRY_WATCH_COMPLETE",
          partial: false,
        });
        return;
      }

      if (isDead(status)) {
        const isRejected = status === "REJECTED";
        await this._updateTrade(tradeId, {
          status: isRejected ? STATUS.ENTRY_FAILED : STATUS.ENTRY_CANCELLED,
          closeReason: `ENTRY_${status}${msg ? " | " + msg : ""}`,
        });
        await this._finalizeClosed(tradeId, t.instrument_token);
        return;
      }

      if (
        String(env.ENTRY_PENDING_EDGE_REVALIDATE_ENABLED ?? "true") ===
          "true" &&
        String(t.entryOrderType || "LIMIT").toUpperCase() === "LIMIT" &&
        [
          STATUS.ENTRY_OPEN,
          STATUS.ENTRY_PLACED,
          STATUS.ENTRY_REPLACED,
        ].includes(t.status)
      ) {
        const marketState = await this._getPendingEntryMarketState(t);
        const pending = evaluatePendingEntryState({
          trade: t,
          quote: marketState.quote,
          underlyingLtp: marketState.underlyingLtp,
          nowTs: Date.now(),
          env,
          profile,
          currentOrderPrice: Number(t.expectedEntryPrice ?? 0),
        });
        if (
          !pending.ok &&
          String(env.ENTRY_PENDING_CANCEL_ON_EDGE_DECAY ?? "true") === "true"
        ) {
          await this._updateTrade(tradeId, {
            entryPendingLastReason: pending.cancelReason,
            entryPendingLastCheckAt: new Date(),
            executionGateReason: pending.cancelReason,
          });
          const result = await this._cancelOpenEntryOrder({
            tradeId,
            entryOrderId,
            reason: pending.cancelReason,
            purpose: "ENTRY_EDGE_DECAY",
          });
          if (result?.done !== false) return;
        }
      }

      await sleep(pollMs);
    }

    // -------- timeout handling --------

    // If entry is still alive after watch window, cancel it to avoid a stale fill later.

    // This is especially important for LIMIT entries.

    const tFinal = await getTrade(tradeId);

    if (!tFinal) return;
    if (String(tFinal.entryOrderId || "") !== String(entryOrderId)) return;

    // already progressed in between

    if (
      [
        STATUS.LIVE,

        STATUS.EXITED_TARGET,

        STATUS.EXITED_SL,

        STATUS.ENTRY_FILLED,

        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,

        STATUS.GUARD_FAILED,

        STATUS.CLOSED,
      ].includes(tFinal.status)
    ) {
      return;
    }

    let status = null;

    let avg = null;

    let filledQty = null;

    let msg = null;

    // Try order history first (more reliable than getOrders for old/rejected orders)

    if (typeof this.kite.getOrderHistory === "function") {
      try {
        const hist = await this.kite.getOrderHistory(entryOrderId);

        const last = Array.isArray(hist) ? hist[hist.length - 1] : null;

        status = last?.status;

        avg = last?.average_price;

        filledQty = last?.filled_quantity;

        msg = last?.status_message_raw || last?.status_message || null;
      } catch {
        // ignore
      }
    }

    if (!status) {
      try {
        const orders = await this.kite.getOrders();

        const o = (orders || []).find(
          (x) => String(x.order_id || x.orderId) === String(entryOrderId),
        );

        status = o?.status;

        avg = o?.average_price;

        filledQty = o?.filled_quantity;

        msg = o?.status_message_raw || o?.status_message || null;
      } catch {
        // ignore
      }
    }

    status = String(status || "").toUpperCase();

    if (status === "COMPLETE") {
      const avgPx = Number(avg) || Number(tFinal.expectedEntryPrice) || 0;
      const qty = Number(filledQty ?? tFinal.qty ?? 0);
      await this._finalizeEntryFill({
        tradeId,
        trade: tFinal,
        avgPrice: avgPx,
        filledQty: qty,
        source: "ENTRY_WATCH_TIMEOUT_COMPLETE",
        partial: false,
      });
      return;
    }

    if (isDead(status)) {
      const isRejected = status === "REJECTED";
      await this._updateTrade(tradeId, {
        status: isRejected ? STATUS.ENTRY_FAILED : STATUS.ENTRY_CANCELLED,

        closeReason: `ENTRY_${status}${msg ? " | " + String(msg) : ""}`,
      });

      await this._finalizeClosed(tradeId, tFinal.instrument_token);

      return;
    }

    const cancelOnTimeout =
      String(env.CANCEL_ENTRY_ON_TIMEOUT || "true") === "true";

    if (cancelOnTimeout) {
      const timeoutCancel = await this._cancelOpenEntryOrder({
        tradeId,
        entryOrderId,
        reason: "ENTRY_TIMEOUT_CANCELLED",
        purpose: "ENTRY_TIMEOUT",
      });
      if (timeoutCancel?.done !== false) return;

      logger.error(
        {
          tradeId,
          entryOrderId,
          reason: timeoutCancel?.reason || null,
          recovery: timeoutCancel?.recovery || null,
        },
        "[entry_watch] timeout cancel unresolved; recovery escalated",
      );
      return;
    }

    await this._recoverAmbiguousEntryState({
      tradeId,
      entryOrderId,
      source: "ENTRY_WATCH_TIMEOUT_NO_CANCEL",
      reason: "ENTRY_TIMEOUT_NO_CANCEL",
    });
  }

  _clearEntryLimitFallbackTimer(tradeId) {
    const id = String(tradeId || "");
    if (!id) return;
    const timer = this._entryFallbackTimers.get(id);
    if (timer) clearTimeout(timer);
    this._entryFallbackTimers.delete(id);
  }

  _scheduleEntryLimitFallback({
    tradeId,
    entryOrderId,
    entryParams,
    timeoutMs,
  }) {
    const id = String(tradeId || "");
    const oid = String(entryOrderId || "");
    const ms = Number(timeoutMs ?? 0);
    if (!id || !oid || ms <= 0) return;
    if (this._stopped) return;

    this._clearEntryLimitFallbackTimer(id);

    const timer = setTimeout(() => {
      this._entryLimitFallbackFire({
        tradeId: id,
        entryOrderId: oid,
        entryParams,
      }).catch((e) => {
        logger.warn(
          { tradeId: id, entryOrderId: oid, e: e.message },
          "[entry_fallback] failed",
        );
      });
    }, ms);

    this._entryFallbackTimers.set(id, timer);
  }

  async _entryLimitFallbackFire(args) {
    return this._runTradeCommand(
      args?.tradeId,
      EXEC_COMMAND.HANDLE_TIMEOUT,
      async () => this._entryLimitFallbackFireImpl(args),
      { allowMissing: true },
    );
  }

  async _entryLimitFallbackFireImpl({ tradeId, entryOrderId, entryParams }) {
    if (this._stopped) return;
    const tradeKey = String(tradeId || "");
    if (!tradeKey) return;
    if (this._entryFallbackInFlight.has(tradeKey)) {
      logger.info(
        { tradeId, entryOrderId },
        "[entry_fallback] skipped; already in-flight",
      );
      return;
    }

    this._entryFallbackInFlight.add(tradeKey);
    const t = await getTrade(tradeId);
    if (!t) {
      this._entryFallbackInFlight.delete(tradeKey);
      return;
    }

    if (t.entryFinalized === true) {
      this._clearEntryLimitFallbackTimer(tradeId);
      this._entryFallbackInFlight.delete(tradeKey);
      return;
    }

    try {
      await this._updateTrade(tradeId, {
        entryFallbackInFlight: true,
        entryFallbackStartedAt: new Date(),
      });

      const terminal = [
        STATUS.LIVE,
        STATUS.SL_PLACED,
        STATUS.SL_OPEN,
        STATUS.SL_CONFIRMED,
        STATUS.PANIC_EXIT_PLACED,
        STATUS.PANIC_EXIT_CONFIRMED,
        STATUS.ENTRY_FILLED,
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,
        STATUS.ENTRY_REPLACED,
        STATUS.CLOSED,
        STATUS.GUARD_FAILED,
      ];
      if (terminal.includes(t.status)) {
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      const statusInfo = await this._getOrderStatus(entryOrderId);
      const status = String(statusInfo?.status || "").toUpperCase();
      const order = statusInfo?.order || {};
      const filledNow = Number(order.filled_quantity ?? 0);
      const avgNow = Number(
        order.average_price ?? t.entryPrice ?? t.candle?.close ?? 0,
      );

      if (status === "COMPLETE") {
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice:
            avgNow > 0
              ? avgNow
              : Number(
                  t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                ),
          filledQty: Number(order.filled_quantity ?? t.qty ?? 0),
          source: "ENTRY_LIMIT_FALLBACK_STATUS",
          partial: false,
        });
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
        const qty = Number(order.filled_quantity ?? t.qty);
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_FILLED,
          entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
          qty,
          entryFinalized: true,
        });
        await this._placeExitsIfMissing({
          ...t,
          entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
          qty,
        });
        await this._ensureExitQty(tradeId, qty);
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      if (isDead(status)) {
        if (status === "REJECTED") {
          this._recordTradeDecision({
            trade: t,
            outcome: "BLOCKED",
            stage: "entry_timeout",
            reason: "ENTRY_REJECTED",
            meta: { source: "ENTRY_LIMIT_FALLBACK_STATUS" },
          });
          await this._updateTrade(tradeId, {
            status: STATUS.ENTRY_FAILED,
            closeReason: `ENTRY_${status}`,
          });
          await this._finalizeClosed(tradeId, t.instrument_token);
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
        }
        if (filledNow > 0) {
          await this._finalizeEntryFill({
            tradeId,
            trade: t,
            avgPrice:
              avgNow > 0
                ? avgNow
                : Number(
                    t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                  ),
            filledQty: filledNow,
            source: "ENTRY_LIMIT_FALLBACK_STATUS",
            partial: true,
            reason: status,
          });
          logger.warn(
            { tradeId, entryOrderId, filledQty: filledNow, status },
            "[entry_fallback] dead status with partial fill; skipping MARKET fallback",
          );
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
          await this._updateTrade(tradeId, {
            status: STATUS.ENTRY_OPEN,
            entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
            qty: filledNow,
            entryFinalized: true,
          });
          await this._placeExitsIfMissing({
            ...t,
            entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
            qty: filledNow,
          });
          await this._ensureExitQty(tradeId, filledNow);
          logger.warn(
            { tradeId, entryOrderId, filledQty: filledNow, status },
            "[entry_fallback] dead status with partial fill; skipping MARKET fallback",
          );
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
        }
      }

      if (filledNow > 0) {
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice:
            avgNow > 0
              ? avgNow
              : Number(
                  t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                ),
          filledQty: filledNow,
          source: "ENTRY_LIMIT_FALLBACK_STATUS",
          partial: true,
          reason: status || "PARTIAL_FILL",
        });
        logger.warn(
          { tradeId, entryOrderId, filledQty: filledNow },
          "[entry_fallback] partial fill detected; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_OPEN,
          entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
          qty: filledNow,
          entryFinalized: true,
        });
        await this._placeExitsIfMissing({
          ...t,
          entryPrice: avgNow > 0 ? avgNow : t.entryPrice,
          qty: filledNow,
        });
        await this._ensureExitQty(tradeId, filledNow);
        logger.warn(
          { tradeId, entryOrderId, filledQty: filledNow },
          "[entry_fallback] partial fill detected; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      // Final safety recheck before aggressive fallback (race window between exchange fill and this timer)
      const graceMs = Math.max(
        0,
        Number(env.ENTRY_LIMIT_FALLBACK_GRACE_MS ?? 250),
      );
      if (graceMs > 0) {
        await sleep(graceMs);

        const againInfo = await this._getOrderStatus(entryOrderId);
        const againStatus = String(againInfo?.status || "").toUpperCase();
        const againOrder = againInfo?.order || {};
        const filledAgain = Number(againOrder.filled_quantity ?? 0);
        const avgAgain = Number(
          againOrder.average_price ?? t.entryPrice ?? t.candle?.close ?? 0,
        );

        if (againStatus === "COMPLETE") {
          await this._finalizeEntryFill({
            tradeId,
            trade: t,
            avgPrice:
              avgAgain > 0
                ? avgAgain
                : Number(
                    t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                  ),
            filledQty: Number(againOrder.filled_quantity ?? t.qty ?? 0),
            source: "ENTRY_LIMIT_FALLBACK_GRACE",
            partial: false,
          });
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
          const qty = Number(againOrder.filled_quantity ?? t.qty);
          await this._updateTrade(tradeId, {
            status: STATUS.ENTRY_FILLED,
            entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
            qty,
            entryFinalized: true,
          });
          await this._placeExitsIfMissing({
            ...t,
            entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
            qty,
          });
          await this._ensureExitQty(tradeId, qty);
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
        }

        if (isDead(againStatus)) {
          if (againStatus === "REJECTED") {
            await this._updateTrade(tradeId, {
              status: STATUS.ENTRY_FAILED,
              closeReason: `ENTRY_${againStatus}`,
            });
            await this._finalizeClosed(tradeId, t.instrument_token);
            this._clearEntryLimitFallbackTimer(tradeId);
            return;
          }
          if (filledAgain > 0) {
            await this._finalizeEntryFill({
              tradeId,
              trade: t,
              avgPrice:
                avgAgain > 0
                  ? avgAgain
                  : Number(
                      t.entryPrice ??
                        t.expectedEntryPrice ??
                        t.candle?.close ??
                        0,
                    ),
              filledQty: filledAgain,
              source: "ENTRY_LIMIT_FALLBACK_GRACE",
              partial: true,
              reason: againStatus,
            });
            logger.warn(
              {
                tradeId,
                entryOrderId,
                filledQty: filledAgain,
                status: againStatus,
              },
              "[entry_fallback] dead status with partial fill; skipping MARKET fallback",
            );
            this._clearEntryLimitFallbackTimer(tradeId);
            return;
            await this._updateTrade(tradeId, {
              status: STATUS.ENTRY_OPEN,
              entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
              qty: filledAgain,
              entryFinalized: true,
            });
            await this._placeExitsIfMissing({
              ...t,
              entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
              qty: filledAgain,
            });
            await this._ensureExitQty(tradeId, filledAgain);
            logger.warn(
              {
                tradeId,
                entryOrderId,
                filledQty: filledAgain,
                status: againStatus,
              },
              "[entry_fallback] dead status with partial fill; skipping MARKET fallback",
            );
            this._clearEntryLimitFallbackTimer(tradeId);
            return;
          }
        }

        if (filledAgain > 0) {
          await this._finalizeEntryFill({
            tradeId,
            trade: t,
            avgPrice:
              avgAgain > 0
                ? avgAgain
                : Number(
                    t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                  ),
            filledQty: filledAgain,
            source: "ENTRY_LIMIT_FALLBACK_GRACE",
            partial: true,
            reason: againStatus || "PARTIAL_FILL",
          });
          logger.warn(
            { tradeId, entryOrderId, filledQty: filledAgain },
            "[entry_fallback] partial fill detected; skipping MARKET fallback",
          );
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
          await this._updateTrade(tradeId, {
            status: STATUS.ENTRY_OPEN,
            entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
            qty: filledAgain,
            entryFinalized: true,
          });
          await this._placeExitsIfMissing({
            ...t,
            entryPrice: avgAgain > 0 ? avgAgain : t.entryPrice,
            qty: filledAgain,
          });
          await this._ensureExitQty(tradeId, filledAgain);
          logger.warn(
            { tradeId, entryOrderId, filledQty: filledAgain },
            "[entry_fallback] partial fill detected; skipping MARKET fallback",
          );
          this._clearEntryLimitFallbackTimer(tradeId);
          return;
        }
      }

      logger.warn(
        { tradeId, entryOrderId },
        "[entry_fallback] timeout -> cancel LIMIT then (if cancelled) place MARKET",
      );

      // Cancel LIMIT first, then verify CANCELLED vs late fill. Only then place MARKET.
      try {
        this.expectedCancelOrderIds.add(String(entryOrderId));
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY || "regular",
          entryOrderId,
          {
            purpose: "ENTRY_LIMIT_FALLBACK_CANCEL",
            tradeId,
          },
        );
      } catch (e) {
        // Cancel can fail if order just filled; we'll verify via history below.
        logger.warn(
          { tradeId, entryOrderId, e: e.message },
          "[entry_fallback] cancel attempt failed; verifying order status",
        );
      }

      const afterInfo = await this._checkLateFillAfterCancel(entryOrderId);
      const afterStatus = String(afterInfo?.status || "").toUpperCase();
      const afterOrder = afterInfo?.order || {};
      const filledAfter = Number(afterOrder.filled_quantity ?? 0);
      const avgAfter = Number(
        afterOrder.average_price ?? t.entryPrice ?? t.candle?.close ?? 0,
      );

      if (afterStatus === "COMPLETE") {
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice:
            avgAfter > 0
              ? avgAfter
              : Number(
                  t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                ),
          filledQty: Number(afterOrder.filled_quantity ?? t.qty ?? 0),
          source: "ENTRY_LIMIT_FALLBACK_CANCEL",
          partial: false,
        });
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
        const qty = Number(afterOrder.filled_quantity ?? t.qty);
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_FILLED,
          entryPrice: avgAfter > 0 ? avgAfter : t.entryPrice,
          qty,
          entryFinalized: true,
        });
        await this._placeExitsIfMissing({
          ...t,
          entryPrice: avgAfter > 0 ? avgAfter : t.entryPrice,
          qty,
        });
        await this._ensureExitQty(tradeId, qty);
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      if (filledAfter > 0) {
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice:
            avgAfter > 0
              ? avgAfter
              : Number(
                  t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                ),
          filledQty: filledAfter,
          source: "ENTRY_LIMIT_FALLBACK_CANCEL",
          partial: true,
          reason: afterStatus || "PARTIAL_FILL",
        });
        logger.warn(
          {
            tradeId,
            entryOrderId,
            filledQty: filledAfter,
            status: afterStatus,
          },
          "[entry_fallback] late/partial fill observed after cancel; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
        await this._updateTrade(tradeId, {
          status: STATUS.ENTRY_OPEN,
          entryPrice: avgAfter > 0 ? avgAfter : t.entryPrice,
          qty: filledAfter,
          entryFinalized: true,
        });
        await this._placeExitsIfMissing({
          ...t,
          entryPrice: avgAfter > 0 ? avgAfter : t.entryPrice,
          qty: filledAfter,
        });
        await this._ensureExitQty(tradeId, filledAfter);
        logger.warn(
          {
            tradeId,
            entryOrderId,
            filledQty: filledAfter,
            status: afterStatus,
          },
          "[entry_fallback] late/partial fill observed after cancel; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      // If cancel is still being processed, don't place MARKET yet — reschedule a short re-check.
      if (afterStatus && afterStatus !== "CANCELLED" && !isDead(afterStatus)) {
        logger.warn(
          { tradeId, entryOrderId, status: afterStatus },
          "[entry_fallback] cancel not confirmed; escalating recovery",
        );
        await this._recoverAmbiguousEntryState({
          tradeId,
          entryOrderId,
          source: "ENTRY_LIMIT_FALLBACK_CANCEL",
          reason: afterStatus || "CANCEL_NOT_CONFIRMED",
        });
        return;
      }

      // Re-check trade status before placing MARKET (it may have moved to ENTRY_FILLED/LIVE in parallel)
      const tNow = await getTrade(tradeId);
      if (!tNow || terminal.includes(tNow.status)) {
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      // Guard against feed/API lag: websocket update may already know ENTRY LIMIT got filled.
      const known = this._getKnownOrderStatus(entryOrderId);
      const knownStatus = String(known?.status || "").toUpperCase();
      const knownOrder = known?.order || {};
      const knownFilled = Number(knownOrder.filled_quantity ?? 0);
      const knownAvg = Number(
        knownOrder.average_price ?? t.entryPrice ?? t.candle?.close ?? 0,
      );
      if (knownStatus === "COMPLETE" || knownFilled > 0) {
        await this._finalizeEntryFill({
          tradeId,
          trade: t,
          avgPrice:
            knownAvg > 0
              ? knownAvg
              : Number(
                  t.entryPrice ?? t.expectedEntryPrice ?? t.candle?.close ?? 0,
                ),
          filledQty: Number(knownOrder.filled_quantity ?? t.qty ?? 0),
          source: "ENTRY_LIMIT_FALLBACK_STREAM",
          partial: knownStatus !== "COMPLETE",
          reason: knownStatus || "STREAM_FILL",
        });
        logger.warn(
          { tradeId, entryOrderId, knownStatus, knownFilled },
          "[entry_fallback] broker stream indicates late/complete fill; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
        const qty = Number(knownOrder.filled_quantity ?? t.qty);
        await this._updateTrade(tradeId, {
          status:
            knownStatus === "COMPLETE"
              ? STATUS.ENTRY_FILLED
              : STATUS.ENTRY_OPEN,
          entryPrice: knownAvg > 0 ? knownAvg : t.entryPrice,
          qty,
          entryFinalized: true,
        });
        await this._placeExitsIfMissing({
          ...t,
          entryPrice: knownAvg > 0 ? knownAvg : t.entryPrice,
          qty,
        });
        await this._ensureExitQty(tradeId, qty);
        logger.warn(
          { tradeId, entryOrderId, knownStatus, knownFilled },
          "[entry_fallback] broker stream indicates late/complete fill; skipping MARKET fallback",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      const marketParams = {
        ...entryParams,
        order_type: "MARKET",
      };
      delete marketParams.price;

      let fallbackOrderId = null;
      try {
        const out = await this._safePlaceOrder(
          env.DEFAULT_ORDER_VARIETY,
          marketParams,
          { purpose: "ENTRY_LIMIT_FALLBACK", tradeId },
        );
        fallbackOrderId = out.orderId;
      } catch (e) {
        this._recordTradeDecision({
          trade: tNow || t,
          outcome: "BLOCKED",
          stage: "entry_timeout",
          reason: "ENTRY_LIMIT_FALLBACK_MARKET_PLACE_FAILED",
          meta: { message: e?.message || String(e) },
        });
        logger.error(
          { tradeId, entryOrderId, e: e.message },
          "[entry_fallback] MARKET place failed",
        );
        this._clearEntryLimitFallbackTimer(tradeId);
        return;
      }

      await this._updateTrade(tradeId, {
        entryOrderId: fallbackOrderId,
        entryFallbackFrom: entryOrderId,
        entryFallbackPlacedAt: new Date(),
        entryPlacedAt: tNow?.entryPlacedAt || new Date(),
        status: STATUS.ENTRY_REPLACED,
        entryFinalized: false,
      });
      await linkOrder({
        order_id: String(fallbackOrderId),
        tradeId,
        role: "ENTRY",
      });
      await this._replayOrphanUpdates(fallbackOrderId);

      this._clearEntryLimitFallbackTimer(tradeId);
    } finally {
      this._entryFallbackInFlight.delete(tradeKey);
      await this._updateTrade(tradeId, {
        entryFallbackInFlight: false,
        entryFallbackLastCompletedAt: new Date(),
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
    }
  }

  async _watchExitLeg(tradeId, orderId, role) {
    if (this._stopped) return;
    const oid = String(orderId || "");
    if (!oid) return;
    if (String(role || "").toUpperCase() === "SL") return;

    const pollMs = Number(env.EXIT_WATCH_POLL_MS ?? 1000);
    const maxMs = Number(env.EXIT_WATCH_MS ?? 20000);
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      if (this._stopped) return;
      const t = await getTrade(tradeId);
      if (!t) return;

      if (
        [
          STATUS.EXITED_TARGET,
          STATUS.EXITED_SL,
          STATUS.ENTRY_FAILED,
          STATUS.ENTRY_CANCELLED,
          STATUS.GUARD_FAILED,
          STATUS.CLOSED,
        ].includes(t.status)
      ) {
        return;
      }

      let status = null;
      let last = null;

      if (typeof this.kite.getOrderHistory === "function") {
        try {
          const hist = await this.kite.getOrderHistory(oid);
          last = Array.isArray(hist) ? hist[hist.length - 1] : null;
          status = String(last?.status || "").toUpperCase();
          if (last) await this.onOrderUpdate(last);
        } catch {
          // ignore
        }
      }

      status = String(status || "").toUpperCase();
      if (status === "COMPLETE") return;

      if (isDead(status)) {
        // onOrderUpdate should handle the required reactions.
        return;
      }

      await sleep(pollMs);
    }

    logger.warn({ tradeId, orderId: oid, role }, "[exit_watch] timeout");
  }

  _armStopLossSla({ tradeId, slOrderId, instrumentToken }) {
    const slaMs = Math.max(1000, Number(env.SL_SAFETY_SLA_MS ?? 3000));
    if (!tradeId || !slOrderId) return;
    if (this._stopped) return;

    const id = String(tradeId);
    this._clearStopLossSlaTimer(id);

    const timer = setTimeout(async () => {
      try {
        this._slSafetyTimers.delete(id);
        if (this._stopped) return;
        const trade = await getTrade(tradeId);
        if (!trade) return;
        if (
          [STATUS.EXITED_TARGET, STATUS.EXITED_SL, STATUS.CLOSED].includes(
            String(trade.status || ""),
          )
        )
          return;

        let status = "";
        if (typeof this.kite.getOrderHistory === "function") {
          const hist = await this.kite.getOrderHistory(String(slOrderId));
          const last = Array.isArray(hist) ? hist[hist.length - 1] : null;
          status = String(last?.status || "").toUpperCase();
        }

        const confirmed = [
          "OPEN",
          "TRIGGER PENDING",
          "COMPLETE",
          "PARTIAL",
        ].includes(status);
        if (confirmed) {
          await this._updateTrade(tradeId, {
            status: STATUS.SL_CONFIRMED,
            slConfirmedAt: new Date(),
          });
          return;
        }

        const token = Number(instrumentToken ?? trade.instrument_token);
        const cooldownMin = Math.max(
          1,
          Number(env.SL_SLA_BREACH_COOLDOWN_MIN ?? 5),
        );
        if (Number.isFinite(token) && token > 0 && this.risk?.setCooldown) {
          this.risk.setCooldown(
            trade?.riskKey || String(token),
            cooldownMin * 60,
            "SL_SLA_BREACH",
          );
        }

        logger.error(
          { tradeId, slOrderId, status, slaMs, token },
          "[trade] SL guarantee SLA breached -> panic exit",
        );
        await this._panicExit(trade, "SL_SLA_BREACH", {
          allowWhenHalted: true,
        });
      } catch (e) {
        logger.warn(
          { tradeId, slOrderId, e: e?.message || String(e) },
          "[trade] SL SLA watchdog failed",
        );
      }
    }, slaMs);
    this._slSafetyTimers.set(id, timer);
  }

  _defaultNoTradeWindows() {
    // Recommended for scalping
    return "09:15-09:25,15:20-15:30";
  }

  _isBlockedByNoTradeWindow() {
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const now = DateTime.now().setZone(tz);
    const ranges =
      String(env.NO_TRADE_WINDOWS || "").trim() ||
      this._defaultNoTradeWindows();

    const windows = parseTimeWindows(ranges);
    return isWithinAnyWindow(now, windows);
  }
  async _spreadCheck(instrument, opts = {}) {
    const sampleOnly = !!opts.sampleOnly;
    const allowWhenDisabled = !!opts.allowWhenDisabled;

    const enabled = String(env.ENABLE_SPREAD_FILTER) === "true";
    if (!enabled && !(sampleOnly && allowWhenDisabled)) return { ok: true };

    // OPT mode is extremely sensitive to liquidity.
    // Fail-closed if we can't verify bid/ask depth (prevents illiquid / spoofed strikes).
    const strictOptDepth = this._isOptMode();

    if (typeof this.kite.getQuote !== "function") {
      return strictOptDepth
        ? { ok: false, reason: "NO_GETQUOTE_FN" }
        : { ok: true, note: "no_getQuote" };
    }

    const ex = instrument.exchange || env.DEFAULT_EXCHANGE || "NSE";
    const sym = instrument.tradingsymbol;
    const key = `${String(ex).toUpperCase()}:${String(sym).toUpperCase()}`;

    try {
      const resp = await this.kite.getQuote([key]);
      const q = resp?.[key];
      const bid = Number(q?.depth?.buy?.[0]?.price);
      const ask = Number(q?.depth?.sell?.[0]?.price);
      const ltp = Number(q?.last_price);

      const hasDepth =
        Number.isFinite(bid) &&
        Number.isFinite(ask) &&
        bid > 0 &&
        ask > 0 &&
        ask >= bid;

      if (!hasDepth) {
        if (strictOptDepth) {
          return { ok: false, reason: "NO_DEPTH", meta: { bid, ask, ltp } };
        }
        return { ok: true, note: "no_depth" };
      }

      const mid = (bid + ask) / 2;
      const bps = ((ask - bid) / mid) * 10000;

      const maxBps = Number.isFinite(Number(opts.maxBps))
        ? Number(opts.maxBps)
        : this._getMaxSpreadBps(instrument);

      if (!Number.isFinite(bps)) {
        if (strictOptDepth) {
          return {
            ok: false,
            reason: "SPREAD_BPS_NAN",
            meta: { bid, ask, ltp, bps },
          };
        }
        return { ok: true, note: "spread_nan", meta: { bid, ask, ltp, bps } };
      }

      if (!sampleOnly && enabled && bps > maxBps) {
        return {
          ok: false,
          reason: `SPREAD_TOO_WIDE (${bps.toFixed(1)} bps > ${maxBps})`,
          meta: { bid, ask, ltp, bps },
        };
      }

      return {
        ok: true,
        meta: { bid, ask, ltp, bps },
        note: bps > maxBps ? "spread_wide_sample" : null,
      };
    } catch (e) {
      logger.warn(
        { e: e.message },
        strictOptDepth
          ? "[filters] spread check failed; blocking trade (OPT strict)"
          : "[filters] spread check failed; allowing trade",
      );
      return strictOptDepth
        ? {
            ok: false,
            reason: "QUOTE_ERROR",
            note: "quote_error",
            meta: { message: e.message },
          }
        : { ok: true, note: "quote_error" };
    }
  }

  async _expectedMoveModel({ token, baseIntervalMin, atrPeriod, closeHint }) {
    const atrMult = Number(env.EXPECTED_MOVE_ATR_MULT ?? 0.5);
    const horizonMin = Number(env.EXPECTED_MOVE_HORIZON_MIN ?? 15);

    // Prefer computing ATR on a realistic horizon interval if it exists; else fall back.
    const refIntervals = String(env.EXPECTED_MOVE_REF_INTERVALS || "15,5,3,1")
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    const candidates = [];
    const pushUnique = (n) => {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return;
      if (!candidates.includes(v)) candidates.push(v);
    };

    pushUnique(horizonMin);
    for (const n of refIntervals) pushUnique(n);
    pushUnique(baseIntervalMin);

    const limit = Math.max(60, Number(env.ATR_LOOKBACK_LIMIT ?? 200));
    let usedIntervalMin = null;
    let atr = null;
    let usedLen = null;

    for (const iv of candidates) {
      try {
        const cs = await getRecentCandles(token, iv, limit);
        if (!cs || cs.length < Math.max(atrPeriod + 5, 30)) continue;
        const a = atrLast(cs, atrPeriod);
        if (!Number.isFinite(a) || a <= 0) continue;
        usedIntervalMin = iv;
        atr = a;
        usedLen = cs.length;
        break;
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    }

    // Hard fallback to base interval candle ATR if everything failed
    if (!Number.isFinite(atr)) {
      try {
        const cs = await getRecentCandles(token, baseIntervalMin, limit);
        if (cs && cs.length) {
          const a = atrLast(cs, atrPeriod);
          if (Number.isFinite(a) && a > 0) {
            usedIntervalMin = baseIntervalMin;
            atr = a;
            usedLen = cs.length;
          }
        }
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    }

    let scaleFactor = 1;
    const scaleMode = String(
      env.EXPECTED_MOVE_SCALE_MODE || "SQRT_TIME",
    ).toUpperCase();
    if (
      scaleMode !== "NONE" &&
      Number.isFinite(usedIntervalMin) &&
      usedIntervalMin > 0 &&
      Number.isFinite(horizonMin) &&
      horizonMin > 0 &&
      usedIntervalMin !== horizonMin
    ) {
      // volatility ~ sqrt(time) scaling
      scaleFactor = Math.sqrt(horizonMin / usedIntervalMin);
    }

    const expectedMovePerShare =
      Number.isFinite(atr) && atr > 0 ? atr * atrMult * scaleFactor : null;

    return {
      expectedMovePerShare,
      meta: {
        horizonMin,
        atrPeriod,
        atrMult,
        baseIntervalMin: Number(baseIntervalMin),
        usedIntervalMin,
        usedLen,
        scaleMode,
        scaleFactor,
        atr,
        closeHint: Number.isFinite(closeHint) ? Number(closeHint) : null,
      },
    };
  }

  async _multiTfTrend(token) {
    if (String(env.MULTI_TF_ENABLED || "true") !== "true") {
      return { ok: true, note: "multi_tf_disabled" };
    }

    const base = Number(env.MULTI_TF_INTERVAL_MIN ?? 5);
    const candidates = [base, 3, 5, 15]
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n) && n > 0);

    const limit = Math.max(80, Number(env.MTF_LOOKBACK_LIMIT ?? 200));
    const fastLen = Number(env.MULTI_TF_EMA_FAST ?? 9);
    const slowLen = Number(env.MULTI_TF_EMA_SLOW ?? 21);

    let usedIntervalMin = null;
    let candles = null;

    for (const iv of candidates) {
      try {
        const cs = await getRecentCandles(token, iv, limit);
        if (!cs || cs.length < Math.max(slowLen + 10, 40)) continue;
        usedIntervalMin = iv;
        candles = cs;
        break;
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    }

    if (!candles) return { ok: true, note: "multi_tf_no_data" };

    const closes = candles
      .map((c) => Number(c.close))
      .filter((x) => Number.isFinite(x));

    if (closes.length < Math.max(slowLen + 5, 30)) {
      return { ok: true, note: "multi_tf_insufficient_closes" };
    }

    const emaFast = emaLast(closes, fastLen);
    const emaSlow = emaLast(closes, slowLen);
    const lastClose = closes[closes.length - 1];

    let trend = "FLAT";
    if (Number.isFinite(emaFast) && Number.isFinite(emaSlow)) {
      if (emaFast > emaSlow) trend = "UP";
      else if (emaFast < emaSlow) trend = "DOWN";
    }

    const diff =
      Number.isFinite(emaFast) && Number.isFinite(emaSlow)
        ? Math.abs(emaFast - emaSlow)
        : null;
    const strengthBps =
      Number.isFinite(diff) && Number.isFinite(lastClose) && lastClose > 0
        ? (diff / lastClose) * 10000
        : null;

    return {
      ok: true,
      meta: {
        usedIntervalMin,
        emaFastLen: fastLen,
        emaSlowLen: slowLen,
        emaFast,
        emaSlow,
        lastClose,
        trend,
        strengthBps,
      },
    };
  }

  async _multiTfConfirm(token, side) {
    const info = await this._multiTfTrend(token);
    if (!info.ok) return info;

    // If disabled/no data, pass through
    const emaFast = info?.meta?.emaFast;
    const emaSlow = info?.meta?.emaSlow;
    if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) {
      return { ok: true, meta: info?.meta || null };
    }

    const trendOk = side === "BUY" ? emaFast > emaSlow : emaFast < emaSlow;

    if (!trendOk) {
      return {
        ok: false,
        reason: "MULTI_TF_TREND_MISMATCH",
        meta: info?.meta || null,
      };
    }

    return { ok: true, meta: info?.meta || null };
  }

  async _regimeFilters({
    token,
    side,
    intervalMin,
    strategyId,
    strategyStyle,
    signalRegime,
    regimeSnapshot,
    signalId,
    policy,
    underlying,
    isTradeToken,
  }) {
    if (String(env.REGIME_FILTERS_ENABLED) !== "true") return { ok: true };

    const limit = 250;
    const candles = await getRecentCandles(token, intervalMin, limit);

    if (!Array.isArray(candles) || candles.length < 30) {
      return { ok: true, note: "insufficient_candles" };
    }

    const last = candles[candles.length - 1];

    // Base context for all filters (also feeds cost/edge gating)
    const close = Number(last.close);
    const atrPeriod = Number(env.EXPECTED_MOVE_ATR_PERIOD ?? 14);
    const atrBase = atrLast(candles, atrPeriod);
    const atr = atrBase; // FIX: prevent "atr is not defined"
    const style = String(strategyStyle || "").toUpperCase() || "UNKNOWN";
    const det = detectRegime({ candles, env, now: new Date() });
    const resolvedRegime = resolveSignalRegimeSnapshot({
      signal: {
        signalId,
        regime: signalRegime,
        regimeSnapshot,
      },
      liveDetection: det,
      intervalMin,
      nowMs: Date.now(),
      liveTs: last?.ts || null,
    });
    const effectiveSnapshot = resolvedRegime.snapshot;
    const effectiveRegime =
      effectiveSnapshot?.regime && effectiveSnapshot.regime !== "UNKNOWN"
        ? effectiveSnapshot.regime
        : signalRegime || det?.regime || null;

    if (resolvedRegime.mismatch) {
      logger.warn(
        withSignalLifecycleMeta(
          { signalId, regimeSnapshotId: regimeSnapshot?.snapshotId || null },
          {
            mismatchReasons: resolvedRegime.mismatchReasons,
            frozenSnapshotId: resolvedRegime.frozenSnapshot?.snapshotId || null,
            frozenSnapshotTs: resolvedRegime.frozenSnapshot?.timestamp || null,
            liveSnapshotId: resolvedRegime.liveSnapshot?.snapshotId || null,
            liveSnapshotTs: resolvedRegime.liveSnapshot?.timestamp || null,
            frozenRegime: resolvedRegime.frozenSnapshot?.regime || null,
            liveRegime: resolvedRegime.liveSnapshot?.regime || null,
            intervalMin,
          },
        ),
        "REGIME_SNAPSHOT_MISMATCH",
      );
    }

    const em = await this._expectedMoveModel({
      token,
      baseIntervalMin: intervalMin,
      atrPeriod,
      closeHint: close,
    });

    const baseMeta = {
      signalId: signalId || null,
      intervalMin,
      close: Number.isFinite(close) ? close : null,
      atr: Number.isFinite(atrBase) ? atrBase : null,
      atrBase: Number.isFinite(atrBase) ? atrBase : null,
      expectedMovePerShare: Number.isFinite(em?.expectedMovePerShare)
        ? Number(em.expectedMovePerShare)
        : null,
      expectedMoveMeta: em?.meta || null,
      regime: effectiveRegime,
      regimeFamily: effectiveSnapshot?.regimeFamily || null,
      primaryRegime:
        effectiveSnapshot?.primaryRegime && effectiveSnapshot.primaryRegime !== "UNKNOWN"
          ? effectiveSnapshot.primaryRegime
          : det?.primaryRegime || null,
      secondaryRegime:
        effectiveSnapshot?.secondaryRegime && effectiveSnapshot.secondaryRegime !== "UNKNOWN"
          ? effectiveSnapshot.secondaryRegime
          : det?.secondaryRegime || null,
      regimeReason:
        resolvedRegime.frozenSnapshot && !resolvedRegime.mismatch
          ? "FROZEN_SIGNAL_SNAPSHOT"
          : det?.reason || null,
      regimeSnapshotId: effectiveSnapshot?.snapshotId || null,
      regimeSnapshotTs: effectiveSnapshot?.timestamp || null,
      compressionActive:
        effectiveSnapshot?.compressionActive === true ||
        effectiveRegime === "TREND_COMPRESSED",
      strategyId: strategyId || null,
      strategyStyle: style,
    };

    // Strategy-aware regime gating (pro-level, but tunable)
    if (String(env.STRATEGY_STYLE_REGIME_GATES_ENABLED || "true") === "true") {
      const styleGate = isStrategyStyleAllowedForRegime({
        strategyStyle: style,
        regime: baseMeta.regime,
        env,
      });
      if (!styleGate.allowed) {
        return {
          ok: false,
          reason: `STYLE_REGIME_MISMATCH (${styleGate.strategyStyle} in ${styleGate.regime})`,
          meta: {
            ...baseMeta,
            allowedRegimes: styleGate.allowedRegimes,
          },
        };
      }
    }

    // Relative volume (last vs avg of last N)
    if (String(env.ENABLE_REL_VOLUME_FILTER) === "true" && isTradeToken) {
      const n = 20;
      if (candles.length < n + 2)
        return { ok: false, reason: "REL_VOLUME_INSUFFICIENT_DATA" };
      const tail = candles.slice(-n - 1, -1);
      const avg = avgNum(tail.map((c) => Number(c.volume)));
      const cur = Number(last.volume);
      if (Number.isFinite(avg) && avg > 0 && Number.isFinite(cur)) {
        const rel = cur / avg;
        // Dynamic pacing: scale minRel thresholds up/down while preserving per-style ratios
        const baseRel = Number(env.MIN_REL_VOLUME ?? 1.0);
        const dynBase = Number.isFinite(Number(policy?.minRelVolBase))
          ? Number(policy.minRelVolBase)
          : baseRel;
        const scale = baseRel > 0 ? dynBase / baseRel : 1.0;

        const styleRel =
          style === "TREND"
            ? Number(env.MIN_REL_VOLUME_TREND ?? baseRel)
            : style === "RANGE"
              ? Number(env.MIN_REL_VOLUME_RANGE ?? baseRel)
              : style === "OPEN"
                ? Number(env.MIN_REL_VOLUME_OPEN ?? baseRel)
                : baseRel;

        const minRel = Math.max(0, styleRel * scale);

        if (rel < minRel) {
          return {
            ok: false,
            reason: `REL_VOLUME_TOO_LOW (${rel.toFixed(2)}x)`,
            meta: { ...baseMeta, rel, cur, avg },
          };
        }
      }
    }
    // ATR volatility filter
    if (String(env.ENABLE_VOLATILITY_FILTER) === "true") {
      if (Number.isFinite(atr) && Number.isFinite(close) && close > 0) {
        const atrPct = (atr / close) * 100;

        const baseMinAtrPct = Number(env.MIN_ATR_PCT ?? 0.04);

        // Index underlyings have huge prices; % floors can wrongly block decent ATR.
        // Convert a points-based floor to % for indices.
        let minAtrPct = baseMinAtrPct;
        if (underlying) {
          const u = String(underlying).toUpperCase();
          const pointsByUnderlying = {
            NIFTY: Number(env.MIN_ATR_POINTS_NIFTY ?? 10),
            BANKNIFTY: Number(env.MIN_ATR_POINTS_BANKNIFTY ?? 20),
            SENSEX: Number(env.MIN_ATR_POINTS_SENSEX ?? 15),
          };
          const minPts = pointsByUnderlying[u];
          if (Number.isFinite(minPts) && minPts > 0) {
            minAtrPct = (minPts / close) * 100;
          }
        }

        const maxAtrPct = Number(env.MAX_ATR_PCT ?? 2.5);

        if (atrPct < minAtrPct) {
          return {
            ok: false,
            reason: `ATR_TOO_LOW (${atrPct.toFixed(3)}% < ${minAtrPct.toFixed(3)}%)`,
            meta: {
              ...baseMeta,
              atrPct,
              minAtrPct,
              underlying: underlying ?? null,
            },
          };
        }

        if (atrPct > maxAtrPct) {
          return {
            ok: false,
            reason: `ATR_TOO_HIGH (${atrPct.toFixed(2)}% > ${maxAtrPct.toFixed(2)}%)`,
            meta: {
              ...baseMeta,
              atrPct,
              maxAtrPct,
              underlying: underlying ?? null,
            },
          };
        }
      }
    }

    // Range percentile filter (optional)
    if (String(env.ENABLE_RANGE_PCTL_FILTER) === "true") {
      const lookback = Math.max(20, Number(env.RANGE_PCTL_LOOKBACK ?? 50));
      const ranges = candles
        .slice(-lookback)
        .map((c) => {
          const hi = Number(c.high);
          const lo = Number(c.low);
          const cl = Number(c.close);
          if (
            !Number.isFinite(hi) ||
            !Number.isFinite(lo) ||
            !Number.isFinite(cl) ||
            cl <= 0
          )
            return null;
          return ((hi - lo) / cl) * 100;
        })
        .filter((x) => x != null);
      if (ranges.length >= 20) {
        const cur = ranges[ranges.length - 1];
        const hist = ranges.slice(0, -1);
        const p = percentileRank(hist, cur);
        const minP = Number(env.MIN_RANGE_PCTL ?? 30);
        const maxP = Number(env.MAX_RANGE_PCTL ?? 99);
        if (p < minP)
          return {
            ok: false,
            reason: `RANGE_TOO_LOW_PCTL (${p.toFixed(0)} < ${minP})`,
            meta: { ...baseMeta, p },
          };
        if (p > maxP)
          return {
            ok: false,
            reason: `RANGE_TOO_HIGH_PCTL (${p.toFixed(0)} > ${maxP})`,
            meta: { ...baseMeta, p },
          };
      }
    }

    // Multi-TF confirmation (strategy-aware)
    const mtfEnabled = String(env.MULTI_TF_ENABLED || "true") === "true";
    const mtfMode = String(env.MULTI_TF_MODE || "TREND_ONLY").toUpperCase();

    const shouldConfirm =
      mtfEnabled &&
      mtfMode !== "OFF" &&
      (mtfMode === "ALL" || (mtfMode === "TREND_ONLY" && style !== "RANGE"));

    if (shouldConfirm) {
      const tf = await this._multiTfConfirm(token, side);
      if (!tf.ok) {
        return { ...tf, meta: { ...baseMeta, ...(tf.meta || {}) } };
      }
      baseMeta.multiTf = tf.meta || null;
    } else if (
      style === "RANGE" &&
      String(env.RANGE_AVOID_TREND || "false") === "true"
    ) {
      // Optional mean-reversion safety: avoid fading into strong higher-TF trend
      const info = await this._multiTfTrend(token);
      const strength = info?.meta?.strengthBps;
      baseMeta.multiTf = info?.meta || null;

      const maxBps = Number(env.RANGE_MAX_TREND_STRENGTH_BPS ?? 40);
      if (
        Number.isFinite(strength) &&
        Number.isFinite(maxBps) &&
        strength > maxBps
      ) {
        return {
          ok: false,
          reason: `RANGE_STRONG_TREND (${Math.round(
            strength,
          )}bps > ${Math.round(maxBps)}bps)`,
          meta: { ...baseMeta },
        };
      }
    }

    return { ok: true, meta: { ...baseMeta } };
  }

  async _qualityGateStopLoss({
    entryGuess,
    stopLoss,
    side,
    instrument,
    minTicks,
    maxPct,
  }) {
    const tick = Number(instrument?.tick_size ?? 0.05);
    const slDist = Math.abs(Number(entryGuess) - Number(stopLoss));
    const ticks = tick > 0 ? slDist / tick : slDist;

    const minTicksVal = Number.isFinite(Number(minTicks))
      ? Number(minTicks)
      : Number(env.MIN_SL_TICKS ?? 2);
    if (Number.isFinite(ticks) && ticks < minTicksVal) {
      return {
        ok: false,
        reason: `SL_TOO_TIGHT (${ticks.toFixed(1)} ticks < ${minTicksVal})`,
      };
    }

    const maxPctVal = Number.isFinite(Number(maxPct))
      ? Number(maxPct)
      : Number(env.MAX_SL_PCT ?? 1.0);
    if (Number.isFinite(entryGuess) && entryGuess > 0) {
      const pct = (slDist / entryGuess) * 100;
      if (pct > maxPctVal) {
        return {
          ok: false,
          reason: `SL_TOO_WIDE (${pct.toFixed(2)}% > ${maxPctVal}%)`,
        };
      }
    }

    // Logical sanity
    if (side === "BUY" && stopLoss >= entryGuess)
      return { ok: false, reason: "INVALID_SL_BUY" };
    if (side === "SELL" && stopLoss <= entryGuess)
      return { ok: false, reason: "INVALID_SL_SELL" };

    return { ok: true };
  }

  async onSignal(signal) {
    if (this._stopped) return;
    const signalCreatedAt =
      signal?.signalCreatedAt || new Date().toISOString();
    const signalDecisionTs =
      signal?.signalDecisionTs || signalCreatedAt;
    const signalEventTs = resolveSignalEventTs(signal, signalCreatedAt);
    const normalizedRegimeSnapshot =
      signal?.regimeSnapshot ||
      freezeSignalRegimeSnapshot({
        signal,
        context: {
          intervalMin: signal?.intervalMin ?? signal?.candle?.interval_min ?? 1,
          stage: signal?.stage || "trade_manager_receive",
          last: signal?.candle?.ts || signal?.ts || null,
        },
        selectorState: null,
        timestampMs:
          Date.parse(signalEventTs || "") ||
          Date.parse(signalCreatedAt) ||
          Date.now(),
      });
    signal = {
      ...(signal || {}),
      signalId: signal?.signalId || buildSignalLifecycleId(),
      signalCreatedAt,
      signalDecisionTs,
      signalEventTs,
      regimeSnapshot: normalizedRegimeSnapshot,
      regimeSnapshotId:
        signal?.regimeSnapshotId || normalizedRegimeSnapshot?.snapshotId || null,
      entryPipeline: {
        ...(signal?.entryPipeline || {}),
        signalCreatedAt,
        signalDecisionTs,
        signalEventTs,
      },
    };
    signal = {
      ...signal,
      conversionSummary: buildSignalConversionSummary(signal, {
        mtfState: signal?.mtfState || signal?.scoreBreakdown?.mtfState || null,
      }),
    };
    if (signal.signalDecision && typeof signal.signalDecision === "object") {
      signal.signalDecision = {
        ...signal.signalDecision,
        conversion: signal.conversionSummary,
      };
    }
    markEntryPipelineStage(signal, "routeStartAt");

    const applyConversionSummary = (signalLike, patch = {}) => {
      const nextSignal = {
        ...signalLike,
        conversionSummary: buildSignalConversionSummary(signalLike, patch),
      };
      if (nextSignal.signalDecision && typeof nextSignal.signalDecision === "object") {
        nextSignal.signalDecision = {
          ...nextSignal.signalDecision,
          conversion: nextSignal.conversionSummary,
        };
      }
      return nextSignal;
    };

    let s = signal;
    const recordSignalDecision = ({
      signalLike = s,
      trade = null,
      token = null,
      outcome,
      stage,
      reason,
      meta = {},
      conversion = null,
    }) => {
      const nextSignal = conversion
        ? applyConversionSummary(signalLike, conversion)
        : signalLike;
      if (signalLike === signal) signal = nextSignal;
      if (signalLike === s) s = nextSignal;
      this._recordTradeDecision({
        signal: nextSignal,
        trade,
        token,
        outcome,
        stage,
        reason,
        meta,
      });
      return nextSignal;
    };

    if (this.activeTradeId) {
      logger.info(
        withSignalLifecycleMeta(signal, { activeTradeId: this.activeTradeId }),
        "[signal] ignored (active trade exists)",
      );
      return;
    }

    if (this._isBlockedByNoTradeWindow()) {
      logger.info(
        withSignalLifecycleMeta(signal, { token: signal.instrument_token }),
        "[trade] blocked (no-trade window)",
      );
      return;
    }

    if (!getTradingEnabled()) {
      logger.info(
        withSignalLifecycleMeta(signal, {
          token: signal.instrument_token,
          side: signal.side,
          reason: signal.reason,
          source: getTradingEnabledSource(),
        }),
        "[trade] dry-run (trading disabled)",
      );
      return;
    }

    // Dynamic pacing policy (aim ~5-7 trades/day)
    const policy = computePacingPolicy({
      env,
      tradesToday: this.risk.tradesToday,
      telemetrySnapshot: telemetry.snapshot ? telemetry.snapshot() : null,
      nowMs: Date.now(),
    });

    const minConf = Number(policy?.minConf ?? env.MIN_SIGNAL_CONFIDENCE ?? 0);
    let conf = Number(signal?.confidence);
    const baseInstrument = await ensureInstrument(
      this.kite,
      Number(signal?.instrument_token),
    );
    const isIndexUnderlying =
      String(baseInstrument?.segment || "").toUpperCase() === "INDICES";
    if (
      isIndexUnderlying &&
      String(signal?.strategyId || "") === "volume_spike"
    ) {
      logger.info(
        withSignalLifecycleMeta(signal, {
          token: signal?.instrument_token,
          strategyId: signal?.strategyId,
        }),
        "[trade] blocked (volume_spike disabled for index underlyings)",
      );
      return;
    }

    const isOptMode = this._isOptMode();
    const mustRouteUnderlyingToOption = isOptMode || isIndexUnderlying;
    const routeMode = resolvePreRouteMode({ isOptMode, isIndexUnderlying });
    const preRouteGate = evaluatePreRouteConfidenceGate({
      mustRouteUnderlyingToOption,
      conf,
      minConf,
      preRouteAllowanceUsed: this._getPreRouteConfidenceAllowance(),
      signal,
      env,
    });
    if (preRouteGate.blocked) {
      signal = recordSignalDecision({
        signalLike: signal,
        token: signal?.instrument_token,
        outcome: "BLOCKED",
        stage: "route",
        reason: "PRE_ROUTE_LOW_CONFIDENCE",
        meta: {
          signalId: signal?.signalId || null,
          regimeSnapshotId: signal?.regimeSnapshotId || null,
          conf: preRouteGate.conf,
          minConf: preRouteGate.minConf,
          preRouteAllowanceUsed: preRouteGate.preRouteAllowanceUsed,
          preRouteScore: preRouteGate.preRouteScore,
          expectedRouteAdjustment: preRouteGate.expectedRouteAdjustment,
          routedScore: preRouteGate.routedScore,
          strategyId: signal?.strategyId || null,
          side: signal?.side || null,
          routeMode,
          routeConfidenceStage: preRouteGate.routeConfidenceStage,
          routeConfidenceDecision: preRouteGate.routeConfidenceDecision,
          estimateUsed: preRouteGate.estimateUsed,
          actualUsed: preRouteGate.actualUsed,
        },
        conversion: {
          routeAttempted: false,
          preRouteScore: preRouteGate.preRouteScore,
          expectedRouteAdjustment: preRouteGate.expectedRouteAdjustment,
          routedConfidence: preRouteGate.routedScore,
          postRouteDecision: "BLOCKED",
          finalOutcome: "BLOCKED_PRE_ROUTE_CONFIDENCE",
          finalReasonCode: "PRE_ROUTE_LOW_CONFIDENCE",
        },
      });
      logger.info(
        withSignalLifecycleMeta(signal, {
          token: signal?.instrument_token,
          conf: preRouteGate.conf,
          minConf: preRouteGate.minConf,
          preRouteAllowanceUsed: preRouteGate.preRouteAllowanceUsed,
          preRouteScore: preRouteGate.preRouteScore,
          expectedRouteAdjustment: preRouteGate.expectedRouteAdjustment,
          routedScore: preRouteGate.routedScore,
          strategyId: signal?.strategyId || null,
          side: signal?.side || null,
          routeMode,
          routeConfidenceStage: preRouteGate.routeConfidenceStage,
          routeConfidenceDecision: preRouteGate.routeConfidenceDecision,
          estimateUsed: preRouteGate.estimateUsed,
          actualUsed: preRouteGate.actualUsed,
          conversionSummary: signal?.conversionSummary || null,
        }),
        "[trade] blocked (pre-route low confidence)",
      );
      return;
    }

    if (preRouteGate.routeConfidenceDecision === "SOFT_PENALTY") {
      signal = applyConversionSummary(signal, {
        preRouteScore: preRouteGate.preRouteScore,
        expectedRouteAdjustment: preRouteGate.expectedRouteAdjustment,
        routedConfidence: preRouteGate.routedScore,
      });
      logger.info(
        withSignalLifecycleMeta(signal, {
          token: signal?.instrument_token,
          conf: preRouteGate.conf,
          minConf: preRouteGate.minConf,
          preRouteScore: preRouteGate.preRouteScore,
          expectedRouteAdjustment: preRouteGate.expectedRouteAdjustment,
          routedScore: preRouteGate.routedScore,
          routeMode,
          routeConfidenceStage: preRouteGate.routeConfidenceStage,
          routeConfidenceDecision: preRouteGate.routeConfidenceDecision,
          softPenaltyApplied: preRouteGate.softPenaltyApplied,
        }),
        "[trade] pre-route confidence softened to post-route validation",
      );
    }

    // In OPT mode, we generate signals on an underlying (FUT/SPOT) but execute on an option contract.
    // Route here so downstream logic (risk, orders, telemetry) is consistent on the executed instrument.
    if (mustRouteUnderlyingToOption) {
      // QuoteGuard safety: if quotes are unstable (breaker open), pause new OPT entries.
      const blockOnQG =
        String(env.OPT_BLOCK_ON_QUOTE_GUARD_OPEN || "true") !== "false";
      if (
        blockOnQG &&
        typeof isQuoteGuardBreakerOpen === "function" &&
        isQuoteGuardBreakerOpen()
      ) {
        this._pushCircuitEvent("quoteGuard");
        const st =
          typeof getQuoteGuardStats === "function"
            ? getQuoteGuardStats()
            : null;
        s = recordSignalDecision({
          token: s.instrument_token,
          outcome: "BLOCKED",
          stage: "route",
          reason: "QUOTE_GUARD_BREAKER_OPEN",
          meta: {
            breakerOpenUntil: st?.breakerOpenUntil || null,
            failStreak: st?.stats?.failStreak ?? null,
          },
          conversion: {
            routeAttempted: false,
            postRouteDecision: "BLOCKED",
            finalOutcome: "BLOCKED_ROUTING",
            finalReasonCode: "QUOTE_GUARD_BREAKER_OPEN",
          },
        });
        logger.warn(
          withSignalLifecycleMeta(s, {
            breakerOpenUntil: st?.breakerOpenUntil || null,
            failStreak: st?.stats?.failStreak ?? null,
            token: s.instrument_token,
            side: s.side,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[trade] blocked (quote guard breaker open)",
        );
        return;
      }
      const underlyingToken = Number(s.instrument_token);
      const underlyingSide = String(s.side || "").toUpperCase();

      if (!this._isFnoEnabled()) {
        s = recordSignalDecision({
          token: underlyingToken,
          outcome: "BLOCKED",
          stage: "route",
          reason: "FNO_ROUTING_DISABLED",
          meta: {
            segment: baseInstrument?.segment || null,
          },
          conversion: {
            routeAttempted: false,
            postRouteDecision: "BLOCKED",
            finalOutcome: "BLOCKED_ROUTING",
            finalReasonCode: "FNO_ROUTING_DISABLED",
          },
        });
        logger.warn(
          withSignalLifecycleMeta(s, {
            token: underlyingToken,
            segment: baseInstrument?.segment,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[trade] blocked (index/underlying signal requires FNO routing)",
        );
        return;
      }

      // Ensure we have a universe snapshot (built at ticker connect, but keep a safe fallback)
      let uni = getLastFnoUniverse();
      if (!uni?.universe) {
        try {
          uni = await buildFnoUniverse({ kite: this.kite });
        } catch (e) {
          logger.warn(
            { e: e?.message || String(e) },
            "[options] universe build failed",
          );
        }
      }

      // Signal source can stay FUT/SPOT, but ATM strike should use dedicated strike-ref token (pro style: SPOT).
      const underInstr =
        Number(baseInstrument?.instrument_token) === underlyingToken
          ? baseInstrument
          : await ensureInstrument(this.kite, underlyingToken);
      const contractByUnderlying = uni?.universe?.contracts || {};
      const resolvedUnderlying = Object.entries(contractByUnderlying).find(
        ([, c]) =>
          Number(c?.instrument_token) === underlyingToken ||
          String(c?.tradingsymbol || "").toUpperCase() ===
            String(underInstr?.tradingsymbol || "").toUpperCase(),
      )?.[0];
      const strikeRefToken = Number(
        resolvedUnderlying
          ? contractByUnderlying?.[resolvedUnderlying]?.strike_ref_token
          : NaN,
      );

      let strikeRefLtp = Number.NaN;
      if (Number.isFinite(strikeRefToken) && strikeRefToken > 0) {
        strikeRefLtp = Number(this.lastPriceByToken.get(strikeRefToken));
        if (!(strikeRefLtp > 0)) {
          const strikeRefInstr = await ensureInstrument(
            this.kite,
            strikeRefToken,
          );
          strikeRefLtp = Number(
            await this._getLtp(strikeRefToken, strikeRefInstr),
          );
        }
      }

      const underLtp =
        (await this._getLtp(underlyingToken, underInstr)) ||
        Number(s.candle?.close);
      const routeLtp =
        Number.isFinite(strikeRefLtp) && strikeRefLtp > 0
          ? strikeRefLtp
          : underLtp;

      const preRouteTradability = evaluatePreRouteTradability({
        signal: s,
        underlying: resolvedUnderlying || underInstr?.name || underInstr?.tradingsymbol,
        lotSize: resolvedUnderlying
          ? contractByUnderlying?.[resolvedUnderlying]?.lot_size
          : underInstr?.lot_size,
        riskBudgetInr: resolveSignalRiskBudgetInr({
          signalStyle: s.strategyStyle,
          config: env,
        }),
        config: env,
      });
      if (preRouteTradability.blocked) {
        s = recordSignalDecision({
          token: underlyingToken,
          outcome: "BLOCKED",
          stage: "pre_route_tradability",
          reason: preRouteTradability.reasonCode,
          meta: preRouteTradability.meta,
          conversion: {
            routeAttempted: false,
            postRouteDecision: "BLOCKED",
            finalOutcome: "BLOCKED_PRE_ROUTE_TRADABILITY",
            finalReasonCode: preRouteTradability.reasonCode,
          },
        });
        logger.info(
          withSignalLifecycleMeta(s, {
            token: underlyingToken,
            ...preRouteTradability.meta,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[trade] blocked (pre-route tradability screen)",
        );
        return;
      }

      if (typeof this.runtimeAddTokens === "function") {
        try {
          const candidates = await buildOptionSubscriptionCandidates({
            kite: this.kite,
            universe: uni,
            underlyingToken,
            underlyingTradingsymbol: underInstr?.tradingsymbol,
            underlyingLtp: routeLtp,
          });
          if (candidates.length) {
            observeBackgroundTask(
              Promise.resolve(
                this.runtimeAddTokens(candidates, {
                  reason: "OPT_UNDERLYING_CANDIDATES",
                  backfill: false,
                  isOption: true,
                }),
              ).then((result) => {
                if (result?.ok === false) {
                  logger.warn(
                    withSignalLifecycleMeta(s, {
                      token: underlyingToken,
                      error: result?.error || null,
                    }),
                    "[options] candidate runtime subscribe unavailable",
                  );
                }
                return result;
              }),
              (error) => {
                logger.warn(
                  withSignalLifecycleMeta(s, {
                    token: underlyingToken,
                    e: error?.message || String(error),
                  }),
                  "[options] candidate runtime subscribe failed",
                );
              },
            );
          }
        } catch (e) {
          logger.warn(
            { e: e?.message || String(e), token: underlyingToken },
            "[options] candidate runtime subscribe failed",
          );
        }
      }

      let picked = await pickOptionContractForSignal({
        kite: this.kite,
        universe: uni,
        underlyingToken,
        underlyingTradingsymbol: underInstr?.tradingsymbol,
        side: underlyingSide,
        underlyingLtp: routeLtp,
        maxSpreadBpsOverride: policy?.maxSpreadBpsOpt,
      });

      // PATCH-10: Hard-focus one underlying (prevents accidental multi-index trading)
      if (env.FNO_SINGLE_UNDERLYING_ENABLED) {
        const only = String(
          env.FNO_SINGLE_UNDERLYING_SYMBOL || "",
        ).toUpperCase();
        const got = String(picked?.underlying || "").toUpperCase();
        if (only && got && got !== only) {
          s = recordSignalDecision({
            token: picked?.instrument_token || underlyingToken,
            outcome: "BLOCKED",
            stage: "route",
            reason: "UNDERLYING_FOCUS_MISMATCH",
            meta: {
              expectedUnderlying: only,
              actualUnderlying: got,
            },
            conversion: {
              routeAttempted: true,
              postRouteDecision: "BLOCKED",
              finalOutcome: "BLOCKED_ROUTING",
              finalReasonCode: "UNDERLYING_FOCUS_MISMATCH",
            },
          });
          logger.warn(
            withSignalLifecycleMeta(s, {
              only,
              got,
              token: picked.instrument_token,
              conversionSummary: s?.conversionSummary || null,
            }),
            "[options] blocked: picked contract is not primary underlying",
          );
          return;
        }
      }

      if (!picked || !picked.instrument_token) {
        s = recordSignalDecision({
          token: underlyingToken,
          outcome: "BLOCKED",
          stage: "route",
          reason: picked?.reason || "NO_OPTION_CONTRACT",
          meta: {
            underlyingToken,
            underlyingSide,
            message: picked?.message || null,
            selectionPath: picked?.meta?.selectionPath || null,
            fallbackTrace: picked?.meta?.fallbackTrace || null,
          },
          conversion: {
            routeAttempted: true,
            postRouteDecision: "BLOCKED",
            finalOutcome: "BLOCKED_ROUTING",
            finalReasonCode: picked?.reason || "NO_OPTION_CONTRACT",
          },
        });
        logger.warn(
          withSignalLifecycleMeta(s, {
            underlyingToken,
            underlyingSide,
            reason: picked?.reason,
            message: picked?.message,
            meta: picked?.meta,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[options] no contract could be picked",
        );
        return;
      }

      let liq = await this._preEntryOptionLiquidityCheck(picked);
      if (!liq.ok) {
        const alternates = Array.isArray(picked?.meta?.alternateContracts)
          ? picked.meta.alternateContracts
          : [];
        let rescued = null;
        for (const candidate of alternates) {
          if (
            Number(candidate?.instrument_token ?? 0) <= 0 ||
            Number(candidate?.instrument_token) === Number(picked.instrument_token)
          ) {
            continue;
          }
          const altLiq = await this._preEntryOptionLiquidityCheck(candidate);
          if (altLiq.ok) {
            rescued = { candidate, liq: altLiq };
            break;
          }
        }
        if (rescued) {
          const previousPicked = picked;
          const rejectedLiq = liq;
          picked = rescued.candidate;
          liq = rescued.liq;
          s = recordSignalDecision({
            token: picked.instrument_token,
            outcome: "ADJUSTED",
            stage: "route",
            reason: "ALTERNATE_CONTRACT_SELECTED",
            meta: {
              rejectedToken: Number(previousPicked?.instrument_token ?? 0) || null,
              rejectionReason: rejectedLiq?.reason || null,
              selectionPath: picked?.meta?.selectionPath || null,
              selectionObservability:
                picked?.meta?.selectionObservability || null,
            },
          });
          logger.warn(
            withSignalLifecycleMeta(s, {
              from: rejectedLiq?.reason || null,
              oldToken: Number(previousPicked?.instrument_token),
              newToken: picked.instrument_token,
              newHealth: picked.health_score,
              conversionSummary: s?.conversionSummary || null,
            }),
            "[options] switched to healthier alternate contract before entry",
          );
        } else {
          s = recordSignalDecision({
            token: picked.instrument_token,
            outcome: "BLOCKED",
            stage: "contract",
            reason: liq.reason || "OPTION_LIQUIDITY_RECHECK_FAILED",
            meta: {
              contract: {
                instrument_token: picked.instrument_token,
                tradingsymbol: picked.tradingsymbol,
                expiry: picked.expiry,
                strike: picked.strike,
                optType: picked.optType,
              },
              selectionPath: picked?.meta?.selectionPath || null,
              selectionObservability:
                picked?.meta?.selectionObservability || null,
              liquidity: liq.meta || null,
            },
            conversion: {
              routeAttempted: true,
              selectedContract: buildSignalConversionSummary({
                option_meta: picked,
              }).selectedContract,
              postRouteDecision: "BLOCKED",
              finalOutcome: "BLOCKED_CONTRACT",
              finalReasonCode: liq.reason || "OPTION_LIQUIDITY_RECHECK_FAILED",
            },
          });
          logger.info(
            withSignalLifecycleMeta(s, {
              token: picked.instrument_token,
              reason: liq.reason,
              meta: liq.meta,
              conversionSummary: s?.conversionSummary || null,
            }),
            "[trade] blocked (option liquidity recheck)",
          );
          return;
        }
      }
      markEntryPipelineStage(s, "contractSelectedAt");

      const routeConfidence = buildRouteConfidenceAssessment({
        signal: s,
        baseConfidence: s.confidence,
        pick: picked,
        liqMeta: liq?.meta,
        env,
      });
      const finalConfidence = Number(routeConfidence?.routedScore);

      // Ensure we subscribe the chosen option contract (so downstream OMS/risk gets ticks)
      let rt = null;
      const requireSub =
        String(env.OPT_REQUIRE_SUBSCRIBED_LTP || "false") === "true";
      let selectedContractSubscribePromise = null;
      if (typeof this.runtimeAddTokens === "function") {
        selectedContractSubscribePromise = observeBackgroundTask(
          Promise.resolve(
            this.runtimeAddTokens([Number(picked.instrument_token)], {
              reason: "OPT_SELECTED_CONTRACT",
              // For options, candle history is important for exits; default: backfill enabled.
              backfill:
                String(env.OPT_RUNTIME_SUBSCRIBE_BACKFILL || "false") ===
                "true",
              // Prefer a slightly deeper backfill for options (per-token override supported by pipeline).
              daysOverride: Number(env.RUNTIME_SUBSCRIBE_BACKFILL_DAYS_OPT ?? 2),
            }),
          ),
          (error) => {
            logger.warn(
              withSignalLifecycleMeta(s, {
                token: picked.instrument_token,
                e: error?.message || String(error),
              }),
              "[options] selected contract runtime subscribe failed",
            );
          },
        );
      }

      if (requireSub && selectedContractSubscribePromise) {
        rt = await selectedContractSubscribePromise;
      } else if (selectedContractSubscribePromise) {
        selectedContractSubscribePromise.then((result) => {
          if (result?.ok === false) {
            logger.warn(
              withSignalLifecycleMeta(s, {
                token: picked.instrument_token,
                error: result?.error || null,
              }),
              "[options] selected contract runtime subscribe unavailable",
            );
          }
        });
      }

      if (requireSub && (!rt || !rt.ok)) {
        s = recordSignalDecision({
          token: picked.instrument_token,
          outcome: "BLOCKED",
          stage: "route",
          reason: "RUNTIME_SUBSCRIBE_UNAVAILABLE",
          meta: {
            error: rt?.error || null,
            selectionPath: picked?.meta?.selectionPath || null,
          },
          conversion: {
            routeAttempted: true,
            selectedContract: buildSignalConversionSummary({
              option_meta: picked,
            }).selectedContract,
            postRouteDecision: "BLOCKED",
            finalOutcome: "BLOCKED_ROUTING",
            finalReasonCode: "RUNTIME_SUBSCRIBE_UNAVAILABLE",
          },
        });
        logger.info(
          withSignalLifecycleMeta(s, {
            token: picked.instrument_token,
            error: rt?.error,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[trade] blocked (runtime subscribe unavailable)",
        );
        return;
      }

      s = {
        ...s,
        instrument_token: Number(picked.instrument_token),
        side: "BUY", // long options only (BUY CE/PE)
        underlying_token: underlyingToken,
        underlying_side: underlyingSide,
        underlying_symbol: picked?.underlying || null,
        underlying_ltp: underLtp,
        option_meta: picked,
        routeConfidence,
        confidence: Number.isFinite(finalConfidence)
          ? finalConfidence
          : Number(s.confidence),
        reason:
          `${s.reason || ""} | OPT ${picked.optType} ${picked.strike} ${picked.expiry}`.trim(),
      };
      s = applyConversionSummary(s, {
        routeAttempted: true,
        selectedContract: buildSignalConversionSummary({
          option_meta: picked,
        }).selectedContract,
        preRouteScore: routeConfidence?.preRouteScore ?? null,
        expectedRouteAdjustment: routeConfidence?.expectedRouteAdjustment ?? null,
        routedConfidence: routeConfidence?.routedScore ?? null,
        postRouteDecision: "ROUTED",
      });
    } else {
      markEntryPipelineStage(s, "contractSelectedAt");
    }

    const token = Number(s.instrument_token);
    const dailyRiskPromise = getDailyRisk(todayKey());
    const instrumentPromise =
      Number(baseInstrument?.instrument_token) === token
        ? Promise.resolve(baseInstrument)
        : observeBackgroundTask(
            ensureInstrument(this.kite, token),
            (error) => {
              logger.warn(
                withSignalLifecycleMeta(s, {
                  token,
                  e: error?.message || String(error),
                }),
                "[instruments] selected instrument resolve failed during warmup",
              );
            },
          );
    const signalTsMs = this._signalTimestampMs(s);
    const riskKey = this._buildRiskKey({
      strategyId: s.strategyId,
      underlying: s.underlying_symbol || s.option_meta?.underlying,
      token,
    });

    const trackDecision = (outcome, stage, reason, meta, decisionTrade = null) => {
      const conversion = {};
      if (stage === "admission" && outcome === "BLOCKED") {
        conversion.postRouteDecision =
          reason === "POST_ROUTE_LOW_CONFIDENCE"
            ? "BLOCKED"
            : s.option_meta
              ? "PASSED"
              : s?.conversionSummary?.postRouteDecision ?? null;
        conversion.finalOutcome =
          reason === "POST_ROUTE_LOW_CONFIDENCE"
            ? "BLOCKED_POST_ROUTE_CONFIDENCE"
            : "BLOCKED_ADMISSION";
        conversion.finalReasonCode = reason;
        if (reason === "POST_ROUTE_LOW_CONFIDENCE") {
          conversion.routedConfidence = toFiniteOrNull(meta?.conf ?? s?.confidence);
        }
      } else if (
        (stage === "risk_fit" || stage === "affordability") &&
        outcome === "BLOCKED"
      ) {
        conversion.postRouteDecision =
          s.option_meta ? "PASSED" : s?.conversionSummary?.postRouteDecision ?? null;
        conversion.riskFitDecision =
          meta?.riskFitDecision || (stage === "risk_fit" ? "BLOCKED" : null);
        conversion.finalOutcome = "BLOCKED_RISK_FIT";
        conversion.finalReasonCode = reason;
      } else if (stage === "risk_fit" && outcome === "ADJUSTED") {
        conversion.riskFitDecision = meta?.riskFitDecision || reason || "ADJUSTED";
      } else if (stage === "entry" && outcome === "ENTRY_PLACED") {
        conversion.postRouteDecision =
          s.option_meta ? "PASSED" : s?.conversionSummary?.postRouteDecision ?? null;
        conversion.riskFitDecision =
          s?.conversionSummary?.riskFitDecision || "FIT";
        conversion.finalOutcome = "READY_FOR_EXECUTION";
        conversion.finalReasonCode = reason;
      } else if (stage === "entry" && outcome === "BLOCKED") {
        conversion.finalOutcome = "BLOCKED_EXECUTION_ADMISSION";
        conversion.finalReasonCode = reason;
      } else if (stage === "optimizer" && outcome === "BLOCKED") {
        conversion.finalOutcome = "BLOCKED_ADMISSION";
        conversion.finalReasonCode = reason;
      }

      if (Object.keys(conversion).length > 0) {
        s = applyConversionSummary(s, conversion);
      }

      this._recordTradeDecision({
        signal: s,
        trade: decisionTrade,
        token,
        outcome,
        stage,
        reason,
        meta,
      });
    };

    trackDecision("RECEIVED", "signal", "RECEIVED", {
      confidence: s.confidence,
      regime: s.regime,
      option: s.option_meta
        ? {
            underlying: s.option_meta.underlying,
            type: s.option_meta.optType,
            strike: s.option_meta.strike,
            expiry: s.option_meta.expiry,
          }
        : null,
    });
    const dailyRisk = await dailyRiskPromise;
    const dailyState = String(dailyRisk?.state || "RUNNING");
    if (dailyState === "SOFT_STOP") {
      trackDecision("BLOCKED", "admission", "DAILY_SOFT_STOP", {
        dailyState,
      });
      logger.warn({ token, dailyState }, "[trade] blocked (daily soft stop)");
      return;
    }
    if (dailyState === "HARD_STOP") {
      trackDecision("BLOCKED", "admission", "DAILY_HARD_STOP", {
        dailyState,
      });
      logger.warn({ token, dailyState }, "[trade] blocked (daily hard stop)");
      return;
    }
    const check = this.risk.canTrade(riskKey);
    if (!check.ok) {
      trackDecision("BLOCKED", "admission", check.reason || "RISK_CAN_TRADE", {
        riskKey,
      });
      logger.info({ token, reason: check.reason }, "[trade] blocked");
      return;
    }

    const cbState = this._checkCircuitBreakers();
    if (!cbState.ok) {
      trackDecision("BLOCKED", "admission", "CIRCUIT_BREAKER", cbState);
      logger.warn({ token, cbState }, "[trade] blocked (circuit breaker)");
      return;
    }

    if (this.risk.getKillSwitch()) {
      trackDecision("BLOCKED", "admission", "KILL_SWITCH_ACTIVE");
      logger.warn("[trade] blocked (kill switch)");
      return;
    }

    if (
      this._slippageCooldownUntil &&
      Date.now() < this._slippageCooldownUntil
    ) {
      trackDecision("BLOCKED", "admission", "SLIPPAGE_COOLDOWN_ACTIVE", {
        until: this._slippageCooldownUntil,
      });
      logger.warn(
        { token, until: this._slippageCooldownUntil },
        "[trade] blocked (slippage cooldown)",
      );
      return;
    }

    if (this._isStrategyThrottled(s.strategyId)) {
      const until = this._strategyCooldownUntil.get(String(s.strategyId));
      trackDecision("BLOCKED", "admission", "STRATEGY_COOLDOWN", {
        strategyId: s.strategyId,
        until,
      });
      logger.warn(
        { strategyId: s.strategyId, until },
        "[trade] blocked (strategy cooldown)",
      );
      return;
    }

    // Confidence gate (dynamic)
    conf = Number(s.confidence);
    if (Number.isFinite(minConf) && minConf > 0 && Number.isFinite(conf)) {
      if (conf < minConf) {
        const reasonCode = s.option_meta
          ? "POST_ROUTE_LOW_CONFIDENCE"
          : "LOW_CONFIDENCE";
        trackDecision("BLOCKED", "admission", reasonCode, {
          conf,
          minConf,
          preRouteScore: s?.routeConfidence?.preRouteScore ?? null,
          expectedRouteAdjustment:
            s?.routeConfidence?.expectedRouteAdjustment ?? null,
          routedScore: conf,
        });
        logger.info(
          withSignalLifecycleMeta(s, {
            token: s.instrument_token,
            conf,
            minConf,
            postRoute: !!s.option_meta,
            conversionSummary: s?.conversionSummary || null,
          }),
          "[trade] blocked (low confidence post-route)",
        );
        return;
      }
    }

    if (Boolean(env.EXECUTABLE_SIGNAL_GATE_ENABLED ?? true)) {
      this._recordTradeDecision({
        signal: s,
        token,
        outcome: "EXECUTABLE_SIGNAL",
        stage: "gate",
        reason: "PASS",
        meta: { conf, minConf, regime: s.regime, side: s.side },
      });
    }
    const instrument = await instrumentPromise;

    const tick = Number(instrument.tick_size ?? 0.05);

    // Normalize side and detect contract type (options)
    const side = String(s.side || "BUY").toUpperCase();
    const isOptContract =
      !!s.option_meta ||
      String(instrument?.instrument_type || "").toUpperCase() === "CE" ||
      String(instrument?.instrument_type || "").toUpperCase() === "PE" ||
      /(?:CE|PE)$/.test(String(instrument?.tradingsymbol || "").toUpperCase());

    // Pro: options default LIMIT; others use global ENTRY_ORDER_TYPE
    const entryOrderType = String(
      isOptContract
        ? env.ENTRY_ORDER_TYPE_OPT || env.ENTRY_ORDER_TYPE || "LIMIT"
        : env.ENTRY_ORDER_TYPE || "MARKET",
    ).toUpperCase();

    // Slippage guard thresholds (segment-aware)
    // FIX: Previously we referenced maxEntrySlipBps/maxEntrySlipKillBps later in this method
    // but only defined them inside the reconcile() path, causing "maxEntrySlipBps is not defined".
    const maxEntrySlipBps = Number(
      isOptContract
        ? Number(
            env.MAX_ENTRY_SLIPPAGE_BPS_OPT ?? env.MAX_ENTRY_SLIPPAGE_BPS ?? 120,
          )
        : Number(env.MAX_ENTRY_SLIPPAGE_BPS ?? 25),
    );
    const maxEntrySlipKillBps = Number(
      isOptContract
        ? Number(
            env.MAX_ENTRY_SLIPPAGE_KILL_BPS_OPT ??
              env.MAX_ENTRY_SLIPPAGE_KILL_BPS ??
              250,
          )
        : Number(env.MAX_ENTRY_SLIPPAGE_KILL_BPS ?? 60),
    );

    // Spread filter (use separate threshold for options)
    const sp = await this._spreadCheck(instrument, {
      maxBps: s.option_meta
        ? Number(
            policy?.maxSpreadBpsOpt ??
              env.OPT_MAX_SPREAD_BPS ??
              env.MAX_SPREAD_BPS ??
              15,
          )
        : Number(policy?.maxSpreadBps ?? env.MAX_SPREAD_BPS ?? 15),
    });
    if (!sp.ok) {
      if (
        String(sp.reason || "")
          .toUpperCase()
          .includes("SPREAD")
      ) {
        this._pushCircuitEvent("spreadSpikes");
      }
      trackDecision("BLOCKED", "contract", sp.reason || "SPREAD_BLOCK", {
        spread: sp.meta || null,
      });
      logger.info(
        { token, reason: sp.reason, meta: sp.meta },
        "[trade] blocked (spread)",
      );
      return;
    }

    const quoteAtEntry = sp?.meta || null;
    const expectedEntryPrice =
      Number(s.side === "BUY" ? quoteAtEntry?.ask : quoteAtEntry?.bid) ||
      Number(quoteAtEntry?.ltp) ||
      Number(s.candle?.close);
    const plannedEntryPrice = Number(expectedEntryPrice);

    // Stop-loss
    // - Cash: candle low/high
    // - Options: configurable (PCT / POINTS / UNDERLYING_ATR)
    let entryGuess = expectedEntryPrice;
    let stopLoss;
    if (s.option_meta) {
      // Backward-compatible stop mode:
      // - OPT_SL_MODE is the "real" knob used by risk logic.
      // - OPT_STOP_MODE/OPT_STOP_POINTS existed as a UI knob; if set, map it.
      const stopModeRaw = String(
        env.OPT_SL_MODE || env.OPT_STOP_MODE || "PREMIUM_PCT",
      )
        .toUpperCase()
        .trim();
      const stopMode = stopModeRaw === "PCT" ? "PREMIUM_PCT" : stopModeRaw;

      if (
        stopMode === "POINTS" ||
        stopMode === "PREMIUM_POINTS" ||
        stopMode === "PRICE"
      ) {
        const pts = Number(env.OPT_STOP_POINTS ?? env.OPT_SL_POINTS ?? 0);
        if (Number.isFinite(pts) && pts > 0) {
          const raw = Number(expectedEntryPrice) - pts;
          stopLoss = roundToTick(raw, tick, "down");
        } else {
          // Fallback to pct if points not configured.
          const slPct = Number(env.OPT_STOP_PCT ?? env.OPT_SL_PCT ?? 12);
          const raw = Number(expectedEntryPrice) * (1 - slPct / 100);
          stopLoss = roundToTick(raw, tick, "down");
        }
      } else {
        // Default: premium percent stop
        const slPct = Number(env.OPT_STOP_PCT ?? env.OPT_SL_PCT ?? 12);
        const raw = Number(expectedEntryPrice) * (1 - slPct / 100);
        stopLoss = roundToTick(raw, tick, "down");
      }
    } else {
      const slFromCandle =
        s.side === "BUY" ? Number(s.candle?.low) : Number(s.candle?.high);
      stopLoss = slFromCandle;
      if (!Number.isFinite(stopLoss) || stopLoss <= 0)
        stopLoss = fallbackSL(entryGuess, s.side);
      if (s.side === "BUY" && stopLoss >= entryGuess)
        stopLoss = fallbackSL(entryGuess, "BUY");
      if (s.side === "SELL" && stopLoss <= entryGuess)
        stopLoss = fallbackSL(entryGuess, "SELL");
      stopLoss = roundToTick(stopLoss, tick, s.side === "BUY" ? "down" : "up");
    }

    // Regime filters / MTF confirmation
    const intervalMin = Number(s.intervalMin ?? s.candle?.interval_min ?? 1);
    const regimeToken = Number(s.underlying_token ?? token);
    const regimeSide = String(s.underlying_side || s.side);
    const reg = await this._regimeFilters({
      token: regimeToken,
      side: regimeSide,
      intervalMin,
      strategyId: s.strategyId,
      strategyStyle: s.strategyStyle,
      signalRegime: s.regime,
      regimeSnapshot: s.regimeSnapshot || null,
      signalId: s.signalId || null,
      policy,
      underlying: s?.option_meta?.underlying,
      isTradeToken: !!s.option_meta,
    });
    if (!reg.ok) {
      trackDecision("BLOCKED", "admission", reg.reason || "REGIME_BLOCK", {
        regime: reg.meta || null,
      });
      logger.info(
        { token, reason: reg.reason, meta: reg.meta },
        "[trade] blocked (regime)",
      );
      return;
    }

    if (s.option_meta) {
      const slMode = String(
        env.OPT_SL_MODE || env.OPT_STOP_MODE || "PREMIUM_PCT",
      ).toUpperCase();
      if (slMode === "UNDERLYING_ATR") {
        const fit = optionStopLossFromUnderlyingATR({
          side,
          entry: expectedEntryPrice,
          tickSize: tick,
          optionMeta: s.option_meta,
          atr: Number(reg?.meta?.atr),
          atrMult: Number(env.OPT_SL_UNDERLYING_ATR_MULT ?? 1.0),
          minTicks: Number(env.OPT_SL_UNDERLYING_MIN_TICKS ?? 6),
        });
        if (fit?.ok) {
          stopLoss = fit.stopLoss;
          logger.info(
            {
              token,
              side,
              stopLoss,
              entry: expectedEntryPrice,
              meta: fit.meta,
            },
            "[risk] option SL set from underlying ATR",
          );
        }
      }
    }

    // stop-loss quality gating (options allow wider % stops)
    const gate = await this._qualityGateStopLoss({
      entryGuess,
      stopLoss,
      side,
      instrument,
      maxPct: s.option_meta ? Number(env.OPT_MAX_SL_PCT ?? 35) : undefined,
    });
    if (!gate.ok) {
      trackDecision("BLOCKED", "risk_fit", gate.reason || "STOP_LOSS_QUALITY", {
        entryGuess,
        stopLoss,
      });
      logger.info({ token, reason: gate.reason }, "[trade] blocked (SL gate)");
      return;
    }

    // ---- Adaptive optimizer (normalized family keys + explicit soft vs hard actions) ----
    const rrBase = Number(env.RR_TARGET ?? 1.0);
    const confidenceRaw = conf;
    const opt = optimizer.evaluateSignal({
      symbol: instrument.tradingsymbol,
      underlying:
        s.underlying_symbol || s.option_meta?.underlying || instrument?.name,
      optType: s.option_meta?.optType || instrument?.instrument_type,
      delta: s.option_meta?.delta,
      expiry: s.option_meta?.expiry,
      dte: s.option_meta?.meta?.dteDays ?? s.option_meta?.dteDays,
      optionMeta: s.option_meta || null,
      strategyId: s.strategyId,
      nowTs: Date.now(),
      atrBase: reg?.meta?.atrBase || reg?.meta?.atr,
      close: reg?.meta?.close,
      rrBase,
      spreadBps: Number(sp?.meta?.bps ?? 0),
      signalRegime: s.regime,
      strategyStyle: s.strategyStyle,
      confidence: confidenceRaw,
    });
    const optAdmission = resolveOptimizerAdmission({
      env,
      optimizerResult: opt,
      confidenceRaw,
      minConf,
    });
    const confidenceMult = optAdmission.confidenceMult;
    const qtyMult = optAdmission.qtyMult;
    const optimizerTelemetry = {
      action: opt?.action || "PASS",
      reason: opt?.reason || null,
      ...(opt?.meta || {}),
      confidenceRaw: toFiniteOrNull(confidenceRaw),
      confidenceMult,
      confidenceUsedForTelemetry: toFiniteOrNull(
        optAdmission.confidenceUsedForTelemetry,
      ),
      qtyMult,
      compatibilityMode: optAdmission.compatibilityMode,
    };

    if (!opt.ok) {
      logger.info(
        { token, optimizer: optimizerTelemetry },
        "[trade] blocked (optimizer hard block)",
      );
      trackDecision("BLOCKED", "optimizer", "OPTIMIZER_HARD_BLOCK", {
        optimizer: optimizerTelemetry,
        ...optimizerTelemetry,
      });
      return;
    }

    if (optAdmission.compatibilityMode) {
      logger.info(
        { token, strategyId: s.strategyId },
        "[optimizer] compatibility min-confidence recheck active",
      );
    }

    if (!optAdmission.ok) {
      logger.info(
        {
          token: s.instrument_token,
          conf: confidenceRaw,
          confidenceUsed: optAdmission.confidenceUsedForTelemetry,
          minConf,
          optimizer: optimizerTelemetry,
        },
        "[trade] blocked (optimizer compatibility confidence recheck)",
      );
      trackDecision("BLOCKED", "optimizer", optAdmission.reason, {
        conf: confidenceRaw,
        confidenceUsed: optAdmission.confidenceUsedForTelemetry,
        minConf,
        optimizer: optimizerTelemetry,
        compatibilityMode: true,
      });
      return;
    }

    if (opt.action === "SOFT_DEWEIGHT") {
      trackDecision("ADJUSTED", "optimizer", "OPTIMIZER_SOFT_DEWEIGHT", {
        optimizer: optimizerTelemetry,
        ...optimizerTelemetry,
      });
    } else if (opt.action === "RR_TUNE_ONLY") {
      trackDecision("ADJUSTED", "optimizer", "OPTIMIZER_RR_TUNE_ONLY", {
        optimizer: optimizerTelemetry,
        ...optimizerTelemetry,
      });
    }

    const optimizerContext = buildFrozenOptimizerContext({
      optimizerResult: opt,
      confidenceRaw,
      rrBase,
    });

    // ---- Plan builder (dynamic SL + target) ----
    let plan = null;
    let plannedTargetPrice = null;
    let expectedMovePerUnit = null;
    let planMeta = null;

    if (String(env.PLAN_ENABLED || "false") === "true") {
      try {
        const planCandleLimit = Number(env.PLAN_CANDLE_LIMIT ?? 800);
        const planCandlesPromise = getRecentCandles(
          regimeToken,
          intervalMin,
          planCandleLimit,
        );

        // For options, also fetch option-premium candles (premium-aware exits)
        let premiumCandles = null;
        let premiumPlanSource = null;
        let premiumPlanWarmed = null;
        let premiumPlanData = null;
        const premiumPlanPromise = s.option_meta
          ? (() => {
              markEntryPipelineStage(s, "backfillStartAt");
              return resolvePlanPremiumCandles({
                runtimeGetCandles: this.runtimeGetCandles,
                dbGetRecentCandles: getRecentCandles,
                token,
                intervalMin,
                limit: Number(
                  env.OPT_PLAN_PREM_CANDLE_LIMIT ??
                    env.PLAN_CANDLE_LIMIT ??
                    800,
                ),
                env,
                referenceTs: s.signalEventTs || s.signalCreatedAt || null,
              }).finally(() => {
                markEntryPipelineStage(s, "backfillEndAt");
              });
            })()
          : Promise.resolve(null);
        const [planCandles, resolvedPremiumPlanData] = await Promise.all([
          planCandlesPromise,
          premiumPlanPromise,
        ]);

        premiumPlanData = resolvedPremiumPlanData;
        if (premiumPlanData) {
          if (s.option_meta) {
            s = {
              ...s,
              option_meta: {
                ...s.option_meta,
                premiumContext: {
                  source: premiumPlanData.source,
                  warmed: premiumPlanData.warmed,
                  candleCount: premiumPlanData.candleCount,
                  minRequired: premiumPlanData.minRequired,
                  readinessState: premiumPlanData.readinessState,
                  degraded: premiumPlanData.degraded,
                  degradedBy: premiumPlanData.degradedBy,
                  lastCandleTs: premiumPlanData.lastCandleTs,
                },
              },
            };
            s = applyConversionSummary(s, {
              selectedContract: buildSignalConversionSummary({
                option_meta: s.option_meta,
              }).selectedContract,
            });
          }
          premiumCandles = premiumPlanData.candles;
          premiumPlanSource = premiumPlanData.source;
          premiumPlanWarmed = premiumPlanData.warmed;
          if (
            premiumPlanData.degraded === true &&
            typeof this.runtimeAddTokens === "function" &&
            s.option_meta?.instrument_token
          ) {
            observeBackgroundTask(
              Promise.resolve(
                this.runtimeAddTokens([Number(s.option_meta.instrument_token)], {
                  reason: "OPT_PLAN_PREMIUM_WARM",
                  backfill: true,
                  isOption: true,
                  daysOverride: Number(env.RUNTIME_SUBSCRIBE_BACKFILL_DAYS_OPT ?? 2),
                }),
              ),
              (error) => {
                logger.warn(
                  withSignalLifecycleMeta(s, {
                    token,
                    e: error?.message || String(error),
                  }),
                  "[plan] premium context warmup failed",
                );
              },
            );
          }
          logger.info(
            withSignalLifecycleMeta(s, {
              token,
              intervalMin,
              source: premiumPlanSource,
              warmed: premiumPlanWarmed,
              candleCount: premiumPlanData.candleCount,
              minRequired: premiumPlanData.minRequired,
              readinessState: premiumPlanData.readinessState,
              degraded: premiumPlanData.degraded,
              degradedBy: premiumPlanData.degradedBy,
              lastCandleTs: premiumPlanData.lastCandleTs,
              staleByMs: premiumPlanData.staleByMs,
            }),
            "[plan] option premium candles resolved",
          );
        }

        const entryUnderlying = Number(
          s.option_meta
            ? (s.underlying_ltp ?? s.candle?.close ?? 0)
            : (quoteAtEntry?.ltp ?? s.candle?.close ?? 0),
        );

        const atr = Number(reg?.meta?.atr);
        const cl = Number(reg?.meta?.close);
        const atrPctUnderlying =
          Number.isFinite(atr) && Number.isFinite(cl) && cl > 0
            ? (atr / cl) * 100
            : null;

          plan = buildTradePlan({
          env,
          candles: planCandles,
          premiumCandles,
          intervalMin,
          side: regimeSide,
          signalStyle: s.strategyStyle,
          entryUnderlying,
          expectedMoveUnderlying: Number(reg?.meta?.expectedMovePerShare),
          atrPeriod: Number(env.EXPECTED_MOVE_ATR_PERIOD ?? 14),
          optionMeta: s.option_meta
            ? { ...s.option_meta, strategyStyle: s.strategyStyle }
            : null,
          entryPremium: s.option_meta ? expectedEntryPrice : null,
          premiumTick: tick,
          atrPctUnderlying,
          rrFloorOverride: optimizerTelemetry.rrUsed,
        });

        if (plan?.ok) {
          stopLoss = plan.stopLoss;
          plannedTargetPrice = plan.targetPrice;
          expectedMovePerUnit = plan.expectedMovePerUnit;
          planMeta = {
            ...(plan.meta || {}),
            premiumPlanSource,
            premiumPlanWarmed,
            premiumPlanReadiness: premiumPlanData
              ? {
                  source: premiumPlanData.source,
                  warmed: premiumPlanData.warmed,
                  candleCount: premiumPlanData.candleCount,
                  minRequired: premiumPlanData.minRequired,
                  readinessState: premiumPlanData.readinessState,
                  degraded: premiumPlanData.degraded,
                  degradedBy: premiumPlanData.degradedBy,
                  lastCandleTs: premiumPlanData.lastCandleTs,
                }
              : null,
          };

          // Re-check SL sanity after plan override
          const slGate2 = await this._qualityGateStopLoss({
            entryGuess,
            stopLoss,
            side,
            instrument,
            maxPct: s.option_meta
              ? Number(env.OPT_MAX_SL_PCT ?? 35)
              : Number(env.MAX_SL_PCT ?? 1.2),
          });
          if (!slGate2.ok) {
            logger.info(
              { token, reason: slGate2.reason, meta: slGate2.meta },
              "[trade] blocked (SL plan gate)",
            );
            return;
          }
        }
      } catch (e) {
        logger.warn(
          { err: e?.message || e },
          "[plan] failed; falling back to basic SL/target",
        );
      }
    }

    // ---- Adaptive optimizer (strategy×symbol×time-bucket auto-block + dynamic RR) ----
    const rrTarget = resolveOptimizerRrTarget({
      plan,
      optimizerResult: opt,
      rrBase,
    });
    const qtyMode = String(
      env.QTY_SIZING_MODE || "RISK_THEN_MARGIN",
    ).toUpperCase();
    const _styleForSizing = String(
      planMeta?.style || s.strategyStyle || "",
    ).toUpperCase();
    const _openMult = _styleForSizing.includes("OPEN")
      ? Number(env.OPEN_RISK_MULT ?? 0.7)
      : 1.0;
    const _riskInrOverride = Number(env.RISK_PER_TRADE_INR ?? 0) * _openMult;
    const lotSize = Number(instrument?.lot_size ?? 1);
    const tickSize = Number(instrument?.tick_size ?? tick ?? 0.05);
    const expectedSlippagePts = Number(
      env.EXPECTED_SLIPPAGE_POINTS ??
        (Number(quoteAtEntry?.bps ?? 0) > 0 && Number(entryGuess) > 0
          ? (Number(quoteAtEntry.bps) / 10000) * Number(entryGuess)
          : 0),
    );
    const feePerLotInr = Number(env.EXPECTED_FEES_PER_LOT_INR ?? 0);
    const riskBudgetInr = Number(
      _riskInrOverride ?? env.RISK_PER_TRADE_INR ?? 0,
    );
    const minLotPolicy = String(
      env.FNO_MIN_LOT_POLICY || "STRICT",
    ).toUpperCase();

    const strategyStopLoss = Number(stopLoss);
    let sizingStopLoss = strategyStopLoss;
    let riskFitMode = "FIT";
    let riskFitDecision = "FIT";
    let riskBreachState = "NONE";
    let slCompressionPct = null;
    let riskBreachTag = null;

    const strategyRiskFit = this._evaluateMinTradableRiskFit({
      entryPrice: entryGuess,
      strategyStopLoss,
      side,
      lotSize,
      riskBudgetInr,
      expectedSlippagePts,
      feePerLotInr,
      tickSize,
    });
    let sizingRiskFit = strategyRiskFit;
    const slFitDecision = resolvePreEntrySlFitDecision({
      config: env,
      optionMeta: s.option_meta,
      lotSize,
      strategyRiskFit,
    });
    const slFitTelemetry = {
      token,
      strategyId: s.strategyId || null,
      side,
      strategyFitsMinTradable: slFitDecision.strategyFitsMinTradable,
      slFitEnabled: slFitDecision.slFitEnabled,
      slFitWhenCapBlocks: slFitDecision.slFitWhenCapBlocks,
    };

    if (slFitDecision.compressionAttempted) {
      logger.info(
        {
          ...slFitTelemetry,
          compressionAttempted: true,
          compressionSkipReason: null,
        },
        "[risk] pre-entry compression considered",
      );
      const minTicks = Number(
        env.OPT_SL_FIT_MIN_TICKS ?? env.MIN_SL_TICKS ?? 2,
      );
      const fit = fitStopLossToLotRiskCap({
        side,
        entry: entryGuess,
        stopLoss: strategyStopLoss,
        lot: lotSize,
        tickSize,
        capInr: riskBudgetInr,
        minTicks,
      });

      const fitGuard =
        fit.ok && fit.changed
          ? evaluateStopFitCompression({
              entryPrice: entryGuess,
              originalStopLoss: strategyStopLoss,
              fittedStopLoss: fit.stopLoss,
              env,
              tickSize,
              plannedTargetPrice,
              rrTarget,
              strategyStyle: _styleForSizing,
            })
          : { ok: false, reason: fit.reason || "NO_COMPRESSION_CANDIDATE" };

      if (fit.ok && fit.changed && fitGuard.ok) {
        sizingStopLoss = Number(fit.stopLoss);
        sizingRiskFit = this._evaluateMinTradableRiskFit({
          entryPrice: entryGuess,
          strategyStopLoss: sizingStopLoss,
          side,
          lotSize,
          riskBudgetInr,
          expectedSlippagePts,
          feePerLotInr,
          tickSize,
        });

        if (sizingRiskFit?.fitsMinTradable) {
          riskFitMode = "COMPRESSED_FIT";
          riskFitDecision = "COMPRESSED";
          slCompressionPct = Number(fitGuard.tightenPct ?? null);
          logger.warn(
            {
              ...slFitTelemetry,
              token,
              side,
              entryGuess,
              strategyStopLoss,
              sizingStopLoss,
              compressionAttempted: true,
              compressionSkipReason: null,
              compressionPct: slCompressionPct,
              ...buildCompressionTelemetryMeta(fitGuard),
              riskBudgetInr,
              rrBefore: fitGuard.rrBefore,
              rrAfter: fitGuard.rrAfter,
            },
            "[risk] pre-entry compression enabled for min-tradable fit",
          );
        } else {
          logger.info(
            {
              ...slFitTelemetry,
              compressionAttempted: true,
              compressionSkipReason: "POST_COMPRESSION_STILL_NOT_FIT",
              strategyStopLoss,
              sizingStopLoss,
              ...buildCompressionTelemetryMeta(fitGuard),
              riskBudgetInr,
            },
            "[risk] pre-entry compression skipped",
          );
        }
      } else {
        logger.info(
          {
            ...slFitTelemetry,
            compressionAttempted: true,
            compressionSkipReason:
              fit.ok && fit.changed
                ? fitGuard.reason || "SL_FIT_GUARD_REJECTED"
                : fit.reason || "NO_COMPRESSION_CANDIDATE",
            strategyStopLoss,
            fittedStopLoss: toFiniteOrNull(fit?.stopLoss),
            ...buildCompressionTelemetryMeta(fitGuard),
            riskBudgetInr,
          },
          "[risk] pre-entry compression skipped",
        );
      }
    } else if (
      s.option_meta &&
      Number(lotSize) > 1 &&
      (slFitDecision.slFitEnabled ||
        slFitDecision.slFitWhenCapBlocks ||
        !slFitDecision.strategyFitsMinTradable)
    ) {
      logger.info(
        {
          ...slFitTelemetry,
          compressionAttempted: false,
          compressionSkipReason: slFitDecision.compressionSkipReason,
        },
        "[risk] pre-entry compression skipped",
      );
    }

    // ---- Option Greeks edge gate: IV + Vega + Theta ----
    // Protects from cases where direction is right but premium loses due to IV drop/theta.
    if (s.option_meta && Boolean(env.OPT_IV_THETA_FILTER_ENABLED ?? true)) {
      try {
        const metaOpt = s.option_meta || {};
        const vega1 = Number(metaOpt.vega_1pct);
        const thetaDay = Number(metaOpt.theta_per_day);
        const ivChPts = Number(metaOpt.iv_change_pts);

        const minDropPts = Number(env.OPT_IV_DROP_MIN_PTS ?? 1.5);
        const capDropPts = Number(env.OPT_IV_DROP_CAP_PTS ?? 4.0);

        const holdMin = Number(
          env.OPT_EXPECTED_HOLD_MIN ?? env.OPT_EXIT_MAX_HOLD_MIN ?? 10,
        );
        const edgeMult = Number(env.OPT_IV_THETA_EDGE_MULT ?? 1.2);

        // Expected premium gain: prefer planned target distance; fallback to delta-mapped move.
        const expectedGainP = Number.isFinite(Number(plannedTargetPrice))
          ? Math.abs(Number(plannedTargetPrice) - Number(entryGuess ?? 0))
          : null;

        const entryU = Number(
          planMeta?.underlying?.entry ?? s.underlying_ltp ?? 0,
        );
        const targetU = Number(planMeta?.underlying?.target ?? 0);
        const moveU =
          Number.isFinite(entryU) && Number.isFinite(targetU) && targetU > 0
            ? Math.abs(targetU - entryU)
            : Math.abs(Number(reg?.meta?.expectedMovePerShare ?? 0));

        const absDelta = Number.isFinite(Number(metaOpt.delta))
          ? Math.abs(Number(metaOpt.delta))
          : Number(planMeta?.option?.absDelta ?? 0);
        const gamma = Number.isFinite(Number(metaOpt.gamma))
          ? Math.abs(Number(metaOpt.gamma))
          : 0;

        const mappedGainP =
          Number.isFinite(moveU) && moveU > 0 && absDelta > 0
            ? absDelta * moveU + 0.5 * gamma * moveU * moveU
            : null;

        const baseGain = Number.isFinite(expectedGainP)
          ? expectedGainP
          : mappedGainP;

        // IV drop impact (only when IV is clearly falling right now)
        let ivImpact = 0;
        if (
          Number.isFinite(vega1) &&
          Number.isFinite(ivChPts) &&
          ivChPts < -minDropPts
        ) {
          const drop = Math.min(capDropPts, Math.abs(ivChPts));
          ivImpact = Math.max(0, vega1 * drop);
        }

        // Theta bleed for expected holding time
        let thetaCost = 0;
        if (
          Number.isFinite(thetaDay) &&
          thetaDay < 0 &&
          Number.isFinite(holdMin) &&
          holdMin > 0
        ) {
          thetaCost = Math.abs(thetaDay) * (holdMin / 1440);
        }

        const friction = ivImpact + thetaCost;

        if (
          Number.isFinite(baseGain) &&
          baseGain > 0 &&
          Number.isFinite(friction) &&
          friction > 0
        ) {
          if (baseGain < friction * edgeMult) {
            logger.info(
              {
                token,
                side,
                reason: "IV_THETA_EDGE_TOO_LOW",
                meta: {
                  baseGain,
                  expectedGainP,
                  mappedGainP,
                  moveU,
                  absDelta,
                  gamma,
                  ivChPts,
                  vega_1pct: vega1,
                  theta_per_day: thetaDay,
                  holdMin,
                  ivImpact,
                  thetaCost,
                  friction,
                  edgeMult,
                },
              },
              "[trade] blocked (IV/theta edge gate)",
            );
            trackDecision("BLOCKED", "trade", "IV_THETA_EDGE_TOO_LOW", {
              baseGain,
              expectedGainP,
              mappedGainP,
              moveU,
              absDelta,
              gamma,
              ivChPts,
              vega_1pct: vega1,
              theta_per_day: thetaDay,
              holdMin,
              ivImpact,
              thetaCost,
              friction,
              edgeMult,
            });
            return;
          }
        }
      } catch (e) {
        logger.warn(
          { err: e?.message || e },
          "[trade] IV/theta gate failed; continuing",
        );
      }
    }
    let qtyByRisk = Number(sizingRiskFit?.maxQtyByRisk ?? 0);
    const riskFitResolution = resolveMinLotRiskPolicyDecision({
      config: env,
      lotSize,
      riskBudgetInr,
      strategyRiskFit,
      sizingRiskFit,
      riskFitMode,
      minLotPolicy,
    });
    const oneLotRiskInr = Number(riskFitResolution.adjustedRiskInr ?? 0);
    const originalRiskInr = Number(riskFitResolution.originalRiskInr ?? 0);
    const adjustedRiskInr = Number(riskFitResolution.adjustedRiskInr ?? 0);
    const riskBreachPct = toFiniteOrNull(riskFitResolution.riskBreachPct);
    riskFitMode = riskFitResolution.riskFitMode || riskFitMode;
    riskFitDecision = riskFitResolution.riskFitDecision || riskFitDecision;
    riskBreachState = riskFitResolution.riskBreachState || riskBreachState;
    riskBreachTag = riskFitResolution.riskBreachTag || null;

    if (!(qtyByRisk >= 1)) {
      if (riskFitResolution.allowOneLot) {
        qtyByRisk = lotSize;
      } else {
        trackDecision("BLOCKED", "risk_fit", "MIN_LOT_RISK_REJECT", {
          riskFitDecision: "REJECT",
          minLotPolicy,
          lotSize,
          strategyStopLoss,
          sizingStopLoss,
          riskBudgetInr,
          oneLotRiskInr,
          originalRiskInr,
          adjustedRiskInr,
          breachPct: riskBreachPct,
          riskFitMode,
          compressionAppliedPct: slCompressionPct,
          riskBreachTag,
          bufferPctAllowed: riskFitResolution.bufferPctAllowed,
        });
        logger.info(
          {
            token,
            side,
            reason: "MIN_LOT_RISK_REJECT",
            meta: {
              minLotPolicy,
              lotSize,
              strategyStopLoss,
              sizingStopLoss,
              riskBudgetInr,
              oneLotRiskInr,
              originalRiskInr,
              adjustedRiskInr,
              breachPct: riskBreachPct,
              riskFitMode,
              riskFitDecision: "REJECT",
              compressionAppliedPct: slCompressionPct,
              riskBreachTag,
              bufferPctAllowed: riskFitResolution.bufferPctAllowed,
            },
          },
          "[trade] blocked (1 lot does not fit risk budget at strategy stop)",
        );
        return;
      }
    }

    s = applyConversionSummary(s, { riskFitDecision });
    if (riskFitDecision !== "FIT") {
      trackDecision("ADJUSTED", "risk_fit", riskFitDecision, {
        riskFitDecision,
        minLotPolicy,
        lotSize,
        strategyStopLoss,
        sizingStopLoss,
        riskBudgetInr,
        originalRiskInr,
        adjustedRiskInr,
        riskBreachPct,
        compressionAppliedPct: slCompressionPct,
        riskBreachTag,
      });
    }

    let qtyWanted = qtyByRisk;

    const entryParamsForSizing = {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: side,
      quantity: 1, // placeholder (marginSizer will change it)
      product: env.DEFAULT_PRODUCT,
      order_type: "MARKET",
      validity: "DAY",
      tag: makeTag("SIZING", "SIZING"),
    };

    const marginSizing = await marginAwareSizing({
      kite: this.kite,
      entryParams: entryParamsForSizing,
      entryPriceGuess: entryGuess,
      qtyByRisk: qtyWanted,
    });
    if (!marginSizing.ok || marginSizing.blocked || !(marginSizing.qty > 0)) {
      trackDecision(
        "BLOCKED",
        "affordability",
        marginSizing.reason || "MARGIN_BLOCKED",
        marginSizing.meta || null,
      );
      logger.info(
        {
          token,
          side,
          reason: marginSizing.reason,
          meta: marginSizing.meta,
        },
        "[trade] blocked (margin/affordability)",
      );
      return;
    }

    if (marginSizing.degraded) {
      trackDecision(
        "DEGRADED",
        "affordability",
        marginSizing.reason || "ORDER_MARGIN_ESTIMATED",
        marginSizing.meta || null,
      );
    }

    let qty = Math.max(0, Number(marginSizing.qty ?? 0));

    // Derivatives: ensure qty is a multiple of lot size and meets min-lot policy
    qty = this._normalizeQtyToLot(qty, instrument);

    const freezeCheck = this._applyFreezeQty(qty, instrument);
    if (!freezeCheck.ok) {
      trackDecision("BLOCKED", "risk_fit", "FREEZE_QTY_BLOCK", {
        qty,
        freezeQty: freezeCheck.freeze,
      });
      logger.warn(
        { token, qty, freezeQty: freezeCheck.freeze },
        "[trade] blocked (freeze quantity)",
      );
      alert("warn", "⚠️ Freeze quantity blocked trade", {
        token,
        qty,
        freezeQty: freezeCheck.freeze,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
      return;
    }
    if (freezeCheck.freeze && freezeCheck.qty !== qty) {
      logger.warn(
        { token, qty, newQty: freezeCheck.qty, freezeQty: freezeCheck.freeze },
        "[trade] qty capped to freeze quantity",
      );
      qty = freezeCheck.qty;
    }
    if (qty < 1) {
      trackDecision("BLOCKED", "affordability", "INSUFFICIENT_MARGIN_MIN_QTY", {
        qtyByRisk,
        marginSizing: marginSizing.meta || null,
      });
      logger.warn(
        {
          token,
          side,
          qtyByRisk,
          availableMargin: "check /admin/status funds",
        },
        "[trade] blocked: insufficient margin for even 1 qty",
      );
      return;
    }

    // Optional optimizer qty de-weight (keeps turnover/costs down for weak edges)
    if (String(env.OPT_DEWEIGHT_APPLY_TO_QTY || "false") === "true") {
      if (Number.isFinite(qtyMult) && qtyMult > 0 && qtyMult < 1) {
        qty = Math.max(1, Math.floor(qty * qtyMult));
        qty = this._normalizeQtyToLot(qty, instrument);
      }
    }

    const lotRiskCapEnforce = Boolean(env.LOT_RISK_CAP_ENFORCE);
    if (lotRiskCapEnforce) {
      const entryForRisk = Number(expectedEntryPrice ?? entryGuess ?? 0);
      const finalRiskFit = this._evaluateMinTradableRiskFit({
        entryPrice: entryForRisk,
        strategyStopLoss: sizingStopLoss,
        side,
        lotSize,
        riskBudgetInr,
        expectedSlippagePts,
        feePerLotInr,
        tickSize,
      });
      const maxRiskQty = Number(finalRiskFit?.maxQtyByRisk ?? 0);
      const allowTaggedOneLot =
        riskFitMode === "FORCE_ONE_LOT_BREACH" ||
        riskFitMode === "BUFFER_ALLOWED";
      const cappedQty = allowTaggedOneLot
        ? Math.max(lotSize, Math.min(qty, lotSize))
        : maxRiskQty;

      if (!allowTaggedOneLot && cappedQty < 1) {
        trackDecision("BLOCKED", "risk_fit", "LOT_RISK_CAP_BLOCK", {
          qty,
          maxRiskQty,
          strategyStopLoss,
          sizingStopLoss,
          riskBudgetInr,
          riskFitMode,
        });
        logger.info(
          {
            token,
            side,
            reason: "LOT_RISK_CAP_BLOCK",
            meta: {
              qty,
              maxRiskQty,
              strategyStopLoss,
              sizingStopLoss,
              riskBudgetInr,
              riskFitMode,
            },
          },
          "[trade] blocked (risk budget cannot support normalized qty at strategy stop)",
        );
        return;
      }

      if (allowTaggedOneLot) {
        qty = this._normalizeQtyToLot(Math.max(lotSize, qty), instrument);
      } else if (qty > cappedQty) {
        logger.warn(
          {
            token,
            side,
            qtyOld: qty,
            qtyNew: cappedQty,
            strategyStopLoss,
            sizingStopLoss,
            riskBudgetInr,
          },
          "[risk] qty reduced to fit risk budget at preserved stop",
        );
        qty = cappedQty;
      }
    }

    const exposureCheck = await this._checkExposureLimits({
      instrument,
      qty,
      entryPrice: expectedEntryPrice || entryGuess,
    });
    if (!exposureCheck.ok) {
      trackDecision(
        "BLOCKED",
        "risk_fit",
        exposureCheck.reason || "EXPOSURE_LIMIT_BLOCK",
        exposureCheck.meta || null,
      );
      logger.info(
        { token, reason: exposureCheck.reason, meta: exposureCheck.meta },
        "[trade] blocked (exposure limits)",
      );
      return;
    }

    // --- Cost/edge gate (solves "profit smaller than charges" for high-frequency scalping)
    // Require:
    //  - planned SL (₹) not too small (MIN_SL_INR)
    //  - RR target is feasible given volatility (ATR-based expected move)
    //  - expected move >= K * estimated all-in costs (COST_GATE_MULT)
    const edge = costGate({
      entryPrice: expectedEntryPrice,
      stopLoss,
      rrTarget: rrTarget,
      expectedMovePerShare: Number.isFinite(Number(expectedMovePerUnit))
        ? Number(expectedMovePerUnit)
        : s.option_meta
          ? Number(reg?.meta?.expectedMovePerShare) *
            (String(
              s.option_meta?.moneyness || env.OPT_MONEYNESS || "ATM",
            ).toUpperCase() === "ITM"
              ? Number(env.OPT_DELTA_ITM ?? 0.65)
              : String(
                    s.option_meta?.moneyness || env.OPT_MONEYNESS || "ATM",
                  ).toUpperCase() === "OTM"
                ? Number(env.OPT_DELTA_OTM ?? 0.4)
                : Number(env.OPT_DELTA_ATM ?? 0.5))
          : Number(reg?.meta?.expectedMovePerShare),
      qty,
      spreadBps: Number(sp?.meta?.bps ?? 0),
      env,
      instrument,
    });
    if (!edge.ok) {
      trackDecision(
        "BLOCKED",
        "risk_fit",
        edge.reason || "COST_EDGE_BLOCK",
        edge.meta || null,
      );
      logger.info(
        { token, reason: edge.reason, meta: edge.meta },
        "[trade] blocked (cost/edge gate)",
      );
      return;
    }

    const minGreenEnabled = String(env.MIN_GREEN_ENABLED || "true") === "true";
    const minGreen = minGreenEnabled
      ? estimateMinGreen({
          entryPrice: expectedEntryPrice,
          qty,
          spreadBps: Number(sp?.meta?.bps ?? 0),
          env,
          instrument,
        })
      : {
          estChargesInr: 0,
          slippageBufferInr: 0,
          minGreenInr: 0,
          minGreenPts: 0,
          meta: null,
        };

    markEntryPipelineStage(s, "admissionCheckAt");
    const admissionLatency = emitEntryPipelineLatency({
      signal: s,
      logger,
      env,
      extraMeta: { stage: "admission_check" },
    });
    s.entryPipelineLatency = admissionLatency;
    const executionGate = await this._evaluateExecutionAdmission({
      signal: s,
      instrument,
      side,
      plannedEntry: plannedEntryPrice,
      signalTsMs,
    });
    if (!executionGate.ok) {
      logger.info(
        withSignalLifecycleMeta(s, {
          token,
          reasonCode: executionGate.reasonCode,
          signalAgeMs: executionGate.signalAgeMs,
          freshnessSource: executionGate.freshnessSource,
          correctedSignalAgeMs: executionGate.correctedSignalAgeMs,
          pipelineLatencyMs: executionGate.pipelineLatencyMs,
          latencyGraceApplied: executionGate.latencyGraceApplied,
          spreadBps: executionGate.spreadBps,
          premiumDriftPct: executionGate.premiumDriftPct,
          entryDeviationPct: executionGate.entryDeviationPct,
          adverseUnderlyingBps: executionGate.adverseUnderlyingBps,
          chaseStep: executionGate.chaseStep,
          optionLiquidityReason: executionGate.optionLiquidityReason,
          entryPipelineLatency: admissionLatency,
        }),
        "[trade] blocked (execution admission)",
      );
      trackDecision("BLOCKED", "entry", executionGate.reasonCode, {
        signalAgeMs: executionGate.signalAgeMs,
        freshnessSource: executionGate.freshnessSource,
        correctedSignalAgeMs: executionGate.correctedSignalAgeMs,
        pipelineLatencyMs: executionGate.pipelineLatencyMs,
        latencyGraceApplied: executionGate.latencyGraceApplied,
        spreadBps: executionGate.spreadBps,
        premiumDriftPct: executionGate.premiumDriftPct,
        entryDeviationPct: executionGate.entryDeviationPct,
        adverseUnderlyingBps: executionGate.adverseUnderlyingBps,
        optionLiquidityReason: executionGate.optionLiquidityReason,
        entryPipelineLatency: admissionLatency,
      });
      return;
    }

    const executionTs = new Date();
    const executionEntryPrice = Number(
      executionGate.executionPrice ?? plannedEntryPrice,
    );
    const tradeId = crypto.randomUUID();
    const initialStrategyRisk = this._computeActualRiskFromStrategyStop({
      entryPrice: expectedEntryPrice,
      strategyStopLoss,
      qty,
      side,
    });
    const entryUrgency = this._entryUrgencyProfile({
      strategyId: s.strategyId,
      strategyStyle: s.strategyStyle,
      planMeta,
      option_meta: s.option_meta || null,
      instrument,
    });
    const trade = {
      tradeId,
      instrument_token: token,
      intervalMin,
      instrument,
      strategyId: s.strategyId,
      riskKey,
      side: side,
      qty,
      candle: s.candle,
      underlying_token: s.underlying_token || null,
      underlying_side: s.underlying_side || null,
      option_meta: s.option_meta || null,
      ...this._buildStopSemanticsPatch({
        strategyStopLoss,
        sizingStopLoss,
        brokerStopLoss: strategyStopLoss,
      }),
      initialStrategyRiskPts: initialStrategyRisk.riskPts,
      initialStrategyRiskInr: initialStrategyRisk.riskInr,
      oneLotPlannedRiskInr: oneLotRiskInr,
      riskBudgetInr,
      riskFitDecision,
      riskFitMode,
      riskBreachState,
      riskBreachPct,
      riskBreachTag,
      slCompressionPct,
      compressionAppliedPct: slCompressionPct,
      originalRiskInr,
      adjustedRiskInr,
      postFillTrueRiskInr: null,
      postFillRiskCapInr: riskBudgetInr,
      postFillRiskAction: "NONE",
      executionRiskPts: null,
      executionRiskQty: null,
      executionRiskInr: null,
      beLocked: false,
      trueBePrice: null,
      costGreenFloorInr: null,
      costGreenFloorPrice: null,
      greenLockActive: false,
      greenLockFloorPrice: null,
      beAppliedAt: null,
      beAppliedStopLoss: null,
      beApplyFails: 0,
      peakLtp: null,
      peakPnlInr: 0,
      peakPnlR: null,
      peakExecutablePnlInr: null,
      peakExecutableR: null,
      peakR: 0,
      beEligible: false,
      beLockHit: false,
      trailHit: false,
      profitLockArmed: false,
      mfeLockTier: 0,
      mfeLockFloorPrice: null,
      givebackR: null,
      givebackPct: null,
      givebackActive: false,
      shadowExitActive: false,
      protectionUpgradePending: false,
      protectionUpgradeSoftFailed: false,
      protectionUpgradeFallbackMode: null,
      protectionUpgradeUnconfirmedSince: null,
      protectionUpgradeTargetStopLoss: null,
      shadowProtectionActiveReason: null,
      runnerRebasedAt: null,
      runnerRebaseSource: null,
      runnerBaselineQty: null,
      runnerBaselineLtp: null,
      runnerBaselineExecutablePrice: null,
      runnerBaselinePnlInr: null,
      runnerBaselineExecutablePnlInr: null,
      runnerRealizedPnlInr: null,
      lastProtectedR: null,
      lastProtectedInr: null,
      lastExitPlanReason: null,
      trailSl: null,
      trailActive: false,
      desiredStopLoss: null,
      finalStopLoss: null,
      hardFloor: null,
      structureTrailFloor: null,
      structureTrailSource: null,
      structureTrailAllowed: false,
      protectionGateOpen: false,
      winnerModeActive: false,
      entryFilledAt: null,
      entryPlacedAt: null,
      timeStopAt: null,
      quoteAtEntry,
      marketContextAtEntry: {
        spread: Number.isFinite(Number(quoteAtEntry?.bps))
          ? Number(quoteAtEntry?.bps)
          : null,
        ivPercentile: Number.isFinite(Number(s?.option_meta?.iv_pts))
          ? Number(s.option_meta.iv_pts)
          : null,
        atr: Number.isFinite(Number(reg?.meta?.atr))
          ? Number(reg.meta.atr)
          : null,
        regimeTag: reg?.meta?.regime || s?.regime || null,
        trendState: reg?.meta?.multiTf?.trend || null,
      },
      signalTs: new Date(signalTsMs),
      signalEventTs: s.signalEventTs || null,
      executionTs,
      signalAgeMs: executionGate.signalAgeMs,
      plannedEntry: plannedEntryPrice,
      actualEntry: null,
      entryDriftPct: Number(executionGate.premiumDriftPct ?? 0),
      spreadBpsAtSelection: Number.isFinite(Number(quoteAtEntry?.bps))
        ? Number(quoteAtEntry?.bps)
        : null,
      spreadBpsAtExecution: executionGate.spreadBps,
      freshnessAccepted: Boolean(executionGate.freshnessAccepted),
      executionGateReason: executionGate.reasonCode,
      earlyFailArmed: false,
      earlyFailReason: null,
      expectedEntryPrice: executionEntryPrice,
      regimeMeta: reg?.meta || null,
      costMeta: edge?.meta || null,
      estChargesInr: minGreen.estChargesInr,
      slippageBufferInr: minGreen.slippageBufferInr,
      minGreenInr: minGreen.minGreenInr,
      minGreenPts: minGreen.minGreenPts,
      // planned risk cap used for sizing / gating (₹)
      riskInr: riskBudgetInr,
      entryOrderType,
      maxEntrySlippageBps: maxEntrySlipBps,
      maxEntrySlippageKillBps: maxEntrySlipKillBps,
      entrySlippageBps: null,
      entryUrgencyKey: entryUrgency.profileKey,
      entryRepriceCount: 0,
      entryPendingLastReason: null,
      entryPendingLastCheckAt: null,
      rr: rrTarget,
      plannedTargetPrice: plannedTargetPrice || null,
      planMeta: planMeta || null,
      pacingPolicy: policy?.meta || null,
      optimizer: optimizerTelemetry,
      optimizerContext,
      marginSizingReason: marginSizing.reason || null,
      marginSizingDegraded: Boolean(marginSizing.degraded),
      marginSizingMeta: marginSizing.meta || null,
      status: STATUS.ENTRY_PLACED,
      entryOrderId: null,
      entryFinalized: false,
      entryFallbackInFlight: false,
      slOrderId: null,
      targetOrderId: null,
      exitPlacedAt: null,
      entryPrice: null,
      exitPrice: null,
      closeReason: null,
      exitFamily: null,
      exitReasonCode: null,
      exitAuthority: null,
      targetReplaceCount: 0,
      product: String(env.DEFAULT_PRODUCT || "MIS").toUpperCase(),
      signalId: s.signalId || null,
      signalCreatedAt: s.signalCreatedAt || null,
      signalDecisionTs: s.signalDecisionTs || null,
      regimeSnapshot: s.regimeSnapshot || null,
      signalDecision: s.signalDecision || null,
      conversionSummary: s.conversionSummary || null,
      entryPipeline: s.entryPipeline || null,
      decisionAt: new Date(),
    };
    markEntryPipelineStage(s, "orderIntentCreatedAt");
    trade.entryPipeline = s.entryPipeline || null;
    trade.entryPipelineLatency = emitEntryPipelineLatency({
      signal: s,
      logger,
      env,
      extraMeta: { stage: "order_intent" },
    });

    await insertTrade(trade);

    // ENTRY order (MARKET by default; optional LIMIT to reduce slippage)
    const entryParams = {
      exchange: instrument.exchange,
      tradingsymbol: instrument.tradingsymbol,
      transaction_type: side,
      quantity: qty,
      product: env.DEFAULT_PRODUCT,
      order_type: entryOrderType,
      validity: "DAY",
      tag: makeTag(tradeId, "ENTRY"),
    };

    if (entryOrderType === "LIMIT") {
      // Use top-of-book price from spread check if available.
      // BUY -> ask; SELL -> bid
      const px = Number(executionEntryPrice) || Number(entryGuess);
      entryParams.price = roundToTick(px, tick, side === "BUY" ? "up" : "down");
    }

    logger.info(
      withSignalLifecycleMeta(s, {
        tradeId,
        entryParams,
        entryUrgency: entryUrgency.profileKey,
        pendingMaxMs: entryUrgency.maxPendingMs,
        maxChaseBps: entryUrgency.maxChaseBps,
        signalAgeMs: executionGate.signalAgeMs,
        spreadBpsAtExecution: executionGate.spreadBps,
        entryDriftPct: executionGate.premiumDriftPct,
        entryPipelineLatency: trade.entryPipelineLatency,
      }),
      "[trade] placing ENTRY",
    );
    trackDecision(
      "ENTRY_PLACED",
      "entry",
      "ENTRY_PLACED",
      {
        entryParams,
        signalAgeMs: executionGate.signalAgeMs,
        spreadBpsAtExecution: executionGate.spreadBps,
        entryDriftPct: executionGate.premiumDriftPct,
        entryPipelineLatency: trade.entryPipelineLatency,
        optimizer: optimizerTelemetry,
      },
      trade,
    );
    alert("info", "🟢 ENTRY placing", {
      tradeId,
      symbol: instrument.tradingsymbol,
      side: side,
      qty,
      entryRef: Number(expectedEntryPrice) || Number(entryGuess) || null,
      stopLoss,
      strategyId: s.strategyId,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    let entryOrderId = null;
    try {
      const out = await this._safePlaceOrder(
        env.DEFAULT_ORDER_VARIETY,
        entryParams,
        { purpose: "ENTRY", tradeId },
      );
      entryOrderId = out.orderId;
    } catch (e) {
      trackDecision(
        "BLOCKED",
        "entry",
        "ENTRY_PLACE_FAILED",
        { message: e.message },
        trade,
      );
      logger.error({ tradeId, e: e.message }, "[trade] ENTRY place failed");
      alert("error", "❌ ENTRY rejected/failed", {
        tradeId,
        message: e.message,
      }).catch((err) =>
        reportWindowedFault({
          code: "ALERT_SEND_FAILED",
          windowKey: "alert_send_failed",
          err,
          message: "[alert] failed to dispatch notification",
          meta: { context: "trade_manager" },
        }),
      );
      this.risk.markFailure("ENTRY_PLACE_FAILED");
      await this._updateTrade(tradeId, {
        status: STATUS.ENTRY_FAILED,
        closeReason: "ENTRY_PLACE_FAILED | " + e.message,
      });
      await this._finalizeClosed(tradeId, token);
      return;
    }

    // Pro: if LIMIT entry is not filled quickly, fallback to MARKET (options only)
    if (entryOrderType === "LIMIT") {
      this._startEntryLadder({
        tradeId,
        entryOrderId,
        instrument,
        side,
        basePrice: Number(
          entryParams.price ?? expectedEntryPrice ?? entryGuess,
        ),
      }).catch((e) => {
        logger.warn(
          { tradeId, e: e?.message || String(e) },
          "[entry_ladder] failed",
        );
      });
    }

    // Pro: if LIMIT entry is not filled quickly, fallback to MARKET (options only)
    if (
      isOptContract &&
      entryOrderType === "LIMIT" &&
      String(env.ENTRY_LIMIT_FALLBACK_TO_MARKET || "false") === "true" &&
      Number(env.ENTRY_LIMIT_TIMEOUT_MS ?? 0) > 0
    ) {
      try {
        this._scheduleEntryLimitFallback({
          tradeId,
          entryOrderId,
          entryParams,
          timeoutMs: Number(env.ENTRY_LIMIT_TIMEOUT_MS),
        });
      } catch (e) {
        logger.warn(
          { tradeId, entryOrderId, e: e.message },
          "[entry_fallback] schedule failed",
        );
      }
    }

    await this._updateTrade(tradeId, {
      entryOrderId,
      entryPlacedAt: new Date(),
      status: STATUS.ENTRY_OPEN,
      entryFinalized: false,
      ...this._eventPatch("ENTRY_PLACED", {
        orderId: entryOrderId,
        qty,
        side,
      }),
    });
    await linkOrder({ order_id: String(entryOrderId), tradeId, role: "ENTRY" });
    await this._replayOrphanUpdates(entryOrderId);

    this.activeTradeId = tradeId;
    this._activeTradeToken = token;
    this._activeTradeSide = side;
    this.risk.markTradeOpened(token, { tradeId, side: side, qty });

    // watchdog fallback (in case order_update is missing)
    this._watchEntryUntilDone(tradeId, String(entryOrderId)).catch((e) => {
      logger.error({ tradeId, e: e.message }, "[entry_watch] failed");
    });
  }

  async onOrderUpdate(order) {
    if (this._stopped) return;
    const orderId = String(order.order_id || order.orderId || "");
    if (!orderId) return;

    const status = String(order.status || "").toUpperCase();
    const updateSignature = buildOrderUpdateSignature(order);
    const prevOrder = this._lastOrdersById.get(orderId) || null;
    const prevStatus = String(prevOrder?.status || "").toUpperCase();
    if (
      isOrderStatusRegression(prevStatus, status) &&
      isTerminalOrderStatus(prevStatus)
    ) {
      logger.info(
        { orderId, prevStatus, incomingStatus: status },
        "[order_update] ignored (status regression after terminal)",
      );
      return;
    }

    if (
      hasSeenOrderUpdateSignature(
        this._processedOrderUpdateSignatureById,
        orderId,
        updateSignature,
      )
    ) {
      return;
    }

    this._rememberLiveOrder(orderId, order);

    const hit = await findTradeByOrder(orderId);
    if (status === "REJECTED") this._pushCircuitEvent("rejects");
    if (!hit) {
      if (
        hasSeenOrderUpdateSignature(
          this._orphanOrderUpdateSignatureById,
          orderId,
          updateSignature,
        )
      ) {
        return;
      }
      rememberOrderUpdateSignature(
        this._orphanOrderUpdateSignatureById,
        orderId,
        updateSignature,
      );
      if (status === "COMPLETE") {
        try {
          const matched = await this._matchUnlinkedBrokerExit(order);
          if (matched?.tradeId) {
            await linkOrder({
              order_id: orderId,
              tradeId: matched.tradeId,
              role: "BROKER_SQUAREOFF",
            });
            await this._closeByBrokerSquareoff(
              matched,
              order,
              "BROKER_SQUAREOFF",
            );
            return;
          }
        } catch (e) {
          logger.warn(
            { orderId, e: e?.message || String(e) },
            "[order_update] unlinked complete match failed",
          );
        }
      }

      // Early order_update race: store and replay after link exists.
      await saveOrphanOrderUpdate({ order_id: orderId, payload: order });
      this._orphanReplayStats.queued += 1;
      logger.warn(
        { orderId, status: order.status },
        "[order_update] orphan stored (no link yet)",
      );
      return;
    }

    rememberOrderUpdateSignature(
      this._processedOrderUpdateSignatureById,
      orderId,
      updateSignature,
    );
    this._orphanOrderUpdateSignatureById.delete(orderId);

    try {
      await appendOrderLog({
        order_id: orderId,
        tradeId: hit?.trade?.tradeId || null,
        status,
        payload: order,
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const linkedTrade = hit?.trade || null;
    const link = hit?.link || null;
    try {
      await linkOrder({
        order_id: orderId,
        tradeId: linkedTrade?.tradeId || null,
        role: link?.role || "UNKNOWN",
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
    try {
      await upsertLiveOrderSnapshot({
        tradeId: linkedTrade?.tradeId || null,
        orderId,
        role: link?.role || "UNKNOWN",
        order,
        source: "order_update",
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    return this._runTradeCommand(
      linkedTrade?.tradeId,
      EXEC_COMMAND.APPLY_ORDER_UPDATE,
      async (freshTrade) => {
        const trade = freshTrade || linkedTrade;
        if (!trade?.tradeId) return;

        this._scheduleReconcile("order_update");

        // Ignore expected OCO cancels
        if (
          (status === "CANCELLED" || status === "CANCELED") &&
          this.expectedCancelOrderIds.has(orderId)
        ) {
          this.expectedCancelOrderIds.delete(orderId);
          logger.info({ orderId }, "[oco] cancel confirmed");
          return;
        }

        logger.info(
          {
            tradeId: trade.tradeId,
            role: link.role,
            status,
            orderId,
            status_message: order.status_message || null,
            status_message_raw: order.status_message_raw || null,
          },
          "[order_update]",
        );

    if (link.role === "BROKER_SQUAREOFF") {
      if (status === "COMPLETE") {
        await this._closeByBrokerSquareoff(trade, order, "BROKER_SQUAREOFF");
      }
      return;
    }

    // ✅ FIXED: PANIC_EXIT must not reference undefined variables and must not finalize on dead status
    if (link.role === "PANIC_EXIT") {
      if (status === "COMPLETE") {
        const exitPrice = Number(order.average_price ?? order.price ?? 0);
        this._clearPanicExitWatch(trade.tradeId);
        this._panicExitRetryCount.delete(String(trade.tradeId));
        const exitLifecycle = resolveExitLifecycle(
          trade?.exitReasonCode || trade?.panicExitReason || "PANIC_EXIT",
          {
            exitAuthority:
              trade?.exitAuthority ||
              (trade?.panicExitReason ? null : "PANIC_EXIT_ENGINE"),
          },
        );

        await this._updateTrade(trade.tradeId, {
          status: STATUS.CLOSED,
          panicExitState: STATUS.PANIC_EXIT_CONFIRMED,
          panicExitPending: false,
          exitPrice: exitPrice > 0 ? exitPrice : trade.exitPrice,
          closeReason: (trade.closeReason || "PANIC_EXIT") + " | FILLED",
          exitReason: "PANIC_EXIT",
          exitFamily:
            exitLifecycle.exitFamily ?? trade?.exitFamily ?? "LOSS_CONTAINMENT",
          exitReasonCode:
            exitLifecycle.exitReasonCode ??
            trade?.exitReasonCode ??
            "PANIC_EXIT",
          exitAuthority:
            exitLifecycle.exitAuthority ??
            trade?.exitAuthority ??
            "PANIC_EXIT_ENGINE",
          exitAt: new Date(),
          closedAt: new Date(),
        });

        alert("warn", "PANIC EXIT filled", {
          tradeId: trade.tradeId,
          exitPrice: exitPrice > 0 ? exitPrice : null,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
        await this._bookRealizedPnl(trade.tradeId);
        await this._finalizeClosed(trade.tradeId, trade.instrument_token);
        return;
      }

      // OPEN / PARTIAL: track progress, but do not place SL/TARGET (panic exit is the protection)
      if (status === "OPEN" || status === "PARTIAL") {
        const filledNow = Number(order.filled_quantity ?? 0);
        if (filledNow > 0) {
          await this._updateTrade(trade.tradeId, {
            panicExitPending: false,
            panicExitLastStatus: status,
            panicExitFilledQty: filledNow,
            panicExitAvgPrice: Number(order.average_price ?? 0) || null,
            panicExitLastUpdateAt: new Date(),
          });
          alert("warn", "⚠️ PANIC EXIT partial/open (still exiting)", {
            tradeId: trade.tradeId,
            status,
            filledQty: filledNow,
          }).catch((err) =>
            reportWindowedFault({
              code: "ALERT_SEND_FAILED",
              windowKey: "alert_send_failed",
              err,
              message: "[alert] failed to dispatch notification",
              meta: { context: "trade_manager" },
            }),
          );
        }
        return;
      }

      if (isDead(status)) {
        const msg =
          order.status_message_raw ||
          order.status_message ||
          order.message ||
          "";

        this._clearPanicExitWatch(trade.tradeId);
        this._panicExitRetryCount.delete(String(trade.tradeId));
        this._handleOrderRejection({ trade, order, role: link.role });
        logger.error(
          { tradeId: trade.tradeId, orderId, status, msg },
          "[panic] PANIC_EXIT order is dead (position may still be open!)",
        );
        alert(
          "error",
          "🛑 PANIC EXIT order failed (manual intervention needed)",
          {
            tradeId: trade.tradeId,
            status,
            msg: msg || null,
          },
        ).catch((err) => {
          reportFault({
            code: "TRADING_TRADEMANAGER_ASYNC",
            err,
            message: "[src/trading/tradeManager.js] async task failed",
          });
        });

        // IMPORTANT: do NOT finalizeClosed here. Broker position may still be open.
        await this._updateTrade(trade.tradeId, {
          status: STATUS.GUARD_FAILED,
          panicExitPending: false,
          closeReason: `PANIC_EXIT_${status}${msg ? " | " + msg : ""}`,
          panicExitLastStatus: status,
          panicExitLastUpdateAt: new Date(),
        });
        return;
      }

      // TRIGGER PENDING / other states -> wait
      return;
    }

    if (link.role === "RISK_REDUCE") {
      logger.info(
        { tradeId: trade.tradeId, orderId, status },
        "[order_update] risk reduce",
      );
      return;
    }

    if (link.role === "ENTRY") {
      // Guard against out-of-order / duplicate entry updates (e.g., OPEN after COMPLETE, or duplicate COMPLETE)
      const freshEntryTrade0 = await getTrade(trade.tradeId);
      const progressedStatus0 = freshEntryTrade0?.status || trade.status;
      const currentEntryOrderId = String(freshEntryTrade0?.entryOrderId || "");
      const isCurrentEntry =
        !currentEntryOrderId || currentEntryOrderId === orderId;

      if (
        ENTRY_REPLAY_BLOCKED_STATUSES.has(progressedStatus0) &&
        ["OPEN", "PARTIAL", "COMPLETE"].includes(status)
      ) {
        logger.info(
          {
            tradeId: trade.tradeId,
            role: link.role,
            status,
            orderId,
            tradeStatus: progressedStatus0,
          },
          "[order_update] ignored (stale/duplicate entry update)",
        );
        return;
      }

      if (status === "COMPLETE") {
        if (!isCurrentEntry) {
          logger.warn(
            {
              tradeId: trade.tradeId,
              orderId,
              status,
              currentEntryOrderId,
            },
            "[order_update] complete update for non-current entry order ignored",
          );
          return;
        }
        this._clearEntryLimitFallbackTimer(trade.tradeId);
        await this._finalizeEntryFill({
          tradeId: trade.tradeId,
          trade,
          avgPrice: Number(
            order.average_price ??
              trade.entryPrice ??
              trade.expectedEntryPrice ??
              trade.candle?.close ??
              0,
          ),
          filledQty: Number(order.filled_quantity ?? trade.qty ?? 0),
          source: "ORDER_UPDATE",
          partial: false,
        });
        return;
        const avg = Number(
          order.average_price ?? trade.entryPrice ?? trade.candle?.close,
        );
        const filledQty = Number(order.filled_quantity ?? trade.qty);

        const expected = Number(
          trade.expectedEntryPrice ??
            trade.quoteAtEntry?.ltp ??
            trade.candle?.close ??
            0,
        );
        const entrySide = String(trade.side || "BUY").toUpperCase();
        const entryType = String(
          trade.entryOrderType || env.ENTRY_ORDER_TYPE || "MARKET",
        ).toUpperCase();
        const submittedLimitPriceRaw =
          entryType === "LIMIT"
            ? (order.price ??
              order.limit_price ??
              trade.expectedEntryPrice ??
              trade.entryPrice ??
              null)
            : null;
        const submittedLimitPrice =
          Number.isFinite(Number(submittedLimitPriceRaw)) &&
          Number(submittedLimitPriceRaw) > 0
            ? Number(submittedLimitPriceRaw)
            : null;
        const slipInr = worseSlippageInr({
          side: trade.side,
          expected,
          actual: avg,
          qty: filledQty,
          leg: "ENTRY",
        });
        const guardForLimit =
          String(env.ENTRY_SLIPPAGE_GUARD_FOR_LIMIT || "false") === "true";

        const isOptContract =
          !!trade.option_meta ||
          String(trade.instrument?.instrument_type || "").toUpperCase() ===
            "CE" ||
          String(trade.instrument?.instrument_type || "").toUpperCase() ===
            "PE" ||
          /(?:CE|PE)$/.test(
            String(trade.instrument?.tradingsymbol || "").toUpperCase(),
          );

        const maxBps = Number(
          trade.maxEntrySlippageBps ??
            (isOptContract
              ? (env.MAX_ENTRY_SLIPPAGE_BPS_OPT ?? 120)
              : (env.MAX_ENTRY_SLIPPAGE_BPS ?? 25)),
        );
        const killBpsBase = Number(
          trade.maxEntrySlippageKillBps ??
            (isOptContract
              ? (env.MAX_ENTRY_SLIPPAGE_KILL_BPS_OPT ?? 250)
              : (env.MAX_ENTRY_SLIPPAGE_KILL_BPS ?? 60)),
        );

        const tick = Number(trade.instrument?.tick_size ?? 0.05);
        const ticksAllowance = Number(
          isOptContract
            ? (env.MAX_ENTRY_SLIPPAGE_TICKS_OPT ?? 4)
            : (env.MAX_ENTRY_SLIPPAGE_TICKS ?? 2),
        );
        const tickBps =
          expected > 0 && tick > 0 ? (tick / expected) * 10000 : null;

        const effMaxBps =
          tickBps != null
            ? Math.max(maxBps, tickBps * Math.max(1, ticksAllowance))
            : maxBps;

        const effKillBps = Math.max(killBpsBase, effMaxBps * 2);

        const slippageGuard = evaluateEntrySlippageGuard({
          entrySide,
          entryType,
          expectedPrice: expected,
          avgFillPrice: avg,
          submittedLimitPrice,
          thresholdBps: effMaxBps,
          guardForLimit,
        });
        const slipBps = slippageGuard.rawSlipBps;
        const adverseSlipBps = slippageGuard.adverseSlipBps;
        const favorableSlipBps = slippageGuard.favorableSlipBps;
        const shouldPanicForSlippage = slippageGuard.triggered;
        const plannedEntryForFill = Number(
          trade.plannedEntry ?? trade.expectedEntryPrice ?? expected ?? 0,
        );
        const actualEntryDriftPct = adverseDriftPct({
          side: trade.side,
          plannedEntry: plannedEntryForFill,
          actualEntry: avg,
        });
        const entryFillPatch = {
          entryPrice: avg,
          actualEntry: avg,
          qty: filledQty,
          entrySlippageBps: slipBps,
          entrySlippageInrWorse: slipInr,
          entryDriftPct: actualEntryDriftPct,
          entryFilledAt: new Date(),
          entryAt: new Date(),
          entryFinalized: true,
          ...this._eventPatch("ENTRY_FILLED", {
            avg,
            filledQty,
            slipBps,
          }),
        };
        const slippageLog = {
          tradeId: trade.tradeId,
          entrySide,
          entryType,
          expected,
          avg,
          submittedLimitPrice,
          rawSlipBps: slipBps,
          adverseSlipBps,
          favorableSlipBps,
          thresholdBps: effMaxBps,
          effMaxBps,
          isAtOrBetterThanLimit: slippageGuard.isAtOrBetterThanLimit,
          triggered: shouldPanicForSlippage,
          reason: slippageGuard.reason,
          maxBps,
          tick,
          ticksAllowance,
        };

        // Slippage guard (primarily for MARKET entries). Options are noisier; thresholds are segment-aware.
        if (shouldPanicForSlippage) {
          await this._updateTrade(trade.tradeId, {
            status: STATUS.GUARD_FAILED,
            closeReason: `ENTRY_SLIPPAGE (${adverseSlipBps.toFixed(
              1,
            )}bps > ${effMaxBps.toFixed(1)})`,
            ...entryFillPatch,
          });

          logger.error(
            slippageLog,
            "[guard] adverse entry slippage too high -> panic exit",
          );

          alert(
            "error",
            "🛑 ENTRY slippage too high -> panic exit",
            slippageLog,
          ).catch((err) =>
            reportWindowedFault({
              code: "ALERT_SEND_FAILED",
              windowKey: "alert_send_failed",
              err,
              message: "[alert] failed to dispatch notification",
              meta: { context: "trade_manager" },
            }),
          );

          if (adverseSlipBps >= effKillBps && entryType === "MARKET") {
            this.risk.setKillSwitch(true);
          }

          await this._panicExit(
            {
              ...trade,
              status: STATUS.GUARD_FAILED,
              entryPrice: avg,
              qty: filledQty,
            },
            "ENTRY_SLIPPAGE",
          );

          return;
        }

        await this._updateTrade(trade.tradeId, {
          status: STATUS.ENTRY_FILLED,
          ...entryFillPatch,
        });
        logger.info(slippageLog, "[guard] entry slippage accepted");

        const minGreenEnabled =
          String(env.MIN_GREEN_ENABLED || "true") === "true";
        const minGreen = minGreenEnabled
          ? estimateMinGreen({
              entryPrice: avg,
              qty: filledQty,
              spreadBps: Number(trade?.quoteAtEntry?.bps ?? 0),
              env,
              instrument: trade.instrument,
            })
          : {
              estChargesInr: 0,
              slippageBufferInr: 0,
              minGreenInr: 0,
              minGreenPts: 0,
              meta: null,
            };

        const strategyStopLossAtFill = this._strategyStopLossFromTrade(trade);
        const sizingStopLossAtFill = this._sizingStopLossFromTrade(trade);
        const actualRisk = this._computeActualRiskFromStrategyStop({
          entryPrice: avg,
          strategyStopLoss: strategyStopLossAtFill,
          qty: filledQty,
          side: trade.side,
        });
        const riskBudgetAtFill = this._riskBudgetInr(trade);

        const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
        const proTimeStopsEnabled =
          Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0) > 0 ||
          Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0) > 0;
        const timeStopAt =
          !proTimeStopsEnabled &&
          Number.isFinite(timeStopMin) &&
          timeStopMin > 0
            ? new Date(Date.now() + timeStopMin * 60 * 1000)
            : null;

        logger.info(
          {
            tradeId: trade.tradeId,
            strategyStopLoss: strategyStopLossAtFill,
            actualRiskPts: actualRisk.riskPts,
            actualRiskInr: actualRisk.riskInr,
            minGreenInr: minGreen.minGreenInr,
            minGreenPts: minGreen.minGreenPts,
            timeStopAt,
          },
          "[trade] strategy risk/min-green computed",
        );

        await this._updateTrade(
          trade.tradeId,
          this._buildStopSemanticsPatch({
            strategyStopLoss: strategyStopLossAtFill,
            sizingStopLoss: sizingStopLossAtFill,
            brokerStopLoss: strategyStopLossAtFill,
            patch: {
              riskPts: actualRisk.riskPts,
              riskInr: riskBudgetAtFill,
              ...buildExecutionRiskPatch({
                trade,
                qty: filledQty,
                entryPrice: avg,
                stopLoss: strategyStopLossAtFill,
              }),
              lotSize: filledQty,
              riskStopPrice: strategyStopLossAtFill,
              riskStopPts: actualRisk.riskPts,
              riskStopInr: actualRisk.riskInr,
              riskQty: filledQty,
              initialStrategyRiskPts:
                trade.initialStrategyRiskPts ?? actualRisk.riskPts,
              initialStrategyRiskInr:
                trade.initialStrategyRiskInr ?? actualRisk.riskInr,
              postFillTrueRiskInr: actualRisk.riskInr,
              postFillRiskCapInr: riskBudgetAtFill,
              postFillRiskAction: "NONE",
              riskBreachState: "NONE",
              actualRiskPts: actualRisk.riskPts,
              actualRiskInr: actualRisk.riskInr,
              estChargesInr: minGreen.estChargesInr,
              slippageBufferInr: minGreen.slippageBufferInr,
              minGreenInr: minGreen.minGreenInr,
              minGreenPts: minGreen.minGreenPts,
              timeStopAt,
            },
          }),
        );

        alert("info", "✅ ENTRY filled", {
          tradeId: trade.tradeId,
          avg,
          expected,
          filledQty,
          slipBps,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
        this.risk.resetFailures();

        // PATCH-10: Post-fill risk recheck (actual fill can make ₹ risk exceed cap)
        const pf = await this._postFillRiskRecheckAndAdjust({
          tradeId: trade.tradeId,
          entryPrice: avg,
          qty: filledQty,
        });
        if (pf && pf.exited) return;

        await this._recalcTargetFromActualFill({
          tradeId: trade.tradeId,
          entryPrice: avg,
        });

        const freshForExits = (await getTrade(trade.tradeId)) || trade;
        await this._placeExitsIfMissing({
          ...trade,
          ...freshForExits,
          entryPrice: avg,
          qty: filledQty,
        });
        await this._ensureExitQty(trade.tradeId, filledQty);
        return;
      }

      const filledNow = Number(order.filled_quantity ?? 0);
      const avgNow = Number(
        order.average_price ?? trade.entryPrice ?? trade.candle?.close ?? 0,
      );
      if ((status === "PARTIAL" || status === "OPEN") && filledNow > 0) {
        if (!isCurrentEntry) {
          logger.warn(
            { tradeId: trade.tradeId, orderId, status, currentEntryOrderId },
            "[order_update] partial/open update for non-current entry order ignored",
          );
          return;
        }
        this._clearEntryLimitFallbackTimer(trade.tradeId);
        await this._finalizeEntryFill({
          tradeId: trade.tradeId,
          trade,
          avgPrice:
            avgNow > 0
              ? avgNow
              : Number(
                  trade.entryPrice ??
                    trade.expectedEntryPrice ??
                    trade.candle?.close ??
                    0,
                ),
          filledQty: filledNow,
          source: "ORDER_UPDATE",
          partial: true,
        });
        return;
        const partialEntryDriftPct = adverseDriftPct({
          side: trade.side,
          plannedEntry: Number(
            trade.plannedEntry ?? trade.expectedEntryPrice ?? 0,
          ),
          actualEntry: avgNow,
        });
        this._clearEntryLimitFallbackTimer(trade.tradeId);
        // Place protective exits for the filled quantity (safety first)
        await this._updateTrade(trade.tradeId, {
          status: STATUS.ENTRY_OPEN,
          entryPrice: avgNow > 0 ? avgNow : trade.entryPrice,
          actualEntry: avgNow > 0 ? avgNow : trade.actualEntry,
          entryDriftPct: partialEntryDriftPct,
          qty: filledNow,
          entryFinalized: true,
          ...this._eventPatch("ENTRY_PARTIAL_FILL", {
            avg: avgNow,
            filledQty: filledNow,
          }),
        });
        const minGreenEnabled =
          String(env.MIN_GREEN_ENABLED || "true") === "true";
        const minGreen = minGreenEnabled
          ? estimateMinGreen({
              entryPrice: avgNow,
              qty: filledNow,
              spreadBps: Number(trade?.quoteAtEntry?.bps ?? 0),
              env,
              instrument: trade.instrument,
            })
          : {
              estChargesInr: 0,
              slippageBufferInr: 0,
              minGreenInr: 0,
              minGreenPts: 0,
              meta: null,
            };
        const strategyStopLossAtFill = this._strategyStopLossFromTrade(trade);
        const sizingStopLossAtFill = this._sizingStopLossFromTrade(trade);
        const actualRisk = this._computeActualRiskFromStrategyStop({
          entryPrice: avgNow,
          strategyStopLoss: strategyStopLossAtFill,
          qty: filledNow,
          side: trade.side,
        });
        const riskBudgetAtFill = this._riskBudgetInr(trade);
        const timeStopMin = Number(env.TIME_STOP_MIN ?? 0);
        const proTimeStopsEnabled =
          Number(env.TIME_STOP_NO_PROGRESS_MIN ?? 0) > 0 ||
          Number(env.TIME_STOP_MAX_HOLD_MIN ?? 0) > 0;
        const timeStopAt =
          !proTimeStopsEnabled &&
          Number.isFinite(timeStopMin) &&
          timeStopMin > 0
            ? new Date(Date.now() + timeStopMin * 60 * 1000)
            : null;
        logger.info(
          {
            tradeId: trade.tradeId,
            strategyStopLoss: strategyStopLossAtFill,
            actualRiskPts: actualRisk.riskPts,
            actualRiskInr: actualRisk.riskInr,
            minGreenInr: minGreen.minGreenInr,
            minGreenPts: minGreen.minGreenPts,
            timeStopAt,
          },
          "[trade] strategy risk/min-green computed (partial)",
        );

        await this._updateTrade(
          trade.tradeId,
          this._buildStopSemanticsPatch({
            strategyStopLoss: strategyStopLossAtFill,
            sizingStopLoss: sizingStopLossAtFill,
            brokerStopLoss: strategyStopLossAtFill,
            patch: {
              riskPts: actualRisk.riskPts,
              riskInr: riskBudgetAtFill,
              ...buildExecutionRiskPatch({
                trade,
                qty: filledNow,
                entryPrice: avgNow,
                stopLoss: strategyStopLossAtFill,
              }),
              lotSize: filledNow,
              riskStopPrice: strategyStopLossAtFill,
              riskStopPts: actualRisk.riskPts,
              riskStopInr: actualRisk.riskInr,
              riskQty: filledNow,
              initialStrategyRiskPts:
                trade.initialStrategyRiskPts ?? actualRisk.riskPts,
              initialStrategyRiskInr:
                trade.initialStrategyRiskInr ?? actualRisk.riskInr,
              postFillTrueRiskInr: actualRisk.riskInr,
              postFillRiskCapInr: riskBudgetAtFill,
              postFillRiskAction: "NONE",
              riskBreachState: "NONE",
              actualRiskPts: actualRisk.riskPts,
              actualRiskInr: actualRisk.riskInr,
              estChargesInr: minGreen.estChargesInr,
              slippageBufferInr: minGreen.slippageBufferInr,
              minGreenInr: minGreen.minGreenInr,
              minGreenPts: minGreen.minGreenPts,
              timeStopAt,
            },
          }),
        );
        const pf = await this._postFillRiskRecheckAndAdjust({
          tradeId: trade.tradeId,
          entryPrice: avgNow,
          qty: filledNow,
        });
        if (pf && pf.exited) return;
        await this._placeExitsIfMissing({
          ...trade,
          entryPrice: avgNow > 0 ? avgNow : trade.entryPrice,
          qty: filledNow,
        });
        await this._ensureExitQty(trade.tradeId, filledNow);
        alert("warn", "⚠️ ENTRY partial fill (protecting filled qty)", {
          tradeId: trade.tradeId,
          filledQty: filledNow,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
        return;
      }

      if (isDead(status)) {
        this._clearEntryLimitFallbackTimer(trade.tradeId);
        if (!isCurrentEntry) {
          logger.warn(
            {
              tradeId: trade.tradeId,
              orderId,
              status,
              currentEntryOrderId,
            },
            "[order_update] dead update for non-current entry order ignored",
          );
          return;
        }
        this._handleOrderRejection({ trade, order, role: link.role });
        const isRejected = status === "REJECTED";
        this._recordTradeDecision({
          trade,
          outcome: "BLOCKED",
          stage: "entry",
          reason: isRejected ? "ENTRY_REJECTED" : `ENTRY_${status}`,
          meta: {
            source: "ORDER_UPDATE",
            msg: order.status_message_raw || order.status_message || null,
          },
        });
        await this._updateTrade(trade.tradeId, {
          status: isRejected ? STATUS.ENTRY_FAILED : STATUS.ENTRY_CANCELLED,
          closeReason:
            "ENTRY_" +
            status +
            (order.status_message_raw ? " | " + order.status_message_raw : ""),
        });
        alert(
          "error",
          isRejected ? "❌ ENTRY rejected" : "⚠️ ENTRY cancelled/lapsed",
          {
            tradeId: trade.tradeId,
            status,
            msg: order.status_message_raw || order.status_message || null,
          },
        ).catch((err) => {
          reportFault({
            code: "TRADING_TRADEMANAGER_ASYNC",
            err,
            message: "[src/trading/tradeManager.js] async task failed",
          });
        });
        if (isRejected) {
          const fail = this.risk.markFailure("ENTRY_" + status);
          if (fail.killed) {
            alert("error", "🛑 Too many failures -> kill switch", fail).catch(
              () => {},
            );
          }
        }
        await this._finalizeClosed(trade.tradeId, trade.instrument_token);
        return;
      }

      // Ignore out-of-order / stale updates after we already progressed past entry
      const freshEntryTrade = await getTrade(trade.tradeId);
      const progressedStatus = freshEntryTrade?.status || trade.status;
      if (
        [
          STATUS.ENTRY_FILLED,
          STATUS.LIVE,
          STATUS.EXITED_TARGET,
          STATUS.EXITED_SL,
          STATUS.ENTRY_FAILED,
          STATUS.ENTRY_CANCELLED,
          STATUS.GUARD_FAILED,
          STATUS.CLOSED,
        ].includes(progressedStatus)
      ) {
        logger.info(
          {
            tradeId: trade.tradeId,
            role: link.role,
            status,
            orderId,
            tradeStatus: progressedStatus,
          },
          "[order_update] ignored (stale entry update)",
        );
        return;
      }

      if (!isCurrentEntry) {
        logger.info(
          {
            tradeId: trade.tradeId,
            role: link.role,
            status,
            orderId,
            currentEntryOrderId,
          },
          "[order_update] ignored (non-current entry order)",
        );
        return;
      }

      await this._updateTrade(trade.tradeId, { status: STATUS.ENTRY_OPEN });
      return;
    }

    if (link.role === "TP1") {
      // TP1 is a partial take-profit. We must transition to runner stage safely.
      const filledNow = Number(order.filled_quantity ?? 0);
      const qtyNow = Number(order.quantity ?? trade.tp1Qty ?? trade.qty ?? 0);

      if (status === "COMPLETE") {
        return this._onTp1Filled(trade.tradeId, trade, order);
      }

      // Any partial fill is handled by: cancel remaining TP1 and immediately protect runner qty.
      if (
        (status === "PARTIAL" || status === "OPEN") &&
        filledNow > 0 &&
        qtyNow > 0
      ) {
        return this._onTp1PartialFill(trade.tradeId, trade, order);
      }

      if (isDead(status)) {
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if (
          [
            STATUS.EXITED_TARGET,
            STATUS.EXITED_SL,
            STATUS.ENTRY_FAILED,
            STATUS.ENTRY_CANCELLED,
            STATUS.CLOSED,
          ].includes(tStatus)
        ) {
          logger.info(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[order_update] ignored (trade already closed)",
          );
          return;
        }

        // TP1 dead -> disable scale-out for this trade and place normal TARGET if missing
        await this._updateTrade(trade.tradeId, {
          tp1OrderId: null,
          tp1Aborted: true,
          tp1LastStatus: status,
        });

        try {
          const fresh = (await getTrade(trade.tradeId)) || trade;
          await this._placeExitsIfMissing(fresh);
          await this._ensureExitQty(trade.tradeId, Number(fresh.qty ?? 0));
        } catch (e) {
          logger.warn(
            { tradeId: trade.tradeId, e: e.message },
            "[tp1] fallback exits failed",
          );
        }
        return;
      }

      return;
    }
    if (link.role === "TARGET") {
      try {
        await this._updateTrade(trade.tradeId, {
          targetOrderStatus: status || null,
          targetOrderStatusUpdatedAt: new Date(),
        });
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      // Partial exit fills are dangerous (remaining qty may be unprotected or double-exited).
      const filledNow = Number(order.filled_quantity ?? 0);
      const qtyNow = Number(order.quantity ?? trade.qty ?? 0);
      if (
        (status === "PARTIAL" || status === "OPEN") &&
        filledNow > 0 &&
        qtyNow > 0 &&
        filledNow < qtyNow
      ) {
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if (
          ![
            STATUS.EXITED_TARGET,
            STATUS.EXITED_SL,
            STATUS.ENTRY_FAILED,
            STATUS.ENTRY_CANCELLED,
            STATUS.CLOSED,
          ].includes(tStatus)
        ) {
          return this._guardFail(trade, "TARGET_PARTIAL_FILL");
        }
        return;
      }

      if (status === "COMPLETE") {
        // OCO race safety: if SL already filled (or trade already closed), this TARGET fill can flip position.
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if ([STATUS.EXITED_SL, STATUS.CLOSED].includes(tStatus)) {
          const closedByOrderId = String(freshTrade?.exitOrderId || "");
          if (closedByOrderId && closedByOrderId === String(orderId)) {
            logger.info(
              { tradeId: trade.tradeId, orderId, tradeStatus: tStatus },
              "[order_update] duplicate TARGET complete ignored (same exit order)",
            );
            return;
          }
          logger.error(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[oco] double-exit detected (TARGET filled after SL/close)",
          );
          await this._updateTrade(trade.tradeId, {
            ocoDoubleFillDetectedAt: new Date(),
            ocoDoubleFillRole: "TARGET",
            ocoDoubleFillTradeStatus: tStatus,
          });
          await this.setKillSwitch(true, "OCO_DOUBLE_FILL");
          await this._panicExit(freshTrade || trade, "OCO_DOUBLE_FILL_TARGET", {
            allowWhenHalted: true,
          });
          await halt("OCO_DOUBLE_FILL", {
            tradeId: trade.tradeId,
            role: "TARGET",
            orderId,
          });
          return;
        }
        // Duplicate update for already-target-exited trades -> ignore
        if (tStatus === STATUS.EXITED_TARGET) {
          logger.info(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[order_update] duplicate TARGET complete ignored",
          );
          return;
        }
        return this._onTargetFilled(trade.tradeId, trade, order);
      }

      if (isDead(status)) {
        this._handleOrderRejection({ trade, order, role: link.role });
        // If the trade is already terminal, ignore late exit-leg events (common after restart / OCO)
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if (
          [
            STATUS.EXITED_TARGET,
            STATUS.EXITED_SL,
            STATUS.ENTRY_FAILED,
            STATUS.ENTRY_CANCELLED,
            STATUS.CLOSED,
          ].includes(tStatus)
        ) {
          logger.info(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[order_update] ignored (trade already closed)",
          );
          return;
        }

        // TARGET dead -> clear and re-place (SL keeps protection)
        return this._handleDeadTarget(trade, order, "postback");
      }

      return;
    }

    if (link.role === "SL") {
      try {
        await this._updateTrade(trade.tradeId, {
          slOrderStatus: status || null,
          slOrderStatusUpdatedAt: new Date(),
        });
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      const orderType = String(order.order_type || trade.slOrderType || "")
        .toUpperCase()
        .trim();
      if (
        (status === "OPEN" || status === "TRIGGERED") &&
        (!orderType || orderType === "SL")
      ) {
        this._registerSlWatchFromTrade(trade);
        this._armSlWatchTriggered(trade.tradeId, Date.now(), "order_update");
      }

      // Partial SL fills are dangerous (can leave remainder exposed or cause over-exit).
      const filledNow = Number(order.filled_quantity ?? 0);
      const qtyNow = Number(order.quantity ?? trade.qty ?? 0);
      if (
        (status === "PARTIAL" || status === "OPEN") &&
        filledNow > 0 &&
        qtyNow > 0 &&
        filledNow < qtyNow
      ) {
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if (
          ![
            STATUS.EXITED_TARGET,
            STATUS.EXITED_SL,
            STATUS.ENTRY_FAILED,
            STATUS.ENTRY_CANCELLED,
            STATUS.CLOSED,
          ].includes(tStatus)
        ) {
          return this._guardFail(trade, "SL_PARTIAL_FILL");
        }
        return;
      }

      if (status === "COMPLETE") {
        // OCO race safety: if TARGET already filled (or trade already closed), this SL fill can flip position.
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if ([STATUS.EXITED_TARGET, STATUS.CLOSED].includes(tStatus)) {
          const closedByOrderId = String(freshTrade?.exitOrderId || "");
          if (closedByOrderId && closedByOrderId === String(orderId)) {
            logger.info(
              { tradeId: trade.tradeId, orderId, tradeStatus: tStatus },
              "[order_update] duplicate SL complete ignored (same exit order)",
            );
            return;
          }
          logger.error(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[oco] double-exit detected (SL filled after TARGET/close)",
          );
          await this._updateTrade(trade.tradeId, {
            ocoDoubleFillDetectedAt: new Date(),
            ocoDoubleFillRole: "SL",
            ocoDoubleFillTradeStatus: tStatus,
          });
          await this.setKillSwitch(true, "OCO_DOUBLE_FILL");
          await this._panicExit(freshTrade || trade, "OCO_DOUBLE_FILL_SL", {
            allowWhenHalted: true,
          });
          await halt("OCO_DOUBLE_FILL", {
            tradeId: trade.tradeId,
            role: "SL",
            orderId,
          });
          return;
        }
        // Duplicate update for already-sl-exited trades -> ignore
        if (tStatus === STATUS.EXITED_SL) {
          logger.info(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[order_update] duplicate SL complete ignored",
          );
          return;
        }
        await this._updateTrade(trade.tradeId, { slState: STATUS.SL_CONFIRMED });
        return this._onSlFilled(trade.tradeId, trade, order);
      }

      if (isDead(status)) {
        this._handleOrderRejection({ trade, order, role: link.role });
        // If the trade is already terminal, ignore late exit-leg events (common after restart / OCO)
        const freshTrade = await getTrade(trade.tradeId);
        const tStatus = freshTrade?.status || trade.status;
        if (
          [
            STATUS.EXITED_TARGET,
            STATUS.EXITED_SL,
            STATUS.ENTRY_FAILED,
            STATUS.ENTRY_CANCELLED,
            STATUS.CLOSED,
          ].includes(tStatus)
        ) {
          logger.info(
            {
              tradeId: trade.tradeId,
              role: link.role,
              status,
              orderId,
              tradeStatus: tStatus,
            },
            "[order_update] ignored (trade already closed)",
          );
          return;
        }

        // SL dead => kill switch + panic exit
        return this._guardFail(trade, "SL_" + status);
      }

        return;
      }
      },
      {
        seedTrade: linkedTrade,
        allowMissing: true,
      },
    );
  }

  async _handleDeadTarget(trade, targetOrder, source) {
    return this._runTradeCommand(
      trade?.tradeId,
      EXEC_COMMAND.HANDLE_TARGET_QTY_RECOVERY,
      async () => this._handleDeadTargetImpl(trade, targetOrder, source),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _handleDeadTargetImpl(trade, targetOrder, source) {
    const tradeId = trade.tradeId;
    this._clearTargetWatch(tradeId);
    const scaleOutEnabled = this._scaleOutEligible(trade);
    const keepTp2Resting =
      scaleOutEnabled &&
      trade.tp1Done &&
      String(env.RUNNER_KEEP_TP2_RESTING) === "true";
    if (
      scaleOutEnabled &&
      String(env.DYNAMIC_EXITS_AFTER_TP1_ONLY) === "true" &&
      !trade.tp1Done
    )
      return;
    const fresh = (await getTrade(tradeId)) || trade;

    const rejectMsg =
      targetOrder?.status_message_raw ||
      targetOrder?.status_message ||
      targetOrder?.message ||
      "";
    if (this._shouldFallbackToVirtualTarget(rejectMsg)) {
      await this._enableVirtualTarget(fresh, {
        reason: rejectMsg,
        source: source || "dead_target",
      });
      return;
    }

    // Don't replace if already closed/failed
    if (
      [
        STATUS.EXITED_TARGET,
        STATUS.EXITED_SL,
        STATUS.ENTRY_FAILED,
        STATUS.ENTRY_CANCELLED,
        STATUS.GUARD_FAILED,
        STATUS.CLOSED,
      ].includes(fresh.status)
    )
      return;

    const count = Number(fresh.targetReplaceCount ?? 0);
    const max = Number(env.TARGET_REPLACE_MAX ?? 2);
    if (count >= max) {
      logger.error(
        { tradeId, count, max, source },
        "[target] replace limit reached; keeping SL only",
      );
      await this._updateTrade(tradeId, {
        targetOrderId: null,
        closeReason: `TARGET_DEAD_REPLACE_LIMIT_REACHED | last=${String(
          targetOrder?.status || "",
        ).toUpperCase()}`,
        targetReplaceCount: count,
      });
      return;
    }

    logger.warn(
      {
        tradeId,
        source,
        status: String(targetOrder?.status || "").toUpperCase(),
      },
      "[target] dead -> replacing",
    );

    // Clear targetOrderId first to avoid other logic treating it as active
    await this._updateTrade(tradeId, {
      targetOrderId: null,
      targetReplaceCount: count + 1,
    });

    // Place a new target order
    try {
      await this._placeTargetOnly({
        ...fresh,
        targetOrderId: null,
        targetReplaceCount: count + 1,
      });
    } catch (e) {
      logger.warn(
        { tradeId, e: e.message },
        "[target] replace failed; SL remains active",
      );
      await this._updateTrade(tradeId, {
        closeReason: `TARGET_REPLACE_FAILED | ${e.message}`,
      });
    }
  }

  _getKnownOrderQuantity(orderId) {
    const oid = String(orderId || "");
    if (!oid) return null;
    const order = this._lastOrdersById.get(oid) || null;
    const qty = Number(order?.quantity ?? NaN);
    return Number.isFinite(qty) && qty > 0 ? qty : null;
  }

  _shouldSkipExitQtySync(orderId, qty) {
    const oid = String(orderId || "");
    if (!oid || !(qty > 0)) return true;
    const currentKnownQty = this._getKnownOrderQuantity(oid);
    if (Number.isFinite(currentKnownQty) && currentKnownQty === qty) {
      return true;
    }
    const lastSynced = this._exitQtyLastSyncedByOrderId.get(oid);
    return Number(lastSynced?.qty ?? NaN) === qty;
  }

  _markExitQtySynced(orderId, qty) {
    const oid = String(orderId || "");
    if (!oid || !(qty > 0)) return;
    this._exitQtyLastSyncedByOrderId.set(oid, {
      qty,
      syncedAt: Date.now(),
    });
  }

  async _ensureExitQty(tradeId, desiredQty) {
    return this._runTradeCommand(
      tradeId,
      EXEC_COMMAND.HANDLE_TARGET_QTY_RECOVERY,
      async () => this._ensureExitQtyImpl(tradeId, desiredQty),
      { allowMissing: true },
    );
  }

  async _ensureExitQtyImpl(tradeId, desiredQty) {
    const fresh = await getTrade(tradeId);
    if (!fresh) return;
    const qty = Number(desiredQty ?? fresh.qty ?? 0);
    if (qty < 1) return;

    // Adjust SL qty (safety critical)
    if (fresh.slOrderId && typeof this.kite.modifyOrder === "function") {
      if (!this._shouldSkipExitQtySync(fresh.slOrderId, qty)) {
        try {
          const slModify = await this._safeModifyOrder(
          env.DEFAULT_ORDER_VARIETY,
          fresh.slOrderId,
          { quantity: qty },
          { purpose: "SL_QTY_MODIFY", tradeId },
        );
          const slSkipped = Boolean(slModify?.skipped);
          this._markExitQtySynced(fresh.slOrderId, qty);
          logger.info(
            {
              tradeId,
              slOrderId: fresh.slOrderId,
              qty,
              result: slSkipped
                ? String(slModify?.reason || "skipped")
                : "modified",
            },
            slSkipped ? "[trade] SL qty sync skipped" : "[trade] SL qty modified",
          );
      } catch (e) {
        logger.error(
          { tradeId, e: e.message },
          "[trade] SL qty modify failed -> panic exit",
        );
        alert("error", "🛑 SL qty modify failed -> PANIC EXIT", {
          tradeId,
          message: e.message,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
        this.risk.setKillSwitch(true);
        await upsertDailyRisk(todayKey(), {
          kill: true,
          reason: "SL_QTY_MODIFY_FAILED",
          lastTradeId: tradeId,
        });
        await this._panicExit(fresh, "SL_QTY_MODIFY_FAILED");
        return;
      }
      }
    }

    // Adjust TARGET qty (nice-to-have)
    if (fresh.targetOrderId && typeof this.kite.modifyOrder === "function") {
      if (!this._shouldSkipExitQtySync(fresh.targetOrderId, qty)) {
        try {
        await this._safeModifyOrder(
          env.DEFAULT_ORDER_VARIETY,
          fresh.targetOrderId,
          { quantity: qty },
          { purpose: "TARGET_QTY_MODIFY", tradeId },
        );
        this._markExitQtySynced(fresh.targetOrderId, qty);
        logger.info(
          { tradeId, targetOrderId: fresh.targetOrderId, qty },
          "[trade] TARGET qty modified",
        );
      } catch (e) {
        const containment = await this._containTargetQtySyncFailure({
          tradeId,
          trade: fresh,
          desiredQty: qty,
          error: e,
        });
        logger.warn(
          {
            tradeId,
            e: e.message,
            containmentMode: containment?.mode ?? null,
            contained: Boolean(containment?.contained),
          },
          containment?.contained
            ? "[trade] TARGET qty modify failed; fallback contained target leg"
            : "[trade] TARGET qty modify failed; broker target remains unconfirmed",
        );
        alert("warn", "⚠️ TARGET qty modify failed", {
          tradeId,
          message: e.message,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      }
      }
    }
  }

  async _containTargetQtySyncFailure({ tradeId, trade, desiredQty, error }) {
    const msg = String(error?.message || error || "");
    const qty = Math.max(0, Number(desiredQty ?? trade?.qty ?? 0));
    const targetOrderId = trade?.targetOrderId ? String(trade.targetOrderId) : null;
    const now = new Date();
    let brokerTargetCleared = !targetOrderId;

    if (targetOrderId) {
      try {
        this.expectedCancelOrderIds.add(String(targetOrderId));
        await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, targetOrderId, {
          purpose: "TARGET_QTY_SYNC_CANCEL_REPLACE",
          tradeId,
        });
      } catch (cancelErr) {
        logger.warn(
          {
            tradeId,
            targetOrderId,
            e: cancelErr?.message || String(cancelErr),
          },
          "[trade] TARGET qty sync cancel failed",
        );
      }

      try {
        const after = await this._getOrderStatus(targetOrderId);
        const afterStatus = String(after?.status || "").toUpperCase();
        if (afterStatus === "COMPLETE") {
          await this._updateTrade(tradeId, {
            targetQtySyncStatus: "TARGET_ALREADY_FILLED",
            targetQtySyncFallbackMode: "TARGET_ALREADY_FILLED",
            targetQtySyncFailedAt: now,
            targetQtySyncDesiredQty: qty,
          });
          return { contained: true, mode: "TARGET_ALREADY_FILLED" };
        }
        brokerTargetCleared =
          !afterStatus ||
          ["CANCELLED", "CANCELED", "REJECTED", "LAPSED"].includes(afterStatus);
      } catch (statusErr) {
        logger.warn(
          {
            tradeId,
            targetOrderId,
            e: statusErr?.message || String(statusErr),
          },
          "[trade] TARGET qty sync post-cancel status check failed",
        );
      }
    }

    if (!brokerTargetCleared) {
      await this._updateTrade(tradeId, {
        targetQtySyncStatus: "BROKER_TARGET_UNCONFIRMED",
        targetQtySyncFallbackMode: "BROKER_TARGET_STILL_OPEN",
        targetQtySyncFailedAt: now,
        targetQtySyncDesiredQty: qty,
        targetQtySyncError: msg,
      });
      return { contained: false, mode: "BROKER_TARGET_STILL_OPEN" };
    }

    await this._updateTrade(tradeId, {
      targetOrderId: null,
      targetOrderType: null,
      targetQtySyncStatus: "BROKER_TARGET_CLEARED",
      targetQtySyncFallbackMode: "CANCEL_REPLACE",
      targetQtySyncFailedAt: now,
      targetQtySyncDesiredQty: qty,
      targetQtySyncError: msg,
    });
    this._clearTargetWatch(tradeId);

    const fresh = (await getTrade(tradeId)) || {
      ...trade,
      qty,
      targetOrderId: null,
      targetOrderType: null,
    };
    const replacementTrade = {
      ...fresh,
      qty,
      runnerQty: trade?.tp1Done ? qty : fresh?.runnerQty,
      targetOrderId: null,
      targetOrderType: null,
    };

    try {
      if (
        replacementTrade?.targetVirtual ||
        this._isOptTargetModeVirtual(replacementTrade)
      ) {
        throw new Error("USE_VIRTUAL_TARGET");
      }
      if (trade?.tp1Done) {
        await this._placeRunnerTargetOnly(replacementTrade);
      } else {
        await this._placeTargetOnly(replacementTrade);
      }
      await this._updateTrade(tradeId, {
        targetQtySyncStatus: "CANCEL_REPLACED",
        targetQtySyncFallbackMode: "BROKER_TARGET_REPLACED",
        targetQtySyncFailedAt: now,
        targetQtySyncDesiredQty: qty,
      });
      return { contained: true, mode: "BROKER_TARGET_REPLACED" };
    } catch (replaceErr) {
      try {
        await this._enableVirtualTarget(replacementTrade, {
          reason: "TARGET_QTY_SYNC_FAILED",
          source: "qty_sync_failure",
        });
        await this._updateTrade(tradeId, {
          targetOrderId: null,
          targetOrderType: null,
          targetQtySyncStatus: "VIRTUALIZED",
          targetQtySyncFallbackMode: "VIRTUAL_TARGET",
          targetQtySyncFailedAt: now,
          targetQtySyncDesiredQty: qty,
          targetQtySyncError:
            `${msg} | ${String(replaceErr?.message || replaceErr)}`,
        });
        return { contained: true, mode: "VIRTUAL_TARGET" };
      } catch (virtualErr) {
        await this._updateTrade(tradeId, {
          targetQtySyncStatus: "VIRTUAL_TARGET_FAILED",
          targetQtySyncFallbackMode: "UNCONTAINED",
          targetQtySyncFailedAt: now,
          targetQtySyncDesiredQty: qty,
          targetQtySyncError:
            `${msg} | ${String(replaceErr?.message || replaceErr)} | ${String(
              virtualErr?.message || virtualErr,
            )}`,
        });
        return { contained: false, mode: "UNCONTAINED" };
      }
    }
  }

  async _postFillRiskRecheckAndAdjust({ tradeId, entryPrice, qty }) {
    try {
      if (!env.POST_FILL_RISK_RECHECK_ENABLED)
        return { ok: true, skipped: true };

      const t = await getTrade(tradeId);
      if (!t) return { ok: true, skipped: true };

      const entry = Number(entryPrice ?? t.entryPrice ?? 0);
      const q = Number(qty ?? t.qty ?? 0);
      const strategyStopLoss = this._strategyStopLossFromTrade(t);
      const sizingStopLoss = this._sizingStopLossFromTrade(t);
      const brokerStopLoss =
        this._brokerStopLossFromTrade(t) ?? strategyStopLoss;

      if (!(entry > 0) || !(strategyStopLoss > 0) || !(q > 0)) {
        return { ok: true, skipped: true };
      }

      const capBase = this._riskBudgetInr(t);
      const eps = Math.max(0, Number(env.POST_FILL_RISK_EPS_PCT ?? 0));
      const capInr = capBase * (1 + eps);
      const actualRisk = this._computeActualRiskFromStrategyStop({
        entryPrice: entry,
        strategyStopLoss,
        qty: q,
        side: t.side,
      });
      const trueRiskInr = Number(actualRisk?.riskInr ?? NaN);
      const breach = this._classifyPostFillRiskBreach({
        trueRiskInr,
        capInr,
      });
      const softAction = String(
        env.POST_FILL_RISK_SOFT_ACTION || "TAG_ONLY",
      ).toUpperCase();
      const hardAction = String(
        env.POST_FILL_RISK_HARD_ACTION ||
          env.POST_FILL_RISK_FAIL_ACTION ||
          "EXIT",
      ).toUpperCase();
      const tickSize = Number(t.instrument?.tick_size ?? 0.05);
      const lotSize = Math.max(1, Number(t.instrument?.lot_size ?? 1));
      const reduceFit = this._evaluateMinTradableRiskFit({
        entryPrice: entry,
        strategyStopLoss,
        side: t.side,
        lotSize,
        riskBudgetInr: capBase,
        expectedSlippagePts: Number(
          env.EXPECTED_SLIPPAGE_POINTS ??
            env.POST_FILL_EXPECTED_SLIPPAGE_POINTS ??
            0,
        ),
        feePerLotInr: Number(env.EXPECTED_FEES_PER_LOT_INR ?? 0),
        tickSize,
      });
      const reduceTargetQty = Number(reduceFit?.maxQtyByRisk ?? 0);

      if (
        !Number.isFinite(trueRiskInr) ||
        !Number.isFinite(capInr) ||
        capInr <= 0
      ) {
        return { ok: true, skipped: true };
      }

      await this._updateTrade(
        tradeId,
        this._buildStopSemanticsPatch({
          strategyStopLoss,
          sizingStopLoss,
          brokerStopLoss,
          patch: {
            riskBreachState: breach.state,
            postFillTrueRiskInr: trueRiskInr,
            postFillRiskCapInr: capInr,
            postFillRiskAction:
              breach.state === "NONE"
                ? "NONE"
                : breach.state === "SOFT"
                  ? softAction
                  : hardAction,
            actualRiskPts: actualRisk.riskPts,
            actualRiskInr: trueRiskInr,
            postFillRisk: {
              ok: breach.state !== "HARD",
              refit: false,
              entryPrice: entry,
              strategyStopLoss,
              brokerStopLoss,
              qty: q,
              trueRiskInr,
              capInr,
              breachState: breach.state,
              breachInr: breach.breachInr,
              breachPct: breach.breachPct,
              softLimitInr: breach.softLimitInr,
              hardLimitInr: breach.hardLimitInr,
              reduceTargetQty:
                reduceTargetQty >= lotSize && reduceTargetQty < q
                  ? reduceTargetQty
                  : null,
              ts: new Date().toISOString(),
            },
          },
        }),
      );

      if (breach.state === "NONE") {
        return { ok: true, refit: false };
      }

      if (breach.state === "SOFT") {
        logger.warn(
          {
            tradeId,
            strategyStopLoss,
            trueRiskInr,
            capInr,
            breachInr: breach.breachInr,
            breachPct: breach.breachPct,
            action: softAction,
          },
          "[postFillRisk] soft breach tagged; strategy stop preserved",
        );
        return { ok: true, breach: "SOFT", action: softAction };
      }

      logger.error(
        {
          tradeId,
          strategyStopLoss,
          trueRiskInr,
          capInr,
          breachInr: breach.breachInr,
          breachPct: breach.breachPct,
          reduceTargetQty:
            reduceTargetQty >= lotSize && reduceTargetQty < q
              ? reduceTargetQty
              : null,
          hardAction,
        },
        "[postFillRisk] hard breach detected; strategy stop preserved",
      );

      const canReduce =
        Boolean(env.POST_FILL_RISK_REDUCE_IF_POSSIBLE) &&
        reduceTargetQty >= lotSize &&
        reduceTargetQty < q;

      if (canReduce) {
        const reduced = await this._reducePositionToTargetQty({
          trade: t,
          entryPrice: entry,
          targetQty: reduceTargetQty,
          reason: "POST_FILL_RISK_HARD_REDUCE",
        });
        if (reduced?.reduced) {
          return this._postFillRiskRecheckAndAdjust({
            tradeId,
            entryPrice: entry,
            qty: reduced.newQty,
          });
        }
      }

      if (hardAction === "EXIT" || hardAction === "REDUCE") {
        alert("error", "🛑 Post-fill risk hard breach; panic exit", {
          tradeId,
          entryPrice: entry,
          strategyStopLoss,
          qty: q,
          trueRiskInr,
          capInr,
          hardAction,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );

        const fresh = (await getTrade(tradeId)) || t;
        await this._panicExit(
          { ...fresh, entryPrice: entry, qty: q },
          "POST_FILL_RISK_HARD_BREACH",
        );
        await this._updateTrade(tradeId, {
          status: STATUS.GUARD_FAILED,
          closeReason: `POST_FILL_RISK_HARD_BREACH (${trueRiskInr.toFixed(0)}>${capInr.toFixed(0)})`,
        });
        return {
          ok: false,
          exited: true,
          reason: "POST_FILL_RISK_HARD_BREACH",
        };
      }

      return { ok: false, exited: false, reason: "POST_FILL_RISK_HARD_BREACH" };
    } catch (e) {
      logger.warn(
        { tradeId, e: e.message },
        "[postFillRisk] recheck failed (continuing)",
      );
      return { ok: true, skipped: true, error: e.message };
    }
  }

  async _reducePositionToTargetQty({ trade, entryPrice, targetQty, reason }) {
    const tradeId = trade?.tradeId;
    if (!tradeId) return { ok: false, skipped: true, reason: "NO_TRADE_ID" };

    const fresh = (await getTrade(tradeId)) || trade;
    const currentQty = Number(fresh.qty ?? trade.qty ?? 0);
    const desiredQty = this._normalizeQtyToLot(targetQty, fresh.instrument);
    const reduceQty = Math.max(0, currentQty - desiredQty);
    if (!(currentQty > 0) || !(desiredQty >= 0) || !(reduceQty > 0)) {
      return { ok: false, skipped: true, reason: "NO_REDUCTION_NEEDED" };
    }

    const exitSide =
      String(fresh.side || "").toUpperCase() === "BUY" ? "SELL" : "BUY";
    const params = {
      exchange: fresh.instrument.exchange,
      tradingsymbol: fresh.instrument.tradingsymbol,
      transaction_type: exitSide,
      quantity: reduceQty,
      product: this._activeTradeProduct(fresh),
      order_type: "MARKET",
      validity: "DAY",
      tag: makeTag(tradeId, "REDUCE"),
    };

    logger.warn(
      { tradeId, currentQty, desiredQty, reduceQty, reason },
      "[postFillRisk] reducing filled position to fit risk cap",
    );

    const out = await this._safePlaceOrder(env.DEFAULT_ORDER_VARIETY, params, {
      purpose: "POST_FILL_RISK_REDUCE",
      tradeId,
    });
    const reduceOrderId = out.orderId;
    await linkOrder({
      order_id: String(reduceOrderId),
      tradeId,
      role: "RISK_REDUCE",
    });
    await this._replayOrphanUpdates(reduceOrderId);

    let latest = null;
    const attempts = Math.max(
      2,
      Number(env.POST_FILL_RISK_REDUCE_POLL_ATTEMPTS ?? 4),
    );
    const delayMs = Math.max(
      100,
      Number(env.POST_FILL_RISK_REDUCE_POLL_MS ?? 350),
    );
    for (let i = 0; i < attempts; i += 1) {
      latest = await this._getOrderStatus(reduceOrderId);
      const st = String(latest?.status || "").toUpperCase();
      if (
        st === "COMPLETE" ||
        st === "REJECTED" ||
        st === "CANCELLED" ||
        st === "CANCELED"
      ) {
        break;
      }
      if (i < attempts - 1) await sleep(delayMs);
    }

    const status = String(latest?.status || "").toUpperCase();
    if (status !== "COMPLETE") {
      logger.error(
        { tradeId, reduceOrderId, status, reason },
        "[postFillRisk] reduction order did not complete",
      );
      return {
        ok: false,
        reduced: false,
        reason: status || "REDUCE_NOT_FILLED",
      };
    }

    const reducedQtyFilled = Number(
      latest?.order?.filled_quantity ?? reduceQty,
    );
    const avgExitPrice = Number(
      latest?.order?.average_price ?? latest?.order?.price ?? 0,
    );
    const newQty = Math.max(0, currentQty - reducedQtyFilled);

    await this._bookPartialPnlLeg({
      tradeId,
      side: fresh.side,
      entryPrice: entryPrice ?? fresh.entryPrice,
      exitPrice: avgExitPrice,
      qty: reducedQtyFilled,
      label: "POST_FILL_RISK_REDUCE",
    });

    await this._updateTrade(tradeId, {
      qty: newQty,
      ...buildExecutionRiskPatch({
        trade: fresh,
        qty: newQty,
        entryPrice: entryPrice ?? fresh.entryPrice,
        stopLoss: this._strategyStopLossFromTrade(fresh),
      }),
      postFillRiskAction: "REDUCE",
      riskBreachState: newQty > 0 ? "SOFT" : "NONE",
      postFillReduceOrderId: reduceOrderId,
      postFillReducedQty: reducedQtyFilled,
      postFillReducedAt: new Date(),
      entryFinalized: true,
    });

    if (newQty < 1) {
      await this._updateTrade(tradeId, {
        status: STATUS.CLOSED,
        exitReason: "POST_FILL_RISK_REDUCE_FULL",
        closeReason: "POST_FILL_RISK_REDUCE_FULL",
        exitFamily: "LOSS_CONTAINMENT",
        exitReasonCode: "POST_FILL_RISK_REDUCE_FULL",
        exitAuthority: "POST_FILL_RISK_ENGINE",
        exitAt: new Date(),
        closedAt: new Date(),
      });
      await this._finalizeClosed(tradeId, fresh.instrument_token);
    }

    return {
      ok: true,
      reduced: true,
      newQty,
      orderId: reduceOrderId,
      avgExitPrice,
    };
  }

  async _recalcTargetFromActualFill({ tradeId, entryPrice }) {
    try {
      if (String(env.OPT_TP_ENABLED || "false") !== "true") {
        return { ok: true, skipped: true };
      }
      const t = await getTrade(tradeId);
      if (!t) return { ok: true, skipped: true };

      const entry = Number(entryPrice ?? t.entryPrice ?? 0);
      const sl = Number(this._strategyStopLossFromTrade(t));
      if (!(entry > 0) || !(sl > 0)) return { ok: true, skipped: true };

      const rr = Number(t.rr ?? env.RR_TARGET ?? 1.0);
      const tickSize = Number(t.instrument?.tick_size ?? 0.05);
      const newTarget = computeTargetFromRR({
        side: t.side,
        entry,
        stopLoss: sl,
        rr,
        tickSize,
      });

      if (!Number.isFinite(newTarget) || newTarget <= 0) {
        return { ok: true, skipped: true };
      }

      await this._updateTrade(tradeId, {
        plannedTargetPrice: newTarget,
        ...(t.targetOrderId ? { targetPrice: newTarget } : {}),
      });

      if (
        t.targetOrderId &&
        String(t.targetOrderType || "").toUpperCase() === "LIMIT" &&
        typeof this.kite.modifyOrder === "function"
      ) {
        try {
          await this._safeModifyOrder(
            env.DEFAULT_ORDER_VARIETY,
            t.targetOrderId,
            { price: newTarget },
            { purpose: "TARGET_PRICE_MODIFY_POST_FILL", tradeId },
          );
          logger.info(
            { tradeId, targetOrderId: t.targetOrderId, targetPrice: newTarget },
            "[trade] TARGET price adjusted post-fill",
          );
        } catch (e) {
          logger.warn(
            { tradeId, e: e.message },
            "[trade] TARGET price modify failed post-fill (continuing)",
          );
          alert("warn", "⚠️ TARGET price modify failed post-fill", {
            tradeId,
            message: e.message,
          }).catch((err) =>
            reportWindowedFault({
              code: "ALERT_SEND_FAILED",
              windowKey: "alert_send_failed",
              err,
              message: "[alert] failed to dispatch notification",
              meta: { context: "trade_manager" },
            }),
          );
        }
      }

      return { ok: true, targetPrice: newTarget };
    } catch (e) {
      logger.warn(
        { tradeId, e: e.message },
        "[trade] post-fill target recalc failed (continuing)",
      );
      return { ok: true, skipped: true, error: e.message };
    }
  }

  _computeTargetPrice(trade) {
    if (Number.isFinite(Number(trade?.plannedTargetPrice))) {
      return Number(trade.plannedTargetPrice);
    }

    const rr = Number(trade.rr ?? 1.0);
    const entryPx = Number(trade.entryPrice ?? trade.candle?.close);
    const baseSL = Number(this._strategyStopLossFromTrade(trade));
    const riskPerShare = Math.abs(entryPx - baseSL);
    const targetPx =
      trade.side === "BUY"
        ? entryPx + rr * riskPerShare
        : entryPx - rr * riskPerShare;

    const tick = Number(trade.instrument.tick_size ?? 0.05);
    return roundToTick(targetPx, tick, trade.side === "BUY" ? "up" : "down");
  }

  async _placeTargetOnly(trade) {
    const tradeId = trade.tradeId;

    const entryPx = Number(trade.entryPrice ?? trade.candle?.close);
    if (!Number.isFinite(entryPx) || entryPx <= 0)
      throw new Error("missing_entry_price");

    const targetPrice = this._computeTargetPrice(trade);
    const tgtSide = trade.side === "BUY" ? "SELL" : "BUY";

    const token = Number(trade.instrument_token);
    const ltp = await this._getLtp(token, trade.instrument);

    const alreadyCrossed =
      Number.isFinite(ltp) &&
      ((tgtSide === "BUY" && Number(ltp) <= Number(targetPrice)) ||
        (tgtSide === "SELL" && Number(ltp) >= Number(targetPrice)));

    const targetParams = {
      exchange: trade.instrument.exchange,
      tradingsymbol: trade.instrument.tradingsymbol,
      transaction_type: tgtSide,
      quantity: trade.qty,
      product: env.DEFAULT_PRODUCT,
      order_type: alreadyCrossed ? "MARKET" : "LIMIT",
      ...(alreadyCrossed ? {} : { price: targetPrice }),
      validity: "DAY",
      tag: makeTag(tradeId, "TARGET"),
    };

    logger.info({ tradeId, targetParams }, "[trade] placing TARGET");
    alert("info", "🎯 TARGET placing", {
      tradeId,
      targetPrice,
      qty: trade.qty,
      order_type: targetParams.order_type,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    if (isHalted()) {
      logger.warn("[trade] TARGET skipped (halted)");
      return;
    }

    const { orderId: targetOrderId } = await this._safePlaceOrder(
      env.DEFAULT_ORDER_VARIETY,
      targetParams,
      { purpose: "TARGET", tradeId },
    );

    const fresh = await getTrade(tradeId);
    const shouldMarkLive = [STATUS.ENTRY_FILLED, STATUS.LIVE].includes(
      fresh?.status,
    );
    const patch = {
      targetOrderId,
      targetPrice,
      targetOrderType: targetParams.order_type,
      targetVirtual: false,
      targetPlacedAt: new Date(),
      exitPlacedAt: new Date(),
      status: STATUS.LIVE,
    };
    if (!shouldMarkLive) {
      delete patch.status;
    }
    await this._updateTrade(tradeId, patch);
    this._clearVirtualTarget(tradeId);
    this._registerTargetWatchFromTrade({
      ...trade,
      targetOrderId,
      targetPrice,
      targetOrderType: targetParams.order_type,
    });
    await linkOrder({
      order_id: String(targetOrderId),
      tradeId,
      role: "TARGET",
    });
    await this._replayOrphanUpdates(targetOrderId);

    this._watchExitLeg(tradeId, targetOrderId, "TARGET").catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
  }
  _scaleOutEligible(trade) {
    const enabled = String(env.SCALE_OUT_ENABLED) === "true";
    const initQty = Number(trade?.initialQty ?? trade?.qty ?? 0);
    return enabled && initQty >= 2 && !trade?.tp1Aborted;
  }

  _computeTp1Qty(totalQty, lotSize = 1) {
    const total = Number(totalQty);
    if (!Number.isFinite(total) || total < 2) return null;

    const pct = Number(env.TP1_QTY_PCT ?? 50);
    const raw = Math.floor((total * pct) / 100);
    const lot = Math.max(1, Number(lotSize) || 1);

    if (lot <= 1) {
      const tp1Qty = Math.max(1, Math.min(raw, total - 1));
      const runnerQty = total - tp1Qty;
      if (runnerQty < 1) return null;
      return { tp1Qty, runnerQty, pct };
    }

    if (total % lot !== 0) return null;

    let tp1Qty = Math.floor(raw / lot) * lot;
    let runnerQty = total - tp1Qty;

    while (tp1Qty > 0 && runnerQty % lot !== 0) {
      tp1Qty -= lot;
      runnerQty = total - tp1Qty;
    }

    if (tp1Qty <= 0 || runnerQty <= 0) return null;
    if (tp1Qty % lot !== 0 || runnerQty % lot !== 0) return null;

    return { tp1Qty, runnerQty, pct };
  }

  _computeTp1Price(trade) {
    const entry = Number(trade?.entryPrice ?? 0);
    const sl = Number(this._strategyStopLossFromTrade(trade));
    const risk = Math.abs(entry - sl);
    const mult = Number(env.TP1_R ?? 1);
    const tick = Number(trade?.instrument?.tick_size ?? 0.05);

    if (!Number.isFinite(entry) || !Number.isFinite(sl) || !(risk > 0))
      return null;

    const raw =
      trade.side === "BUY" ? entry + mult * risk : entry - mult * risk;
    return roundToTick(raw, tick, trade.side === "BUY" ? "up" : "down");
  }

  async _placeTp1Only(trade) {
    const tradeId = trade.tradeId;
    const initQty = Number(trade.initialQty ?? trade.qty ?? 0);
    const sizing = this._computeTp1Qty(
      initQty,
      Number(trade?.instrument?.lot_size ?? 1),
    );
    if (!sizing) throw new Error("SCALE_OUT_NOT_ELIGIBLE");

    const tp1Price = this._computeTp1Price(trade);
    if (!tp1Price || tp1Price <= 0) throw new Error("TP1_PRICE_INVALID");

    const exitSide = trade.side === "BUY" ? "SELL" : "BUY";
    const tokenNow = Number(trade.instrument_token);
    const ltpNow = await this._getLtp(tokenNow, trade.instrument);

    const crossed =
      Number.isFinite(ltpNow) &&
      ((exitSide === "SELL" && Number(ltpNow) >= tp1Price) ||
        (exitSide === "BUY" && Number(ltpNow) <= tp1Price));

    const params = {
      exchange: trade.instrument.exchange,
      tradingsymbol: trade.instrument.tradingsymbol,
      transaction_type: exitSide,
      quantity: sizing.tp1Qty,
      product: env.DEFAULT_PRODUCT,
      order_type: crossed ? "MARKET" : "LIMIT",
      ...(crossed ? {} : { price: tp1Price }),
      validity: "DAY",
      tag: makeTag(tradeId, "TP1"),
    };

    logger.info(
      {
        tradeId,
        tp1Price,
        qty: sizing.tp1Qty,
        runnerQty: sizing.runnerQty,
        crossed,
      },
      "[trade] placing TP1",
    );
    alert("info", "🎯 TP1 placing", {
      tradeId,
      tp1Price,
      tp1Qty: sizing.tp1Qty,
      runnerQty: sizing.runnerQty,
      tp1R: Number(env.TP1_R ?? 1),
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    if (isHalted()) {
      logger.warn("[trade] TP1 skipped (halted)");
      return;
    }

    const { orderId: tp1OrderId } = await this._safePlaceOrder(
      env.DEFAULT_ORDER_VARIETY,
      params,
      { purpose: "TP1", tradeId },
    );

    await this._updateTrade(tradeId, {
      tp1OrderId,
      tp1Price,
      tp1Qty: sizing.tp1Qty,
      runnerQty: sizing.runnerQty,
      tp1Done: false,
      tp1PlacedAt: new Date(),
      exitPlacedAt: new Date(),
      initialQty: initQty,
    });
    await linkOrder({ order_id: String(tp1OrderId), tradeId, role: "TP1" });
    await this._replayOrphanUpdates(tp1OrderId);

    this._watchExitLeg(tradeId, tp1OrderId, "TP1").catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
  }

  async _placeRunnerTargetOnly(trade) {
    const tradeId = trade.tradeId;
    const token = Number(trade.instrument_token);
    const intervalMin = Number(
      trade.intervalMin ?? trade.candle?.interval_min ?? 1,
    );

    let candles = [];
    try {
      candles = await getRecentCandles(token, intervalMin, 600);
    } catch {
      candles = [];
    }

    const plan = planRunnerTarget({ trade, candles });
    if (!plan?.price || plan.price <= 0)
      throw new Error("RUNNER_TARGET_PLAN_FAILED");

    const targetPrice = plan.price;
    const exitSide = trade.side === "BUY" ? "SELL" : "BUY";

    const ltpNow = await this._getLtp(token, trade.instrument);
    const crossed =
      Number.isFinite(ltpNow) &&
      ((exitSide === "SELL" && Number(ltpNow) >= targetPrice) ||
        (exitSide === "BUY" && Number(ltpNow) <= targetPrice));

    const params = {
      exchange: trade.instrument.exchange,
      tradingsymbol: trade.instrument.tradingsymbol,
      transaction_type: exitSide,
      quantity: trade.qty,
      product: env.DEFAULT_PRODUCT,
      order_type: crossed ? "MARKET" : "LIMIT",
      ...(crossed ? {} : { price: targetPrice }),
      validity: "DAY",
      tag: makeTag(tradeId, "TP2"),
    };

    logger.info(
      {
        tradeId,
        targetPrice,
        qty: trade.qty,
        mode: plan.mode,
        crossed,
        meta: plan.meta,
      },
      "[trade] placing RUNNER TARGET",
    );
    alert("info", "🏁 Runner target placing", {
      tradeId,
      targetPrice,
      qty: trade.qty,
      mode: plan.mode,
      meta: plan.meta,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });

    if (isHalted()) {
      logger.warn("[trade] RUNNER TARGET skipped (halted)");
      return;
    }

    const { orderId: targetOrderId } = await this._safePlaceOrder(
      env.DEFAULT_ORDER_VARIETY,
      params,
      { purpose: "TARGET", tradeId },
    );

    const fresh = await getTrade(tradeId);
    const shouldMarkLive = [STATUS.ENTRY_FILLED, STATUS.LIVE].includes(
      fresh?.status,
    );
    const patch = {
      targetOrderId,
      targetPrice,
      targetOrderType: params.order_type,
      runnerTargetMode: plan.mode,
      runnerTargetMeta: plan.meta,
      targetVirtual: false,
      targetPlacedAt: new Date(),
      exitPlacedAt: new Date(),
      status: STATUS.LIVE,
    };
    if (!shouldMarkLive) {
      delete patch.status;
    }
    await this._updateTrade(tradeId, patch);
    this._clearVirtualTarget(tradeId);
    this._registerTargetWatchFromTrade({
      ...trade,
      targetOrderId,
      targetPrice,
      targetOrderType: params.order_type,
    });
    await linkOrder({
      order_id: String(targetOrderId),
      tradeId,
      role: "TARGET",
    });
    await this._replayOrphanUpdates(targetOrderId);

    this._watchExitLeg(tradeId, targetOrderId, "TARGET").catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
  }

  async _bookPartialPnlLeg({
    tradeId,
    side,
    entryPrice,
    exitPrice,
    qty,
    label,
  }) {
    const entry = Number(entryPrice ?? 0);
    const exit = Number(exitPrice ?? 0);
    const q = Number(qty ?? 0);
    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(exit) ||
      !(q > 0) ||
      entry <= 0 ||
      exit <= 0
    )
      return;

    const pnl = side === "BUY" ? (exit - entry) * q : (entry - exit) * q;

    const key = todayKey();
    const cur = await getDailyRisk(key);
    const realized = Number(cur?.realizedPnl ?? 0);

    await upsertDailyRisk(key, {
      realizedPnl: realized + pnl,
      lastTradeId: tradeId,
    });
    await this._updateDailyPnlState({
      realized: realized + pnl,
      openPnl: 0,
      total: realized + pnl,
      prevState: cur?.state || "RUNNING",
    });

    try {
      const t = await getTrade(tradeId);
      const legs = Array.isArray(t?.pnlLegs) ? t.pnlLegs : [];
      legs.push({
        label: String(label || "LEG"),
        qty: q,
        exitPrice: exit,
        pnl,
        at: new Date(),
      });
      await this._updateTrade(tradeId, {
        pnlLegs: legs,
        partialRealizedPnl: Number(t?.partialRealizedPnl ?? 0) + pnl,
      });
    } catch {
      // ignore
    }

    logger.info(
      { tradeId, label, pnl, realizedPnl: realized + pnl },
      "[pnl] booked partial",
    );
  }

  async _onTp1PartialFill(tradeId, trade, tp1Order) {
    const filled = Number(tp1Order.filled_quantity ?? 0);
    if (!(filled > 0)) return;

    const oid = String(
      tp1Order.order_id || tp1Order.orderId || trade.tp1OrderId || "",
    );
    if (oid) {
      // cancel remaining to avoid oversell
      this.expectedCancelOrderIds.add(String(oid));
      try {
        await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, oid, {
          purpose: "TP1_CANCEL_REMAINING_ON_PARTIAL",
          tradeId,
        });
      } catch (e) {
        logger.warn({ tradeId, e: e.message }, "[tp1] cancel remaining failed");
      }
    }

    return this._onTp1Filled(tradeId, trade, tp1Order, {
      forcedFilledQty: filled,
    });
  }

  async _onTp1Filled(tradeId, trade, tp1Order, opts = {}) {
    return this._runTradeCommand(
      tradeId,
      EXEC_COMMAND.PLACE_OR_CONFIRM_PROTECTION,
      async () => this._onTp1FilledImpl(tradeId, trade, tp1Order, opts),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _onTp1FilledImpl(tradeId, trade, tp1Order, opts = {}) {
    const fresh = (await getTrade(tradeId)) || trade;
    if (!fresh) return;

    const entry = Number(fresh.entryPrice ?? 0);
    const initQty = Number(fresh.initialQty ?? fresh.qty ?? 0);
    const filledQty = Number(
      opts.forcedFilledQty ?? tp1Order.filled_quantity ?? fresh.tp1Qty ?? 0,
    );
    const avgExit = Number(
      tp1Order.average_price ?? tp1Order.price ?? fresh.tp1Price ?? 0,
    );

    const tp1ExpectedPrice = Number(fresh.tp1Price ?? tp1Order.price ?? 0);

    // TP1 spread sample (never blocks)
    let tp1QuoteAt = null;
    try {
      if (String(env.SPREAD_SAMPLE_ON_EXIT || "true") === "true") {
        const spTp1 = await this._spreadCheck(fresh.instrument, {
          sampleOnly: true,
          allowWhenDisabled: true,
        });
        tp1QuoteAt = spTp1?.meta || null;
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const tp1SlippageBpsWorse = worseSlippageBps({
      side: fresh.side,
      expected: tp1ExpectedPrice,
      actual: avgExit,
      leg: "EXIT",
    });

    const tp1SlippageInrWorse = worseSlippageInr({
      side: fresh.side,
      expected: tp1ExpectedPrice,
      actual: avgExit,
      qty: filledQty,
      leg: "EXIT",
    });

    if (!(entry > 0) || !(avgExit > 0) || !(filledQty > 0)) return;

    const remaining = initQty - filledQty;
    if (remaining < 1) {
      // Defensive: if TP1 exits entire qty, close like target.
      if (fresh.slOrderId) {
        this.expectedCancelOrderIds.add(String(fresh.slOrderId));
        try {
          await this._safeCancelOrder(
            env.DEFAULT_ORDER_VARIETY,
            fresh.slOrderId,
            {
              purpose: "OCO_CANCEL_SL_ON_TP1_FULL",
              tradeId,
            },
          );
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
      }

      await this._updateTrade(tradeId, {
        tp1Done: true,
        tp1FilledQty: filledQty,
        tp1ExitPrice: avgExit,
        tp1ExpectedPrice,
        tp1QuoteAt,
        tp1SlippageBpsWorse,
        tp1SlippageInrWorse,
        status: STATUS.EXITED_TARGET,
        exitPrice: avgExit,
        exitExpectedPrice: tp1ExpectedPrice,
        exitQuoteAt: tp1QuoteAt,
        exitSlippageBpsWorse: tp1SlippageBpsWorse,
        exitSlippageInrWorse: tp1SlippageInrWorse,
        closeReason: "TP1_FULL_EXIT",
      });
      await this._bookRealizedPnl(tradeId);
      await this._finalizeClosed(tradeId, fresh.instrument_token);
      return;
    }

    // Book partial pnl for TP1 leg
    await this._bookPartialPnlLeg({
      tradeId,
      side: fresh.side,
      entryPrice: entry,
      exitPrice: avgExit,
      qty: filledQty,
      label: "TP1",
    });

    const tp1RealizedPnlInr =
      fresh.side === "BUY"
        ? (avgExit - entry) * filledQty
        : (entry - avgExit) * filledQty;
    const runnerRebasePatch = buildRunnerRebasePatch({
      trade: fresh,
      remainingQty: remaining,
      runnerPrice: avgExit,
      executablePrice:
        Number(tp1QuoteAt?.ltp ?? NaN) > 0 ? Number(tp1QuoteAt.ltp) : avgExit,
      realizedTp1PnlInr:
        Number(fresh?.partialRealizedPnl ?? 0) + tp1RealizedPnlInr,
      source: "TP1",
      now: new Date(),
    });

    // Move to runner stage immediately so winner-protection state is rebased to runner qty.
    await this._updateTrade(tradeId, {
      tp1Done: true,
      tp1FilledQty: filledQty,
      tp1ExitPrice: avgExit,
      tp1ExpectedPrice,
      tp1QuoteAt,
      tp1SlippageBpsWorse,
      tp1SlippageInrWorse,
      tp1FilledAt: new Date(),
      qty: remaining,
      runnerQty: remaining,
      ...runnerRebasePatch,
    });
    // Resize + tighten SL to "true breakeven" (+buffer, +estimated per-share fees)
    const tick = Number(fresh.instrument?.tick_size ?? 0.05);
    const bufTicks = Number(
      env.RUNNER_BE_BUFFER_TICKS ?? env.DYN_BE_BUFFER_TICKS ?? 1,
    );
    const buffer = bufTicks * tick;

    // Estimate round-trip costs for the remaining (runner) qty.
    // This prevents BE exits that are still fee-negative on small quantities.

    const entrySpreadBps = Number(fresh?.quoteAtEntry?.bps ?? 0);
    const tp1SpreadBps = Number(tp1QuoteAt?.bps ?? 0);
    const spreadBpsUsed =
      entrySpreadBps > 0 && tp1SpreadBps > 0
        ? (entrySpreadBps + tp1SpreadBps) / 2
        : entrySpreadBps || tp1SpreadBps || 0;
    const mult = Number(env.DYN_BE_COST_MULT ?? 1.0);
    let costPerShare = 0;
    let estCostInr = 0;
    let costMeta = null;
    try {
      const est = estimateRoundTripCostInr({
        entryPrice: entry,
        qty: remaining,
        spreadBps: spreadBpsUsed,
        env,
        instrument: fresh?.instrument || null,
      });
      estCostInr = Number(est?.estCostInr ?? 0);
      costMeta = est?.meta || null;
      if (Number.isFinite(estCostInr) && estCostInr > 0 && remaining > 0) {
        costPerShare = estCostInr / remaining;
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const rawBe =
      fresh.side === "BUY"
        ? entry + mult * costPerShare + buffer
        : entry - (mult * costPerShare + buffer);

    const be = roundToTick(rawBe, tick, fresh.side === "BUY" ? "up" : "down");

    const curSL = Number(
      this._brokerStopLossFromTrade(fresh) ??
        this._strategyStopLossFromTrade(fresh) ??
        0,
    );
    const newSL =
      fresh.side === "BUY"
        ? Math.max(curSL || -Infinity, be)
        : Math.min(curSL || Infinity, be);
    if (fresh.slOrderId) {
      try {
        await this._safeModifyOrder(
          env.DEFAULT_ORDER_VARIETY,
          fresh.slOrderId,
          { trigger_price: newSL, quantity: remaining },
          { purpose: "TP1_TO_BE_AND_RESIZE_SL", tradeId },
        );
        await this._updateTrade(tradeId, {
          stopLoss: newSL,
          slTrigger: newSL,
          ...buildExecutionRiskPatch({
            trade: fresh,
            qty: remaining,
            entryPrice: entry,
            stopLoss: this._strategyStopLossFromTrade(fresh),
          }),
          beLocked: true,
          beEligible: true,
          beLockHit: true,
          beLockedAt: fresh?.beLockedAt ?? new Date(),
          beLockedAtPrice: newSL,
          beAppliedAt: new Date(),
          beAppliedStopLoss: newSL,
          beApplyFails: 0,
          ...clearProtectionUpgradeStatePatch(),
          ...this._eventPatch("SL_MOVED_BE", {
            tradeId,
            stopLoss: newSL,
            remaining,
          }),
        });
        try {
          this._updateSlWatchTrigger(tradeId, newSL);
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
        logger.info(
          { tradeId, stopLoss: newSL, remaining },
          "[tp1] SL moved to BE+buffer and resized",
        );
        alert("info", "🧷 SL moved to BE+buffer", {
          tradeId,
          stopLoss: newSL,
          remaining,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
      } catch (e) {
        const tp1ProtectionTrade = {
          ...fresh,
          qty: remaining,
          tp1Done: true,
          stopLoss: newSL,
          slTrigger: newSL,
          ...runnerRebasePatch,
        };
        let recoveredViaCancelReplace = false;
        if (
          String(env.DYNAMIC_EXIT_CANCEL_REPLACE_ON_FAIL || "true") === "true"
        ) {
          recoveredViaCancelReplace = await this._replaceDynamicSlOrder(
            tp1ProtectionTrade,
            newSL,
          );
        }
        if (recoveredViaCancelReplace) {
          await this._updateTrade(tradeId, {
            ...buildExecutionRiskPatch({
              trade: fresh,
              qty: remaining,
              entryPrice: entry,
              stopLoss: this._strategyStopLossFromTrade(fresh),
            }),
            beLocked: true,
            beEligible: true,
            beLockHit: true,
            beLockedAt: fresh?.beLockedAt ?? new Date(),
            beLockedAtPrice: newSL,
            beAppliedAt: new Date(),
            beAppliedStopLoss: newSL,
            beApplyFails: 0,
            ...clearProtectionUpgradeStatePatch(),
          });
          logger.warn(
            { tradeId, stopLoss: newSL, remaining },
            "[tp1] SL recovered via cancel-replace after modify failure",
          );
        } else if (isSoftBrokerModifyError(e)) {
          const nextBeApplyFails =
            Math.max(0, Number(fresh?.beApplyFails ?? 0)) + 1;
          const pendingReason = protectionUpgradeReason({
            trade: fresh,
            source: "TP1_BE_REPRICE",
          });
          await this._updateTrade(tradeId, {
            beLocked: true,
            beEligible: true,
            beLockHit: true,
            beLockedAt: fresh?.beLockedAt ?? new Date(),
            beLockedAtPrice: newSL,
            beApplyFails: nextBeApplyFails,
            ...protectionUpgradeStatePatch({
              proposedStopLoss: newSL,
              fallbackMode: "SHADOW_PENDING",
              pending: true,
              softFailed: true,
              reason: pendingReason,
              now: new Date(),
            }),
          });
          await this._activateDynamicShadowMode(
            tp1ProtectionTrade,
            { reason: pendingReason, finalStop: newSL },
            {
              failCount: nextBeApplyFails,
              error: e,
              source: "tp1_be_soft_fail",
            },
          );
          logger.warn(
            { tradeId, e: e.message, stopLoss: newSL, remaining },
            "[tp1] SL modify soft-failed; runner shadow protection pending",
          );
        } else {
          logger.error(
            { tradeId, e: e.message },
            "[tp1] SL modify failed -> panic exit",
          );
          await this._panicExit(tp1ProtectionTrade, "TP1_SL_MODIFY_FAILED");
          return;
        }
      }
    }

    // Place runner target (TP2) if missing
    const after = (await getTrade(tradeId)) || fresh;
    if (!after.targetOrderId) {
      await this._placeRunnerTargetOnly(after);
    }

    await this._ensureExitQty(tradeId, remaining);
  }

  async _placeExitsIfMissing(trade) {
    return this._runTradeCommand(
      trade?.tradeId,
      EXEC_COMMAND.PLACE_OR_CONFIRM_PROTECTION,
      async () => this._placeExitsIfMissingImpl(trade),
      {
        seedTrade: trade,
        allowMissing: true,
      },
    );
  }

  async _placeExitsIfMissingImpl(trade) {
    const tradeId = trade.tradeId;

    // prevent duplicate SL/TARGET placement due to concurrent calls
    if (this.exitPlacementLocks.has(tradeId)) {
      logger.warn({ tradeId }, "[trade] exits placement skipped (lock)");
      return;
    }

    this.exitPlacementLocks.add(tradeId);
    try {
      const fresh = await getTrade(tradeId);
      if (!fresh) return;
      const shouldMarkLive = [STATUS.ENTRY_FILLED, STATUS.LIVE].includes(
        fresh.status,
      );

      // place SL if missing
      if (!fresh.slOrderId) {
        const liveTrade = { ...trade, ...fresh };
        const slSide = liveTrade.side === "BUY" ? "SELL" : "BUY";
        const liveStopLoss = Number(liveTrade.stopLoss);
        const liveQty = Number(liveTrade.qty);
        const liveInstrument = liveTrade.instrument;

        // If SL trigger is already breached (fast move), exit MARKET immediately instead of placing an invalid/instant SL
        const tokenNow = Number(liveTrade.instrument_token);
        const ltpNow = await this._getLtp(tokenNow, liveInstrument);
        const slBreached =
          Number.isFinite(ltpNow) &&
          ((slSide === "SELL" && Number(ltpNow) <= liveStopLoss) ||
            (slSide === "BUY" && Number(ltpNow) >= liveStopLoss));
        if (slBreached) {
          this._recordTradeDecision({
            trade: liveTrade,
            outcome: "BLOCKED",
            stage: "protection",
            reason: "SL_ALREADY_BREACHED",
            meta: { ltp: ltpNow, stopLoss: liveStopLoss, qty: liveQty },
          });
          logger.warn(
            { tradeId, ltpNow, stopLoss: liveStopLoss, slSide },
            "[trade] SL already breached -> MARKET exit",
          );
          alert("error", "🛑 SL already breached -> MARKET exit", {
            tradeId,
            ltp: ltpNow,
            stopLoss: liveStopLoss,
          }).catch((err) =>
            reportWindowedFault({
              code: "ALERT_SEND_FAILED",
              windowKey: "alert_send_failed",
              err,
              message: "[alert] failed to dispatch notification",
              meta: { context: "trade_manager" },
            }),
          );
          this.risk.setKillSwitch(true);
          await upsertDailyRisk(todayKey(), {
            kill: true,
            reason: "SL_ALREADY_BREACHED",
            lastTradeId: tradeId,
          });
          await this._panicExit(fresh, "SL_ALREADY_BREACHED");
          return;
        }

        const slOrderType = this._getStopLossOrderType(liveInstrument);
        const slLimitPrice =
          slOrderType === "SL"
            ? this._buildStopLossLimitPrice({
                triggerPrice: liveStopLoss,
                exitSide: slSide,
                instrument: liveInstrument,
              })
            : null;

        let slOrderTypeUsed = slOrderType;
        let slLimitPriceUsed = slLimitPrice;

        const slParams = {
          exchange: liveInstrument.exchange,
          tradingsymbol: liveInstrument.tradingsymbol,
          transaction_type: slSide,
          quantity: liveQty,
          product: env.DEFAULT_PRODUCT,
          order_type: slOrderType,
          trigger_price: liveStopLoss,
          ...(slOrderType === "SL" ? { price: slLimitPrice } : {}),
          validity: "DAY",
          tag: makeTag(tradeId, "SL"),
        };

        logger.info({ tradeId, slParams }, "[trade] placing SL");
        alert("info", "🛡️ SL placing", {
          tradeId,
          stopLoss: liveStopLoss,
          qty: liveQty,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );

        if (isHalted()) {
          logger.warn("[trade] SL skipped (halted)");
          return;
        }

        let slOrderId = null;
        try {
          const out = await this._safePlaceOrder(
            env.DEFAULT_ORDER_VARIETY,
            slParams,
            { purpose: "SL", tradeId },
          );
          slOrderId = out.orderId;
        } catch (e) {
          const msg = String(e?.message || e);

          // If SL-M is blocked/discontinued (common in F&O / some exchanges), retry with SL (stoploss-limit).
          if (
            String(slParams?.order_type || "").toUpperCase() === "SL-M" &&
            this._isSlmBlockedError(msg)
          ) {
            try {
              const fallbackParams = {
                ...slParams,
                order_type: "SL",
                price: this._buildStopLossLimitPrice({
                  // NOTE: if SL-M is blocked, SL-L is used and should be watchdogged.

                  triggerPrice: liveStopLoss,
                  exitSide: slSide,
                  instrument: liveInstrument,
                }),
              };

              slOrderTypeUsed = "SL";
              slLimitPriceUsed = fallbackParams.price;

              logger.warn(
                { tradeId, msg, fallbackParams },
                "[trade] SL-M blocked; retrying SL (stoploss-limit)",
              );

              const out2 = await this._safePlaceOrder(
                env.DEFAULT_ORDER_VARIETY,
                fallbackParams,
                { purpose: "SL", tradeId },
              );
              slOrderId = out2.orderId;
            } catch (e2) {
              logger.error(
                { tradeId, e: String(e2?.message || e2) },
                "[trade] SL retry (SL) failed",
              );
            }
          }

          if (!slOrderId) {
            this._recordTradeDecision({
              trade: fresh,
              outcome: "BLOCKED",
              stage: "protection",
              reason: "SL_PLACE_FAILED",
              meta: {
                message: msg,
                orderType: slOrderTypeUsed,
                stopLoss: liveStopLoss,
                qty: liveQty,
              },
            });
            logger.error(
              { tradeId, e: msg },
              "[trade] SL place failed -> panic exit",
            );
            alert("error", "🛑 SL place failed -> PANIC EXIT", {
              tradeId,
              message: msg,
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
            this.risk.setKillSwitch(true);
            await upsertDailyRisk(todayKey(), {
              kill: true,
              reason: "SL_PLACE_FAILED",
              lastTradeId: tradeId,
            });
            await this._panicExit(fresh, "SL_PLACE_FAILED");
            return;
          }
        }
        await this._updateTrade(tradeId, {
          status: STATUS.SL_PLACED,
          slOrderId,
          slPlacedAt: new Date(),
          exitPlacedAt: new Date(),
          slOrderType: slOrderTypeUsed,
          slLimitPrice: slLimitPriceUsed,
          ...this._eventPatch("SL_PLACED", {
            slOrderId,
            stopLoss: liveStopLoss,
            slOrderType: slOrderTypeUsed,
          }),
        });

        // Register SL watchdog state (for SL-L)
        try {
          this._registerSlWatchFromTrade({
            ...fresh,
            slOrderId,
            slOrderType: slOrderTypeUsed,
            slLimitPrice: slLimitPriceUsed,
          });
        } catch (err) {
          reportFault({
            code: "TRADING_TRADEMANAGER_CATCH",
            err,
            message: "[src/trading/tradeManager.js] caught and continued",
          });
        }
        await linkOrder({ order_id: String(slOrderId), tradeId, role: "SL" });
        await this._replayOrphanUpdates(slOrderId);
        alert("info", "✅ SL placed", {
          tradeId,
          slOrderId,
          stopLoss: liveStopLoss,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );

        this._armStopLossSla({
          tradeId,
          slOrderId,
          instrumentToken: Number(fresh.instrument_token ?? token),
        });
      }

      const tpEnabled = String(env.OPT_TP_ENABLED || "false") === "true";
      if (!tpEnabled) {
        const patch = {
          status: STATUS.LIVE,
          targetOrderId: null,
          targetOrderType: null,
          targetPrice: null,
          targetVirtual: false,
          tp1OrderId: null,
          tp1Aborted: true,
          ...this._eventPatch("TP_DISABLED", {
            reason: "OPT_TP_ENABLED=false",
          }),
        };
        if (!shouldMarkLive) {
          delete patch.status;
        }
        await this._updateTrade(tradeId, patch);
        return;
      }

      // place TP1 / TARGET (runner) depending on scale-out stage
      const fresh2 = await getTrade(tradeId);
      if (!fresh2) return;

      if (this._isOptTargetModeVirtual(trade)) {
        await this._enforceOptVirtualTargetMode(
          { ...trade, ...fresh2 },
          "opt_mode",
        );
        logger.info(
          {
            tradeId,
            targetPrice: fresh2.targetPrice,
            targetVirtual: true,
            optTargetMode: "VIRTUAL",
          },
          "[trade] OPT_TARGET_MODE=VIRTUAL -> tracking virtual target",
        );
        alert("info", "🎯 OPT_TARGET_MODE=VIRTUAL -> tracking virtual target", {
          tradeId,
          targetPrice: fresh2.targetPrice,
        }).catch((err) =>
          reportWindowedFault({
            code: "ALERT_SEND_FAILED",
            windowKey: "alert_send_failed",
            err,
            message: "[alert] failed to dispatch notification",
            meta: { context: "trade_manager" },
          }),
        );
        if (shouldMarkLive) {
          await this._updateTrade(tradeId, { status: STATUS.LIVE });
        }
        return;
      }

      const scaleEnabled = String(env.SCALE_OUT_ENABLED) === "true";
      const initQty = Number(fresh2.initialQty ?? fresh2.qty ?? trade.qty ?? 0);
      const eligible = scaleEnabled && initQty >= 2 && !fresh2.tp1Aborted;

      if (eligible) {
        // Stage 1: TP1 not yet done -> ensure TP1 exists
        if (!fresh2.tp1Done) {
          if (!fresh2.tp1OrderId) {
            try {
              await this._placeTp1Only({
                ...trade,
                ...fresh2,
                initialQty: initQty,
              });
            } catch (e) {
              logger.warn(
                { tradeId, e: e.message },
                "[trade] TP1 place failed -> fallback to normal TARGET",
              );
              await this._updateTrade(tradeId, {
                tp1Aborted: true,
                tp1OrderId: null,
                closeReason: "TP1_PLACE_FAILED | " + e.message,
              });
              // fallback to a single target
              try {
                await this._placeTargetOnly({
                  ...trade,
                  ...fresh2,
                  initialQty: initQty,
                });
              } catch (e2) {
                const msg = String(e2?.message || e2);
                if (this._shouldFallbackToVirtualTarget(msg)) {
                  await this._enableVirtualTarget(
                    { ...trade, ...fresh2, initialQty: initQty },
                    { reason: msg, source: "tp1_fallback_target" },
                  );
                  if (shouldMarkLive) {
                    await this._updateTrade(tradeId, { status: STATUS.LIVE });
                  }
                  return;
                }
                logger.warn(
                  { tradeId, e: msg },
                  "[trade] TARGET place failed (keeping SL only)",
                );
                alert("warn", "⚠️ TARGET place failed (SL still active)", {
                  tradeId,
                  message: msg,
                }).catch((err) =>
                  reportWindowedFault({
                    code: "ALERT_SEND_FAILED",
                    windowKey: "alert_send_failed",
                    err,
                    message: "[alert] failed to dispatch notification",
                    meta: { context: "trade_manager" },
                  }),
                );
                this._recordTradeDecision({
                  trade: fresh2,
                  outcome: "DEGRADED",
                  stage: "protection",
                  reason: "TARGET_PLACE_FAILED",
                  meta: { message: msg, source: "tp1_fallback_target" },
                });
                const patch = {
                  status: STATUS.LIVE,
                  closeReason: "TARGET_PLACE_FAILED | " + msg,
                };
                if (!shouldMarkLive) {
                  delete patch.status;
                }
                await this._updateTrade(tradeId, patch);
                return;
              }
            }
          }
        } else {
          // Stage 2: TP1 done -> ensure runner TARGET exists
          if (!fresh2.targetOrderId) {
            try {
              await this._placeRunnerTargetOnly({
                ...trade,
                ...fresh2,
                initialQty: initQty,
              });
            } catch (e) {
              const msg = String(e?.message || e);
              if (this._shouldFallbackToVirtualTarget(msg)) {
                await this._enableVirtualTarget(
                  { ...trade, ...fresh2, initialQty: initQty },
                  { reason: msg, source: "runner_target" },
                );
                if (shouldMarkLive) {
                  await this._updateTrade(tradeId, { status: STATUS.LIVE });
                }
                return;
              }
              logger.warn(
                { tradeId, e: msg },
                "[trade] RUNNER TARGET place failed (keeping SL only)",
              );
              alert("warn", "⚠️ RUNNER TARGET place failed (SL still active)", {
                tradeId,
                message: msg,
              }).catch((err) =>
                reportWindowedFault({
                  code: "ALERT_SEND_FAILED",
                  windowKey: "alert_send_failed",
                  err,
                  message: "[alert] failed to dispatch notification",
                  meta: { context: "trade_manager" },
                }),
              );
              this._recordTradeDecision({
                trade: fresh2,
                outcome: "DEGRADED",
                stage: "protection",
                reason: "RUNNER_TARGET_PLACE_FAILED",
                meta: { message: msg, source: "runner_target" },
              });
              const patch = {
                status: STATUS.LIVE,
                closeReason: "RUNNER_TARGET_PLACE_FAILED | " + msg,
              };
              if (!shouldMarkLive) {
                delete patch.status;
              }
              await this._updateTrade(tradeId, patch);
              return;
            }
          }
        }
      } else {
        // Regular single-target mode
        if (!fresh2.targetOrderId) {
          try {
            await this._placeTargetOnly({
              ...trade,
              ...fresh2,
              initialQty: initQty,
            });
          } catch (e) {
            const msg = String(e?.message || e);
            if (this._shouldFallbackToVirtualTarget(msg)) {
              await this._enableVirtualTarget(
                { ...trade, ...fresh2, initialQty: initQty },
                { reason: msg, source: "target" },
              );
              if (shouldMarkLive) {
                await this._updateTrade(tradeId, { status: STATUS.LIVE });
              }
              return;
            }
            logger.warn(
              { tradeId, e: msg },
              "[trade] TARGET place failed (keeping SL only)",
            );
            alert("warn", "⚠️ TARGET place failed (SL still active)", {
              tradeId,
              message: msg,
            }).catch((err) =>
              reportWindowedFault({
                code: "ALERT_SEND_FAILED",
                windowKey: "alert_send_failed",
                err,
                message: "[alert] failed to dispatch notification",
                meta: { context: "trade_manager" },
              }),
            );
            // Do not kill-switch; SL is safety critical and is already placed.
            this._recordTradeDecision({
              trade: fresh2,
              outcome: "DEGRADED",
              stage: "protection",
              reason: "TARGET_PLACE_FAILED",
              meta: { message: msg, source: "target" },
            });
            const patch = {
              status: STATUS.LIVE,
              closeReason: "TARGET_PLACE_FAILED | " + msg,
            };
            if (!shouldMarkLive) {
              delete patch.status;
            }
            await this._updateTrade(tradeId, patch);
            return;
          }
        }
      }
      if (shouldMarkLive) {
        await this._updateTrade(tradeId, { status: STATUS.LIVE });
      }
    } finally {
      this.exitPlacementLocks.delete(tradeId);
    }
  }

  async _onTargetFilled(tradeId, trade, targetOrder) {
    this._clearTargetWatch(tradeId);
    // Cancel TP1 if still pending (avoid accidental over-exit)
    if (trade.tp1OrderId && !trade.tp1Done) {
      this.expectedCancelOrderIds.add(String(trade.tp1OrderId));
      try {
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY,
          trade.tp1OrderId,
          {
            purpose: "OCO_CANCEL_TP1_ON_TARGET",
            tradeId,
          },
        );
      } catch (e) {
        logger.warn({ tradeId, e: e.message }, "[oco] cancel TP1 failed");
      }
    }
    if (trade.slOrderId) {
      this.expectedCancelOrderIds.add(String(trade.slOrderId));
      try {
        // ✅ use safe cancel (rate-limit + accounting)
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY,
          trade.slOrderId,
          {
            purpose: "OCO_CANCEL_SL_ON_TARGET",
            tradeId,
          },
        );
        logger.info(
          { tradeId, slOrderId: trade.slOrderId },
          "[oco] cancelled SL",
        );
      } catch (e) {
        logger.warn({ tradeId, e: e.message }, "[oco] cancel SL failed");
      }
    }

    const exitPrice = Number(
      targetOrder.average_price ?? targetOrder.price ?? trade.targetPrice ?? 0,
    );

    const exitExpectedPrice = Number(
      trade.targetPrice ?? targetOrder.price ?? 0,
    );

    // Exit spread sample (never blocks)
    let exitQuoteAt = null;
    try {
      if (String(env.SPREAD_SAMPLE_ON_EXIT || "true") === "true") {
        const spExit = await this._spreadCheck(trade.instrument, {
          sampleOnly: true,
          allowWhenDisabled: true,
        });
        exitQuoteAt = spExit?.meta || null;
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const exitSlippageBpsWorse = worseSlippageBps({
      side: trade.side,
      expected: exitExpectedPrice,
      actual: exitPrice,
      leg: "EXIT",
    });

    const exitSlippageInrWorse = worseSlippageInr({
      side: trade.side,
      expected: exitExpectedPrice,
      actual: exitPrice,
      qty: trade.qty,
      leg: "EXIT",
    });
    const exitLifecycle = resolveExitLifecycle("TARGET_HIT", {
      exitAuthority: "TARGET_ORDER",
    });
    await this._updateTrade(tradeId, {
      status: STATUS.EXITED_TARGET,
      exitPrice,
      exitExpectedPrice,
      exitQuoteAt,
      exitSlippageBpsWorse,
      exitSlippageInrWorse,
      closeReason: exitLifecycle.exitReasonCode,
      exitReason: exitLifecycle.exitReasonCode,
      exitFamily: exitLifecycle.exitFamily,
      exitReasonCode: exitLifecycle.exitReasonCode,
      exitAuthority: exitLifecycle.exitAuthority,
      exitAt: new Date(),
      exitOrderId: String(
        targetOrder?.order_id ||
          targetOrder?.orderId ||
          trade?.targetOrderId ||
          "",
      ),
      exitOrderRole: "TARGET",
    });
    alert("info", "🏁 TARGET HIT", { tradeId, exitPrice }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
    this.risk.resetFailures();
    await this._bookRealizedPnl(tradeId);
    await this._finalizeClosed(tradeId, trade.instrument_token);
  }

  async _onSlFilled(tradeId, trade, slOrder) {
    this._clearTargetWatch(tradeId);
    this._dynExitDisabled.add(tradeId);
    // Cancel TP1 if still pending (avoid accidental over-exit)
    if (trade.tp1OrderId && !trade.tp1Done) {
      this.expectedCancelOrderIds.add(String(trade.tp1OrderId));
      try {
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY,
          trade.tp1OrderId,
          {
            purpose: "OCO_CANCEL_TP1_ON_SL",
            tradeId,
          },
        );
      } catch (e) {
        logger.warn({ tradeId, e: e.message }, "[oco] cancel TP1 failed");
      }
    }
    if (trade.targetOrderId) {
      this.expectedCancelOrderIds.add(String(trade.targetOrderId));
      try {
        await this._safeCancelOrder(
          env.DEFAULT_ORDER_VARIETY,
          trade.targetOrderId,
          { purpose: "OCO_CANCEL_TARGET_ON_SL", tradeId },
        );
        logger.info(
          { tradeId, targetOrderId: trade.targetOrderId },
          "[oco] cancelled TARGET",
        );
      } catch (e) {
        logger.warn({ tradeId, e: e.message }, "[oco] cancel TARGET failed");
      }
    }

    const exitPrice = Number(
      slOrder.average_price ??
        slOrder.trigger_price ??
        this._brokerStopLossFromTrade(trade) ??
        0,
    );

    const exitExpectedPrice = Number(
      this._brokerStopLossFromTrade(trade) ??
        slOrder.trigger_price ??
        this._strategyStopLossFromTrade(trade) ??
        0,
    );

    // Exit spread sample (never blocks)
    let exitQuoteAt = null;
    try {
      if (String(env.SPREAD_SAMPLE_ON_EXIT || "true") === "true") {
        const spExit = await this._spreadCheck(trade.instrument, {
          sampleOnly: true,
          allowWhenDisabled: true,
        });
        exitQuoteAt = spExit?.meta || null;
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const exitSlippageBpsWorse = worseSlippageBps({
      side: trade.side,
      expected: exitExpectedPrice,
      actual: exitPrice,
      leg: "EXIT",
    });

    const exitSlippageInrWorse = worseSlippageInr({
      side: trade.side,
      expected: exitExpectedPrice,
      actual: exitPrice,
      qty: trade.qty,
      leg: "EXIT",
    });
    const stopReasonCode = deriveStopExitReasonCode(trade);
    const exitLifecycle = resolveExitLifecycle(stopReasonCode, {
      exitAuthority: "STOP_ORDER",
    });
    await this._updateTrade(tradeId, {
      status: STATUS.EXITED_SL,
      dynExitDisabled: true,
      dynExitDisabledAt: new Date(),
      exitPrice,
      exitExpectedPrice,
      exitQuoteAt,
      exitSlippageBpsWorse,
      exitSlippageInrWorse,
      closeReason: exitLifecycle.exitReasonCode,
      exitReason: exitLifecycle.exitReasonCode,
      exitFamily: exitLifecycle.exitFamily,
      exitReasonCode: exitLifecycle.exitReasonCode,
      exitAuthority: exitLifecycle.exitAuthority,
      exitAt: new Date(),
      exitOrderId: String(
        slOrder?.order_id || slOrder?.orderId || trade?.slOrderId || "",
      ),
      exitOrderRole: "SL",
    });
    alert("warn", "🛑 SL HIT", { tradeId, exitPrice }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
    this.risk.resetFailures();
    await this._bookRealizedPnl(tradeId);
    await this._finalizeClosed(tradeId, trade.instrument_token);
  }

  async _guardFail(trade, reason) {
    const freshTrade = (await getTrade(trade?.tradeId)) || trade;
    const reasonKey = String(reason || "").toUpperCase();

    // In panic/time-stop flow, SL cancellation is expected while flattening.
    if (reasonKey === "SL_CANCELLED") {
      const panicPlaced = !!freshTrade?.panicExitOrderId;
      let isFlat = false;
      try {
        const token = Number(freshTrade?.instrument_token);
        const positions = await this.kite.getPositions();
        const net = positions?.net || positions?.day || [];
        const p = Array.isArray(net)
          ? net.find((x) => Number(x.instrument_token) === token)
          : null;
        const q = Number(p?.quantity ?? p?.net_quantity ?? 0);
        isFlat = Number.isFinite(q) && q === 0;
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }

      if (panicPlaced || isFlat) {
        logger.warn(
          {
            tradeId: freshTrade?.tradeId || trade?.tradeId,
            reason,
            panicPlaced,
            isFlat,
          },
          "[guard] ignored expected SL cancel during panic/time-stop exit",
        );
        return;
      }
    }

    logger.error(
      { tradeId: trade.tradeId, reason },
      "[guard] exit leg failed -> kill switch",
    );
    alert("error", "GUARD FAIL (exit leg failed) -> kill switch", {
      tradeId: trade.tradeId,
      reason,
    }).catch((err) => {
      reportFault({
        code: "TRADING_TRADEMANAGER_ASYNC",
        err,
        message: "[src/trading/tradeManager.js] async task failed",
      });
    });
    const f = this.risk.markFailure(reason);
    if (f.killed)
      alert("error", "🛑 Failure limit reached -> kill switch", f).catch(
        () => {},
      );
    this.risk.setKillSwitch(true);
    await this._updateTrade(trade.tradeId, {
      status: STATUS.GUARD_FAILED,
      closeReason: reason,
    });
    await upsertDailyRisk(todayKey(), {
      kill: true,
      reason,
      lastTradeId: trade.tradeId,
    });

    // Best-effort: cancel existing exit legs to reduce risk of over-exit before PANIC order hits.
    try {
      const fresh = (await getTrade(trade.tradeId)) || trade;
      for (const oid of [fresh.slOrderId, fresh.targetOrderId]) {
        if (!oid) continue;
        this.expectedCancelOrderIds.add(String(oid));
        await this._safeCancelOrder(env.DEFAULT_ORDER_VARIETY, oid, {
          purpose: "GUARD_CANCEL_EXIT_LEG",
          tradeId: trade.tradeId,
        });
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // SL/exit leg failed => panic exit immediately (safety critical)
    await this._panicExit(trade, reason);
  }

  async _bookRealizedPnl(tradeId) {
    const t = await getTrade(tradeId);
    if (!t) return;

    const entry = Number(t.entryPrice ?? 0);
    const exit = Number(t.exitPrice ?? 0);
    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(exit) ||
      entry <= 0 ||
      exit <= 0
    )
      return;

    const qty = Number(t.qty ?? 0);
    const pnl = t.side === "BUY" ? (exit - entry) * qty : (entry - exit) * qty;

    const key = todayKey();
    const cur = await getDailyRisk(key);
    const realized = Number(cur?.realizedPnl ?? 0);

    await upsertDailyRisk(key, {
      realizedPnl: realized + pnl,
      lastTradeId: tradeId,
    });

    try {
      this._updateStrategyLossStreak({ trade: t, pnl });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }
    logger.info(
      { tradeId, pnl, realizedPnl: realized + pnl },
      "[pnl] booked realized",
    );
  }

  async _computeAndPersistFeeMultiple(tradeId) {
    if (String(env.FEE_MULTIPLE_ENABLED || "true") !== "true") return null;

    const t = await getTrade(tradeId);
    if (!t) return null;

    const entry = Number(t.entryPrice ?? 0);
    const exit = Number(t.exitPrice ?? 0);
    const side = String(t.side || "BUY").toUpperCase();

    if (!(entry > 0) || !(exit > 0)) return null;

    const qtyNow = Number(t.qty ?? 0);
    const baseQty = Number(t.initialQty ?? qtyNow ?? 0);
    if (!(baseQty > 0)) return null;

    // PnL: include any booked partial legs + the final leg.
    const partial = Number(t.partialRealizedPnl ?? 0);
    const finalLegPnl =
      side === "BUY" ? (exit - entry) * qtyNow : (entry - exit) * qtyNow;

    const grossPnlInr = partial + finalLegPnl;

    // Expected PnL based on expected entry/exit prices (helps separate charges vs slippage impact)
    const expectedEntry = Number(
      t.expectedEntryPrice ?? t.entryExpectedPrice ?? 0,
    );
    const expectedExit = Number(t.exitExpectedPrice ?? 0);
    const tp1Exp = Number(t.tp1ExpectedPrice ?? 0);
    const tp1Qty = Number(t.tp1FilledQty ?? 0);

    let pnlExpectedInr = null;
    try {
      const expEntryOk = expectedEntry > 0;
      const expExitOk = expectedExit > 0;
      const expTp1Ok = tp1Exp > 0 && tp1Qty > 0;

      let expected = 0;
      if (expTp1Ok && expEntryOk) {
        expected +=
          side === "BUY"
            ? (tp1Exp - expectedEntry) * tp1Qty
            : (expectedEntry - tp1Exp) * tp1Qty;
      }
      if (expExitOk && expEntryOk) {
        expected +=
          side === "BUY"
            ? (expectedExit - expectedEntry) * qtyNow
            : (expectedEntry - expectedExit) * qtyNow;
      }
      pnlExpectedInr = Number.isFinite(expected) ? expected : null;
    } catch {
      pnlExpectedInr = null;
    }

    const pnlSlippageDeltaInr = Number.isFinite(pnlExpectedInr)
      ? grossPnlInr - pnlExpectedInr
      : null;

    // More realistic order count: scale-out usually means ENTRY + TP1 + final exit.
    const scaleOutUsed =
      !!t.tp1Done && Number(t.tp1FilledQty ?? 0) > 0 && baseQty > qtyNow;
    const execOrders = scaleOutUsed ? 3 : 2;

    const entrySpreadBps = Number(t?.quoteAtEntry?.bps ?? 0);
    const exitSpreadBps = Number(t?.exitQuoteAt?.bps ?? 0);
    const spreadBpsUsed =
      entrySpreadBps > 0 && exitSpreadBps > 0
        ? (entrySpreadBps + exitSpreadBps) / 2
        : entrySpreadBps || exitSpreadBps || 0;

    let estCostInr = 0;
    let costMeta = null;
    try {
      const est = estimateRoundTripCostInr({
        entryPrice: entry,
        qty: baseQty,
        spreadBps: spreadBpsUsed,
        env: { ...env, EXPECTED_EXECUTED_ORDERS: execOrders },
        instrument: t?.instrument || null,
      });
      estCostInr = Number(est?.estCostInr ?? 0);
      costMeta = est?.meta || null;
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    const feeMultiple =
      Number.isFinite(estCostInr) && estCostInr > 0
        ? grossPnlInr / estCostInr
        : null;

    const netAfterEstCostsInr = Number.isFinite(estCostInr)
      ? grossPnlInr - estCostInr
      : null;

    const entrySlippage = Number(t.entrySlippageInrWorse ?? 0);
    const exitSlippage = Number(t.exitSlippageInrWorse ?? 0);
    const brokerage = Number(costMeta?.brokerage ?? 0);
    const taxes =
      (Number(costMeta?.turnover ?? 0) * Number(costMeta?.variableBps ?? 0)) /
      10000;
    const feesTotal = brokerage + taxes;

    // Persist on the trade for post-analysis.
    try {
      await this._updateTrade(tradeId, {
        pnlGrossInr: grossPnlInr,
        pnlExpectedInr,
        pnlSlippageDeltaInr,
        spreadBpsUsed,
        pnlNetAfterEstCostsInr: netAfterEstCostsInr,
        estCostsInr: estCostInr,
        feeMultiple,
        feeMultipleExecOrders: execOrders,
        feeMultipleMeta: costMeta,
        costPayload: {
          entrySlippage: Number.isFinite(entrySlippage) ? entrySlippage : null,
          exitSlippage: Number.isFinite(exitSlippage) ? exitSlippage : null,
          brokerage: Number.isFinite(brokerage) ? brokerage : null,
          taxes: Number.isFinite(taxes) ? taxes : null,
          feesTotal: Number.isFinite(feesTotal) ? feesTotal : null,
        },
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    try {
      this._recordSlippageFeedback({
        entrySlippageBps: t.entrySlippageBps,
        pnlSlippageDeltaInr,
      });
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    // Pro observability: aggregate fee-multiple by strategy and keep a ring of recent trades.
    try {
      tradeTelemetry.recordTradeClose({
        tradeId,
        strategyId: t.strategyId,
        side,
        closeReason: t.closeReason,
        grossPnlInr,
        estCostInr,
        netAfterEstCostsInr,
        feeMultiple,
      });

      // Adaptive optimizer: update rolling fee-multiple stats per symbol×strategy×bucket and auto-block weak keys.
      try {
        const symbol =
          t?.instrument?.tradingsymbol ||
          t?.instrument?.symbol ||
          t?.instrument?.name ||
          t?.instrument?.tradingsymbol ||
          null;
        optimizer.recordTradeClose({
          symbol: symbol || "UNKNOWN",
          underlying: t?.underlying_symbol || t?.option_meta?.underlying,
          optType: t?.option_meta?.optType,
          delta: t?.option_meta?.delta,
          expiry: t?.option_meta?.expiry,
          dte: t?.option_meta?.meta?.dteDays ?? t?.option_meta?.dteDays,
          optionMeta: t?.option_meta || null,
          strategyId: t.strategyId || "UNKNOWN",
          strategyStyle: t?.strategyStyle || null,
          signalRegime: t?.regime || null,
          feeMultiple,
          startedAtTs: t?.createdAt
            ? new Date(t.createdAt).getTime()
            : Date.now(),
          nowTs: Date.now(),
          optimizerContext: t?.optimizerContext || null,
        });
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    logger.info(
      {
        tradeId,
        strategyId: t.strategyId,
        closeReason: t.closeReason,
        grossPnlInr,
        estCostInr,
        netAfterEstCostsInr,
        feeMultiple,
        execOrders,
      },
      "[fees] fee-multiple computed",
    );

    return {
      feeMultiple,
      estCostInr,
      grossPnlInr,
      netAfterEstCostsInr,
      execOrders,
    };
  }

  async _finalizeClosed(tradeId, instrument_token) {
    return this._runTradeCommand(
      tradeId,
      EXEC_COMMAND.FINALIZE_CLOSE,
      async () => this._finalizeClosedImpl(tradeId, instrument_token),
      { allowMissing: true },
    );
  }

  async _finalizeClosedImpl(tradeId, instrument_token) {
    // Preserve terminal statuses for easier debugging (don't always overwrite with CLOSED)
    const t = await getTrade(tradeId);
    const terminal = [
      STATUS.EXITED_TARGET,
      STATUS.EXITED_SL,
      STATUS.ENTRY_FAILED,
      STATUS.ENTRY_CANCELLED,
    ];

    // Fee-multiple scoring (grossPnL / estimated costs) — helps tune to beat charges.
    if (t && [STATUS.EXITED_TARGET, STATUS.EXITED_SL].includes(t.status)) {
      try {
        await this._computeAndPersistFeeMultiple(tradeId);
      } catch (err) {
        reportFault({
          code: "TRADING_TRADEMANAGER_CATCH",
          err,
          message: "[src/trading/tradeManager.js] caught and continued",
        });
      }
    }

    const tradeWithPnl = await getTrade(tradeId);

    if (t && terminal.includes(t.status)) {
      await this._updateTrade(tradeId, { closedAt: new Date() });
    } else {
      await this._updateTrade(tradeId, {
        status: STATUS.CLOSED,
        closedAt: new Date(),
      });
    }

    // Track last closed trade briefly (helps detect OCO races that flip positions after close)
    try {
      this.lastClosedTradeId = tradeId;
      this.lastClosedToken = Number(instrument_token);
      this.lastClosedAt = Date.now();
    } catch (err) {
      reportFault({
        code: "TRADING_TRADEMANAGER_CATCH",
        err,
        message: "[src/trading/tradeManager.js] caught and continued",
      });
    }

    this.activeTradeId = null;
    this.recoveredPosition = null;
    this._activeTradeToken = null;
    this._activeTradeSide = null;
    this._cleanupTradeRuntimeState(tradeId);
    const qty = Number(tradeWithPnl?.qty ?? t?.qty ?? 0);
    const entry = Number(tradeWithPnl?.entryPrice ?? t?.entryPrice ?? 0);
    const exit = Number(tradeWithPnl?.exitPrice ?? t?.exitPrice ?? 0);
    const pnl =
      qty > 0 && entry > 0 && exit > 0
        ? String(tradeWithPnl?.side || t?.side || "BUY").toUpperCase() === "BUY"
          ? (exit - entry) * qty
          : (entry - exit) * qty
        : null;

    if (
      tradeWithPnl &&
      [STATUS.EXITED_TARGET, STATUS.EXITED_SL].includes(tradeWithPnl.status)
    ) {
      const grossPnlInr = Number(tradeWithPnl?.pnlGrossInr);
      const netPnlInr = Number(tradeWithPnl?.pnlNetAfterEstCostsInr);
      alert(pnl != null && pnl >= 0 ? "info" : "warn", "📌 Trade closed", {
        tradeId,
        status: tradeWithPnl.status,
        closeReason: tradeWithPnl.closeReason,
        pnlInr: pnl,
        pnlGrossInr: Number.isFinite(grossPnlInr) ? grossPnlInr : null,
        pnlNetAfterEstCostsInr: Number.isFinite(netPnlInr) ? netPnlInr : null,
        entryPrice: Number.isFinite(entry) ? entry : null,
        exitPrice: Number.isFinite(exit) ? exit : null,
        qty: Number.isFinite(qty) ? qty : null,
      }).catch((err) => {
        reportFault({
          code: "TRADING_TRADEMANAGER_ASYNC",
          err,
          message: "[src/trading/tradeManager.js] async task failed",
        });
      });
    }

    this.risk.markTradeClosed(
      tradeWithPnl?.riskKey || t?.riskKey || String(instrument_token),
      {
        status: tradeWithPnl?.status || t?.status,
        closeReason: tradeWithPnl?.closeReason || t?.closeReason,
        exitReason: tradeWithPnl?.exitReason || t?.exitReason,
        pnl,
      },
    );
  }

  async setKillSwitch(enabled, reason) {
    const en = !!enabled;
    this.risk.setKillSwitch(en);
    await upsertDailyRisk(todayKey(), {
      kill: en,
      reason: en ? String(reason || "ADMIN") : null,
    });
    alert(
      en ? "error" : "info",
      en ? "🛑 Kill-switch ENABLED" : "✅ Kill-switch DISABLED",
      {
        kill: en,
        reason: en ? String(reason || "ADMIN") : null,
      },
    ).catch((err) =>
      reportWindowedFault({
        code: "ALERT_SEND_FAILED",
        windowKey: "alert_send_failed",
        err,
        message: "[alert] failed to dispatch notification",
        meta: { context: "trade_manager" },
      }),
    );
    logger.warn({ kill: en, reason }, "[risk] kill-switch updated");
  }

  async status() {
    const active = this.activeTradeId
      ? await getTrade(this.activeTradeId)
      : null;
    const risk = await getDailyRisk(todayKey());
    return {
      tradingEnabled: getTradingEnabled(),
      tradingEnabledSource: getTradingEnabledSource(),
      killSwitch: this.risk.getKillSwitch(),
      tradesToday: this.risk.tradesToday,
      activeTradeId: this.activeTradeId,
      activeTrade: active,
      recoveredPosition: this.recoveredPosition,
      dailyRisk: risk,
      dailyRiskState: risk?.state || "RUNNING",
      dailyRiskReason: risk?.stateReason || null,
      ordersPlacedToday: this.ordersPlacedToday,
      dynamicExitCadence: this._dynExitCadenceSnapshot(),
      orphanReplay: { ...this._orphanReplayStats },
      faults: snapshotFaults(),
    };
  }
}

function fallbackSL(entry, side) {
  const pct = Number(env.SL_PCT_FALLBACK ?? 0.3) / 100.0;
  if (side === "BUY") return entry * (1 - pct);
  return entry * (1 + pct);
}

function optionStopLossFromUnderlyingATR({
  side,
  entry,
  tickSize,
  optionMeta,
  atr,
  atrMult,
  minTicks,
}) {
  const atrVal = Number(atr);
  const mult = Number(atrMult);
  if (!Number.isFinite(atrVal) || atrVal <= 0 || !Number.isFinite(mult)) {
    return { ok: false, reason: "INVALID_ATR" };
  }

  const moveU = Math.max(0, atrVal * Math.max(0, mult));
  if (!(moveU > 0)) return { ok: false, reason: "NO_MOVE" };

  const moneyness = String(optionMeta?.moneyness || env.OPT_MONEYNESS || "ATM")
    .toUpperCase()
    .trim();

  const fallbackDelta =
    moneyness === "ITM"
      ? Number(env.OPT_DELTA_ITM ?? 0.65)
      : moneyness === "OTM"
        ? Number(env.OPT_DELTA_OTM ?? 0.4)
        : Number(env.OPT_DELTA_ATM ?? 0.5);

  const deltaRaw = Math.abs(Number(optionMeta?.delta));
  const delta =
    Number.isFinite(deltaRaw) && deltaRaw > 0 ? deltaRaw : fallbackDelta;

  const gammaRaw = Math.abs(Number(optionMeta?.gamma));
  const gamma = Number.isFinite(gammaRaw) ? gammaRaw : 0;

  let premMove = moveU * delta + 0.5 * gamma * moveU * moveU;
  if (!Number.isFinite(premMove) || premMove <= 0) {
    return { ok: false, reason: "NO_PREM_MOVE" };
  }

  const tick = Number(tickSize ?? 0.05);
  const minTicksNum = Math.max(0, Number(minTicks ?? 0));
  const minStop = minTicksNum > 0 ? minTicksNum * tick : 0;
  if (minStop > 0) premMove = Math.max(premMove, minStop);

  const rawStop =
    side === "BUY" ? Number(entry) - premMove : Number(entry) + premMove;

  if (!Number.isFinite(rawStop) || rawStop <= 0) {
    return { ok: false, reason: "INVALID_STOP" };
  }

  const stopLoss = roundToTick(rawStop, tick, side === "BUY" ? "down" : "up");

  return {
    ok: true,
    stopLoss,
    meta: {
      moveU,
      delta,
      gamma,
      premMove,
      minStop,
      atr: atrVal,
      atrMult: mult,
    },
  };
}

function calcOpenPnl(trade, ltp) {
  const entry = Number(
    trade.entryPrice ??
      trade.expectedEntryPrice ??
      trade.quoteAtEntry?.ltp ??
      trade.candle?.close ??
      0,
  );
  const qty = Number(trade.qty ?? 0);
  if (!entry || !qty) return 0;
  return trade.side === "BUY" ? (ltp - entry) * qty : (entry - ltp) * qty;
}

function isDead(status) {
  const s = String(status || "").toUpperCase();
  return ["REJECTED", "CANCELLED", "CANCELED", "LAPSED"].includes(s);
}

function makeTag(tradeId, role) {
  const base = String(tradeId || "").replaceAll("-", "");
  const r =
    String(role || "X")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 1) || "X";
  // 20 chars max. Keep role in the tail so ENTRY/SL/TARGET tags are distinct.
  return `T${base.slice(0, 18)}${r}`.slice(0, 20);
}

function isRetryablePlaceError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  const status = Number(e?.status ?? e?.http_code ?? e?.code ?? 0);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const patterns = [
    "etimedout",
    "econnreset",
    "socket hang up",
    "network",
    "gateway",
    "service unavailable",
    "temporary",
    "timeout",
  ];
  return patterns.some((p) => msg.includes(p));
}

function detectCircuitBreakerReason(message) {
  const msg = String(message || "").toLowerCase();
  if (!msg) return null;

  const patterns = [
    { code: "CIRCUIT_BREAKER", re: /circuit|price band|upper band|lower band/ },
    { code: "MARKET_PROTECTION", re: /market protection|price protection|rms/ },
    { code: "LTP_FREEZE", re: /ltp freeze|last traded price freeze/ },
    { code: "FREEZE_QTY", re: /freeze qty|freeze quantity/ },
    { code: "EXCHANGE_HALT", re: /halted|suspended/ },
  ];

  return patterns.find((p) => p.re.test(msg)) || null;
}

function normalizeOrderShapeForMatch(x) {
  return {
    exchange: String(x.exchange || "").toUpperCase(),
    tradingsymbol: String(
      x.tradingsymbol || x.trading_symbol || "",
    ).toUpperCase(),
    transaction_type: String(x.transaction_type || "").toUpperCase(),
    order_type: String(x.order_type || "").toUpperCase(),
    product: String(x.product || "").toUpperCase(),
    quantity: Number(x.quantity ?? 0),
    price: Number(x.price ?? 0),
    trigger_price: Number(x.trigger_price ?? x.triggerPrice ?? 0),
  };
}

function ordersMatch(a, b) {
  return (
    a.exchange === b.exchange &&
    a.tradingsymbol === b.tradingsymbol &&
    a.transaction_type === b.transaction_type &&
    a.order_type === b.order_type &&
    a.product === b.product &&
    a.quantity === b.quantity &&
    nearlyEq(a.price, b.price) &&
    nearlyEq(a.trigger_price, b.trigger_price)
  );
}

function nearlyEq(a, b) {
  const x = Number(a ?? 0);
  const y = Number(b ?? 0);
  return Math.abs(x - y) < 1e-6;
}

function parseTimeWindows(str) {
  const s = String(str || "").trim();
  if (!s) return [];
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  const windows = [];
  for (const part of parts) {
    const [a, b] = part.split("-").map((x) => x.trim());
    if (!a || !b) continue;
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const sa = DateTime.fromFormat(a, "HH:mm", { zone: tz });
    const sb = DateTime.fromFormat(b, "HH:mm", { zone: tz });
    if (!sa.isValid || !sb.isValid) continue;
    const startMin = sa.hour * 60 + sa.minute;
    const endMin = sb.hour * 60 + sb.minute;
    windows.push({ startMin, endMin });
  }
  return windows;
}

function isWithinAnyWindow(dt, windows) {
  const m = dt.hour * 60 + dt.minute;
  for (const w of windows || []) {
    if (w.startMin <= w.endMin) {
      if (m >= w.startMin && m <= w.endMin) return true;
    } else {
      // crosses midnight
      if (m >= w.startMin || m <= w.endMin) return true;
    }
  }
  return false;
}

function avgNum(arr) {
  const xs = (arr || [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function emaLast(values, period) {
  const p = Math.max(1, Number(period ?? 1));
  const xs = values.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  if (xs.length < p) return NaN;
  const k = 2 / (p + 1);
  let ema = avgNum(xs.slice(0, p));
  for (let i = p; i < xs.length; i++) {
    ema = xs[i] * k + ema * (1 - k);
  }
  return ema;
}

function atrLast(candles, period = 14) {
  const p = Math.max(1, Number(period ?? 14));
  if (!Array.isArray(candles) || candles.length < p + 2) return NaN;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const hi = Number(c.high);
    const lo = Number(c.low);
    const pc = Number(prev.close);
    if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(pc))
      continue;
    const tr = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    trs.push(tr);
  }
  if (trs.length < p) return NaN;
  // Wilder's ATR: smooth TR
  let atr = avgNum(trs.slice(0, p));
  for (let i = p; i < trs.length; i++) {
    atr = (atr * (p - 1) + trs[i]) / p;
  }
  return atr;
}

function percentileRank(hist, x) {
  if (!hist || !hist.length) return 50;
  const vals = hist.slice().sort((a, b) => a - b);
  const v = Number(x);
  let less = 0;
  for (const n of vals) if (n < v) less++;
  return (less / vals.length) * 100;
}

module.exports = {
  TradeManager,
  STATUS,
  buildEarlyFailRuntimeTelemetry,
  buildFrozenOptimizerContext,
  buildCompressionTelemetryMeta,
  evaluatePreRouteTradability,
  evaluatePreRouteConfidenceGate,
  resolveMinLotRiskPolicyDecision,
  resolvePreEntrySlFitDecision,
  resolvePreRouteConfidenceAllowance,
  resolveOptimizerAdmission,
  resolveOptimizerRrTarget,
};

