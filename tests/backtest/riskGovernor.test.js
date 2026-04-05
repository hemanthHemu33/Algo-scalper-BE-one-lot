const assert = require("node:assert/strict");
const { createRiskGovernor } = require("../../src/backtest/riskGovernor");

const governor = createRiskGovernor({
  initialCapital: 50000,
  capitalPerTrade: 20000,
  marginMultiplier: 1,
  riskPerTradeInr: 500,
  maxDailyLossInr: 1000,
  maxConcurrentPositions: 1,
  maxTradesPerDay: 2,
  maxConsecutiveLosses: 2,
  maxOpenRiskInr: 600,
  entryCutoffTime: "15:00",
});

const preview = governor.previewPosition({
  ts: "2026-01-01T09:15:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "risk_based",
  defaultQty: 50,
});

assert.equal(preview.ok, true);
governor.reservePosition("r1", preview);
const blocked = governor.previewPosition({
  ts: "2026-01-01T09:16:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "risk_based",
  defaultQty: 50,
});
assert.equal(blocked.ok, false);
assert.equal(blocked.rejectionReason, "MAX_CONCURRENT_BLOCK");

governor.activatePosition("r1", "t1", { capitalUsed: 5000, riskInr: 250, ts: "2026-01-01T09:16:00+05:30" });
governor.markToMarket("2026-01-01T09:20:00+05:30", [{ tradeId: "t1", unrealizedPnL: -100 }]);
governor.closePosition("t1", { ts: "2026-01-01T09:30:00+05:30", netPnl: -600 });
governor.closePosition("missing", { ts: "2026-01-01T09:45:00+05:30", netPnl: -500 });

const haltState = governor.getHaltState("2026-01-01T10:00:00+05:30");
assert.equal(haltState.halted, true);
assert.ok(haltState.reasons.includes("DAILY_LOSS_HALT"));
assert.ok(haltState.reasons.includes("MAX_CONSECUTIVE_LOSSES_HALT"));

const cutoffGovernor = createRiskGovernor({
  initialCapital: 50000,
  capitalPerTrade: 20000,
  marginMultiplier: 1,
  riskPerTradeInr: 500,
  maxConcurrentPositions: 1,
  timezone: "Asia/Kolkata",
  entryCutoffTime: "15:00",
});

const beforeCutoffPreview = cutoffGovernor.previewPosition({
  ts: "2026-01-02T14:59:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "fixed",
  defaultQty: 50,
});
assert.equal(beforeCutoffPreview.ok, true);

const exactCutoffPreview = cutoffGovernor.previewPosition({
  ts: "2026-01-02T15:00:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "fixed",
  defaultQty: 50,
});
assert.equal(exactCutoffPreview.ok, false);
assert.equal(exactCutoffPreview.rejectionReason, "ENTRY_CUTOFF_BLOCK");

const cutoffPreview = cutoffGovernor.previewPosition({
  ts: "2026-01-02T15:05:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "fixed",
  defaultQty: 50,
});
assert.equal(cutoffPreview.ok, false);
assert.equal(cutoffPreview.rejectionReason, "ENTRY_CUTOFF_BLOCK");

const noCutoffGovernor = createRiskGovernor({
  initialCapital: 50000,
  capitalPerTrade: 20000,
  marginMultiplier: 1,
  riskPerTradeInr: 500,
  maxConcurrentPositions: 1,
});
const noCutoffPreview = noCutoffGovernor.previewPosition({
  ts: "2026-01-02T15:05:00+05:30",
  entryPrice: 100,
  stopLoss: 95,
  instrument: { lot_size: 50 },
  qtyMode: "fixed",
  defaultQty: 50,
});
assert.equal(noCutoffPreview.ok, true);

console.log("riskGovernor.test.js passed");
