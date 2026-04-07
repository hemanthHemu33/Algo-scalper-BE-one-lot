const assert = require("node:assert/strict");
const { DateTime } = require("luxon");

const { env } = require("../../src/config");
const {
  clearTrackedSession,
  currentTradingDayKey,
  isTokenFromPreviousTradingDay,
  shouldForceLogoutNow,
  trackSession,
} = require("../../src/kite/sessionControl");

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = env[key];
    env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      env[key] = value;
    }
  }
}

function testPreviousDayTokenDetection() {
  const now = DateTime.fromISO("2026-04-06T09:30:00", {
    zone: env.CANDLE_TZ || "Asia/Kolkata",
  });

  assert.equal(
    isTokenFromPreviousTradingDay(
      { tradingDayKey: "2026-04-05" },
      { now },
    ),
    true,
  );
  assert.equal(
    isTokenFromPreviousTradingDay(
      { tradingDayKey: "2026-04-06" },
      { now },
    ),
    false,
  );
}

function testForceLogoutSchedule() {
  withEnv(
    {
      FORCE_DAILY_KITE_LOGOUT: true,
      KITE_LOGOUT_AT: "15:25",
    },
    () => {
      const now = DateTime.fromISO("2026-04-06T15:30:00", {
        zone: env.CANDLE_TZ || "Asia/Kolkata",
      });
      const tradingDayKey = currentTradingDayKey(now);
      const doc = {
        tradingDayKey,
        login_time: now.minus({ hours: 6 }).toISO(),
      };

      trackSession({ accessToken: "kite-token", doc, source: "test" });
      assert.equal(
        shouldForceLogoutNow({ now, doc }),
        true,
      );
      clearTrackedSession("test_complete");
    },
  );
}

function main() {
  testPreviousDayTokenDetection();
  testForceLogoutSchedule();
  console.log("sessionControl.test.js passed");
}

main();
