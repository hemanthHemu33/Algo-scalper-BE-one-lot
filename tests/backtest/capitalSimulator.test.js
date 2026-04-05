const assert = require("node:assert/strict");
const { createCapitalSimulator } = require("../../src/backtest/capitalSimulator");

const capital = createCapitalSimulator({
  startingCapital: 50000,
  capitalPerTrade: 20000,
  marginMultiplier: 1,
  riskPerTradeInr: 500,
  maxDailyLossInr: 1000,
  maxConcurrentPositions: 1,
  maxTradesPerDay: 2,
  maxConsecutiveLosses: 2
});

const preview = capital.previewPosition({
  ts: "2026-01-01T09:15:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "risk_based",
  defaultQty: 50
});

assert.equal(preview.ok, true);
capital.reservePosition("r1", preview);
const blocked = capital.previewPosition({
  ts: "2026-01-01T09:16:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "risk_based",
  defaultQty: 50
});
assert.equal(blocked.ok, false);
assert.equal(blocked.rejectionReason, "MAX_CONCURRENT_BLOCK");

capital.activatePosition("r1", "t1", { capitalUsed: 5000, riskInr: 250 });
capital.closePosition("t1", { ts: "2026-01-01T09:30:00+05:30", netPnl: -600 });
capital.closePosition("missing", { ts: "2026-01-01T09:45:00+05:30", netPnl: -500 });

const haltState = capital.getHaltState("2026-01-01T10:00:00+05:30");
assert.equal(haltState.halted, true);
assert.ok(haltState.reasons.includes("DAILY_LOSS_HALT"));
assert.ok(haltState.reasons.includes("MAX_CONSECUTIVE_LOSSES_HALT"));

console.log("capitalSimulator.test.js passed");
