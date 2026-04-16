const assert = require("node:assert/strict");

const { TradeTelemetry } = require("../../src/telemetry/tradeTelemetry");

function approxEqual(actual, expected, epsilon = 0.001) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

const telemetry = new TradeTelemetry({
  enabled: true,
  flushSec: 0,
  ringSize: 32,
});

telemetry.recordDecision({
  outcome: "RECEIVED",
  stage: "signal",
  reason: "RECEIVED",
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "route",
  reason: "PRE_ROUTE_LOW_CONFIDENCE",
});
telemetry.recordDecision({
  outcome: "ADJUSTED",
  stage: "admission",
  reason: "POST_ROUTE_CONFIDENCE_SOFT_PASS",
  meta: {
    strategyId: "ema_pullback",
    family: "ema_pullback",
    plannerPathUsed: "MIXED_ASSIST",
    plannerFallbackReason: "OPTION_PREMIUM_MAPPING_FALLBACK",
    conf: 72,
    minConf: 75,
    confidenceGap: 3,
    expectedRouteAdjustment: -5,
    routedScore: 72,
  },
});
telemetry.recordDecision({
  outcome: "ADJUSTED",
  stage: "admission",
  reason: "MULTI_TF_TREND_TRANSITION_PASS",
  meta: {
    mtfStrengthBps: 14,
  },
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "admission",
  reason: "POST_ROUTE_LOW_CONFIDENCE",
  meta: {
    conf: 69,
    minConf: 75,
    confidenceGap: 6,
    expectedRouteAdjustment: -8,
    routedScore: 69,
  },
});
telemetry.recordDecision({
  outcome: "ADJUSTED",
  stage: "risk_fit",
  reason: "COMPRESSED",
  meta: {
    riskFitDecision: "COMPRESSED",
    originalRiskInr: 2400,
    adjustedRiskInr: 1760,
    breachPct: 0,
    compressionAppliedPct: 8,
    riskFitMode: "COMPRESSED_FIT",
  },
});
telemetry.recordDecision({
  outcome: "ADJUSTED",
  stage: "risk_fit",
  reason: "BREACH_ALLOWED",
  meta: {
    riskFitDecision: "BREACH_ALLOWED",
    originalRiskInr: 1960,
    adjustedRiskInr: 1960,
    breachPct: 8.89,
    riskFitMode: "BUFFER_ALLOWED",
  },
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "risk_fit",
  reason: "MIN_LOT_RISK_REJECT",
  meta: {
    strategyId: "ema_pullback",
    family: "ema_pullback",
    plannerPathUsed: "MIXED_ASSIST",
    plannerFallbackReason: "OPTION_PREMIUM_MAPPING_FALLBACK",
    riskFitDecision: "REJECT",
    originalRiskInr: 2400,
    adjustedRiskInr: 2300,
    breachPct: 27.78,
    riskFitMode: "FIT",
  },
});
telemetry.recordDecision({
  outcome: "READY_FOR_EXECUTION",
  stage: "entry",
  reason: "READY_FOR_EXECUTION",
  meta: {
    strategyId: "breakout",
    family: "breakout",
    plannerPathUsed: "MODERN",
  },
});
telemetry.recordDecision({
  outcome: "ENTRY_PLACED",
  stage: "entry",
  reason: "ENTRY_PLACED",
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "admission",
  reason: "STRATEGY_COOLDOWN",
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "planner",
  reason: "TARGET_BELOW_MIN_RR",
  meta: {
    strategyId: "orb",
    family: "orb",
    plannerPathUsed: "LEGACY_FALLBACK",
    plannerFallbackReason: "RICH_CONTEXT_INCOMPLETE",
  },
});
telemetry.recordDecision({
  outcome: "BLOCKED",
  stage: "admission",
  reason: "STRATEGY_COOLDOWN",
});

const snapshot = telemetry.snapshot();

assert.deepEqual(snapshot.blockerFunnel, {
  received: 1,
  blockedPreRouteConfidence: 1,
  blockedPostRouteConfidence: 1,
  softPassedPostRouteConfidence: 1,
  multiTfTransitionPassed: 1,
  blockedPlanner: 1,
  plannerFallbackCount: 2,
  readinessBlockedStale: 0,
  readinessBlockedIncomplete: 0,
  blockedRiskFit: 1,
  compressedRiskFit: 1,
  breachAllowedRiskFit: 1,
  readyForExecution: 1,
  entryPlaced: 1,
});

assert.equal(snapshot.blockerReasonsTop.PRE_ROUTE_LOW_CONFIDENCE, 1);
assert.equal(snapshot.blockerReasonsTop.POST_ROUTE_CONFIDENCE_SOFT_PASS, 1);
assert.equal(snapshot.blockerReasonsTop.POST_ROUTE_LOW_CONFIDENCE, 1);
assert.equal(snapshot.blockerReasonsTop.COMPRESSED, 1);
assert.equal(snapshot.blockerReasonsTop.BREACH_ALLOWED, 1);
assert.equal(snapshot.blockerReasonsTop.MIN_LOT_RISK_REJECT, 1);
assert.equal(snapshot.blockerReasonsTop.MULTI_TF_TREND_TRANSITION_PASS, 1);
assert.equal(snapshot.blockerReasonsTop.TARGET_BELOW_MIN_RR, 1);
assert.equal(snapshot.blockerReasonsTop.STRATEGY_COOLDOWN, 2);
assert.equal(Object.keys(snapshot.blockerReasonsTop)[0], "STRATEGY_COOLDOWN");
assert.equal(snapshot.finalBlockerReasonByFamily["UNKNOWN|STRATEGY_COOLDOWN"], 2);
assert.equal(snapshot.finalBlockerReasonByStrategy["UNKNOWN|STRATEGY_COOLDOWN"], 2);
assert.equal(snapshot.plannerPathStats.countsByPath.MODERN, 1);
assert.equal(snapshot.plannerPathStats.countsByPath.LEGACY_FALLBACK, 1);
assert.equal(snapshot.plannerPathStats.countsByPath.MIXED_ASSIST, 1);
assert.equal(snapshot.plannerPathStats.acceptedByPath.MODERN, 1);
assert.equal(snapshot.plannerPathStats.blockedByPath.LEGACY_FALLBACK, 1);
assert.equal(snapshot.plannerPathStats.blockedByPath.MIXED_ASSIST, 1);
assert.equal(
  snapshot.plannerPathStats.fallbackReasonCounts.RICH_CONTEXT_INCOMPLETE,
  1,
);
assert.equal(
  snapshot.plannerPathStats.fallbackReasonCounts.OPTION_PREMIUM_MAPPING_FALLBACK,
  1,
);
assert.equal(snapshot.plannerPathStats.byStrategy["breakout|MODERN"], 1);
assert.equal(snapshot.plannerPathStats.byStrategy["orb|LEGACY_FALLBACK"], 1);
assert.equal(snapshot.plannerPathStats.byFamily["ema_pullback|MIXED_ASSIST"], 1);

assert.equal(snapshot.postRouteStats.hardBlockedCount, 1);
assert.equal(snapshot.postRouteStats.softPassCount, 1);
approxEqual(snapshot.postRouteStats.avgConfidenceGap, 4.5);
approxEqual(snapshot.postRouteStats.avgExpectedRouteAdjustment, -6.5);
approxEqual(snapshot.postRouteStats.avgRoutedScore, 70.5);

assert.equal(snapshot.riskFitStats.rejectCount, 1);
assert.equal(snapshot.riskFitStats.compressedCount, 1);
assert.equal(snapshot.riskFitStats.breachAllowedCount, 1);
approxEqual(snapshot.riskFitStats.avgOriginalRiskInr, 2253.333);
approxEqual(snapshot.riskFitStats.avgAdjustedRiskInr, 2006.667);
approxEqual(snapshot.riskFitStats.avgBreachPct, 12.223);

telemetry.recordTradeClose({
  tradeId: "T-ALC-1",
  strategyId: "breakout",
  side: "BUY",
  closeReason: "ALC_EXIT_NOW",
  grossPnlInr: -120,
  estCostInr: 18,
  netAfterEstCostsInr: -138,
  feeMultiple: -6.666,
  alcAction: "EXIT_NOW",
  alcDesiredAction: "EXIT_NOW",
  alcRequested: true,
  alcRequestedLevel: "EXIT",
  alcTargetState: "EXIT",
  alcAppliedConfirmed: true,
  alcAppliedLevel: "EXIT",
  alcAppliedSource: "ALC_EXIT_NOW",
  alcAppliedState: "EXIT",
  alcAttributionConfidence: "HIGH",
  alcRequestedButNotApplied: false,
  alcAppliedButSuperseded: false,
  alcSupersededBy: null,
  alcFinalProtectionOwner: "ALC_EXIT_NOW",
  alcRetryCount: 2,
  alcSavedRiskR: 0.5,
  alcSavedRiskInr: 250,
  alcBlockedReason: "ALC_BLOCKED_PENDING_MODIFY",
  regime: "TREND",
  spreadRegime: "WIDE",
});

telemetry.recordTradeClose({
  tradeId: "T-ALC-2",
  strategyId: "orb",
  side: "SELL",
  closeReason: "GREEN_LOCK",
  grossPnlInr: 75,
  estCostInr: 12,
  netAfterEstCostsInr: 63,
  feeMultiple: 6.25,
  alcAction: "COMPRESS_L1",
  alcDesiredAction: "COMPRESS_L1",
  alcRequested: true,
  alcRequestedLevel: "L1",
  alcTargetState: "L1",
  alcAppliedConfirmed: true,
  alcAppliedLevel: "L1",
  alcAppliedSource: "ALC_L1",
  alcAppliedState: "L1",
  alcAttributionConfidence: "LOW",
  alcRequestedButNotApplied: false,
  alcAppliedButSuperseded: true,
  alcSupersededBy: "GREEN_LOCK",
  alcFinalProtectionOwner: "GREEN_LOCK",
  alcRetryCount: 1,
  alcSavedRiskR: 0.25,
  alcSavedRiskInr: 125,
  regime: "MEAN_REVERT",
  spreadRegime: "MID",
});

telemetry.recordTradeClose({
  tradeId: "T-ALC-3",
  strategyId: "ema_pullback",
  side: "BUY",
  closeReason: "HARD_SL",
  grossPnlInr: -80,
  estCostInr: 10,
  netAfterEstCostsInr: -90,
  feeMultiple: -8,
  alcAction: "COMPRESS_L2",
  alcDesiredAction: "COMPRESS_L2",
  alcRequested: true,
  alcRequestedLevel: "L2",
  alcTargetState: "L2",
  alcAppliedConfirmed: false,
  alcAppliedLevel: null,
  alcAppliedSource: null,
  alcAppliedState: "NONE",
  alcAttributionConfidence: null,
  alcRequestedButNotApplied: true,
  alcAppliedButSuperseded: false,
  alcSupersededBy: null,
  alcFinalProtectionOwner: "HARD_SL",
  alcRetryCount: 1,
  alcSavedRiskR: null,
  alcSavedRiskInr: null,
  alcBlockedReason: "ALC_BLOCKED_PENDING_MODIFY",
  regime: "TREND",
  spreadRegime: "TIGHT",
});

const alcSnapshot = telemetry.snapshot();
assert.equal(alcSnapshot.alcSummary.triggeredCount, 3);
assert.equal(alcSnapshot.alcSummary.l1Count, 1);
assert.equal(alcSnapshot.alcSummary.l2Count, 1);
assert.equal(alcSnapshot.alcSummary.exitNowCount, 1);
assert.equal(alcSnapshot.alcSummary.retryCount, 4);
assert.equal(alcSnapshot.alcSummary.appliedConfirmedCount, 2);
assert.equal(alcSnapshot.alcSummary.requestedButNotAppliedCount, 1);
assert.equal(alcSnapshot.alcSummary.supersededCount, 1);
assert.equal(alcSnapshot.alcSummary.attributionLowConfidenceCount, 1);
approxEqual(alcSnapshot.alcSummary.savedRiskR, 0.75);
approxEqual(alcSnapshot.alcSummary.savedRiskInr, 375);
assert.equal(
  alcSnapshot.alcSummary.blockedCountByReason.ALC_BLOCKED_PENDING_MODIFY,
  2,
);
assert.equal(
  alcSnapshot.alcSummary.actionByStrategy["breakout|EXIT_NOW"],
  1,
);
assert.equal(
  alcSnapshot.alcSummary.actionByStrategy["orb|COMPRESS_L1"],
  1,
);
assert.equal(
  alcSnapshot.alcSummary.actionByRegime["TREND|EXIT_NOW"],
  1,
);
assert.equal(
  alcSnapshot.alcSummary.actionByRegime["MEAN_REVERT|COMPRESS_L1"],
  1,
);
assert.equal(
  alcSnapshot.alcSummary.actionBySpreadRegime["WIDE|EXIT_NOW"],
  1,
);
assert.equal(
  alcSnapshot.alcSummary.supersededBy.GREEN_LOCK,
  1,
);
assert.equal(
  alcSnapshot.alcSummary.finalProtectionOwner.GREEN_LOCK,
  1,
);

const compactTelemetry = new TradeTelemetry({
  enabled: true,
  flushSec: 0,
  ringSize: 32,
});

for (let index = 0; index < 12; index += 1) {
  compactTelemetry.recordDecision({
    outcome: "BLOCKED",
    stage: "admission",
    reason: `REASON_${index}`,
  });
}

const compactSnapshot = compactTelemetry.snapshot();
assert.equal(Object.keys(compactSnapshot.blockerReasonsTop).length, 10);

console.log("tradeTelemetry.test.js passed");
