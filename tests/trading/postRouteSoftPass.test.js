const assert = require("node:assert/strict");

const {
  resolvePostRouteConfidenceDecision,
} = require("../../src/trading/tradeManager");
const {
  buildSignalConversionSummary,
} = require("../../src/strategy/signalLifecycle");

const healthySignal = {
  signalId: "sig-soft-pass",
  strategyId: "ema_pullback",
  side: "BUY",
  confidence: 72,
  option_meta: {
    instrument_token: 12345,
    underlying: "NIFTY",
    optType: "CE",
    strike: 22500,
    expiry: "2026-04-09",
    bps: 18,
    health_score: 74,
    depth: 42,
    meta: {
      selectionObservability: {
        ok: true,
        eligibilityPassed: true,
        minEligibilityChecksPassed: true,
        selectedByFallback: false,
        fallbackReason: null,
        selectedReason: "PRIMARY_ELIGIBLE",
      },
    },
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
      fallbackReason: null,
      eligibilityPassed: true,
      minEligibilityChecksPassed: true,
      selectedReason: "PRIMARY_ELIGIBLE",
    },
  },
};

const softPass = resolvePostRouteConfidenceDecision({
  signal: healthySignal,
  conf: 72,
  minConf: 75,
  config: {
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 4,
    OPT_MAX_SPREAD_BPS: 35,
    OPT_HEALTH_SCORE_MIN: 45,
  },
});

assert.equal(softPass.blocked, false);
assert.equal(softPass.adjusted, true);
assert.equal(softPass.reasonCode, "POST_ROUTE_CONFIDENCE_SOFT_PASS");
assert.equal(softPass.postRouteDecision, "SOFT_PASS");
assert.equal(softPass.meta.confidenceGap, 3);

const nearThresholdSoftPass = resolvePostRouteConfidenceDecision({
  signal: {
    ...healthySignal,
    confidence: 70,
    routeConfidence: {
      ...healthySignal.routeConfidence,
      routedScore: 70,
      contractMetrics: {
        ...healthySignal.routeConfidence.contractMetrics,
        spreadBps: 18,
        healthScore: 74,
        depth: 42,
        selectedByFallback: false,
      },
    },
  },
  conf: 70,
  minConf: 75,
  config: {
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 4,
    OPT_MAX_SPREAD_BPS: 35,
    OPT_HEALTH_SCORE_MIN: 45,
  },
});

assert.equal(nearThresholdSoftPass.blocked, false);
assert.equal(nearThresholdSoftPass.adjusted, true);
assert.equal(
  nearThresholdSoftPass.reasonCode,
  "POST_ROUTE_CONFIDENCE_SOFT_PASS",
);
assert.equal(
  nearThresholdSoftPass.meta.softPassReason,
  "TREND_NEAR_THRESHOLD_CLEAN_CONTRACT",
);

const conversionSummary = buildSignalConversionSummary(healthySignal, {
  routeAttempted: true,
  postRouteDecision: softPass.postRouteDecision,
  routedConfidence: softPass.meta.routedScore,
});

assert.equal(conversionSummary.postRouteDecision, "SOFT_PASS");
assert.equal(conversionSummary.routedConfidence, 72);

const compatibilityPoorReject = resolvePostRouteConfidenceDecision({
  signal: {
    ...healthySignal,
    option_meta: {
      ...healthySignal.option_meta,
      meta: {
        selectionObservability: {
          ok: false,
          eligibilityPassed: false,
          minEligibilityChecksPassed: false,
          selectedByFallback: true,
          fallbackReason: "ROUTER_RELAXATION",
          selectedReason: "FAILED_ELIGIBILITY",
        },
      },
    },
    routeConfidence: {
      ...healthySignal.routeConfidence,
      contractMetrics: {
        ...healthySignal.routeConfidence.contractMetrics,
        selectedByFallback: true,
        fallbackReason: "ROUTER_RELAXATION",
        eligibilityPassed: false,
        minEligibilityChecksPassed: false,
        selectedReason: "FAILED_ELIGIBILITY",
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

assert.equal(compatibilityPoorReject.blocked, true);
assert.equal(compatibilityPoorReject.adjusted, false);
assert.equal(
  compatibilityPoorReject.reasonCode,
  "POST_ROUTE_LOW_CONFIDENCE",
);

const wideSpreadNearThresholdReject = resolvePostRouteConfidenceDecision({
  signal: {
    ...healthySignal,
    confidence: 70,
    option_meta: {
      ...healthySignal.option_meta,
      bps: 52,
      health_score: 74,
      depth: 42,
    },
    routeConfidence: {
      ...healthySignal.routeConfidence,
      routedScore: 70,
      contractMetrics: {
        ...healthySignal.routeConfidence.contractMetrics,
        spreadBps: 52,
        healthScore: 74,
        depth: 42,
        selectedByFallback: false,
      },
    },
  },
  conf: 70,
  minConf: 75,
  config: {
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 4,
    OPT_MAX_SPREAD_BPS: 35,
    OPT_HEALTH_SCORE_MIN: 45,
  },
});

assert.equal(wideSpreadNearThresholdReject.blocked, true);
assert.equal(wideSpreadNearThresholdReject.adjusted, false);
assert.equal(wideSpreadNearThresholdReject.reasonCode, "POST_ROUTE_LOW_CONFIDENCE");

console.log("postRouteSoftPass.test.js passed");
