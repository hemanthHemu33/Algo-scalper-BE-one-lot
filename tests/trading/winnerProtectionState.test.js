const assert = require("node:assert/strict");
const {
  WINNER_PROTECTION_DEFAULTS,
  buildMissingWinnerProtectionPatch,
} = require("../../src/trading/winnerProtectionState");
const {
  normalizeActiveTrade,
  normalizeTradeRow,
} = require("../../src/trading/tradeNormalization");

const seeded = buildMissingWinnerProtectionPatch({});
assert.deepEqual(seeded, WINNER_PROTECTION_DEFAULTS);

const preserveExisting = buildMissingWinnerProtectionPatch({
  peakExecutableR: 1.1,
  currentExecutableR: 0,
  hardGivebackExitArmed: false,
  hardGivebackRule: "RULE_B",
});
assert.equal(Object.prototype.hasOwnProperty.call(preserveExisting, "peakExecutableR"), false);
assert.equal(Object.prototype.hasOwnProperty.call(preserveExisting, "currentExecutableR"), false);
assert.equal(
  Object.prototype.hasOwnProperty.call(preserveExisting, "hardGivebackExitArmed"),
  false,
);
assert.equal(Object.prototype.hasOwnProperty.call(preserveExisting, "hardGivebackRule"), false);

const normalizedActive = normalizeActiveTrade({
  tradeId: "T-NORM-ACTIVE",
  stopLoss: 99,
  initialStopLoss: 90,
  slTrigger: 99,
  instrument: { tradingsymbol: "TEST" },
  currentExecutableR: 0,
  protectedPeakR: 0,
  hardGivebackExitArmed: false,
  hardGivebackConfirmTicks: 0,
  givebackConfirmMs: 0,
});

for (const key of Object.keys(WINNER_PROTECTION_DEFAULTS)) {
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedActive, key), true);
}

assert.equal(normalizedActive.currentExecutableR, 0);
assert.equal(normalizedActive.peakExecutableR, 0);
assert.equal(normalizedActive.protectedPeakR, 0);
assert.equal(normalizedActive.protectedCurrentR, 0);
assert.equal(normalizedActive.tightenActive, false);
assert.equal(normalizedActive.hardGivebackExitArmed, false);
assert.equal(normalizedActive.hardGivebackConfirmTicks, 0);
assert.equal(normalizedActive.givebackConfirmMs, 0);
assert.equal(normalizedActive.shouldExitNowReason, null);

const normalizedRow = normalizeTradeRow({
  tradeId: "T-NORM-ROW",
  stopLoss: 99,
  initialStopLoss: 90,
  slTrigger: 99,
  instrument: { tradingsymbol: "TEST" },
  current_executable_r: 0,
  protected_peak_r: 0,
  protected_current_r: 0,
  mfe_lock_tier: 0,
  tighten_active: false,
  hard_giveback_exit_armed: false,
  hard_giveback_confirm_ticks: 0,
  giveback_confirm_ms: 0,
});

for (const key of Object.keys(WINNER_PROTECTION_DEFAULTS)) {
  assert.equal(Object.prototype.hasOwnProperty.call(normalizedRow, key), true);
}

assert.equal(normalizedRow.currentExecutableR, 0);
assert.equal(normalizedRow.protectedPeakR, 0);
assert.equal(normalizedRow.protectedCurrentR, 0);
assert.equal(normalizedRow.mfeLockTier, 0);
assert.equal(normalizedRow.tightenActive, false);
assert.equal(normalizedRow.hardGivebackExitArmed, false);
assert.equal(normalizedRow.hardGivebackConfirmTicks, 0);
assert.equal(normalizedRow.givebackConfirmMs, 0);
assert.equal(normalizedRow.shouldExitNowReason, null);

console.log("winnerProtectionState.test.js passed");
