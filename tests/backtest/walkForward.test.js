const assert = require("node:assert/strict");
const { buildWalkForwardSegments } = require("../../src/backtest/walkForward");

const tradingDays = [
  "2026-01-01",
  "2026-01-02",
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09"
];

const segments = buildWalkForwardSegments(tradingDays, {
  trainWindowDays: 3,
  testWindowDays: 2,
  stepDays: 2,
  anchored: false
});

assert.equal(segments.length, 2);
assert.deepEqual(segments[0].trainDays, ["2026-01-01", "2026-01-02", "2026-01-05"]);
assert.deepEqual(segments[0].testDays, ["2026-01-06", "2026-01-07"]);
assert.ok(segments[0].trainDays[segments[0].trainDays.length - 1] < segments[0].testDays[0]);

console.log("walkForward.test.js passed");
