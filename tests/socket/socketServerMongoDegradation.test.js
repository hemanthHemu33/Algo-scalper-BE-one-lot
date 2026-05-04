const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadSocketHarness({
  envOverrides = {},
  tickerManagerOverrides = {},
  mongoWorkGateOverrides = {},
  dbOverrides = {},
  haltOverrides = {},
  tradingEnabledOverrides = {},
  tokenWatcherOverrides = {},
  loggerOverrides = {},
} = {}) {
  const socketServerPath = path.join(ROOT, "src", "socket", "socketServer.js");
  const configPath = path.join(ROOT, "src", "config.js");
  const tickerManagerPath = path.join(ROOT, "src", "kite", "tickerManager.js");
  const mongoWorkGatePath = path.join(ROOT, "src", "runtime", "mongoWorkGate.js");
  const dbPath = path.join(ROOT, "src", "db.js");
  const haltPath = path.join(ROOT, "src", "runtime", "halt.js");
  const tradingEnabledPath = path.join(
    ROOT,
    "src",
    "runtime",
    "tradingEnabled.js",
  );
  const tokenWatcherPath = path.join(ROOT, "src", "tokenWatcher.js");
  const loggerPath = path.join(ROOT, "src", "logger.js");

  delete require.cache[require.resolve(socketServerPath)];

  const { env } = require(configPath);
  const tickerManager = require(tickerManagerPath);
  const mongoWorkGate = require(mongoWorkGatePath);
  const db = require(dbPath);
  const halt = require(haltPath);
  const tradingEnabled = require(tradingEnabledPath);
  const tokenWatcher = require(tokenWatcherPath);
  const { logger } = require(loggerPath);

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

  patchObject(tickerManager, tickerManagerOverrides);
  patchObject(mongoWorkGate, mongoWorkGateOverrides);
  patchObject(db, dbOverrides);
  patchObject(halt, haltOverrides);
  patchObject(tradingEnabled, tradingEnabledOverrides);
  patchObject(tokenWatcher, tokenWatcherOverrides);
  patchObject(logger, loggerOverrides);
  patchEnv({
    MONGO_SOCKET_STALE_WARN_MS: "1000",
    SOCKET_STATUS_MAX_STALE_MS: "60000",
    ...envOverrides,
  });

  const socketServerModule = require(socketServerPath);

  return {
    ...socketServerModule,
    restore() {
      delete require.cache[require.resolve(socketServerPath)];
      while (restorers.length) {
        restorers.pop()();
      }
    },
  };
}

async function testSocketStatusReturnsStructuredWaitingStateBeforePipelineReady() {
  const harness = loadSocketHarness({
    tickerManagerOverrides: {
      getPipeline: () => {
        throw new Error("Pipeline not ready yet");
      },
      getTickerStatus: () => ({ connected: false, hasSession: false }),
    },
    mongoWorkGateOverrides: {
      evaluateMongoWorkGate: () => ({
        deferred: false,
        severity: "HEALTHY",
        status: "HEALTHY",
        release() {},
      }),
    },
    dbOverrides: {
      getMongoRuntimeState: () => ({
        connected: true,
        degraded: false,
        severity: "HEALTHY",
        state: "HEALTHY",
      }),
    },
    haltOverrides: {
      isHalted: () => false,
      getHaltInfo: () => null,
    },
    tokenWatcherOverrides: {
      getTokenWatcherStatus: () => ({
        hasValidToken: false,
        lastReason: "NO_TOKEN",
      }),
    },
    tradingEnabledOverrides: {
      getTradingEnabled: () => true,
    },
  });

  try {
    const snap = await harness.__test.buildStatusSnapshot();
    assert.equal(snap.pipelineReady, false);
    assert.equal(snap.pipelineState, "WAITING_FOR_TOKEN");
    assert.equal(snap.reasonCode, "NO_TOKEN");
    assert.equal(snap.statusSource, "memory");
    assert.equal(snap.statusStale, false);
  } finally {
    harness.restore();
  }
}

async function testSocketStatusMarksCachedSnapshotStaleDuringMongoDegradation() {
  const harness = loadSocketHarness({
    tickerManagerOverrides: {
      getPipeline: () => ({
        status: async () => ({ ok: true }),
      }),
      getTickerStatus: () => ({ connected: true, hasSession: true }),
    },
    mongoWorkGateOverrides: {
      evaluateMongoWorkGate: () => ({
        deferred: true,
        severity: "DEGRADED",
        status: "DEGRADED",
        backoffMs: 1_000,
      }),
    },
    dbOverrides: {
      getMongoRuntimeState: () => ({
        connected: true,
        degraded: true,
        severity: "DEGRADED",
        state: "DEGRADED",
      }),
    },
    haltOverrides: {
      isHalted: () => false,
      getHaltInfo: () => null,
    },
    tokenWatcherOverrides: {
      getTokenWatcherStatus: () => ({
        hasValidToken: true,
        lastReason: "startup",
      }),
    },
    tradingEnabledOverrides: {
      getTradingEnabled: () => true,
    },
  });

  try {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.__test.setPipelineStatusCacheForTests(
      {
        ok: true,
        tradesToday: 7,
        ordersPlacedToday: 3,
      },
      Date.now() - 4_000,
    );

    const snap = await harness.__test.buildStatusSnapshot();
    assert.equal(snap.statusSource, "cache");
    assert.equal(snap.statusStale, true);
    assert.equal(Number(snap.statusStaleMs || 0) >= 3_000, true);
    assert.equal(snap.statusVeryStale, false);
    assert.equal(snap.warning, "DB_DEGRADED_STATUS_STALE");
    assert.equal(snap.mongoSeverity, "DEGRADED");
    assert.equal(snap.mongoState, "DEGRADED");
  } finally {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.restore();
  }
}

async function testSocketStatusMarksVeryStaleCache() {
  const harness = loadSocketHarness({
    envOverrides: {
      SOCKET_STATUS_MAX_STALE_MS: "1000",
    },
    tickerManagerOverrides: {
      getPipeline: () => ({
        status: async () => ({ ok: true }),
      }),
      getTickerStatus: () => ({ connected: true, hasSession: true }),
    },
    mongoWorkGateOverrides: {
      evaluateMongoWorkGate: () => ({
        deferred: true,
        severity: "SEVERELY_DEGRADED",
        status: "SEVERELY_DEGRADED",
        backoffMs: 2_000,
      }),
    },
    dbOverrides: {
      getMongoRuntimeState: () => ({
        connected: true,
        degraded: true,
        severity: "SEVERELY_DEGRADED",
        state: "SEVERELY_DEGRADED",
      }),
    },
    haltOverrides: {
      isHalted: () => false,
      getHaltInfo: () => null,
    },
    tokenWatcherOverrides: {
      getTokenWatcherStatus: () => ({
        hasValidToken: true,
        lastReason: "startup",
      }),
    },
    tradingEnabledOverrides: {
      getTradingEnabled: () => true,
    },
  });

  try {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.__test.setPipelineStatusCacheForTests({ ok: true }, Date.now() - 4_000);

    const snap = await harness.__test.buildStatusSnapshot();
    assert.equal(snap.statusSource, "cache");
    assert.equal(snap.statusStale, true);
    assert.equal(snap.statusVeryStale, true);
    assert.equal(snap.warning, "DB_DEGRADED_STATUS_VERY_STALE");
    assert.equal(snap.mongoSeverity, "SEVERELY_DEGRADED");
  } finally {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.restore();
  }
}

async function testSocketStatusReturnsUnavailableWhenMongoDeferredWithoutCache() {
  const harness = loadSocketHarness({
    tickerManagerOverrides: {
      getPipeline: () => ({
        status: async () => ({ ok: true }),
      }),
      getTickerStatus: () => ({ connected: true, hasSession: true }),
    },
    mongoWorkGateOverrides: {
      evaluateMongoWorkGate: () => ({
        deferred: true,
        severity: "DEGRADED",
        status: "DEGRADED",
        backoffMs: 1_000,
      }),
    },
    dbOverrides: {
      getMongoRuntimeState: () => ({
        connected: true,
        degraded: true,
        severity: "DEGRADED",
        state: "DEGRADED",
      }),
    },
    haltOverrides: {
      isHalted: () => false,
      getHaltInfo: () => null,
    },
    tokenWatcherOverrides: {
      getTokenWatcherStatus: () => ({
        hasValidToken: true,
        lastReason: "startup",
      }),
    },
    tradingEnabledOverrides: {
      getTradingEnabled: () => true,
    },
  });

  try {
    harness.__test.resetPipelineStatusCacheForTests();
    const snap = await harness.__test.buildStatusSnapshot();
    assert.equal(snap.dbStatusMode, "unavailable");
    assert.equal(snap.dbStatusNoCache, true);
    assert.equal(snap.dbStatusFreshnessUnavailable, true);
    assert.equal(snap.mongoGateDeferred, true);
  } finally {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.restore();
  }
}

async function testSocketStatusHealthyPathRefreshesLive() {
  let pipelineStatusCalls = 0;
  const harness = loadSocketHarness({
    tickerManagerOverrides: {
      getPipeline: () => ({
        status: async () => {
          pipelineStatusCalls += 1;
          return {
            ok: true,
            tradesToday: 12,
            ordersPlacedToday: 5,
            tradingEnabled: false,
          };
        },
      }),
      getTickerStatus: () => ({ connected: true, hasSession: true }),
    },
    mongoWorkGateOverrides: {
      evaluateMongoWorkGate: () => ({
        deferred: false,
        severity: "HEALTHY",
        status: "HEALTHY",
        release() {},
      }),
    },
    dbOverrides: {
      getMongoRuntimeState: () => ({
        connected: true,
        degraded: false,
        severity: "HEALTHY",
        state: "HEALTHY",
      }),
    },
    haltOverrides: {
      isHalted: () => false,
      getHaltInfo: () => null,
    },
    tokenWatcherOverrides: {
      getTokenWatcherStatus: () => ({
        hasValidToken: true,
        lastReason: "startup",
      }),
    },
    tradingEnabledOverrides: {
      getTradingEnabled: () => true,
    },
  });

  try {
    harness.__test.resetPipelineStatusCacheForTests();
    const snap = await harness.__test.buildStatusSnapshot();
    assert.equal(pipelineStatusCalls, 1);
    assert.equal(snap.dbStatusMode, "live");
    assert.equal(snap.statusSource, "live");
    assert.equal(snap.statusStale, false);
    assert.equal(snap.tradesToday, 12);
    assert.equal(snap.ordersPlacedToday, 5);
  } finally {
    harness.__test.resetPipelineStatusCacheForTests();
    harness.restore();
  }
}

async function main() {
  await testSocketStatusReturnsStructuredWaitingStateBeforePipelineReady();
  await testSocketStatusMarksCachedSnapshotStaleDuringMongoDegradation();
  await testSocketStatusMarksVeryStaleCache();
  await testSocketStatusReturnsUnavailableWhenMongoDeferredWithoutCache();
  await testSocketStatusHealthyPathRefreshesLive();
  console.log("socketServerMongoDegradation.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
