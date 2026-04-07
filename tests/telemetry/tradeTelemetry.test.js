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
    conf: 72,
    minConf: 75,
    confidenceGap: 3,
    expectedRouteAdjustment: -5,
    routedScore: 72,
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
  stage: "admission",
  reason: "STRATEGY_COOLDOWN",
});

const snapshot = telemetry.snapshot();

assert.deepEqual(snapshot.blockerFunnel, {
  received: 1,
  blockedPreRouteConfidence: 1,
  blockedPostRouteConfidence: 1,
  softPassedPostRouteConfidence: 1,
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
assert.equal(snapshot.blockerReasonsTop.STRATEGY_COOLDOWN, 2);
assert.equal(Object.keys(snapshot.blockerReasonsTop)[0], "STRATEGY_COOLDOWN");

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
