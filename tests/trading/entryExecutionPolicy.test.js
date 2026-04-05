const assert = require("node:assert/strict");
const {
  buildEntryUrgencyProfile,
  evaluateExecutionGate,
  evaluatePendingEntryState,
  evaluateStopFitCompression,
} = require("../../src/trading/entryExecutionPolicy");

const BASE_NOW = Date.parse("2026-01-01T09:15:00.000Z");

const env = {
  ENTRY_LADDER_TICKS: 2,
  ENTRY_LADDER_STEP_DELAY_MS: 350,
  ENTRY_LADDER_MAX_CHASE_BPS: 35,
  ENTRY_LADDER_STYLE_ENABLED: true,
  ENTRY_LADDER_URGENCY_BREAKOUT_MULT: 2.4,
  ENTRY_LADDER_URGENCY_OPEN_MULT: 2.0,
  ENTRY_LADDER_URGENCY_TREND_MULT: 1.6,
  ENTRY_LADDER_URGENCY_RANGE_MULT: 0.9,
  ENTRY_PENDING_REVALIDATE_AFTER_MS: 1500,
  ENTRY_PENDING_MAX_SPREAD_BPS: 45,
  ENTRY_PENDING_MAX_ADVERSE_UL_BPS: 12,
  ENTRY_PENDING_MAX_MS_BREAKOUT: 7000,
  ENTRY_PENDING_MAX_MS_OPEN: 9000,
  ENTRY_PENDING_MAX_MS_TREND: 12000,
  ENTRY_PENDING_MAX_MS_RANGE: 20000,
  ENTRY_WATCH_MS: 30000,
  EXEC_SIGNAL_MAX_AGE_MS: 5000,
  EXEC_MAX_PREMIUM_DRIFT_PCT: 1.0,
  EXEC_MAX_SPREAD_BPS: 45,
  EXEC_MAX_CHASE_STEPS: 3,
  EXEC_MAX_ENTRY_DEVIATION_PCT: 1.2,
  PRE_ENTRY_SL_COMPRESSION_ENABLED: true,
  PRE_ENTRY_SL_COMPRESSION_MAX_PCT: 0.1,
  PRE_ENTRY_SL_COMPRESSION_MAX_TICKS: 6,
  PRE_ENTRY_SL_COMPRESSION_ALLOW_OPEN: false,
  PRE_ENTRY_SL_COMPRESSION_REQUIRE_RR_FLOOR: true,
  PRE_ENTRY_SL_COMPRESSION_MIN_RR: 1.8,
  OPT_SL_FIT_MIN_DISTANCE_KEEP_PCT: 80,
};

function assertClose(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

const trendTrade = {
  side: "BUY",
  strategyId: "ema_pullback",
  strategyStyle: "TREND",
  expectedEntryPrice: 330.65,
  entryPlacedAt: new Date(BASE_NOW).toISOString(),
  underlying_ltp: 24000,
  instrument: {
    tick_size: 0.05,
    segment: "NFO-OPT",
    tradingsymbol: "NIFTY26JAN24000CE",
  },
};

const breakoutProfile = buildEntryUrgencyProfile({
  trade: { strategyId: "breakout", strategyStyle: "TREND" },
  env,
});
const trendProfile = buildEntryUrgencyProfile({ trade: trendTrade, env });

assert.equal(trendProfile.profileKey, "TREND");
assert.ok(trendProfile.ladderSteps > env.ENTRY_LADDER_TICKS);
assert.ok(trendProfile.stepDelayMs < env.ENTRY_LADDER_STEP_DELAY_MS);
assert.ok(breakoutProfile.ladderSteps > trendProfile.ladderSteps);
assert.ok(breakoutProfile.maxChaseBps > trendProfile.maxChaseBps);

const tickOnlyCompression = evaluateStopFitCompression({
  entryPrice: 100,
  originalStopLoss: 90,
  fittedStopLoss: 90.4,
  env,
  tickSize: 0.05,
  plannedTargetPrice: 120,
  rrTarget: 2.0,
  strategyStyle: "TREND",
});

assert.equal(tickOnlyCompression.ok, false);
assert.equal(tickOnlyCompression.reason, "SL_FIT_TICK_LIMIT");
assert.equal(tickOnlyCompression.maxCompressionPoints, null);
assertClose(tickOnlyCompression.maxCompressionPtsByTick, 0.3);
assertClose(tickOnlyCompression.maxCompressionPtsEffective, 0.3);
assert.equal(tickOnlyCompression.limitSourceUsed, "TICKS");

const pointsCapCompression = evaluateStopFitCompression({
  entryPrice: 100,
  originalStopLoss: 90,
  fittedStopLoss: 90.75,
  env: {
    ...env,
    PRE_ENTRY_SL_COMPRESSION_MAX_TICKS: 20,
    PRE_ENTRY_SL_COMPRESSION_MAX_POINTS: 0.6,
  },
  tickSize: 0.05,
  plannedTargetPrice: 120,
  rrTarget: 2.0,
  strategyStyle: "TREND",
});

assert.equal(pointsCapCompression.ok, false);
assert.equal(pointsCapCompression.reason, "SL_FIT_POINTS_LIMIT");
assertClose(pointsCapCompression.maxCompressionPoints, 0.6);
assertClose(pointsCapCompression.maxCompressionPtsByTick, 1.0);
assertClose(pointsCapCompression.maxCompressionPtsEffective, 0.6);
assert.equal(pointsCapCompression.limitSourceUsed, "POINTS");

const strictestActiveCompression = evaluateStopFitCompression({
  entryPrice: 100,
  originalStopLoss: 90,
  fittedStopLoss: 90.6,
  env: {
    ...env,
    PRE_ENTRY_SL_COMPRESSION_MAX_PCT: 0.05,
    PRE_ENTRY_SL_COMPRESSION_MAX_TICKS: 20,
    PRE_ENTRY_SL_COMPRESSION_MAX_POINTS: 0.8,
  },
  tickSize: 0.05,
  plannedTargetPrice: 120,
  rrTarget: 2.0,
  strategyStyle: "TREND",
});

assert.equal(strictestActiveCompression.ok, false);
assert.equal(strictestActiveCompression.reason, "SL_FIT_PCT_LIMIT");
assertClose(strictestActiveCompression.maxCompressionPtsByPct, 0.5);
assertClose(strictestActiveCompression.maxCompressionPtsByTick, 1.0);
assertClose(strictestActiveCompression.maxCompressionPoints, 0.8);
assertClose(strictestActiveCompression.maxCompressionPtsEffective, 0.5);
assert.equal(strictestActiveCompression.limitSourceUsed, "PCT");

const acceptedCompression = evaluateStopFitCompression({
  entryPrice: 100,
  originalStopLoss: 90,
  fittedStopLoss: 90.3,
  env: {
    ...env,
    PRE_ENTRY_SL_COMPRESSION_MAX_TICKS: 10,
    PRE_ENTRY_SL_COMPRESSION_MAX_POINTS: 0.6,
  },
  tickSize: 0.05,
  plannedTargetPrice: 120,
  rrTarget: 2.0,
  strategyStyle: "TREND",
});

assert.equal(acceptedCompression.ok, true);
assert.equal(acceptedCompression.reason, null);
assertClose(acceptedCompression.compressionPts, 0.3);
assertClose(acceptedCompression.maxCompressionPtsEffective, 0.5);
assert.equal(acceptedCompression.limitSourceUsed, "TICKS");

const spreadBlocked = evaluatePendingEntryState({
  trade: trendTrade,
  quote: { bid: 330.0, ask: 332.5, ltp: 331.2 },
  underlyingLtp: 24002,
  nowTs: BASE_NOW + 4_000,
  env,
  profile: trendProfile,
  currentOrderPrice: 330.7,
});

assert.equal(spreadBlocked.ok, false);
assert.equal(spreadBlocked.cancelReason, "ENTRY_SPREAD_WIDENED");

const driftBlocked = evaluatePendingEntryState({
  trade: trendTrade,
  quote: { bid: 332.4, ask: 333.0, ltp: 332.8 },
  underlyingLtp: 24002,
  nowTs: BASE_NOW + 4_000,
  env,
  profile: trendProfile,
  currentOrderPrice: 330.7,
});

assert.equal(driftBlocked.ok, false);
assert.equal(driftBlocked.cancelReason, "ENTRY_PRICE_DRIFT");

const edgeDecayBlocked = evaluatePendingEntryState({
  trade: trendTrade,
  quote: { bid: 330.6, ask: 330.75, ltp: 330.7 },
  underlyingLtp: 23960,
  nowTs: BASE_NOW + 4_000,
  env,
  profile: trendProfile,
  currentOrderPrice: 330.65,
});

assert.equal(edgeDecayBlocked.ok, false);
assert.equal(edgeDecayBlocked.cancelReason, "ENTRY_EDGE_DECAY");

const staleBlocked = evaluatePendingEntryState({
  trade: trendTrade,
  quote: { bid: 330.6, ask: 330.75, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 13_000,
  env,
  profile: trendProfile,
  currentOrderPrice: 330.65,
});

assert.equal(staleBlocked.ok, false);
assert.equal(staleBlocked.cancelReason, "ENTRY_PENDING_STALE");

const healthyReprice = evaluatePendingEntryState({
  trade: trendTrade,
  quote: { bid: 330.7, ask: 331.45, ltp: 331.1 },
  underlyingLtp: 24003,
  nowTs: BASE_NOW + 2_000,
  env,
  profile: trendProfile,
  currentOrderPrice: 330.7,
});

assert.equal(healthyReprice.ok, true);
assert.ok(Number(healthyReprice.targetPrice) > 330.7);
assert.ok(Number(healthyReprice.targetPrice) <= 332.55);

const staleSignalGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW).toISOString(),
  trade: { ...trendTrade, plannedEntry: 330.65 },
  quote: { bid: 330.6, ask: 330.8, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 6_000,
  env,
});

assert.equal(staleSignalGate.ok, false);
assert.equal(staleSignalGate.reasonCode, "EXEC_SIGNAL_STALE");
assert.equal(staleSignalGate.freshnessSource, "EVENT_TS");

const premiumDriftGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW).toISOString(),
  trade: { ...trendTrade, plannedEntry: 330.65 },
  quote: { bid: 333.6, ask: 334.05, ltp: 333.85 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 2_000,
  env,
});

assert.equal(premiumDriftGate.ok, false);
assert.equal(premiumDriftGate.reasonCode, "EXEC_PREMIUM_DRIFT_EXCEEDED");

const spreadGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW).toISOString(),
  trade: { ...trendTrade, plannedEntry: 330.65 },
  quote: { bid: 329.8, ask: 331.6, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 2_000,
  env,
});

assert.equal(spreadGate.ok, false);
assert.equal(spreadGate.reasonCode, "EXEC_SPREAD_EXCEEDED");

const chaseGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW).toISOString(),
  trade: { ...trendTrade, plannedEntry: 330.65 },
  quote: { bid: 331.0, ask: 331.3, ltp: 331.15 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 2_000,
  env,
  chaseStep: 4,
  candidateEntryPrice: 331.3,
});

assert.equal(chaseGate.ok, false);
assert.equal(chaseGate.reasonCode, "EXEC_CHASE_LIMIT_EXCEEDED");

const correctedFreshnessGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW - 60_000).toISOString(),
  trade: {
    ...trendTrade,
    plannedEntry: 330.65,
    signalCreatedAt: new Date(BASE_NOW + 1_500).toISOString(),
  },
  quote: { bid: 330.6, ask: 330.8, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 5_500,
  env: {
    ...env,
    MAX_EXECUTION_AGE_MS: 5_000,
    MAX_LATENCY_GRACE_MS: 3_000,
  },
});

assert.equal(correctedFreshnessGate.ok, true);
assert.equal(correctedFreshnessGate.freshnessSource, "CREATED_AT");
assert.ok(correctedFreshnessGate.signalAgeMs < 5_000);

const decisionFreshnessGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW - 60_000).toISOString(),
  trade: {
    ...trendTrade,
    plannedEntry: 330.65,
    signalDecisionTs: new Date(BASE_NOW + 2_000).toISOString(),
  },
  quote: { bid: 330.6, ask: 330.8, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 5_500,
  env: {
    ...env,
    MAX_EXECUTION_AGE_MS: 5_000,
    MAX_LATENCY_GRACE_MS: 3_000,
  },
});

assert.equal(decisionFreshnessGate.ok, true);
assert.equal(decisionFreshnessGate.freshnessSource, "DECISION_TS");
assert.ok(decisionFreshnessGate.signalAgeMs < 5_000);

const latencyGraceGate = evaluateExecutionGate({
  signalTs: new Date(BASE_NOW - 60_000).toISOString(),
  trade: {
    ...trendTrade,
    plannedEntry: 330.65,
    signalCreatedAt: new Date(BASE_NOW).toISOString(),
    entryPipelineLatency: { totalAgeMs: 4_500 },
  },
  quote: { bid: 330.6, ask: 330.8, ltp: 330.7 },
  underlyingLtp: 24001,
  nowTs: BASE_NOW + 8_500,
  env: {
    ...env,
    MAX_EXECUTION_AGE_MS: 5_000,
    MAX_LATENCY_GRACE_MS: 5_000,
  },
});

assert.equal(latencyGraceGate.ok, true);
assert.equal(latencyGraceGate.latencyGraceApplied, true);

console.log("entryExecutionPolicy.test.js passed");
