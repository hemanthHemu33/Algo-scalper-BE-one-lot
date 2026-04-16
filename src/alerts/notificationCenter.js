const { getDb } = require("../db");
const { ObjectId } = require("mongodb");
const { dispatchNotification } = require("./alertService");
const { reportFault } = require("../runtime/errorBus");

const CHANNELS = "notification_channels";
const INCIDENTS = "notification_incidents";

async function listChannels() {
  const db = getDb();
  return db.collection(CHANNELS).find({}).sort({ createdAt: -1 }).toArray();
}

async function addChannel({ name, type, target, enabled = true }) {
  const db = getDb();
  const doc = {
    name: name || type || "channel",
    type: type || "webhook",
    target,
    enabled: !!enabled,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const res = await db.collection(CHANNELS).insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function removeChannel(id) {
  const db = getDb();
  if (!id) return;
  const _id = ObjectId.isValid(id) ? new ObjectId(id) : id;
  await db.collection(CHANNELS).deleteOne({ _id });
}

async function recordIncident({ type, message, severity, meta }) {
  const db = getDb();
  const doc = {
    type: type || "incident",
    message: message || "",
    severity: severity || "info",
    meta: meta || null,
    createdAt: new Date(),
  };
  await db.collection(INCIDENTS).insertOne(doc);
  return doc;
}

async function listIncidents({ limit = 100 } = {}) {
  const db = getDb();
  return db
    .collection(INCIDENTS)
    .find({})
    .sort({ createdAt: -1 })
    .limit(Math.max(1, Math.min(limit, 500)))
    .toArray();
}

async function emitNotification({ type, message, severity, meta }) {
  try {
    await dispatchNotification({
      kind: "incident",
      severity: severity || "info",
      entityType: meta?.tradeId ? "trade" : "engine",
      entityId: meta?.tradeId || type || "notification_center",
      tradeId: meta?.tradeId || null,
      dedupeKey: `notification_center:${String(type || "incident").toUpperCase()}:${meta?.tradeId || "global"}`,
      event: String(type || "incident").toUpperCase(),
      status: meta?.status || null,
      source: "notification_center",
      payload: {
        message: message || "",
        meta: meta || null,
      },
      createdAt: new Date().toISOString(),
    });
  } catch (err) { reportFault({ code: "ALERTS_NOTIFICATIONCENTER_CATCH", err, message: "[src/alerts/notificationCenter.js] caught and continued" }); }

  let db;
  try {
    db = getDb();
  } catch {
    return { ok: false, reason: "db_not_ready" };
  }

  const channels = await db
    .collection(CHANNELS)
    .find({ enabled: true })
    .toArray();

  const results = [];
  for (const ch of channels) {
    if (ch.type === "webhook" && ch.target) {
      try {
        const resp = await fetch(String(ch.target), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, message, severity, meta }),
        });
        results.push({ id: ch._id, ok: resp.ok, status: resp.status });
      } catch (e) {
        results.push({ id: ch._id, ok: false, error: e?.message || String(e) });
      }
    } else {
      results.push({
        id: ch._id,
        ok: false,
        error: "unsupported_channel_type",
        type: ch.type,
      });
    }
  }

  return { ok: true, delivered: results };
}

module.exports = {
  listChannels,
  addChannel,
  removeChannel,
  listIncidents,
  emitNotification,
};
