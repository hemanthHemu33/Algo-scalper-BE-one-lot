// src/tokenWatcher.js
const { env } = require("./config");
const { logger } = require("./logger");
const { alert } = require("./alerts/alertService");
const { getDb } = require("./db");
const { readLatestTokenDoc } = require("./tokenStore");
const { reportFault } = require("./runtime/errorBus");
const {
  invalidateStoredSession,
  isTokenFromPreviousTradingDay,
  trackSession,
  clearTrackedSession,
} = require("./kite/sessionControl");
const { updateLivePreflightContext } = require("./runtime/livePreflight");

const watcherState = {
  lastReason: null,
  lastUpdatedAt: null,
  missing: false,
  activeEnvironment: String(env.TOKEN_FILTER_ENV || env.APP_ENV || env.NODE_ENV || "local"),
  activeSource: null,
  staleTokenBlockedAt: null,
};

function getTokenWatcherStatus() {
  return { ...watcherState };
}

async function watchLatestToken({ onToken }) {
  const db = getDb();
  const col = db.collection(env.TOKENS_COLLECTION);

  let lastToken = null;

  // Missing-token notification state (avoid spamming)
  let missing = false;
  let lastMissingAlertAt = 0;

  const maybeNotifyMissing = async (meta) => {
    const now = Date.now();
    const everyMs = 30 * 60 * 1000; // 30 minutes
    if (now - lastMissingAlertAt < everyMs) return;

    lastMissingAlertAt = now;

    const details = {
      collection: meta?.collection || env.TOKENS_COLLECTION,
      filter: meta?.filter || {},
      reason: meta?.reason || "NO_TOKEN",
      hint: "Login to Kite via your token generator/scanner app OR insert/update a doc with access_token in this collection.",
    };

    logger.error(details, "[tokenWatcher] kite access token missing");
    alert(
      "warn",
      "🔑 Kite access token missing. Please login to Kite and sync token to Mongo.",
      details
    ).catch((err) => { reportFault({ code: "TOKENWATCHER_ASYNC", err, message: "[src/tokenWatcher.js] async task failed" }); });
  };

  const refreshAndNotify = async (reason = "manual") => {
    const res = await readLatestTokenDoc();

    // No doc / no access token -> keep the process alive and notify operator.
    if (!res?.accessToken) {
      if (!missing) {
        missing = true;
        lastToken = null;
      }
      clearTrackedSession("missing_token");
      updateLivePreflightContext({ tokenDoc: null });
      watcherState.missing = true;
      watcherState.lastReason = res?.reason || "NO_TOKEN";
      watcherState.activeSource = null;
      logger.warn(
        {
          reason,
          tokenReason: res?.reason,
          collection: res?.collection || env.TOKENS_COLLECTION,
          filter: res?.filter || {},
        },
        "[tokenWatcher] no usable kite token. Engine will stay up and wait."
      );
      await maybeNotifyMissing(res);
      return;
    }

    const accessToken = String(res.accessToken);
    missing = false;
    watcherState.missing = false;
    watcherState.lastUpdatedAt = res?.doc?.updatedAt || res?.doc?.createdAt || null;
    watcherState.activeSource = res?.doc?.sessionSource || "token_store";

    if (
      env.KITE_BLOCK_PREV_DAY_TOKEN === true &&
      res?.doc &&
      isTokenFromPreviousTradingDay(res.doc)
    ) {
      try {
        await invalidateStoredSession({
          doc: res.doc,
          reason: "PREVIOUS_TRADING_DAY_TOKEN",
          meta: { source: reason },
        });
      } catch (err) {
        logger.warn(
          {
            reason,
            error: err?.message || String(err),
          },
          "[tokenWatcher] failed to invalidate previous-day token",
        );
      }
      clearTrackedSession("previous_day_token");
      updateLivePreflightContext({ tokenDoc: res.doc });
      watcherState.lastReason = "PREVIOUS_TRADING_DAY_TOKEN";
      watcherState.staleTokenBlockedAt = new Date().toISOString();
      lastToken = null;
      logger.error(
        {
          reason,
          updatedAt: watcherState.lastUpdatedAt,
          environment:
            res?.doc?.environment || env.TOKEN_FILTER_ENV || env.APP_ENV || null,
        },
        "[tokenWatcher] previous-day kite token blocked",
      );
      await maybeNotifyMissing({
        ...res,
        reason: "PREVIOUS_TRADING_DAY_TOKEN",
      });
      return;
    }

    if (accessToken === lastToken) return;

    lastToken = accessToken;
    watcherState.lastReason = reason;
    trackSession({
      accessToken,
      doc: res?.doc || null,
      source: reason,
    });
    updateLivePreflightContext({ tokenDoc: res?.doc || null });
    logger.info(
      {
        reason,
        updatedAt: res?.doc?.updatedAt || null,
        environment:
          res?.doc?.environment || env.TOKEN_FILTER_ENV || env.APP_ENV || null,
        sessionSource: res?.doc?.sessionSource || null,
      },
      "[token] loaded/updated"
    );
    alert("info", "🔑 Kite token loaded/updated").catch((err) => { reportFault({ code: "TOKENWATCHER_ASYNC", err, message: "[src/tokenWatcher.js] async task failed" }); });
    await onToken(accessToken, res?.doc || null, reason);
  };

  // Initial refresh should never crash the app now
  await refreshAndNotify("startup");

  // Best-effort: Change stream watch (replica set / Atlas)
  let changeStream = null;
  try {
    changeStream = col.watch([], { fullDocument: "updateLookup" });
    changeStream.on("change", async () => {
      try {
        await refreshAndNotify("change_stream");
      } catch (e) {
        logger.warn(
          { e: e.message },
          "[tokenWatcher] refresh failed on change"
        );
      }
    });
    changeStream.on("error", (err) => {
      logger.warn(
        { e: err?.message || String(err) },
        "[tokenWatcher] change stream error (will rely on polling)"
      );
    });
    logger.info("[tokenWatcher] change stream started (collection-wide)");
  } catch (e) {
    logger.warn(
      { e: e.message },
      "[tokenWatcher] change streams not available (will rely on polling)"
    );
  }

  // Polling fallback: keeps working even if change streams are not supported
  const pollMs = Math.max(5000, Number(env.TOKEN_POLL_INTERVAL_MS ?? 30000));
  const interval = setInterval(() => {
    refreshAndNotify("poll").catch((err) => { reportFault({ code: "TOKENWATCHER_ASYNC", err, message: "[src/tokenWatcher.js] async task failed" }); });
  }, pollMs);

  return () => {
    clearInterval(interval);
    if (changeStream) {
      try {
        changeStream.close();
      } catch (err) { reportFault({ code: "TOKENWATCHER_CATCH", err, message: "[src/tokenWatcher.js] caught and continued" }); }
    }
  };
}

module.exports = { getTokenWatcherStatus, watchLatestToken };
