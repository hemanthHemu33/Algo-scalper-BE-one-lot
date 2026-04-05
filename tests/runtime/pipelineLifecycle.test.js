const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadPipelineHarness({
  envOverrides = {},
  tradeManagerOverrides = {},
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

  delete require.cache[require.resolve(pipelinePath)];

  const { env } = require(configPath);
  const candleBuilderModule = require(candleBuilderPath);
  const candleCacheModule = require(candleCachePath);
  const candleWriteBufferModule = require(candleWriteBufferPath);
  const riskEngineModule = require(riskEnginePath);
  const tradeManagerModule = require(tradeManagerPath);

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

  patchObject(StubTradeManager.prototype, tradeManagerOverrides);

  patchObject(candleBuilderModule, { CandleBuilder: StubCandleBuilder });
  patchObject(candleCacheModule, { CandleCache: StubCandleCache });
  patchObject(candleWriteBufferModule, {
    CandleWriteBuffer: StubCandleWriteBuffer,
  });
  patchObject(riskEngineModule, { RiskEngine: StubRiskEngine });
  patchObject(tradeManagerModule, { TradeManager: StubTradeManager });
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
  testBeConfigSurfaceIsTruthful();
  console.log("pipelineLifecycle.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
