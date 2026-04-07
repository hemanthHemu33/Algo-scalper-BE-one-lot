const { DateTime } = require("luxon");
const { KiteConnect } = require("kiteconnect");
const { env } = require("../config");
const { getDb } = require("../db");
const { logger } = require("../logger");
const { getHostIdentity } = require("./networkIdentity");

const state = {
  currentAccessToken: null,
  currentDoc: null,
  currentSource: null,
  lastCheckedAt: null,
  lastLogoutAt: null,
  lastLogoutReason: null,
  lastInvalidatedAt: null,
  lastInvalidatedReason: null,
  logoutTriggeredDayKey: null,
  timer: null,
};

function nowDt() {
  return DateTime.now().setZone(env.CANDLE_TZ || "Asia/Kolkata");
}

function currentTradingDayKey(dt = nowDt()) {
  return dt.toFormat("yyyy-LL-dd");
}

function parseClock(value, fallback = "15:25") {
  const raw = String(value || fallback).trim();
  const dt = DateTime.fromFormat(raw, "HH:mm", {
    zone: env.CANDLE_TZ || "Asia/Kolkata",
  });
  return dt.isValid ? raw : fallback;
}

function resolveLoginTime(doc) {
  const raw =
    doc?.login_time ||
    doc?.loginTime ||
    doc?.session_login_time ||
    doc?.createdAt ||
    doc?.updatedAt ||
    null;

  if (!raw) return null;
  if (raw instanceof Date) {
    const dt = DateTime.fromJSDate(raw).setZone(env.CANDLE_TZ || "Asia/Kolkata");
    return dt.isValid ? dt : null;
  }

  const iso = DateTime.fromISO(String(raw), {
    zone: env.CANDLE_TZ || "Asia/Kolkata",
  });
  if (iso.isValid) return iso;

  const js = new Date(raw);
  if (!Number.isNaN(js.getTime())) {
    const dt = DateTime.fromJSDate(js).setZone(env.CANDLE_TZ || "Asia/Kolkata");
    return dt.isValid ? dt : null;
  }

  return null;
}

function isTokenFromPreviousTradingDay(doc, { now = nowDt() } = {}) {
  if (!doc || typeof doc !== "object") return false;

  const tokenDayKey =
    String(doc.tradingDayKey || "").trim() ||
    resolveLoginTime(doc)?.toFormat("yyyy-LL-dd") ||
    "";

  if (!tokenDayKey) return false;
  return tokenDayKey !== currentTradingDayKey(now);
}

function shouldForceLogoutNow({
  now = nowDt(),
  doc = state.currentDoc,
} = {}) {
  if (env.FORCE_DAILY_KITE_LOGOUT !== true) return false;
  if (!doc || typeof doc !== "object") return false;
  if (doc.invalidatedAt || doc.loggedOutAt || !state.currentAccessToken) return false;

  const logoutAt = parseClock(env.KITE_LOGOUT_AT, "15:25");
  const cutoff = DateTime.fromFormat(logoutAt, "HH:mm", {
    zone: env.CANDLE_TZ || "Asia/Kolkata",
  }).set({
    year: now.year,
    month: now.month,
    day: now.day,
    second: 0,
    millisecond: 0,
  });

  if (!cutoff.isValid || now < cutoff) return false;
  const todayKey = currentTradingDayKey(now);
  if (state.logoutTriggeredDayKey === todayKey) return false;

  const tokenDayKey =
    String(doc.tradingDayKey || "").trim() ||
    resolveLoginTime(doc)?.toFormat("yyyy-LL-dd") ||
    "";
  if (tokenDayKey && tokenDayKey !== todayKey) return false;

  return true;
}

async function kiteDeleteSession(accessToken) {
  const token = String(accessToken || "").trim();
  if (!token) {
    throw new Error("kiteDeleteSession requires access token");
  }

  const client = new KiteConnect({ api_key: env.KITE_API_KEY });
  client.setAccessToken(token);
  return client.invalidateAccessToken(token);
}

async function invalidateStoredSession({
  doc = state.currentDoc,
  reason = "SESSION_INVALIDATED",
  meta = null,
} = {}) {
  const db = getDb();
  const col = db.collection(env.TOKENS_COLLECTION);
  const now = new Date();
  const filter = doc?._id
    ? { _id: doc._id }
    : {
        type: doc?.type || "kite_session",
        ...(doc?.environment ? { environment: doc.environment } : {}),
      };

  const update = {
    $set: {
      sessionActive: false,
      invalidatedAt: now,
      invalidatedReason: String(reason || "SESSION_INVALIDATED"),
      updatedAt: now,
      lastVerifiedAt: now,
      hostIdentity: doc?.hostIdentity || getHostIdentity(),
      environment:
        doc?.environment || String(env.APP_ENV || env.NODE_ENV || "local"),
      ...(meta ? { invalidationMeta: meta } : {}),
    },
    $unset: {
      access_token: "",
      accessToken: "",
      token: "",
      access: "",
      kite_access_token: "",
      refresh_token: "",
    },
  };

  await col.updateOne(filter, update, { upsert: false });

  if (state.currentDoc && doc?._id && String(state.currentDoc._id) === String(doc._id)) {
    state.currentDoc = {
      ...state.currentDoc,
      sessionActive: false,
      invalidatedAt: now.toISOString(),
      invalidatedReason: String(reason || "SESSION_INVALIDATED"),
    };
    state.currentAccessToken = null;
  }

  state.lastInvalidatedAt = now.toISOString();
  state.lastInvalidatedReason = String(reason || "SESSION_INVALIDATED");
}

function trackSession({ accessToken, doc, source } = {}) {
  state.currentAccessToken = accessToken ? String(accessToken) : null;
  state.currentDoc = doc || null;
  state.currentSource = source || null;
  state.lastCheckedAt = new Date().toISOString();
}

function clearTrackedSession(reason = "cleared") {
  state.currentAccessToken = null;
  state.currentDoc = null;
  state.currentSource = null;
  state.lastInvalidatedReason = reason;
  state.lastInvalidatedAt = new Date().toISOString();
}

function getSessionControlStatus() {
  const doc = state.currentDoc;
  return {
    active: !!state.currentAccessToken,
    source: state.currentSource || null,
    loginTime: doc?.login_time || doc?.loginTime || null,
    tradingDayKey:
      String(doc?.tradingDayKey || "").trim() ||
      resolveLoginTime(doc)?.toFormat("yyyy-LL-dd") ||
      null,
    tokenFresh:
      doc && env.KITE_BLOCK_PREV_DAY_TOKEN === true
        ? !isTokenFromPreviousTradingDay(doc)
        : null,
    invalidatedAt: state.lastInvalidatedAt,
    invalidatedReason: state.lastInvalidatedReason,
    lastLogoutAt: state.lastLogoutAt,
    lastLogoutReason: state.lastLogoutReason,
    lastCheckedAt: state.lastCheckedAt,
    environment:
      doc?.environment || String(env.APP_ENV || env.NODE_ENV || "local"),
    hostIdentity: doc?.hostIdentity || getHostIdentity(),
    publicIp: doc?.publicIp || null,
    sessionSource: doc?.sessionSource || null,
  };
}

async function runSessionControlTick({
  reason = "interval",
  onSessionInvalidated,
} = {}) {
  state.lastCheckedAt = new Date().toISOString();
  const doc = state.currentDoc;
  if (!doc || !state.currentAccessToken) {
    return { ok: true, skipped: true, reason: "NO_ACTIVE_SESSION" };
  }

  if (
    env.KITE_BLOCK_PREV_DAY_TOKEN === true &&
    isTokenFromPreviousTradingDay(doc)
  ) {
    await invalidateStoredSession({
      doc,
      reason: "PREVIOUS_TRADING_DAY_TOKEN",
      meta: { source: reason },
    });
    logger.error(
      {
        reason,
        loginTime: doc?.login_time || doc?.loginTime || null,
        tradingDayKey: doc?.tradingDayKey || null,
      },
      "[kite-session] previous-day token invalidated",
    );
    if (typeof onSessionInvalidated === "function") {
      await onSessionInvalidated({
        reason: "PREVIOUS_TRADING_DAY_TOKEN",
        doc,
      });
    }
    return { ok: false, blocked: true, reason: "PREVIOUS_TRADING_DAY_TOKEN" };
  }

  if (!shouldForceLogoutNow({ doc })) {
    return { ok: true, skipped: true, reason: "NO_LOGOUT_REQUIRED" };
  }

  try {
    await kiteDeleteSession(state.currentAccessToken);
  } catch (err) {
    logger.warn(
      {
        reason,
        error: err?.message || String(err),
      },
      "[kite-session] remote logout failed; invalidating local session anyway",
    );
  }

  await invalidateStoredSession({
    doc,
    reason: "FORCED_DAILY_LOGOUT",
    meta: { source: reason },
  });

  const todayKey = currentTradingDayKey();
  state.logoutTriggeredDayKey = todayKey;
  state.lastLogoutAt = new Date().toISOString();
  state.lastLogoutReason = "FORCED_DAILY_LOGOUT";

  logger.warn(
    {
      reason,
      logoutAt: env.KITE_LOGOUT_AT,
      tradingDayKey: todayKey,
    },
    "[kite-session] forced daily logout completed",
  );

  if (typeof onSessionInvalidated === "function") {
    await onSessionInvalidated({
      reason: "FORCED_DAILY_LOGOUT",
      doc,
    });
  }

  return { ok: true, loggedOut: true, reason: "FORCED_DAILY_LOGOUT" };
}

function startSessionControl(options = {}) {
  if (state.timer) return state.timer;
  const everyMs = Math.max(15_000, Number(env.TOKEN_POLL_INTERVAL_MS ?? 30_000));
  state.timer = setInterval(() => {
    runSessionControlTick(options).catch((err) => {
      logger.warn(
        { error: err?.message || String(err) },
        "[kite-session] hygiene tick failed",
      );
    });
  }, everyMs);
  state.timer.unref?.();
  return state.timer;
}

function stopSessionControl() {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

module.exports = {
  clearTrackedSession,
  currentTradingDayKey,
  getSessionControlStatus,
  invalidateStoredSession,
  isTokenFromPreviousTradingDay,
  kiteDeleteSession,
  resolveLoginTime,
  runSessionControlTick,
  shouldForceLogoutNow,
  startSessionControl,
  stopSessionControl,
  trackSession,
};
