const { getDb } = require("../db");
const { env } = require("../config");

const NOTIFICATION_OUTBOX = "notification_outbox";
const TRADE_CARD_KINDS = new Set(["trade_status", "trade_terminal"]);

function nowDate() {
  return new Date();
}

function computeRetryDelayMs(retryCount, retryAfterMs = null) {
  const baseMs = Math.max(
    250,
    Number(env.TELEGRAM_OUTBOX_RETRY_BASE_MS ?? 1500) || 1500,
  );
  const exponentialMs = Math.min(baseMs * 2 ** Math.max(0, retryCount - 1), 120000);
  const preferredMs = Number.isFinite(Number(retryAfterMs))
    ? Math.max(exponentialMs, Number(retryAfterMs))
    : exponentialMs;
  const jitterWindow = Math.max(0, Math.round(preferredMs * 0.15));
  return preferredMs + Math.round(Math.random() * jitterWindow);
}

function buildGenericUniqueKey(job) {
  return [
    job.channel || "telegram",
    job.kind || "incident",
    job.dedupeKey || "no_dedupe",
    job.stateHash || "no_state",
  ].join(":");
}

function buildTradeCardUniqueKey(job) {
  return `${job.channel || "telegram"}:trade-card:${String(job.tradeId || job.entityId || "")}`;
}

function sanitizeJob(job) {
  return {
    channel: job.channel || "telegram",
    kind: job.kind || "incident",
    severity: job.severity || "info",
    entityType: job.entityType || null,
    entityId: job.entityId || null,
    tradeId: job.tradeId || null,
    event: job.event || null,
    status: job.status || null,
    source: job.source || null,
    dedupeKey: job.dedupeKey || null,
    stateHash: job.stateHash || null,
    displayHash: job.displayHash || null,
    payloadHash: job.payloadHash || null,
    envelope: job.envelope || null,
    payload: job.payload || null,
    operation: job.operation || "send",
    messageId: job.messageId || null,
    displayOnly: Boolean(job.displayOnly),
    forceDisplayRefresh: Boolean(job.forceDisplayRefresh),
  };
}

async function ensureNotificationOutboxIndexes() {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  await col.createIndex({ uniqueKey: 1 }, { unique: true });
  await col.createIndex({ status: 1, retryAt: 1, updatedAt: 1 });
  await col.createIndex({ tradeId: 1, updatedAt: -1 });
  await col.createIndex({ createdAt: -1 });
}

async function enqueueOutboxJob(job) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const now = nowDate();
  const sanitized = sanitizeJob(job);
  const isTradeCard = TRADE_CARD_KINDS.has(sanitized.kind);
  const uniqueKey = isTradeCard
    ? buildTradeCardUniqueKey(sanitized)
    : buildGenericUniqueKey(sanitized);

  if (isTradeCard) {
    await col.updateOne(
      { uniqueKey },
      {
        $set: {
          ...sanitized,
          uniqueKey,
          retryCount: 0,
          retryAt: now,
          status: "pending",
          lastError: null,
          workerId: null,
          processingAt: null,
          sentAt: null,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );
  } else {
    await col.updateOne(
      { uniqueKey },
      {
        $setOnInsert: {
          ...sanitized,
          uniqueKey,
          retryCount: 0,
          retryAt: now,
          status: "pending",
          lastError: null,
          workerId: null,
          processingAt: null,
          sentAt: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    );
  }

  return col.findOne({ uniqueKey });
}

async function claimDueJobs({ limit = 10, workerId }) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const now = nowDate();
  const due = await col
    .find({
      status: { $in: ["pending", "retry"] },
      retryAt: { $lte: now },
    })
    .sort({ retryAt: 1, updatedAt: 1, createdAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 10, 50)))
    .toArray();

  const claimed = [];
  for (const candidate of due) {
    const claim = await col.findOneAndUpdate(
      {
        _id: candidate._id,
        status: candidate.status,
        updatedAt: candidate.updatedAt,
      },
      {
        $set: {
          status: "processing",
          workerId: String(workerId || "notification-dispatcher"),
          processingAt: nowDate(),
          updatedAt: nowDate(),
        },
      },
      { returnDocument: "after" },
    );
    if (claim?.value) claimed.push(claim.value);
  }

  return claimed;
}

async function getOutboxJobById(jobId) {
  const db = getDb();
  return db.collection(NOTIFICATION_OUTBOX).findOne({ _id: jobId });
}

async function markJobSent({ jobId, processedStateHash, result, messageId = null }) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const current = await col.findOne({ _id: jobId });
  if (!current) return { ok: false, missing: true };

  const deliveredHash = String(processedStateHash || "");
  const latestHash = String(current.stateHash || "");
  const now = nowDate();

  if (latestHash && deliveredHash && latestHash !== deliveredHash) {
    await col.updateOne(
      { _id: jobId },
      {
        $set: {
          status: "pending",
          retryAt: now,
          ...(Number.isFinite(Number(messageId)) && Number(messageId) > 0
            ? { messageId: Number(messageId), operation: "edit" }
            : {}),
          workerId: null,
          processingAt: null,
          updatedAt: now,
          lastDeliveryAt: now,
          lastDeliveryResult: result || null,
          lastDeliveredStateHash: deliveredHash || null,
        },
      },
    );
    return { ok: true, superseded: true };
  }

  await col.updateOne(
    { _id: jobId },
    {
      $set: {
        status: "sent",
        sentAt: now,
        ...(Number.isFinite(Number(messageId)) && Number(messageId) > 0
          ? {
              messageId: Number(messageId),
              operation: "edit",
            }
          : {}),
        workerId: null,
        processingAt: null,
        updatedAt: now,
        lastDeliveryAt: now,
        lastDeliveryResult: result || null,
        lastDeliveredStateHash: deliveredHash || null,
      },
    },
  );
  return { ok: true, sent: true };
}

async function markJobRetry(job, error, options = {}) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const retryCount = Math.max(0, Number(job?.retryCount ?? 0)) + 1;
  const maxRetries = Math.max(
    0,
    Number(env.TELEGRAM_OUTBOX_MAX_RETRIES ?? 8) || 8,
  );
  const now = nowDate();
  const message = error?.message || String(error || "notification_delivery_failed");

  if (retryCount > maxRetries) {
    await col.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "failed",
          retryCount,
          lastError: message,
          failedAt: now,
          workerId: null,
          processingAt: null,
          updatedAt: now,
        },
      },
    );
    return { ok: true, failed: true };
  }

  const retryAt = new Date(
    Date.now() +
      computeRetryDelayMs(retryCount, Number(error?.retryAfterMs ?? NaN)),
  );
  const overridePatch =
    options?.overridePatch && typeof options.overridePatch === "object"
      ? options.overridePatch
      : null;
  await col.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "retry",
        retryCount,
        retryAt,
        lastError: message,
        workerId: null,
        processingAt: null,
        updatedAt: now,
        ...(overridePatch || {}),
      },
    },
  );
  return { ok: true, retry: true, retryAt };
}

async function markJobFailedPermanent(job, error, options = {}) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const now = nowDate();
  const message = error?.message || String(error || "notification_delivery_failed");
  const overridePatch =
    options?.overridePatch && typeof options.overridePatch === "object"
      ? options.overridePatch
      : null;
  await col.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        lastError: message,
        failedAt: now,
        workerId: null,
        processingAt: null,
        updatedAt: now,
        ...(overridePatch || {}),
      },
    },
  );
  return { ok: true, failed: true };
}

async function requeueStaleProcessingJobs({
  staleMs = 60_000,
} = {}) {
  const db = getDb();
  const col = db.collection(NOTIFICATION_OUTBOX);
  const cutoff = new Date(Date.now() - Math.max(1000, Number(staleMs) || 60_000));
  const result = await col.updateMany(
    {
      status: "processing",
      processingAt: { $lte: cutoff },
    },
    {
      $set: {
        status: "retry",
        retryAt: nowDate(),
        workerId: null,
        processingAt: null,
        updatedAt: nowDate(),
      },
    },
  );
  return Number(result?.modifiedCount ?? 0);
}

module.exports = {
  NOTIFICATION_OUTBOX,
  TRADE_CARD_KINDS,
  ensureNotificationOutboxIndexes,
  enqueueOutboxJob,
  claimDueJobs,
  getOutboxJobById,
  markJobSent,
  markJobRetry,
  markJobFailedPermanent,
  requeueStaleProcessingJobs,
};
