const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { reportFault } = require("../runtime/errorBus");

/**
 * Trade outcome telemetry (pro tuning support).
 *
 * Tracks closed trades + fee-multiple (grossPnL / estimated costs).
 * This complements signalTelemetry (candidate/blocked reasons) with "did we beat costs?"
 */

function tz() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function dayKey(now = new Date()) {
  try {
    return DateTime.fromJSDate(now, { zone: tz() }).toFormat("yyyy-LL-dd");
  } catch {
    const d = new Date(now);
    return d.toISOString().slice(0, 10);
  }
}

function safeKey(s, maxLen = 180) {
  const v = String(s || "").replace(/\s+/g, " ").trim();
  if (!v) return "UNKNOWN";
  return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
}

function inc(obj, key, n = 1) {
  if (!obj) return;
  const k = safeKey(key);
  obj[k] = (obj[k] || 0) + Number(n ?? 0);
}

function safeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return { note: "UNSERIALIZABLE_META" };
  }
}

function bucketFeeMultiple(x) {
  if (!Number.isFinite(x)) return "NA";
  if (x < 0) return "<0";
  if (x < 1) return "0-1";
  if (x < 2) return "1-2";
  if (x < 3) return "2-3";
  if (x < 5) return "3-5";
  return "5+";
}

class TradeTelemetry {
  constructor() {
    this._enabled =
      String(env.TELEMETRY_ENABLED || "true") === "true" &&
      String(env.TELEMETRY_TRADES_ENABLED || "true") === "true";

    this._ringSize = Number(env.TELEMETRY_TRADES_RING_SIZE ?? 300);
    this._flushSec = Number(env.TELEMETRY_FLUSH_SEC ?? 60);
    this._dailyCollection =
      env.TELEMETRY_TRADES_DAILY_COLLECTION || "telemetry_trades_daily";

    this._state = this._freshState(dayKey());
    this._timer = null;
  }

  _freshState(dk) {
    return {
      dayKey: dk,
      tz: tz(),
      startedAt: new Date(),
      updatedAt: new Date(),

      tradesClosedTotal: 0,
      closedByStrategy: {},
      closedByReason: {},
      feeMultipleBuckets: {},

      sumFeeMultiple: 0,
      countFeeMultiple: 0,

      sumNetAfterEstCostsInr: 0,
      sumGrossPnlInr: 0,
      sumEstCostsInr: 0,

      lastTrades: [], // ring buffer
      decisionsTotal: 0,
      decisionsByOutcome: {},
      decisionsByStage: {},
      decisionsByReason: {},
      lastDecisions: [], // ring buffer
    };
  }

  _rotateIfNeeded(now = new Date()) {
    const dk = dayKey(now);
    if (dk === this._state.dayKey) return;

    this.flush().catch((err) => { reportFault({ code: "TELEMETRY_TRADETELEMETRY_ASYNC", err, message: "[src/telemetry/tradeTelemetry.js] async task failed" }); });
    this._state = this._freshState(dk);
  }

  start() {
    if (!this._enabled) return;
    if (this._timer) return;

    if (Number.isFinite(this._flushSec) && this._flushSec > 0) {
      this._timer = setInterval(() => {
        this.flush().catch((err) => { reportFault({ code: "TELEMETRY_TRADETELEMETRY_ASYNC", err, message: "[src/telemetry/tradeTelemetry.js] async task failed" }); });
      }, this._flushSec * 1000);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  recordDecision({
    tradeId,
    signalId,
    strategyId,
    side,
    token,
    outcome,
    stage,
    reason,
    meta,
  }) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    const sid = safeKey(strategyId || "UNKNOWN", 80);
    const out = safeKey(outcome || "UNKNOWN", 40);
    const stg = safeKey(stage || "unknown", 40);
    const rsn = safeKey(reason || out, 140);
    const key = safeKey(`${stg}|${rsn}`, 220);

    this._state.updatedAt = new Date();
    this._state.decisionsTotal += 1;
    inc(this._state.decisionsByOutcome, out, 1);
    inc(this._state.decisionsByStage, stg, 1);
    inc(this._state.decisionsByReason, key, 1);

    const item = {
      ts: Date.now(),
      dayKey: this._state.dayKey,
      tradeId: String(tradeId || ""),
      signalId: signalId ? String(signalId) : null,
      strategyId: sid,
      side: side || null,
      token: Number.isFinite(Number(token)) ? Number(token) : null,
      outcome: out,
      stage: stg,
      reason: rsn,
      meta: safeMeta(meta),
    };

    this._state.lastDecisions.push(item);
    if (this._state.lastDecisions.length > this._ringSize) {
      this._state.lastDecisions.splice(
        0,
        this._state.lastDecisions.length - this._ringSize,
      );
    }
  }

  recordTradeClose({
    tradeId,
    strategyId,
    side,
    closeReason,
    grossPnlInr,
    estCostInr,
    netAfterEstCostsInr,
    feeMultiple,
  }) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    this._state.updatedAt = new Date();
    this._state.tradesClosedTotal += 1;

    const sid = safeKey(strategyId || "UNKNOWN", 80);
    const rsn = safeKey(closeReason || "UNKNOWN", 140);

    inc(this._state.closedByStrategy, sid, 1);
    inc(this._state.closedByReason, rsn, 1);
    inc(this._state.feeMultipleBuckets, bucketFeeMultiple(feeMultiple), 1);

    const fm = Number(feeMultiple);
    if (Number.isFinite(fm)) {
      this._state.sumFeeMultiple += fm;
      this._state.countFeeMultiple += 1;
    }

    const g = Number(grossPnlInr ?? 0);
    const c = Number(estCostInr ?? 0);
    const n = Number(netAfterEstCostsInr ?? 0);
    if (Number.isFinite(g)) this._state.sumGrossPnlInr += g;
    if (Number.isFinite(c)) this._state.sumEstCostsInr += c;
    if (Number.isFinite(n)) this._state.sumNetAfterEstCostsInr += n;

    const item = {
      ts: Date.now(),
      dayKey: this._state.dayKey,
      tradeId: String(tradeId || ""),
      strategyId: sid,
      side: side || null,
      closeReason: rsn,
      grossPnlInr: Number.isFinite(g) ? g : null,
      estCostInr: Number.isFinite(c) ? c : null,
      netAfterEstCostsInr: Number.isFinite(n) ? n : null,
      feeMultiple: Number.isFinite(fm) ? fm : null,
    };

    this._state.lastTrades.push(item);
    if (this._state.lastTrades.length > this._ringSize) {
      this._state.lastTrades.splice(
        0,
        this._state.lastTrades.length - this._ringSize
      );
    }
  }

  snapshot() {
    const s = this._state;
    const avgFeeMultiple =
      s.countFeeMultiple > 0 ? s.sumFeeMultiple / s.countFeeMultiple : null;

    return {
      enabled: this._enabled,
      dayKey: s.dayKey,
      tz: s.tz,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      tradesClosedTotal: s.tradesClosedTotal,
      closedByStrategy: s.closedByStrategy,
      closedByReason: s.closedByReason,
      feeMultipleBuckets: s.feeMultipleBuckets,
      avgFeeMultiple,
      sumGrossPnlInr: s.sumGrossPnlInr,
      sumEstCostsInr: s.sumEstCostsInr,
      sumNetAfterEstCostsInr: s.sumNetAfterEstCostsInr,
      lastTrades: s.lastTrades.slice(-50),
      decisionsTotal: s.decisionsTotal,
      decisionsByOutcome: s.decisionsByOutcome,
      decisionsByStage: s.decisionsByStage,
      decisionsByReason: s.decisionsByReason,
      lastDecisions: s.lastDecisions.slice(-50),
    };
  }

  async flush() {
    if (!this._enabled) return { ok: false, reason: "disabled" };
    this._rotateIfNeeded(new Date());

    let db;
    try {
      db = getDb();
    } catch {
      return { ok: false, reason: "db_not_ready" };
    }

    const avgFeeMultiple =
      this._state.countFeeMultiple > 0
        ? this._state.sumFeeMultiple / this._state.countFeeMultiple
        : null;

    const doc = {
      ...this._state,
      avgFeeMultiple,
      lastTrades: this._state.lastTrades.slice(-200),
      lastDecisions: this._state.lastDecisions.slice(-200),
      updatedAt: new Date(),
    };

    try {
      const col = db.collection(this._dailyCollection);
      await col.updateOne(
        { dayKey: doc.dayKey },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      return { ok: true, dayKey: doc.dayKey };
    } catch (e) {
      logger.warn({ e: e?.message || String(e) }, "[tradeTelemetry] flush failed");
      return { ok: false, reason: "flush_failed", error: e?.message };
    }
  }
  async readDailyFromDb(dk) {
    let db;
    try {
      db = getDb();
    } catch {
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

const tradeTelemetry = new TradeTelemetry();

module.exports = { tradeTelemetry };
