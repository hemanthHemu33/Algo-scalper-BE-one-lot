const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const { BASE_NOW, makeTrade, makeEnv, flatCandles, applyPlanPatch } = require("./_helpers");

const env = makeEnv({ EARLY_WINNER_RETENTION_ENABLED: "false" });
let trade = makeTrade();
let previousFloorPrice = 0;

function approx(actual, expected, tolerance = 0.001) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const checkpoints = [
  { ltp: 107.9, expectedTier: 0, expectedFloorR: 0, expectedFloorPrice: null },
  { ltp: 108.0, expectedTier: 1, expectedFloorR: 0.2 },
  { ltp: 110.0, expectedTier: 2, expectedFloorR: 0.6 },
  { ltp: 112.6, expectedTier: 3, expectedFloorR: 0.8 },
];

for (const [idx, checkpoint] of checkpoints.entries()) {
  const plan = computeDynamicExitPlan({
    trade,
    ltp: checkpoint.ltp,
    candles: flatCandles(),
    nowTs: BASE_NOW + (idx + 1) * 60_000,
    env,
  });
  assert.equal(plan.ok, true);
  assert.equal(Number(plan.mfeLockTier ?? 0), checkpoint.expectedTier);
  if (checkpoint.expectedFloorPrice === null) {
    assert.equal(Number(plan.mfeLockFloorR ?? 0), checkpoint.expectedFloorR);
    assert.equal(plan.mfeLockFloorPrice ?? null, null);
  } else {
    approx(plan.mfeLockFloorR, checkpoint.expectedFloorR);
    assert.ok(Number(plan.mfeLockFloorPrice ?? 0) >= previousFloorPrice);
  }
  previousFloorPrice = Math.max(previousFloorPrice, Number(plan.mfeLockFloorPrice ?? 0));
  trade = applyPlanPatch(trade, plan);
}

const tierFivePlan = computeDynamicExitPlan({
  trade,
  ltp: 120.0,
  candles: flatCandles(),
  nowTs: BASE_NOW + 5 * 60_000,
  env,
});
assert.equal(tierFivePlan.ok, true);
assert.equal(Number(tierFivePlan.mfeLockTier ?? 0), 5);
assert.ok(Number(tierFivePlan.mfeLockFloorR ?? 0) >= 1.6);
assert.ok(Number(tierFivePlan.mfeLockFloorPrice ?? 0) >= previousFloorPrice);
console.log("mfeLockLadder.test.js passed");
