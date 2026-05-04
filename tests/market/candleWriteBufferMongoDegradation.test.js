const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadHarness({
  envOverrides = {},
  evaluateMongoWorkGate = null,
  deferMongoWorkForError = null,
  logRecoveryIfAny = null,
  insertManyCandles = null,
} = {}) {
  const paths = {
    config: path.join(ROOT, "src", "config.js"),
    candleStore: path.join(ROOT, "src", "market", "candleStore.js"),
    mongoWorkGate: path.join(ROOT, "src", "runtime", "mongoWorkGate.js"),
    mongoRuntimeState: path.join(ROOT, "src", "runtime", "mongoRuntimeState.js"),
    candleBuffer: path.join(ROOT, "src", "market", "candleWriteBuffer.js"),
  };

  for (const p of Object.values(paths)) {
    delete require.cache[require.resolve(p)];
  }

  const { env } = require(paths.config);
  const candleStoreModule = require(paths.candleStore);
  const mongoWorkGateModule = require(paths.mongoWorkGate);
  const mongoRuntimeState = require(paths.mongoRuntimeState);

  mongoRuntimeState.resetMongoRuntimeStateForTests?.();

  const defaults = {
    CANDLE_WRITE_BUFFER_ENABLED: "true",
    CANDLE_WRITER_MAX_BACKLOG: "10",
    CANDLE_WRITER_WARN_BACKLOG: "2",
    CANDLE_WRITER_CRITICAL_BACKLOG: "5",
    CANDLE_WRITER_FLUSH_BATCH_SIZE: "500",
    CANDLE_WRITER_FLUSH_CONCURRENCY: "1",
    MONGO_BACKOFF_JITTER_PCT: "0",
  };
  const previousEnv = {};
  for (const [key, value] of Object.entries({ ...defaults, ...envOverrides })) {
    previousEnv[key] = env[key];
    env[key] = value;
  }

  const calls = {
    insertManyCandles: [],
  };

  const originalInsertManyCandles = candleStoreModule.insertManyCandles;
  candleStoreModule.insertManyCandles = async (intervalMin, batch) => {
    calls.insertManyCandles.push({ intervalMin, batch });
    if (typeof insertManyCandles === "function") {
      return insertManyCandles(intervalMin, batch);
    }
    return { ok: true };
  };

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

  delete require.cache[require.resolve(paths.candleBuffer)];
  const candleWriteBufferModule = require(paths.candleBuffer);

  return {
    ...candleWriteBufferModule,
    calls,
    restore() {
      candleStoreModule.insertManyCandles = originalInsertManyCandles;
      mongoWorkGateModule.evaluateMongoWorkGate = originalGate.evaluateMongoWorkGate;
      mongoWorkGateModule.deferMongoWorkForError = originalGate.deferMongoWorkForError;
      mongoWorkGateModule.logRecoveryIfAny = originalGate.logRecoveryIfAny;
      for (const [key, value] of Object.entries(previousEnv)) {
        env[key] = value;
      }
      mongoRuntimeState.resetMongoRuntimeStateForTests?.();
      for (const p of Object.values(paths)) {
        delete require.cache[require.resolve(p)];
      }
    },
  };
}

function candle(ts) {
  return {
    instrument_token: 101,
    interval_min: 1,
    ts,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
  };
}

async function testCandleWriterDeferredFlushTracksBacklog() {
  const h = loadHarness({
    envOverrides: {
      CANDLE_WRITER_WARN_BACKLOG: "1",
    },
    evaluateMongoWorkGate: () => ({
      deferred: true,
      severity: "DEGRADED",
      status: "DEGRADED",
      backoffMs: 1000,
    }),
  });
  try {
    h.resetCandleWriterHealthForTests();
    const writer = new h.CandleWriteBuffer();
    writer.enqueue(candle("2026-04-22T09:15:00.000Z"));
    const result = await writer.flush();
    const health = h.getCandleWriterHealth();

    assert.equal(result.deferred, true);
    assert.equal(health.candleWriterBacklog, 1);
    assert.equal(health.flushDeferredCount, 1);
    assert.equal(health.warningCode, "CANDLE_PERSISTENCE_BACKLOG_WARN");
  } finally {
    h.restore();
  }
}

async function testCandleWriterWarnsAndBlocksAtConfiguredBacklog() {
  const h = loadHarness({
    envOverrides: {
      CANDLE_WRITER_MAX_BACKLOG: "3",
      CANDLE_WRITER_WARN_BACKLOG: "1",
      CANDLE_WRITER_CRITICAL_BACKLOG: "2",
    },
  });
  try {
    h.resetCandleWriterHealthForTests();
    const writer = new h.CandleWriteBuffer();
    writer.enqueue(candle("2026-04-22T09:15:00.000Z"));
    writer.enqueue(candle("2026-04-22T09:16:00.000Z"));
    let health = h.getCandleWriterHealth();
    assert.equal(health.warningCode, "CANDLE_PERSISTENCE_BACKLOG_HIGH");

    writer.enqueue(candle("2026-04-22T09:17:00.000Z"));
    health = h.getCandleWriterHealth();
    assert.equal(health.readinessBlocked, true);
    assert.equal(
      health.readinessReasons.includes("CANDLE_WRITER_BACKLOG_MAXED"),
      true,
    );

    const blocked = writer.enqueue(candle("2026-04-22T09:18:00.000Z"));
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, "CANDLE_WRITER_BACKLOG_MAXED");
  } finally {
    h.restore();
  }
}

async function testCandleWriterFlushResumesAfterRecovery() {
  let gateDeferred = true;
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
  });
  try {
    h.resetCandleWriterHealthForTests();
    const writer = new h.CandleWriteBuffer();
    writer.enqueue(candle("2026-04-22T09:15:00.000Z"));

    const deferred = await writer.flush();
    assert.equal(deferred.deferred, true);

    gateDeferred = false;
    const flushed = await writer.flush();
    const health = h.getCandleWriterHealth();

    assert.equal(flushed.ok, true);
    assert.equal(h.calls.insertManyCandles.length, 1);
    assert.equal(health.candleWriterBacklog, 0);
    assert.ok(health.lastFlushOkAt);
  } finally {
    h.restore();
  }
}

async function main() {
  await testCandleWriterDeferredFlushTracksBacklog();
  await testCandleWriterWarnsAndBlocksAtConfiguredBacklog();
  await testCandleWriterFlushResumesAfterRecovery();
  console.log("candleWriteBufferMongoDegradation.test.js passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
