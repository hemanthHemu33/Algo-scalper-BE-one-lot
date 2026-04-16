const { env } = require("../config");
const { insertManyCandles } = require("./candleStore");
const { logger } = require("../logger");
const { reportFault, reportWindowedFault } = require("../runtime/errorBus");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");
const {
  markMongoHealthy,
  markMongoDegraded,
} = require("../runtime/mongoRuntimeState");

function _bool(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true";
}

function _num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

class CandleWriteBuffer {
  constructor() {
    this.enabled = _bool(env.CANDLE_WRITE_BUFFER_ENABLED, true);
    this.flushMs = _num(env.CANDLE_WRITE_FLUSH_MS, 1500);
    this.maxBatch = _num(env.CANDLE_WRITE_MAX_BATCH, 500);
    this.maxBuffer = _num(env.CANDLE_WRITE_MAX_BUFFER, 15000);

    this._timer = null;
    this._serial = Promise.resolve();

    // intervalMin -> array<candle>
    this._buf = new Map();
    this.totalBuffered = 0;
    this.dropped = 0;
    this._lastDropLogAt = 0;
    this._mongoDegraded = false;
    this._mongoBackoffMs = 0;
    this._nextFlushAt = 0;
  }

  start() {
    if (!this.enabled) return;
    if (this._timer) return;
    const ms = Math.max(250, this.flushMs);
    this._timer = setInterval(() => {
      this.flush().catch((err) => { reportFault({ code: "MARKET_CANDLEWRITEBUFFER_ASYNC", err, message: "[src/market/candleWriteBuffer.js] async task failed" }); });
    }, ms);
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    await this.flush({ force: true }).catch((err) => { reportFault({ code: "MARKET_CANDLEWRITEBUFFER_ASYNC", err, message: "[src/market/candleWriteBuffer.js] async task failed" }); });
  }

  enqueue(candle) {
    if (!this.enabled) return;
    if (!candle || !candle.interval_min) return;

    // Backpressure: if buffer too big, drop new candles (avoid memory blow-up)
    if (Number.isFinite(this.maxBuffer) && this.maxBuffer > 0) {
      if (this.totalBuffered >= this.maxBuffer) {
        this.dropped += 1;
        const now = Date.now();
        if (now - this._lastDropLogAt > 5000) {
          this._lastDropLogAt = now;
          logger.warn(
            { dropped: this.dropped, totalBuffered: this.totalBuffered },
            "[candle-writer] buffer full; dropping candles",
          );
        }
        return;
      }
    }

    const intervalMin = Number(candle.interval_min);
    if (!Number.isFinite(intervalMin) || intervalMin <= 0) return;

    const arr = this._buf.get(intervalMin) || [];
    arr.push(candle);
    this._buf.set(intervalMin, arr);
    this.totalBuffered += 1;
  }

  stats() {
    return {
      enabled: this.enabled,
      flushMs: this.flushMs,
      maxBatch: this.maxBatch,
      maxBuffer: this.maxBuffer,
      buckets: this._buf.size,
      totalBuffered: this.totalBuffered,
      dropped: this.dropped,
    };
  }

  _nextMongoBackoffMs() {
    this._mongoBackoffMs = this._mongoBackoffMs
      ? Math.min(this._mongoBackoffMs * 2, 20_000)
      : 1_000;
    this._nextFlushAt = Date.now() + this._mongoBackoffMs;
    return this._mongoBackoffMs;
  }

  _markMongoRecovered() {
    if (!this._mongoDegraded) {
      this._mongoBackoffMs = 0;
      this._nextFlushAt = 0;
      return;
    }
    this._mongoDegraded = false;
    this._mongoBackoffMs = 0;
    this._nextFlushAt = 0;
    markMongoHealthy();
    logger.info("[candle-writer] mongo recovered; flush resumed");
  }

  _deferMongoFlush(error, intervalMin) {
    const backoffMs = this._nextMongoBackoffMs();
    this._mongoDegraded = true;
    markMongoDegraded({
      error,
      reason: "candle_write_buffer_flush",
    });
    reportWindowedFault({
      windowKey: "candle_writer_mongo_degraded",
      windowMs: 30_000,
      code: "CANDLE_WRITER_MONGO_DEGRADED",
      err: error,
      message: "[candle-writer] mongo degraded; flush deferred",
      meta: { intervalMin, backoffMs, totalBuffered: this.totalBuffered },
    });
  }

  async flush({ force = false } = {}) {
    if (!this.enabled) return;
    if (!this.totalBuffered) return;
    if (!force && this._nextFlushAt && Date.now() < this._nextFlushAt) return;

    // Serialize flushes (avoid overlapping bulkWrite)
    this._serial = this._serial.then(async () => {
      for (const [intervalMin, arr] of Array.from(this._buf.entries())) {
        if (!arr || !arr.length) {
          this._buf.delete(intervalMin);
          continue;
        }

        // Drain in batches
        while (arr.length) {
          const batch = arr.splice(0, Math.max(1, this.maxBatch));
          try {
            await insertManyCandles(intervalMin, batch);
            this.totalBuffered -= batch.length;
            this._markMongoRecovered();
          } catch (e) {
            // Put back and retry later
            arr.unshift(...batch);
            if (isTransientMongoError(e)) {
              this._deferMongoFlush(e, intervalMin);
              return;
            }
            reportWindowedFault({
              windowKey: "candle_writer_flush_failed",
              windowMs: 30_000,
              code: "CANDLE_WRITER_FLUSH_FAILED",
              err: e,
              message: "[candle-writer] bulkWrite failed; will retry",
              meta: { intervalMin, totalBuffered: this.totalBuffered },
            });
            return;
          }
        }

        this._buf.delete(intervalMin);
      }
    });

    await this._serial;
  }
}

module.exports = { CandleWriteBuffer };
