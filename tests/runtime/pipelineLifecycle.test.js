const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const BASE_TS = Date.parse("2026-01-01T09:15:00.000Z");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPipelineHarness({
  envOverrides = {},
  tradeManagerOverrides = {},
  candleBuilderOverrides = {},
  strategyEngineOverrides = {},
  loggerOverrides = {},
} = {}) {
  const pipelinePath = path.join(ROOT, "src", "pipeline.js");
  const configPath = path.join(ROOT, "src", "config.js");
  const candleBuilderPath = path.join(ROOT, "src", "market", "candleBuilder.js");
  const candleCachePath = path.join(ROOT, "src", "market", "candleCache.js");
  const candleWriteBufferPath = path.join(
    ROOT,
    "src",
    "market",
    "candleWriteBuffer.js",
  );
  const riskEnginePath = path.join(ROOT, "src", "risk", "riskEngine.js");
  const tradeManagerPath = path.join(ROOT, "src", "trading", "tradeManager.js");
  const strategyEnginePath = path.join(
    ROOT,
    "src",
    "strategy",
    "strategyEngine.js",
  );
  const loggerPath = path.join(ROOT, "src", "logger.js");
  const mongoStatePath = path.join(
    ROOT,
    "src",
    "runtime",
    "mongoRuntimeState.js",
  );

  delete require.cache[require.resolve(pipelinePath)];

  const { env } = require(configPath);
  const candleBuilderModule = require(candleBuilderPath);
  const candleCacheModule = require(candleCachePath);
  const candleWriteBufferModule = require(candleWriteBufferPath);
  const riskEngineModule = require(riskEnginePath);
  const tradeManagerModule = require(tradeManagerPath);
  const strategyEngineModule = require(strategyEnginePath);
  const { logger } = require(loggerPath);
  const mongoStateModule = require(mongoStatePath);
  if (typeof mongoStateModule.resetMongoRuntimeStateForTests === "function") {
    mongoStateModule.resetMongoRuntimeStateForTests();
  }

  const stats = {
    finalizerTicks: 0,
    writerStarts: 0,
    writerStops: 0,
    traderStops: 0,
  };

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

  class StubCandleBuilder {
    addIndexTokens() {}

    onTicks() {
      return [];
    }

    finalizeDue() {
      stats.finalizerTicks += 1;
      return [];
    }

    getCurrentCandle() {
      return null;
    }
  }

  class StubCandleCache {
    addCandles() {}

    addCandle() {}

    getCandles() {
      return [];
    }
  }

  class StubCandleWriteBuffer {
    start() {
      stats.writerStarts += 1;
    }

    async stop() {
      stats.writerStops += 1;
    }

    enqueue() {}
  }

  class StubRiskEngine {}

  class StubTradeManager {
    setRuntimeAddTokens() {}

    async init() {}

    onTick() {}

    async onSignal() {}

    async onOrderUpdate() {}

    async reconcile() {
      return { ok: true };
    }

    async positionFirstReconcile() {
      return { ok: true };
    }

    async setKillSwitch() {}

    async status() {
      return { ok: true };
    }

    async stop() {
      stats.traderStops += 1;
    }
  }

  patchObject(StubCandleBuilder.prototype, candleBuilderOverrides);
  patchObject(StubTradeManager.prototype, tradeManagerOverrides);

  patchObject(candleBuilderModule, { CandleBuilder: StubCandleBuilder });
  patchObject(candleCacheModule, { CandleCache: StubCandleCache });
  patchObject(candleWriteBufferModule, {
    CandleWriteBuffer: StubCandleWriteBuffer,
  });
  patchObject(riskEngineModule, { RiskEngine: StubRiskEngine });
  patchObject(tradeManagerModule, { TradeManager: StubTradeManager });
  patchObject(strategyEngineModule, strategyEngineOverrides);
  patchObject(logger, loggerOverrides);
  patchEnv({
    CANDLE_INTERVALS: "1",
    CANDLE_TIMER_FINALIZER_ENABLED: "true",
    CANDLE_FINALIZER_INTERVAL_MS: 20,
    ...envOverrides,
  });

  const { buildPipeline } = require(pipelinePath);

  return {
    buildPipeline,
    stats,
    restore() {
      delete require.cache[require.resolve(pipelinePath)];
      while (restorers.length) {
        const restore = restorers.pop();
        restore();
      }
    },
  };
}

async function testPipelineStopLifecycle() {
  const harness = loadPipelineHarness();
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });

    await sleep(80);
    assert.ok(harness.stats.finalizerTicks >= 2);
    assert.equal(harness.stats.writerStarts, 1);

    await pipeline.stop();

    const ticksAfterStop = harness.stats.finalizerTicks;
    await sleep(70);

    assert.equal(harness.stats.writerStops, 1);
    assert.equal(harness.stats.traderStops, 1);
    assert.equal(harness.stats.finalizerTicks, ticksAfterStop);

    await pipeline.stop();
    assert.equal(harness.stats.writerStops, 1);
    assert.equal(harness.stats.traderStops, 1);
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

async function testTradePathRuntimeAbortEscalation() {
  const logs = [];
  let closeCount = 0;
  const signal = {
    signalId: "sig-runtime-abort",
    regimeSnapshotId: "snap-runtime-abort",
    instrument_token: 12345,
    side: "BUY",
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    confidence: 67.1,
    intervalMin: 1,
    regime: "TREND",
    preEmit: {
      routeConfidence: {
        preRouteScore: 50.2,
        expectedRouteAdjustment: -0.7,
        routedScore: 49.5,
        estimated: true,
      },
    },
    conversionSummary: {
      routeAttempted: false,
      preRouteScore: 50.2,
      expectedRouteAdjustment: -0.7,
      routedConfidence: 49.5,
      routeConfidenceBasis: "ESTIMATED",
    },
  };

  const harness = loadPipelineHarness({
    envOverrides: {
      CANDLE_TIMER_FINALIZER_ENABLED: "false",
      FNO_ENABLED: "true",
      FNO_MODE: "OPT",
    },
    candleBuilderOverrides: {
      onTicks() {
        closeCount += 1;
        return [
          {
            instrument_token: 12345,
            interval_min: 1,
            ts: new Date(BASE_TS + closeCount * 60_000),
            close: 101 + closeCount * 0.1,
          },
        ];
      },
    },
    strategyEngineOverrides: {
      async evaluateOnCandleClose() {
        return {
          ...signal,
          candle: {
            interval_min: 1,
            ts: new Date(BASE_TS + closeCount * 60_000),
          },
        };
      },
    },
    tradeManagerOverrides: {
      async onSignal() {
        throw new Error("router exploded before contract selection");
      },
    },
    loggerOverrides: {
      info(payload, message) {
        logs.push({ level: "info", payload, message });
      },
      warn(payload, message) {
        logs.push({ level: "warn", payload, message });
      },
      error(payload, message) {
        logs.push({ level: "error", payload, message });
      },
    },
  });
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    await pipeline.onTicks([
      { instrument_token: 12345, last_price: 101, timestamp: new Date(BASE_TS) },
    ]);
    await pipeline.onTicks([
      { instrument_token: 12345, last_price: 101.2, timestamp: new Date(BASE_TS + 500) },
    ]);

    const runtimeAbortLog = logs.find(
      (entry) =>
        String(entry.message || "").includes(
          "[route] candidate failed before contract selection",
        ),
    );
    assert.ok(
      runtimeAbortLog,
      "structured runtime-abort event should be emitted for trade-path exceptions",
    );

    const payload = runtimeAbortLog.payload || {};
    assert.equal(payload.runtimeAbortCategory, "RUNTIME_ERROR");
    assert.equal(payload.stage, "signal_dispatch");
    assert.equal(payload.substage, "bar_close");
    assert.equal(payload.signalId, "sig-runtime-abort");
    assert.equal(payload.regimeSnapshotId, "snap-runtime-abort");
    assert.equal(payload.token, 12345);
    assert.equal(payload.strategyId, "ema_pullback");
    assert.equal(payload.side, "BUY");
    assert.equal(payload.timeframe, 1);
    assert.equal(payload.routeMode, "OPT");
    assert.equal(payload.routeAttempted, false);
    assert.equal(payload.contractSelectionStarted, false);
    assert.equal(payload.estimatedRoutePhase, true);
    assert.equal(payload.actualRoutePhase, false);
    assert.equal(payload.errorName, "Error");
    assert.ok(
      String(payload.errorMessage || "").includes(
        "router exploded before contract selection",
      ),
    );

    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").includes("[pipeline] task failed"),
      ),
      true,
      "generic pipeline failure log should still be present",
    );
    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").toLowerCase().includes("suppressed"),
      ),
      false,
      "runtime abort should not be misclassified as suppression",
    );
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

async function testPipelineSerializesOrderUpdateAndReconcile() {
  const events = [];
  let inFlight = 0;
  const harness = loadPipelineHarness({
    tradeManagerOverrides: {
      async onOrderUpdate() {
        events.push("order-start");
        inFlight += 1;
        assert.equal(inFlight, 1);
        await sleep(30);
        inFlight -= 1;
        events.push("order-end");
      },
      async reconcile() {
        events.push("reconcile-start");
        assert.equal(inFlight, 0);
        inFlight += 1;
        await sleep(5);
        inFlight -= 1;
        events.push("reconcile-end");
      },
    },
  });
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    const orderPromise = pipeline.onOrderUpdate({ order_id: "ORDER-1" });
    const reconcilePromise = pipeline.reconcile();

    await Promise.all([orderPromise, reconcilePromise]);

    assert.deepEqual(events, [
      "order-start",
      "order-end",
      "reconcile-start",
      "reconcile-end",
    ]);
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

async function testReconcileMongoDegradationIsClassifiedAndDeferred() {
  const logs = [];
  const harness = loadPipelineHarness({
    envOverrides: {
      CANDLE_TIMER_FINALIZER_ENABLED: "false",
    },
    tradeManagerOverrides: {
      async reconcile() {
        throw new Error(
          "Timed out while checking out a connection from connection pool",
        );
      },
    },
    loggerOverrides: {
      info(payload, message) {
        logs.push({ level: "info", payload, message });
      },
      warn(payload, message) {
        logs.push({ level: "warn", payload, message });
      },
      error(payload, message) {
        logs.push({ level: "error", payload, message });
      },
    },
  });
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    const out = await pipeline.reconcile();

    assert.equal(out?.deferred, true);
    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").includes(
          "[reconcile] deferred due to mongo degradation",
        ),
      ) ||
        logs.some((entry) =>
          String(entry.message || "").includes(
            "[reconcile] skipped due to severe mongo pressure",
          ),
        ),
      true,
    );
    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").includes("[pipeline] task failed"),
      ),
      false,
      "known mongo degradation should not surface as generic pipeline task failure",
    );
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

async function testReconcileNonMongoErrorsStillSurfaceAsPipelineFailures() {
  const logs = [];
  const harness = loadPipelineHarness({
    envOverrides: {
      CANDLE_TIMER_FINALIZER_ENABLED: "false",
    },
    tradeManagerOverrides: {
      async reconcile() {
        throw new Error("reconcile logic bug");
      },
    },
    loggerOverrides: {
      info(payload, message) {
        logs.push({ level: "info", payload, message });
      },
      warn(payload, message) {
        logs.push({ level: "warn", payload, message });
      },
      error(payload, message) {
        logs.push({ level: "error", payload, message });
      },
    },
  });
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    await pipeline.reconcile();

    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").includes("[pipeline] task failed"),
      ),
      true,
    );
    assert.equal(
      logs.some((entry) =>
        String(entry.message || "").includes(
          "[reconcile] deferred due to mongo degradation",
        ),
      ),
      false,
      "non-mongo reconcile failures must not be masked as degradation defers",
    );
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

async function testPipelineWiresCoordinatorAwareReconcileRunner() {
  let injectedRunner = null;
  let injectedOptions = null;
  const harness = loadPipelineHarness({
    envOverrides: {
      CANDLE_TIMER_FINALIZER_ENABLED: "false",
    },
    tradeManagerOverrides: {
      setReconcileRunner(fn, options = {}) {
        injectedRunner = fn;
        injectedOptions = options;
      },
    },
  });
  let pipeline = null;

  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    assert.equal(typeof injectedRunner, "function");
    assert.equal(injectedOptions?.coordinatorAware, true);
    assert.equal(injectedRunner, pipeline.reconcile);
  } finally {
    try {
      await pipeline?.stop?.();
    } catch {}
    harness.restore();
  }
}

function testBeConfigSurfaceIsTruthful() {
  const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const { env } = require(path.join(ROOT, "src", "config.js"));

  assert.equal(envText.includes("BE_LOCK_ENABLED="), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(env, "BE_LOCK_ENABLED"),
    false,
  );
}

async function main() {
  await testPipelineStopLifecycle();
  await testPipelineSerializesOrderUpdateAndReconcile();
  await testPipelineWiresCoordinatorAwareReconcileRunner();
  await testReconcileMongoDegradationIsClassifiedAndDeferred();
  await testReconcileNonMongoErrorsStillSurfaceAsPipelineFailures();
  await testTradePathRuntimeAbortEscalation();
  testBeConfigSurfaceIsTruthful();
  console.log("pipelineLifecycle.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
