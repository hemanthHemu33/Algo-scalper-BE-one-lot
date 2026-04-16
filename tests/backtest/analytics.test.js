const assert = require("node:assert/strict");

const {
  buildMetrics,
  normalizeBacktestTrade,
} = require("../../src/backtest/analytics");

const rawTrades = [
  {
    tradeId: "bt-alc-applied",
    strategyId: "breakout",
    regime: "TREND",
    side: "BUY",
    signalTs: "2026-01-01T09:15:00.000Z",
    entryFilledAt: "2026-01-01T09:16:00.000Z",
    exitTs: "2026-01-01T09:24:00.000Z",
    entryPrice: 100,
    exitPrice: 94,
    initialStopLoss: 90,
    executionRiskInr: 1000,
    grossPnl: -120,
    costs: 20,
    netPnl: -140,
    exitReason: "GREEN_LOCK",
    protectedStopSource: "GREEN_LOCK",
    loserCompressionDesiredAction: "COMPRESS_L2",
    loserCompressionTargetState: "L2",
    loserCompressionSubmittedState: "L2",
    loserCompressionAppliedState: "L1",
    loserCompressionAppliedSource: "ALC_L1",
    loserCompressionAppliedConfirmed: true,
    loserCompressionAttributionConfidence: "HIGH",
    loserCompressionLastConfirmedStop: 93,
    loserCompressionRetryCount: 1,
    loserCompressionBlockedReason: null,
    peakR: 1.2,
  },
  {
    tradeId: "bt-alc-requested-only",
    strategyId: "orb",
    regime: "OPEN",
    side: "SELL",
    signalTs: "2026-01-01T09:30:00.000Z",
    entryFilledAt: "2026-01-01T09:31:00.000Z",
    exitTs: "2026-01-01T09:38:00.000Z",
    entryPrice: 100,
    exitPrice: 110,
    initialStopLoss: 110,
    executionRiskInr: 1000,
    grossPnl: -200,
    costs: 20,
    netPnl: -220,
    exitReason: "HARD_SL",
    protectedStopSource: "HARD_SL",
    loserCompressionDesiredAction: "COMPRESS_L2",
    loserCompressionTargetState: "L2",
    loserCompressionSubmittedState: "L2",
    loserCompressionAppliedState: "NONE",
    loserCompressionAppliedConfirmed: false,
    loserCompressionRetryCount: 2,
    loserCompressionBlockedReason: "ALC_BLOCKED_PENDING_MODIFY",
    peakR: 0.2,
  },
];

const normalizedTrades = rawTrades.map((trade) => normalizeBacktestTrade(trade));

assert.equal(normalizedTrades[0].alcRequested, true);
assert.equal(normalizedTrades[0].alcAppliedLevel, "L1");
assert.equal(normalizedTrades[0].alcAppliedSource, "ALC_L1");
assert.equal(normalizedTrades[0].alcAppliedButSuperseded, true);
assert.equal(normalizedTrades[0].alcSupersededBy, "GREEN_LOCK");
assert.equal(normalizedTrades[0].alcFinalProtectionOwner, "GREEN_LOCK");
assert.equal(normalizedTrades[0].alcSavedRiskR, 0.3);
assert.equal(normalizedTrades[0].alcSavedRiskInr, 300);

assert.equal(normalizedTrades[1].alcRequested, true);
assert.equal(normalizedTrades[1].alcRequestedLevel, "L2");
assert.equal(normalizedTrades[1].alcAppliedLevel, null);
assert.equal(normalizedTrades[1].alcRequestedButNotApplied, true);

const analytics = buildMetrics(normalizedTrades, {
  startingCapital: 50000,
  signalLog: [],
  admissionLog: [],
  rejectionLog: [],
  portfolioCurve: [],
});

assert.equal(analytics.summary.alcTriggeredCount, 2);
assert.equal(analytics.summary.alcL1Count, 0);
assert.equal(analytics.summary.alcL2Count, 2);
assert.equal(analytics.summary.alcAppliedConfirmedCount, 1);
assert.equal(analytics.summary.alcRequestedButNotAppliedCount, 1);
assert.equal(analytics.summary.alcSupersededCount, 1);
assert.equal(analytics.summary.alcAttributionLowConfidenceCount, 0);
assert.equal(analytics.summary.alcSavedRiskR, 0.3);
assert.equal(analytics.summary.alcSavedRiskInr, 300);
assert.equal(
  analytics.summary.alcBlockedCountByReason.ALC_BLOCKED_PENDING_MODIFY,
  1,
);
assert.equal(
  analytics.summary.alcSupersededBy.GREEN_LOCK,
  1,
);
assert.equal(
  analytics.summary.alcFinalProtectionOwner.GREEN_LOCK,
  1,
);

console.log("analytics.test.js passed");
