const { env } = require("../config");
const { insertManyCandles } = require("./candleStore");
const { logger } = require("../logger");
const { reportFault, reportWindowedFault } = require("../runtime/errorBus");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");
const {
  evaluateMongoWorkGate,
  deferMongoWorkForError,
  logRecoveryIfAny,
} = require("../runtime/mongoWorkGate");
const {
  getMongoRuntimeState,
  noteMongoSubsystemBacklog,
  updateMongoSubsystemHealth,
} = require("../runtime/mongoRuntimeState");

function _bool(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true";
}

function _num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const sharedHealth = {
  enabled: false,
  candleWriterBacklog: 0,
  oldestQueuedAgeMs: 0,
  oldestQueuedAt: null,
  lastFlushOkAt: null,
  lastFlushFailedAt: null,
  droppedCount: 0,
  compactedCount: 0,
  overflowRejectedCount: 0,
  flushDeferredCount: 0,
  warningCode: null,
  readinessBlocked: false,
  readinessReasons: [],
  maxBacklog: 0,
  warnBacklog: 0,
  criticalBacklog: 0,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resetCandleWriterHealthForTests() {
  Object.assign(sharedHealth, {
    enabled: false,
    candleWriterBacklog: 0,
    oldestQueuedAgeMs: 0,
    oldestQueuedAt: null,
    lastFlushOkAt: null,
    lastFlushFailedAt: null,
    droppedCount: 0,
    compactedCount: 0,
    overflowRejectedCount: 0,
    flushDeferredCount: 0,
    warningCode: null,
    readinessBlocked: false,
    readinessReasons: [],
    maxBacklog: 0,
    warnBacklog: 0,
    criticalBacklog: 0,
  });
}

function getCandleWriterHealth() {
  return clone(sharedHealth);
}

class CandleWriteBuffer {
  constructor() {
    this.enabled = _bool(env.CANDLE_WRITE_BUFFER_ENABLED, true);
    this.flushMs = _num(env.CANDLE_WRITE_FLUSH_MS, 1500);
    this.maxBatch = _num(
      env.CANDLE_WRITER_FLUSH_BATCH_SIZE,
      _num(env.CANDLE_WRITE_MAX_BATCH, 500),
    );
    this.maxBacklog = _num(
      env.CANDLE_WRITER_MAX_BACKLOG,
      _num(env.CANDLE_WRITE_MAX_BUFFER, 15_000),
    );
    this.warnBacklog = _num(env.CANDLE_WRITER_WARN_BACKLOG, 500);
    this.criticalBacklog = _num(env.CANDLE_WRITER_CRITICAL_BACKLOG, 2_000);
    this.flushConcurrency = Math.max(
      1,
      _num(env.CANDLE_WRITER_FLUSH_CONCURRENCY, 1),
    );

    this._timer = null;
    this._serial = Promise.resolve();
    this._buf = new Map();
    this.totalBuffered = 0;
    this.dropped = 0;
    this.compacted = 0;
    this.overflowRejected = 0;
    this.flushDeferredCount = 0;
    this._nextFlushAt = 0;
    this._lastWarnLogAt = 0;
    this._lastCriticalLogAt = 0;
    this._backlogMaxed = false;
    this._lastFlushOkAt = null;
    this._lastFlushFailedAt = null;

    this._syncHealth();
  }

  _entryKey(candle) {
    return [
      Number(candle?.instrument_token) || 0,
      Number(candle?.interval_min) || 0,
      candle?.ts ? new Date(candle.ts).toISOString() : "invalid_ts",
    ].join("|");
  }

  _oldestQueuedEntry() {
    let oldest = null;
    for (const arr of this._buf.values()) {
      if (!Array.isArray(arr) || !arr.length) continue;
      for (const entry of arr) {
        if (!entry?.queuedAtMs) continue;
        if (!oldest || entry.queuedAtMs < oldest.queuedAtMs) {
          oldest = entry;
        }
      }
    }
    return oldest;
  }

  _oldestQueuedAgeMs() {
    const oldest = this._oldestQueuedEntry();
    if (!oldest?.queuedAtMs) return 0;
    return Math.max(0, Date.now() - oldest.queuedAtMs);
  }

  _readinessReasons() {
    const reasons = [];
    if (this.totalBuffered >= this.criticalBacklog) {
      reasons.push("CANDLE_PERSISTENCE_BACKLOG_HIGH");
    }
    if (this._backlogMaxed || this.totalBuffered >= this.maxBacklog) {
      reasons.push("CANDLE_WRITER_BACKLOG_MAXED");
    }
    return reasons;
  }

  _warningCode() {
    if (this._backlogMaxed || this.totalBuffered >= this.maxBacklog) {
      return "CANDLE_WRITER_BACKLOG_MAXED";
    }
    if (this.totalBuffered >= this.criticalBacklog) {
      return "CANDLE_PERSISTENCE_BACKLOG_HIGH";
    }
    if (this.totalBuffered >= this.warnBacklog) {
      return "CANDLE_PERSISTENCE_BACKLOG_WARN";
    }
    return null;
  }

  _syncHealth() {
    const oldest = this._oldestQueuedEntry();
    Object.assign(sharedHealth, {
      enabled: this.enabled,
      candleWriterBacklog: Math.max(0, Number(this.totalBuffered || 0)),
      oldestQueuedAgeMs: this._oldestQueuedAgeMs(),
      oldestQueuedAt: oldest?.queuedAt || null,
      lastFlushOkAt: this._lastFlushOkAt,
      lastFlushFailedAt: this._lastFlushFailedAt,
      droppedCount: Math.max(0, Number(this.dropped || 0)),
      compactedCount: Math.max(0, Number(this.compacted || 0)),
      overflowRejectedCount: Math.max(0, Number(this.overflowRejected || 0)),
      flushDeferredCount: Math.max(0, Number(this.flushDeferredCount || 0)),
      warningCode: this._warningCode(),
      readinessBlocked:
        this._backlogMaxed || this.totalBuffered >= this.maxBacklog,
      readinessReasons: this._readinessReasons(),
      maxBacklog: this.maxBacklog,
      warnBacklog: this.warnBacklog,
      criticalBacklog: this.criticalBacklog,
    });

    noteMongoSubsystemBacklog({
      subsystem: "candle_writer",
      priority: "important",
      backlog: this.totalBuffered,
      dropped: this.dropped,
      compacted: this.compacted,
      oldestQueuedAt: oldest?.queuedAt || null,
      health: {
        backlog: this.totalBuffered,
        droppedCount: this.dropped,
        compactedCount: this.compacted,
        oldestQueuedAt: oldest?.queuedAt || null,
        lastFlushOkAt: this._lastFlushOkAt,
        lastFlushFailedAt: this._lastFlushFailedAt,
        flushDeferredCount: this.flushDeferredCount,
        warningCode: sharedHealth.warningCode,
        readinessBlocked: sharedHealth.readinessBlocked,
        readinessReasons: sharedHealth.readinessReasons,
        warnBacklog: this.warnBacklog,
        criticalBacklog: this.criticalBacklog,
        maxBacklog: this.maxBacklog,
      },
    });
    updateMongoSubsystemHealth({
      subsystem: "candle_writer",
      priority: "important",
      health: sharedHealth,
    });
  }

  start() {
    if (!this.enabled) return;
    if (this._timer) return;
    const ms = Math.max(250, this.flushMs);
    this._timer = setInterval(() => {
      this.flush().catch((err) => {
        reportFault({
          code: "MARKET_CANDLEWRITEBUFFER_ASYNC",
          err,
          message: "[src/market/candleWriteBuffer.js] async task failed",
        });
      });
    }, ms);
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    await this.flush({ force: true }).catch((err) => {
      reportFault({
        code: "MARKET_CANDLEWRITEBUFFER_ASYNC",
        err,
        message: "[src/market/candleWriteBuffer.js] async task failed",
      });
    });
  }

  _dropOldestSafeDuplicate() {
    const seen = new Map();
    for (const [intervalMin, arr] of this._buf.entries()) {
      if (!Array.isArray(arr) || !arr.length) continue;
      for (let index = 0; index < arr.length; index += 1) {
        const entry = arr[index];
        if (!entry?.key) continue;
        if (seen.has(entry.key)) {
          const first = seen.get(entry.key);
          const firstArr = this._buf.get(first.intervalMin);
          if (!Array.isArray(firstArr) || first.index >= firstArr.length) {
            continue;
          }
          firstArr.splice(first.index, 1);
          this.totalBuffered = Math.max(0, this.totalBuffered - 1);
          this.dropped += 1;
          this.compacted += 1;
          if (!firstArr.length) this._buf.delete(first.intervalMin);
          return true;
        }
        seen.set(entry.key, { intervalMin, index });
      }
    }
    return false;
  }

  _logBacklogWarnings() {
    const now = Date.now();
    if (this.totalBuffered >= this.criticalBacklog) {
      if (now - this._lastCriticalLogAt >= 30_000) {
        this._lastCriticalLogAt = now;
        reportWindowedFault({
          windowKey: "candle_writer_backlog_critical",
          windowMs: 30_000,
          code: "CANDLE_PERSISTENCE_BACKLOG_HIGH",
          message: "[candle-writer] backlog critical",
          meta: {
            backlog: this.totalBuffered,
            criticalBacklog: this.criticalBacklog,
            maxBacklog: this.maxBacklog,
          },
        });
      }
      return;
    }
    if (this.totalBuffered >= this.warnBacklog) {
      if (now - this._lastWarnLogAt >= 30_000) {
        this._lastWarnLogAt = now;
        reportWindowedFault({
          windowKey: "candle_writer_backlog_warn",
          windowMs: 30_000,
          code: "CANDLE_PERSISTENCE_BACKLOG_WARN",
          message: "[candle-writer] backlog warning",
          meta: {
            backlog: this.totalBuffered,
            warnBacklog: this.warnBacklog,
          },
        });
      }
    }
  }

  enqueue(candle) {
    if (!this.enabled) return { ok: false, skipped: true, reason: "disabled" };
    if (!candle || !candle.interval_min) {
      return { ok: false, skipped: true, reason: "invalid_candle" };
    }

    const intervalMin = Number(candle.interval_min);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) {
      return { ok: false, skipped: true, reason: "invalid_interval" };
    }

    const arr = this._buf.get(intervalMin) || [];
    const key = this._entryKey(candle);
    const existingIndex = arr.findIndex((entry) => entry?.key === key);
    if (existingIndex >= 0) {
      arr[existingIndex] = {
        ...arr[existingIndex],
        candle,
      };
      this._buf.set(intervalMin, arr);
      this.compacted += 1;
      this._syncHealth();
      return { ok: true, deduped: true };
    }

    if (Number.isFinite(this.maxBacklog) && this.maxBacklog > 0) {
      if (this.totalBuffered >= this.maxBacklog) {
        if (!this._dropOldestSafeDuplicate()) {
          this.overflowRejected += 1;
          this._backlogMaxed = true;
          this._syncHealth();
          reportWindowedFault({
            windowKey: "candle_writer_backlog_maxed",
            windowMs: 30_000,
            code: "CANDLE_WRITER_BACKLOG_MAXED",
            message: "[candle-writer] backlog maxed; unique candle persistence blocked",
            meta: {
              backlog: this.totalBuffered,
              maxBacklog: this.maxBacklog,
              overflowRejectedCount: this.overflowRejected,
            },
          });
          return { ok: false, blocked: true, reason: "CANDLE_WRITER_BACKLOG_MAXED" };
        }
      }
    }

    arr.push({
      key,
      candle,
      queuedAtMs: Date.now(),
      queuedAt: new Date().toISOString(),
    });
    this._buf.set(intervalMin, arr);
    this.totalBuffered += 1;
    this._backlogMaxed = this.totalBuffered >= this.maxBacklog;
    this._logBacklogWarnings();
    this._syncHealth();
    return { ok: true, queued: true };
  }

  stats() {
    this._syncHealth();
    return {
      enabled: this.enabled,
      flushMs: this.flushMs,
      maxBatch: this.maxBatch,
      maxBacklog: this.maxBacklog,
      warnBacklog: this.warnBacklog,
      criticalBacklog: this.criticalBacklog,
      buckets: this._buf.size,
      totalBuffered: this.totalBuffered,
      dropped: this.dropped,
      compacted: this.compacted,
      overflowRejected: this.overflowRejected,
      nextFlushAt:
        this._nextFlushAt > 0 ? new Date(this._nextFlushAt).toISOString() : null,
      health: getCandleWriterHealth(),
    };
  }

  _deferMongoFlush(error, release, intervalMin) {
    this.flushDeferredCount += 1;
    this._lastFlushFailedAt = new Date().toISOString();
    const deferred = deferMongoWorkForError({
      subsystem: "candle_writer",
      priority: "important",
      error,
      reason: "candle_write_buffer_flush",
      backlog: this.totalBuffered,
      dropped: this.dropped,
      compacted: this.compacted,
      oldestQueuedAt: this._oldestQueuedEntry()?.queuedAt || null,
      phase: "flush",
      windowKey: "candle_writer_mongo_degraded",
      code: "CANDLE_WRITER_MONGO_DEGRADED",
      message: "[candle-writer] mongo degraded; flush deferred",
      release,
    });
    const backoffMs = Number(deferred?.backoffMs || 0);
    this._nextFlushAt = backoffMs > 0 ? Date.now() + backoffMs : 0;
    this._syncHealth();
    reportWindowedFault({
      windowKey: "candle_writer_flush_deferred",
      windowMs: 30_000,
      code: "CANDLE_WRITER_MONGO_DEGRADED",
      err: error,
      message: "[candle-writer] flush deferred by mongo coordinator",
      meta: {
        intervalMin,
        backlog: this.totalBuffered,
        backoffMs,
        severity: getMongoRuntimeState()?.severity || null,
      },
    });
    return deferred;
  }

  async flush({ force = false } = {}) {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    if (!this.totalBuffered) {
      this._syncHealth();
      return { ok: true, skipped: true, reason: "empty" };
    }
    if (!force && this._nextFlushAt && Date.now() < this._nextFlushAt) {
      return {
        ok: false,
        deferred: true,
        reason: "backoff_active",
        deferredMs: Math.max(0, this._nextFlushAt - Date.now()),
      };
    }

    let release = null;
    if (!force) {
      const oldestQueuedAt = this._oldestQueuedEntry()?.queuedAt || null;
      const gate = evaluateMongoWorkGate({
        subsystem: "candle_writer",
        priority: "important",
        backlog: this.totalBuffered,
        dropped: this.dropped,
        compacted: this.compacted,
        oldestQueuedAt,
        phase: "flush",
        windowKey: "candle_writer_mongo_gate_deferred",
        code: "CANDLE_WRITER_MONGO_DEFERRED",
        message: "[candle-writer] flush deferred by mongo coordinator",
      });
      if (gate?.deferred) {
        const runtime = getMongoRuntimeState() || {};
        const severe =
          String(runtime.state || gate.status || "").toUpperCase() ===
          "SEVERELY_DEGRADED";
        const backlogUrgent = this.totalBuffered >= this.criticalBacklog;
        if (severe || !backlogUrgent) {
          this.flushDeferredCount += 1;
          this._nextFlushAt = Date.now() + Math.max(0, Number(gate.backoffMs) || 0);
          this._syncHealth();
          return gate;
        }
        const urgentGate = evaluateMongoWorkGate({
          subsystem: "candle_writer",
          priority: "critical",
          backlog: this.totalBuffered,
          dropped: this.dropped,
          compacted: this.compacted,
          oldestQueuedAt,
          phase: "flush",
          allowDuringSevere: false,
          windowKey: "candle_writer_mongo_gate_urgent",
          code: "CANDLE_WRITER_MONGO_URGENT",
          message: "[candle-writer] urgent flush allowed near critical backlog",
        });
        if (urgentGate?.deferred) {
          this.flushDeferredCount += 1;
          this._nextFlushAt =
            Date.now() + Math.max(0, Number(urgentGate.backoffMs) || 0);
          this._syncHealth();
          return urgentGate;
        }
        release = urgentGate.release || null;
      } else {
        release = gate.release || null;
      }
    }

    this._serial = this._serial.then(async () => {
      for (const [intervalMin, arr] of Array.from(this._buf.entries())) {
        if (!Array.isArray(arr) || !arr.length) {
          this._buf.delete(intervalMin);
          continue;
        }

        while (arr.length) {
          const batchEntries = arr.splice(0, Math.max(1, this.maxBatch));
          const batch = batchEntries.map((entry) => entry.candle);
          try {
            await insertManyCandles(intervalMin, batch);
            this.totalBuffered = Math.max(0, this.totalBuffered - batch.length);
            this._nextFlushAt = 0;
            this._backlogMaxed = false;
            this._lastFlushOkAt = new Date().toISOString();
            this._syncHealth();
          } catch (e) {
            arr.unshift(...batchEntries);
            this._lastFlushFailedAt = new Date().toISOString();
            this._syncHealth();
            if (isTransientMongoError(e)) {
              return this._deferMongoFlush(e, release, intervalMin);
            }
            if (typeof release === "function") {
              release();
              release = null;
            }
            reportWindowedFault({
              windowKey: "candle_writer_flush_failed",
              windowMs: 30_000,
              code: "CANDLE_WRITER_FLUSH_FAILED",
              err: e,
              message: "[candle-writer] bulkWrite failed; will retry",
              meta: { intervalMin, totalBuffered: this.totalBuffered },
            });
            return { ok: false, reason: "flush_failed", error: e?.message || String(e) };
          }
        }

        this._buf.delete(intervalMin);
      }

      this._syncHealth();
      logRecoveryIfAny({
        subsystem: "candle_writer",
        priority: "important",
        phase: "flush",
        release,
        backlog: this.totalBuffered,
        meta: { totalBuffered: this.totalBuffered },
      });
      release = null;
      return { ok: true, flushed: true };
    });

    return this._serial;
  }
}

module.exports = {
  CandleWriteBuffer,
  getCandleWriterHealth,
  resetCandleWriterHealthForTests,
};
