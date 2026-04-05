const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { notifyLifecycle } = require("./lifecycleNotify");

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function numberEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseClock(value, fallback) {
  const raw = String(value || fallback || "").trim();
  const dt = DateTime.fromFormat(raw, "HH:mm", {
    zone: env.CANDLE_TZ || "Asia/Kolkata",
  });
  return dt.isValid ? raw : fallback;
}

function nowDt() {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  if (env.ENGINE_TEST_NOW_ISO) {
    const testNow = DateTime.fromISO(String(env.ENGINE_TEST_NOW_ISO), { zone: tz });
    if (testNow.isValid) return testNow;
  }
  return DateTime.now().setZone(tz);
}

function withTodayTime(dt, hhmm) {
  return DateTime.fromFormat(
    `${dt.toFormat("yyyy-LL-dd")} ${hhmm}`,
    "yyyy-LL-dd HH:mm",
    { zone: dt.zoneName },
  );
}

function resolveSchedule(dt) {
  const warmup = withTodayTime(
    dt,
    parseClock(env.ENGINE_WARMUP_HHMM, env.MARKET_OPEN || "09:15"),
  );
  const live = withTodayTime(
    dt,
    parseClock(env.ENGINE_LIVE_HHMM, env.MARKET_OPEN || "09:15"),
  );
  const close = withTodayTime(
    dt,
    parseClock(env.ENGINE_CLOSE_HHMM, env.MARKET_CLOSE || "15:30"),
  );
  const idleAfter = close.plus({
    minutes: Math.max(0, numberEnv(env.ENGINE_IDLE_AFTER_MIN, 5)),
  });

  if (dt >= close) return { mode: "COOLDOWN", warmup, live, close, idleAfter };
  if (dt >= live) return { mode: "LIVE", warmup, live, close, idleAfter };
  if (dt >= warmup) return { mode: "WARMUP", warmup, live, close, idleAfter };
  return { mode: "IDLE", warmup, live, close, idleAfter };
}

function createEngineLifecycle({
  startSession,
  stopSession,
  setTradingEnabled,
  getSessionStatus,
  getOpenPositionsSummary,
} = {}) {
  const state = {
    mode: "IDLE",
    token: null,
    sessionRunning: false,
    closePollTimer: null,
    serial: Promise.resolve(),
    lastReason: "init",
    lastTransitionAt: new Date().toISOString(),
  };

  async function safeNotify(event, payload = {}) {
    try {
      await notifyLifecycle(event, payload);
    } catch (err) {
      logger.warn(
        { event, err: err?.message || String(err) },
        "[lifecycle] notification failed",
      );
    }
  }

  function setMode(mode, reason, meta = {}) {
    state.mode = String(mode || "IDLE").toUpperCase();
    state.lastReason = String(reason || "unspecified");
    state.lastTransitionAt = new Date().toISOString();
    return safeNotify(
      state.mode === "IDLE"
        ? "IDLE_ENTER"
        : state.mode === "LIVE"
          ? "LIVE_START"
          : state.mode === "COOLDOWN"
            ? "CLOSE_START"
            : "WARMUP_START",
      { reason: state.lastReason, mode: state.mode, ...meta },
    );
  }

  async function safeSetTradingEnabled(enabled, reason) {
    if (typeof setTradingEnabled !== "function") return;
    await setTradingEnabled(enabled, reason);
  }

  async function safeStartSession(token, reason) {
    if (typeof startSession !== "function") {
      state.sessionRunning = true;
      return { ok: true, skipped: true };
    }
    const out = await startSession(token, reason);
    const ok = out?.ok !== false;
    state.sessionRunning = ok;
    return { ok, ...out };
  }

  async function safeStopSession(reason) {
    if (typeof stopSession !== "function") {
      state.sessionRunning = false;
      return { ok: true, skipped: true };
    }
    const out = await stopSession(reason);
    state.sessionRunning = false;
    return out;
  }

  async function maybeRefreshSessionFlag() {
    if (typeof getSessionStatus !== "function") return;
    try {
      const status = await getSessionStatus();
      state.sessionRunning = Boolean(
        status?.tickerConnected || status?.pipelineReady || state.sessionRunning,
      );
    } catch (err) {
      logger.warn(
        { err: err?.message || String(err) },
        "[lifecycle] session status refresh failed",
      );
    }
  }

  function clearClosePoll() {
    if (!state.closePollTimer) return;
    clearInterval(state.closePollTimer);
    state.closePollTimer = null;
  }

  async function stopIntoIdle(reason) {
    clearClosePoll();
    await safeSetTradingEnabled(false, reason);
    try {
      await safeStopSession(reason);
    } catch (err) {
      await safeNotify("COOLDOWN_STOP_FAILED", {
        reason,
        error: err?.message || String(err),
      });
      throw err;
    }
    await setMode("IDLE", reason);
  }

  async function pollCooldownState() {
    if (typeof getOpenPositionsSummary !== "function") {
      await stopIntoIdle("cooldown_to_idle");
      return;
    }

    let summary = null;
    try {
      summary = await getOpenPositionsSummary();
    } catch (err) {
      summary = { openCount: -1, error: err?.message || String(err) };
    }

    const openCount = Number(summary?.openCount);
    if (!Number.isFinite(openCount) || openCount < 0) {
      await safeNotify("FLAT_CHECK_ERROR_HOLDING", {
        reason: "cooldown",
        ...summary,
      });
      return;
    }

    if (openCount > 0) return;
    await stopIntoIdle("cooldown_to_idle");
  }

  async function startCooldownPolling() {
    clearClosePoll();

    if (!boolEnv(env.ENGINE_REQUIRE_FLAT_BEFORE_IDLE, true)) {
      await stopIntoIdle("cooldown_to_idle");
      return;
    }

    await pollCooldownState();
    if (state.mode !== "COOLDOWN") return;

    const pollSec = Math.max(1, numberEnv(env.ENGINE_COOLDOWN_POLL_SEC, 15));
    state.closePollTimer = setInterval(() => {
      pollCooldownState().catch((err) => {
        logger.warn(
          { err: err?.message || String(err) },
          "[lifecycle] cooldown poll failed",
        );
      });
    }, pollSec * 1000);
  }

  async function ensureSession(reason) {
    await maybeRefreshSessionFlag();
    if (state.sessionRunning) return { ok: true, reused: true };
    return safeStartSession(state.token, reason);
  }

  async function applySchedule(reason) {
    if (!state.token) {
      clearClosePoll();
      await setMode("IDLE", "no_token");
      return { ok: true, mode: state.mode };
    }

    const schedule = resolveSchedule(nowDt());

    if (schedule.mode === "LIVE") {
      const started = await ensureSession(reason);
      if (!started?.ok) {
        state.sessionRunning = false;
        await safeNotify("LIVE_START_FAILED", {
          reason,
          mode: schedule.mode,
        });
        await setMode("IDLE", "live_start_failed");
        return { ok: false, mode: state.mode };
      }
      clearClosePoll();
      await safeSetTradingEnabled(true, "live");
      await setMode("LIVE", reason);
      return { ok: true, mode: state.mode };
    }

    if (schedule.mode === "COOLDOWN") {
      const started = await ensureSession("cooldown_resume");
      if (!started?.ok) {
        await safeNotify("LIVE_START_FAILED", {
          reason: "cooldown_resume",
          mode: schedule.mode,
        });
        await setMode("IDLE", "live_start_failed");
        return { ok: false, mode: state.mode };
      }
      await safeSetTradingEnabled(false, "close");
      await setMode("COOLDOWN", "close", {
        closeAt: schedule.close.toISO(),
      });
      await startCooldownPolling();
      return { ok: true, mode: state.mode };
    }

    if (schedule.mode === "WARMUP") {
      const started = await ensureSession("warmup");
      if (!started?.ok) {
        await safeNotify("LIVE_START_FAILED", {
          reason: "warmup",
          mode: schedule.mode,
        });
        await setMode("IDLE", "live_start_failed");
        return { ok: false, mode: state.mode };
      }
      clearClosePoll();
      await safeSetTradingEnabled(false, "warmup");
      await setMode("WARMUP", "warmup");
      return { ok: true, mode: state.mode };
    }

    clearClosePoll();
    await safeSetTradingEnabled(false, "idle");
    if (state.sessionRunning) {
      await safeStopSession("idle");
    }
    await setMode("IDLE", "idle");
    return { ok: true, mode: state.mode };
  }

  function enqueue(fn) {
    state.serial = state.serial
      .then(fn)
      .catch((err) => {
        logger.error(
          { err: err?.message || String(err) },
          "[lifecycle] transition failed",
        );
        throw err;
      });
    return state.serial;
  }

  async function setToken(nextToken) {
    return enqueue(async () => {
      const token = String(nextToken || "").trim();
      if (!token) {
        state.token = null;
        await stopIntoIdle("token_missing");
        return { ok: true, mode: state.mode };
      }

      const isRefresh = !!state.token && state.token !== token;
      state.token = token;

      if (isRefresh) {
        await safeNotify("TOKEN_REFRESHED", { reason: "token_refresh" });
        await safeSetTradingEnabled(false, "token_refresh");
        await safeStopSession("token_refresh");
      }

      return applySchedule(isRefresh ? "token_refresh" : "token_set");
    });
  }

  function status() {
    return {
      enabled: boolEnv(env.ENGINE_LIFECYCLE_ENABLED, false),
      mode: state.mode,
      tokenPresent: !!state.token,
      sessionRunning: state.sessionRunning,
      lastReason: state.lastReason,
      lastTransitionAt: state.lastTransitionAt,
    };
  }

  function stop() {
    clearClosePoll();
  }

  return {
    setToken,
    status,
    stop,
  };
}

module.exports = { createEngineLifecycle };
