const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadHarness() {
  const paths = {
    config: path.join(ROOT, "src", "config.js"),
    db: path.join(ROOT, "src", "db.js"),
    tokenStore: path.join(ROOT, "src", "tokenStore.js"),
    tokenWatcher: path.join(ROOT, "src", "tokenWatcher.js"),
  };

  for (const p of Object.values(paths)) {
    delete require.cache[require.resolve(p)];
  }

  const { env } = require(paths.config);
  const dbModule = require(paths.db);
  const tokenStoreModule = require(paths.tokenStore);

  const originalEnv = {};
  const envOverrides = {
    TOKEN_POLL_INTERVAL_MS: 5000,
    MONGO_BACKOFF_JITTER_PCT: 0,
    MONGO_CHANGE_STREAM_BACKOFF_MIN_MS: 8000,
    MONGO_CHANGE_STREAM_BACKOFF_MAX_MS: 16000,
    KITE_BLOCK_PREV_DAY_TOKEN: false,
    TELEGRAM_ENABLED: "false",
    TELEGRAM_NOTIFICATIONS_ENABLED: "false",
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    originalEnv[key] = env[key];
    env[key] = value;
  }

  const originalGetDb = dbModule.getDb;
  const originalReadLatestTokenDoc = tokenStoreModule.readLatestTokenDoc;

  let watchAttempts = 0;
  let refreshReads = 0;
  dbModule.getDb = () => ({
    collection() {
      return {
        watch() {
          watchAttempts += 1;
          throw new Error(
            "Timed out while checking out a connection from connection pool",
          );
        },
      };
    },
  });

  tokenStoreModule.readLatestTokenDoc = async () => {
    refreshReads += 1;
    return {
      accessToken: "token-12345",
      doc: {
        access_token: "token-12345",
        updatedAt: "2026-04-27T09:15:00.000Z",
        environment: "paper",
      },
    };
  };

  delete require.cache[require.resolve(paths.tokenWatcher)];
  const tokenWatcherModule = require(paths.tokenWatcher);

  return {
    tokenWatcherModule,
    getStats() {
      return { watchAttempts, refreshReads };
    },
    restore() {
      dbModule.getDb = originalGetDb;
      tokenStoreModule.readLatestTokenDoc = originalReadLatestTokenDoc;
      for (const [key, value] of Object.entries(originalEnv)) {
        env[key] = value;
      }
      for (const p of Object.values(paths)) {
        delete require.cache[require.resolve(p)];
      }
    },
  };
}

async function testTokenWatcherBacksOffChangeStreamRestartsUnderMongoStress() {
  const h = loadHarness();
  let stop = null;
  let onTokenCalls = 0;
  try {
    stop = await h.tokenWatcherModule.watchLatestToken({
      onToken: async () => {
        onTokenCalls += 1;
      },
    });

    await sleep(1200);
    const stats = h.getStats();
    assert.equal(
      stats.watchAttempts,
      1,
      "change stream should not thrash-restart while mongo is degraded",
    );
    assert.ok(stats.refreshReads >= 1);
    assert.equal(onTokenCalls, 1, "same token update should not retrigger onToken");

    const status = h.tokenWatcherModule.getTokenWatcherStatus();
    assert.equal(status.fallbackActive, true);
    assert.equal(status.hasValidToken, true);
    assert.ok(status.lastTokenFingerprint);
    assert.ok(
      status.changeStreamNextAttemptAt,
      "next change-stream attempt should be delayed during degradation",
    );
  } finally {
    try {
      stop?.();
    } catch {}
    h.restore();
  }
}

async function main() {
  await testTokenWatcherBacksOffChangeStreamRestartsUnderMongoStress();
  console.log("tokenWatcherMongoDegradation.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
