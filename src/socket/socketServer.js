const { Server } = require("socket.io");
const { env } = require("../config");
const { logger } = require("../logger");
const {
  getPipeline,
  getTickerStatus,
  getSubscribedTokens,
} = require("../kite/tickerManager");
const { isHalted, getHaltInfo } = require("../runtime/halt");
const { getTradingEnabled } = require("../runtime/tradingEnabled");
const { getDb, getMongoRuntimeState } = require("../db");
const { getTokenWatcherStatus } = require("../tokenWatcher");
const { telemetry } = require("../telemetry/signalTelemetry");
const { tradeTelemetry } = require("../telemetry/tradeTelemetry");
const { optimizer } = require("../optimizer/adaptiveOptimizer");
const { costCalibrator } = require("../trading/costCalibrator");
const { equityService } = require("../account/equityService");
const { buildPositionsSnapshot } = require("../trading/positionService");
const { getOrdersSnapshot } = require("../trading/orderService");
const { getRiskLimits } = require("../risk/riskLimits");
const { getStrategyKpis } = require("../telemetry/strategyKpi");
const { getExecutionQuality } = require("../execution/executionStats");
const { marketHealth } = require("../market/marketHealth");
const { listAuditLogs } = require("../audit/auditLog");
const { listChannels, listIncidents } = require("../alerts/notificationCenter");
const { getMarketCalendarMeta } = require("../market/marketCalendar");
const { getLastFnoUniverse } = require("../fno/fnoUniverse");
const { getQuoteGuardStats } = require("../kite/quoteGuard");
const { getRecentCandles, getCandlesSince } = require("../market/candleStore");
const { reportFault, reportWindowedFault } = require("../runtime/errorBus");
const { ltpStream, getLatestLtp } = require("../market/ltpStream");
const {
  normalizeActiveTrade,
  normalizeTradeRow,
} = require("../trading/tradeNormalization");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");
const {
  evaluateMongoWorkGate,
  deferMongoWorkForError,
  noteMongoWorkSuccess,
} = require("../runtime/mongoWorkGate");
const { noteMongoStatusStaleness } = require("../runtime/mongoRuntimeState");

const pipelineStatusCache = {
  snapshot: null,
  atMs: 0,
};

function resetPipelineStatusCacheForTests() {
  pipelineStatusCache.snapshot = null;
  pipelineStatusCache.atMs = 0;
}

function setPipelineStatusCacheForTests(snapshot, atMs = Date.now()) {
  pipelineStatusCache.snapshot =
    snapshot && typeof snapshot === "object" ? { ...snapshot } : null;
  pipelineStatusCache.atMs = Number(atMs) || Date.now();
}

function mongoStatusFields() {
  const state = getMongoRuntimeState();
  return {
    mongoConnected: !!state?.connected,
    mongoDegraded: !!state?.degraded,
    mongoSeverity: state?.severity || state?.status || "HEALTHY",
    mongoState: state?.state || state?.status || "HEALTHY",
    mongoEnteredAt: state?.enteredAt || null,
    mongoLastFailureAt: state?.lastFailureAt || null,
    mongoLastRecoveryAt: state?.lastRecoveryAt || null,
    mongoFailureStreak: Number(state?.failureStreak || 0),
    mongoBurstCount: Number(state?.burstCount || 0),
    mongoCheckoutTimeoutCount: Number(state?.checkoutTimeoutCount || 0),
    mongoSubsystemDeferCount: Number(state?.subsystemDeferCount || 0),
    mongoSubsystemResumeCount: Number(state?.subsystemResumeCount || 0),
    mongoDegradedDurationMs: Number(state?.degradedDurationMs || 0),
    mongoTotalBacklog: Number(state?.totalBacklog || 0),
    mongoLastHealthyAt: state?.lastHealthyAt || null,
    mongoLastErrorAt: state?.lastErrorAt || null,
    mongoLastErrorMessage: state?.lastErrorMessage || null,
    mongoPoolClearedCount: Number(state?.poolClearedCount || 0),
    mongoSnapshot: state,
  };
}

function buildPipelineWaitingStatus() {
  const tokenWatcher = getTokenWatcherStatus?.() || {};
  const ticker = getTickerStatus?.() || {};
  const updatedAt = new Date().toISOString();

  if (!tokenWatcher?.hasValidToken) {
    const reasonCode = tokenWatcher?.lastReason || "WAITING_FOR_TOKEN";
    const reason =
      reasonCode === "PREVIOUS_TRADING_DAY_TOKEN"
        ? "Previous-day token blocked; waiting for a fresh token."
        : "Waiting for a valid Kite token.";
    return {
      ok: true,
      pipelineReady: false,
      pipelineState: "WAITING_FOR_TOKEN",
      reasonCode,
      reason,
      updatedAt,
    };
  }

  if (!ticker?.connected) {
    return {
      ok: true,
      pipelineReady: false,
      pipelineState: "PRIMING",
      reasonCode: ticker?.hasSession ? "TICKER_CONNECTING" : "SESSION_PRIMING",
      reason: ticker?.hasSession
        ? "Kite session is active; waiting for ticker connectivity."
        : "Kite session is being initialized.",
      updatedAt,
    };
  }

  return {
    ok: true,
    pipelineReady: false,
    pipelineState: "BACKFILLING",
    reasonCode: "PIPELINE_PRIMING",
    reason: "Pipeline bootstrap is still priming runtime state.",
    updatedAt,
  };
}

function socketStatusFreshnessFields({
  dbStatusMode = "live",
  dbStatusStaleMs = null,
  mongoStatus = {},
}) {
  const statusStale = dbStatusMode === "cache";
  const staleMs = statusStale ? Math.max(0, Number(dbStatusStaleMs || 0)) : 0;
  const maxStaleMs = Math.max(
    1000,
    Number(env.SOCKET_STATUS_MAX_STALE_MS ?? 60_000) || 60_000,
  );
  const statusVeryStale = statusStale && staleMs > maxStaleMs;
  return {
    statusSource:
      dbStatusMode === "cache"
        ? "cache"
        : dbStatusMode === "unavailable"
          ? "unavailable"
          : dbStatusMode === "live"
            ? "live"
            : "memory",
    statusStale,
    statusStaleMs: staleMs,
    statusVeryStale,
    warning: statusStale
      ? statusVeryStale
        ? "DB_DEGRADED_STATUS_VERY_STALE"
        : "DB_DEGRADED_STATUS_STALE"
      : null,
    mongoSeverity: mongoStatus?.mongoSeverity || "HEALTHY",
    mongoState: mongoStatus?.mongoState || "HEALTHY",
  };
}

function parseCorsAllowList() {
  const raw = String(env.CORS_ORIGIN || "*").trim();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsOriginFn(origin, cb) {
  try {
    const allowList = parseCorsAllowList();
    const allowAll = allowList.includes("*");

    // DEV: allow all (Vite port changes should not break)
    if (env.NODE_ENV !== "production") {
      return cb(null, true);
    }

    // PROD: allow only allowlist unless "*"
    if (allowAll) return cb(null, true);
    if (!origin) return cb(null, false);
    if (allowList.includes(origin)) return cb(null, true);
    return cb(null, false);
  } catch (e) {
    return cb(e, false);
  }
}

function assertAdminKey(socket) {
  const expected = env.ADMIN_API_KEY;

  // In production, require a key.
  if (!expected && env.NODE_ENV === "production") {
    const err = new Error("ADMIN_API_KEY not configured");
    err.data = { code: "ADMIN_API_KEY_MISSING" };
    throw err;
  }

  // In dev, if key is not set, allow.
  if (!expected) return;

  const provided =
    socket?.handshake?.auth?.apiKey ||
    socket?.handshake?.headers?.["x-api-key"] ||
    null;

  if (provided && provided === expected) return;

  const err = new Error("unauthorized");
  err.data = { code: "UNAUTHORIZED" };
  throw err;
}

async function buildStatusSnapshot() {
  const toSnapshot = ({
    pipeline = null,
    status = {},
    dbDegraded = false,
    dbStatusStaleMs = null,
    dbStatusMode = "live",
    dbStatusReason = null,
    dbStatusNoCache = false,
    mongoGateDeferred = false,
    mongoGateSeverity = null,
  } = {}) => {
    const normalizedStatus = status && typeof status === "object" ? status : {};
    const ticker = getTickerStatus();
    const halted = isHalted();
    const mongoStatus = mongoStatusFields();
    const freshness = socketStatusFreshnessFields({
      dbStatusMode,
      dbStatusStaleMs,
      mongoStatus,
    });
    noteMongoStatusStaleness({
      subsystem: "socket_status",
      staleMs: freshness.statusStale ? freshness.statusStaleMs : 0,
    });
    const normalizedTicker = {
      connected: false,
      lastDisconnect: null,
      hasSession: false,
      ...(ticker || {}),
    };
    const dailyPnL =
      normalizedStatus?.dailyRisk?.lastTotal ??
      normalizedStatus?.dailyRisk?.lastRealizedPnl ??
      normalizedStatus?.dailyRisk?.realizedPnl ??
      null;
    const state =
      normalizedStatus?.dailyRiskState ??
      normalizedStatus?.dailyRisk?.state ??
      "RUNNING";
    const activeTrade = normalizeActiveTrade(normalizedStatus?.activeTrade);
    const activeTradeId = normalizedStatus?.activeTradeId ?? null;
    const targetMode =
      activeTrade?.optTargetMode ||
      (activeTrade?.targetVirtual ? "VIRTUAL" : null) ||
      (env.OPT_TARGET_MODE ? String(env.OPT_TARGET_MODE).toUpperCase() : null);
    const stopMode = activeTrade?.optStopMode || env.OPT_STOP_MODE || null;
    const targetStatus = activeTrade
      ? activeTrade?.targetOrderId
        ? activeTrade?.targetVirtual
          ? "VIRTUAL"
          : "PLACED"
        : activeTrade?.targetPrice
          ? "PENDING"
          : null
      : null;
    const tradeTracking = {
      tracker: activeTrade?.strategyId || activeTrade?.tracker || null,
      targetMode,
      targetStatus,
      stopMode,
      lastEvent: activeTrade?.lastEvent || null,
      lastUpdate: activeTrade?.updatedAt || null,
      activeTradeId,
      activeTrade,
    };
    const systemHealth = {
      lastSocketEvent: normalizedStatus?.lastSocketEvent || null,
      lastDisconnect: normalizedTicker.lastDisconnect || null,
      rejectedTrades:
        normalizedStatus?.rejectedTrades ??
        normalizedStatus?.dailyRisk?.rejectedTrades ??
        normalizedStatus?.dailyRisk?.rejections ??
        null,
      mongoDegraded: mongoStatus.mongoDegraded,
    };
    const pipelineReady = normalizedStatus?.pipelineReady ?? !!pipeline;
    return {
      ok: normalizedStatus?.ok ?? !!pipeline,
      pipelineReady,
      pipelineState:
        normalizedStatus?.pipelineState || (pipelineReady ? "READY" : "PRIMING"),
      reasonCode: normalizedStatus?.reasonCode || null,
      reason: normalizedStatus?.reason || null,
      updatedAt: normalizedStatus?.updatedAt || new Date().toISOString(),
      ...normalizedStatus,
      tradingEnabled: normalizedStatus?.tradingEnabled ?? getTradingEnabled(),
      killSwitch: normalizedStatus?.killSwitch ?? false,
      halted,
      haltInfo: getHaltInfo(),
      ticker: normalizedTicker,
      now: new Date().toISOString(),
      tradesToday: normalizedStatus?.tradesToday ?? 0,
      ordersPlacedToday: normalizedStatus?.ordersPlacedToday ?? 0,
      dailyPnL,
      state,
      activeTradeId,
      activeTrade,
      tradeTracking,
      systemHealth,
      dbDegraded: dbDegraded || mongoStatus.mongoDegraded,
      dbStatusStaleMs,
      dbStatusMode,
      dbStatusReason,
      dbStatusNoCache: !!dbStatusNoCache,
      dbStatusFreshnessUnavailable: dbStatusMode === "unavailable",
      mongoGateDeferred: !!mongoGateDeferred,
      mongoGateSeverity: mongoGateSeverity || null,
      ...freshness,
      ...mongoStatus,
    };
  };

  let pipeline = null;
  let s = null;
  let dbDegraded = false;
  let dbStatusStaleMs = null;
  let dbStatusMode = "live";
  let dbStatusReason = null;
  let dbStatusNoCache = false;
  let mongoGateDeferred = false;
  let mongoGateSeverity = null;
  const staleWarnMs = Math.max(
    1000,
    Number(env.MONGO_SOCKET_STALE_WARN_MS ?? 15_000) || 15_000,
  );
  const resolvePipeline = () => {
    if (pipeline) return pipeline;
    try {
      pipeline = getPipeline() || null;
    } catch {
      pipeline = null;
    }
    return pipeline;
  };
  const cachedSnapshot = ({
    reason,
    severity = null,
    windowKey,
    error = null,
  }) => {
    if (!pipelineStatusCache.snapshot) return null;
    s = { ...pipelineStatusCache.snapshot };
    dbDegraded = true;
    dbStatusMode = "cache";
    dbStatusReason = reason;
    dbStatusNoCache = false;
    dbStatusStaleMs = Math.max(0, Date.now() - pipelineStatusCache.atMs);
    reportWindowedFault({
      windowKey,
      windowMs: 30_000,
      code: "SOCKET_STATUS_MONGO_CACHED",
      err: error || undefined,
      message: "[socket] serving cached pipeline status during mongo degradation",
      meta: {
        statusStaleMs: dbStatusStaleMs,
        statusStale: true,
        staleWarn: dbStatusStaleMs >= staleWarnMs,
        severity,
      },
    });
    return toSnapshot({
      pipeline: resolvePipeline(),
      status: s,
      dbDegraded,
      dbStatusStaleMs,
      dbStatusMode,
      dbStatusReason,
      dbStatusNoCache,
      mongoGateDeferred,
      mongoGateSeverity,
    });
  };
  const gate = evaluateMongoWorkGate({
    subsystem: "socket_status",
    priority: "non_critical",
    phase: "status refresh",
    windowKey: "socket_pipeline_status_gate_deferred",
    code: "SOCKET_STATUS_MONGO_DEFERRED",
    message: "[socket] status refresh deferred by mongo coordinator",
  });
  if (gate?.deferred) {
    const severe =
      String(gate.status || gate.severity || "").toUpperCase() ===
      "SEVERELY_DEGRADED";
    mongoGateDeferred = true;
    mongoGateSeverity = gate.severity || gate.status || null;
    const cached = cachedSnapshot({
      reason: severe ? "mongo_gate_severe_pressure" : "mongo_gate_deferred",
      severity: gate.severity || gate.status || null,
      windowKey: "socket_pipeline_status_cached_gate",
    });
    if (cached) {
      return cached;
    }

    pipeline = resolvePipeline();
    if (!pipeline) {
      return toSnapshot({
        pipeline: null,
        status: buildPipelineWaitingStatus(),
        dbDegraded: true,
        dbStatusMode: "memory",
        dbStatusReason: severe
          ? "mongo_gate_severe_pressure_pipeline_waiting"
          : "mongo_gate_deferred_pipeline_waiting",
        dbStatusNoCache: true,
        mongoGateDeferred,
        mongoGateSeverity,
      });
    }

    dbDegraded = true;
    dbStatusMode = "unavailable";
    dbStatusNoCache = true;
    dbStatusReason = severe
      ? "mongo_gate_severe_pressure_no_cache"
      : "mongo_gate_deferred_no_cache";
    reportWindowedFault({
      windowKey: "socket_pipeline_status_unavailable_gate",
      windowMs: 30_000,
      code: "SOCKET_STATUS_MONGO_UNAVAILABLE",
      message: "[socket] pipeline status unavailable",
      meta: {
        reason: dbStatusReason,
        severity: gate.severity || gate.status || null,
        noCache: true,
      },
    });
    return toSnapshot({
      pipeline: resolvePipeline(),
      status: null,
      dbDegraded,
      dbStatusStaleMs: null,
      dbStatusMode,
      dbStatusReason,
      dbStatusNoCache,
      mongoGateDeferred,
      mongoGateSeverity,
    });
  }
  let release = gate?.release || null;
  try {
    pipeline = resolvePipeline();
    if (!pipeline) {
      if (typeof release === "function") {
        release();
        release = null;
      }
      return toSnapshot({
        pipeline: null,
        status: buildPipelineWaitingStatus(),
        dbDegraded: false,
        dbStatusMode: "memory",
        dbStatusReason: "pipeline_not_ready",
        dbStatusNoCache: true,
        mongoGateDeferred: false,
        mongoGateSeverity: null,
      });
    }
    if (pipeline?.status) {
      s = await pipeline.status();
      if (s && typeof s === "object") {
        pipelineStatusCache.snapshot = { ...s };
        pipelineStatusCache.atMs = Date.now();
      }
      dbStatusMode = "live";
      dbStatusReason = null;
      dbStatusNoCache = false;
      noteMongoWorkSuccess({
        subsystem: "socket_status",
        priority: "non_critical",
        release,
      });
      release = null;
    }
  } catch (e) {
    const transientMongo = isTransientMongoError(e);
    if (transientMongo) {
      deferMongoWorkForError({
        subsystem: "socket_status",
        priority: "non_critical",
        error: e,
        reason: "socket_status_refresh",
        phase: "status refresh",
        windowKey: "socket_pipeline_status_error_deferred",
        code: "SOCKET_STATUS_MONGO_DEGRADED",
        message: "[socket] status refresh deferred due to mongo degradation",
        release,
      });
      release = null;
      const cached = cachedSnapshot({
        reason: "mongo_error_cached",
        severity: getMongoRuntimeState()?.severity || "DEGRADED",
        windowKey: "socket_pipeline_status_cached_mongo",
        error: e,
      });
      if (cached) {
        return cached;
      }
      dbDegraded = true;
      dbStatusMode = "unavailable";
      dbStatusReason = "mongo_error_no_cache";
      dbStatusNoCache = true;
      reportWindowedFault({
        windowKey: "socket_pipeline_status_unavailable_mongo",
        windowMs: 30_000,
        code: "SOCKET_STATUS_MONGO_UNAVAILABLE",
        err: e,
        message: "[socket] pipeline status unavailable",
      });
    } else {
      if (typeof release === "function") {
        release();
        release = null;
      }
      if (!s) {
        dbStatusMode = "unavailable";
        dbStatusReason = "pipeline_status_error";
        dbStatusNoCache = pipelineStatusCache.snapshot ? false : true;
      }
      logger.warn(
        { err: e?.message || String(e) },
        "[socket] pipeline status unavailable",
      );
    }
  }
  return toSnapshot({
    pipeline,
    status: s,
    dbDegraded,
    dbStatusStaleMs,
    dbStatusMode,
    dbStatusReason,
    dbStatusNoCache,
    mongoGateDeferred,
    mongoGateSeverity,
  });
}

function getKiteClient() {
  try {
    const pipeline = getPipeline();
    return pipeline?.trader?.kite || null;
  } catch {
    return null;
  }
}

async function buildCriticalHealthSnapshot() {
  const ticker = getTickerStatus();
  const halted = isHalted();
  const haltInfo = getHaltInfo();
  const quoteGuard = getQuoteGuardStats();

  let pipeline = null;
  try {
    pipeline = getPipeline();
  } catch (err) { reportFault({ code: "SOCKET_SOCKETSERVER_CATCH", err, message: "[src/socket/socketServer.js] caught and continued" }); }

  const killSwitch =
    !!pipeline?.trader?.risk?.getKillSwitch?.() ||
    !!pipeline?.trader?.risk?.kill;
  const checks = [];

  if (env.CRITICAL_HEALTH_REQUIRE_TICKER_CONNECTED && !ticker?.connected) {
    checks.push({ ok: false, code: "TICKER_NOT_CONNECTED" });
  } else {
    checks.push({ ok: true, code: "TICKER_CONNECTED" });
  }

  if (env.CRITICAL_HEALTH_FAIL_ON_HALT && halted) {
    checks.push({ ok: false, code: "HALTED", meta: haltInfo || null });
  } else {
    checks.push({ ok: true, code: "NOT_HALTED" });
  }

  if (env.CRITICAL_HEALTH_FAIL_ON_KILL_SWITCH && killSwitch) {
    checks.push({ ok: false, code: "KILL_SWITCH" });
  } else {
    checks.push({ ok: true, code: "KILL_SWITCH_OFF" });
  }

  const breakerUntilRaw = quoteGuard?.breakerOpenUntil ?? null;
  const breakerUntil =
    typeof breakerUntilRaw === "string"
      ? Date.parse(breakerUntilRaw)
      : Number.isFinite(Number(breakerUntilRaw))
        ? Number(breakerUntilRaw)
        : 0;
  const breakerOpen = breakerUntil > Date.now();
  if (env.CRITICAL_HEALTH_FAIL_ON_QUOTE_BREAKER && breakerOpen) {
    checks.push({
      ok: false,
      code: "QUOTE_BREAKER_OPEN",
      meta: {
        breakerOpenUntil: breakerUntil,
        failStreak: quoteGuard?.stats?.failStreak || 0,
        lastError: quoteGuard?.stats?.lastError || null,
      },
    });
  } else {
    checks.push({ ok: true, code: "QUOTE_BREAKER_OK" });
  }

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    now: new Date().toISOString(),
    checks,
    ticker,
    halted,
    haltInfo,
    killSwitch,
    quoteGuard,
    pipeline: pipeline ? { ok: true } : { ok: false },
  };
}

async function buildTelemetrySnapshot() {
  const snapshot = telemetry.snapshot();
  const isEmpty =
    Number(snapshot.candidatesTotal ?? 0) === 0 &&
    Number(snapshot.decisionsTotal ?? 0) === 0 &&
    Number(snapshot.blockedTotal ?? 0) === 0;

  if (!isEmpty) {
    return { ok: true, source: "memory", data: snapshot };
  }

  const doc = await telemetry.readDailyFromDb(snapshot.dayKey);
  if (doc) {
    return { ok: true, source: "db", data: doc };
  }

  return { ok: true, source: "memory", data: snapshot };
}

function buildTradeTelemetrySnapshot() {
  const data = tradeTelemetry.snapshot();
  const lastUpdated = data?.lastUpdated ?? data?.updatedAt ?? null;
  return {
    ok: true,
    data: {
      ...data,
      targetMode: data?.targetMode ?? null,
      targetStatus: data?.targetStatus ?? null,
      stopMode: data?.stopMode ?? null,
      trackerStatus: data?.trackerStatus ?? null,
      lastEvent: data?.lastEvent ?? null,
      lastUpdated,
      target_mode: data?.target_mode ?? data?.targetMode ?? null,
      target_status: data?.target_status ?? data?.targetStatus ?? null,
      stop_mode: data?.stop_mode ?? data?.stopMode ?? null,
      tracker_status: data?.tracker_status ?? data?.trackerStatus ?? null,
      last_event: data?.last_event ?? data?.lastEvent ?? null,
      last_updated: data?.last_updated ?? lastUpdated,
    },
  };
}

function safeJsonHash(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(Date.now());
  }
}

function buildLiveCandleSnapshot(candle) {
  if (!candle) return null;
  return {
    ...candle,
    live: true,
    updatedAt: new Date(),
  };
}

function mergeLiveCandle(rows, live) {
  if (!live) return rows;
  const out = Array.isArray(rows) ? rows.slice() : [];
  const liveTs = live?.ts ? new Date(live.ts).getTime() : null;
  if (!Number.isFinite(liveTs)) return out;
  const last = out[out.length - 1];
  const lastTs = last?.ts ? new Date(last.ts).getTime() : null;
  if (Number.isFinite(lastTs) && lastTs === liveTs) {
    out[out.length - 1] = live;
  } else if (!Number.isFinite(lastTs) || liveTs > lastTs) {
    out.push(live);
  }
  return out;
}

function hashLiveCandle(live) {
  if (!live) return null;
  return safeJsonHash({
    ts: live.ts,
    open: live.open,
    high: live.high,
    low: live.low,
    close: live.close,
    volume: live.volume,
  });
}

function attachSocketServer(httpServer) {
  const enabled = String(env.SOCKET_ENABLED || "true") === "true";
  if (!enabled) {
    logger.warn("[socket] SOCKET_ENABLED=false (disabled)");
    return null;
  }

  const io = new Server(httpServer, {
    path: env.SOCKET_PATH || "/socket.io",
    cors: {
      origin: corsOriginFn,
      methods: ["GET", "POST"],
      allowedHeaders: ["x-api-key", "authorization", "content-type"],
    },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    try {
      assertAdminKey(socket);
      return next();
    } catch (e) {
      return next(e);
    }
  });

  io.on("connection", (socket) => {
    const sid = socket.id;

    socket.emit("server:hello", {
      ok: true,
      sid,
      now: new Date().toISOString(),
      env: env.NODE_ENV,
    });

    const timers = new Map();
    const chartSubs = new Map();
    const ltpSubs = new Map();
    const snapshotHashes = new Map();
    const includeLiveCharts =
      String(env.WS_CHART_INCLUDE_LIVE || "true") === "true";
    const defaultSnapshotIntervalMs = Number(
      env.WS_ADMIN_SNAPSHOT_INTERVAL_MS ?? 5000,
    );
    let requestedStatusIntervalMs = Number(env.WS_STATUS_INTERVAL_MS ?? 2000);
    let activeStatusIntervalMs = null;
    let statusSubscribed = true;

    // ---- helpers
    const stopTimer = (key) => {
      const t = timers.get(key);
      if (t) clearInterval(t);
      timers.delete(key);
    };

    const startTimer = (key, intervalMs, fn) => {
      stopTimer(key);
      const ms = Math.max(200, Number(intervalMs) || 1000);
      const t = setInterval(() => {
        fn().catch((e) => {
          socket.emit("server:error", {
            ok: false,
            channel: key,
            error: e?.message || String(e),
          });
        });
      }, ms);
      timers.set(key, t);
    };

    const emitSnapshot = (names, payload) => {
      const list = Array.isArray(names) ? names : [names];
      for (const name of list) {
        socket.emit(name, payload);
      }
    };

    const emitIfChanged = (key, names, payload) => {
      const h = safeJsonHash(payload);
      if (h === snapshotHashes.get(key)) return;
      snapshotHashes.set(key, h);
      emitSnapshot(names, payload);
    };

    const resolveStatusIntervalMs = () => {
      const base = Math.max(200, Number(requestedStatusIntervalMs) || 2000);
      const mongo = getMongoRuntimeState() || {};
      if (!mongo.degraded) return base;
      const severe = String(mongo.severity || "").toUpperCase() === "SEVERELY_DEGRADED";
      const factor = severe ? 5 : 3;
      const maxMs = severe ? 20_000 : 15_000;
      return Math.min(Math.max(base, 2000) * factor, maxMs);
    };

    const ensureStatusTimer = () => {
      if (!statusSubscribed) return;
      const nextMs = resolveStatusIntervalMs();
      if (activeStatusIntervalMs === nextMs) return;
      activeStatusIntervalMs = nextMs;
      startTimer("status", nextMs, sendStatus);
    };

    const sendStatus = async () => {
      const snap = await buildStatusSnapshot();
      emitIfChanged("status", ["status:update", "status"], snap);
      if (statusSubscribed) ensureStatusTimer();
    };

    const sendSubs = async () => {
      const tokens = getSubscribedTokens ? getSubscribedTokens() : [];
      const snap = { ok: true, count: tokens.length, tokens };
      emitIfChanged("subs", ["subs:update", "subs", "subscriptions"], snap);
    };

    const fetchTradesSnapshot = async (limit = 50) => {
      const lim = Number(limit);
      const safeLimit = Number.isFinite(lim) ? Math.min(200, Math.max(1, lim)) : 50;
      const db = getDb();
      const rows = await db
        .collection("trades")
        .find({})
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .toArray();
      return { ok: true, rows: rows.map((row) => normalizeTradeRow(row)), limit: safeLimit };
    };

    const sendTradesSnapshot = async (limit = 50) => {
      const { limit: safeLimit, ...payload } = await fetchTradesSnapshot(limit);
      emitIfChanged(`trades:snapshot:${safeLimit}`, "trades:snapshot", payload);
      return payload.rows;
    };

    const sendTradesRecentSnapshot = async (limit = 10) => {
      const { limit: safeLimit, ...payload } = await fetchTradesSnapshot(limit);
      emitIfChanged("trades:recent", ["trades", "trades:recent"], payload);
      return payload.rows;
    };

    const sendLtpSnapshot = (sub) => {
      const payload = getLatestLtp(sub.token);
      if (payload) {
        emitSnapshot(["ltp:update", "ltp", "tick"], { ok: true, ...payload });
      }
    };

    const handleLtpTick = (payload) => {
      const sub = ltpSubs.get(payload.token);
      if (!sub) return;
      emitSnapshot(["ltp:update", "ltp", "tick"], { ok: true, ...payload });
    };

    // trades: keep a per-socket tail cursor
    let tradesCursorMs = 0;

    const pollTradesDelta = async () => {
      const since = tradesCursorMs;
      if (!since) return;
      const db = getDb();
      const rows = await db
        .collection("trades")
        .find({ updatedAt: { $gt: new Date(since) } })
        .sort({ updatedAt: 1 })
        .limit(200)
        .toArray();

      if (rows.length) {
        const last = rows[rows.length - 1];
        const lastMs = new Date(
          last.updatedAt || last.createdAt || Date.now(),
        ).getTime();
        if (Number.isFinite(lastMs) && lastMs > tradesCursorMs) tradesCursorMs = lastMs;
        socket.emit("trades:delta", {
          ok: true,
          rows: rows.map((row) => normalizeTradeRow(row)),
        });
      }
    };

    const getLiveCandleForSub = (sub) => {
      if (!includeLiveCharts) return null;
      try {
        const pipeline = getPipeline();
        if (pipeline?.getLiveCandle) {
          return pipeline.getLiveCandle(sub.token, sub.intervalMin);
        }
      } catch (err) { reportFault({ code: "SOCKET_SOCKETSERVER_CATCH", err, message: "[src/socket/socketServer.js] caught and continued" }); }
      return null;
    };

    const sendChartSnapshot = async (sub) => {
      const rows = await getRecentCandles(sub.token, sub.intervalMin, sub.limit);
      const live = buildLiveCandleSnapshot(getLiveCandleForSub(sub));
      const merged = mergeLiveCandle(rows, live);
      const last = merged[merged.length - 1];
      sub.lastTsMs = last ? new Date(last.ts).getTime() : 0;
      sub.lastUpdatedAtMs = last
        ? new Date(last.updatedAt || last.ts).getTime()
        : 0;
      sub.lastLiveHash = hashLiveCandle(live);
      socket.emit("chart:snapshot", {
        ok: true,
        chartId: sub.chartId,
        token: sub.token,
        intervalMin: sub.intervalMin,
        rows: merged,
      });
      emitIfChanged(`candles:${sub.chartId}`, ["candles", "candles:recent"], {
        ok: true,
        rows: merged,
      });
    };

    const sendCandlesSnapshot = async (sub) => {
      const rows = await getRecentCandles(sub.token, sub.intervalMin, sub.limit);
      const live = buildLiveCandleSnapshot(getLiveCandleForSub(sub));
      const merged = mergeLiveCandle(rows, live);
      emitIfChanged(`candles:${sub.chartId}`, ["candles", "candles:recent"], {
        ok: true,
        rows: merged,
      });
    };

    const sendEquitySnapshot = async () => {
      const kite = getKiteClient();
      const data = await equityService.snapshot({ kite });
      emitIfChanged("equity", "equity", { ok: true, ...data });
    };

    const sendPositionsSnapshot = async () => {
      const kite = getKiteClient();
      const rows = await buildPositionsSnapshot({ kite });
      emitIfChanged("positions", "positions", { ok: true, rows });
    };

    const sendOrdersSnapshot = async () => {
      const kite = getKiteClient();
      const rows = await getOrdersSnapshot({ kite });
      emitIfChanged("orders", "orders", { ok: true, rows });
    };

    const sendRiskLimitsSnapshot = async () => {
      const limits = await getRiskLimits();
      const resolved = limits?.limits || {};
      const maxDailyLoss = resolved.dailyLossCapInr ?? null;
      const maxDrawdown = resolved.maxDrawdownInr ?? null;
      const maxOpenTrades = resolved.maxOpenTrades ?? null;
      const maxExposureInr = resolved.maxPortfolioExposureInr ?? null;
      const positions = await buildPositionsSnapshot({ kite: getKiteClient() });
      const exposureBySymbol = {};
      for (const p of positions) {
        const key = p.tradingsymbol || String(p.instrument_token || "");
        exposureBySymbol[key] = (exposureBySymbol[key] || 0) + (p.exposureInr || 0);
      }
      emitIfChanged("risk:limits", "risk:limits", {
        ok: true,
        ...limits,
        maxDailyLoss,
        maxDrawdown,
        maxOpenTrades,
        maxExposureInr,
        usage: {
          openPositions: positions.length,
          exposureBySymbol,
        },
      });
    };

    const sendStrategyKpisSnapshot = async () => {
      const data = await getStrategyKpis({ limit: 500 });
      emitIfChanged("strategy:kpis", "strategy:kpis", { ok: true, ...data });
    };

    const sendExecutionQualitySnapshot = async () => {
      const data = await getExecutionQuality({ limit: 500 });
      emitIfChanged("execution:quality", "execution:quality", {
        ok: true,
        ...data,
        fillRate: data?.fillRate ?? null,
        avgSlippage:
          data?.slippage?.avgEntrySlippageBps ??
          data?.slippage?.avgExitSlippageInr ??
          null,
        avgLatencyMs:
          data?.latency?.orderPlacementMs ??
          data?.latency?.orderFillMs ??
          data?.latency?.exitFillMs ??
          null,
        rejects: data?.rejections ?? {},
      });
    };

    const sendMarketHealthSnapshot = async () => {
      const data = marketHealth.snapshot({ tokens: null });
      emitIfChanged("market:health", "market:health", { ok: true, ...data });
    };

    const sendAuditLogsSnapshot = async () => {
      const rows = await listAuditLogs({ limit: 100 });
      emitIfChanged("audit:logs", "audit:logs", { ok: true, rows });
    };

    const sendAlertsChannelsSnapshot = async () => {
      const rows = await listChannels();
      emitIfChanged("alerts:channels", "alerts:channels", { ok: true, rows });
    };

    const sendAlertsIncidentsSnapshot = async () => {
      const rows = await listIncidents({ limit: 100 });
      emitIfChanged("alerts:incidents", "alerts:incidents", { ok: true, rows });
    };

    const sendTelemetrySnapshot = async () => {
      const snap = await buildTelemetrySnapshot();
      emitIfChanged("telemetry", ["telemetry", "telemetry:snapshot"], snap);
    };

    const sendTradeTelemetrySnapshot = async () => {
      const snap = buildTradeTelemetrySnapshot();
      emitIfChanged("tradeTelemetry", ["tradeTelemetry", "tradeTelemetry:snapshot"], snap);
    };

    const sendOptimizerSnapshot = async () => {
      const snap = { ok: true, data: optimizer.snapshot() };
      emitIfChanged("optimizer", ["optimizer", "optimizer:snapshot"], snap);
    };

    const sendRejectionsSnapshot = async () => {
      const snap = {
        ok: true,
        source: "memory",
        data: telemetry.rejectionsSnapshot({}),
      };
      emitIfChanged("rejections", "rejections", snap);
    };

    const sendCostCalibrationSnapshot = async () => {
      const snap = costCalibrator.snapshot();
      const recent = await costCalibrator.recentRuns(10);
      emitIfChanged("cost:calibration", "cost:calibration", {
        ok: true,
        calibration: snap,
        recentRuns: recent,
      });
    };

    const sendMarketCalendarSnapshot = async () => {
      const meta = getMarketCalendarMeta();
      emitIfChanged("market:calendar", "market:calendar", { ok: true, meta });
    };

    const sendFnoSnapshot = async () => {
      const u = getLastFnoUniverse();
      const payload = u || { ok: true, enabled: false, universe: null };
      emitIfChanged("fno", "fno", payload);
    };

    const sendHealthCriticalSnapshot = async () => {
      const snap = await buildCriticalHealthSnapshot();
      emitIfChanged("health:critical", "health:critical", snap);
    };

    const tradesRecentLimit = Number(env.WS_TRADES_RECENT_LIMIT ?? 10);
    const tradesRecentIntervalMs = Number(
      env.WS_TRADES_RECENT_INTERVAL_MS ?? defaultSnapshotIntervalMs,
    );

    const bootstrapSnapshots = () => {
      sendStatus().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendSubs().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendTradesRecentSnapshot(tradesRecentLimit).catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendEquitySnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendPositionsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendOrdersSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendRiskLimitsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendStrategyKpisSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendExecutionQualitySnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendMarketHealthSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendAuditLogsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendAlertsChannelsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendAlertsIncidentsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendTelemetrySnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendTradeTelemetrySnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendOptimizerSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendRejectionsSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendCostCalibrationSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendMarketCalendarSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendFnoSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      sendHealthCriticalSnapshot().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
    };

    bootstrapSnapshots();

    ensureStatusTimer();
    startTimer(
      "subs",
      Number(env.WS_SUBS_INTERVAL_MS ?? 5000),
      sendSubs,
    );
    startTimer("trades:recent", tradesRecentIntervalMs, () =>
      sendTradesRecentSnapshot(tradesRecentLimit),
    );
    startTimer("equity", defaultSnapshotIntervalMs, sendEquitySnapshot);
    startTimer("positions", defaultSnapshotIntervalMs, sendPositionsSnapshot);
    startTimer("orders", defaultSnapshotIntervalMs, sendOrdersSnapshot);
    startTimer("risk:limits", defaultSnapshotIntervalMs, sendRiskLimitsSnapshot);
    startTimer("strategy:kpis", defaultSnapshotIntervalMs, sendStrategyKpisSnapshot);
    startTimer(
      "execution:quality",
      defaultSnapshotIntervalMs,
      sendExecutionQualitySnapshot,
    );
    startTimer("market:health", defaultSnapshotIntervalMs, sendMarketHealthSnapshot);
    startTimer("audit:logs", defaultSnapshotIntervalMs, sendAuditLogsSnapshot);
    startTimer(
      "alerts:channels",
      defaultSnapshotIntervalMs,
      sendAlertsChannelsSnapshot,
    );
    startTimer(
      "alerts:incidents",
      defaultSnapshotIntervalMs,
      sendAlertsIncidentsSnapshot,
    );
    startTimer("telemetry", defaultSnapshotIntervalMs, sendTelemetrySnapshot);
    startTimer(
      "tradeTelemetry",
      defaultSnapshotIntervalMs,
      sendTradeTelemetrySnapshot,
    );
    startTimer("optimizer", defaultSnapshotIntervalMs, sendOptimizerSnapshot);
    startTimer("rejections", defaultSnapshotIntervalMs, sendRejectionsSnapshot);
    startTimer(
      "cost:calibration",
      defaultSnapshotIntervalMs,
      sendCostCalibrationSnapshot,
    );
    startTimer(
      "market:calendar",
      defaultSnapshotIntervalMs,
      sendMarketCalendarSnapshot,
    );
    startTimer("fno", defaultSnapshotIntervalMs, sendFnoSnapshot);
    startTimer(
      "health:critical",
      defaultSnapshotIntervalMs,
      sendHealthCriticalSnapshot,
    );

    const pollCharts = async () => {
      if (!chartSubs.size) return;

      for (const sub of chartSubs.values()) {
        const since = sub.lastTsMs;
        if (!since) {
          await sendChartSnapshot(sub);
          continue;
        }

        const rows = await getCandlesSince(
          sub.token,
          sub.intervalMin,
          since,
          Math.min(env.WS_CHART_MAX_DELTA || 200, 2000),
        );
        const live = buildLiveCandleSnapshot(getLiveCandleForSub(sub));
        const liveHash = hashLiveCandle(live);

        let emitRows = rows;
        if (live) {
          emitRows = mergeLiveCandle(emitRows, live);
        }

        if (!emitRows.length) {
          if (!live || liveHash === sub.lastLiveHash) {
            continue;
          }
          emitRows = [live];
        }

        const last = emitRows[emitRows.length - 1];
        const lastTs = last?.ts ? new Date(last.ts).getTime() : 0;
        const lastUpd = last?.updatedAt
          ? new Date(last.updatedAt).getTime()
          : last?.ts
            ? new Date(last.ts).getTime()
            : 0;

        if (
          rows.length === 1 &&
          lastTs === sub.lastTsMs &&
          lastUpd === sub.lastUpdatedAtMs &&
          liveHash === sub.lastLiveHash
        ) {
          continue;
        }

        sub.lastTsMs = lastTs || sub.lastTsMs;
        sub.lastUpdatedAtMs = lastUpd || sub.lastUpdatedAtMs;
        sub.lastLiveHash = liveHash;

        socket.emit("chart:delta", {
          ok: true,
          chartId: sub.chartId,
          token: sub.token,
          intervalMin: sub.intervalMin,
          rows: emitRows,
        });
        await sendCandlesSnapshot(sub);
      }
    };

    // ---- events from client (FE -> BE)

    socket.on("status:subscribe", (payload = {}) => {
      statusSubscribed = true;
      requestedStatusIntervalMs = Number(
        payload.intervalMs ?? env.WS_STATUS_INTERVAL_MS ?? 2000,
      );
      sendStatus().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      activeStatusIntervalMs = null;
      ensureStatusTimer();
    });

    socket.on("status:request", () => {
      sendStatus().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
    });

    socket.on("status:unsubscribe", () => {
      statusSubscribed = false;
      stopTimer("status");
      activeStatusIntervalMs = null;
    });

    socket.on("subs:subscribe", (payload = {}) => {
      const intervalMs = Number(payload.intervalMs ?? env.WS_SUBS_INTERVAL_MS ?? 5000);
      sendSubs().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
      startTimer("subs", intervalMs, sendSubs);
    });

    socket.on("subs:request", () => {
      sendSubs().catch((err) => { reportFault({ code: "SOCKET_SOCKETSERVER_ASYNC", err, message: "[src/socket/socketServer.js] async task failed" }); });
    });

    socket.on("subs:unsubscribe", () => {
      stopTimer("subs");
    });

    socket.on("trades:subscribe", async (payload = {}) => {
      const intervalMs = Number(payload.intervalMs ?? env.WS_TRADES_INTERVAL_MS ?? 2000);
      const limit = Number(payload.limit ?? 50);
      const rows = await sendTradesSnapshot(limit);
      const mostRecent = rows[0];
      const cursor = mostRecent
        ? new Date(
            mostRecent.updatedAt || mostRecent.createdAt || Date.now(),
          ).getTime()
        : 0;
      tradesCursorMs = cursor || Date.now();
      startTimer("trades", intervalMs, pollTradesDelta);
    });

    socket.on("trades:unsubscribe", () => {
      stopTimer("trades");
      tradesCursorMs = 0;
    });

    socket.on("chart:subscribe", async (payload = {}) => {
      const chartId = String(payload.chartId || "");
      const token = Number(payload.token);
      const intervalMin = Number(payload.intervalMin ?? 1);
      const limitRaw = Number(payload.limit ?? 300);
      const limit = Number.isFinite(limitRaw) ? Math.min(2000, Math.max(10, limitRaw)) : 300;

      if (!chartId) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "missing_chartId" });
        return;
      }
      if (!Number.isFinite(token) || token <= 0) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "invalid_token" });
        return;
      }
      if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
        socket.emit("server:error", { ok: false, channel: "chart", error: "invalid_interval" });
        return;
      }

      const sub = {
        chartId,
        token,
        intervalMin,
        limit,
        lastTsMs: 0,
        lastUpdatedAtMs: 0,
        lastLiveHash: null,
      };

      chartSubs.set(chartId, sub);
      await sendChartSnapshot(sub);

      // Start global chart polling if not already
      if (!timers.get("charts")) {
        const intervalMs = Number(env.WS_CHART_INTERVAL_MS ?? 1000);
        startTimer("charts", intervalMs, pollCharts);
      }
    });

    socket.on("chart:unsubscribe", (payload = {}) => {
      const chartId = String(payload.chartId || "");
      if (chartId) chartSubs.delete(chartId);
      if (!chartSubs.size) stopTimer("charts");
    });

    socket.on("ltp:subscribe", (payload = {}) => {
      const tokens = Array.isArray(payload.tokens)
        ? payload.tokens
        : payload.token != null
          ? [payload.token]
          : [];
      const list = tokens
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t > 0);

      if (!list.length) {
        socket.emit("server:error", { ok: false, channel: "ltp", error: "missing_tokens" });
        return;
      }

      for (const token of list) {
        ltpSubs.set(token, { token });
        sendLtpSnapshot({ token });
      }

      if (!timers.get("ltp")) {
        ltpStream.on("tick", handleLtpTick);
        timers.set("ltp", "event");
      }
    });

    socket.on("ltp:unsubscribe", (payload = {}) => {
      const tokens = Array.isArray(payload.tokens)
        ? payload.tokens
        : payload.token != null
          ? [payload.token]
          : [];
      const list = tokens
        .map((t) => Number(t))
        .filter((t) => Number.isFinite(t) && t > 0);

      if (!list.length) {
        ltpSubs.clear();
      } else {
        for (const token of list) ltpSubs.delete(token);
      }

      if (!ltpSubs.size && timers.get("ltp")) {
        ltpStream.off("tick", handleLtpTick);
        timers.delete("ltp");
      }
    });

    // Optional: lightweight client pings (for UI debugging)
    socket.on("client:ping", (payload = {}) => {
      socket.emit("server:pong", { ok: true, now: new Date().toISOString(), echo: payload });
    });

    socket.on("disconnect", () => {
      for (const t of timers.values()) {
        if (t && typeof t !== "string") clearInterval(t);
      }
      timers.clear();
      chartSubs.clear();
      ltpSubs.clear();
      ltpStream.off("tick", handleLtpTick);
      logger.info({ sid }, "[socket] disconnect");
    });

    logger.info({ sid }, "[socket] connected");
  });

  logger.info({ path: env.SOCKET_PATH || "/socket.io" }, "[socket] attached");

  return io;
}

module.exports = {
  attachSocketServer,
  __test: {
    buildStatusSnapshot,
    resetPipelineStatusCacheForTests,
    setPipelineStatusCacheForTests,
  },
};
