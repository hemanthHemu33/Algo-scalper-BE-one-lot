const assert = require("node:assert/strict");
const path = require("node:path");
const {
  deriveStopExitReasonCode,
  isWinnerProtectionActive,
} = require("../../src/trading/tradeLifecycleState");

const ROOT = path.resolve(__dirname, "..", "..");

function loadTradeManagerHarness({
  tradeStoreOverrides = {},
  loggerOverrides = {},
  costCalibratorOverrides = {},
  envOverrides = {},
  dynamicExitManagerOverrides = {},
  candleStoreOverrides = {},
  instrumentRepoOverrides = {},
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

  delete require.cache[require.resolve(tradeManagerPath)];

  const tradeStore = require(tradeStorePath);
  const { logger } = require(loggerPath);
  const { costCalibrator } = require(costCalibratorPath);
  const dynamicExitManager = require(dynamicExitManagerPath);
  const candleStore = require(candleStorePath);
  const instrumentRepo = require(instrumentRepoPath);
  const { env } = require(configPath);

  const restorers = [];

  function patchObject(target, overrides) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides)) {
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
    for (const [key, value] of Object.entries(overrides)) {
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
  patchEnv(envOverrides);

  const tradeManagerModule = require(tradeManagerPath);

  return {
    ...tradeManagerModule,
    restore() {
      delete require.cache[require.resolve(tradeManagerPath)];
      while (restorers.length) {
        const restore = restorers.pop();
        restore();
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testReconcileInitGuard() {
  const calls = {
    ensureIndexes: 0,
    costStart: 0,
    ensureDailyRisk: 0,
    hydrateRiskState: 0,
    refreshRiskLimits: 0,
    hydrateRisk: 0,
    hydrateOpenPosition: 0,
    startExitLoop: 0,
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      ensureTradeIndexes: async () => {
        calls.ensureIndexes += 1;
      },
      getActiveTrades: async () => [],
      getLiveOrderSnapshotsByTradeIds: async () => [],
    },
    costCalibratorOverrides: {
      start: async () => {
        calls.costStart += 1;
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        getOrders: async () => [],
        getPositions: async () => ({ net: [] }),
      },
      riskEngine: makeRiskEngine(),
    });

    tm._ensureDailyRisk = async () => {
      calls.ensureDailyRisk += 1;
    };
    tm._hydrateRiskStateFromDb = async () => {
      calls.hydrateRiskState += 1;
    };
    tm.refreshRiskLimits = async () => {
      calls.refreshRiskLimits += 1;
    };
    tm._hydrateRiskFromDb = async () => {
      calls.hydrateRisk += 1;
    };
    tm._hydrateOpenPositionFromActiveTrade = async () => {
      calls.hydrateOpenPosition += 1;
    };
    tm._startExitLoop = () => {
      calls.startExitLoop += 1;
    };
    tm._globalFactRecoveryGate = async () => ({ ok: true });
    tm._restoreDynamicExitState = async () => {};
    tm._persistLiveOrderSnapshotsForTrades = async () => {};
    tm._syncRiskFromPositions = () => {};
    tm._monitorPortfolioRisk = async () => {};
    tm._maybeHardFlatOnRestart = async () => {};

    await tm.reconcile([]);
    await tm.reconcile([]);

    assert.equal(calls.ensureIndexes, 1);
    assert.equal(calls.costStart, 1);
    assert.equal(calls.ensureDailyRisk, 1);
    assert.equal(calls.hydrateRiskState, 1);
    assert.equal(calls.refreshRiskLimits, 1);
    assert.equal(calls.hydrateRisk, 1);
    assert.equal(calls.hydrateOpenPosition, 1);
    assert.equal(calls.startExitLoop, 1);
  } finally {
    harness.restore();
  }
}

async function testProtectiveSlIsNotFastWatched() {
  const warnings = [];
  let historyCalls = 0;

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      warn(payload, message) {
        warnings.push(String(message || payload || ""));
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        getOrderHistory: async () => {
          historyCalls += 1;
          return [{ status: "TRIGGER PENDING" }];
        },
      },
      riskEngine: makeRiskEngine(),
    });

    await tm._watchExitLeg("T-1", "SL-1", "SL");

    assert.equal(historyCalls, 0);
    assert.equal(
      warnings.some((entry) => entry.includes("[exit_watch] timeout")),
      false,
    );
  } finally {
    harness.restore();
  }
}

async function testExitQtySkipsNoopModify() {
  let modifyCalls = 0;
  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({
        tradeId: "T-1",
        qty: 50,
        slOrderId: "SL-1",
        targetOrderId: "TARGET-1",
      }),
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: { modifyOrder() {} },
      riskEngine: makeRiskEngine(),
    });

    tm._lastOrdersById.set("SL-1", { quantity: 50 });
    tm._lastOrdersById.set("TARGET-1", { quantity: 50 });
    tm._safeModifyOrder = async () => {
      modifyCalls += 1;
      return { skipped: false };
    };

    await tm._ensureExitQty("T-1", 50);

    assert.equal(modifyCalls, 0);
  } finally {
    harness.restore();
  }
}

async function testTargetQtySyncFallbackVirtualizesStaleTarget() {
  const tradeState = {
    tradeId: "T-TARGET-SYNC",
    status: "LIVE",
    side: "BUY",
    qty: 50,
    initialQty: 50,
    tp1Done: true,
    runnerQty: 30,
    entryPrice: 100,
    strategyStopLoss: 90,
    sizingStopLoss: 90,
    brokerStopLoss: 90,
    stopLoss: 90,
    instrument_token: 12345,
    instrument: {
      tick_size: 0.05,
      segment: "NFO-OPT",
      tradingsymbol: "TESTOPT",
      exchange: "NFO",
    },
    targetOrderId: "TARGET-1",
    targetOrderType: "LIMIT",
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
      },
    },
    envOverrides: {
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        modifyOrder() {},
      },
      riskEngine: makeRiskEngine(),
    });

    let replaceQty = null;
    let virtualized = null;

    tm._lastOrdersById.set("TARGET-1", { quantity: 50 });
    tm._safeModifyOrder = async (_variety, orderId) => {
      if (orderId === "TARGET-1") throw new Error("rate limit");
      return { skipped: false };
    };
    tm._safeCancelOrder = async () => {};
    tm._getOrderStatus = async () => ({ status: "CANCELLED" });
    tm._placeRunnerTargetOnly = async (trade) => {
      replaceQty = trade.qty;
      throw new Error("broker replace unavailable");
    };
    tm._enableVirtualTarget = async (trade, meta) => {
      virtualized = {
        tradeId: trade.tradeId,
        qty: trade.qty,
        reason: meta?.reason ?? null,
        source: meta?.source ?? null,
      };
      tradeState.targetVirtual = true;
    };

    await tm._ensureExitQty(tradeState.tradeId, 30);

    assert.equal(replaceQty, 30);
    assert.deepEqual(virtualized, {
      tradeId: "T-TARGET-SYNC",
      qty: 30,
      reason: "TARGET_QTY_SYNC_FAILED",
      source: "qty_sync_failure",
    });
    assert.equal(tradeState.targetOrderId, null);
    assert.equal(tradeState.targetOrderType, null);
    assert.equal(tradeState.targetQtySyncStatus, "VIRTUALIZED");
    assert.equal(tradeState.targetQtySyncFallbackMode, "VIRTUAL_TARGET");
    assert.equal(tradeState.targetQtySyncDesiredQty, 30);
    assert.equal(Boolean(tradeState.targetVirtual), true);
  } finally {
    harness.restore();
  }
}

async function testSafeModifyOrderSkipsBrokerAlreadyMatchingTarget() {
  const infoLogs = [];
  let modifyCalls = 0;

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      info(payload, message) {
        infoLogs.push({ payload, message });
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        modifyOrder: async () => {
          modifyCalls += 1;
        },
      },
      riskEngine: makeRiskEngine(),
    });

    tm._lastOrdersById.set("SL-1", {
      trigger_price: 104.05,
      price: 104.05,
    });

    const result = await tm._safeModifyOrder(
      "regular",
      "SL-1",
      { trigger_price: 104.05, price: 104.05 },
      { purpose: "DYN_TRAIL_SL", tradeId: "T-MATCH", tickSize: 0.05 },
    );

    assert.equal(modifyCalls, 0);
    assert.equal(result?.skipped, true);
    assert.equal(result?.reason, "broker_already_matches_target");
    assert.equal(
      infoLogs.some((entry) =>
        String(entry.message || "").includes(
          "broker stop already matches target",
        ),
      ),
      true,
    );
  } finally {
    harness.restore();
  }
}

async function testSafeModifyOrderSkipsTinyStopDelta() {
  let modifyCalls = 0;

  const harness = loadTradeManagerHarness();

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        modifyOrder: async () => {
          modifyCalls += 1;
        },
      },
      riskEngine: makeRiskEngine(),
    });

    tm._lastOrdersById.set("SL-1", {
      trigger_price: 104.05,
    });

    const result = await tm._safeModifyOrder(
      "regular",
      "SL-1",
      { trigger_price: 104.08 },
      { purpose: "DYN_TRAIL_SL", tradeId: "T-TINY", tickSize: 0.05 },
    );

    assert.equal(modifyCalls, 0);
    assert.equal(result?.skipped, true);
    assert.equal(result?.reason, "delta_below_tick");
  } finally {
    harness.restore();
  }
}

async function testDynamicSlModifyBlockedWithoutAuthority() {
  const logs = [];
  let safeModifyCalls = 0;

  const plan = {
    ok: true,
    sl: { stopLoss: 189.65 },
    finalStop: 189.65,
    tradePatch: {
      telemetryProposalFloor: 189.6,
      executableHardFloor: 189.6,
      desiredStopLoss: 189.6,
      finalStopLoss: 189.65,
      hardFloor: 189.6,
      structureTrailSource: "GATED",
      structureTrailAllowed: false,
      protectionGateOpen: false,
      winnerModeActive: false,
      stopImproveAuthorized: false,
      stopImproveBlockedReason: "NO_AUTHORITY",
    },
    meta: {
      desiredStopLoss: 189.6,
      finalStopLoss: 189.65,
      telemetryProposalFloor: 189.6,
      executableHardFloor: 189.6,
      hardFloor: 189.6,
      structureTrailSource: "GATED",
      structureTrailAllowed: false,
      protectionGateOpen: false,
      winnerModeActive: false,
      beLockHit: false,
      greenLockActive: false,
      profitLockArmed: false,
      mfeLockTier: 0,
      mfeLockFloorPrice: null,
      tightenActive: false,
      hardGivebackExitArmed: false,
      shadowExitActive: false,
      exitAuthority: null,
      reasonTags: ["STRUCTURE_TRAIL_GATED"],
      stopImproveAuthorized: false,
      stopImproveBlockedReason: "NO_AUTHORITY",
    },
  };

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      info(payload, message) {
        logs.push({ payload, message });
      },
    },
    tradeStoreOverrides: {
      updateTrade: async () => {},
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return plan;
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 190;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      safeModifyCalls += 1;
    };

    const trade = {
      tradeId: "T-GUARD",
      status: "LIVE",
      side: "BUY",
      qty: 50,
      strategyStopLoss: 166.45,
      sizingStopLoss: 166.45,
      brokerStopLoss: 166.45,
      stopLoss: 166.45,
      entryPrice: 189.6,
      instrument_token: 12345,
      instrument: {
        tick_size: 0.05,
        segment: "NSE",
        tradingsymbol: "TEST",
        exchange: "NSE",
      },
      slOrderId: "SL-1",
    };
    const byId = new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 166.45,
        },
      ],
    ]);

    await tm._maybeDynamicAdjustExits(trade, byId);

    assert.equal(safeModifyCalls, 0);
  } finally {
    harness.restore();
  }
}

function buildAuthorityPlan({
  beLockHit = false,
  beApplied = false,
  trailAllowed = false,
  trailActive = false,
} = {}) {
  const protectionGateOpen = Boolean(beApplied || trailAllowed || trailActive);
  return {
    ok: true,
    sl: { stopLoss: 189.65 },
    finalStop: 189.65,
    stopImproveAuthorized: true,
    tradePatch: {
      telemetryProposalFloor: 189.6,
      executableHardFloor: 189.6,
      desiredStopLoss: 189.6,
      finalStopLoss: 189.65,
      hardFloor: 189.6,
      structureTrailSource: trailAllowed ? "TRAIL" : "GATED",
      structureTrailAllowed: trailAllowed,
      protectionGateOpen,
      winnerModeActive: protectionGateOpen,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
    },
    meta: {
      desiredStopLoss: 189.6,
      finalStopLoss: 189.65,
      telemetryProposalFloor: 189.6,
      executableHardFloor: 189.6,
      hardFloor: 189.6,
      structureTrailSource: trailAllowed ? "TRAIL" : "GATED",
      structureTrailAllowed: trailAllowed,
      protectionGateOpen,
      winnerModeActive: protectionGateOpen,
      beLockHit,
      beApplied,
      trailAllowed,
      trailActive,
      greenLockActive: false,
      profitLockArmed: false,
      mfeLockTier: 0,
      mfeLockFloorPrice: null,
      tightenActive: false,
      hardGivebackExitArmed: false,
      shadowExitActive: false,
      exitAuthority: null,
      reasonTags: beLockHit ? ["BE_ARM"] : [],
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
    },
  };
}

async function runDynamicStopPlan(plan) {
  const logs = [];
  let safeModifyCalls = 0;

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      info(payload, message) {
        logs.push({ payload, message });
      },
    },
    tradeStoreOverrides: {
      updateTrade: async () => {},
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return plan;
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 190;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      safeModifyCalls += 1;
    };

    const trade = {
      tradeId: "T-AUTH",
      status: "LIVE",
      side: "BUY",
      qty: 50,
      strategyStopLoss: 166.45,
      sizingStopLoss: 166.45,
      brokerStopLoss: 166.45,
      stopLoss: 166.45,
      entryPrice: 189.6,
      instrument_token: 12345,
      instrument: {
        tick_size: 0.05,
        segment: "NSE",
        tradingsymbol: "TEST",
        exchange: "NSE",
      },
      slOrderId: "SL-1",
    };
    const byId = new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 166.45,
        },
      ],
    ]);

    await tm._maybeDynamicAdjustExits(trade, byId);

    return { safeModifyCalls, logs };
  } finally {
    harness.restore();
  }
}

async function testBeLockHitDoesNotGrantDerivedAuthority() {
  const result = await runDynamicStopPlan(
    buildAuthorityPlan({ beLockHit: true }),
  );

  assert.equal(result.safeModifyCalls, 0);
}

async function testBeAppliedGrantsDerivedAuthority() {
  const result = await runDynamicStopPlan(
    buildAuthorityPlan({ beApplied: true }),
  );

  assert.equal(result.safeModifyCalls, 1);
}

async function testTrailAllowedGrantsDerivedAuthority() {
  const result = await runDynamicStopPlan(
    buildAuthorityPlan({ trailAllowed: true }),
  );

  assert.equal(result.safeModifyCalls, 1);
}

function buildBeProtectPlan({
  stopLoss = 104.05,
  beFloor = 104,
  beFloorSource = "MIN_GREEN",
  protectedStopSource = "MIN_GREEN",
} = {}) {
  return {
    ok: true,
    sl: { stopLoss },
    finalStop: stopLoss,
    stopImproveAuthorized: true,
    tradePatch: {
      beLocked: true,
      beLockedAt: new Date("2026-03-18T09:16:00.000Z"),
      beLockedAtPrice: beFloor,
      beEligible: true,
      beLockHit: true,
      trailHit: false,
      trailActive: false,
      telemetryProposalFloor: beFloor,
      executableHardFloor: beFloor,
      desiredStopLoss: beFloor,
      finalStopLoss: stopLoss,
      hardFloor: beFloor,
      structureTrailSource: null,
      structureTrailAllowed: false,
      protectionGateOpen: false,
      winnerModeActive: false,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
    },
    meta: {
      pnlInr: 60,
      minGreenSatisfied: true,
      beEligible: true,
      beArmed: true,
      beApplied: false,
      beLockHit: true,
      forceBePriorityMove: true,
      beFloor,
      beFloorSource,
      trailEligible: false,
      trailArmed: false,
      trailAllowed: false,
      trailActive: false,
      trailHit: false,
      trailBlockReason: "WAITING_FOR_BE_APPLY_OR_TRAIL_ARM",
      protectedStopSource,
      desiredStopLoss: beFloor,
      finalStopLoss: stopLoss,
      telemetryProposalFloor: beFloor,
      executableHardFloor: beFloor,
      hardFloor: beFloor,
      structureTrailSource: null,
      structureTrailAllowed: false,
      protectionGateOpen: false,
      winnerModeActive: false,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
      reasonTags: ["BE_ARM"],
    },
  };
}

function buildProtectionRuntimePlan({
  stopLoss = 104.2,
  desiredStopLoss = 104.15,
  hardFloor = 104.15,
  protectedStopSource = "EARLY_WINNER_RETENTION",
  protectionPhase = "PHASE_2_EARLY_WINNER_RETENTION",
  tradePatchOverrides = {},
  metaOverrides = {},
} = {}) {
  const tradePatch = {
    beLocked: true,
    beLockedAt: "2026-03-18T09:16:00.000Z",
    beLockedAtPrice: 104,
    beEligible: true,
    beLockHit: true,
    earlyWinnerEligible: true,
    earlyWinnerArmed: true,
    earlyWinnerConfirmed: true,
    earlyWinnerActive: true,
    earlyWinnerConfirmTicks: 2,
    earlyWinnerConfirmMs: 3000,
    earlyWinnerTier: 1,
    earlyWinnerKeepR: 0.12,
    earlyWinnerFloorPrice: desiredStopLoss,
    earlyWinnerFloorSource: protectedStopSource,
    dynamicTrailArmR: 0.68,
    handoffMaturity: 2,
    structureCandidateAvailable: true,
    structureReferenceType: "VWAP",
    structureReferencePrice: 20022,
    structureMappedFloor: desiredStopLoss,
    telemetryProposalFloor: desiredStopLoss,
    executableHardFloor: hardFloor,
    desiredStopLoss,
    finalStopLoss: stopLoss,
    hardFloor,
    protectedStopSource,
    protectionPhase,
    protectionStateVersion: 3,
    trailHit: false,
    trailActive: false,
    structureTrailAllowed: false,
    protectionGateOpen: true,
    winnerModeActive: true,
    stopImproveAuthorized: true,
    stopImproveBlockedReason: null,
    ...tradePatchOverrides,
  };

  return {
    ok: true,
    sl: { stopLoss },
    finalStop: stopLoss,
    stopImproveAuthorized: true,
    tradePatch,
    meta: {
      pnlInr: 68,
      currentExecutableR: 0.62,
      protectedPeakR: 0.7,
      peakExecutableR: 0.7,
      beEligible: true,
      beArmed: true,
      beApplied: true,
      beLockHit: true,
      beFloor: 104,
      beFloorSource: "MIN_GREEN",
      protectionPhase,
      earlyWinnerEligible: true,
      earlyWinnerArmed: true,
      earlyWinnerConfirmed: true,
      earlyWinnerTier: 1,
      earlyWinnerFloor: desiredStopLoss,
      earlyWinnerFloorSource: protectedStopSource,
      earlyWinnerKeepR: 0.12,
      earlyWinnerMfeLockActive: true,
      earlyWinnerHandoffReady: false,
      telemetryProposalFloor: desiredStopLoss,
      executableHardFloor: hardFloor,
      desiredStopLoss,
      finalStopLoss: stopLoss,
      hardFloor,
      protectedStopSource,
      dynamicTrailArmR: 0.68,
      handoffMaturity: 2,
      structureCandidateAvailable: true,
      structureReferenceType: "VWAP",
      structureReferencePrice: 20022,
      structureMappedFloor: desiredStopLoss,
      protectionStateVersion: 3,
      protectionGateOpen: true,
      winnerModeActive: true,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
      reasonTags: ["EARLY_WINNER_RETENTION"],
      ...metaOverrides,
    },
  };
}

function buildAlcCompressionPlan({
  stopLoss = 94.5,
  state = "L1",
  requestReady = true,
  requestOutcome = "ALC_REQUEST_READY",
  requestBlockedReason = null,
  pendingAction = null,
  retryCount = 0,
  appliedState = "NONE",
  appliedConfirmed = false,
  appliedSource = null,
  attributionConfidence = null,
} = {}) {
  const normalizedState = String(state || "L1").toUpperCase() === "L2" ? "L2" : "L1";
  const action = normalizedState === "L2" ? "COMPRESS_L2" : "COMPRESS_L1";
  const protectedStopSource = normalizedState === "L2" ? "ALC_L2" : "ALC_L1";
  const normalizedAppliedState =
    String(appliedState || "NONE").toUpperCase() === "L2" ? "L2" : String(appliedState || "NONE").toUpperCase() === "L1" ? "L1" : "NONE";
  const resolvedAppliedConfirmed =
    Boolean(appliedConfirmed) ||
    (normalizedAppliedState !== "NONE" &&
      requestOutcome === "ALC_APPLIED_CONFIRMED");
  const resolvedAppliedSource =
    appliedSource ||
    (resolvedAppliedConfirmed && normalizedAppliedState !== "NONE"
      ? normalizedAppliedState === "L2"
        ? "ALC_L2"
        : "ALC_L1"
      : null);
  const failureScore = normalizedState === "L2" ? 89 : 78;
  return {
    ok: true,
    sl: requestReady ? { stopLoss } : null,
    finalStop: stopLoss,
    stopImproveAuthorized: true,
    tradePatch: {
      loserCompressionDesiredAction: action,
      loserCompressionTargetState: normalizedState,
      loserCompressionSubmittedState:
        pendingAction === "STOP_MODIFY" ? normalizedState : "NONE",
      loserCompressionAppliedState: normalizedAppliedState,
      loserCompressionPendingAction: pendingAction,
      loserCompressionAppliedSource: resolvedAppliedSource,
      loserCompressionAppliedConfirmed: resolvedAppliedConfirmed,
      loserCompressionAttributionConfidence:
        resolvedAppliedConfirmed ? attributionConfidence || "HIGH" : null,
      loserCompressionRetryCount: retryCount,
      loserCompressionState: normalizedState,
      loserCompressionLastAction: action,
      loserCompressionReasonAtLastAction: `ALC_${action}`,
      loserCompressionScoreAtLastAction: failureScore,
      loserCompressionBlockedReason: requestBlockedReason,
      loserExitTriggered: false,
      loserExitReasonCode: null,
      desiredStopLoss: stopLoss,
      finalStopLoss: stopLoss,
      hardFloor: stopLoss,
      protectedStopSource,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
      winnerModeActive: false,
    },
    meta: {
      currentExecutableR: -0.55,
      peakExecutableR: 0.03,
      beEligible: false,
      beArmed: false,
      beApplied: false,
      minGreenSatisfied: false,
      trailAllowed: false,
      trailActive: false,
      protectedStopSource,
      desiredStopLoss: stopLoss,
      finalStopLoss: stopLoss,
      hardFloor: stopLoss,
      stopImproveAuthorized: true,
      stopImproveBlockedReason: null,
      loserCompressionEligible: true,
      loserCompressionActive: requestReady,
      loserCompressionAction: requestReady ? action : "HOLD",
      loserCompressionDesiredAction: action,
      loserCompressionReason: `ALC_${action}`,
      loserCompressionAuthority: "ADAPTIVE_LOSER_ENGINE",
      loserCompressionLevel: normalizedState === "L2" ? 2 : 1,
      loserCompressionTargetState: normalizedState,
      loserCompressionSubmittedState:
        pendingAction === "STOP_MODIFY" ? normalizedState : "NONE",
      loserCompressionAppliedState: normalizedAppliedState,
      loserCompressionPendingAction: pendingAction,
      loserCompressionPendingSince: null,
      loserCompressionRetryCount: retryCount,
      loserCompressionRequestOutcome: requestOutcome,
      loserCompressionAppliedSource: resolvedAppliedSource,
      loserCompressionAppliedConfirmed: resolvedAppliedConfirmed,
      loserCompressionAttributionConfidence:
        resolvedAppliedConfirmed ? attributionConfidence || "HIGH" : null,
      loserCompressionSuperseded:
        requestOutcome === "ALC_SUPERSEDE_L1_TO_L2",
      loserCompressionSupersedeReason:
        requestOutcome === "ALC_SUPERSEDE_L1_TO_L2"
          ? "ALC_SUPERSEDE_L1_TO_L2"
          : null,
      loserCompressionRequestReady: requestReady,
      loserCompressionRequestBlockedReason: requestBlockedReason,
      loserCompressionProposedStop: stopLoss,
      loserCompressionFinalStop: stopLoss,
      loserCompressionBlockedReason: requestBlockedReason,
      loserCompressionTriggeredAt: "2026-03-18T09:16:00.000Z",
      loserCompressionEscalated: normalizedState === "L2",
      alcRequested: true,
      alcRequestedLevel: normalizedState,
      alcAppliedLevel:
        resolvedAppliedConfirmed && normalizedAppliedState !== "NONE"
          ? normalizedAppliedState
          : null,
      alcAppliedSource: resolvedAppliedSource,
      alcAttributionConfidence:
        resolvedAppliedConfirmed ? attributionConfidence || "HIGH" : null,
      alcRequestedButNotApplied: !resolvedAppliedConfirmed,
      alcAppliedButSuperseded: false,
      alcSupersededBy: null,
      alcFinalProtectionOwner: protectedStopSource,
      failureScore,
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: null,
      exitAuthority: "ADAPTIVE_LOSER_ENGINE",
      reasonTags: [`ALC_${action}`],
    },
  };
}

function buildAlcExitPlan() {
  return {
    ok: true,
    action: { exitNow: true, reason: "ALC_EXIT_NOW" },
    stopImproveAuthorized: false,
    tradePatch: {
      loserCompressionDesiredAction: "EXIT_NOW",
      loserCompressionTargetState: "EXIT",
      loserCompressionSubmittedState: "NONE",
      loserCompressionAppliedState: "NONE",
      loserCompressionPendingAction: null,
      loserCompressionRetryCount: 0,
      loserCompressionState: "EXITED",
      loserCompressionLastAction: "EXIT_NOW",
      loserCompressionReasonAtLastAction: "ALC_EXIT_NOW",
      loserCompressionScoreAtLastAction: 97,
      loserCompressionBlockedReason: null,
      loserExitTriggered: true,
      loserExitReasonCode: "ALC_EXIT_NOW",
      stopImproveAuthorized: false,
      stopImproveBlockedReason: "EXIT_NOW",
      winnerModeActive: false,
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "ALC_EXIT_NOW",
      exitAuthority: "ADAPTIVE_LOSER_ENGINE",
    },
    meta: {
      beEligible: false,
      beArmed: false,
      beApplied: false,
      minGreenSatisfied: false,
      trailAllowed: false,
      trailActive: false,
      protectedStopSource: null,
      stopImproveAuthorized: false,
      stopImproveBlockedReason: "EXIT_NOW",
      loserCompressionEligible: true,
      loserCompressionActive: false,
      loserCompressionAction: "EXIT_NOW",
      loserCompressionDesiredAction: "EXIT_NOW",
      loserCompressionReason: "ALC_EXIT_NOW",
      loserCompressionAuthority: "ADAPTIVE_LOSER_ENGINE",
      loserCompressionLevel: 3,
      loserCompressionTargetState: "EXIT",
      loserCompressionSubmittedState: "NONE",
      loserCompressionAppliedState: "NONE",
      loserCompressionPendingAction: null,
      loserCompressionPendingSince: null,
      loserCompressionRetryCount: 0,
      loserCompressionRequestOutcome: "ALC_REQUEST_READY",
      loserCompressionAppliedConfirmed: false,
      loserCompressionSuperseded: false,
      loserCompressionSupersedeReason: null,
      loserCompressionRequestReady: true,
      loserCompressionRequestBlockedReason: null,
      loserCompressionBlockedReason: null,
      loserCompressionTriggeredAt: "2026-03-18T09:16:00.000Z",
      loserCompressionEscalated: true,
      loserExitTriggered: true,
      loserExitReasonCode: "ALC_EXIT_NOW",
      alcRequested: true,
      alcRequestedLevel: "EXIT",
      alcAppliedLevel: null,
      alcAppliedSource: null,
      alcAttributionConfidence: null,
      alcRequestedButNotApplied: true,
      alcAppliedButSuperseded: false,
      alcSupersededBy: null,
      alcFinalProtectionOwner: "ALC_EXIT_NOW",
      failureScore: 97,
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "ALC_EXIT_NOW",
      exitAuthority: "ADAPTIVE_LOSER_ENGINE",
    },
  };
}

function mergeTradePatches(trade, updates) {
  return updates.reduce((state, patch) => ({ ...state, ...patch }), { ...trade });
}

async function testBeApplySuccessMarksBrokerTruth() {
  const updates = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      updateTrade: async (_tradeId, patch) => {
        updates.push(patch);
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return buildBeProtectPlan();
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 106;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {};

    const trade = {
      ...makeRuntimeTrade("T-BE-SUCCESS"),
      entryPrice: 100,
      stopLoss: 90,
      brokerStopLoss: 90,
      strategyStopLoss: 90,
      sizingStopLoss: 90,
    };
    const byId = new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 90,
        },
      ],
    ]);

    await tm._maybeDynamicAdjustExits(trade, byId);

    const beAppliedPatch = updates.find((patch) => patch.beAppliedAt);
    assert.ok(beAppliedPatch);
    assert.equal(Number(beAppliedPatch.beAppliedStopLoss ?? 0), 104.05);
    assert.equal(Number(beAppliedPatch.stopLoss ?? 0), 104.05);
    assert.equal(Number(beAppliedPatch.slTrigger ?? 0), 104.05);
    assert.equal(Number(beAppliedPatch.beApplyFails ?? 0), 0);
    const runtimeTrade = mergeTradePatches(trade, updates);
    assert.equal(isWinnerProtectionActive(runtimeTrade), true);
    assert.equal(deriveStopExitReasonCode(runtimeTrade), "BREAK_EVEN");
  } finally {
    harness.restore();
  }
}

async function testBeApplyFailureDoesNotMarkBrokerTruth() {
  const updates = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      updateTrade: async (_tradeId, patch) => {
        updates.push(patch);
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return buildBeProtectPlan();
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 106;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      throw new Error("rate limit");
    };

    const trade = {
      ...makeRuntimeTrade("T-BE-FAIL"),
      entryPrice: 100,
      stopLoss: 90,
      brokerStopLoss: 90,
      strategyStopLoss: 90,
      sizingStopLoss: 90,
    };
    const byId = new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 90,
        },
      ],
    ]);

    await tm._maybeDynamicAdjustExits(trade, byId);

    assert.equal(
      updates.some((patch) => patch.beAppliedAt || patch.beAppliedStopLoss),
      false,
    );
    const failPatch = updates.find((patch) => patch.beApplyFails === 1);
    assert.ok(failPatch);
    assert.equal(Boolean(failPatch.protectionUpgradePending), true);
    assert.equal(Boolean(failPatch.protectionUpgradeSoftFailed), true);
    assert.equal(failPatch.protectionUpgradeFallbackMode, "SHADOW_PENDING");
    assert.equal(failPatch.shadowProtectionActiveReason, "MIN_GREEN");
    const runtimeTrade = mergeTradePatches(trade, updates);
    assert.equal(Boolean(runtimeTrade.protectionUpgradePending), true);
    assert.equal(Boolean(runtimeTrade.protectionUpgradeSoftFailed), true);
    assert.equal(runtimeTrade.protectionUpgradeFallbackMode, "SHADOW_PENDING");
    assert.equal(runtimeTrade.shadowProtectionActiveReason, "MIN_GREEN");
    assert.equal(Boolean(runtimeTrade.shadowExitActive), true);
    assert.ok(Number(runtimeTrade.protectionUpgradeTargetStopLoss ?? 0) > 0);
    assert.equal(isWinnerProtectionActive(runtimeTrade), false);
    assert.equal(deriveStopExitReasonCode(runtimeTrade), "HARD_SL");
  } finally {
    harness.restore();
  }
}

async function testProtectiveSoftFailureBreachesShadowAndPanics() {
  const updates = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      updateTrade: async (_tradeId, patch) => {
        updates.push(patch);
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return buildBeProtectPlan();
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let panicReason = null;

    tm._getLtp = async () => 103.9;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      throw new Error("timeout");
    };
    tm._panicExit = async (_trade, reason) => {
      panicReason = reason;
    };

    const trade = {
      ...makeRuntimeTrade("T-SHADOW-BREACH"),
      entryPrice: 100,
      stopLoss: 90,
      brokerStopLoss: 90,
      strategyStopLoss: 90,
      sizingStopLoss: 90,
    };
    const byId = new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 90,
        },
      ],
    ]);

    await tm._maybeDynamicAdjustExits(trade, byId);

    assert.equal(panicReason, "SHADOW_EXIT_BREACH");
    const runtimeTrade = mergeTradePatches(trade, updates);
    assert.equal(Boolean(runtimeTrade.protectionUpgradePending), true);
    assert.equal(Boolean(runtimeTrade.shadowExitActive), true);
    assert.equal(runtimeTrade.shadowProtectionActiveReason, "MIN_GREEN");
  } finally {
    harness.restore();
  }
}

async function testProtectionNoopSkipsWriteAndModifyIntent() {
  const plan = buildProtectionRuntimePlan();
  const tradeState = {
    ...makeRuntimeTrade("T-PROTECT-NOOP"),
    version: 9,
    stopLoss: 100.05,
    slTrigger: 100.05,
    brokerStopLoss: 100.05,
    desiredStopLoss: 104.15,
    finalStopLoss: 104.2,
    telemetryProposalFloor: 104.15,
    hardFloor: 104.15,
    executableHardFloor: 104.15,
    earlyWinnerFloorPrice: 104.15,
    structureMappedFloor: 104.15,
    protectedStopSource: "EARLY_WINNER_RETENTION",
    protectionPhase: "PHASE_2_EARLY_WINNER_RETENTION",
    earlyWinnerTier: 1,
    dynamicTrailArmR: 0.68,
    handoffMaturity: 2,
    protectionStateVersion: 8,
    protectionUpgradePending: true,
    protectionUpgradeTargetStopLoss: 104.2,
    ...plan.tradePatch,
  };
  let updateTradeCalls = 0;
  let safeModifyCalls = 0;

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async () => {
        updateTradeCalls += 1;
        throw new Error("updateTrade should not be called for noop protection state");
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return plan;
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 106.4;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      safeModifyCalls += 1;
      return { skipped: false };
    };

    await tm._maybeDynamicAdjustExits(tradeState, new Map([
      [
        "SL-1",
        {
          status: "TRIGGER PENDING",
          order_type: "SL-M",
          trigger_price: 100.05,
        },
      ],
    ]));

    assert.equal(updateTradeCalls, 0);
    assert.equal(safeModifyCalls, 0);
    assert.equal(Number(tradeState.protectionUpgradeTargetStopLoss ?? 0), 104.2);
  } finally {
    harness.restore();
  }
}

async function testProtectionConflictRetryAppliesOnce() {
  const tradeState = {
    ...makeRuntimeTrade("T-PROTECT-CONFLICT"),
    version: 11,
    desiredStopLoss: 100.05,
    finalStopLoss: 100.05,
    telemetryProposalFloor: 100.05,
    hardFloor: 100.05,
    protectedStopSource: "MIN_GREEN",
    protectionPhase: "PHASE_1_COST_PROTECTION",
    earlyWinnerTier: 0,
    handoffMaturity: 1,
    protectionStateVersion: 5,
  };
  let updateTradeCalls = 0;

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch, options = {}) => {
        updateTradeCalls += 1;
        if (updateTradeCalls === 1) {
          tradeState.version += 1;
          return {
            ok: false,
            status: "CONFLICT",
            expectedVersion: Number(options?.expectedVersion ?? 0),
            actualVersion: tradeState.version,
            trade: { ...tradeState },
          };
        }
        assert.equal(Number(options?.expectedVersion ?? 0), tradeState.version);
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
    envOverrides: {
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    const result = await tm._applyProtectionStatePatch({
      tradeId: tradeState.tradeId,
      trade: { ...tradeState },
      patch: {
        telemetryProposalFloor: 104.15,
        executableHardFloor: 104.15,
        desiredStopLoss: 104.15,
        finalStopLoss: 104.2,
        hardFloor: 104.15,
        protectedStopSource: "EARLY_WINNER_RETENTION",
        protectionPhase: "PHASE_2_EARLY_WINNER_RETENTION",
        earlyWinnerTier: 1,
        handoffMaturity: 2,
        protectionStateVersion: 3,
      },
      attemptId: "ATTEMPT-CONFLICT",
      computationId: "COMP-CONFLICT",
    });

    assert.equal(updateTradeCalls, 2);
    assert.equal(result.applied, true);
    assert.equal(result.protectionPatchConflict, true);
    assert.equal(Number(tradeState.desiredStopLoss ?? 0), 104.15);
    assert.equal(Number(tradeState.finalStopLoss ?? 0), 104.2);
    assert.equal(tradeState.protectedStopSource, "EARLY_WINNER_RETENTION");
    assert.equal(tradeState.protectionPhase, "PHASE_2_EARLY_WINNER_RETENTION");
    assert.equal(Number(tradeState.earlyWinnerTier ?? 0), 1);
    assert.equal(Number(tradeState.handoffMaturity ?? 0), 2);
    assert.ok(Number(tradeState.protectionStateVersion ?? 0) >= 6);
  } finally {
    harness.restore();
  }
}

async function testProtectionDominanceKeepsStrongerState() {
  const tradeState = {
    ...makeRuntimeTrade("T-PROTECT-DOMINANCE"),
    version: 17,
    desiredStopLoss: 104.35,
    finalStopLoss: 104.4,
    telemetryProposalFloor: 104.35,
    executableHardFloor: 104.35,
    hardFloor: 104.35,
    protectedStopSource: "MFE_LOCK_TIER_2",
    protectionPhase: "PHASE_3_PRE_TRAIL_MFE_LOCK",
    earlyWinnerTier: 2,
    handoffMaturity: 2,
    protectionStateVersion: 9,
  };
  let updateTradeCalls = 0;

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async () => {
        updateTradeCalls += 1;
        throw new Error("weaker protection patch should be skipped");
      },
    },
    envOverrides: {
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    const result = await tm._applyProtectionStatePatch({
      tradeId: tradeState.tradeId,
      trade: { ...tradeState },
      patch: {
        telemetryProposalFloor: 104.15,
        desiredStopLoss: 104.15,
        finalStopLoss: 104.2,
        hardFloor: 104.15,
        protectedStopSource: "EARLY_WINNER_RETENTION",
        protectionPhase: "PHASE_2_EARLY_WINNER_RETENTION",
        earlyWinnerTier: 1,
        handoffMaturity: 1,
      },
      attemptId: "ATTEMPT-DOMINANCE",
      computationId: "COMP-DOMINANCE",
    });

    assert.equal(updateTradeCalls, 0);
    assert.equal(result.applied, false);
    assert.equal(result.dominatedByCurrent, true);
    assert.equal(result.protectionWriteNoop, true);
    assert.equal(result.mergeAction, "DOMINATED_BY_CURRENT");
    assert.equal(
      result.protectionPatchSkippedReason,
      "DOMINATED_BY_CURRENT_PROTECTION",
    );
    assert.equal(Number(tradeState.finalStopLoss ?? 0), 104.4);
    assert.equal(tradeState.protectedStopSource, "MFE_LOCK_TIER_2");
    assert.equal(tradeState.protectionPhase, "PHASE_3_PRE_TRAIL_MFE_LOCK");
  } finally {
    harness.restore();
  }
}

async function testAlcSubmitMarksSubmittedUntilBrokerConfirmed() {
  const tradeState = {
    ...makeRuntimeTrade("T-ALC-SUBMIT"),
    version: 3,
    stopLoss: 90,
    slTrigger: 90,
    brokerStopLoss: 90,
    panicExitPending: false,
  };
  const byId = new Map([
    [
      "SL-1",
      {
        status: "TRIGGER PENDING",
        order_type: "SL-M",
        trigger_price: 90,
      },
    ],
  ]);

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      findTradeByOrder: async (orderId) =>
        String(orderId) === "SL-1"
          ? { trade: { ...tradeState }, link: { role: "SL" } }
          : null,
      appendOrderLog: async () => {},
      upsertLiveOrderSnapshot: async () => {},
      linkOrder: async () => {},
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan({ trade }) {
        const brokerConfirmed = Number(trade?.brokerStopLoss ?? 0) >= 94.5;
        return buildAlcCompressionPlan({
          state: "L1",
          stopLoss: 94.5,
          requestReady: !brokerConfirmed,
          requestOutcome: brokerConfirmed
            ? "ALC_APPLIED_CONFIRMED"
            : "ALC_REQUEST_READY",
          requestBlockedReason: brokerConfirmed
            ? "ALC_BLOCKED_ALREADY_CONFIRMED"
            : null,
          appliedState: brokerConfirmed ? "L1" : "NONE",
        });
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let modifyCalls = 0;
    tm._getLtp = async () => 94.8;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      modifyCalls += 1;
      return { skipped: false };
    };
    tm._scheduleReconcile = () => {};

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(modifyCalls, 1);
    assert.equal(tradeState.loserCompressionTargetState, "L1");
    assert.equal(tradeState.loserCompressionSubmittedState, "L1");
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(tradeState.loserCompressionPendingAction, "STOP_MODIFY");
    assert.equal(Boolean(tradeState.protectionUpgradePending), true);
    assert.equal(tradeState.loserCompressionBlockedReason, "ALC_REQUEST_SUBMITTED");
    assert.equal(Boolean(tradeState.loserCompressionAppliedConfirmed), false);
    assert.equal(tradeState.loserCompressionAppliedSource, null);
    assert.equal(Number(tradeState.brokerStopLoss ?? 0), 90);

    tm._bookRealizedPnl = async () => {};
    tm._finalizeClosed = async () => {};

    await tm.onOrderUpdate({
      order_id: "SL-1",
      status: "OPEN",
      order_type: "SL-M",
      trigger_price: 94.5,
      filled_quantity: 0,
      quantity: 50,
      exchange_update_timestamp: "2026-03-18T09:16:30.000Z",
    });

    assert.equal(Number(tradeState.brokerStopLoss ?? 0), 94.5);

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(tradeState.loserCompressionAppliedState, "L1");
    assert.equal(tradeState.loserCompressionPendingAction, null);
    assert.equal(tradeState.loserCompressionBlockedReason, "ALC_BLOCKED_ALREADY_CONFIRMED");
    assert.equal(Boolean(tradeState.loserCompressionAppliedConfirmed), true);
    assert.equal(tradeState.loserCompressionAppliedSource, "ALC_L1");
  } finally {
    harness.restore();
  }
}

async function testAlcSoftFailurePausesSpamAndRetriesAfterStale() {
  const tradeState = {
    ...makeRuntimeTrade("T-ALC-RETRY"),
    version: 7,
    stopLoss: 90,
    slTrigger: 90,
    brokerStopLoss: 90,
    panicExitPending: false,
  };
  const byId = new Map([
    [
      "SL-1",
      {
        status: "TRIGGER PENDING",
        order_type: "SL-M",
        trigger_price: 90,
      },
    ],
  ]);

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan({ trade }) {
        const pendingSinceMs = trade?.loserCompressionPendingSince
          ? new Date(trade.loserCompressionPendingSince).getTime()
          : NaN;
        const isFreshPending =
          trade?.loserCompressionPendingAction === "STOP_MODIFY" &&
          Number.isFinite(pendingSinceMs) &&
          Date.now() - pendingSinceMs < 8_000;
        return buildAlcCompressionPlan({
          state: "L1",
          stopLoss: 94.5,
          requestReady: !isFreshPending,
          requestOutcome: isFreshPending
            ? "ALC_HOLD"
            : Number(trade?.loserCompressionRetryCount ?? 0) > 0
              ? "ALC_RETRY_L1"
              : "ALC_REQUEST_READY",
          requestBlockedReason: isFreshPending
            ? "ALC_BLOCKED_PENDING_MODIFY"
            : null,
          pendingAction: isFreshPending ? "STOP_MODIFY" : null,
          retryCount: Number(trade?.loserCompressionRetryCount ?? 0),
        });
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let modifyCalls = 0;
    tm._getLtp = async () => 94.8;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      modifyCalls += 1;
      if (modifyCalls === 1) {
        throw new Error("timeout");
      }
      return { skipped: false };
    };

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(modifyCalls, 1);
    assert.equal(tradeState.loserCompressionSubmittedState, "L1");
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(tradeState.loserCompressionPendingAction, "STOP_MODIFY");
    assert.equal(tradeState.loserCompressionBlockedReason, "ALC_REQUEST_STALE");
    assert.equal(Number(tradeState.loserCompressionRetryCount ?? 0), 1);

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);
    assert.equal(modifyCalls, 1);

    const staleTs = new Date(Date.now() - 20_000).toISOString();
    tradeState.loserCompressionPendingSince = staleTs;
    tradeState.loserCompressionLastAttemptAt = staleTs;
    tradeState.protectionUpgradeUnconfirmedSince = staleTs;
    tm._dynExitFailBackoffUntil.set(tradeState.tradeId, Date.now() - 1);

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(modifyCalls, 2);
    assert.equal(tradeState.loserCompressionSubmittedState, "L1");
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(tradeState.loserCompressionPendingAction, "STOP_MODIFY");
    assert.equal(tradeState.loserCompressionBlockedReason, "ALC_REQUEST_SUBMITTED");
  } finally {
    harness.restore();
  }
}

async function testAlcDoesNotConfirmFromNonAlcWinnerStop() {
  const tradeState = {
    ...makeRuntimeTrade("T-ALC-NONALC"),
    loserCompressionTargetState: "L1",
    loserCompressionSubmittedState: "L1",
    loserCompressionAppliedState: "NONE",
    loserCompressionPendingAction: null,
    loserCompressionLastRequestedStop: 94.5,
    protectedStopSource: "GREEN_LOCK",
    protectionUpgradePending: false,
    shadowProtectionActiveReason: null,
    stopLoss: 96,
    slTrigger: 96,
    brokerStopLoss: 90,
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
        return {
          ok: true,
          status: "APPLIED",
          version: 1,
          trade: { ...tradeState },
        };
      },
      appendOrderLog: async () => {},
      upsertLiveOrderSnapshot: async () => {},
      linkOrder: async () => {},
      findTradeByOrder: async (orderId) =>
        orderId === "SL-1"
          ? {
              trade: { ...tradeState },
              link: { role: "SL" },
            }
          : null,
    },
    envOverrides: {
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    await tm.onOrderUpdate({
      order_id: "SL-1",
      status: "OPEN",
      order_type: "SL-M",
      trigger_price: 96,
      filled_quantity: 0,
      quantity: 50,
      exchange_update_timestamp: "2026-03-18T09:16:45.000Z",
    });

    assert.equal(Number(tradeState.brokerStopLoss ?? 0), 96);
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(Boolean(tradeState.loserCompressionAppliedConfirmed), false);
    assert.equal(tradeState.loserCompressionAppliedSource, null);
  } finally {
    harness.restore();
  }
}

async function testAlcSellSupersedeToL2WithoutFalseApply() {
  const tradeState = {
    ...makeRuntimeTrade("T-ALC-SELL-L2"),
    side: "SELL",
    version: 11,
    entryPrice: 100,
    stopLoss: 106.5,
    slTrigger: 106.5,
    brokerStopLoss: 110,
    loserCompressionTargetState: "L1",
    loserCompressionSubmittedState: "L1",
    loserCompressionAppliedState: "NONE",
    loserCompressionPendingAction: "STOP_MODIFY",
    loserCompressionPendingSince: new Date().toISOString(),
    loserCompressionLastRequestedStop: 106.5,
    loserCompressionLastAttemptAt: new Date().toISOString(),
    loserCompressionRetryCount: 1,
    protectionUpgradePending: true,
    protectionUpgradeTargetStopLoss: 106.5,
  };
  const byId = new Map([
    [
      "SL-1",
      {
        status: "TRIGGER PENDING",
        order_type: "SL-M",
        trigger_price: 110,
      },
    ],
  ]);

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan({ trade }) {
        const pendingSinceMs = trade?.loserCompressionPendingSince
          ? new Date(trade.loserCompressionPendingSince).getTime()
          : NaN;
        const isFreshPending =
          trade?.loserCompressionPendingAction === "STOP_MODIFY" &&
          Number.isFinite(pendingSinceMs) &&
          Date.now() - pendingSinceMs < 8_000 &&
          String(trade?.loserCompressionTargetState || "").toUpperCase() === "L2";
        return buildAlcCompressionPlan({
          state: "L2",
          stopLoss: 105.5,
          requestReady: !isFreshPending,
          requestOutcome: isFreshPending
            ? "ALC_HOLD"
            : "ALC_SUPERSEDE_L1_TO_L2",
          requestBlockedReason: isFreshPending
            ? "ALC_BLOCKED_PENDING_MODIFY"
            : null,
          pendingAction: isFreshPending ? "STOP_MODIFY" : null,
          retryCount: Number(trade?.loserCompressionRetryCount ?? 0),
          appliedState: String(trade?.loserCompressionAppliedState || "NONE"),
        });
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      PROTECTION_DEDUPE_ENABLED: "true",
      PROTECTION_NOOP_WRITE_SKIP: "true",
      PROTECTION_CONFLICT_RETRY_ONCE: "true",
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let modifyCalls = 0;
    tm._getLtp = async () => 105.2;
    tm._trackDynExitCadence = () => {};
    tm._safeModifyOrder = async () => {
      modifyCalls += 1;
      return { skipped: false };
    };

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(modifyCalls, 1);
    assert.equal(tradeState.loserCompressionTargetState, "L2");
    assert.equal(tradeState.loserCompressionSubmittedState, "L2");
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(tradeState.loserCompressionPendingAction, "STOP_MODIFY");
    assert.equal(Number(tradeState.brokerStopLoss ?? 0), 110);

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);
    assert.equal(modifyCalls, 1);
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
  } finally {
    harness.restore();
  }
}

async function testAlcExitRequestAndConfirmLifecycle() {
  const tradeState = {
    ...makeRuntimeTrade("T-ALC-EXIT"),
    version: 13,
    stopLoss: 90,
    slTrigger: 90,
    brokerStopLoss: 90,
    panicExitPending: false,
    qty: 50,
  };
  const byId = new Map([
    [
      "SL-1",
      {
        status: "TRIGGER PENDING",
        order_type: "SL-M",
        trigger_price: 90,
      },
    ],
  ]);

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      findTradeByOrder: async (orderId) =>
        String(orderId) === "PANIC-1"
          ? { trade: { ...tradeState }, link: { role: "PANIC_EXIT" } }
          : null,
      appendOrderLog: async () => {},
      upsertLiveOrderSnapshot: async () => {},
      linkOrder: async ({ order_id }) => {
        if (String(order_id) === "PANIC-1") {
          tradeState.panicExitOrderId = "PANIC-1";
        }
      },
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return buildAlcExitPlan();
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {
        getPositions: async () => ({
          net: [
            {
              instrument_token: tradeState.instrument_token,
              quantity: tradeState.qty,
            },
          ],
        }),
      },
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 93.2;
    tm._trackDynExitCadence = () => {};
    tm._safeCancelOrder = async () => {};
    tm._safePlaceOrder = async () => ({ orderId: "PANIC-1" });
    tm._replayOrphanUpdates = async () => {};
    tm._schedulePanicExitWatch = () => {};
    tm._clearTimeStopFallback = () => {};
    tm._bookRealizedPnl = async () => {};
    tm._finalizeClosed = async () => {};
    tm._scheduleReconcile = () => {};

    await tm._maybeDynamicAdjustExits({ ...tradeState }, byId);

    assert.equal(tradeState.status, "PANIC_EXIT_PLACED");
    assert.equal(tradeState.panicExitOrderId, "PANIC-1");
    assert.equal(tradeState.loserCompressionTargetState, "EXIT");
    assert.equal(tradeState.loserCompressionSubmittedState, "EXIT");
    assert.equal(tradeState.loserCompressionAppliedState, "NONE");
    assert.equal(tradeState.loserCompressionPendingAction, "EXIT_REQUEST");
    assert.equal(Boolean(tradeState.loserExitTriggered), true);
    assert.equal(Boolean(tradeState.loserCompressionAppliedConfirmed), false);

    await tm.onOrderUpdate({
      order_id: "PANIC-1",
      status: "COMPLETE",
      average_price: 93.2,
      filled_quantity: 50,
      quantity: 50,
      exchange_update_timestamp: "2026-03-18T09:17:00.000Z",
    });

    assert.equal(tradeState.status, "CLOSED");
    assert.equal(tradeState.loserCompressionAppliedState, "EXIT");
    assert.equal(tradeState.loserCompressionPendingAction, null);
    assert.equal(tradeState.loserCompressionBlockedReason, "ALC_APPLIED_CONFIRMED");
    assert.equal(Boolean(tradeState.loserCompressionAppliedConfirmed), true);
    assert.equal(tradeState.loserCompressionAppliedSource, "ALC_EXIT_NOW");
  } finally {
    harness.restore();
  }
}

function buildAuthorizedEarlyFailPlan() {
  return {
    ok: true,
    action: { exitNow: true, reason: "EARLY_STRUCTURE_FAILURE" },
    tradePatch: {
      earlyFailArmed: true,
      earlyFailReason: "EARLY_STRUCTURE_FAILURE",
      earlyFailMode: "STRUCTURE",
      earlyFailEligible: true,
      earlyFailAuthority: "EARLY_FAIL_ENGINE",
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "EARLY_STRUCTURE_FAILURE",
      exitAuthority: "EARLY_FAIL_ENGINE",
    },
    meta: {
      earlyFailArmed: true,
      earlyFailMode: "STRUCTURE",
      earlyFailReason: "EARLY_STRUCTURE_FAILURE",
      earlyFailEligible: true,
      earlyFailAuthority: "EARLY_FAIL_ENGINE",
      earlyFailSinceTs: "2026-03-18T09:15:12.000Z",
      earlyFailTradeAgeMs: 16000,
      earlyFailBarsSinceEntry: 1,
      earlyFailConfirmTicks: 2,
      earlyFailConfirmTarget: 2,
      earlyFailConfirmMs: 1000,
      earlyFailBufferUsed: 7.5,
      earlyFailReferenceLevel: 19950,
      earlyFailReferenceSource: "PLAN_UNDERLYING_STOP",
      earlyFailBreachAmount: 30,
      earlyFailMfeAtDecision: 0.1,
      earlyFailAdverseRAtDecision: 0.15,
      earlyFailMaeAtDecision: 0.15,
      earlyFailDecisionState: "EXIT_AUTHORIZED",
      shouldExitNowReason: "EARLY_STRUCTURE_FAILURE",
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "EARLY_STRUCTURE_FAILURE",
      exitAuthority: "EARLY_FAIL_ENGINE",
    },
  };
}

function makeRuntimeTrade(tradeId = "T-EARLY") {
  return {
    tradeId,
    status: "LIVE",
    side: "BUY",
    qty: 50,
    entryPrice: 100,
    strategyStopLoss: 90,
    sizingStopLoss: 90,
    brokerStopLoss: 90,
    stopLoss: 90,
    initialStopLoss: 90,
    loserCompressionDesiredAction: "HOLD",
    loserCompressionTargetState: "NONE",
    loserCompressionSubmittedState: "NONE",
    loserCompressionAppliedState: "NONE",
    loserCompressionPendingAction: null,
    loserCompressionPendingSince: null,
    loserCompressionLastRequestedStop: null,
    loserCompressionLastConfirmedStop: null,
    loserCompressionLastAttemptAt: null,
    loserCompressionLastConfirmedAt: null,
    loserCompressionAppliedSource: null,
    loserCompressionAppliedConfirmed: false,
    loserCompressionAttributionConfidence: null,
    loserCompressionRetryCount: 0,
    instrument_token: 12345,
    createdAt: "2026-03-18T09:15:00.000Z",
    entryFilledAt: "2026-03-18T09:15:00.000Z",
    instrument: {
      tick_size: 0.05,
      segment: "NSE",
      tradingsymbol: "TEST",
      exchange: "NSE",
    },
    slOrderId: "SL-1",
  };
}

async function testTp1RunnerRebasesWinnerStateAndMarksBeLive() {
  const tradeState = {
    ...makeRuntimeTrade("T-TP1-RUNNER"),
    qty: 50,
    initialQty: 50,
    entryPrice: 100,
    strategyStopLoss: 90,
    sizingStopLoss: 90,
    brokerStopLoss: 90,
    stopLoss: 90,
    slTrigger: 90,
    tp1Price: 104,
    tp1Qty: 20,
    partialRealizedPnl: 20,
    peakLtp: 108,
    peakPnlInr: 400,
    peakExecutablePnlInr: 350,
    peakPnlR: 0.8,
    peakExecutableR: 0.7,
    protectedPeakR: 0.7,
    protectedCurrentR: 0.55,
    mfeLockTier: 2,
    mfeLockFloorR: 0.45,
    greenLockActive: true,
    givebackR: 0.25,
    hardGivebackExitArmed: true,
  };
  const updates = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        updates.push(patch);
        Object.assign(tradeState, patch);
      },
    },
    envOverrides: {
      SPREAD_SAMPLE_ON_EXIT: "false",
      RUNNER_BE_BUFFER_TICKS: 1,
      DYN_BE_COST_MULT: 0,
      TELEGRAM_MIN_LEVEL: "error",
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let partialBooked = null;
    let ensuredQty = null;

    tm._bookPartialPnlLeg = async (payload) => {
      partialBooked = payload;
    };
    tm._safeModifyOrder = async () => ({ skipped: false });
    tm._placeRunnerTargetOnly = async () => {
      tradeState.targetOrderId = "TARGET-RUNNER";
    };
    tm._ensureExitQty = async (_tradeId, qty) => {
      ensuredQty = qty;
    };

    await tm._onTp1Filled(tradeState.tradeId, { ...tradeState }, {
      filled_quantity: 20,
      average_price: 104,
      price: 104,
    });

    assert.deepEqual(partialBooked, {
      tradeId: "T-TP1-RUNNER",
      side: "BUY",
      entryPrice: 100,
      exitPrice: 104,
      qty: 20,
      label: "TP1",
    });
    assert.equal(ensuredQty, 30);
    assert.equal(tradeState.tp1Done, true);
    assert.equal(tradeState.qty, 30);
    assert.equal(tradeState.runnerQty, 30);
    assert.equal(tradeState.runnerRebaseSource, "TP1");
    assert.ok(tradeState.runnerRebasedAt);
    assert.equal(tradeState.runnerBaselineQty, 30);
    assert.equal(Number(tradeState.runnerBaselineLtp ?? 0), 104);
    assert.equal(Number(tradeState.runnerBaselineExecutablePrice ?? 0), 104);
    assert.equal(Number(tradeState.runnerBaselinePnlInr ?? 0), 120);
    assert.equal(Number(tradeState.runnerBaselineExecutablePnlInr ?? 0), 120);
    assert.equal(Number(tradeState.runnerRealizedPnlInr ?? 0), 100);
    assert.equal(Number(tradeState.peakPnlInr ?? 0), 120);
    assert.equal(Number(tradeState.peakExecutablePnlInr ?? 0), 120);
    assert.equal(Number(tradeState.executionRiskQty ?? 0), 30);
    assert.equal(Number(tradeState.executionRiskInr ?? 0), 300);
    assert.equal(Number(tradeState.givebackR ?? 0), 0);
    assert.equal(Number(tradeState.mfeLockTier ?? 0), 0);
    assert.equal(Boolean(tradeState.greenLockActive), false);
    assert.equal(Boolean(tradeState.hardGivebackExitArmed), false);
    assert.equal(Number(tradeState.stopLoss ?? 0), 100.05);
    assert.equal(Number(tradeState.slTrigger ?? 0), 100.05);
    assert.equal(Number(tradeState.beAppliedStopLoss ?? 0), 100.05);
    assert.ok(tradeState.beAppliedAt);
    assert.equal(Boolean(tradeState.beLocked), true);
    assert.equal(Boolean(tradeState.protectionUpgradePending), false);
    assert.equal(isWinnerProtectionActive(tradeState), true);
    assert.equal(deriveStopExitReasonCode(tradeState), "BREAK_EVEN");
  } finally {
    harness.restore();
  }
}

async function testEarlyFailAuthorizationLogsDecisionFacts() {
  const infoLogs = [];
  const warnLogs = [];
  const panicCalls = [];

  const earlyFailPlan = buildAuthorizedEarlyFailPlan();

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      info(payload, message) {
        infoLogs.push({ payload, message });
      },
      warn(payload, message) {
        warnLogs.push({ payload, message });
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return earlyFailPlan;
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    tradeStoreOverrides: {
      updateTrade: async () => {},
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      EARLY_FAIL_LOG_VERBOSE: true,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 98.5;
    tm._trackDynExitCadence = () => {};
    tm._panicExit = async (_trade, reason) => {
      panicCalls.push(reason);
    };

    const trade = makeRuntimeTrade("T-EARLY");

    await tm._maybeDynamicAdjustExits(trade, new Map());

    assert.deepEqual(panicCalls, ["EARLY_STRUCTURE_FAILURE"]);

    const evalLog = infoLogs.find((entry) =>
      String(entry.message || "").includes("[dyn_exit] eval"),
    );
    assert.ok(evalLog);
    assert.equal(evalLog.payload.earlyFailMode, "STRUCTURE");
    assert.equal(evalLog.payload.earlyFailDecisionState, "EXIT_AUTHORIZED");
    assert.equal(evalLog.payload.earlyFailReferenceSource, "PLAN_UNDERLYING_STOP");
    assert.equal(evalLog.payload.earlyFailConfirmTicks, 2);
    assert.equal(evalLog.payload.earlyFailConfirmTarget, 2);
    assert.equal(evalLog.payload.earlyFailBufferUsed, 7.5);
    assert.equal(evalLog.payload.earlyFailAdverseRAtDecision, 0.15);

    const authLog = warnLogs.find((entry) =>
      String(entry.message || "").includes("EARLY_FAIL_EXIT_AUTHORIZED"),
    );
    assert.ok(authLog);
    assert.equal(authLog.payload.exitAuthority, "EARLY_FAIL_ENGINE");
    assert.equal(authLog.payload.earlyFailReferenceLevel, 19950);
    assert.equal(authLog.payload.earlyFailBreachAmount, 30);
    assert.equal(authLog.payload.earlyFailDecisionState, "EXIT_AUTHORIZED");
    assert.equal(authLog.payload.earlyFailBufferUsed, 7.5);
    assert.equal(authLog.payload.earlyFailAdverseRAtDecision, 0.15);
  } finally {
    harness.restore();
  }
}

async function testEarlyFailAuthorizationLogsCompactWhenVerboseOff() {
  const infoLogs = [];
  const warnLogs = [];
  const panicCalls = [];
  const earlyFailPlan = buildAuthorizedEarlyFailPlan();

  const harness = loadTradeManagerHarness({
    loggerOverrides: {
      info(payload, message) {
        infoLogs.push({ payload, message });
      },
      warn(payload, message) {
        warnLogs.push({ payload, message });
      },
    },
    dynamicExitManagerOverrides: {
      computeDynamicExitPlan() {
        return earlyFailPlan;
      },
    },
    candleStoreOverrides: {
      getRecentCandles: async () => [],
    },
    tradeStoreOverrides: {
      updateTrade: async () => {},
    },
    envOverrides: {
      DYNAMIC_EXITS_ENABLED: "true",
      DYNAMIC_EXIT_MIN_INTERVAL_MS: 0,
      DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS: 0,
      EARLY_FAIL_LOG_VERBOSE: false,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._getLtp = async () => 98.5;
    tm._trackDynExitCadence = () => {};
    tm._panicExit = async (_trade, reason) => {
      panicCalls.push(reason);
    };

    await tm._maybeDynamicAdjustExits(makeRuntimeTrade("T-EARLY-COMPACT"), new Map());

    assert.deepEqual(panicCalls, ["EARLY_STRUCTURE_FAILURE"]);

    const evalLog = infoLogs.find((entry) =>
      String(entry.message || "").includes("[dyn_exit] eval"),
    );
    assert.ok(evalLog);
    assert.equal(evalLog.payload.earlyFailMode, "STRUCTURE");
    assert.equal(evalLog.payload.earlyFailReason, "EARLY_STRUCTURE_FAILURE");
    assert.equal(evalLog.payload.earlyFailReferenceLevel, 19950);
    assert.equal(evalLog.payload.earlyFailBreachAmount, 30);
    assert.equal(evalLog.payload.earlyFailTradeAgeMs, 16000);
    assert.equal(evalLog.payload.earlyFailConfirmTicks, 2);
    assert.equal(evalLog.payload.earlyFailConfirmMs, 1000);
    assert.equal(evalLog.payload.earlyFailBufferUsed, undefined);
    assert.equal(evalLog.payload.earlyFailCandidateReason, undefined);
    assert.equal(evalLog.payload.earlyFailMfeAtDecision, undefined);

    const authLog = warnLogs.find((entry) =>
      String(entry.message || "").includes("EARLY_FAIL_EXIT_AUTHORIZED"),
    );
    assert.ok(authLog);
    assert.equal(authLog.payload.tradeId, "T-EARLY-COMPACT");
    assert.equal(authLog.payload.earlyFailMode, "STRUCTURE");
    assert.equal(authLog.payload.earlyFailReason, "EARLY_STRUCTURE_FAILURE");
    assert.equal(authLog.payload.earlyFailReferenceLevel, 19950);
    assert.equal(authLog.payload.earlyFailBreachAmount, 30);
    assert.equal(authLog.payload.earlyFailTradeAgeMs, 16000);
    assert.equal(authLog.payload.earlyFailDecisionState, "EXIT_AUTHORIZED");
    assert.equal(authLog.payload.earlyFailBufferUsed, undefined);
    assert.equal(authLog.payload.earlyFailCandidateReason, undefined);
    assert.equal(authLog.payload.earlyFailAdverseRAtDecision, undefined);
  } finally {
    harness.restore();
  }
}

async function testStaleEntryReplayIsIgnoredEarly() {
  let appendOrderLogCalls = 0;
  let updateTradeCalls = 0;

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      findTradeByOrder: async () => ({
        trade: {
          tradeId: "T-1",
          status: "SL_CONFIRMED",
          entryOrderId: "ENTRY-1",
          qty: 50,
        },
        link: { role: "ENTRY" },
      }),
      getTrade: async () => ({
        tradeId: "T-1",
        status: "SL_CONFIRMED",
        entryOrderId: "ENTRY-1",
        qty: 50,
      }),
      appendOrderLog: async () => {
        appendOrderLogCalls += 1;
      },
      updateTrade: async () => {
        updateTradeCalls += 1;
      },
      linkOrder: async () => {},
      upsertLiveOrderSnapshot: async () => {},
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._scheduleReconcile = () => {};

    const order = {
      order_id: "ENTRY-1",
      status: "COMPLETE",
      filled_quantity: 50,
      average_price: 102.5,
      pending_quantity: 0,
      exchange_update_timestamp: "2026-03-18T09:16:00.000Z",
    };
    const staleOpenReplay = {
      ...order,
      status: "OPEN",
      exchange_update_timestamp: "2026-03-18T09:17:00.000Z",
    };

    await tm.onOrderUpdate(order);
    await tm.onOrderUpdate(staleOpenReplay);
    await tm.onOrderUpdate(order);

    assert.equal(appendOrderLogCalls, 1);
    assert.equal(updateTradeCalls, 0);
  } finally {
    harness.restore();
  }
}

async function testTradeCommandSerializesReconcileAndOrderUpdate() {
  const events = [];
  const tradeState = {
    ...makeRuntimeTrade("T-SERIAL"),
    version: 5,
    panicExitPending: false,
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch, options = {}) => {
        const expectedVersion = Number(
          options?.expectedVersion ?? tradeState.version,
        );
        if (expectedVersion !== tradeState.version) {
          return {
            ok: false,
            status: "CONFLICT",
            expectedVersion,
            actualVersion: tradeState.version,
            trade: { ...tradeState },
          };
        }
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    const reconcilePromise = tm._runTradeCommand(
      tradeState.tradeId,
      "RECONCILE_DIFF_RESOLUTION",
      async () => {
        events.push("reconcile-start");
        await sleep(30);
        await tm._updateTrade(tradeState.tradeId, { status: "SL_CONFIRMED" });
        events.push("reconcile-end");
      },
      { seedTrade: { ...tradeState }, allowMissing: true },
    );

    await sleep(5);

    const orderPromise = tm._runTradeCommand(
      tradeState.tradeId,
      "APPLY_ORDER_UPDATE",
      async () => {
        events.push("order-start");
        await tm._updateTrade(tradeState.tradeId, { panicExitPending: true });
        events.push("order-end");
      },
      { seedTrade: { ...tradeState }, allowMissing: true },
    );

    await Promise.all([reconcilePromise, orderPromise]);

    assert.deepEqual(events, [
      "reconcile-start",
      "reconcile-end",
      "order-start",
      "order-end",
    ]);
    assert.equal(tradeState.status, "SL_CONFIRMED");
    assert.equal(Boolean(tradeState.panicExitPending), true);
    assert.equal(tradeState.version, 7);
  } finally {
    harness.restore();
  }
}

async function testRestoreDynamicExitStatePreservesPendingProtection() {
  const tradeState = {
    ...makeRuntimeTrade("T-RESTORE"),
    version: 4,
    protectionUpgradePending: true,
    protectionUpgradeSoftFailed: true,
    protectionUpgradeFallbackMode: "SHADOW_PENDING",
    protectionUpgradeUnconfirmedSince: "2026-03-18T09:16:00.000Z",
    protectionUpgradeTargetStopLoss: 104.05,
    shadowProtectionActiveReason: "MIN_GREEN",
    shadowExitActive: true,
    beLocked: true,
    beAppliedAt: null,
    beAppliedStopLoss: null,
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      updateTrade: async (_tradeId, patch, options = {}) => {
        const expectedVersion = Number(
          options?.expectedVersion ?? tradeState.version,
        );
        if (expectedVersion !== tradeState.version) {
          return {
            ok: false,
            status: "CONFLICT",
            expectedVersion,
            actualVersion: tradeState.version,
            trade: { ...tradeState },
          };
        }
        Object.assign(tradeState, patch);
        tradeState.version += 1;
        return {
          ok: true,
          status: "APPLIED",
          version: tradeState.version,
          trade: { ...tradeState },
        };
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    await tm._restoreDynamicExitState([tradeState]);

    assert.equal(Boolean(tradeState.protectionUpgradePending), true);
    assert.equal(Boolean(tradeState.protectionUpgradeSoftFailed), true);
    assert.equal(tradeState.protectionUpgradeFallbackMode, "SHADOW_PENDING");
    assert.equal(tradeState.shadowProtectionActiveReason, "MIN_GREEN");
    assert.equal(Boolean(tradeState.shadowExitActive), true);
    assert.equal(Number(tradeState.protectionUpgradeTargetStopLoss ?? 0), 104.05);
    assert.ok(Object.prototype.hasOwnProperty.call(tradeState, "peakLtp"));
  } finally {
    harness.restore();
  }
}

async function testTradeManagerStopLifecycle() {
  let exitLoopTicks = 0;
  let reconcileRuns = 0;

  const harness = loadTradeManagerHarness({
    envOverrides: {
      EXIT_LOOP_MS: 20,
      RECONCILE_ON_ORDER_UPDATE: "true",
      RECONCILE_DEBOUNCE_MS: 40,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    tm._exitLoopTick = async () => {
      exitLoopTicks += 1;
    };
    tm.reconcile = async () => {
      reconcileRuns += 1;
      return { ok: true };
    };

    tm._startExitLoop();
    await sleep(550);
    assert.ok(exitLoopTicks >= 2);

    tm._scheduleReconcile("test_stop");
    await tm.stop();

    const ticksAfterStop = exitLoopTicks;
    await sleep(325);

    assert.equal(tm._exitLoopTimer, null);
    assert.equal(tm._reconcileTimer, null);
    assert.equal(exitLoopTicks, ticksAfterStop);
    assert.equal(reconcileRuns, 0);

    await tm.stop();
    assert.equal(tm._exitLoopTimer, null);
  } finally {
    harness.restore();
  }
}

async function testFinalizeClosedCleansTradeRuntimeState() {
  const tradeId = "T-CLOSE";
  const trade = {
    tradeId,
    status: "CLOSED",
    instrument_token: 321,
    side: "BUY",
    qty: 25,
    entryPrice: 100,
    exitPrice: 104,
  };
  const fired = [];

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...trade }),
      updateTrade: async () => {},
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    const arm = (label) =>
      setTimeout(() => {
        fired.push(label);
      }, 40);

    tm.activeTradeId = tradeId;
    tm.recoveredPosition = { instrument_token: trade.instrument_token };
    tm._activeTradeToken = trade.instrument_token;
    tm._activeTradeSide = trade.side;
    tm.exitPlacementLocks.add(tradeId);
    tm._eodConvertAttempted.add(tradeId);
    tm._dynExitLastAt.set(tradeId, Date.now());
    tm._dynExitLastEvalAt.set(tradeId, Date.now());
    tm._dynExitFailCount.set(tradeId, 1);
    tm._dynExitDisabled.add(tradeId);
    tm._dynExitInFlight.add(tradeId);
    tm._dynExitFailBackoffUntil.set(tradeId, Date.now() + 1000);
    tm._dynPeakLtpByTrade.set(tradeId, 101);
    tm._slWatch.set(tradeId, { timer: arm("sl") });
    tm._targetWatch.set(tradeId, { timer: arm("target") });
    tm._targetWatchdogInFlight.add(tradeId);
    tm._virtualTargetWatch.set(tradeId, { armedAtMs: Date.now() });
    tm._entryFallbackTimers.set(tradeId, arm("entry"));
    tm._entryFallbackInFlight.add(tradeId);
    tm._entryPendingCancelInFlight.add(tradeId);
    tm._panicExitTimers.set(tradeId, arm("panic"));
    tm._panicExitRetryCount.set(tradeId, 2);
    tm._panicExitInFlight.add(tradeId);
    tm._timeStopEscalationAt.set(tradeId, Date.now());
    tm._timeStopFallbackTimers.set(tradeId, arm("time_stop"));
    tm._slSafetyTimers.set(tradeId, arm("sl_sla"));
    tm._virtualTargetFetchInFlight.add(tradeId);

    await tm._finalizeClosed(tradeId, trade.instrument_token);

    assert.equal(tm.activeTradeId, null);
    assert.equal(tm.recoveredPosition, null);
    assert.equal(tm._activeTradeToken, null);
    assert.equal(tm._activeTradeSide, null);
    assert.equal(tm.exitPlacementLocks.has(tradeId), false);
    assert.equal(tm._eodConvertAttempted.has(tradeId), false);
    assert.equal(tm._dynExitLastAt.has(tradeId), false);
    assert.equal(tm._dynExitLastEvalAt.has(tradeId), false);
    assert.equal(tm._dynExitFailCount.has(tradeId), false);
    assert.equal(tm._dynExitDisabled.has(tradeId), false);
    assert.equal(tm._dynExitInFlight.has(tradeId), false);
    assert.equal(tm._dynExitFailBackoffUntil.has(tradeId), false);
    assert.equal(tm._dynPeakLtpByTrade.has(tradeId), false);
    assert.equal(tm._slWatch.has(tradeId), false);
    assert.equal(tm._targetWatch.has(tradeId), false);
    assert.equal(tm._targetWatchdogInFlight.has(tradeId), false);
    assert.equal(tm._virtualTargetWatch.has(tradeId), false);
    assert.equal(tm._entryFallbackTimers.has(tradeId), false);
    assert.equal(tm._entryFallbackInFlight.has(tradeId), false);
    assert.equal(tm._entryPendingCancelInFlight.has(tradeId), false);
    assert.equal(tm._panicExitTimers.has(tradeId), false);
    assert.equal(tm._panicExitRetryCount.has(tradeId), false);
    assert.equal(tm._panicExitInFlight.has(tradeId), false);
    assert.equal(tm._timeStopEscalationAt.has(tradeId), false);
    assert.equal(tm._timeStopFallbackTimers.has(tradeId), false);
    assert.equal(tm._slSafetyTimers.has(tradeId), false);
    assert.equal(tm._virtualTargetFetchInFlight.has(tradeId), false);

    await sleep(80);
    assert.deepEqual(fired, []);

    tm._cleanupTradeRuntimeState(tradeId);
    assert.equal(tm._slWatch.has(tradeId), false);
    assert.equal(tm._panicExitTimers.has(tradeId), false);
  } finally {
    harness.restore();
  }
}

async function testFinalizeEntryFillUsesReducedQtyForExitSync() {
  const tradeState = {
    tradeId: "T-FILL",
    status: "ENTRY_OPEN",
    side: "BUY",
    qty: 50,
    instrument_token: 12345,
    instrument: { tick_size: 0.05 },
    quoteAtEntry: { bps: 10 },
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
      },
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let ensuredQty = null;

    tm._buildEntryFillMetrics = () => ({
      avg: 100,
      qty: 50,
      slippageLog: { expected: 100, rawSlipBps: 0, effMaxBps: 50 },
      adverseSlipBps: 0,
      effKillBps: 100,
      entryType: "LIMIT",
      shouldPanicForSlippage: false,
      entryFillPatch: {
        entryPrice: 100,
        actualEntry: 100,
        qty: 50,
        entryFinalized: true,
      },
    });
    tm._buildEntryRiskPatch = () => ({
      minGreen: { minGreenInr: 0, minGreenPts: 0 },
      actualRisk: { riskPts: 1, riskInr: 50 },
      timeStopAt: null,
      patch: {},
    });
    tm._placeExitsIfMissing = async () => {};
    tm._postFillRiskRecheckAndAdjust = async () => {
      tradeState.qty = 25;
      tradeState.postFillRiskAction = "REDUCED";
      return { exited: false };
    };
    tm._recalcTargetFromActualFill = async () => {};
    tm._ensureExitQty = async (_tradeId, qty) => {
      ensuredQty = qty;
    };
    tm._recordTradeDecision = () => {};
    tm.risk.resetFailures = () => {};

    await tm._finalizeEntryFill({
      tradeId: tradeState.tradeId,
      trade: { ...tradeState },
      avgPrice: 100,
      filledQty: 50,
      source: "TEST",
      partial: false,
    });

    assert.equal(ensuredQty, 25);
  } finally {
    harness.restore();
  }
}

async function testEntryLimitFallbackEscalatesAmbiguousRecovery() {
  const tradeState = {
    tradeId: "T-FALLBACK",
    entryOrderId: "ENTRY-1",
    status: "ENTRY_OPEN",
    entryFinalized: false,
    qty: 50,
    instrument_token: 12345,
    instrument: { tick_size: 0.05 },
    candle: { close: 100 },
  };

  const harness = loadTradeManagerHarness({
    tradeStoreOverrides: {
      getTrade: async () => ({ ...tradeState }),
      updateTrade: async (_tradeId, patch) => {
        Object.assign(tradeState, patch);
      },
    },
    envOverrides: {
      ENTRY_LIMIT_FALLBACK_GRACE_MS: 0,
    },
  });

  try {
    const { TradeManager } = harness;
    const tm = new TradeManager({
      kite: {},
      riskEngine: makeRiskEngine(),
    });

    let recoveryArgs = null;

    tm._getOrderStatus = async () => ({
      status: "OPEN",
      order: { filled_quantity: 0, average_price: 0 },
    });
    tm._safeCancelOrder = async () => {};
    tm._checkLateFillAfterCancel = async () => ({
      status: "OPEN",
      order: { filled_quantity: 0, average_price: 0 },
    });
    tm._recoverAmbiguousEntryState = async (args) => {
      recoveryArgs = args;
      return { ok: true };
    };
    tm._clearEntryLimitFallbackTimer = () => {};

    await tm._entryLimitFallbackFire({
      tradeId: tradeState.tradeId,
      entryOrderId: tradeState.entryOrderId,
      entryParams: {},
    });

    assert.equal(recoveryArgs?.tradeId, "T-FALLBACK");
    assert.equal(recoveryArgs?.entryOrderId, "ENTRY-1");
    assert.equal(recoveryArgs?.source, "ENTRY_LIMIT_FALLBACK_CANCEL");
  } finally {
    harness.restore();
  }
}

async function main() {
  await testReconcileInitGuard();
  await testProtectiveSlIsNotFastWatched();
  await testExitQtySkipsNoopModify();
  await testTargetQtySyncFallbackVirtualizesStaleTarget();
  await testSafeModifyOrderSkipsBrokerAlreadyMatchingTarget();
  await testSafeModifyOrderSkipsTinyStopDelta();
  await testDynamicSlModifyBlockedWithoutAuthority();
  await testBeLockHitDoesNotGrantDerivedAuthority();
  await testBeAppliedGrantsDerivedAuthority();
  await testTrailAllowedGrantsDerivedAuthority();
  await testBeApplySuccessMarksBrokerTruth();
  await testBeApplyFailureDoesNotMarkBrokerTruth();
  await testProtectiveSoftFailureBreachesShadowAndPanics();
  await testProtectionNoopSkipsWriteAndModifyIntent();
  await testProtectionConflictRetryAppliesOnce();
  await testProtectionDominanceKeepsStrongerState();
  await testAlcSubmitMarksSubmittedUntilBrokerConfirmed();
  await testAlcSoftFailurePausesSpamAndRetriesAfterStale();
  await testAlcDoesNotConfirmFromNonAlcWinnerStop();
  await testAlcSellSupersedeToL2WithoutFalseApply();
  await testAlcExitRequestAndConfirmLifecycle();
  await testTp1RunnerRebasesWinnerStateAndMarksBeLive();
  await testEarlyFailAuthorizationLogsDecisionFacts();
  await testEarlyFailAuthorizationLogsCompactWhenVerboseOff();
  await testTradeCommandSerializesReconcileAndOrderUpdate();
  await testRestoreDynamicExitStatePreservesPendingProtection();
  await testStaleEntryReplayIsIgnoredEarly();
  await testTradeManagerStopLifecycle();
  await testFinalizeClosedCleansTradeRuntimeState();
  await testFinalizeEntryFillUsesReducedQtyForExitSync();
  await testEntryLimitFallbackEscalatesAmbiguousRecovery();
  console.log("tradeManagerRuntime.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
