const { MongoClient } = require("mongodb");
const dns = require("dns");
const { env } = require("./config");
const { logger } = require("./logger");
const { reportWindowedFault } = require("./runtime/errorBus");
const { isTransientMongoError } = require("./runtime/isTransientMongoError");
const {
  getMongoRuntimeState,
  markMongoHealthy,
  markMongoDegraded,
  noteMongoPoolCleared,
  noteMongoCheckoutFailure,
} = require("./runtime/mongoRuntimeState");

let client;
let db;
let listenersAttached = false;

function mongoNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function mongoClientOptions() {
  return {
    appName: String(process.env.MONGO_APP_NAME || "kite-scalper-engine"),
    retryReads: true,
    retryWrites: true,
    maxPoolSize: mongoNum("MONGO_MAX_POOL_SIZE", 20),
    minPoolSize: mongoNum("MONGO_MIN_POOL_SIZE", 2),
    maxConnecting: mongoNum("MONGO_MAX_CONNECTING", 4),
    maxIdleTimeMS: mongoNum("MONGO_MAX_IDLE_MS", 60_000),
    waitQueueTimeoutMS: mongoNum("MONGO_WAIT_QUEUE_TIMEOUT_MS", 5_000),
    connectTimeoutMS: mongoNum("MONGO_CONNECT_TIMEOUT_MS", 10_000),
    serverSelectionTimeoutMS: mongoNum(
      "MONGO_SERVER_SELECTION_TIMEOUT_MS",
      10_000,
    ),
    socketTimeoutMS: mongoNum("MONGO_SOCKET_TIMEOUT_MS", 45_000),
  };
}

function applySrvDnsWorkaround() {
  // Workaround for Windows SRV DNS failures like:
  // querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
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

function markAndLogMongoDegraded({
  error,
  reason,
  message = "[db] degraded",
  meta,
} = {}) {
  const next = markMongoDegraded({ error, reason });
  const payload = {
    reason: reason || null,
    err: error?.message || String(error || ""),
    ...(meta || {}),
  };

  if (next.becameDegraded) {
    logger.warn(payload, message);
    return;
  }

  reportWindowedFault({
    windowKey: `db_degraded_${String(reason || "unknown")}`,
    windowMs: 30_000,
    code: "DB_DEGRADED",
    err: error,
    message,
    meta: payload,
  });
}

function markMongoConnected(meta = {}) {
  markMongoHealthy({ connect: true });
  logger.info({ db: env.MONGO_DB, ...(meta || {}) }, "[db] connected");
}

function markMongoRecovered(meta = {}) {
  const next = markMongoHealthy();
  if (!next.recovered) return;
  logger.info(meta || {}, "[db] recovered");
}

function attachMongoListeners() {
  if (!client || listenersAttached) return;
  listenersAttached = true;

  client.on("connectionPoolCreated", (event) => {
    logger.info(
      { address: event?.address || null },
      "[db] connection pool created",
    );
  });

  client.on("connectionPoolReady", (event) => {
    markMongoRecovered({ address: event?.address || null });
  });

  client.on("connectionPoolCleared", (event) => {
    const error =
      event?.error || new Error("connection pool cleared");
    const poolClearedCount = noteMongoPoolCleared();
    markAndLogMongoDegraded({
      error,
      reason: "connection_pool_cleared",
      message: "[db] connection pool cleared",
      meta: {
        address: event?.address || null,
        interruptInUseConnections: !!event?.interruptInUseConnections,
        poolClearedCount,
      },
    });
  });

  client.on("connectionPoolClosed", (event) => {
    markAndLogMongoDegraded({
      error: new Error("connection pool closed"),
      reason: "connection_pool_closed",
      meta: { address: event?.address || null },
    });
  });

  client.on("connectionCheckOutFailed", (event) => {
    const error =
      event?.reason instanceof Error
        ? event.reason
        : event?.error instanceof Error
          ? event.error
          : new Error(
              String(
                event?.reason || event?.error || "connection checkout failed",
              ),
            );
    const checkoutFailedCount = noteMongoCheckoutFailure();

    if (isTransientMongoError(error)) {
      markAndLogMongoDegraded({
        error,
        reason: "connection_checkout_failed",
        message: "[db] connection checkout failed",
        meta: {
          address: event?.address || null,
          checkoutFailedCount,
        },
      });
      return;
    }

    reportWindowedFault({
      windowKey: "db_checkout_failed",
      windowMs: 30_000,
      code: "DB_CHECKOUT_FAILED",
      err: error,
      message: "[db] connection checkout failed",
      meta: {
        address: event?.address || null,
        checkoutFailedCount,
      },
    });
  });

  client.on("connectionClosed", (event) => {
    const error =
      event?.error ||
      (String(event?.reason || "").trim()
        ? new Error(String(event.reason))
        : null);
    if (!isTransientMongoError(error)) return;
    markAndLogMongoDegraded({
      error,
      reason: "connection_closed",
      meta: {
        address: event?.address || null,
        closeReason: event?.reason || null,
      },
    });
  });
}

async function connectMongo() {
  if (db) return { client, db };

  applySrvDnsWorkaround();

  client = new MongoClient(env.MONGO_URI, mongoClientOptions());
  attachMongoListeners();

  try {
    await client.connect();
    db = client.db(env.MONGO_DB);
    markMongoConnected();
    return { client, db };
  } catch (error) {
    if (isTransientMongoError(error)) {
      markAndLogMongoDegraded({
        error,
        reason: "connect_failed",
      });
    }
    throw error;
  }
}

function getDb() {
  if (!db) throw new Error("Mongo not connected yet");
  return db;
}

function getMongoRuntimeStateSnapshot() {
  return getMongoRuntimeState();
}

module.exports = {
  connectMongo,
  getDb,
  getMongoRuntimeState: getMongoRuntimeStateSnapshot,
};
