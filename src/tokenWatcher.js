const { env } = require("./config");
const { logger } = require("./logger");
const { alert } = require("./alerts/alertService");
const { getDb } = require("./db");
const { readLatestTokenDoc } = require("./tokenStore");
const { reportFault, reportWindowedFault } = require("./runtime/errorBus");
const {
  invalidateStoredSession,
  isTokenFromPreviousTradingDay,
  trackSession,
  clearTrackedSession,
} = require("./kite/sessionControl");
const { updateLivePreflightContext } = require("./runtime/livePreflight");
const { isTransientMongoError } = require("./runtime/isTransientMongoError");
const {
  markMongoHealthy,
  markMongoDegraded,
} = require("./runtime/mongoRuntimeState");

const watcherState = {
  lastReason: null,
  lastUpdatedAt: null,
  missing: false,
  activeEnvironment: String(
    env.TOKEN_FILTER_ENV || env.APP_ENV || env.NODE_ENV || "local",
  ),
  activeSource: null,
  staleTokenBlockedAt: null,
};

function getTokenWatcherStatus() {
  return { ...watcherState };
}

function isMongoWatcherTransientError(error) {
  return (
    isTransientMongoError(error) ||
    String(error?.message || "").includes("Mongo not connected yet")
  );
}

async function watchLatestToken({ onToken }) {
  let lastToken = null;
  let changeStream = null;
  let changeStreamDisabled = false;
  let pollTimer = null;
  let refreshInFlight = null;
  let stopped = false;
  let missing = false;
  let lastMissingAlertAt = 0;
  let mongoDegraded = false;
  let mongoBackoffMs = 0;

  const pollMs = Math.max(5000, Number(env.TOKEN_POLL_INTERVAL_MS ?? 30000));

  const maybeNotifyMissing = async (meta) => {
    const now = Date.now();
    const everyMs = 30 * 60 * 1000;
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
      "ðŸ”‘ Kite access token missing. Please login to Kite and sync token to Mongo.",
      details,
    ).catch((err) => {
      reportFault({
        code: "TOKENWATCHER_ASYNC",
        err,
        message: "[src/tokenWatcher.js] async task failed",
      });
    });
  };

  const schedulePoll = (delayMs = pollMs) => {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      runRefresh("poll").catch((err) => {
        reportFault({
          code: "TOKENWATCHER_ASYNC",
          err,
          message: "[src/tokenWatcher.js] async task failed",
        });
      });
    }, Math.max(1000, Number(delayMs) || pollMs));
    pollTimer.unref?.();
  };

  const nextMongoBackoffMs = () => {
    mongoBackoffMs = mongoBackoffMs
      ? Math.min(mongoBackoffMs * 2, 30_000)
      : 1_000;
    return mongoBackoffMs;
  };

  const clearMongoDegraded = () => {
    if (!mongoDegraded) {
      mongoBackoffMs = 0;
      return;
    }
    mongoDegraded = false;
    mongoBackoffMs = 0;
    markMongoHealthy();
    logger.info("[tokenWatcher] mongo recovered");
  };

  const deferForMongo = (error, reason) => {
    const backoffMs = nextMongoBackoffMs();
    mongoDegraded = true;
    markMongoDegraded({
      error,
      reason: `token_watcher_${reason}`,
    });
    reportWindowedFault({
      windowKey: "token_watcher_mongo_degraded",
      windowMs: 30_000,
      code: "TOKENWATCHER_MONGO_DEGRADED",
      err: error,
      message: "[tokenWatcher] mongo degraded; watcher deferred",
      meta: { reason, backoffMs },
    });
    schedulePoll(backoffMs);
    return { ok: false, deferred: true, backoffMs };
  };

  const refreshAndNotify = async (reason = "manual") => {
    const res = await readLatestTokenDoc();

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
        "[tokenWatcher] no usable kite token. Engine will stay up and wait.",
      );
      await maybeNotifyMissing(res);
      return { ok: true, waiting: true, reason: res?.reason || "NO_TOKEN" };
    }

    const accessToken = String(res.accessToken);
    missing = false;
    watcherState.missing = false;
    watcherState.lastUpdatedAt =
      res?.doc?.updatedAt || res?.doc?.createdAt || null;
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
      return { ok: true, blocked: true };
    }

    if (accessToken === lastToken) {
      watcherState.lastReason = reason;
      return { ok: true, unchanged: true };
    }

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
      "[token] loaded/updated",
    );
    alert("info", "ðŸ”‘ Kite token loaded/updated").catch((err) => {
      reportFault({
        code: "TOKENWATCHER_ASYNC",
        err,
        message: "[src/tokenWatcher.js] async task failed",
      });
    });
    await onToken(accessToken, res?.doc || null, reason);
    return { ok: true, updated: true };
  };

  const maybeStartChangeStream = async () => {
    if (stopped || changeStream || changeStreamDisabled) return;

    let col;
    try {
      col = getDb().collection(env.TOKENS_COLLECTION);
    } catch (error) {
      if (isMongoWatcherTransientError(error)) {
        deferForMongo(error, "change_stream_start");
        return;
      }
      throw error;
    }

    try {
      changeStream = col.watch([], { fullDocument: "updateLookup" });
      changeStream.on("change", () => {
        runRefresh("change_stream").catch((err) => {
          reportFault({
            code: "TOKENWATCHER_ASYNC",
            err,
            message: "[src/tokenWatcher.js] async task failed",
          });
        });
      });
      changeStream.on("error", (err) => {
        changeStream = null;
        if (isMongoWatcherTransientError(err)) {
          reportWindowedFault({
            windowKey: "token_watcher_change_stream_degraded",
            windowMs: 30_000,
            code: "TOKENWATCHER_CHANGE_STREAM_DEGRADED",
            err,
            message: "[tokenWatcher] change stream degraded (will rely on polling)",
          });
          deferForMongo(err, "change_stream_error");
          return;
        }
        logger.warn(
          { e: err?.message || String(err) },
          "[tokenWatcher] change stream error (will rely on polling)",
        );
        changeStreamDisabled = true;
      });
      logger.info("[tokenWatcher] change stream started (collection-wide)");
    } catch (e) {
      if (isMongoWatcherTransientError(e)) {
        reportWindowedFault({
          windowKey: "token_watcher_change_stream_start",
          windowMs: 30_000,
          code: "TOKENWATCHER_CHANGE_STREAM_START",
          err: e,
          message: "[tokenWatcher] change stream degraded (will rely on polling)",
        });
        deferForMongo(e, "change_stream_start");
        return;
      }
      logger.warn(
        { e: e?.message || String(e) },
        "[tokenWatcher] change streams not available (will rely on polling)",
      );
      changeStreamDisabled = true;
    }
  };

  const runRefresh = async (reason) => {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const result = await refreshAndNotify(reason);
        clearMongoDegraded();
        await maybeStartChangeStream();
        schedulePoll(pollMs);
        return result;
      } catch (error) {
        if (isMongoWatcherTransientError(error)) {
          return deferForMongo(error, reason);
        }
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  };

  try {
    await runRefresh("startup");
  } catch (error) {
    if (!isMongoWatcherTransientError(error)) {
      throw error;
    }
  }

  return () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (changeStream) {
      try {
        changeStream.close();
      } catch (err) {
        reportFault({
          code: "TOKENWATCHER_CATCH",
          err,
          message: "[src/tokenWatcher.js] caught and continued",
        });
      }
    }
  };
}

module.exports = { getTokenWatcherStatus, watchLatestToken };
