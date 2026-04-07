const { getDb } = require("../db");
const { logger } = require("../logger");
const { canTransition, normalizeTradeStatus } = require("./tradeStateMachine");
const { normalizeStopRiskSemantics } = require("./stopRiskSemantics");
const { buildMissingTradeLifecyclePatch } = require("./tradeLifecycleState");
const { buildMissingWinnerProtectionPatch } = require("./winnerProtectionState");

const TRADES = "trades";
const ORDER_LINKS = "order_links";
const DAILY_RISK = "daily_risk";
const RISK_STATE = "risk_state";
const ORPHAN_ORDER_UPDATES = "orphan_order_updates";
const ORPHAN_ORDER_UPDATES_DLQ = "orphan_order_updates_dlq";
const ORDER_LOGS = "order_logs";
const LIVE_ORDER_SNAPSHOTS = "live_order_snapshots";
// Patch-6: cost calibration & reconciliations (post-trade cost model tuning)
const COST_CALIBRATION = "cost_calibration";
const COST_RECONCILIATIONS = "cost_reconciliations";
const STALE_TRANSITION_LOG_DEDUP_WINDOW_MS = 60 * 1000;
const staleTransitionLogCache = new Map();
let staleTransitionLogCacheSweepAt = 0;

function normalizeTradeVersionValue(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function withNormalizedTradeVersion(trade) {
  if (!trade || typeof trade !== "object") return trade;
  return {
    ...trade,
    version: normalizeTradeVersionValue(trade.version),
  };
}

function buildTradeVersionFilter(tradeId, expectedVersion) {
  const filter = { tradeId };
  const version = Number(expectedVersion);
  if (!Number.isInteger(version) || version < 0) {
    return filter;
  }
  if (version === 0) {
    filter.$or = [{ version: 0 }, { version: { $exists: false } }];
    return filter;
  }
  filter.version = version;
  return filter;
}

function shouldLogStaleTransition({ tradeId, fromStatus, toStatus, role }) {
  const now = Date.now();
  if (
    staleTransitionLogCache.size > 0 &&
    now - staleTransitionLogCacheSweepAt >= STALE_TRANSITION_LOG_DEDUP_WINDOW_MS
  ) {
    for (const [key, lastLoggedAt] of staleTransitionLogCache.entries()) {
      if (now - lastLoggedAt >= STALE_TRANSITION_LOG_DEDUP_WINDOW_MS) {
        staleTransitionLogCache.delete(key);
      }
    }
    staleTransitionLogCacheSweepAt = now;
  }

  const key = [
    String(tradeId || ""),
    String(fromStatus || ""),
    String(toStatus || ""),
    String(role || "UNKNOWN").toUpperCase(),
  ].join("|");
  const lastLoggedAt = staleTransitionLogCache.get(key);
  if (
    Number.isFinite(lastLoggedAt) &&
    now - lastLoggedAt < STALE_TRANSITION_LOG_DEDUP_WINDOW_MS
  ) {
    return false;
  }

  staleTransitionLogCache.set(key, now);
  return true;
}

async function ensureTradeIndexes() {
  const db = getDb();
  await db.collection(TRADES).createIndex({ tradeId: 1 }, { unique: true });
  await db.collection(TRADES).createIndex({ status: 1, updatedAt: -1 });
  await db.collection(TRADES).createIndex({ createdAt: -1, strategyId: 1 });
  await db
    .collection(ORDER_LINKS)
    .createIndex({ order_id: 1 }, { unique: true });
  await db.collection(ORDER_LINKS).createIndex({ tradeId: 1 });
  await db.collection(DAILY_RISK).createIndex({ date: 1 }, { unique: true });
  await db.collection(ORDER_LOGS).createIndex({ order_id: 1, createdAt: -1 });
  await db.collection(ORDER_LOGS).createIndex({ tradeId: 1, createdAt: -1 });
  await db
    .collection(LIVE_ORDER_SNAPSHOTS)
    .createIndex({ tradeId: 1 }, { unique: true });
  await db.collection(LIVE_ORDER_SNAPSHOTS).createIndex({ updatedAt: -1 });
  await db.collection(RISK_STATE).createIndex({ date: 1 }, { unique: true });

  // Cost calibration (one doc per segmentKey)
  await db
    .collection(COST_CALIBRATION)
    .createIndex({ segmentKey: 1 }, { unique: true });
  await db.collection(COST_RECONCILIATIONS).createIndex({ createdAt: -1 });

  // Orphan order updates: store early postbacks that arrive before order_id->tradeId link exists.
  // TTL 6 hours (21600 sec)
  await db
    .collection(ORPHAN_ORDER_UPDATES)
    .createIndex({ createdAt: 1 }, { expireAfterSeconds: 6 * 60 * 60 });
  await db
    .collection(ORPHAN_ORDER_UPDATES)
    .createIndex({ order_id: 1, createdAt: 1 });
  await db
    .collection(ORPHAN_ORDER_UPDATES_DLQ)
    .createIndex({ order_id: 1, deadLetteredAt: -1 });
  await db
    .collection(ORPHAN_ORDER_UPDATES_DLQ)
    .createIndex({ deadLetteredAt: 1 });
}

async function insertTrade(trade) {
  const db = getDb();
  const stopRisk = normalizeStopRiskSemantics(trade || {});
  const lifecycle = buildMissingTradeLifecyclePatch({
    ...(trade || {}),
    ...stopRisk,
  });
  const winnerProtection = buildMissingWinnerProtectionPatch({
    ...(trade || {}),
    ...stopRisk,
  });
  await db
    .collection(TRADES)
    .insertOne({
      ...trade,
      ...stopRisk,
      ...lifecycle,
      ...winnerProtection,
      version: Math.max(1, normalizeTradeVersionValue(trade?.version) || 1),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

async function updateTrade(tradeId, patch, options = {}) {
  const db = getDb();
  const update = { ...(patch || {}) };
  const suppliedVersion = Number(options?.expectedVersion);
  const current = withNormalizedTradeVersion(
    options?.currentTrade || (await db.collection(TRADES).findOne({ tradeId })),
  );

  if (!current) {
    return {
      ok: false,
      status: "MISSING",
      tradeId,
      expectedVersion: Number.isInteger(suppliedVersion) ? suppliedVersion : null,
      trade: null,
      validation: null,
    };
  }

  const expectedVersion =
    Number.isInteger(suppliedVersion) && suppliedVersion >= 0
      ? suppliedVersion
      : normalizeTradeVersionValue(current?.version);
  let validation = null;

  if (
    Object.prototype.hasOwnProperty.call(update, "stopLoss") &&
    !Object.prototype.hasOwnProperty.call(update, "brokerStopLoss")
  ) {
    update.brokerStopLoss = update.stopLoss;
  }
  if (
    Object.prototype.hasOwnProperty.call(update, "brokerStopLoss") &&
    !Object.prototype.hasOwnProperty.call(update, "stopLoss")
  ) {
    update.stopLoss = update.brokerStopLoss;
  }
  if (
    Object.prototype.hasOwnProperty.call(update, "strategyStopLoss") &&
    !Object.prototype.hasOwnProperty.call(update, "initialStopLoss")
  ) {
    update.initialStopLoss = update.strategyStopLoss;
  }
  if (
    Object.prototype.hasOwnProperty.call(update, "slTrigger") === false &&
    Object.prototype.hasOwnProperty.call(update, "brokerStopLoss")
  ) {
    update.slTrigger = update.brokerStopLoss;
  }

  if (Object.prototype.hasOwnProperty.call(update, "status")) {
    try {
      const fromStatus = current?.status || null;
      const toStatus = normalizeTradeStatus(update.status);

      // Broker order postbacks can arrive out of order.
      // Ignore late ENTRY_FILLED updates once a trade already has SL/LIVE state.
      const staleEntryFill =
        toStatus === "ENTRY_FILLED" &&
        ["SL_PLACED", "SL_OPEN", "SL_CONFIRMED", "LIVE"].includes(
          normalizeTradeStatus(fromStatus),
        );
      if (staleEntryFill) {
        const role =
          update?.lastEventMeta?.role ?? update?.role ?? current?.lastEventMeta?.role ?? null;
        const staleTransitionMeta = { tradeId, fromStatus, toStatus };
        if (role) staleTransitionMeta.role = role;
        if (shouldLogStaleTransition({ ...staleTransitionMeta, role })) {
          logger.info(
            staleTransitionMeta,
            "[trade] stale ENTRY_FILLED transition ignored",
          );
        }
        delete update.status;
        validation = {
          ok: true,
          reason: "STALE_ENTRY_FILLED_IGNORED",
          fromStatus,
          toStatus,
        };
      }

      const transition = canTransition(fromStatus, toStatus);

      if (!staleEntryFill && !transition.ok) {
        logger.error(
          { tradeId, fromStatus, toStatus, reason: transition.reason },
          "[trade] invalid status transition blocked",
        );
        delete update.status;
        update.statusTransitionError = {
          from: fromStatus,
          to: toStatus,
          reason: transition.reason,
          ts: new Date(),
        };
        validation = {
          ok: false,
          reason: transition.reason,
          fromStatus,
          toStatus,
        };
      } else if (!staleEntryFill) {
        update.status = toStatus;
        validation = {
          ok: true,
          reason: transition.reason,
          fromStatus,
          toStatus,
        };
      }

      if (Object.prototype.hasOwnProperty.call(update, "strategyStopLoss")) {
        const currentStrategyStop = current?.strategyStopLoss ?? current?.initialStopLoss ?? current?.stopLoss ?? null;
        const nextStrategyStop = update.strategyStopLoss;
        if (
          currentStrategyStop != null &&
          nextStrategyStop != null &&
          Number(currentStrategyStop) !== Number(nextStrategyStop)
        ) {
          logger.warn(
            { tradeId, currentStrategyStop, nextStrategyStop },
            "[trade] strategyStopLoss mutation blocked",
          );
          delete update.strategyStopLoss;
          delete update.initialStopLoss;
        }
      }
    } catch (e) {
      logger.warn(
        { tradeId, e: e?.message || String(e) },
        "[trade] status transition validation skipped",
      );
      validation = {
        ok: false,
        reason: "VALIDATION_ERROR",
        fromStatus: current?.status || null,
        toStatus: normalizeTradeStatus(update.status),
      };
    }
  } else if (Object.prototype.hasOwnProperty.call(update, "strategyStopLoss")) {
    try {
      const current = await db.collection(TRADES).findOne({ tradeId });
      const currentStrategyStop = current?.strategyStopLoss ?? current?.initialStopLoss ?? current?.stopLoss ?? null;
      const nextStrategyStop = update.strategyStopLoss;
      if (
        currentStrategyStop != null &&
        nextStrategyStop != null &&
        Number(currentStrategyStop) !== Number(nextStrategyStop)
      ) {
        logger.warn(
          { tradeId, currentStrategyStop, nextStrategyStop },
          "[trade] strategyStopLoss mutation blocked",
        );
        delete update.strategyStopLoss;
        delete update.initialStopLoss;
      }
    } catch (e) {
      logger.warn(
        { tradeId, e: e?.message || String(e) },
        "[trade] strategyStopLoss immutability check skipped",
      );
    }
  }

  delete update.version;

  const runUpdate = () =>
    db.collection(TRADES).findOneAndUpdate(
      buildTradeVersionFilter(tradeId, expectedVersion),
      {
        $set: { ...update, updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { returnDocument: "after" },
    );

  let result;
  try {
    result = await runUpdate();
  } catch (e) {
    const retryable =
      Boolean(e?.errorLabels?.includes?.("RetryableWriteError")) ||
      Boolean(e?.errorLabels?.includes?.("TransientTransactionError")) ||
      [6, 7, 89, 91, 189, 262, 9001, 11600, 11602, 13435, 13436].includes(
        Number(e?.code),
      );

    if (!retryable) throw e;

    logger.warn(
      { tradeId, code: e?.code, message: e?.message || String(e) },
      "[trade] updateTrade transient failure; retrying once",
    );
    result = await runUpdate();
  }

  const appliedTrade = withNormalizedTradeVersion(
    result?.value ??
      result?.lastErrorObject?.value ??
      (result?.tradeId ? result : null),
  );
  if (!appliedTrade) {
    const latest = withNormalizedTradeVersion(
      await db.collection(TRADES).findOne({ tradeId }),
    );
    if (!latest) {
      logger.error(
        { tradeId, patchKeys: Object.keys(update) },
        "[trade] updateTrade dropped because trade was not found",
      );
      return {
        ok: false,
        status: "MISSING",
        tradeId,
        expectedVersion,
        trade: null,
        validation,
      };
    }

    logger.warn(
      {
        tradeId,
        expectedVersion,
        actualVersion: latest.version,
        patchKeys: Object.keys(update),
      },
      "[trade] updateTrade version conflict",
    );
    return {
      ok: false,
      status: "CONFLICT",
      tradeId,
      expectedVersion,
      actualVersion: latest.version,
      trade: latest,
      validation,
    };
  }

  return {
    ok: true,
    status: "APPLIED",
    tradeId,
    expectedVersion,
    version: appliedTrade.version,
    trade: appliedTrade,
    validation,
  };
}

async function getTrade(tradeId) {
  const db = getDb();
  return withNormalizedTradeVersion(
    await db.collection(TRADES).findOne({ tradeId }),
  );
}

async function getActiveTrades() {
  const db = getDb();
  const rows = await db
    .collection(TRADES)
    .find({
      status: {
        $in: [
          "ENTRY_PLACED",
          "ENTRY_OPEN",
          "ENTRY_REPLACED",
          "ENTRY_FILLED",
          "SL_PLACED",
          "SL_OPEN",
          "SL_CONFIRMED",
          "LIVE",
          "EXIT_PLACED",
          "EXIT_OPEN",
          "EXIT_PARTIAL",
          "PANIC_EXIT_PLACED",
          "RECOVERY_REHYDRATED",
          "GUARD_FAILED",
        ],
      },
    })
    .toArray();
  return rows.map((row) => withNormalizedTradeVersion(row));
}

async function linkOrder({ order_id, tradeId, role }) {
  const db = getDb();
  await db.collection(ORDER_LINKS).updateOne(
    { order_id },
    {
      $set: { order_id, tradeId, role, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
}

async function findTradeByOrder(order_id) {
  const db = getDb();
  const link = await db.collection(ORDER_LINKS).findOne({ order_id });
  if (!link) return null;
  const trade = await db.collection(TRADES).findOne({ tradeId: link.tradeId });
  return trade ? { trade, link } : null;
}

async function saveOrphanOrderUpdate({ order_id, payload }) {
  const db = getDb();
  if (!order_id) return;
  await db.collection(ORPHAN_ORDER_UPDATES).insertOne({
    order_id: String(order_id),
    payload,
    createdAt: new Date(),
  });
}

async function popOrphanOrderUpdates(order_id) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return [];
  const rows = await db
    .collection(ORPHAN_ORDER_UPDATES)
    .find({ order_id: oid })
    .sort({ createdAt: 1 })
    .toArray();

  if (rows.length) {
    await db.collection(ORPHAN_ORDER_UPDATES).deleteMany({ order_id: oid });
  }

  return rows.map((r) => r.payload).filter(Boolean);
}

async function deadLetterOrphanOrderUpdates({ order_id, reason, meta }) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return { moved: 0 };

  const rows = await db
    .collection(ORPHAN_ORDER_UPDATES)
    .find({ order_id: oid })
    .sort({ createdAt: 1 })
    .toArray();

  if (!rows.length) return { moved: 0 };

  await db.collection(ORPHAN_ORDER_UPDATES_DLQ).insertMany(
    rows.map((row) => ({
      order_id: oid,
      payload: row.payload || null,
      orphanCreatedAt: row.createdAt || new Date(),
      deadLetteredAt: new Date(),
      reason: reason || "MAX_RETRIES_EXHAUSTED",
      meta: meta || null,
    })),
  );

  await db.collection(ORPHAN_ORDER_UPDATES).deleteMany({ order_id: oid });
  return { moved: rows.length };
}

async function appendOrderLog({ order_id, tradeId, status, payload }) {
  const db = getDb();
  const oid = String(order_id || "");
  if (!oid) return;
  await db.collection(ORDER_LOGS).insertOne({
    order_id: oid,
    tradeId: tradeId || null,
    status: status || null,
    payload: payload || null,
    createdAt: new Date(),
  });
}

async function getOrderLogs({ order_id, tradeId, limit = 200 }) {
  const db = getDb();
  const query = {};
  if (order_id) query.order_id = String(order_id);
  if (tradeId) query.tradeId = tradeId;
  return db
    .collection(ORDER_LOGS)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(limit, 500)))
    .toArray();
}

async function upsertLiveOrderSnapshot({
  tradeId,
  orderId,
  role,
  order,
  source,
  metadata,
}) {
  const db = getDb();
  const tid = String(tradeId || "");
  const oid = String(orderId || "");
  if (!tid || !oid) return;

  const now = new Date();
  const roleKey = String(role || "UNKNOWN")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  const status = String(order?.status || "").toUpperCase() || null;
  const snapshotEntry = {
    orderId: oid,
    role: roleKey,
    status,
    source: source || null,
    seenAt: now,
    order: order || null,
    ...(metadata && typeof metadata === "object" ? metadata : {}),
  };

  const setPatch = {
    tradeId: tid,
    updatedAt: now,
    [`byOrderId.${oid}`]: snapshotEntry,
  };
  if (roleKey) setPatch[`byRole.${roleKey}`] = snapshotEntry;

  await db.collection(LIVE_ORDER_SNAPSHOTS).updateOne(
    { tradeId: tid },
    {
      $set: setPatch,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
}

async function getLiveOrderSnapshotsByTradeIds(tradeIds = []) {
  const db = getDb();
  const ids = (tradeIds || []).map((x) => String(x || "")).filter(Boolean);
  if (!ids.length) return [];
  return db
    .collection(LIVE_ORDER_SNAPSHOTS)
    .find({ tradeId: { $in: ids } })
    .toArray();
}

async function upsertDailyRisk(date, patch) {
  const db = getDb();
  await db.collection(DAILY_RISK).updateOne(
    { date },
    {
      $set: { ...patch, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), date },
    },
    { upsert: true },
  );
}

async function getDailyRisk(date) {
  const db = getDb();
  return db.collection(DAILY_RISK).findOne({ date });
}

async function upsertRiskState(date, patch) {
  const db = getDb();
  await db.collection(RISK_STATE).updateOne(
    { date },
    {
      $set: { ...patch, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), date },
    },
    { upsert: true },
  );
}

async function getRiskState(date) {
  const db = getDb();
  return db.collection(RISK_STATE).findOne({ date });
}

module.exports = {
  TRADES,
  ORDER_LINKS,
  DAILY_RISK,
  RISK_STATE,
  ORPHAN_ORDER_UPDATES,
  ORDER_LOGS,
  LIVE_ORDER_SNAPSHOTS,
  COST_CALIBRATION,
  COST_RECONCILIATIONS,
  ensureTradeIndexes,
  insertTrade,
  updateTrade,
  getTrade,
  getActiveTrades,
  linkOrder,
  findTradeByOrder,
  saveOrphanOrderUpdate,
  popOrphanOrderUpdates,
  deadLetterOrphanOrderUpdates,
  appendOrderLog,
  getOrderLogs,
  upsertLiveOrderSnapshot,
  getLiveOrderSnapshotsByTradeIds,
  upsertDailyRisk,
  getDailyRisk,
  upsertRiskState,
  getRiskState,
};
