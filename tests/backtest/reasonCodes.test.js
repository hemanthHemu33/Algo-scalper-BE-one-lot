const assert = require("node:assert/strict");
const { normalizeReasonCode, toReasonSummary } = require("../../src/backtest/reasonCodes");

assert.equal(normalizeReasonCode("stop_loss"), "STOPLOSS");
assert.equal(normalizeReasonCode("daily loss halt"), "DAILY_LOSS_HALT");
assert.equal(normalizeReasonCode("unknown-code"), "UNKNOWN");

const summary = toReasonSummary("max_concurrent_block");
assert.equal(summary.reasonCode, "MAX_CONCURRENT_BLOCK");
assert.equal(summary.blockedByConcurrency, true);
assert.equal(summary.blockedByExistingPosition, true);

console.log("reasonCodes.test.js passed");
