const assert = require("node:assert/strict");
const path = require("node:path");
const { DateTime } = require("luxon");

const ROOT = path.resolve(__dirname, "..", "..");
const loggerPath = path.join(ROOT, "src", "logger.js");
const storePath = path.join(ROOT, "src", "runtime", "runtimeLogStore.js");

function loadFreshModules() {
  delete require.cache[require.resolve(loggerPath)];
  delete require.cache[require.resolve(storePath)];
  const store = require(storePath);
  const { logger } = require(loggerPath);
  return { store, logger };
}

function createFakeDb() {
  const writes = [];
  const indexes = [];
  const collections = [];
  const deletes = [];

  return {
    writes,
    indexes,
    collections,
    deletes,
    db: {
      collection(name) {
        collections.push(name);
        return {
          async createIndex(key, options) {
            indexes.push({ collection: name, key, options: options || null });
          },
          async insertMany(docs) {
            writes.push(...docs);
            return { insertedCount: docs.length };
          },
          async deleteMany(query) {
            deletes.push({ collection: name, query });
            return { deletedCount: 7 };
          },
        };
      },
    },
  };
}

async function testLoggerPersistsRuntimeLogsToConfiguredCollection() {
  const previousEnv = {
    RUNTIME_LOGS_DB_ENABLED: process.env.RUNTIME_LOGS_DB_ENABLED,
    RUNTIME_LOGS_COLLECTION: process.env.RUNTIME_LOGS_COLLECTION,
    RUNTIME_LOGS_BATCH_SIZE: process.env.RUNTIME_LOGS_BATCH_SIZE,
    RUNTIME_LOGS_FLUSH_INTERVAL_MS: process.env.RUNTIME_LOGS_FLUSH_INTERVAL_MS,
    RUNTIME_LOGS_TTL_ENABLED: process.env.RUNTIME_LOGS_TTL_ENABLED,
    RUNTIME_LOGS_DAILY_PURGE_ENABLED: process.env.RUNTIME_LOGS_DAILY_PURGE_ENABLED,
    RUNTIME_LOGS_DAILY_PURGE_HHMM: process.env.RUNTIME_LOGS_DAILY_PURGE_HHMM,
    RUNTIME_LOGS_DAILY_PURGE_TZ: process.env.RUNTIME_LOGS_DAILY_PURGE_TZ,
    LOG_PRETTY: process.env.LOG_PRETTY,
  };

  process.env.RUNTIME_LOGS_DB_ENABLED = "true";
  process.env.RUNTIME_LOGS_COLLECTION = "run_time_logs";
  process.env.RUNTIME_LOGS_BATCH_SIZE = "10";
  process.env.RUNTIME_LOGS_FLUSH_INTERVAL_MS = "10000";
  process.env.RUNTIME_LOGS_TTL_ENABLED = "false";
  process.env.RUNTIME_LOGS_DAILY_PURGE_ENABLED = "false";
  process.env.LOG_PRETTY = "false";

  const { store, logger } = loadFreshModules();
  const fake = createFakeDb();

  try {
    store.configureRuntimeLogDb(fake.db);

    logger.info(
      {
        tradeId: "T-1",
        access_token: "secret-token",
        nested: { password: "secret-password" },
      },
      "entry %s",
      "accepted",
    );

    const result = await store.flushRuntimeLogs({ drain: true });

    assert.equal(result.ok, true);
    assert.equal(fake.writes.length, 1);
    assert.equal(fake.collections.includes("run_time_logs"), true);

    const doc = fake.writes[0];
    assert.equal(doc.level, "info");
    assert.equal(doc.message, "entry accepted");
    assert.equal(doc.context.tradeId, "T-1");
    assert.equal(doc.context.access_token, "[REDACTED]");
    assert.equal(doc.context.nested.password, "[REDACTED]");
    assert.ok(doc.createdAt instanceof Date);
  } finally {
    store.__test.resetRuntimeLogStoreForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(loggerPath)];
    delete require.cache[require.resolve(storePath)];
  }
}

async function testDailyPurgeDeletesOlderRuntimeLogsAndPersistsStatus() {
  const previousEnv = {
    RUNTIME_LOGS_DB_ENABLED: process.env.RUNTIME_LOGS_DB_ENABLED,
    RUNTIME_LOGS_COLLECTION: process.env.RUNTIME_LOGS_COLLECTION,
    RUNTIME_LOGS_BATCH_SIZE: process.env.RUNTIME_LOGS_BATCH_SIZE,
    RUNTIME_LOGS_FLUSH_INTERVAL_MS: process.env.RUNTIME_LOGS_FLUSH_INTERVAL_MS,
    RUNTIME_LOGS_TTL_ENABLED: process.env.RUNTIME_LOGS_TTL_ENABLED,
    RUNTIME_LOGS_DAILY_PURGE_ENABLED: process.env.RUNTIME_LOGS_DAILY_PURGE_ENABLED,
    RUNTIME_LOGS_DAILY_PURGE_HHMM: process.env.RUNTIME_LOGS_DAILY_PURGE_HHMM,
    RUNTIME_LOGS_DAILY_PURGE_TZ: process.env.RUNTIME_LOGS_DAILY_PURGE_TZ,
    LOG_PRETTY: process.env.LOG_PRETTY,
  };

  process.env.RUNTIME_LOGS_DB_ENABLED = "true";
  process.env.RUNTIME_LOGS_COLLECTION = "run_time_logs";
  process.env.RUNTIME_LOGS_BATCH_SIZE = "10";
  process.env.RUNTIME_LOGS_FLUSH_INTERVAL_MS = "10000";
  process.env.RUNTIME_LOGS_TTL_ENABLED = "false";
  process.env.RUNTIME_LOGS_DAILY_PURGE_ENABLED = "true";
  process.env.RUNTIME_LOGS_DAILY_PURGE_HHMM = "09:00";
  process.env.RUNTIME_LOGS_DAILY_PURGE_TZ = "Asia/Kolkata";
  process.env.LOG_PRETTY = "false";

  const { store } = loadFreshModules();
  const fake = createFakeDb();

  try {
    store.configureRuntimeLogDb(fake.db);

    const now = DateTime.fromISO("2026-04-28T09:00:00", {
      zone: "Asia/Kolkata",
    });
    const result = await store.__test.purgeRuntimeLogsBeforeToday({
      now,
      trigger: "test",
      scheduledFor: now.toISO(),
    });

    assert.equal(result.ok, true);
    assert.equal(fake.deletes.length, 1);
    assert.equal(fake.deletes[0].collection, "run_time_logs");

    const cutoff = fake.deletes[0].query?.createdAt?.$lt;
    const expectedCutoff = now.startOf("day").toJSDate();
    assert.ok(cutoff instanceof Date);
    assert.equal(cutoff.toISOString(), expectedCutoff.toISOString());

    const flushResult = await store.flushRuntimeLogs({ drain: true });
    assert.equal(flushResult.ok, true);

    const statusLog = fake.writes.find(
      (doc) => doc.message === "[runtime-logs] daily purge completed",
    );
    assert.ok(statusLog);
    assert.equal(statusLog.context.deletedCount, 7);
    assert.equal(statusLog.context.cutoff, now.startOf("day").toISO());
    assert.equal(statusLog.context.trigger, "test");
    assert.equal(statusLog.context.purgeTime, "09:00");
    assert.equal(statusLog.context.timezone, "Asia/Kolkata");
  } finally {
    store.__test.resetRuntimeLogStoreForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(loggerPath)];
    delete require.cache[require.resolve(storePath)];
  }
}

async function main() {
  await testLoggerPersistsRuntimeLogsToConfiguredCollection();
  await testDailyPurgeDeletesOlderRuntimeLogsAndPersistsStatus();
  console.log("runtimeLogStore.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
