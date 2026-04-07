const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadLivePreflightHarness({
  envOverrides = {},
  dbOverrides = {},
  marketOverrides = {},
  networkOverrides = {},
  sessionOverrides = {},
} = {}) {
  const livePreflightPath = path.join(ROOT, "src", "runtime", "livePreflight.js");
  const configPath = path.join(ROOT, "src", "config.js");
  const dbPath = path.join(ROOT, "src", "db.js");
  const marketPath = path.join(ROOT, "src", "market", "marketCalendar.js");
  const networkPath = path.join(ROOT, "src", "kite", "networkIdentity.js");
  const sessionPath = path.join(ROOT, "src", "kite", "sessionControl.js");

  delete require.cache[require.resolve(livePreflightPath)];

  const { env } = require(configPath);
  const db = require(dbPath);
  const market = require(marketPath);
  const networkIdentity = require(networkPath);
  const sessionControl = require(sessionPath);

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

  patchEnv(envOverrides);
  patchObject(db, dbOverrides);
  patchObject(market, marketOverrides);
  patchObject(networkIdentity, networkOverrides);
  patchObject(sessionControl, sessionOverrides);

  const livePreflight = require(livePreflightPath);

  return {
    ...livePreflight,
    restore() {
      delete require.cache[require.resolve(livePreflightPath)];
      while (restorers.length) {
        restorers.pop()();
      }
    },
  };
}

async function testStrictLivePreflightPassesWithApprovedIp() {
  const harness = loadLivePreflightHarness({
    envOverrides: {
      TRADING_ENABLED: "true",
      APP_ENV: "render-prod",
      NODE_ENV: "production",
      KITE_ENFORCE_STATIC_IP: true,
      EXPECTED_EGRESS_IPS: "1.2.3.4",
      KITE_ALLOW_LIVE_WITHOUT_STATIC_IP: false,
      KITE_ALLOWED_USER_ID: "AB1234",
      MAX_ORDERS_PER_SEC: 10,
      MAX_ORDERS_PER_MIN: 400,
      MAX_ORDERS_PER_DAY: 5000,
    },
    dbOverrides: {
      getDb() {
        return {};
      },
    },
    marketOverrides: {
      getMarketStatusNow() {
        return { ok: true, allowTradingDay: true, reason: "IN_SESSION" };
      },
    },
    networkOverrides: {
      verifyEgressIp: async () => ({
        ok: true,
        publicIp: "1.2.3.4",
        expectedIps: ["1.2.3.4"],
        reason: "STATIC_IP_MATCH",
        checkedAt: "2026-04-06T09:15:00.000+05:30",
      }),
    },
    sessionOverrides: {
      getSessionControlStatus() {
        return {
          active: true,
          loginTime: "2026-04-06T09:00:00.000+05:30",
          tokenFresh: true,
        };
      },
      isTokenFromPreviousTradingDay() {
        return false;
      },
    },
  });

  try {
    harness.updateLivePreflightContext({
      tokenDoc: { user_id: "AB1234", tradingDayKey: "2026-04-06" },
      tickerStatus: { connected: true, hasSession: true },
      pipelineReady: true,
      quoteDependenciesHealthy: true,
      rateLimiterSnapshot: { limits: { perSec: 10, perMin: 400, perDay: 5000 } },
      brokerRateLimiterSnapshot: {
        limits: { perSec: 10, perMin: 400, perDay: 5000 },
      },
    });

    const result = await harness.refreshLivePreflight({
      source: "test_pass",
      requireRuntimeReady: true,
      forceNetworkRefresh: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.effectiveLiveEnabled, true);
    assert.equal(result.details.staticIpCheck.passed, true);
    assert.equal(result.details.publicIp, "1.2.3.4");
  } finally {
    harness.restore();
  }
}

async function testStrictLivePreflightBlocksOnStaticIpMismatch() {
  const harness = loadLivePreflightHarness({
    envOverrides: {
      TRADING_ENABLED: "true",
      APP_ENV: "render-prod",
      NODE_ENV: "production",
      KITE_ENFORCE_STATIC_IP: true,
      EXPECTED_EGRESS_IPS: "1.2.3.4",
      KITE_ALLOW_LIVE_WITHOUT_STATIC_IP: false,
      MAX_ORDERS_PER_SEC: 10,
      MAX_ORDERS_PER_MIN: 400,
      MAX_ORDERS_PER_DAY: 5000,
    },
    dbOverrides: {
      getDb() {
        return {};
      },
    },
    marketOverrides: {
      getMarketStatusNow() {
        return { ok: true, allowTradingDay: true, reason: "IN_SESSION" };
      },
    },
    networkOverrides: {
      verifyEgressIp: async () => ({
        ok: false,
        publicIp: "9.9.9.9",
        expectedIps: ["1.2.3.4"],
        reason: "STATIC_IP_MISMATCH",
        checkedAt: "2026-04-06T09:15:00.000+05:30",
      }),
    },
    sessionOverrides: {
      getSessionControlStatus() {
        return {
          active: true,
          loginTime: "2026-04-06T09:00:00.000+05:30",
          tokenFresh: true,
        };
      },
      isTokenFromPreviousTradingDay() {
        return false;
      },
    },
  });

  try {
    harness.updateLivePreflightContext({
      tokenDoc: { user_id: "AB1234", tradingDayKey: "2026-04-06" },
      tickerStatus: { connected: true, hasSession: true },
      pipelineReady: true,
      quoteDependenciesHealthy: true,
      rateLimiterSnapshot: { limits: { perSec: 10, perMin: 400, perDay: 5000 } },
    });

    const result = await harness.refreshLivePreflight({
      source: "test_block",
      requireRuntimeReady: true,
      forceNetworkRefresh: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.effectiveLiveEnabled, false);
    assert.equal(
      result.blockingReasons.includes("STATIC_IP_MISMATCH"),
      true,
    );
  } finally {
    harness.restore();
  }
}

async function main() {
  await testStrictLivePreflightPassesWithApprovedIp();
  await testStrictLivePreflightBlocksOnStaticIpMismatch();
  console.log("livePreflight.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
