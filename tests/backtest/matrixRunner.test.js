const assert = require("node:assert/strict");
const { expandMatrixDimensions } = require("../../src/backtest/matrixRunner");

const rows = expandMatrixDimensions({
  "execution.slippageBps": [2, 3],
  "strategy.confidenceMin": [55, 60]
});

assert.equal(rows.length, 4);
assert.equal(rows[0].overrides["execution.slippageBps"], 2);
assert.equal(rows[0].overrides["strategy.confidenceMin"], 55);

console.log("matrixRunner.test.js passed");
