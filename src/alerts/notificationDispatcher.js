const crypto = require("crypto");
const { getDb } = require("../db");
const { env } = require("../config");
const { logger } = require("../logger");
const {
  ensureNotificationLedgerIndexes,
  shouldDispatchDedupe,
  recordDedupeDispatch,
  getTradeCardLedger,
  listTradeMilestones,
  resolveTradeCardDispatch,
  upsertTradeCardLedger,
  invalidateTradeCardMessage,
  recordTradeMilestone,
} = require("./notificationLedger");
const {
  ensureNotificationOutboxIndexes,
  enqueueOutboxJob,
  claimDueJobs,
  markJobSent,
  markJobRetry,
  markJobFailedPermanent,
  requeueStaleProcessingJobs,
} = require("./notificationOutbox");
const { formatEnvelopeToTelegram } = require("./telegramFormatter");
const {
  sendMessage,
  editMessageText,
  isEnabled: isTelegramEnabled,
  classifyTelegramError,
} = require("./telegram");
const {
  buildTradeNotificationPlan,
  incidentsEnabled,
} = require("./notificationPolicy");
const { buildTradeStatusSnapshot } = require("./tradeStatusBuilder");
const { reportWindowedFault } = require("../runtime/errorBus");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");
const {
  markMongoHealthy,
  markMongoDegraded,
} = require("../runtime/mongoRuntimeState");

const INCIDENTS = "notification_incidents";
const workerId = `notif-${process.pid}`;

let startPromise = null;
let started = false;
let workerTimer = null;
let heartbeatTimer = null;
let liveRefreshTimer = null;
let heartbeatProvider = null;
let drainInFlight = false;
let mongoPollDegraded = false;
let mongoPollBackoffMs = 0;
let mongoPollDeferredUntil = 0;

const deliveryMetrics = {
  queued: 0,
  sent: 0,
  edited: 0,
  deduped: 0,
  retried: 0,
  failedPermanent: 0,
  fallbackResend: 0,
  heartbeatQueued: 0,
  liveRefreshQueued: 0,
};

function incrementMetric(key) {
  deliveryMetrics[key] = Number(deliveryMetrics[key] || 0) + 1;
}

function hashObject(value) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(value || {}))
    .digest("hex");
}

function notificationsEnabled() {
  return isTelegramEnabled();
}

function shouldEmitTradeCards() {
  return String(env.TELEGRAM_TRADE_CARD_ENABLED || "true") !== "false";
}

function shouldEmitHeartbeat() {
  return String(env.TELEGRAM_HEARTBEAT_ENABLED || "false") === "true";
}

function getHeartbeatIntervalSec() {
  return Math.max(1, Number(env.TELEGRAM_HEARTBEAT_SEC ?? 900) || 900);
}

function getTradeCardMinRefreshMs() {
  return (
    Math.max(
      5,
      Number(env.TELEGRAM_TRADE_CARD_MIN_REFRESH_SEC ?? 15) || 15,
    ) * 1000
  );
}

function getTradeCardForceRefreshMs() {
  return (
    Math.max(
      15,
      Number(env.TELEGRAM_TRADE_CARD_FORCE_REFRESH_SEC ?? 90) || 90,
    ) * 1000
  );
}

function getTradeCardPnlDeltaInr() {
  return Math.max(
    0,
    Number(env.TELEGRAM_TRADE_CARD_PNL_DELTA_INR ?? 100) || 100,
  );
}

function getTradeCardLtpDelta() {
  return Math.max(0, Number(env.TELEGRAM_TRADE_CARD_LTP_DELTA ?? 0.25) || 0.25);
}

function notificationDebugEnabled() {
  return String(env.TELEGRAM_NOTIFICATION_DEBUG || "false") === "true";
}

function debugLog(meta, message) {
  if (!notificationDebugEnabled()) return;
  logger.info(meta || {}, message);
}

function clearTimers() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (liveRefreshTimer) {
    clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }
}

function nextMongoPollBackoffMs() {
  mongoPollBackoffMs = mongoPollBackoffMs
    ? Math.min(mongoPollBackoffMs * 2, 15_000)
    : 1_000;
  mongoPollDeferredUntil = Date.now() + mongoPollBackoffMs;
  return mongoPollBackoffMs;
}

function deferMongoOutboxPoll(error, context = "outbox_poll") {
  const backoffMs = nextMongoPollBackoffMs();
  mongoPollDegraded = true;
  markMongoDegraded({
    error,
    reason: `notification_dispatcher_${context}`,
  });
  reportWindowedFault({
    windowKey: "notifications_mongo_degraded",
    windowMs: 30_000,
    code: "NOTIFICATIONS_MONGO_DEGRADED",
    err: error,
    message: "[notifications] mongo degraded; outbox poll deferred",
    meta: { context, backoffMs },
  });
  return { ok: false, deferred: true, backoffMs };
}

function clearMongoOutboxPollDegraded() {
  if (!mongoPollDegraded) {
    mongoPollBackoffMs = 0;
    mongoPollDeferredUntil = 0;
    return;
  }
  mongoPollDegraded = false;
  mongoPollBackoffMs = 0;
  mongoPollDeferredUntil = 0;
  markMongoHealthy();
  logger.info("[notifications] mongo recovered; outbox poll resumed");
}

async function ensureIncidentIndexes() {
  const db = getDb();
  const col = db.collection(INCIDENTS);
  await col.createIndex({ createdAt: -1 });
  await col.createIndex({ severity: 1, createdAt: -1 });
  await col.createIndex({ type: 1, createdAt: -1 });
}

async function startNotificationDispatcher() {
  if (!notificationsEnabled()) return { ok: true, skipped: true };
  if (started) return { ok: true, started: true };
  if (startPromise) return startPromise;

  startPromise = (async () => {
    await ensureNotificationLedgerIndexes();
    await ensureNotificationOutboxIndexes();
    await ensureIncidentIndexes();
    await requeueStaleProcessingJobs();

    const pollMs = Math.max(
      250,
      Number(env.TELEGRAM_OUTBOX_POLL_MS ?? 1000) || 1000,
    );
    workerTimer = setInterval(() => {
      processOutboxOnce().catch((error) => {
        reportWindowedFault({
          windowKey: "notifications_outbox_poll_failed",
          windowMs: 30_000,
          code: "NOTIFICATIONS_OUTBOX_POLL_FAILED",
          err: error,
          message: "[notifications] outbox poll failed",
        });
      });
    }, pollMs);
    workerTimer.unref?.();

    started = true;
    refreshHeartbeatTimer();
    refreshLiveRefreshTimer();
    return { ok: true, started: true };
  })().catch((error) => {
    startPromise = null;
    throw error;
  });

  return startPromise;
}

function stopNotificationDispatcher() {
  clearTimers();
  started = false;
  startPromise = null;
  mongoPollDegraded = false;
  mongoPollBackoffMs = 0;
  mongoPollDeferredUntil = 0;
}

function setHeartbeatProvider(provider) {
  heartbeatProvider = typeof provider === "function" ? provider : null;
  refreshHeartbeatTimer();
  refreshLiveRefreshTimer();
}

function refreshHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!started || !notificationsEnabled() || !shouldEmitHeartbeat() || !heartbeatProvider) {
    return;
  }
  const intervalSec = getHeartbeatIntervalSec();
  heartbeatTimer = setInterval(() => {
    emitHeartbeat().catch((error) => {
      logger.warn(
        { err: error?.message || String(error) },
        "[notifications] heartbeat failed",
      );
    });
  }, intervalSec * 1000);
  heartbeatTimer.unref?.();
}

function refreshLiveRefreshTimer() {
  if (liveRefreshTimer) {
    clearInterval(liveRefreshTimer);
    liveRefreshTimer = null;
  }
  if (!started || !notificationsEnabled() || !shouldEmitTradeCards() || !heartbeatProvider) {
    return;
  }
  const refreshMs = getTradeCardMinRefreshMs();
  liveRefreshTimer = setInterval(() => {
    emitLiveTradeRefresh().catch((error) => {
      logger.warn(
        { err: error?.message || String(error) },
        "[notifications] live trade refresh failed",
      );
    });
  }, refreshMs);
  liveRefreshTimer.unref?.();
}

function normalizeEnvelope(envelope) {
  const normalized = {
    kind: envelope?.kind || "incident",
    severity: String(envelope?.severity || "info").toLowerCase(),
    entityType: envelope?.entityType || "engine",
    entityId: envelope?.entityId || "global",
    dedupeKey: envelope?.dedupeKey || null,
    stateHash: envelope?.stateHash || null,
    displayHash:
      envelope?.displayHash || envelope?.payload?.current?.displayHash || null,
    tradeId: envelope?.tradeId || null,
    status: envelope?.status || null,
    event: envelope?.event || null,
    source: envelope?.source || "notification_dispatcher",
    displayOnly: Boolean(envelope?.displayOnly),
    forceDisplayRefresh: Boolean(envelope?.forceDisplayRefresh),
    milestones: Array.isArray(envelope?.milestones) ? envelope.milestones : [],
    payload: envelope?.payload || {},
    createdAt: envelope?.createdAt || new Date().toISOString(),
  };

  if (!normalized.stateHash) {
    normalized.stateHash = hashObject({
      kind: normalized.kind,
      event: normalized.event,
      status: normalized.status,
      payload: normalized.payload,
    });
  }
  if (!normalized.displayHash) {
    normalized.displayHash = normalized.stateHash;
  }
  if (!normalized.dedupeKey) {
    normalized.dedupeKey = `${normalized.entityType}:${normalized.entityId}:${normalized.event || normalized.kind}`;
  }
  return normalized;
}

function buildHeartbeatBucketKey(createdAt) {
  const bucketSec = getHeartbeatIntervalSec();
  const at = createdAt ? new Date(createdAt).getTime() : Date.now();
  const bucket = Math.floor((Number.isFinite(at) ? at : Date.now()) / (bucketSec * 1000));
  return `engine:heartbeat:${bucket}`;
}

function kickOutbox() {
  setImmediate(() => {
    processOutboxOnce().catch((error) => {
      logger.warn(
        { err: error?.message || String(error) },
        "[notifications] immediate outbox flush failed",
      );
    });
  });
}

async function recordIncidentDoc(envelope) {
  if (envelope.kind !== "incident") return;
  const db = getDb();
  await db.collection(INCIDENTS).insertOne({
    type: envelope.event || "incident",
    message: envelope.payload?.message || null,
    severity: envelope.severity || "info",
    meta: envelope.payload?.meta || null,
    entityType: envelope.entityType || null,
    entityId: envelope.entityId || null,
    tradeId: envelope.tradeId || null,
    createdAt: new Date(),
  });
}

async function enrichTradeEnvelope(normalized) {
  for (const milestone of normalized.milestones || []) {
    await recordTradeMilestone({
      tradeId: normalized.tradeId || normalized.entityId,
      milestone,
      snapshot: normalized.payload?.current || null,
      observedAt: normalized.createdAt,
    });
  }
  normalized.payload = {
    ...(normalized.payload || {}),
    milestoneHistory: await listTradeMilestones(
      normalized.tradeId || normalized.entityId,
    ),
  };
  return normalized;
}

async function enqueueEnvelope(envelope) {
  const normalized = normalizeEnvelope(envelope);

  if (normalized.kind === "heartbeat") {
    normalized.dedupeKey = buildHeartbeatBucketKey(normalized.createdAt);
  }

  if (normalized.kind === "trade_status" || normalized.kind === "trade_terminal") {
    if (!shouldEmitTradeCards()) {
      return { ok: true, skipped: true, reason: "trade_cards_disabled" };
    }
    await enrichTradeEnvelope(normalized);
    const { text, parseMode } = formatEnvelopeToTelegram(normalized);
    const payloadHash = hashObject({ text, parseMode });
    const decision = await resolveTradeCardDispatch({
      tradeId: normalized.tradeId || normalized.entityId,
      stateHash: normalized.stateHash,
      displayHash: normalized.displayHash,
      payloadHash,
      allowDisplayRefresh: Boolean(
        normalized.displayOnly || normalized.forceDisplayRefresh,
      ),
    });
    if (!decision.shouldDispatch) {
      incrementMetric("deduped");
      return { ok: true, skipped: true, reason: decision.reason || "duplicate" };
    }

    const messageId = Number(decision?.entry?.telegram?.messageId ?? 0) || null;
    const operation = messageId ? "edit" : "send";
    const job = await enqueueOutboxJob({
      ...normalized,
      operation,
      messageId,
      payloadHash,
      envelope: normalized,
      payload: { text, parseMode },
    });
    incrementMetric("queued");
    if (normalized.source === "heartbeat") incrementMetric("heartbeatQueued");
    if (normalized.source === "live_refresh") incrementMetric("liveRefreshQueued");
    debugLog(
      {
        tradeId: normalized.tradeId,
        event: normalized.event,
        operation,
        displayOnly: normalized.displayOnly,
      },
      "[notifications] queued trade card",
    );
    kickOutbox();
    return { ok: true, queued: true, jobId: job?._id || null };
  }

  if (normalized.kind === "incident" && !incidentsEnabled()) {
    return { ok: true, skipped: true, reason: "incidents_disabled" };
  }

  const { text, parseMode } = formatEnvelopeToTelegram(normalized);
  const payloadHash = hashObject({ text, parseMode });
  const decision = await shouldDispatchDedupe({
    dedupeKey: normalized.dedupeKey,
    stateHash: normalized.stateHash,
    payloadHash,
  });
  if (!decision.shouldDispatch) {
    incrementMetric("deduped");
    return { ok: true, skipped: true, reason: decision.reason || "duplicate" };
  }

  const job = await enqueueOutboxJob({
    ...normalized,
    operation: "send",
    payloadHash,
    envelope: normalized,
    payload: { text, parseMode },
  });
  incrementMetric("queued");
  if (normalized.kind === "heartbeat") incrementMetric("heartbeatQueued");
  kickOutbox();
  return { ok: true, queued: true, jobId: job?._id || null };
}

async function dispatchNotification(envelope) {
  if (!notificationsEnabled()) {
    return { ok: true, skipped: true, reason: "telegram_disabled" };
  }
  await startNotificationDispatcher();
  return enqueueEnvelope(envelope);
}

async function dispatchTradeUpdate({
  previousTrade = null,
  trade = null,
  runtime = {},
  source = "trade_store",
  allowDisplayOnly = false,
  forceDisplayRefresh = false,
}) {
  if (!notificationsEnabled() || !shouldEmitTradeCards()) {
    return { ok: true, skipped: true };
  }
  await startNotificationDispatcher();
  const envelopes = buildTradeNotificationPlan({
    previousTrade,
    trade,
    runtime,
    source,
    allowDisplayOnly,
    forceDisplayRefresh,
  });
  const results = [];
  for (const pending of envelopes) {
    results.push(await enqueueEnvelope(pending));
  }
  return { ok: true, results };
}

function countCriticalFaults(faults) {
  if (Array.isArray(faults)) return faults.length;
  if (!faults || typeof faults !== "object") return 0;
  if (Array.isArray(faults.items)) return faults.items.length;
  return Object.keys(faults).length;
}

function buildActiveTradeSummary(activeTrade) {
  if (!activeTrade) return null;
  const symbol =
    activeTrade?.instrument?.tradingsymbol ||
    activeTrade?.tradingsymbol ||
    activeTrade?.symbol ||
    null;
  return [
    activeTrade?.tradeId || null,
    symbol,
    activeTrade?.side || null,
    activeTrade?.qty != null ? `x${activeTrade.qty}` : null,
    activeTrade?.status || null,
  ]
    .filter(Boolean)
    .join(" ");
}

function shouldSkipHeartbeatWhenClosed(snapshot = {}) {
  if (String(env.TELEGRAM_HEARTBEAT_WHEN_CLOSED || "false") === "true") {
    return false;
  }
  const engineMode =
    snapshot?.engineMode ||
    snapshot?.engineLifecycle?.mode ||
    snapshot?.mode ||
    null;
  if (!engineMode) return false;
  return ["IDLE"].includes(String(engineMode).toUpperCase());
}

async function emitHeartbeat() {
  if (!notificationsEnabled() || !shouldEmitHeartbeat() || !heartbeatProvider) {
    return { ok: true, skipped: true };
  }

  const snapshot = await heartbeatProvider();
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: true, skipped: true, reason: "heartbeat_provider_empty" };
  }
  if (shouldSkipHeartbeatWhenClosed(snapshot)) {
    return { ok: true, skipped: true, reason: "market_closed" };
  }

  const payload = {
    engineMode: snapshot?.engineMode || snapshot?.engineLifecycle?.mode || snapshot?.mode || null,
    tradingEnabled:
      typeof snapshot?.tradingEnabled === "boolean"
        ? snapshot.tradingEnabled
        : null,
    activeTradeCount:
      snapshot?.activeTrade
        ? 1
        : snapshot?.activeTradeId
          ? 1
          : Array.isArray(snapshot?.activeTrades)
            ? snapshot.activeTrades.length
            : 0,
    activeTradeSummary: buildActiveTradeSummary(snapshot?.activeTrade || null),
    dailyRiskState:
      snapshot?.dailyRiskState || snapshot?.dailyRisk?.state || null,
    tickerConnected:
      snapshot?.tickerConnected ??
      snapshot?.ticker?.connected ??
      snapshot?.livePreflight?.details?.ticker?.connected ??
      snapshot?.livePreflight?.details?.runtime?.tickerConnected ??
      null,
    kiteSessionActive:
      snapshot?.kiteLayer?.kiteSessionActive ??
      snapshot?.livePreflight?.details?.session?.active ??
      null,
    killSwitch:
      typeof snapshot?.killSwitch === "boolean" ? snapshot.killSwitch : null,
    criticalFaultCount: countCriticalFaults(snapshot?.faults),
  };
  return enqueueEnvelope({
    kind: "heartbeat",
    severity: "info",
    entityType: "engine",
    entityId: "primary",
    dedupeKey: buildHeartbeatBucketKey(new Date().toISOString()),
    stateHash: hashObject(payload),
    event: "ENGINE_HEARTBEAT",
    source: "heartbeat",
    payload,
    createdAt: new Date().toISOString(),
  });
}

function extractActiveTradeCandidates(snapshot = {}) {
  const candidates = [];
  if (snapshot?.activeTrade && snapshot?.activeTrade?.tradeId) {
    candidates.push({
      trade: snapshot.activeTrade,
      runtime: {
        ...(snapshot.activeTradeRuntime || {}),
        activeTradeId:
          snapshot?.activeTradeId || snapshot?.activeTrade?.tradeId || null,
        killSwitch:
          typeof snapshot?.killSwitch === "boolean" ? snapshot.killSwitch : null,
      },
    });
  }
  return candidates;
}

function absoluteDelta(nextValue, prevValue) {
  const next = Number(nextValue);
  const prev = Number(prevValue);
  if (!Number.isFinite(next) || !Number.isFinite(prev)) {
    return Number.isFinite(next) !== Number.isFinite(prev) ? Infinity : 0;
  }
  return Math.abs(next - prev);
}

function shouldRefreshTradeCard(entry, snapshot) {
  const messageId = Number(entry?.telegram?.messageId ?? 0);
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return { shouldRefresh: false, reason: "missing_message" };
  }
  if (!snapshot || snapshot.terminal) {
    return { shouldRefresh: false, reason: "terminal" };
  }

  const now = Date.now();
  const lastDisplayAt = new Date(
    entry?.liveRefresh?.lastDisplaySentAt || entry?.sentAt || entry?.updatedAt || 0,
  ).getTime();
  const minRefreshMs = getTradeCardMinRefreshMs();
  if (Number.isFinite(lastDisplayAt) && now - lastDisplayAt < minRefreshMs) {
    return { shouldRefresh: false, reason: "min_refresh_interval" };
  }

  const previousSnapshot = entry?.lastSnapshot || {};
  const ltpDelta = absoluteDelta(snapshot?.ltp, previousSnapshot?.ltp);
  const pnlDelta = absoluteDelta(
    snapshot?.pnlOpenInr,
    previousSnapshot?.pnlOpenInr,
  );
  const stopChanged =
    String(snapshot?.stopLoss ?? "") !== String(previousSnapshot?.stopLoss ?? "");
  const targetChanged =
    String(snapshot?.targetPrice ?? "") !==
      String(previousSnapshot?.targetPrice ?? "") ||
    String(snapshot?.targetStateLabel ?? "") !==
      String(previousSnapshot?.targetStateLabel ?? "");
  const protectionChanged =
    String(snapshot?.protectionStage ?? "") !==
      String(previousSnapshot?.protectionStage ?? "");
  const forceRefreshDue =
    !Number.isFinite(lastDisplayAt) ||
    now - lastDisplayAt >= getTradeCardForceRefreshMs();
  const material =
    ltpDelta >= getTradeCardLtpDelta() ||
    pnlDelta >= getTradeCardPnlDeltaInr() ||
    stopChanged ||
    targetChanged ||
    protectionChanged;

  if (!material && !forceRefreshDue) {
    return {
      shouldRefresh: false,
      reason: "below_threshold",
      ltpDelta,
      pnlDelta,
    };
  }

  return {
    shouldRefresh: true,
    reason: material ? "material_change" : "force_refresh_due",
    forceRefreshDue,
    ltpDelta,
    pnlDelta,
  };
}

async function emitLiveTradeRefresh() {
  if (!notificationsEnabled() || !shouldEmitTradeCards() || !heartbeatProvider) {
    return { ok: true, skipped: true };
  }

  const snapshot = await heartbeatProvider();
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: true, skipped: true, reason: "heartbeat_provider_empty" };
  }

  const candidates = extractActiveTradeCandidates(snapshot);
  if (!candidates.length) {
    return { ok: true, skipped: true, reason: "no_active_trade" };
  }

  const results = [];
  for (const candidate of candidates) {
    const tradeId = candidate?.trade?.tradeId;
    if (!tradeId) continue;
    const entry = await getTradeCardLedger(tradeId);
    if (!entry) continue;

    const runtime = {
      ...(candidate.runtime || {}),
      refreshAt: new Date().toISOString(),
      displayUpdatedAt: new Date().toISOString(),
    };
    const previewSnapshot = buildTradeStatusSnapshot({
      trade: candidate.trade,
      runtime,
    });
    const decision = shouldRefreshTradeCard(entry, previewSnapshot);
    if (!decision.shouldRefresh) continue;

    results.push(
      await dispatchTradeUpdate({
        previousTrade: candidate.trade,
        trade: candidate.trade,
        runtime,
        source: "live_refresh",
        allowDisplayOnly: true,
        forceDisplayRefresh: true,
      }),
    );
  }

  return { ok: true, refreshed: results.length, results };
}

async function deliverOutboxJob(job, options = {}) {
  const payload = job?.payload || {};
  const text = payload?.text || "";
  const parseMode = payload?.parseMode || "HTML";
  const operation = options?.operation || job?.operation || "send";
  const messageId =
    options?.messageId == null ? job?.messageId : options.messageId;

  if (operation === "edit" && Number(messageId) > 0) {
    return editMessageText(messageId, text, { parseMode });
  }
  return sendMessage(text, { parseMode });
}

async function processOutboxJob(job) {
  let deliveryOperation =
    job.operation === "edit" && Number(job.messageId) > 0 ? "edit" : "send";
  let result;

  try {
    result = await deliverOutboxJob(job, {
      operation: deliveryOperation,
      messageId: job.messageId,
    });
  } catch (error) {
    const classification = classifyTelegramError(error, {
      operation: deliveryOperation,
    });
    error.notificationClassification = classification;

    if (classification.noChange) {
      result = {
        ok: true,
        messageId: Number(job.messageId) || null,
        raw: { ok: true, noChange: true },
      };
    } else if (
      deliveryOperation === "edit" &&
      classification.permanentEditFailure &&
      (job.kind === "trade_status" || job.kind === "trade_terminal")
    ) {
      await invalidateTradeCardMessage({
        tradeId: job.tradeId || job.entityId,
        reason: "telegram_edit_invalidated",
        error: error?.message || String(error),
      });
      incrementMetric("fallbackResend");
      deliveryOperation = "send";
      try {
        result = await deliverOutboxJob(job, { operation: "send", messageId: null });
      } catch (resendError) {
        resendError.notificationClassification = classifyTelegramError(
          resendError,
          {
            operation: "send",
          },
        );
        resendError.retryOverridePatch = {
          operation: "send",
          messageId: null,
        };
        throw resendError;
      }
    } else {
      throw error;
    }
  }

  if (job.kind === "trade_status" || job.kind === "trade_terminal") {
    await upsertTradeCardLedger({
      tradeId: job.tradeId || job.entityId,
      messageId: result?.messageId,
      stateHash: job.stateHash,
      displayHash: job.displayHash,
      payloadHash: job.payloadHash,
      status: job.status,
      event: job.event,
      snapshot: job.envelope?.payload?.current || null,
      meta: {
        displayOnly: job.displayOnly,
        liveRefresh: job.source === "live_refresh" || job.displayOnly,
        source: job.source,
      },
    });
  } else {
    await recordDedupeDispatch({
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      stateHash: job.stateHash,
      payloadHash: job.payloadHash,
      envelope: job.envelope,
      result: result?.raw || null,
    });
    await recordIncidentDoc(job.envelope || {});
  }

  await markJobSent({
    jobId: job._id,
    processedStateHash: job.stateHash,
    result: result?.raw || null,
    messageId: result?.messageId ?? null,
  });

  if (deliveryOperation === "edit") incrementMetric("edited");
  else incrementMetric("sent");
  return result;
}

async function processOutboxOnce() {
  if (drainInFlight || !notificationsEnabled()) return { ok: true, skipped: true };
  if (mongoPollDeferredUntil && Date.now() < mongoPollDeferredUntil) {
    return {
      ok: false,
      deferred: true,
      backoffMs: Math.max(0, mongoPollDeferredUntil - Date.now()),
    };
  }
  drainInFlight = true;
  try {
    await startNotificationDispatcher();
    let jobs;
    try {
      jobs = await claimDueJobs({ limit: 10, workerId });
    } catch (error) {
      if (isTransientMongoError(error)) {
        return deferMongoOutboxPoll(error, "claim_due_jobs");
      }
      throw error;
    }

    for (const job of jobs) {
      try {
        await processOutboxJob(job);
      } catch (error) {
        if (isTransientMongoError(error)) {
          return deferMongoOutboxPoll(error, "process_outbox_job");
        }
        const classification =
          error?.notificationClassification ||
          classifyTelegramError(error, {
            operation:
              job.operation === "edit" && Number(job.messageId) > 0
                ? "edit"
                : "send",
          });
        if (classification.retryable) {
          incrementMetric("retried");
          try {
            await markJobRetry(job, error, {
              overridePatch: error?.retryOverridePatch || null,
            });
          } catch (persistError) {
            if (isTransientMongoError(persistError)) {
              return deferMongoOutboxPoll(persistError, "mark_job_retry");
            }
            throw persistError;
          }
          continue;
        }

        incrementMetric("failedPermanent");
        try {
          await markJobFailedPermanent(job, error, {
            overridePatch: error?.retryOverridePatch || null,
          });
        } catch (persistError) {
          if (isTransientMongoError(persistError)) {
            return deferMongoOutboxPoll(persistError, "mark_job_failed");
          }
          throw persistError;
        }
        logger.warn(
          {
            jobId: job?._id || null,
            kind: job?.kind || null,
            tradeId: job?.tradeId || null,
            err: error?.message || String(error),
            classification,
          },
          "[notifications] permanent delivery failure",
        );
      }
    }
    clearMongoOutboxPollDegraded();
    return { ok: true, processed: jobs.length };
  } finally {
    drainInFlight = false;
  }
}

function getNotificationDispatcherStatus() {
  return {
    started,
    workerId,
    metrics: { ...deliveryMetrics },
    heartbeatEnabled: shouldEmitHeartbeat(),
    tradeCardsEnabled: shouldEmitTradeCards(),
    liveRefreshMinSec: Math.round(getTradeCardMinRefreshMs() / 1000),
    liveRefreshForceSec: Math.round(getTradeCardForceRefreshMs() / 1000),
  };
}

module.exports = {
  startNotificationDispatcher,
  stopNotificationDispatcher,
  setHeartbeatProvider,
  dispatchNotification,
  dispatchTradeUpdate,
  processOutboxOnce,
  emitHeartbeat,
  emitLiveTradeRefresh,
  getNotificationDispatcherStatus,
};
