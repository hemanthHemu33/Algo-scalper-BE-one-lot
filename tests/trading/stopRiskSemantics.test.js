const assert = require("node:assert/strict");
const {
  resolveStrategyStopLoss,
  resolveBrokerStopLoss,
  buildStrategyStopLossBackfillPatch,
  computeActualRiskFromStrategyStop,
  classifyPostFillRiskBreach,
  normalizeStopRiskSemantics,
} = require("../../src/trading/stopRiskSemantics");
const {
  normalizeActiveTrade,
} = require("../../src/trading/tradeNormalization");

const normalizedLegacy = normalizeStopRiskSemantics({
  stopLoss: 91,
  initialStopLoss: 90,
  slTrigger: 91,
  riskInr: 700,
});

assert.equal(normalizedLegacy.strategyStopLoss, 90);
assert.equal(normalizedLegacy.sizingStopLoss, 90);
assert.equal(normalizedLegacy.brokerStopLoss, 91);
assert.equal(normalizedLegacy.initialStopLoss, 90);
assert.equal(normalizedLegacy.riskBudgetInr, 700);

const normalizedRow = normalizeActiveTrade({
  tradeId: "T-1",
  stopLoss: 99,
  initialStopLoss: 90,
  slTrigger: 99,
  instrument: { tradingsymbol: "TEST" },
});

assert.equal(normalizedRow.strategyStopLoss, 90);
assert.equal(normalizedRow.brokerStopLoss, 99);

assert.equal(resolveStrategyStopLoss({ stopLoss: 88, brokerStopLoss: 88 }), null);
assert.equal(resolveBrokerStopLoss({ stopLoss: 88 }), 88);

const immutableBackfill = buildStrategyStopLossBackfillPatch({
  initialStopLoss: 92,
  stopLoss: 99,
});

assert.equal(immutableBackfill.strategyStopLoss, 92);
assert.equal(immutableBackfill.initialStopLoss, undefined);

const riskStopBackfill = buildStrategyStopLossBackfillPatch({
  riskStopPrice: 87,
});

assert.equal(riskStopBackfill.strategyStopLoss, 87);
assert.equal(riskStopBackfill.initialStopLoss, 87);

const recoveryBackfill = buildStrategyStopLossBackfillPatch(
  { stopLoss: 95 },
  { allowRecoveryBrokerFallback: true },
);

assert.equal(recoveryBackfill.strategyStopLoss, 95);
assert.equal(
  recoveryBackfill.strategyStopLossRecoverySource,
  "RECOVERY_MUTABLE_BROKER_STOP",
);
assert.equal(recoveryBackfill.strategyStopLossRecoveryFallbackUsed, true);

const actualRisk = computeActualRiskFromStrategyStop({
  entryPrice: 330.65,
  strategyStopLoss: 290.95,
  qty: 65,
  side: "BUY",
});

assert.equal(actualRisk.ok, true);
assert.equal(Number(actualRisk.riskPts.toFixed(2)), 39.7);
assert.equal(Number(actualRisk.riskInr.toFixed(2)), 2580.5);

const softBreach = classifyPostFillRiskBreach({
  trueRiskInr: 735,
  capInr: 700,
  softBreachPct: 5,
  hardBreachPct: 12,
});

assert.equal(softBreach.state, "SOFT");

const hardBreach = classifyPostFillRiskBreach({
  trueRiskInr: 790,
  capInr: 700,
  softBreachPct: 5,
  hardBreachPct: 12,
});

assert.equal(hardBreach.state, "HARD");

console.log("stopRiskSemantics.test.js passed");
