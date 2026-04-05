const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const { BASE_NOW, makeTrade, makeEnv, flatCandles } = require("./_helpers");

const trade = makeTrade();
const env = makeEnv();
const plan = computeDynamicExitPlan({
  trade,
  ltp: 109,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env,
});

assert.equal(plan.ok, true);
assert.equal(Boolean(plan.greenLockActive), true);
assert.ok(Number(plan.costGreenFloorPrice) >= Number(trade.entryPrice));
assert.ok(Number(plan.meta?.greenLockFloorPrice) >= 101.2);
assert.ok(Number(plan.finalStop ?? 0) >= Number(plan.meta?.greenLockFloorPrice ?? 0));
console.log("greenLock.test.js passed");
