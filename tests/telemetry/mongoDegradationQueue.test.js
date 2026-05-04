const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadHarness({
  envOverrides = {},
  evaluateMongoWorkGate = null,
  deferMongoWorkForError = null,
  logRecoveryIfAny = null,
  getDbImpl = null,
} = {}) {
  const paths = {
    config: path.join(ROOT, "src", "config.js"),
    db: path.join(ROOT, "src", "db.js"),
    mongoWorkGate: path.join(ROOT, "src", "runtime", "mongoWorkGate.js"),
    signalTelemetry: path.join(ROOT, "src", "telemetry", "signalTelemetry.js"),
    tradeTelemetry: path.join(ROOT, "src", "telemetry", "tradeTelemetry.js"),
  };

  for (const p of Object.values(paths)) {
    delete require.cache[require.resolve(p)];
  }

  const { env } = require(paths.config);
  const dbModule = require(paths.db);
  const mongoWorkGateModule = require(paths.mongoWorkGate);

  const defaults = {
    TELEMETRY_ENABLED: "true",
    TELEMETRY_TRADES_ENABLED: "true",
    TELEMETRY_MAX_QUEUE: "3",
    TELEMETRY_WARN_QUEUE: "2",
    TELEMETRY_FLUSH_BATCH_SIZE: "2",
    TELEMETRY_FLUSH_SEC: "0",
    MONGO_BACKOFF_JITTER_PCT: "0",
  };
  const previousEnv = {};
  for (const [key, value] of Object.entries({ ...defaults, ...envOverrides })) {
    previousEnv[key] = env[key];
    env[key] = value;
  }

  const originalGetDb = dbModule.getDb;
  dbModule.getDb = getDbImpl || (() => ({ collection: () => ({ updateOne: async () => ({ ok: 1 }) }) }));

  const originalGate = {
    evaluateMongoWorkGate: mongoWorkGateModule.evaluateMongoWorkGate,
    deferMongoWorkForError: mongoWorkGateModule.deferMongoWorkForError,
    logRecoveryIfAny: mongoWorkGateModule.logRecoveryIfAny,
  };
  if (typeof evaluateMongoWorkGate === "function") {
    mongoWorkGateModule.evaluateMongoWorkGate = evaluateMongoWorkGate;
  }
  if (typeof deferMongoWorkForError === "function") {
    mongoWorkGateModule.deferMongoWorkForError = deferMongoWorkForError;
  }
  if (typeof logRecoveryIfAny === "function") {
    mongoWorkGateModule.logRecoveryIfAny = logRecoveryIfAny;
  }

  const signalTelemetryModule = require(paths.signalTelemetry);
  const tradeTelemetryModule = require(paths.tradeTelemetry);

  return {
    SignalTelemetry: signalTelemetryModule.SignalTelemetry,
    TradeTelemetry: tradeTelemetryModule.TradeTelemetry,
    restore() {
      dbModule.getDb = originalGetDb;
      mongoWorkGateModule.evaluateMongoWorkGate = originalGate.evaluateMongoWorkGate;
      mongoWorkGateModule.deferMongoWorkForError = originalGate.deferMongoWorkForError;
      mongoWorkGateModule.logRecoveryIfAny = originalGate.logRecoveryIfAny;
      for (const [key, value] of Object.entries(previousEnv)) {
        env[key] = value;
      }
      for (const p of Object.values(paths)) {
        delete require.cache[require.resolve(p)];
      }
    },
  };
}

function testSignalTelemetryQueueIsBounded() {
  const h = loadHarness();
  try {
    const telemetry = new h.SignalTelemetry();
    for (let index = 0; index < 5; index += 1) {
      telemetry.recordDecision({
        signal: { strategyId: "ema_cross" },
        token: 101,
        outcome: "BLOCKED",
        stage: "admission",
        reason: `REASON_${index}`,
      });
    }

    const health = telemetry.healthSnapshot();
    assert.equal(health.queueDepth, 3);
    assert.equal(health.warningCode, "TELEMETRY_QUEUE_MAXED");
    assert.ok(health.droppedCount >= 2);
    assert.ok(health.compactedCount >= 2);
  } finally {
    h.restore();
  }
}

async function testTradeTelemetryFlushDefersAndResumesAfterRecovery() {
  let gateDeferred = true;
  let updateCalls = 0;
  const h = loadHarness({
    evaluateMongoWorkGate: () =>
      gateDeferred
        ? {
            deferred: true,
            severity: "DEGRADED",
            status: "DEGRADED",
            backoffMs: 0,
          }
        : {
            deferred: false,
            severity: "HEALTHY",
            status: "HEALTHY",
            release() {},
          },
    logRecoveryIfAny: ({ release = null } = {}) => {
      if (typeof release === "function") release();
      return { recovered: true };
    },
    getDbImpl: () => ({
      collection() {
        return {
          async updateOne() {
            updateCalls += 1;
            return { ok: 1 };
          },
        };
      },
    }),
  });

  try {
    const telemetry = new h.TradeTelemetry({
      enabled: true,
      flushSec: 0,
      maxQueue: 3,
      warnQueue: 2,
      flushBatchSize: 2,
      dailyCollection: "telemetry_trade_test",
    });

    telemetry.recordDecision({
      tradeId: "T-1",
      outcome: "ENTRY_PLACED",
      stage: "entry",
      reason: "ENTRY_PLACED",
    });
    telemetry.recordTradeClose({
      tradeId: "T-1",
      strategyId: "ema_cross",
      side: "BUY",
      closeReason: "TARGET_HIT",
      grossPnlInr: 100,
      estCostInr: 10,
      netAfterEstCostsInr: 90,
      feeMultiple: 9,
    });

    const deferred = await telemetry.flush();
    assert.equal(deferred.reason, "mongo_backoff");
    assert.equal(telemetry.healthSnapshot().flushDeferredCount, 1);

    gateDeferred = false;
    const flushed = await telemetry.flush();
    const health = telemetry.healthSnapshot();

    assert.equal(flushed.ok, true);
    assert.equal(updateCalls, 1);
    assert.equal(health.queueDepth, 0);
    assert.ok(health.lastFlushOkAt);
  } finally {
    h.restore();
  }
}

async function main() {
  testSignalTelemetryQueueIsBounded();
  await testTradeTelemetryFlushDefersAndResumesAfterRecovery();
  console.log("mongoDegradationQueue.test.js passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
