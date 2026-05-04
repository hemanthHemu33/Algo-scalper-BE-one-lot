const crypto = require("crypto");
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
  evaluateMongoWorkGate,
  deferMongoWorkForError,
  noteMongoWorkSuccess,
} = require("./runtime/mongoWorkGate");
const { getMongoRuntimeState } = require("./runtime/mongoRuntimeState");

const watcherState = {
  lastReason: null,
  lastUpdatedAt: null,
  missing: false,
  activeEnvironment: String(
    env.TOKEN_FILTER_ENV || env.APP_ENV || env.NODE_ENV || "local",
  ),
  activeSource: null,
  staleTokenBlockedAt: null,
  fallbackActive: false,
  changeStreamRestartCount: 0,
  changeStreamNextAttemptAt: null,
  mongoSeverity: "HEALTHY",
  lastMongoDeferAt: null,
  hasValidToken: false,
  lastTokenFingerprint: null,
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

function stableTokenFingerprint(accessToken, doc = null) {
  const updatedAt = doc?.updatedAt || doc?.createdAt || "na";
  const environment =
    doc?.environment || env.TOKEN_FILTER_ENV || env.APP_ENV || env.NODE_ENV || "local";
  const tokenHash = crypto
    .createHash("sha1")
    .update(String(accessToken || ""))
    .digest("hex")
    .slice(0, 12);
  return `${environment}|${updatedAt}|${tokenHash}`;
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
  let mongoDeferred = false;
  let changeStreamRetryMs = 0;
  let nextChangeStreamAttemptAt = 0;
  let changeStreamRestartCount = 0;

  const pollMs = Math.max(5000, Number(env.TOKEN_POLL_INTERVAL_MS ?? 30000));
  const currentRefreshPriority = () => (lastToken ? "important" : "critical");

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
      "Kite access token missing. Please login to Kite and sync token to Mongo.",
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

  const syncWatcherMongoState = () => {
    const runtime = getMongoRuntimeState();
    watcherState.mongoSeverity = runtime?.severity || "HEALTHY";
    return watcherState.mongoSeverity;
  };

  const nextChangeStreamRetryDelayMs = () => {
    const minMs = Math.max(
      500,
      Number(env.MONGO_CHANGE_STREAM_BACKOFF_MIN_MS ?? 1_000) || 1_000,
    );
    const maxMs = Math.max(
      minMs,
      Number(env.MONGO_CHANGE_STREAM_BACKOFF_MAX_MS ?? 60_000) || 60_000,
    );
    changeStreamRetryMs = changeStreamRetryMs
      ? Math.min(changeStreamRetryMs * 2, maxMs)
      : minMs;
    const jitterPct = Math.max(
      0,
      Math.min(0.5, Number(env.MONGO_BACKOFF_JITTER_PCT ?? 0.2) || 0.2),
    );
    const delta = changeStreamRetryMs * jitterPct;
    const jitter = delta ? (Math.random() * 2 - 1) * delta : 0;
    return Math.max(minMs, Math.round(changeStreamRetryMs + jitter));
  };

  const scheduleChangeStreamRetry = (reason = "change_stream_retry", delayMs = null) => {
    const delay = Math.max(
      500,
      Number(delayMs == null ? nextChangeStreamRetryDelayMs() : delayMs) || 1_000,
    );
    nextChangeStreamAttemptAt = Date.now() + delay;
    watcherState.changeStreamNextAttemptAt = new Date(
      nextChangeStreamAttemptAt,
    ).toISOString();
    watcherState.changeStreamRestartCount = changeStreamRestartCount;
    schedulePoll(Math.min(delay, pollMs));
    reportWindowedFault({
      windowKey: "token_watcher_change_stream_retry_scheduled",
      windowMs: 30_000,
      code: "TOKENWATCHER_CHANGE_STREAM_RETRY",
      message: "[tokenWatcher] change stream retry scheduled",
      meta: { reason, delayMs: delay },
    });
  };

  const markMongoWatcherRecovered = ({ release = null } = {}) => {
    const health = noteMongoWorkSuccess({
      subsystem: "token_watcher",
      priority: currentRefreshPriority(),
      release,
    });
    syncWatcherMongoState();
    if (!mongoDeferred) return health;
    mongoDeferred = false;
    watcherState.fallbackActive = false;
    if (health?.recovered) {
      logger.info("[tokenWatcher] mongo recovered; watcher resumed");
    }
    return health;
  };

  const deferForMongo = (error, reason, { release = null } = {}) => {
    const deferred = deferMongoWorkForError({
      subsystem: "token_watcher",
      priority: currentRefreshPriority(),
      error,
      reason: `token_watcher_${reason}`,
      phase: "watch",
      windowKey: "token_watcher_mongo_degraded",
      code: "TOKENWATCHER_MONGO_DEGRADED",
      message: "[tokenWatcher] mongo degraded; watcher deferred",
      release,
    });
    if (!deferred?.deferred) return null;
    mongoDeferred = true;
    watcherState.fallbackActive = true;
    watcherState.lastMongoDeferAt = new Date().toISOString();
    syncWatcherMongoState();
    schedulePoll(deferred.backoffMs || pollMs);
    return deferred;
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
      watcherState.hasValidToken = false;
      watcherState.lastReason = res?.reason || "NO_TOKEN";
      watcherState.activeSource = null;
      watcherState.lastTokenFingerprint = null;
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
    const tokenFingerprint = stableTokenFingerprint(accessToken, res?.doc || null);
    missing = false;
    watcherState.missing = false;
    watcherState.hasValidToken = true;
    watcherState.lastTokenFingerprint = tokenFingerprint;
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
      watcherState.hasValidToken = false;
      watcherState.lastTokenFingerprint = null;
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
      watcherState.hasValidToken = true;
      watcherState.lastTokenFingerprint = tokenFingerprint;
      return { ok: true, unchanged: true };
    }

    lastToken = accessToken;
    watcherState.lastReason = reason;
    watcherState.hasValidToken = true;
    watcherState.lastTokenFingerprint = tokenFingerprint;
    trackSession({
      accessToken,
      doc: res?.doc || null,
      source: reason,
    });
    updateLivePreflightContext({ tokenDoc: res?.doc || null });
    await onToken(accessToken, res?.doc || null, reason);
    return { ok: true, updated: true };
  };

  const maybeStartChangeStream = async () => {
    if (stopped || changeStream || changeStreamDisabled) return;
    if (nextChangeStreamAttemptAt && Date.now() < nextChangeStreamAttemptAt) {
      return;
    }
    const gate = evaluateMongoWorkGate({
      subsystem: "token_watcher",
      priority: currentRefreshPriority(),
      phase: "change stream start",
      allowDuringSevere: !lastToken,
      allowDuringSevereReason: !lastToken ? "token_bootstrap_required" : null,
      windowKey: "token_watcher_gate_deferred",
      code: "TOKENWATCHER_MONGO_DEFERRED",
      message: "[tokenWatcher] change stream start deferred by mongo coordinator",
    });
    if (gate?.deferred) {
      watcherState.fallbackActive = true;
      syncWatcherMongoState();
      scheduleChangeStreamRetry("mongo_gate", gate.backoffMs || null);
      return;
    }

    let release = gate?.release || null;
    let col;
    try {
      col = getDb().collection(env.TOKENS_COLLECTION);
    } catch (error) {
      if (isMongoWatcherTransientError(error)) {
        deferForMongo(error, "change_stream_start", { release });
        scheduleChangeStreamRetry("db_unavailable");
        return;
      }
      if (typeof release === "function") {
        release();
        release = null;
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
        changeStreamRestartCount += 1;
        watcherState.changeStreamRestartCount = changeStreamRestartCount;
        if (isMongoWatcherTransientError(err)) {
          reportWindowedFault({
            windowKey: "token_watcher_change_stream_degraded",
            windowMs: 30_000,
            code: "TOKENWATCHER_CHANGE_STREAM_DEGRADED",
            err,
            message: "[tokenWatcher] change stream degraded (will rely on polling)",
          });
          deferForMongo(err, "change_stream_error");
          scheduleChangeStreamRetry("stream_error");
          return;
        }
        logger.warn(
          { e: err?.message || String(err) },
          "[tokenWatcher] change stream error (will rely on polling)",
        );
        changeStreamDisabled = true;
      });
      changeStreamRetryMs = 0;
      nextChangeStreamAttemptAt = 0;
      watcherState.changeStreamNextAttemptAt = null;
      watcherState.fallbackActive = false;
      syncWatcherMongoState();
      if (typeof release === "function") {
        release();
        release = null;
      }
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
        deferForMongo(e, "change_stream_start", { release });
        scheduleChangeStreamRetry("start_failure");
        return;
      }
      if (typeof release === "function") {
        release();
        release = null;
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
      let release = null;
      try {
        const gate = evaluateMongoWorkGate({
          subsystem: "token_watcher",
          priority: currentRefreshPriority(),
          phase: "token refresh",
          allowDuringSevere: !lastToken,
          allowDuringSevereReason: !lastToken ? "token_bootstrap_required" : null,
          windowKey: "token_watcher_refresh_deferred",
          code: "TOKENWATCHER_REFRESH_DEFERRED",
          message: "[tokenWatcher] refresh deferred by mongo coordinator",
        });
        if (gate?.deferred) {
          mongoDeferred = true;
          watcherState.fallbackActive = true;
          watcherState.lastMongoDeferAt = new Date().toISOString();
          syncWatcherMongoState();
          schedulePoll(gate.backoffMs || pollMs);
          return gate;
        }
        release = gate?.release || null;
        const result = await refreshAndNotify(reason);
        markMongoWatcherRecovered({ release });
        release = null;
        await maybeStartChangeStream();
        schedulePoll(pollMs);
        return result;
      } catch (error) {
        if (isMongoWatcherTransientError(error)) {
          return deferForMongo(error, reason, { release });
        }
        if (typeof release === "function") {
          release();
        }
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();

    return refreshInFlight;
  };

  syncWatcherMongoState();

  try {
    await runRefresh("startup");
  } catch (error) {
    if (!isMongoWatcherTransientError(error)) {
      throw error;
    }
  }

  return () => {
    stopped = true;
    watcherState.fallbackActive = false;
    watcherState.changeStreamNextAttemptAt = null;
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
