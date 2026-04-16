const assert = require("node:assert/strict");
const {
  buildCompressionTelemetryMeta,
  TradeManager,
  evaluatePreRouteTradability,
  evaluatePreRouteConfidenceGate,
  resolvePostRouteConfidenceDecision,
  shouldAllowMultiTfTrendTransitionPass,
  resolveMinLotRiskPolicyDecision,
  resolvePreEntrySlFitDecision,
  resolvePreRouteConfidenceAllowance,
} = require("../../src/trading/tradeManager");

const defaultAllowance = resolvePreRouteConfidenceAllowance({});
assert.equal(defaultAllowance, 14);
assert.equal(
  resolvePreRouteConfidenceAllowance({
    OPT_PRE_ROUTE_MAX_CONF_BOOST: 9,
  }),
  9,
);
assert.equal(
  resolvePreRouteConfidenceAllowance({
    OPT_PRE_ROUTE_MAX_CONF_BOOST: 30,
  }),
  22,
);

const blockedPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 60,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(blockedPreRouteGate.preRouteAllowanceUsed, 14);
assert.equal(blockedPreRouteGate.conf, 60);
assert.equal(blockedPreRouteGate.minConf, 75);
assert.equal(blockedPreRouteGate.routeConfidenceDecision, "SOFT_PENALTY");
assert.equal(blockedPreRouteGate.blocked, false);
assert.ok(blockedPreRouteGate.softPenaltyApplied >= 2);

const passPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 61,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(passPreRouteGate.blocked, false);
assert.equal(passPreRouteGate.routeConfidenceDecision, "PASS");

const hardRejectPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 22,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(hardRejectPreRouteGate.blocked, true);
assert.equal(hardRejectPreRouteGate.routeConfidenceDecision, "HARD_REJECT");

const likelyNonTradable = evaluatePreRouteTradability({
  signal: { strategyStyle: "TREND" },
  underlying: "NIFTY",
  lotSize: 50,
  riskBudgetInr: 1800,
  config: {
    FNO_MIN_LOT_POLICY: "STRICT",
    OPT_MIN_PREMIUM_NIFTY: 250,
    OPT_MAX_PREMIUM_NIFTY: 500,
    OPT_SL_MODE: "PREMIUM_PCT",
    OPT_SL_PCT: 12,
    OPT_DELTA_BAND_MIN: 0.35,
    OPT_DELTA_BAND_MAX: 0.65,
    OPT_DELTA_TARGET: 0.65,
    EXPECTED_SLIPPAGE_POINTS: 0,
    EXPECTED_FEES_PER_LOT_INR: 0,
  },
});

assert.equal(likelyNonTradable.blocked, true);
assert.equal(likelyNonTradable.reasonCode, "OPTION_EXPRESSION_NOT_TRADABLE");
assert.equal(likelyNonTradable.tradabilityState, "LIKELY_UNTRADABLE");
assert.ok(likelyNonTradable.meta.estimatedOneLotRiskInr > 1800);
assert.equal(likelyNonTradable.meta.lotSize, 50);

const postRouteConfidence = TradeManager.prototype._finalOptionSignalConfidence.call(
  {},
  {
    baseConfidence: 60,
    liqMeta: {
      healthScore: 95,
      spreadBps: 20,
    },
  },
);
assert.equal(postRouteConfidence, 69);

const softPassPostRoute = resolvePostRouteConfidenceDecision({
  signal: {
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    option_meta: {
      bps: 18,
      health_score: 74,
      depth: 42,
    },
    routeConfidence: {
      preRouteScore: 78,
      expectedRouteAdjustment: -6,
      routedScore: 72,
      contractMetrics: {
        spreadBps: 18,
        healthScore: 74,
        depth: 42,
        selectedByFallback: false,
      },
    },
  },
  conf: 72,
  minConf: 75,
  config: {
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 4,
    OPT_MAX_SPREAD_BPS: 35,
    OPT_HEALTH_SCORE_MIN: 45,
  },
});

assert.equal(softPassPostRoute.blocked, false);
assert.equal(softPassPostRoute.adjusted, true);
assert.equal(
  softPassPostRoute.reasonCode,
  "POST_ROUTE_CONFIDENCE_SOFT_PASS",
);
assert.equal(softPassPostRoute.postRouteDecision, "SOFT_PASS");
assert.equal(softPassPostRoute.meta.confidenceGap, 3);
assert.equal(softPassPostRoute.meta.routedScore, 72);
assert.equal(softPassPostRoute.meta.softPassUsed, true);
assert.equal(
  softPassPostRoute.meta.softPassProfile,
  "trend_near_threshold_clean_contract",
);
assert.equal(softPassPostRoute.meta.contractQualityBucket, "USABLE");

const hardRejectPostRoute = resolvePostRouteConfidenceDecision({
  signal: {
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    option_meta: {
      bps: 52,
      health_score: 41,
      depth: 4,
      meta: {
        selectionObservability: {
          selectedByFallback: true,
          fallbackReason: "WIDE_SPREAD_FALLBACK",
        },
      },
    },
    routeConfidence: {
      preRouteScore: 78,
      expectedRouteAdjustment: -6,
      routedScore: 72,
      contractMetrics: {
        spreadBps: 52,
        healthScore: 41,
        depth: 4,
        selectedByFallback: true,
        fallbackReason: "WIDE_SPREAD_FALLBACK",
      },
    },
  },
  conf: 72,
  minConf: 75,
  config: {
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 4,
    OPT_MAX_SPREAD_BPS: 35,
    OPT_HEALTH_SCORE_MIN: 45,
  },
});

assert.equal(hardRejectPostRoute.blocked, true);
assert.equal(hardRejectPostRoute.adjusted, false);
assert.equal(hardRejectPostRoute.reasonCode, "POST_ROUTE_LOW_CONFIDENCE");

const mtfTransitionPass = shouldAllowMultiTfTrendTransitionPass({
  strategyId: "breakout",
  signal: {
    strategyId: "breakout",
    confidence: 79,
    setupState: "TRIGGERED",
    meta: {
      freshness: 88,
      setupState: "TRIGGERED",
      retestState: "FIRST_BREAK",
      triggerType: "BREAKOUT_LEVEL",
      volumeQuality: 74,
      structureQuality: 78,
      boundaryQuality: 76,
      expansionQuality: 75,
    },
  },
  regimeMeta: {
    regime: "TREND_COMPRESSED",
    secondaryRegime: "BREAKOUT_WATCH",
    compressionActive: true,
  },
  multiTfMeta: {
    strengthBps: 14,
  },
  config: {
    MULTI_TF_TRANSITION_MAX_OPPOSITE_BPS: 22,
    MULTI_TF_TRANSITION_MIN_FRESHNESS: 82,
    MULTI_TF_TRANSITION_MIN_CONFIDENCE: 74,
    MULTI_TF_TRANSITION_MIN_STRUCTURE_QUALITY: 72,
    MULTI_TF_TRANSITION_MIN_VOLUME_QUALITY: 68,
    MULTI_TF_TRANSITION_MIN_BOUNDARY_QUALITY: 70,
    MULTI_TF_TRANSITION_MIN_EXPANSION_QUALITY: 70,
  },
});

assert.equal(mtfTransitionPass.allowed, true);
assert.equal(mtfTransitionPass.reason, "MULTI_TF_TREND_TRANSITION_PASS");
assert.equal(mtfTransitionPass.meta.mtfStrengthBps, 14);
assert.equal(mtfTransitionPass.meta.transitionPassProfile, "breakout_transition");
assert.equal(mtfTransitionPass.meta.mismatchStrengthBucket, "MODERATE");

const mtfTransitionBlocked = shouldAllowMultiTfTrendTransitionPass({
  strategyId: "breakout",
  signal: {
    strategyId: "breakout",
    confidence: 79,
    setupState: "TRIGGERED",
    meta: {
      freshness: 88,
      setupState: "TRIGGERED",
      retestState: "FIRST_BREAK",
      triggerType: "BREAKOUT_LEVEL",
      volumeQuality: 74,
      structureQuality: 78,
      boundaryQuality: 76,
      expansionQuality: 75,
    },
  },
  regimeMeta: {
    regime: "TREND_COMPRESSED",
    secondaryRegime: "BREAKOUT_WATCH",
    compressionActive: true,
  },
  multiTfMeta: {
    strengthBps: 34,
  },
  config: {
    MULTI_TF_TRANSITION_MAX_OPPOSITE_BPS: 22,
  },
});

assert.equal(mtfTransitionBlocked.allowed, false);
assert.equal(mtfTransitionBlocked.reason, "TRANSITION_GATES_FAILED");
assert.equal(mtfTransitionBlocked.meta.mtfStrengthBps, 34);
assert.equal(mtfTransitionBlocked.meta.mismatchStrengthBucket, "STRONG");

const capBlockedSkip = resolvePreEntrySlFitDecision({
  config: {
    PRE_ENTRY_SL_COMPRESSION_ENABLED: true,
    OPT_SL_FIT_ENABLED: false,
    OPT_SL_FIT_WHEN_CAP_BLOCKS: false,
  },
  optionMeta: { underlying: "NIFTY" },
  lotSize: 50,
  strategyRiskFit: { fitsMinTradable: false },
});

assert.deepEqual(capBlockedSkip, {
  strategyFitsMinTradable: false,
  slFitEnabled: true,
  slFitWhenCapBlocks: false,
  compressionAttempted: false,
  compressionSkipReason: "CAP_BLOCK_COMPRESSION_DISABLED",
});

const capBlockedAttempt = resolvePreEntrySlFitDecision({
  config: {
    PRE_ENTRY_SL_COMPRESSION_ENABLED: true,
    OPT_SL_FIT_ENABLED: false,
    OPT_SL_FIT_WHEN_CAP_BLOCKS: true,
  },
  optionMeta: { underlying: "NIFTY" },
  lotSize: 50,
  strategyRiskFit: { fitsMinTradable: false },
});

assert.equal(capBlockedAttempt.strategyFitsMinTradable, false);
assert.equal(capBlockedAttempt.slFitEnabled, true);
assert.equal(capBlockedAttempt.slFitWhenCapBlocks, true);
assert.equal(capBlockedAttempt.compressionAttempted, true);
assert.equal(capBlockedAttempt.compressionSkipReason, null);

assert.deepEqual(
  resolveMinLotRiskPolicyDecision({
    config: {
      ALLOW_ONE_LOT_RISK_BUFFER_PCT: 10,
      FNO_MIN_LOT_POLICY: "STRICT",
    },
    lotSize: 50,
    riskBudgetInr: 1800,
    strategyRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 1960,
      breachPct: 8.89,
    },
    sizingRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 1960,
      breachPct: 8.89,
    },
    riskFitMode: "FIT",
    minLotPolicy: "STRICT",
  }),
  {
    allowOneLot: true,
    hardReject: false,
    riskFitDecision: "BREACH_ALLOWED",
    riskFitMode: "BUFFER_ALLOWED",
    riskBreachState: "SOFT",
    originalRiskInr: 1960,
    adjustedRiskInr: 1960,
    riskBreachPct: 8.89,
    riskBreachTag: "RISK_BREACH_ALLOWED",
    bufferPctAllowed: 10,
  },
);

assert.deepEqual(
  resolveMinLotRiskPolicyDecision({
    config: {
      ALLOW_ONE_LOT_RISK_BUFFER_PCT: 10,
      FNO_MIN_LOT_POLICY: "STRICT",
    },
    lotSize: 50,
    riskBudgetInr: 1800,
    strategyRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2400,
      breachPct: 33.33,
    },
    sizingRiskFit: {
      fitsMinTradable: true,
      oneLotAllInRiskInr: 1760,
      breachPct: 0,
    },
    riskFitMode: "COMPRESSED_FIT",
    minLotPolicy: "STRICT",
  }),
  {
    allowOneLot: false,
    hardReject: false,
    riskFitDecision: "COMPRESSED",
    riskFitMode: "COMPRESSED_FIT",
    riskBreachState: "NONE",
    originalRiskInr: 2400,
    adjustedRiskInr: 1760,
    riskBreachPct: 0,
    riskBreachTag: null,
    bufferPctAllowed: 10,
  },
);

assert.deepEqual(
  resolveMinLotRiskPolicyDecision({
    config: {
      ALLOW_ONE_LOT_RISK_BUFFER_PCT: 10,
      FNO_MIN_LOT_POLICY: "STRICT",
    },
    lotSize: 50,
    riskBudgetInr: 1800,
    strategyRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2400,
      breachPct: 33.33,
    },
    sizingRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2300,
      breachPct: 27.78,
    },
    riskFitMode: "FIT",
    minLotPolicy: "STRICT",
  }),
  {
    allowOneLot: false,
    hardReject: true,
    riskFitDecision: "REJECT",
    riskFitMode: "FIT",
    riskBreachState: "NONE",
    originalRiskInr: 2400,
    adjustedRiskInr: 2300,
    riskBreachPct: 27.78,
    riskBreachTag: null,
    bufferPctAllowed: 10,
  },
);

assert.deepEqual(
  buildCompressionTelemetryMeta({
    compressionPts: 0.6,
    maxCompressionPct: 10,
    maxCompressionTicks: 6,
    maxCompressionPoints: 0.75,
    maxCompressionPtsByTick: 0.3,
    maxCompressionPtsEffective: 0.3,
    limitSourceUsed: "TICKS",
  }),
  {
    compressionPts: 0.6,
    maxCompressionPct: 10,
    maxCompressionTicks: 6,
    maxCompressionPoints: 0.75,
    maxCompressionPtsByTick: 0.3,
    maxCompressionPtsEffective: 0.3,
    limitSourceUsed: "TICKS",
  },
);

assert.deepEqual(buildCompressionTelemetryMeta(null), {
  compressionPts: null,
  maxCompressionPct: null,
  maxCompressionTicks: null,
  maxCompressionPoints: null,
  maxCompressionPtsByTick: null,
  maxCompressionPtsEffective: null,
  limitSourceUsed: null,
});

console.log("tradeManagerAdmission.test.js passed");
