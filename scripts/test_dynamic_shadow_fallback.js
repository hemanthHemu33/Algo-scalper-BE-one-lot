#!/usr/bin/env node
const assert = require("node:assert/strict");
const Module = require("node:module");

const updates = [];
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "./tradeStore" && parent?.filename?.endsWith("tradeManager.js")) {
    const noop = async () => null;
    return {
      ensureTradeIndexes: noop,
      insertTrade: noop,
      updateTrade: async (tradeId, patch) => {
        updates.push({ tradeId, patch });
        return { acknowledged: true, matchedCount: 1 };
      },
      getTrade: noop,
      getActiveTrades: async () => [],
      linkOrder: noop,
      findTradeByOrder: noop,
      saveOrphanOrderUpdate: noop,
      popOrphanOrderUpdates: async () => [],
      deadLetterOrphanOrderUpdates: async () => ({ moved: 0 }),
      appendOrderLog: noop,
      upsertLiveOrderSnapshot: noop,
      getLiveOrderSnapshotsByTradeIds: async () => [],
      upsertDailyRisk: noop,
      getDailyRisk: noop,
      upsertRiskState: noop,
      getRiskState: noop,
    };
  }
  return originalLoad(request, parent, isMain);
};

const { TradeManager } = require("../src/trading/tradeManager");
Module._load = originalLoad;

(async () => {
  const cancelled = [];
  let placedTrade = null;
  const manager = {
    expectedCancelOrderIds: new Set(),
    _safeCancelOrder: async (...args) => {
      cancelled.push(args);
    },
    _updateTrade: async (tradeId, patch) => {
      updates.push({ tradeId, patch });
    },
    _placeExitsIfMissing: async (trade) => {
      placedTrade = trade;
    },
    _eventPatch: (type, meta) => ({ eventType: type, eventMeta: meta }),
  };

  const trade = {
    tradeId: "T-SHADOW",
    slOrderId: "SL-1",
    stopLoss: 95,
    slTrigger: 95,
  };

  const replaced = await TradeManager.prototype._replaceDynamicSlOrder.call(
    manager,
    trade,
    101.5,
  );
  assert.equal(replaced, true);
  assert.equal(cancelled.length, 1);
  assert.equal(Number(placedTrade?.stopLoss), 101.5);
  assert.equal(updates[0].tradeId, "T-SHADOW");
  assert.equal(updates[0].patch.shadowExitActive, false);

  await TradeManager.prototype._activateDynamicShadowMode.call(
    {
      _updateTrade: async (tradeId, patch) => {
        updates.push({ tradeId, patch });
      },
      _eventPatch: (type, meta) => ({ eventType: type, eventMeta: meta }),
    },
    trade,
    { reason: "GREEN_LOCK" },
    { failCount: 3, source: "modify_fail" },
  );
  const last = updates.at(-1);
  assert.equal(last.tradeId, "T-SHADOW");
  assert.equal(last.patch.shadowExitActive, true);
  assert.equal(last.patch.lastExitPlanReason, "GREEN_LOCK");

  console.log("test_dynamic_shadow_fallback.js passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
