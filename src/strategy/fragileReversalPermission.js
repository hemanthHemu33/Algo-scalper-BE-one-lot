const FRAGILE_REVERSAL_STATES = Object.freeze([
  "TREND_COMPRESSED",
  "BREAKOUT_WATCH",
  "FAILED_BREAKOUT",
]);

const DEFAULT_FRAGILE_REVERSAL_STRATEGIES = Object.freeze({
  TREND_COMPRESSED: ["wick_reversal"],
  BREAKOUT_WATCH: ["wick_reversal"],
  FAILED_BREAKOUT: ["fakeout", "wick_reversal"],
});

const RANGE_REVERSAL_STRATEGY_IDS = new Set([
  "fakeout",
  "rsi_fade",
  "wick_reversal",
]);

const KEY_LEVEL_TYPES = new Set([
  "SUPPORT",
  "RESISTANCE",
  "TRIGGER",
  "ANCHOR",
]);

function normalizeRegime(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return normalized || "UNKNOWN";
}

function normalizeStrategyStyle(style) {
  const value = String(style || "")
    .trim()
    .toUpperCase();
  if (!value) return "UNKNOWN";
  if (value.includes("OPEN")) return "OPEN";
  if (value.includes("TREND")) return "TREND";
  if (value.includes("RANGE")) return "RANGE";
  return value;
}

function normalizeStrategyId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseStrategyList(spec) {
  return String(spec || "")
    .split(",")
    .map((value) => normalizeStrategyId(value))
    .filter(Boolean);
}

function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function stateConfigKey(state) {
  if (state === "TREND_COMPRESSED") {
    return "FRAGILE_REVERSAL_TREND_COMPRESSED_STRATEGIES";
  }
  if (state === "BREAKOUT_WATCH") {
    return "FRAGILE_REVERSAL_BREAKOUT_WATCH_STRATEGIES";
  }
  if (state === "FAILED_BREAKOUT") {
    return "FRAGILE_REVERSAL_FAILED_BREAKOUT_STRATEGIES";
  }
  return null;
}

function configuredFragileReversalStrategies(env = {}, state) {
  const normalizedState = normalizeRegime(state);
  const key = stateConfigKey(normalizedState);
  const defaults = DEFAULT_FRAGILE_REVERSAL_STRATEGIES[normalizedState] || [];
  const configured = key ? parseStrategyList(env?.[key]) : [];
  const allowed = configured.length ? configured : defaults.slice();
  if (boolValue(env?.FRAGILE_REVERSAL_ALLOW_RSI_FADE, false)) {
    allowed.push("rsi_fade");
  }
  return uniq(allowed);
}

function isFragileReversalState(state) {
  return FRAGILE_REVERSAL_STATES.includes(normalizeRegime(state));
}

function isRangeReversalStrategy(strategyId) {
  return RANGE_REVERSAL_STRATEGY_IDS.has(normalizeStrategyId(strategyId));
}

function isFragileReversalStrategyAllowed({ env = {}, marketState, strategyId }) {
  const state = normalizeRegime(marketState);
  const id = normalizeStrategyId(strategyId);
  if (!isFragileReversalState(state)) return false;
  if (id === "rsi_fade" && !boolValue(env?.FRAGILE_REVERSAL_ALLOW_RSI_FADE, false)) {
    return false;
  }
  return configuredFragileReversalStrategies(env, state).includes(id);
}

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function resolveLevelAcceptance(candidate, explicit) {
  return (
    explicit ||
    candidate?.meta?.levelAcceptance ||
    candidate?.scoreBreakdown?.levelAcceptance ||
    candidate?.levelAcceptance ||
    null
  );
}

function resolveDangerStack(candidate, explicit) {
  return (
    explicit ||
    candidate?.meta?.dangerStack ||
    candidate?.scoreBreakdown?.dangerStack ||
    candidate?.dangerStack ||
    null
  );
}

function resolveMtf(candidate, explicit) {
  const scoreBreakdown = candidate?.scoreBreakdown || {};
  return {
    ...(explicit && typeof explicit === "object" ? explicit : {}),
    mtfState: firstPresent(
      explicit?.mtfState,
      explicit?.state,
      candidate?.mtfState,
      scoreBreakdown.mtfState,
    ),
    mtfBias: firstPresent(
      explicit?.mtfBias,
      explicit?.bias,
      candidate?.mtfBias,
      scoreBreakdown.mtfBias,
    ),
    mtfAgreementScore: firstPresent(
      explicit?.mtfAgreementScore,
      explicit?.agreementScore,
      candidate?.mtfAgreementScore,
      scoreBreakdown.mtfAgreementScore,
    ),
  };
}

function nearEnoughFromLevel(levelAcceptance, env) {
  if (levelAcceptance?.acceptanceMeta?.nearEnough === true) return true;
  const distanceAtr = finiteOrNull(levelAcceptance?.distanceToLevelAtr);
  if (distanceAtr == null) return false;
  const maxDistanceAtr = Math.max(
    0.05,
    Number(
      levelAcceptance?.acceptanceMeta?.maxDistanceAtr ??
        env?.LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR ??
        0.8,
    ),
  );
  return distanceAtr <= maxDistanceAtr;
}

function resolveSessionExtremeDetected({ candidate, levelAcceptance, env }) {
  const meta = candidate?.meta || {};
  const scoreBreakdown = candidate?.scoreBreakdown || {};
  const reversalZone = String(
    firstPresent(meta.reversalZone, candidate?.reversalZone, scoreBreakdown.reversalZone),
  ).toUpperCase();
  if (
    reversalZone === "SESSION_LOW_EXHAUSTION" ||
    reversalZone === "SESSION_HIGH_EXHAUSTION"
  ) {
    return true;
  }

  const keyLevelType = String(levelAcceptance?.keyLevelType || "")
    .trim()
    .toUpperCase();
  const nearEnough = nearEnoughFromLevel(levelAcceptance, env);
  if (nearEnough && KEY_LEVEL_TYPES.has(keyLevelType)) return true;
  if (nearEnough && (keyLevelType === "SESSION_LOW" || keyLevelType === "SESSION_HIGH")) {
    return true;
  }

  const triggerLevel = finiteOrNull(
    firstPresent(meta.triggerLevel, meta.wickExtreme, meta.anchorValue, candidate?.triggerLevel),
  );
  const currentSession =
    meta.currentSession ||
    candidate?.regimeMeta?.currentSession ||
    scoreBreakdown.currentSession ||
    null;
  const sessionHigh = finiteOrNull(
    firstPresent(meta.sessionHigh, currentSession?.high, levelAcceptance?.sessionHigh),
  );
  const sessionLow = finiteOrNull(
    firstPresent(meta.sessionLow, currentSession?.low, levelAcceptance?.sessionLow),
  );
  if (triggerLevel == null || (sessionHigh == null && sessionLow == null)) return false;

  const atrValue = finiteOrNull(
    firstPresent(
      levelAcceptance?.acceptanceMeta?.atrValue,
      meta.atr,
      candidate?.regimeMeta?.atr,
      scoreBreakdown.atr,
    ),
  );
  const pxTolerance = Math.max(
    atrValue != null ? atrValue * 0.5 : 0,
    Math.abs(triggerLevel) * 0.0008,
    0.05,
  );
  return (
    (sessionHigh != null && Math.abs(triggerLevel - sessionHigh) <= pxTolerance) ||
    (sessionLow != null && Math.abs(triggerLevel - sessionLow) <= pxTolerance)
  );
}

function baseResult({
  strategyId,
  strategyStyle,
  regime,
  marketState,
  requiredChecks,
  passedChecks,
  failedChecks,
  minConfidenceRequired,
  confidenceUsed,
  mtfState,
  mtfAgreementScore,
  dteDays,
  dangerStackScore,
  levelRejectionDetected,
  sessionExtremeDetected,
  reasonCode,
  allowed = false,
}) {
  const checked =
    normalizeStrategyStyle(strategyStyle) === "RANGE" &&
    isFragileReversalState(marketState);
  return {
    allowed,
    reasonCode,
    exceptionType: checked ? "FRAGILE_REVERSAL" : null,
    requiredChecks,
    passedChecks,
    failedChecks,
    checksPassed: Object.entries(passedChecks)
      .filter(([, passed]) => passed === true)
      .map(([check]) => check),
    minConfidenceRequired,
    confidenceUsed,
    marketState,
    regime,
    strategyId,
    strategyStyle,
    mtfState: mtfState || null,
    mtfAgreementScore,
    dteDays,
    dangerStackScore,
    levelRejectionDetected,
    sessionExtremeDetected,
  };
}

function resolveFragileReversalPermission({
  strategyStyle,
  strategyId,
  regime,
  marketState,
  candidate = null,
  levelAcceptance: explicitLevelAcceptance = null,
  dangerStack: explicitDangerStack = null,
  mtf: explicitMtf = null,
  dteDays: explicitDteDays = null,
  confidence: explicitConfidence = null,
  regimeSnapshot = null,
  env = {},
} = {}) {
  const style = normalizeStrategyStyle(
    strategyStyle || candidate?.strategyStyle || candidate?.style,
  );
  const id = normalizeStrategyId(strategyId || candidate?.strategyId);
  const regimeBucket = normalizeRegime(
    regime ||
      candidate?.regimeSnapshot?.regime ||
      candidate?.regime ||
      regimeSnapshot?.regime,
  );
  const state = normalizeRegime(
    marketState ||
      candidate?.marketState ||
      candidate?.meta?.marketState ||
      candidate?.scoreBreakdown?.marketState ||
      candidate?.regimeMeta?.marketState ||
      regimeSnapshot?.marketState ||
      regimeBucket,
  );

  const enabled = boolValue(env?.FRAGILE_REVERSAL_EXCEPTION_ENABLED, true);
  const allowedStrategyIds = configuredFragileReversalStrategies(env, state);
  const minConfidence = Number(env?.FRAGILE_REVERSAL_MIN_CONFIDENCE ?? 80);
  const minMtfScore = Number(env?.FRAGILE_REVERSAL_MIN_MTF_SCORE ?? 55);
  const blockOnMtfDisagreement = boolValue(
    env?.FRAGILE_REVERSAL_BLOCK_ON_MTF_DISAGREEMENT,
    true,
  );
  const requireLevelRejection = boolValue(
    env?.FRAGILE_REVERSAL_REQUIRE_LEVEL_REJECTION,
    true,
  );
  const requireSessionExtreme = boolValue(
    env?.FRAGILE_REVERSAL_REQUIRE_SESSION_EXTREME,
    true,
  );
  const dangerBelow = Number(env?.FRAGILE_REVERSAL_REQUIRE_DANGER_BELOW ?? 62);
  const oneDteMinConfidence = Number(
    env?.FRAGILE_REVERSAL_ONE_DTE_MIN_CONFIDENCE ?? 86,
  );
  const oneDteMaxDanger = Number(env?.FRAGILE_REVERSAL_ONE_DTE_MAX_DANGER ?? 45);
  const rejectionMinCount = Math.max(1, Number(env?.LEVEL_REJECTION_MIN_COUNT ?? 2));

  const levelAcceptance = resolveLevelAcceptance(candidate, explicitLevelAcceptance);
  const dangerStack = resolveDangerStack(candidate, explicitDangerStack);
  const mtf = resolveMtf(candidate, explicitMtf);
  const dteDays = finiteOrNull(
    firstPresent(
      explicitDteDays,
      candidate?.dteDays,
      candidate?.dte,
      candidate?.meta?.dteDays,
      candidate?.meta?.dte,
      candidate?.meta?.productAdaptation?.dte,
      candidate?.scoreBreakdown?.dte,
    ),
  );
  const oneDte = dteDays != null && dteDays <= 1;
  const minConfidenceRequired = oneDte ? oneDteMinConfidence : minConfidence;
  const confidenceUsed = finiteOrNull(
    firstPresent(
      explicitConfidence,
      candidate?.rawConfidence,
      candidate?.confidence,
      candidate?.normalizedConfidence,
    ),
  );
  const mtfState = String(mtf?.mtfState || "").trim().toUpperCase();
  const mtfBias = String(mtf?.mtfBias || "").trim().toUpperCase();
  const mtfAgreementScore = finiteOrNull(mtf?.mtfAgreementScore);
  const dangerStackScore = finiteOrNull(
    firstPresent(dangerStack?.dangerStackScore, candidate?.dangerStackScore),
  );
  const rejectionCount = Number(levelAcceptance?.rejectionCount ?? 0);
  const levelRejectionDetected =
    levelAcceptance?.repeatedRejectionDetected === true ||
    levelAcceptance?.breakoutRejected === true ||
    rejectionCount >= rejectionMinCount;
  const strictFailedBreakoutRejection =
    levelAcceptance?.repeatedRejectionDetected === true ||
    levelAcceptance?.breakoutRejected === true;
  const sessionExtremeDetected = resolveSessionExtremeDetected({
    candidate,
    levelAcceptance,
    env,
  });

  const requiredChecks = {
    enabled: true,
    strategyStyle: "RANGE",
    allowedStates: FRAGILE_REVERSAL_STATES.slice(),
    allowedStrategyIds,
    minConfidenceRequired,
    minMtfAgreementScore: minMtfScore,
    blockOnMtfDisagreement,
    requireLevelRejection,
    requireSessionExtreme,
    dangerStackBelow: dangerBelow,
    oneDteMinConfidence,
    oneDteMaxDanger,
    levelRejectionMinCount: rejectionMinCount,
  };
  const passedChecks = {};
  const failedChecks = [];
  let firstReasonCode = null;
  const mark = (check, passed, reasonCode) => {
    passedChecks[check] = passed === true;
    if (!passed) {
      failedChecks.push(check);
      if (!firstReasonCode) firstReasonCode = reasonCode;
    }
  };

  mark("EXCEPTION_ENABLED", enabled, "FRAGILE_REVERSAL_DISABLED");
  mark("RANGE_STYLE", style === "RANGE", "FRAGILE_REVERSAL_NOT_RANGE_STYLE");
  mark(
    "MARKET_STATE_NOT_NO_TRADE",
    state !== "NO_TRADE" && state !== "TRAP_RISK_HIGH",
    "FRAGILE_REVERSAL_MARKET_STATE_BLOCKED",
  );
  mark("FRAGILE_STATE", isFragileReversalState(state), "FRAGILE_REVERSAL_STATE_NOT_ALLOWED");
  mark(
    "STRATEGY_ALLOWED",
    isFragileReversalStrategyAllowed({ env, marketState: state, strategyId: id }),
    "FRAGILE_REVERSAL_STRATEGY_NOT_ALLOWED",
  );

  if (failedChecks.length) {
    return baseResult({
      strategyId: id,
      strategyStyle: style,
      regime: regimeBucket,
      marketState: state,
      requiredChecks,
      passedChecks,
      failedChecks,
      minConfidenceRequired,
      confidenceUsed,
      mtfState,
      mtfAgreementScore,
      dteDays,
      dangerStackScore,
      levelRejectionDetected,
      sessionExtremeDetected,
      reasonCode: firstReasonCode || "FRAGILE_REVERSAL_NOT_CONFIRMED",
    });
  }

  const missingContext = [];
  if (confidenceUsed == null) missingContext.push("CONFIDENCE_CONTEXT");
  if (!mtfState) missingContext.push("MTF_STATE_CONTEXT");
  if (mtfAgreementScore == null) missingContext.push("MTF_SCORE_CONTEXT");
  if (!levelAcceptance || typeof levelAcceptance !== "object") {
    missingContext.push("LEVEL_ACCEPTANCE_CONTEXT");
  }
  if (dangerStackScore == null) missingContext.push("DANGER_STACK_CONTEXT");
  for (const check of missingContext) {
    mark(check, false, "FRAGILE_REVERSAL_CONTEXT_MISSING");
  }
  if (missingContext.length) {
    mark("CONTEXT_COMPLETE", false, "FRAGILE_REVERSAL_CONTEXT_MISSING");
    return baseResult({
      strategyId: id,
      strategyStyle: style,
      regime: regimeBucket,
      marketState: state,
      requiredChecks,
      passedChecks,
      failedChecks: uniq(["CONTEXT_MISSING", ...failedChecks]),
      minConfidenceRequired,
      confidenceUsed,
      mtfState,
      mtfAgreementScore,
      dteDays,
      dangerStackScore,
      levelRejectionDetected,
      sessionExtremeDetected,
      reasonCode: "FRAGILE_REVERSAL_CONTEXT_MISSING",
    });
  }
  mark("CONTEXT_COMPLETE", true, "FRAGILE_REVERSAL_CONTEXT_MISSING");

  if (id === "fakeout") {
    mark(
      "FAKEOUT_FAILED_BREAKOUT_STATE",
      state === "FAILED_BREAKOUT",
      "FRAGILE_REVERSAL_FAKEOUT_REQUIRES_FAILED_BREAKOUT",
    );
  }
  mark(
    "MIN_CONFIDENCE",
    confidenceUsed >= minConfidenceRequired,
    oneDte
      ? "FRAGILE_REVERSAL_ONE_DTE_LOW_CONFIDENCE"
      : "FRAGILE_REVERSAL_LOW_CONFIDENCE",
  );
  const mtfHardDisagreement =
    mtfState === "DISAGREEMENT" ||
    mtfState === "HARD_DISAGREEMENT" ||
    mtfBias === "CONFLICT";
  mark(
    "MTF_NOT_DISAGREEMENT",
    !blockOnMtfDisagreement || !mtfHardDisagreement,
    "FRAGILE_REVERSAL_MTF_DISAGREEMENT",
  );
  mark(
    "MIN_MTF_SCORE",
    mtfAgreementScore >= minMtfScore,
    "FRAGILE_REVERSAL_LOW_MTF_SCORE",
  );
  const rejectionConfirmed =
    id === "fakeout" ? strictFailedBreakoutRejection : levelRejectionDetected;
  mark(
    "LEVEL_REJECTION_CONFIRMED",
    !requireLevelRejection || rejectionConfirmed,
    "FRAGILE_REVERSAL_LEVEL_REJECTION_MISSING",
  );
  mark(
    "SESSION_EXTREME_CONFIRMED",
    !requireSessionExtreme || sessionExtremeDetected,
    "FRAGILE_REVERSAL_SESSION_EXTREME_MISSING",
  );
  mark(
    "DANGER_BELOW_THRESHOLD",
    dangerStackScore < dangerBelow,
    "FRAGILE_REVERSAL_DANGER_TOO_HIGH",
  );
  if (oneDte) {
    mark(
      "ONE_DTE_DANGER_BELOW_THRESHOLD",
      dangerStackScore <= oneDteMaxDanger,
      "FRAGILE_REVERSAL_ONE_DTE_DANGER_TOO_HIGH",
    );
  }

  const allowed = failedChecks.length === 0;
  return baseResult({
    strategyId: id,
    strategyStyle: style,
    regime: regimeBucket,
    marketState: state,
    requiredChecks,
    passedChecks,
    failedChecks,
    minConfidenceRequired,
    confidenceUsed,
    mtfState,
    mtfAgreementScore,
    dteDays,
    dangerStackScore,
    levelRejectionDetected,
    sessionExtremeDetected,
    reasonCode: allowed
      ? "FRAGILE_REVERSAL_CONFIRMED"
      : firstReasonCode || "FRAGILE_REVERSAL_NOT_CONFIRMED",
    allowed,
  });
}

module.exports = {
  FRAGILE_REVERSAL_STATES,
  RANGE_REVERSAL_STRATEGY_IDS,
  configuredFragileReversalStrategies,
  isFragileReversalState,
  isRangeReversalStrategy,
  isFragileReversalStrategyAllowed,
  normalizeStrategyId,
  parseStrategyList,
  resolveFragileReversalPermission,
};
