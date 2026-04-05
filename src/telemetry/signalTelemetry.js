const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { reportFault } = require("../runtime/errorBus");

/**
 * Pro-level observability for signal->trade pipeline.
 * Tracks:
 *  - every candidate signal (per strategy)
 *  - every decision outcome (BLOCKED/DRY_RUN/ENTRY_PLACED/...)
 *  - histogram of block reasons (stage|reason)
 *  - ring buffer of last decisions for quick debugging
 *
 * Persisted daily (dayKey in CANDLE_TZ) to Mongo.
 */

function tz() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function dayKey(now = new Date()) {
  try {
    return DateTime.fromJSDate(now, { zone: tz() }).toFormat("yyyy-LL-dd");
  } catch {
    // fallback
    const d = new Date(now);
    return d.toISOString().slice(0, 10);
  }
}

function safeKey(s, maxLen = 180) {
  const v = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return "UNKNOWN";
  return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
}

function inc(obj, key, n = 1) {
  if (!obj) return;
  const k = safeKey(key);
  obj[k] = (obj[k] || 0) + Number(n ?? 0);
}

function deepInc(root, pathArr, n = 1) {
  let cur = root;
  for (let i = 0; i < pathArr.length - 1; i += 1) {
    const k = safeKey(pathArr[i], 80);
    if (!cur[k]) cur[k] = {};
    cur = cur[k];
  }
  inc(cur, pathArr[pathArr.length - 1], n);
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || "").trim();
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function minutesOfDay(nowTs = Date.now()) {
  try {
    const dt = DateTime.fromMillis(Number(nowTs) || Date.now(), { zone: tz() });
    return dt.hour * 60 + dt.minute;
  } catch {
    const d = new Date(nowTs);
    return d.getHours() * 60 + d.getMinutes();
  }
}

function timeBucket(nowTs = Date.now()) {
  // Keep consistent with optimizer buckets
  const openEnd = hhmmToMinutes(env.OPT_BUCKET_OPEN_END || "10:00");
  const closeStart = hhmmToMinutes(env.OPT_BUCKET_CLOSE_START || "15:00");
  const m = minutesOfDay(nowTs);
  if (openEnd != null && m < openEnd) return "OPEN";
  if (closeStart != null && m >= closeStart) return "CLOSE";
  return "MID";
}

function topEntries(obj, topN = 20) {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj)
    .map(([k, v]) => ({ key: k, count: Number(v) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Number(topN) || 20));
}

class SignalTelemetry {
  constructor() {
    this._enabled = String(env.TELEMETRY_ENABLED || "true") === "true";
    this._rejEnabled =
      String(env.TELEMETRY_REJECTIONS_ENABLED || "true") === "true";
    this._rejTopKeys = Number(env.TELEMETRY_REJECTIONS_TOP_KEYS ?? 200);
    this._ringSize = Number(env.TELEMETRY_RING_SIZE ?? 300);
    this._flushSec = Number(env.TELEMETRY_FLUSH_SEC ?? 60);
    this._dailyCollection =
      env.TELEMETRY_DB_DAILY_COLLECTION || "telemetry_signals_daily";

    this._state = this._freshState(dayKey());
    this._timer = null;
  }

  _freshState(dk) {
    return {
      dayKey: dk,
      tz: tz(),
      startedAt: new Date(),
      updatedAt: new Date(),
      candidatesTotal: 0,
      candidatesByStrategy: {}, // strategyId -> count
      decisionsTotal: 0,
      outcomes: {}, // outcome -> count
      blockedTotal: 0,
      blockedByStage: {}, // stage -> count
      blockedByReason: {}, // "stage|reason" -> count
      blockedByStrategy: {}, // strategyId -> count
      blockedByStrategyReason: {}, // strategyId -> { "stage|reason": count }

      // Rejection histograms (symbol×strategy×time-bucket)
      blockedBySymbol: {}, // symbol -> count
      blockedBySymbolReason: {}, // symbol -> { "stage|reason": count }
      blockedBySymbolStrategyBucketReason: {}, // symbol -> strategyId -> bucket -> { "stage|reason": count }
      lastDecisions: [], // ring buffer of recent decisions
    };
  }

  _rotateIfNeeded(now = new Date()) {
    const dk = dayKey(now);
    if (dk === this._state.dayKey) return;

    // try to flush previous day before rotating
    this.flush().catch((err) => { reportFault({ code: "TELEMETRY_SIGNALTELEMETRY_ASYNC", err, message: "[src/telemetry/signalTelemetry.js] async task failed" }); });
    this._state = this._freshState(dk);
  }

  start() {
    if (!this._enabled) return;
    if (this._timer) return;

    if (Number.isFinite(this._flushSec) && this._flushSec > 0) {
      this._timer = setInterval(() => {
        this.flush().catch((err) => { reportFault({ code: "TELEMETRY_SIGNALTELEMETRY_ASYNC", err, message: "[src/telemetry/signalTelemetry.js] async task failed" }); });
      }, this._flushSec * 1000);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  recordCandidate(signal) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    this._state.updatedAt = new Date();
    this._state.candidatesTotal += 1;

    const sid = safeKey(signal?.strategyId || "UNKNOWN", 80);
    inc(this._state.candidatesByStrategy, sid, 1);
  }

  recordDecision({ signal, token, outcome, stage, reason, meta }) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    const sid = safeKey(signal?.strategyId || "UNKNOWN", 80);
    const style = safeKey(signal?.strategyStyle || "UNKNOWN", 40);
    const out = safeKey(outcome || "UNKNOWN", 40);
    const stg = safeKey(stage || "unknown", 40);
    const rsn = safeKey(reason || "", 140);
    const key = safeKey(`${stg}|${rsn || out}`, 220);

    this._state.updatedAt = new Date();
    this._state.decisionsTotal += 1;
    inc(this._state.outcomes, out, 1);

    const symRaw =
      (meta && meta.symbol) ||
      signal?.symbol ||
      signal?.tradingsymbol ||
      signal?.instrument?.tradingsymbol ||
      token ||
      "UNKNOWN";
    const symbol = safeKey(symRaw, 40).toUpperCase();
    const bucket = safeKey(
      (meta && (meta.timeBucket || meta.bucket)) || timeBucket(Date.now()),
      12,
    );

    if (out === "BLOCKED") {
      this._state.blockedTotal += 1;
      inc(this._state.blockedByStage, stg, 1);
      inc(this._state.blockedByReason, key, 1);
      inc(this._state.blockedByStrategy, sid, 1);
      deepInc(this._state.blockedByStrategyReason, [sid, key], 1);

      // Rejection histograms by symbol×strategy×bucket (for tuning)
      if (this._rejEnabled) {
        inc(this._state.blockedBySymbol, symbol, 1);
        deepInc(this._state.blockedBySymbolReason, [symbol, key], 1);
        deepInc(
          this._state.blockedBySymbolStrategyBucketReason,
          [symbol, sid, bucket, key],
          1,
        );
      }
    }

    // ring buffer
    const item = {
      ts: Date.now(),
      dayKey: this._state.dayKey,
      signalId:
        signal?.signalId ||
        meta?.signalId ||
        signal?.signalLifecycleId ||
        null,
      token: Number(token) || null,
      strategyId: sid,
      strategyStyle: style,
      symbol,
      timeBucket: bucket,
      side: signal?.side || null,
      intervalMin: signal?.intervalMin || signal?.candle?.interval_min || null,
      outcome: out,
      stage: stg,
      reason: rsn || null,
      meta: meta || null,
    };
    this._state.lastDecisions.push(item);
    if (this._state.lastDecisions.length > this._ringSize) {
      this._state.lastDecisions.splice(
        0,
        this._state.lastDecisions.length - this._ringSize,
      );
    }
  }

  rejectionsSnapshot(opts = {}) {
    const s = this._state;
    const topN = Number(opts.top) || this._rejTopKeys || 200;

    const bySymbol = topEntries(s.blockedBySymbol, Math.min(topN, 50));
    const byReason = topEntries(s.blockedByReason, Math.min(topN, 50));
    const byStage = topEntries(s.blockedByStage, Math.min(topN, 20));

    // Flatten symbol×strategy×bucket×reason for quick tuning (Top-N)
    const flat = [];
    const tree = s.blockedBySymbolStrategyBucketReason || {};
    for (const sym of Object.keys(tree)) {
      const byStrat = tree[sym] || {};
      for (const strat of Object.keys(byStrat)) {
        const byBucket = byStrat[strat] || {};
        for (const bucket of Object.keys(byBucket)) {
          const byKey = byBucket[bucket] || {};
          for (const rk of Object.keys(byKey)) {
            flat.push({
              symbol: sym,
              strategyId: strat,
              bucket,
              reasonKey: rk,
              count: Number(byKey[rk]) || 0,
            });
          }
        }
      }
    }
    flat.sort((a, b) => b.count - a.count);

    return {
      enabled: this._enabled,
      rejectionsEnabled: this._rejEnabled,
      dayKey: s.dayKey,
      tz: s.tz,
      updatedAt: s.updatedAt,
      blockedTotal: s.blockedTotal,
      top: {
        byStage,
        byReason,
        bySymbol,
        bySymbolStrategyBucketReason: flat.slice(
          0,
          Math.max(1, Number(topN) || 200),
        ),
      },
    };
  }

  snapshot() {
    // return a safe copy
    const s = this._state;
    return {
      enabled: this._enabled,
      dayKey: s.dayKey,
      tz: s.tz,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      candidatesTotal: s.candidatesTotal,
      candidatesByStrategy: s.candidatesByStrategy,
      decisionsTotal: s.decisionsTotal,
      outcomes: s.outcomes,
      blockedTotal: s.blockedTotal,
      blockedByStage: s.blockedByStage,
      blockedByReason: s.blockedByReason,
      blockedByStrategy: s.blockedByStrategy,
      blockedByStrategyReason: s.blockedByStrategyReason,
      lastDecisions: s.lastDecisions.slice(-50), // keep response small
    };
  }

  async flush() {
    if (!this._enabled) return { ok: false, reason: "disabled" };
    this._rotateIfNeeded(new Date());

    let db;
    try {
      db = getDb();
    } catch (e) {
      return { ok: false, reason: "db_not_ready" };
    }

    const doc = {
      ...this._state,
      // keep full ring buffer in DB small-ish
      lastDecisions: this._state.lastDecisions.slice(-200),
      updatedAt: new Date(),
    };

    try {
      const col = db.collection(this._dailyCollection);
      await col.updateOne(
        { dayKey: doc.dayKey },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true },
      );
      return { ok: true, dayKey: doc.dayKey };
    } catch (e) {
      logger.warn({ e: e?.message || String(e) }, "[telemetry] flush failed");
      return { ok: false, reason: "flush_failed", error: e?.message };
    }
  }

  async readDailyFromDb(dk) {
    let db;
    try {
      db = getDb();
    } catch (e) {
      return null;
    }
    const day = safeKey(dk || this._state.dayKey, 20);
    try {
      const col = db.collection(this._dailyCollection);
      return await col.findOne({ dayKey: day });
    } catch {
      return null;
    }
  }
}

const telemetry = new SignalTelemetry();

module.exports = { telemetry, dayKey };
