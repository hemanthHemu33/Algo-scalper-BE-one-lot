const assert = require("node:assert/strict");
const {
  evaluateMinTradableRiskFit,
} = require("../../src/risk/evaluateMinTradableRiskFit");

const strictReject = evaluateMinTradableRiskFit({
  entryPrice: 330.65,
  strategyStopLoss: 290.95,
  side: "BUY",
  lotSize: 65,
  riskBudgetInr: 700,
  expectedSlippagePts: 0.25,
  feePerLotInr: 15,
  tickSize: 0.05,
});

assert.equal(strictReject.ok, true);
assert.equal(strictReject.fitsMinTradable, false);
assert.equal(strictReject.maxQtyByRisk, 0);
assert.ok(Number(strictReject.oneLotAllInRiskInr) > 700);

const fitsOneLot = evaluateMinTradableRiskFit({
  entryPrice: 100,
  strategyStopLoss: 95,
  side: "BUY",
  lotSize: 25,
  riskBudgetInr: 300,
  expectedSlippagePts: 0.2,
  feePerLotInr: 10,
  tickSize: 0.05,
});

assert.equal(fitsOneLot.ok, true);
assert.equal(fitsOneLot.fitsMinTradable, true);
assert.equal(fitsOneLot.maxLotsByRisk, 2);
assert.equal(fitsOneLot.maxQtyByRisk, 50);

const zeroRiskBudgetRejected = evaluateMinTradableRiskFit({
  entryPrice: 100,
  strategyStopLoss: 95,
  side: "BUY",
  lotSize: 25,
  riskBudgetInr: 0,
  expectedSlippagePts: 0.2,
  feePerLotInr: 10,
  tickSize: 0.05,
});

assert.equal(zeroRiskBudgetRejected.ok, false);
assert.equal(zeroRiskBudgetRejected.reason, "NON_POSITIVE_RISK_BUDGET");
assert.equal(zeroRiskBudgetRejected.maxQtyByRisk, 0);

const malformedLotRejected = evaluateMinTradableRiskFit({
  entryPrice: 100,
  strategyStopLoss: 95,
  side: "BUY",
  lotSize: 0,
  riskBudgetInr: 300,
  expectedSlippagePts: 0.2,
  feePerLotInr: 10,
  tickSize: 0.05,
});

assert.equal(malformedLotRejected.ok, false);
assert.equal(malformedLotRejected.reason, "BAD_LOT_SIZE");

const zeroRiskDistanceRejected = evaluateMinTradableRiskFit({
  entryPrice: 100,
  strategyStopLoss: 100,
  side: "BUY",
  lotSize: 25,
  riskBudgetInr: 300,
  expectedSlippagePts: 0.2,
  feePerLotInr: 10,
  tickSize: 0.05,
});

assert.equal(zeroRiskDistanceRejected.ok, false);
assert.equal(zeroRiskDistanceRejected.reason, "NON_POSITIVE_RISK_DISTANCE");

console.log("evaluateMinTradableRiskFit.test.js passed");
