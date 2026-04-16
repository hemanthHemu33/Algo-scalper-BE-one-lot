const assert = require("node:assert/strict");
const {
  TRADE_LIFECYCLE_DEFAULTS,
  buildMissingTradeLifecyclePatch,
  deriveStopExitReasonCode,
  isWinnerProtectionActive,
  normalizeTradeLifecycleState,
} = require("../../src/trading/tradeLifecycleState");
const {
  normalizeActiveTrade,
  normalizeTradeRow,
} = require("../../src/trading/tradeNormalization");

const seeded = buildMissingTradeLifecyclePatch({});
assert.deepEqual(seeded, TRADE_LIFECYCLE_DEFAULTS);

const normalized = normalizeTradeLifecycleState({
  side: "BUY",
  decisionAt: "2026-01-01T09:15:00.000Z",
  entryPlacedAt: "2026-01-01T09:15:02.000Z",
  expectedEntryPrice: 100,
  entryPrice: 101,
  quoteAtEntry: { bps: 18 },
  exitReason: "SL_HIT",
});

assert.equal(normalized.signalTs, "2026-01-01T09:15:00.000Z");
assert.equal(normalized.executionTs, "2026-01-01T09:15:02.000Z");
assert.equal(normalized.plannedEntry, 100);
assert.equal(normalized.actualEntry, 101);
assert.equal(normalized.entryDriftPct, 1);
assert.equal(normalized.spreadBpsAtSelection, 18);
assert.equal(normalized.exitFamily, "LOSS_CONTAINMENT");
assert.equal(normalized.exitReasonCode, "HARD_SL");
assert.equal(normalized.exitAuthority, "STOP_ORDER");

const loserExitNormalized = normalizeTradeLifecycleState({
  side: "BUY",
  entryPrice: 100,
  initialStopLoss: 90,
  executionRiskInr: 1000,
  exitReason: "ALC_EXIT_NOW",
  loserCompressionTargetState: "L2",
  loserCompressionSubmittedState: "L1",
  loserCompressionAppliedState: "L1",
  loserCompressionPendingAction: "STOP_MODIFY",
  loserCompressionPendingSince: "2026-01-01T09:16:00.000Z",
  loserCompressionLastRequestedStop: 94.5,
  loserCompressionLastConfirmedStop: 95,
  loserCompressionLastAttemptAt: "2026-01-01T09:16:10.000Z",
  loserCompressionLastConfirmedAt: "2026-01-01T09:16:15.000Z",
  loserCompressionAppliedSource: "ALC_L1",
  loserCompressionAppliedConfirmed: true,
  loserCompressionAttributionConfidence: "HIGH",
  loserCompressionRetryCount: 2,
  loserCompressionBlockedReason: "ALC_BLOCKED_PENDING_MODIFY",
  loserCompressionLastAction: "COMPRESS_L2",
  loserCompressionTriggeredAt: "2026-01-01T09:16:00.000Z",
  loserExitTriggered: true,
  loserExitReasonCode: "ALC_EXIT_NOW",
});
assert.equal(loserExitNormalized.exitFamily, "LOSS_CONTAINMENT");
assert.equal(loserExitNormalized.exitReasonCode, "ALC_EXIT_NOW");
assert.equal(loserExitNormalized.exitAuthority, "ADAPTIVE_LOSER_ENGINE");
assert.equal(loserExitNormalized.loserCompressionTargetState, "L2");
assert.equal(loserExitNormalized.loserCompressionSubmittedState, "L1");
assert.equal(loserExitNormalized.loserCompressionAppliedState, "L1");
assert.equal(loserExitNormalized.loserCompressionPendingAction, "STOP_MODIFY");
assert.equal(
  loserExitNormalized.loserCompressionPendingSince,
  "2026-01-01T09:16:00.000Z",
);
assert.equal(loserExitNormalized.loserCompressionLastRequestedStop, 94.5);
assert.equal(loserExitNormalized.loserCompressionLastConfirmedStop, 95);
assert.equal(
  loserExitNormalized.loserCompressionLastAttemptAt,
  "2026-01-01T09:16:10.000Z",
);
assert.equal(
  loserExitNormalized.loserCompressionLastConfirmedAt,
  "2026-01-01T09:16:15.000Z",
);
assert.equal(loserExitNormalized.loserCompressionAppliedSource, "ALC_L1");
assert.equal(loserExitNormalized.loserCompressionAppliedConfirmed, true);
assert.equal(
  loserExitNormalized.loserCompressionAttributionConfidence,
  "HIGH",
);
assert.equal(loserExitNormalized.loserCompressionRetryCount, 2);
assert.equal(
  loserExitNormalized.loserCompressionBlockedReason,
  "ALC_BLOCKED_PENDING_MODIFY",
);
assert.equal(loserExitNormalized.loserCompressionLastAction, "COMPRESS_L2");
assert.equal(
  loserExitNormalized.loserCompressionTriggeredAt,
  "2026-01-01T09:16:00.000Z",
);
assert.equal(loserExitNormalized.loserExitTriggered, true);
assert.equal(loserExitNormalized.loserExitReasonCode, "ALC_EXIT_NOW");
assert.equal(loserExitNormalized.alcRequested, true);
assert.equal(loserExitNormalized.alcRequestedLevel, "L2");
assert.equal(loserExitNormalized.alcAppliedLevel, "L1");
assert.equal(loserExitNormalized.alcAppliedSource, "ALC_L1");
assert.equal(loserExitNormalized.alcAttributionConfidence, "HIGH");
assert.equal(loserExitNormalized.alcRequestedButNotApplied, false);
assert.equal(loserExitNormalized.alcAppliedButSuperseded, false);
assert.equal(loserExitNormalized.alcSupersededBy, null);
assert.equal(loserExitNormalized.alcFinalProtectionOwner, "ALC_EXIT_NOW");
assert.equal(loserExitNormalized.alcSavedRiskR, 0.5);
assert.equal(loserExitNormalized.alcSavedRiskInr, 500);

assert.equal(deriveStopExitReasonCode({}), "HARD_SL");
assert.equal(deriveStopExitReasonCode({ beLocked: true }), "HARD_SL");
assert.equal(
  deriveStopExitReasonCode({ beAppliedAt: "2026-01-01T09:16:00.000Z" }),
  "BREAK_EVEN",
);
assert.equal(deriveStopExitReasonCode({ greenLockActive: true }), "GREEN_LOCK");
assert.equal(deriveStopExitReasonCode({ mfeLockTier: 2 }), "MFE_LOCK");
assert.equal(deriveStopExitReasonCode({ trailActive: true, mfeLockTier: 2 }), "TRAIL_EXIT");
assert.equal(isWinnerProtectionActive({ beLocked: true }), false);
assert.equal(
  isWinnerProtectionActive({
    beLockHit: true,
    trailHit: true,
    beLocked: true,
    trailLocked: true,
    beApplied: false,
    trailAllowed: false,
    trailActive: false,
  }),
  false,
);
assert.equal(
  isWinnerProtectionActive({ beAppliedAt: "2026-01-01T09:16:00.000Z" }),
  true,
);

const normalizedActive = normalizeActiveTrade({
  tradeId: "T-LIFE-ACTIVE",
  instrument: { tradingsymbol: "TEST" },
  stopLoss: 99,
  initialStopLoss: 90,
  slTrigger: 99,
});

for (const key of Object.keys(TRADE_LIFECYCLE_DEFAULTS)) {
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedActive, key), true);
}
assert.equal(normalizedActive.executionGateReason, "NOT_EVALUATED");
assert.equal(normalizedActive.earlyFailArmed, false);
assert.equal(normalizedActive.exitReasonCode, null);

const normalizedRow = normalizeTradeRow({
  tradeId: "T-LIFE-ROW",
  instrument: { tradingsymbol: "TEST" },
  stopLoss: 99,
  initialStopLoss: 90,
  slTrigger: 99,
});

for (const key of Object.keys(TRADE_LIFECYCLE_DEFAULTS)) {
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedRow, key), true);
}
assert.equal(normalizedRow.executionGateReason, "NOT_EVALUATED");
assert.equal(normalizedRow.peakR, 0);
assert.equal(normalizedRow.trailActive, false);
assert.equal(normalizedRow.exitFamily, null);

console.log("tradeLifecycleState.test.js passed");
