const { getDb } = require("../db");
const { env } = require("../config");

const NOTIFICATION_LEDGER = "notification_ledger";

function nowDate() {
  return new Date();
}

function getDedupeTtlSec() {
  return Math.max(0, Number(env.TELEGRAM_DEDUPE_TTL_SEC ?? 21600) || 21600);
}

function buildDedupeLedgerKey(dedupeKey) {
  return `dedupe:${String(dedupeKey || "")}`;
}

function buildTradeCardLedgerKey(tradeId) {
  return `trade-card:${String(tradeId || "")}`;
}

function buildTradeMilestoneLedgerKey(tradeId, milestone) {
  return `trade-milestone:${String(tradeId || "")}:${String(milestone || "")}`;
}

async function ensureNotificationLedgerIndexes() {
  const db = getDb();
  const col = db.collection(NOTIFICATION_LEDGER);
  await col.createIndex({ ledgerKey: 1 }, { unique: true });
  await col.createIndex({ kind: 1, tradeId: 1, updatedAt: -1 });
  await col.createIndex({ kind: 1, dedupeKey: 1, updatedAt: -1 });
  await col.createIndex({ kind: 1, firstObservedAt: 1, tradeId: 1 });
}

async function getLedgerEntry(ledgerKey) {
  const db = getDb();
  return db.collection(NOTIFICATION_LEDGER).findOne({ ledgerKey });
}

async function getTradeCardLedger(tradeId) {
  const key = buildTradeCardLedgerKey(tradeId);
  return getLedgerEntry(key);
}

async function listTradeMilestones(tradeId) {
  const db = getDb();
  return db
    .collection(NOTIFICATION_LEDGER)
    .find({
      kind: "trade_milestone",
      tradeId: String(tradeId || ""),
    })
    .sort({ firstObservedAt: 1, createdAt: 1 })
    .toArray();
}

async function shouldDispatchDedupe({
  dedupeKey,
  stateHash,
  payloadHash = null,
}) {
  const ledgerKey = buildDedupeLedgerKey(dedupeKey);
  const current = await getLedgerEntry(ledgerKey);
  if (!current) {
    return { shouldDispatch: true, entry: null };
  }

  const now = Date.now();
  const dedupeUntilTs = current?.dedupeUntil
    ? new Date(current.dedupeUntil).getTime()
    : 0;
  const withinWindow = dedupeUntilTs > now;
  const sameState = String(current.stateHash || "") === String(stateHash || "");
  const samePayload =
    payloadHash != null &&
    String(current.lastPayloadHash || "") === String(payloadHash || "");

  if (withinWindow && (sameState || samePayload)) {
    return {
      shouldDispatch: false,
      entry: current,
      reason: sameState ? "same_state_hash" : "same_payload_hash",
    };
  }

  return { shouldDispatch: true, entry: current };
}

async function recordDedupeDispatch({
  kind,
  dedupeKey,
  stateHash,
  payloadHash,
  envelope,
  result = null,
}) {
  const db = getDb();
  const now = nowDate();
  const ttlSec = getDedupeTtlSec();
  await db.collection(NOTIFICATION_LEDGER).updateOne(
    { ledgerKey: buildDedupeLedgerKey(dedupeKey) },
    {
      $set: {
        ledgerKey: buildDedupeLedgerKey(dedupeKey),
        kind: kind || "incident",
        dedupeKey,
        entityType: envelope?.entityType || null,
        entityId: envelope?.entityId || null,
        tradeId: envelope?.tradeId || null,
        event: envelope?.event || null,
        status: envelope?.status || null,
        severity: envelope?.severity || null,
        stateHash: stateHash || null,
        lastPayloadHash: payloadHash || null,
        dedupeUntil: ttlSec > 0 ? new Date(Date.now() + ttlSec * 1000) : null,
        lastResult: result || null,
        sentAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

async function resolveTradeCardDispatch({
  tradeId,
  stateHash,
  displayHash = null,
  payloadHash = null,
  allowDisplayRefresh = false,
}) {
  const entry = await getTradeCardLedger(tradeId);
  const messageId = Number(entry?.telegram?.messageId ?? 0);
  const sameState = String(entry?.lastStateHash || "") === String(stateHash || "");
  const sameDisplay =
    displayHash != null &&
    String(entry?.lastDisplayHash || "") === String(displayHash || "");
  const samePayload =
    payloadHash != null &&
    String(entry?.lastPayloadHash || "") === String(payloadHash || "");

  if (entry && (samePayload || sameDisplay)) {
    return {
      shouldDispatch: false,
      entry,
      reason: sameDisplay ? "same_display_hash" : "same_payload_hash",
      operation: Number.isFinite(messageId) && messageId > 0 ? "edit" : "send",
    };
  }

  if (entry && sameState && !allowDisplayRefresh) {
    return {
      shouldDispatch: false,
      entry,
      reason: "same_state_hash",
      operation: Number.isFinite(messageId) && messageId > 0 ? "edit" : "send",
    };
  }

  return {
    shouldDispatch: true,
    entry,
    operation: Number.isFinite(messageId) && messageId > 0 ? "edit" : "send",
  };
}

async function upsertTradeCardLedger({
  tradeId,
  messageId,
  stateHash,
  displayHash,
  payloadHash,
  status,
  event,
  snapshot,
  meta = {},
}) {
  const db = getDb();
  const now = nowDate();
  const telegram =
    Number.isFinite(Number(messageId)) && Number(messageId) > 0
      ? {
          chatId: env.TELEGRAM_CHAT_ID || null,
          messageId: Number(messageId),
          invalidatedAt: null,
        }
      : null;

  await db.collection(NOTIFICATION_LEDGER).updateOne(
    { ledgerKey: buildTradeCardLedgerKey(tradeId) },
    {
      $set: {
        ledgerKey: buildTradeCardLedgerKey(tradeId),
        kind: "trade_card",
        tradeId: String(tradeId || ""),
        event: event || null,
        status: status || null,
        lastStateHash: stateHash || null,
        lastDisplayHash: displayHash || null,
        lastPayloadHash: payloadHash || null,
        lastSnapshot: snapshot || null,
        liveRefresh: {
          lastDisplaySentAt: now,
          lastStructuralSentAt:
            meta?.displayOnly || meta?.liveRefresh
              ? meta?.lastStructuralSentAt || null
              : now,
          lastLiveRefreshAt: meta?.liveRefresh ? now : null,
          lastDisplayUpdatedAt: snapshot?.displayUpdatedAt || null,
          lastLtp: snapshot?.ltp ?? null,
          lastPnlOpenInr: snapshot?.pnlOpenInr ?? null,
          source: meta?.source || null,
        },
        telegram,
        sentAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

async function invalidateTradeCardMessage({
  tradeId,
  reason = null,
  error = null,
}) {
  const db = getDb();
  const now = nowDate();
  await db.collection(NOTIFICATION_LEDGER).updateOne(
    { ledgerKey: buildTradeCardLedgerKey(tradeId) },
    {
      $set: {
        updatedAt: now,
        lastEditInvalidatedAt: now,
        lastEditInvalidationReason: reason || null,
        lastEditInvalidationError: error || null,
        telegram: null,
      },
    },
  );
}

async function recordTradeMilestone({
  tradeId,
  milestone,
  snapshot = null,
  observedAt = null,
}) {
  const ledgerKey = buildTradeMilestoneLedgerKey(tradeId, milestone);
  const current = await getLedgerEntry(ledgerKey);
  if (current) {
    return { recorded: false, entry: current };
  }

  const db = getDb();
  const now = observedAt ? new Date(observedAt) : nowDate();
  await db.collection(NOTIFICATION_LEDGER).updateOne(
    { ledgerKey },
    {
      $set: {
        ledgerKey,
        kind: "trade_milestone",
        tradeId: String(tradeId || ""),
        milestone: String(milestone || ""),
        status: snapshot?.status || null,
        terminalEvent: snapshot?.terminalEvent || null,
        firstObservedAt: now,
        lastObservedAt: now,
        snapshot: snapshot || null,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true },
  );
  return { recorded: true, entry: await getLedgerEntry(ledgerKey) };
}

module.exports = {
  NOTIFICATION_LEDGER,
  ensureNotificationLedgerIndexes,
  buildDedupeLedgerKey,
  buildTradeCardLedgerKey,
  buildTradeMilestoneLedgerKey,
  getLedgerEntry,
  getTradeCardLedger,
  listTradeMilestones,
  shouldDispatchDedupe,
  recordDedupeDispatch,
  resolveTradeCardDispatch,
  upsertTradeCardLedger,
  invalidateTradeCardMessage,
  recordTradeMilestone,
};
