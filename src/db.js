const { MongoClient } = require("mongodb");
const dns = require("dns");
const { env } = require("./config");
const { logger } = require("./logger");
const { reportWindowedFault } = require("./runtime/errorBus");
const { isTransientMongoError } = require("./runtime/isTransientMongoError");
const { configureRuntimeLogDb } = require("./runtime/runtimeLogStore");
const {
  getMongoRuntimeState,
  getMongoHealthSnapshot,
  markMongoHealthy,
  markMongoDegraded,
  noteMongoPoolCreated,
  noteMongoPoolClosed,
  noteMongoPoolCleared,
  noteMongoConnectionCreated,
  noteMongoConnectionReady,
  noteMongoConnectionClosed,
  noteMongoCheckoutStarted,
  noteMongoCheckoutSuccess,
  noteMongoCheckoutCheckedIn,
  noteMongoCheckoutFailed,
} = require("./runtime/mongoRuntimeState");

let client;
let db;
let connectPromise = null;
let listenersAttached = false;

function mongoNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function mongoBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function mongoClientOptions() {
  const options = {
    appName: String(process.env.MONGO_APP_NAME || "kite-scalper-engine"),
    retryReads: mongoBool("MONGO_RETRY_READS", true),
    retryWrites: mongoBool("MONGO_RETRY_WRITES", true),
    maxPoolSize: mongoNum("MONGO_MAX_POOL_SIZE", 30),
    minPoolSize: mongoNum("MONGO_MIN_POOL_SIZE", 2),
    maxIdleTimeMS: mongoNum("MONGO_MAX_IDLE_MS", 60_000),
    waitQueueTimeoutMS: mongoNum("MONGO_WAIT_QUEUE_TIMEOUT_MS", 8_000),
    connectTimeoutMS: mongoNum("MONGO_CONNECT_TIMEOUT_MS", 10_000),
    serverSelectionTimeoutMS: mongoNum(
      "MONGO_SERVER_SELECTION_TIMEOUT_MS",
      10_000,
    ),
    socketTimeoutMS: mongoNum("MONGO_SOCKET_TIMEOUT_MS", 45_000),
    heartbeatFrequencyMS: mongoNum("MONGO_HEARTBEAT_FREQUENCY_MS", 10_000),
  };

  const maxConnecting = mongoNum("MONGO_MAX_CONNECTING", 4);
  if (Number.isFinite(maxConnecting) && maxConnecting > 0) {
    options.maxConnecting = maxConnecting;
  }

  return options;
}

function logMongoClientOptions(options) {
  logger.info(
    {
      maxPoolSize: options.maxPoolSize,
      minPoolSize: options.minPoolSize,
      maxConnecting: options.maxConnecting ?? null,
      waitQueueTimeoutMS: options.waitQueueTimeoutMS,
      serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
      connectTimeoutMS: options.connectTimeoutMS,
      socketTimeoutMS: options.socketTimeoutMS,
      heartbeatFrequencyMS: options.heartbeatFrequencyMS,
      retryReads: options.retryReads,
      retryWrites: options.retryWrites,
    },
    "[db] mongo client options resolved",
  );
}

function applySrvDnsWorkaround() {
  try {
    if (process.platform !== "win32") return;

    const uri = String(env.MONGO_URI || "");
    if (!uri.startsWith("mongodb+srv://")) return;

    const enabled =
      String(process.env.DNS_SRV_WORKAROUND || "true") !== "false";
    if (!enabled) return;

    const servers = String(process.env.DNS_SERVERS || "1.1.1.1,8.8.8.8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    dns.setServers(servers);
    logger.warn(
      { servers },
      "[dns] SRV workaround enabled (custom DNS servers set)",
    );
  } catch (e) {
    logger.warn(
      { err: { message: e?.message, name: e?.name } },
      "[dns] SRV workaround failed to apply (continuing)",
    );
  }
}

function toCheckoutError(event = {}) {
  if (event?.reason instanceof Error) return event.reason;
  if (event?.error instanceof Error) return event.error;
  const fallbackReason = String(
    event?.reason || event?.error || "connection checkout failed",
  );
  const error = new Error(fallbackReason);
  error.code = String(event?.reason || "");
  return error;
}

function markAndLogMongoDegraded({
  error,
  reason,
  message = "[db] degraded",
  meta,
} = {}) {
  const degraded = markMongoDegraded({ error, reason });
  const runtime = getMongoRuntimeState();
  reportWindowedFault({
    windowKey: `db_degraded_${String(reason || "unknown")}`,
    windowMs: 30_000,
    code: "DB_DEGRADED",
    err: error,
    message,
    meta: {
      reason: reason || null,
      severity: degraded?.severity || runtime?.severity || null,
      state: degraded?.state || runtime?.state || null,
      failureStreak: Number(
        degraded?.failureStreak || runtime?.failureStreak || 0,
      ),
      burstCount: Number(degraded?.burstCount || runtime?.burstCount || 0),
      degradedSince: runtime?.degradedSince || null,
      err: error?.message || String(error || ""),
      ...(meta || {}),
    },
  });
}

function markMongoConnected(meta = {}) {
  const next = markMongoHealthy({
    connect: true,
    reason: "CONNECT_SUCCESS",
  });
  logger.info(
    {
      db: env.MONGO_DB,
      mongoState: next?.state || getMongoRuntimeState()?.state || null,
      mongoSeverity: next?.severity || getMongoRuntimeState()?.severity || null,
      ...(meta || {}),
    },
    "[db] connected",
  );
}

function attachMongoListeners() {
  if (!client || listenersAttached) return;
  listenersAttached = true;

  client.on("connectionPoolCreated", (event) => {
    try {
      noteMongoPoolCreated(event);
      logger.info(
        {
          address: event?.address || null,
          maxPoolSize: event?.options?.maxPoolSize ?? null,
          minPoolSize: event?.options?.minPoolSize ?? null,
          maxConnecting: event?.options?.maxConnecting ?? null,
          waitQueueTimeoutMS: event?.options?.waitQueueTimeoutMS ?? null,
        },
        "[db] connection pool created",
      );
    } catch {}
  });

  client.on("connectionPoolReady", (event) => {
    try {
      logger.info(
        { address: event?.address || null },
        "[db] connection pool ready",
      );
    } catch {}
  });

  client.on("connectionPoolCleared", (event) => {
    try {
      const error = event?.error || new Error("connection pool cleared");
      const poolClearedCount = noteMongoPoolCleared({ event });
      markAndLogMongoDegraded({
        error,
        reason: "CONNECTION_POOL_CLEARED",
        message: "[db] connection pool cleared",
        meta: {
          address: event?.address || null,
          interruptInUseConnections: !!event?.interruptInUseConnections,
          poolClearedCount,
        },
      });
    } catch {}
  });

  client.on("connectionPoolClosed", (event) => {
    try {
      noteMongoPoolClosed(event);
      markAndLogMongoDegraded({
        error: new Error("connection pool closed"),
        reason: "CONNECTION_POOL_CLOSED",
        message: "[db] connection pool closed",
        meta: { address: event?.address || null },
      });
    } catch {}
  });

  client.on("connectionCreated", (event) => {
    try {
      noteMongoConnectionCreated(event);
    } catch {}
  });

  client.on("connectionReady", (event) => {
    try {
      noteMongoConnectionReady(event);
    } catch {}
  });

  client.on("connectionClosed", (event) => {
    try {
      noteMongoConnectionClosed(event);
      const error =
        event?.error ||
        (String(event?.reason || "").trim()
          ? new Error(String(event.reason))
          : null);
      if (!isTransientMongoError(error)) return;
      markAndLogMongoDegraded({
        error,
        reason: "CONNECTION_CLOSED",
        message: "[db] connection closed during mongo degradation",
        meta: {
          address: event?.address || null,
          closeReason: event?.reason || null,
        },
      });
    } catch {}
  });

  client.on("connectionCheckOutStarted", (event) => {
    try {
      const pressure = noteMongoCheckoutStarted(event);
      if (!pressure?.pressureHigh) return;
      reportWindowedFault({
        windowKey: `db_pool_pressure_${String(event?.address || "unknown")}`,
        windowMs: 30_000,
        code: "DB_POOL_PRESSURE_HIGH",
        message: "[db] connection pool pressure high",
        meta: {
          address: event?.address || null,
          checkedOutTotal: Number(pressure?.checkedOutTotal || 0),
          pendingCheckouts: Number(pressure?.pendingCheckouts || 0),
        },
      });
    } catch {}
  });

  client.on("connectionCheckedOut", (event) => {
    try {
      const success = noteMongoCheckoutSuccess(event);
      if (!success?.recovered) return;
      logger.info(
        {
          address: event?.address || null,
          checkedOutTotal: Number(success?.checkedOutTotal || 0),
          lastCheckoutSuccessAt: success?.lastCheckoutSuccessAt || null,
        },
        "[db] connection pool recovered",
      );
    } catch {}
  });

  client.on("connectionCheckedIn", (event) => {
    try {
      noteMongoCheckoutCheckedIn(event);
    } catch {}
  });

  client.on("connectionCheckOutFailed", (event) => {
    try {
      const error = toCheckoutError(event);
      const metrics = noteMongoCheckoutFailed({
        event,
        error,
        reason: event?.reason || null,
      });
      const reason = metrics?.checkoutTimeout
        ? "CHECKOUT_TIMEOUT"
        : "CHECKOUT_FAILED";

      markAndLogMongoDegraded({
        error,
        reason,
        message: "[db] connection checkout failed",
        meta: {
          address: event?.address || null,
          checkoutFailureCount: Number(metrics?.checkoutFailureCount || 0),
          checkoutTimeoutCount: Number(metrics?.checkoutTimeoutCount || 0),
          checkoutFailureStreak: Number(metrics?.checkoutFailureStreak || 0),
        },
      });
    } catch {}
  });
}

async function connectMongo() {
  if (db) return { client, db };
  if (connectPromise) return connectPromise;

  applySrvDnsWorkaround();

  const options = mongoClientOptions();
  logMongoClientOptions(options);
  if (!client) {
    client = new MongoClient(env.MONGO_URI, options);
  }
  attachMongoListeners();

  connectPromise = (async () => {
    try {
      await client.connect();
      db = client.db(env.MONGO_DB);
      configureRuntimeLogDb(db);
      markMongoConnected();
      return { client, db };
    } catch (error) {
      if (isTransientMongoError(error)) {
        markAndLogMongoDegraded({
          error,
          reason: "CONNECT_FAILED",
          message: "[db] mongo connect failed",
        });
      }
      throw error;
    } finally {
      if (!db) connectPromise = null;
    }
  })();

  return connectPromise;
}

function getDb() {
  if (!db) throw new Error("Mongo not connected yet");
  return db;
}

function getMongoRuntimeStateSnapshot() {
  return getMongoRuntimeState();
}

function getMongoHealthSnapshotWrapper() {
  return getMongoHealthSnapshot();
}

module.exports = {
  connectMongo,
  getDb,
  getMongoRuntimeState: getMongoRuntimeStateSnapshot,
  getMongoHealthSnapshot: getMongoHealthSnapshotWrapper,
};
