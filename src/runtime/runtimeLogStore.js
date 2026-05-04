const os = require("os");
const util = require("util");
const { DateTime } = require("luxon");

const DEFAULT_COLLECTION = "run_time_logs";
const LEVEL_NUMBERS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const SECRET_KEY_PATTERN =
  /(access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|api[_-]?key|cookie|session|bearer)/i;

let db = null;
let pending = [];
let droppedCount = 0;
let flushTimer = null;
let flushing = false;
let indexesEnsured = false;
let indexesPromise = null;
let lastInternalWarnAt = 0;
let dailyPurgeTimer = null;
let dailyPurgeRunning = false;
let lastDailyPurgeKey = null;

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  const n = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}

function isEnabled() {
  return boolEnv("RUNTIME_LOGS_DB_ENABLED", true);
}

function collectionName() {
  return (
    String(process.env.RUNTIME_LOGS_COLLECTION || DEFAULT_COLLECTION).trim() ||
    DEFAULT_COLLECTION
  );
}

function bufferMax() {
  return intEnv("RUNTIME_LOGS_BUFFER_MAX", 5000, 100, 100000);
}

function batchSize() {
  return intEnv("RUNTIME_LOGS_BATCH_SIZE", 100, 1, 1000);
}

function flushIntervalMs() {
  return intEnv("RUNTIME_LOGS_FLUSH_INTERVAL_MS", 1000, 50, 60000);
}

function maxFieldChars() {
  return intEnv("RUNTIME_LOGS_MAX_FIELD_CHARS", 8000, 1000, 200000);
}

function dailyPurgeEnabled() {
  return boolEnv("RUNTIME_LOGS_DAILY_PURGE_ENABLED", true);
}

function dailyPurgeTime() {
  const raw =
    String(process.env.RUNTIME_LOGS_DAILY_PURGE_HHMM || "09:00").trim() ||
    "09:00";
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    internalWarn(
      new Error(`invalid purge time: ${raw}`),
      "[runtime-logs] invalid daily purge time, using 09:00",
    );
    return { hhmm: "09:00", hour: 9, minute: 0 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    internalWarn(
      new Error(`invalid purge time: ${raw}`),
      "[runtime-logs] invalid daily purge time, using 09:00",
    );
    return { hhmm: "09:00", hour: 9, minute: 0 };
  }

  return {
    hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    hour,
    minute,
  };
}

function dailyPurgeTimezone(now = DateTime.now()) {
  const requested =
    String(
      process.env.RUNTIME_LOGS_DAILY_PURGE_TZ ||
        process.env.CANDLE_TZ ||
        process.env.TZ ||
        process.env.LOG_TZ ||
        "Asia/Kolkata",
    ).trim() || "Asia/Kolkata";

  let zonedNow = now.setZone(requested);
  if (zonedNow.isValid) {
    return { timezone: requested, now: zonedNow };
  }

  internalWarn(
    new Error(`invalid purge timezone: ${requested}`),
    "[runtime-logs] invalid daily purge timezone, using Asia/Kolkata",
  );
  zonedNow = now.setZone("Asia/Kolkata");
  return { timezone: "Asia/Kolkata", now: zonedNow };
}

function internalWarn(err, message = "[runtime-logs] persistence warning") {
  const now = Date.now();
  if (now - lastInternalWarnAt < 30000) return;
  lastInternalWarnAt = now;
  // Do not use the app logger here; that would recurse back into this sink.
  // eslint-disable-next-line no-console
  console.warn(message, err?.message || String(err || ""));
}

function emitMaintenanceStatus(level, message, context = null) {
  try {
    recordRuntimeLog(level, [context || {}, message]);
  } catch (err) {
    internalWarn(err, "[runtime-logs] failed to capture maintenance log");
  }

  const consoleLevel =
    level === "error" || level === "fatal"
      ? "error"
      : level === "warn"
        ? "warn"
        : "info";
  try {
    // eslint-disable-next-line no-console
    console[consoleLevel](message, context || {});
  } catch {
    // eslint-disable-next-line no-console
    console[consoleLevel](message);
  }
}

function truncateString(value) {
  const str = String(value);
  const max = maxFieldChars();
  if (str.length <= max) return str;
  return `${str.slice(0, max)}... [truncated ${str.length - max} chars]`;
}

function serializeError(err, depth, seen) {
  const out = {
    name: truncateString(err?.name || "Error"),
    message: truncateString(err?.message || String(err || "")),
  };

  if (err?.stack) out.stack = truncateString(err.stack);
  if (err?.code != null) out.code = normalizeValue(err.code, depth + 1, seen);
  if (err?.cause != null) out.cause = normalizeValue(err.cause, depth + 1, seen);

  for (const key of Object.keys(err || {})) {
    if (out[key] != null) continue;
    out[key] = SECRET_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : normalizeValue(err[key], depth + 1, seen);
  }

  return out;
}

function normalizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    return `[Function${value.name ? `: ${value.name}` : ""}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return serializeError(value, depth, seen);
  }
  if (Buffer.isBuffer(value)) return { type: "Buffer", length: value.length };

  if (depth >= 6) return Array.isArray(value) ? "[Array]" : "[Object]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (
    value &&
    typeof value.toHexString === "function" &&
    typeof value._bsontype === "string"
  ) {
    return truncateString(value.toHexString());
  }

  if (Array.isArray(value)) {
    const maxItems = 100;
    const arr = value
      .slice(0, maxItems)
      .map((item) => normalizeValue(item, depth + 1, seen));
    if (value.length > maxItems) {
      arr.push(`[truncated ${value.length - maxItems} items]`);
    }
    return arr;
  }

  const out = {};
  const keys = Object.keys(value).slice(0, 150);
  for (const key of keys) {
    try {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : normalizeValue(value[key], depth + 1, seen);
    } catch (err) {
      out[key] = `[Unserializable: ${err?.message || String(err)}]`;
    }
  }
  if (Object.keys(value).length > keys.length) {
    out.__truncatedKeys = Object.keys(value).length - keys.length;
  }
  return out;
}

function valueToMessagePart(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(normalizeValue(value));
  } catch {
    return String(value);
  }
}

function formatMessage(args) {
  if (!args.length) return null;
  try {
    if (typeof args[0] === "string") {
      return truncateString(util.format(args[0], ...args.slice(1)));
    }
    return truncateString(args.map(valueToMessagePart).join(" "));
  } catch (err) {
    return truncateString(
      args.map((arg) => valueToMessagePart(arg)).join(" "),
    );
  }
}

function buildRuntimeLogDoc(level, argsLike) {
  const args = Array.from(argsLike || []);
  const createdAt = new Date();
  const first = args[0];
  let context = null;
  let err = null;
  let message = null;
  let messageTemplate = null;
  let extraArgs = [];

  if (first instanceof Error) {
    err = normalizeValue(first);
    messageTemplate = typeof args[1] === "string" ? args[1] : null;
    message = args.length > 1 ? formatMessage(args.slice(1)) : err.message;
    extraArgs = args.slice(2).map((arg) => normalizeValue(arg));
  } else if (
    first &&
    typeof first === "object" &&
    !Array.isArray(first) &&
    !(first instanceof Date)
  ) {
    context = normalizeValue(first);
    if (first.err instanceof Error || first.error instanceof Error) {
      err = normalizeValue(first.err || first.error);
    }
    if (typeof args[1] === "string") {
      messageTemplate = args[1];
      message = formatMessage(args.slice(1));
      extraArgs = args.slice(2).map((arg) => normalizeValue(arg));
    } else if (args.length > 1) {
      message = formatMessage(args.slice(1));
      extraArgs = args.slice(1).map((arg) => normalizeValue(arg));
    } else if (typeof first.msg === "string") {
      message = truncateString(first.msg);
    }
  } else {
    messageTemplate = typeof first === "string" ? first : null;
    message = formatMessage(args);
    extraArgs = args.slice(1).map((arg) => normalizeValue(arg));
  }

  return {
    createdAt,
    ts: createdAt.toISOString(),
    level: String(level || "info"),
    levelNumber: LEVEL_NUMBERS[level] || null,
    message,
    messageTemplate,
    context,
    err,
    extraArgs,
    pid: process.pid,
    hostname: os.hostname(),
    source: "pino",
    service: process.env.MONGO_APP_NAME || "kite-scalper-engine",
  };
}

function buildDroppedLogDoc(count) {
  const createdAt = new Date();
  return {
    createdAt,
    ts: createdAt.toISOString(),
    level: "warn",
    levelNumber: LEVEL_NUMBERS.warn,
    message: "[runtime-logs] buffered logs dropped before DB persistence",
    context: { droppedCount: count, bufferMax: bufferMax() },
    err: null,
    extraArgs: [],
    pid: process.pid,
    hostname: os.hostname(),
    source: "runtime-log-store",
    service: process.env.MONGO_APP_NAME || "kite-scalper-engine",
  };
}

function resolveDailyPurgeSchedule(now = DateTime.now()) {
  const { timezone, now: zonedNow } = dailyPurgeTimezone(now);
  const { hhmm, hour, minute } = dailyPurgeTime();
  const dayStart = zonedNow.startOf("day");
  const scheduledToday = dayStart.set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  const nextRun =
    zonedNow < scheduledToday ? scheduledToday : scheduledToday.plus({ days: 1 });

  return {
    timezone,
    hhmm,
    hour,
    minute,
    now: zonedNow,
    dayStart,
    scheduledToday,
    nextRun,
  };
}

function clearDailyPurgeTimer() {
  if (dailyPurgeTimer) clearTimeout(dailyPurgeTimer);
  dailyPurgeTimer = null;
}

function dropPendingRuntimeLogsBefore(cutoff) {
  const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Number.NaN;
  if (!Number.isFinite(cutoffMs) || pending.length === 0) return 0;

  let removed = 0;
  pending = pending.filter((doc) => {
    const createdAtMs =
      doc?.createdAt instanceof Date ? doc.createdAt.getTime() : Number.NaN;
    if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
      removed += 1;
      return false;
    }
    return true;
  });

  return removed;
}

async function waitForFlushIdle(timeoutMs = 5000) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (flushing && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !flushing;
}

async function purgeRuntimeLogsBeforeToday({
  now = DateTime.now(),
  trigger = "scheduled",
  scheduledFor = null,
} = {}) {
  const schedule = resolveDailyPurgeSchedule(now);
  const runKey = schedule.dayStart.toISODate();
  const cutoff = schedule.dayStart.toJSDate();

  if (!db || !isEnabled() || !dailyPurgeEnabled()) {
    return {
      ok: false,
      enabled: isEnabled(),
      connected: !!db,
      skipped: true,
      trigger,
      runKey,
    };
  }

  if (dailyPurgeRunning) {
    return {
      ok: false,
      enabled: true,
      connected: true,
      skipped: true,
      reason: "already_running",
      trigger,
      runKey,
    };
  }

  dailyPurgeRunning = true;
  let bufferedDeletedCount = 0;
  try {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await waitForFlushIdle();
    bufferedDeletedCount = dropPendingRuntimeLogsBefore(cutoff);
    const result = await db.collection(collectionName()).deleteMany({
      createdAt: { $lt: cutoff },
    });
    lastDailyPurgeKey = runKey;

    emitMaintenanceStatus("info", "[runtime-logs] daily purge completed", {
      collection: collectionName(),
      deletedCount: Number(result?.deletedCount || 0),
      bufferedDeletedCount,
      cutoff: schedule.dayStart.toISO(),
      timezone: schedule.timezone,
      purgeTime: schedule.hhmm,
      trigger,
      scheduledFor,
      runKey,
    });

    return {
      ok: true,
      deletedCount: Number(result?.deletedCount || 0),
      bufferedDeletedCount,
      cutoff: schedule.dayStart.toISO(),
      trigger,
      runKey,
    };
  } catch (err) {
    emitMaintenanceStatus("error", "[runtime-logs] daily purge failed", {
      collection: collectionName(),
      error: err?.message || String(err),
      bufferedDeletedCount,
      cutoff: schedule.dayStart.toISO(),
      timezone: schedule.timezone,
      purgeTime: schedule.hhmm,
      trigger,
      scheduledFor,
      runKey,
    });
    return {
      ok: false,
      error: err?.message || String(err),
      bufferedDeletedCount,
      cutoff: schedule.dayStart.toISO(),
      trigger,
      runKey,
    };
  } finally {
    dailyPurgeRunning = false;
  }
}

function armDailyPurgeTimer(delayMs, trigger, scheduledFor) {
  clearDailyPurgeTimer();
  dailyPurgeTimer = setTimeout(() => {
    dailyPurgeTimer = null;
    purgeRuntimeLogsBeforeToday({
      trigger,
      scheduledFor,
    })
      .catch((err) =>
        emitMaintenanceStatus(
          "error",
          "[runtime-logs] daily purge task crashed",
          {
            error: err?.message || String(err),
            trigger,
            scheduledFor,
          },
        ),
      )
      .finally(() => {
        scheduleRuntimeLogDailyPurge({ allowCatchUp: false });
      });
  }, Math.max(0, Math.floor(delayMs)));
  if (typeof dailyPurgeTimer.unref === "function") dailyPurgeTimer.unref();

  return {
    ok: true,
    scheduledFor,
    delayMs: Math.max(0, Math.floor(delayMs)),
    trigger,
  };
}

function scheduleRuntimeLogDailyPurge({
  now = DateTime.now(),
  allowCatchUp = true,
} = {}) {
  if (!db || !isEnabled() || !dailyPurgeEnabled()) {
    clearDailyPurgeTimer();
    return {
      ok: false,
      enabled: isEnabled(),
      connected: !!db,
      scheduled: false,
    };
  }

  const schedule = resolveDailyPurgeSchedule(now);
  const runKey = schedule.dayStart.toISODate();
  const shouldCatchUp =
    allowCatchUp &&
    schedule.now >= schedule.scheduledToday &&
    lastDailyPurgeKey !== runKey;

  if (shouldCatchUp) {
    return armDailyPurgeTimer(0, "startup_catchup", schedule.scheduledToday.toISO());
  }

  const delayMs = Math.max(
    0,
    Math.round(schedule.nextRun.diff(schedule.now).as("milliseconds")),
  );
  return armDailyPurgeTimer(delayMs, "scheduled", schedule.nextRun.toISO());
}

function stopRuntimeLogDailyPurgeSchedule() {
  clearDailyPurgeTimer();
  return { ok: true };
}

function trimPendingToBufferLimit() {
  const max = bufferMax();
  if (pending.length <= max) return;
  const remove = pending.length - max;
  pending.splice(0, remove);
  droppedCount += remove;
}

function scheduleFlush(delayMs = flushIntervalMs()) {
  if (!db || !isEnabled() || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushRuntimeLogs().catch((err) => internalWarn(err));
  }, Math.max(0, delayMs));
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function recordRuntimeLog(level, argsLike) {
  if (!isEnabled()) return false;

  try {
    const max = bufferMax();
    if (pending.length >= max) {
      pending.shift();
      droppedCount += 1;
    }
    pending.push(buildRuntimeLogDoc(level, argsLike));
    scheduleFlush(pending.length >= batchSize() ? 0 : flushIntervalMs());
    return true;
  } catch (err) {
    internalWarn(err, "[runtime-logs] failed to capture log");
    return false;
  }
}

async function ensureRuntimeLogIndexes() {
  if (!db || !isEnabled()) return { ok: false, enabled: false };
  if (indexesEnsured) return { ok: true, collection: collectionName() };
  if (indexesPromise) return indexesPromise;

  indexesPromise = (async () => {
    const col = db.collection(collectionName());
    await col.createIndex({ createdAt: -1 });
    await col.createIndex({ level: 1, createdAt: -1 });
    await col.createIndex(
      { "context.tradeId": 1, createdAt: -1 },
      { sparse: true },
    );

    if (boolEnv("RUNTIME_LOGS_TTL_ENABLED", false)) {
      const ttlDays = intEnv("RUNTIME_LOGS_TTL_DAYS", 14, 1, 3650);
      await col.createIndex(
        { createdAt: 1 },
        {
          name: "runtime_logs_createdAt_ttl",
          expireAfterSeconds: ttlDays * 24 * 60 * 60,
        },
      );
    }

    indexesEnsured = true;
    return { ok: true, collection: collectionName() };
  })();

  try {
    return await indexesPromise;
  } finally {
    indexesPromise = null;
  }
}

async function flushRuntimeLogs(opts = {}) {
  const drain = !!opts.drain;
  if (!db || !isEnabled() || flushing) {
    return {
      ok: false,
      enabled: isEnabled(),
      connected: !!db,
      pending: pending.length,
    };
  }

  flushing = true;
  let inserted = 0;

  try {
    do {
      const batch = [];
      if (droppedCount > 0) {
        batch.push(buildDroppedLogDoc(droppedCount));
        droppedCount = 0;
      }

      const room = Math.max(0, batchSize() - batch.length);
      batch.push(...pending.splice(0, room));
      if (!batch.length) break;

      try {
        await db.collection(collectionName()).insertMany(batch, {
          ordered: false,
        });
        inserted += batch.length;
      } catch (err) {
        pending.unshift(...batch);
        trimPendingToBufferLimit();
        internalWarn(err, "[runtime-logs] failed to persist logs");
        return {
          ok: false,
          error: err?.message || String(err),
          inserted,
          pending: pending.length,
        };
      }
    } while (drain && pending.length > 0);

    return { ok: true, inserted, pending: pending.length };
  } finally {
    flushing = false;
    if (pending.length > 0) scheduleFlush();
  }
}

function configureRuntimeLogDb(nextDb) {
  if (!isEnabled()) {
    stopRuntimeLogDailyPurgeSchedule();
    return { ok: true, enabled: false };
  }
  db = nextDb || null;
  if (!db) {
    stopRuntimeLogDailyPurgeSchedule();
    return { ok: false, enabled: true };
  }

  ensureRuntimeLogIndexes().catch((err) =>
    internalWarn(err, "[runtime-logs] failed to ensure indexes"),
  );
  scheduleFlush(0);
  scheduleRuntimeLogDailyPurge();
  return { ok: true, enabled: true, collection: collectionName() };
}

function resetRuntimeLogStoreForTests() {
  if (flushTimer) clearTimeout(flushTimer);
  if (dailyPurgeTimer) clearTimeout(dailyPurgeTimer);
  db = null;
  pending = [];
  droppedCount = 0;
  flushTimer = null;
  flushing = false;
  indexesEnsured = false;
  indexesPromise = null;
  lastInternalWarnAt = 0;
  dailyPurgeTimer = null;
  dailyPurgeRunning = false;
  lastDailyPurgeKey = null;
}

module.exports = {
  DEFAULT_COLLECTION,
  configureRuntimeLogDb,
  ensureRuntimeLogIndexes,
  flushRuntimeLogs,
  recordRuntimeLog,
  scheduleRuntimeLogDailyPurge,
  stopRuntimeLogDailyPurgeSchedule,
  __test: {
    buildRuntimeLogDoc,
    purgeRuntimeLogsBeforeToday,
    resolveDailyPurgeSchedule,
    resetRuntimeLogStoreForTests,
  },
};
