const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadTradeManagerHarness({
  tradeStoreOverrides = {},
  loggerOverrides = {},
  costCalibratorOverrides = {},
  envOverrides = {},
  dynamicExitManagerOverrides = {},
  candleStoreOverrides = {},
  instrumentRepoOverrides = {},
  livePreflightOverrides = {},
} = {}) {
  const tradeManagerPath = path.join(ROOT, "src", "trading", "tradeManager.js");
  const tradeStorePath = path.join(ROOT, "src", "trading", "tradeStore.js");
  const loggerPath = path.join(ROOT, "src", "logger.js");
  const costCalibratorPath = path.join(
    ROOT,
    "src",
    "trading",
    "costCalibrator.js",
  );
  const dynamicExitManagerPath = path.join(
    ROOT,
    "src",
    "trading",
    "dynamicExitManager.js",
  );
  const candleStorePath = path.join(ROOT, "src", "market", "candleStore.js");
  const instrumentRepoPath = path.join(
    ROOT,
    "src",
    "instruments",
    "instrumentRepo.js",
  );
  const configPath = path.join(ROOT, "src", "config.js");
  const livePreflightPath = path.join(ROOT, "src", "runtime", "livePreflight.js");

  delete require.cache[require.resolve(tradeManagerPath)];

  const tradeStore = require(tradeStorePath);
  const { logger } = require(loggerPath);
  const { costCalibrator } = require(costCalibratorPath);
  const dynamicExitManager = require(dynamicExitManagerPath);
  const candleStore = require(candleStorePath);
  const instrumentRepo = require(instrumentRepoPath);
  const livePreflight = require(livePreflightPath);
  const { env } = require(configPath);

  const restorers = [];

  function patchObject(target, overrides) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides || {})) {
      previous[key] = target[key];
      target[key] = value;
    }
    restorers.push(() => {
      for (const [key, value] of Object.entries(previous)) {
        target[key] = value;
      }
    });
  }

  function patchEnv(overrides) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides || {})) {
      previous[key] = env[key];
      env[key] = value;
    }
    restorers.push(() => {
      for (const [key, value] of Object.entries(previous)) {
        env[key] = value;
      }
    });
  }

  patchObject(tradeStore, tradeStoreOverrides);
  patchObject(logger, loggerOverrides);
  patchObject(costCalibrator, costCalibratorOverrides);
  patchObject(dynamicExitManager, dynamicExitManagerOverrides);
  patchObject(candleStore, candleStoreOverrides);
  patchObject(instrumentRepo, instrumentRepoOverrides);
  patchObject(livePreflight, livePreflightOverrides);
  patchEnv(envOverrides);

  const tradeManagerModule = require(tradeManagerPath);

  return {
    ...tradeManagerModule,
    restore() {
      delete require.cache[require.resolve(tradeManagerPath)];
      while (restorers.length) {
        restorers.pop()();
      }
    },
  };
}

function makeRiskEngine() {
  return {
    setStateChangeHandler() {},
    resetFailures() {},
    setKillSwitch() {},
    markTradeOpened() {},
    markTradeClosed() {},
    setOpenPosition() {},
    evaluateMinTradableRiskFit() {
      return { maxQtyByRisk: 0 };
    },
  };
}

async function testEntryOrdersApplyTtlAndAutoslice() {
  const placeCalls = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      upsertDailyRisk: async () => {},
    },
    envOverrides: {
      TRADING_ENABLED: "false",
      KITE_USE_AUTOSLICE: true,
      KITE_ENTRY_VALIDITY: "TTL",
      KITE_ENTRY_VALIDITY_TTL_MIN: 1,
      MAX_ORDERS_PER_DAY: 5000,
    },
    livePreflightOverrides: {
      refreshLivePreflight: async () => ({
        ok: true,
        requestedByEnv: false,
        warnings: [],
        blockingReasons: [],
        details: {},
      }),
      updateLivePreflightContext: () => {},
      getEffectiveLiveEnabled: () => false,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        placeOrder: async (_variety, params) => {
          placeCalls.push(params);
          return { order_id: "ENTRY-1" };
        },
      },
      riskEngine: makeRiskEngine(),
    });

    const result = await tm._safePlaceOrder(
      "regular",
      {
        exchange: "NFO",
        tradingsymbol: "NIFTY26APR22500CE",
        transaction_type: "BUY",
        quantity: 75,
        product: "MIS",
        order_type: "LIMIT",
        price: 123.45,
        validity: "DAY",
        tag: "ENTRY-TAG",
      },
      { purpose: "ENTRY", tradeId: "T-ENTRY" },
    );

    assert.equal(result.orderId, "ENTRY-1");
    assert.equal(placeCalls.length, 1);
    assert.equal(placeCalls[0].autoslice, true);
    assert.equal(placeCalls[0].validity, "TTL");
    assert.equal(placeCalls[0].validity_ttl, 1);
    assert.equal(tm._autosliceUsedToday, 1);
    assert.equal(tm._ttlEntryUsedToday, 1);
  } finally {
    harness.restore();
  }
}

async function testModifyCapTriggersCancelReplace() {
  const updates = [];
  const linkedOrders = [];
  const logs = [];
  const placeCalls = [];
  const cancelCalls = [];
  let modifyCalls = 0;

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      findTradeByOrder: async (orderId) => ({
        trade: { tradeId: "T-CAP", targetOrderId: orderId },
        link: { role: "TARGET" },
      }),
      getTrade: async (tradeId) => ({
        tradeId,
        targetOrderId: "TARGET-1",
      }),
      updateTrade: async (_tradeId, patch) => {
        updates.push(patch);
      },
      linkOrder: async (payload) => {
        linkedOrders.push(payload);
      },
      appendOrderLog: async (payload) => {
        logs.push(payload);
      },
      upsertLiveOrderSnapshot: async () => {},
      upsertDailyRisk: async () => {},
    },
    envOverrides: {
      TRADING_ENABLED: "false",
      KITE_MAX_MODIFICATIONS_PER_ORDER: 2,
      MAX_ORDERS_PER_DAY: 5000,
    },
    livePreflightOverrides: {
      refreshLivePreflight: async () => ({
        ok: true,
        requestedByEnv: false,
        warnings: [],
        blockingReasons: [],
        details: {},
      }),
      updateLivePreflightContext: () => {},
      getEffectiveLiveEnabled: () => false,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        modifyOrder: async () => {
          modifyCalls += 1;
          return {};
        },
        cancelOrder: async () => {
          cancelCalls.push(true);
          return {};
        },
        placeOrder: async (_variety, params) => {
          placeCalls.push(params);
          return { order_id: "TARGET-2" };
        },
      },
      riskEngine: makeRiskEngine(),
    });

    tm._replayOrphanUpdates = async () => {};
    tm._watchExitLeg = async () => {};

    tm._lastOrdersById.set("TARGET-1", {
      order_id: "TARGET-1",
      status: "OPEN",
      exchange: "NFO",
      tradingsymbol: "NIFTY26APR22500CE",
      transaction_type: "SELL",
      pending_quantity: 75,
      quantity: 75,
      product: "MIS",
      order_type: "LIMIT",
      price: 130,
      validity: "DAY",
      tag: "TARGET-TAG",
    });
    tm._setOrderModifyCount("TARGET-1", 2);

    const result = await tm._safeModifyOrder(
      "regular",
      "TARGET-1",
      { price: 129.5 },
      { purpose: "TARGET_QTY_MODIFY", tradeId: "T-CAP", tickSize: 0.05 },
    );

    assert.equal(modifyCalls, 0);
    assert.equal(cancelCalls.length, 1);
    assert.equal(placeCalls.length, 1);
    assert.equal(placeCalls[0].price, 129.5);
    assert.equal(result.modifyCapHit, true);
    assert.equal(result.cancelReplaceTriggered, true);
    assert.equal(result.replacementOrderId, "TARGET-2");
    assert.equal(tm._modifyCapHitsToday, 1);
    assert.equal(tm._cancelReplaceCountToday, 1);
    assert.equal(
      updates.some((patch) => patch.targetOrderId === "TARGET-2"),
      true,
    );
    assert.equal(
      linkedOrders.some((row) => row.order_id === "TARGET-2" && row.role === "TARGET"),
      true,
    );
    assert.equal(
      logs.some((row) => row.status === "MODIFY_CAP_HIT"),
      true,
    );
  } finally {
    harness.restore();
  }
}

async function main() {
  await testEntryOrdersApplyTtlAndAutoslice();
  await testModifyCapTriggersCancelReplace();
  console.log("tradeManagerKiteLayer.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
