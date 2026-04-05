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
