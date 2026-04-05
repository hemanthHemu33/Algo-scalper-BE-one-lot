const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { reportFault } = require("../runtime/errorBus");
const {
  readState: readOptimizerState,
  writeState: writeOptimizerState,
} = require("./optimizerStateStore");

// Trades collection name is defined in tradeStore.js, but we keep a local constant here to avoid circular deps.
const TRADES_COLLECTION = "trades";

const ACTION = Object.freeze({
  HARD_BLOCK: "HARD_BLOCK",
  SOFT_DEWEIGHT: "SOFT_DEWEIGHT",
  RR_TUNE_ONLY: "RR_TUNE_ONLY",
  PASS: "PASS",
});

const SPREAD_SOFT_ACTIONS = new Set(["NONE", "CONF", "QTY", "RR_ONLY"]);
const DEFAULT_KEY_MODE = "NORMALIZED_V2";
const DEFAULT_SCHEMA_VERSION = 2;
const DEFAULT_KEY_SCHEMA_VERSION = DEFAULT_KEY_MODE;
const NON_OPTION_TYPE = "NONOPT";

function tz(runtimeEnv = env) {
  return runtimeEnv.CANDLE_TZ || "Asia/Kolkata";
}

function n(x, d = NaN) {
  if (x === null || x === undefined || x === "") return d;
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function toBool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ["1", "true", "yes", "on"].includes(s);
}

function safeKey(s, maxLen = 64, fallback = "UNKNOWN") {
  const v = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!v) return fallback;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function safeUpper(s, maxLen = 64, fallback = "UNKNOWN") {
  return safeKey(s, maxLen, fallback).toUpperCase();
}

function scopeSet(runtimeEnv = env) {
  const s = safeUpper(runtimeEnv.OPT_BLOCK_SCOPE || "BOTH", 24, "BOTH");
  if (s === "KEY") return { key: true, strategy: false };
  if (s === "STRATEGY") return { key: false, strategy: true };
  return { key: true, strategy: true };
}

function hhmmToMinutes(hhmm) {
  const t = String(hhmm || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function minutesOfDay(nowTs, runtimeEnv = env) {
  try {
    const dt = DateTime.fromMillis(Number(nowTs) || Date.now(), {
      zone: tz(runtimeEnv),
    });
    return dt.hour * 60 + dt.minute;
  } catch {
    const d = new Date(nowTs);
    return d.getHours() * 60 + d.getMinutes();
  }
}

function bucketForTs(nowTs, runtimeEnv = env, bucketOpenEnd, bucketCloseStart) {
  const openEnd = hhmmToMinutes(
    bucketOpenEnd ?? runtimeEnv.OPT_BUCKET_OPEN_END ?? "10:00",
  );
  const closeStart = hhmmToMinutes(
    bucketCloseStart ?? runtimeEnv.OPT_BUCKET_CLOSE_START ?? "15:00",
  );
  const m = minutesOfDay(nowTs, runtimeEnv);
  if (openEnd != null && m < openEnd) return "OPEN";
  if (closeStart != null && m >= closeStart) return "CLOSE";
  return "MID";
}

function normalizeUnderlying(underlying, symbol) {
  const raw = underlying || symbol || "UNKNOWN";
  return safeUpper(raw, 32, "UNKNOWN");
}

function normalizeOptType(optType, symbol) {
  const t = safeUpper(optType, 16, "");
  if (t === "CE" || t === "PE") return t;
  const sym = safeUpper(symbol, 64, "");
  if (sym.endsWith("CE")) return "CE";
  if (sym.endsWith("PE")) return "PE";
  return NON_OPTION_TYPE;
}

function normalizeDteBand(dte, expiry, nowTs = Date.now()) {
  let days = n(dte, NaN);
  if (!Number.isFinite(days) && expiry) {
    const ms = new Date(expiry).getTime();
    if (Number.isFinite(ms)) {
      days = (ms - Number(nowTs || Date.now())) / (1000 * 60 * 60 * 24);
    }
  }
  if (!Number.isFinite(days)) return "D1_3";
  if (days < 1) return "D0";
  if (days < 4) return "D1_3";
  if (days < 8) return "D4_7";
  return "D8P";
}

function estimateAbsDelta(delta, moneyness, runtimeEnv = env) {
  const d = n(delta, NaN);
  if (Number.isFinite(d)) return Math.abs(d);
  const m = safeUpper(moneyness, 16, "ATM");
  if (m === "ITM") return n(runtimeEnv.OPT_DELTA_ITM, 0.65);
  if (m === "OTM") return n(runtimeEnv.OPT_DELTA_OTM, 0.4);
  return n(runtimeEnv.OPT_DELTA_ATM, 0.5);
}

function normalizeDeltaBand(delta, moneyness, runtimeEnv = env) {
  const absDelta = estimateAbsDelta(delta, moneyness, runtimeEnv);
  if (!Number.isFinite(absDelta)) return "DELTA_45_55";
  if (absDelta < 0.35) return "DELTA_20_35";
  if (absDelta < 0.45) return "DELTA_35_45";
  if (absDelta < 0.55) return "DELTA_45_55";
  if (absDelta < 0.7) return "DELTA_55_70";
  return "DELTA_70P";
}

function normalizeStyleBand(strategyStyle, signalRegime, bucket) {
  const style = safeUpper(strategyStyle, 64, "");
  const regime = safeUpper(signalRegime, 64, "");
  if (style.includes("OPEN") || regime.includes("OPEN")) return "OPEN";
  if (style.includes("TREND") || regime.includes("TREND")) return "TREND";
  if (style.includes("RANGE") || regime.includes("RANGE")) return "RANGE";
  if (String(bucket || "").toUpperCase() === "OPEN") return "OPEN";
  return "DEFAULT";
}

function normalizeSpreadSoftAction(action) {
  const upper = safeUpper(action || "RR_ONLY", 16, "RR_ONLY");
  return SPREAD_SOFT_ACTIONS.has(upper) ? upper : "RR_ONLY";
}

function spreadRegime(spreadBps, spreadPenaltyBps, spreadBlockBps) {
  const bps = n(spreadBps, NaN);
  if (!Number.isFinite(bps) || bps <= 0) {
    return { regime: "UNKNOWN", bps: null };
  }
  if (bps >= Number(spreadBlockBps)) return { regime: "EXTREME", bps };
  if (bps >= Number(spreadPenaltyBps)) return { regime: "WIDE", bps };
  return { regime: "OK", bps };
}

function buildOptimizerKeyContext(input = {}, options = {}) {
  const runtimeEnv = options.env || env;
  const bucket = safeUpper(
    input.bucket ||
      bucketForTs(
        input.bucketTs ?? input.nowTs ?? Date.now(),
        runtimeEnv,
        options.bucketOpenEnd,
        options.bucketCloseStart,
      ),
    16,
    "MID",
  );
  const strategyId = safeKey(input.strategyId, 64);
  const symbol = safeUpper(input.symbol || input.tradingsymbol, 64, "UNKNOWN");
  const optType = normalizeOptType(
    input.optType ?? input.optionMeta?.optType,
    symbol,
  );
  const isOption = optType === "CE" || optType === "PE";
  const underlying = normalizeUnderlying(
    input.underlying ?? input.optionMeta?.underlying,
    symbol,
  );
  const styleBand = normalizeStyleBand(
    input.strategyStyle ?? input.optionMeta?.strategyStyle,
    input.signalRegime,
    bucket,
  );
  const includeOptType = toBool(
    options.includeOptType ?? runtimeEnv.OPT_STRATEGY_KEY_INCLUDE_OPT_TYPE,
    true,
  );
  const includeStyle = toBool(
    options.includeStyle ?? runtimeEnv.OPT_STRATEGY_KEY_INCLUDE_STYLE,
    true,
  );
  let dteBand = null;
  let deltaBand = null;
  let keyKey;

  if (isOption) {
    dteBand = normalizeDteBand(
      input.dte ??
        input.optionMeta?.meta?.dteDays ??
        input.optionMeta?.dteDays,
      input.expiry ?? input.optionMeta?.expiry,
      input.nowTs,
    );
    deltaBand = normalizeDeltaBand(
      input.delta ?? input.optionMeta?.delta,
      input.optionMeta?.moneyness,
      runtimeEnv,
    );
    keyKey = `K2|${underlying}|${optType}|${strategyId}|${bucket}|${dteBand}|${deltaBand}`;
  } else {
    keyKey = `K2|${underlying}|${strategyId}|${bucket}`;
  }

  const stratKey = `S2|${strategyId}|${bucket}|${
    includeOptType ? optType : "ANY"
  }|${includeStyle ? styleBand : "DEFAULT"}`;

  return {
    schemaVersion: DEFAULT_SCHEMA_VERSION,
    keySchemaVersion: DEFAULT_KEY_SCHEMA_VERSION,
    keyMode: DEFAULT_KEY_MODE,
    symbol,
    underlying,
    optType,
    strategyId,
    bucket,
    dteBand,
    deltaBand,
    styleBand,
    keyKey,
    stratKey,
    isOption,
  };
}

class RollingWindow {
  constructor(max = 60) {
    this.max = Math.max(1, Number(max) || 60);
    this.items = [];
  }

  push(v) {
    if (v === null || v === undefined) return;
    const x = Number(v);
    if (!Number.isFinite(x)) return;
    this.items.push(x);
    if (this.items.length > this.max) {
      this.items.splice(0, this.items.length - this.max);
    }
  }

  get n() {
    return this.items.length;
  }

  avg() {
    if (!this.items.length) return null;
    let s = 0;
    for (const x of this.items) s += x;
    return s / this.items.length;
  }

  snapshot() {
    const a = this.avg();
    return {
      n: this.n,
      avg: Number.isFinite(a) ? a : null,
      last: this.items.length ? this.items[this.items.length - 1] : null,
    };
  }
}

class AdaptiveOptimizer {
  constructor(options = {}) {
    this._env = options.env || env;
    this._logger = options.logger || logger;
    this._dbGetter = options.getDb || getDb;
    this._readState = options.readState || readOptimizerState;
    this._writeState = options.writeState || writeOptimizerState;

    this._enabled = toBool(this._env.OPTIMIZER_ENABLED, true);

    this._lookbackN = Number(this._env.OPT_LOOKBACK_N ?? 60);
    this._minSamplesKey = Number(
      this._env.OPT_MIN_SAMPLES_KEY ?? this._env.OPT_MIN_SAMPLES ?? 20,
    );
    this._minSamplesStrategy = Number(
      this._env.OPT_MIN_SAMPLES_STRATEGY ?? this._env.OPT_MIN_SAMPLES ?? 20,
    );
    this._feeMultipleMin = Number(
      this._env.OPT_BLOCK_FEE_MULTIPLE_AVG_MIN ?? 3,
    );
    this._blockTtlMin = Number(this._env.OPT_BLOCK_TTL_MIN ?? 120);

    this._deweightEnabled = toBool(this._env.OPT_DEWEIGHT_ENABLED, true);
    this._deMinSamples = Number(this._env.OPT_DEWEIGHT_MIN_SAMPLES ?? 5);
    this._deConfMin = Number(this._env.OPT_DEWEIGHT_CONF_MIN ?? 0.9);
    this._deQtyMin = Number(this._env.OPT_DEWEIGHT_QTY_MIN ?? 0.5);
    this._deweightHardVetoEnabled = toBool(
      this._env.OPT_DEWEIGHT_HARD_VETO_ENABLED,
      false,
    );

    this._spreadPenaltyBps = Number(this._env.OPT_SPREAD_PENALTY_BPS ?? 25);
    this._spreadBlockBps = Number(this._env.OPT_SPREAD_BLOCK_BPS ?? 60);
    this._spreadPenaltyConfMult = Number(
      this._env.OPT_SPREAD_PENALTY_CONF_MULT ?? 0.9,
    );
    this._spreadBlockEnabled = toBool(
      this._env.OPT_SPREAD_BLOCK_ENABLED,
      false,
    );
    this._spreadSoftAction = normalizeSpreadSoftAction(
      this._env.OPT_SPREAD_SOFT_ACTION,
    );

    this._rrTrendMin = Number(this._env.RR_TREND_MIN ?? 1.5);
    this._rrWideSpreadMin = Number(this._env.RR_WIDE_SPREAD_MIN ?? 1.8);

    this._bucketOpenEnd = String(this._env.OPT_BUCKET_OPEN_END || "10:00");
    this._bucketCloseStart = String(
      this._env.OPT_BUCKET_CLOSE_START || "15:00",
    );

    this._logDecisions = toBool(this._env.OPT_LOG_DECISIONS, true);
    this._keyMode = safeUpper(this._env.OPT_KEY_MODE, 32, DEFAULT_KEY_MODE);
    this._keySchemaVersion = DEFAULT_KEY_SCHEMA_VERSION;
    this._stateVersion = Math.max(
      1,
      Number(this._env.OPT_STATE_VERSION ?? 2) || 2,
    );
    this._strategyKeyIncludeOptType = toBool(
      this._env.OPT_STRATEGY_KEY_INCLUDE_OPT_TYPE,
      true,
    );
    this._strategyKeyIncludeStyle = toBool(
      this._env.OPT_STRATEGY_KEY_INCLUDE_STYLE,
      true,
    );

    this._persistEnabled =
      options.persistEnabled ?? toBool(this._env.OPT_STATE_PERSIST, false);
    this._stateFlushSec = Number(this._env.OPT_STATE_FLUSH_SEC ?? 15);
    this._stateMaxKeys = Number(this._env.OPT_STATE_MAX_KEYS ?? 1500);
    this._stateDirty = false;
    this._stateTimer = null;
    this._stateLoaded = false;
    this._stateLastSavedAt = null;
    this._skipStateLoadOnce = false;

    this._windows = new Map();
    this._blocked = new Map();

    this._bootstrapped = false;
    this._bootstrapInFlight = null;
  }

  _scope() {
    return scopeSet(this._env);
  }

  _log(payload, msg) {
    if (!this._logDecisions) return;
    try {
      this._logger.info(payload || {}, msg);
    } catch (err) {
      reportFault({
        code: "OPTIMIZER_ADAPTIVEOPTIMIZER_CATCH",
        err,
        message: "[src/optimizer/adaptiveOptimizer.js] caught and continued",
      });
    }
  }

  _markStateDirty() {
    if (!this._persistEnabled) return;
    this._stateDirty = true;
  }

  _startStateTimer() {
    if (!this._persistEnabled) return;
    if (this._stateTimer) return;

    const sec = Number(this._stateFlushSec ?? 0);
    if (!(sec > 0)) return;

    this._stateTimer = setInterval(() => {
      this.flushState().catch((err) => {
        reportFault({
          code: "OPTIMIZER_ADAPTIVEOPTIMIZER_ASYNC",
          err,
          message: "[src/optimizer/adaptiveOptimizer.js] async task failed",
        });
      });
    }, sec * 1000);
    this._stateTimer.unref?.();
  }

  _stopStateTimer() {
    if (this._stateTimer) clearInterval(this._stateTimer);
    this._stateTimer = null;
  }

  _serializeState() {
    const windows = {};
    const blocked = {};

    let wCount = 0;
    for (const [k, w] of this._windows.entries()) {
      if (wCount >= this._stateMaxKeys) break;
      windows[k] = Array.isArray(w.items) ? w.items.slice(-this._lookbackN) : [];
      wCount += 1;
    }

    const nowTs = Date.now();
    for (const [k, b] of this._blocked.entries()) {
      if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) continue;
      blocked[k] = {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: b.reason,
        snapshot: b.snapshot || null,
      };
    }

    return {
      version: this._stateVersion,
      keySchemaVersion: this._keySchemaVersion,
      keyMode: this._keyMode,
      tz: tz(this._env),
      lookbackN: this._lookbackN,
      feeMultipleMin: this._feeMultipleMin,
      minSamplesKey: this._minSamplesKey,
      minSamplesStrategy: this._minSamplesStrategy,
      blockTtlMin: this._blockTtlMin,
      windows,
      blocked,
      savedAt: new Date(),
    };
  }

  _hydrateState(doc) {
    if (!doc || typeof doc !== "object") return { ok: false, reason: "no_doc" };

    const docVersion = Number(doc.version ?? doc.stateVersion ?? 1);
    const docKeySchemaVersion = String(doc.keySchemaVersion || "");
    if (
      docVersion !== this._stateVersion ||
      docKeySchemaVersion !== this._keySchemaVersion
    ) {
      this._windows.clear();
      this._blocked.clear();
      this._logger.info(
        {
          persistedVersion: docVersion,
          expectedVersion: this._stateVersion,
          persistedKeySchemaVersion: docKeySchemaVersion,
          expectedKeySchemaVersion: this._keySchemaVersion,
        },
        "[optimizer] ignored persisted state due to schema change",
      );
      return {
        ok: false,
        reason: "state_version_mismatch",
        ignored: true,
        version: docVersion,
          keySchemaVersion: docKeySchemaVersion,
      };
    }

    const windows =
      doc.windows && typeof doc.windows === "object" ? doc.windows : {};
    const blocked =
      doc.blocked && typeof doc.blocked === "object" ? doc.blocked : {};

    this._windows.clear();
    this._blocked.clear();

    let countW = 0;
    for (const k of Object.keys(windows)) {
      if (countW >= this._stateMaxKeys) break;
      const arr = windows[k];
      const w = new RollingWindow(this._lookbackN);
      if (Array.isArray(arr)) {
        for (const x of arr) w.push(x);
      }
      this._windows.set(k, w);
      countW += 1;
    }

    const nowTs = Date.now();
    let countB = 0;
    for (const k of Object.keys(blocked)) {
      const b = blocked[k];
      if (!b) continue;
      if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) continue;
      this._blocked.set(k, {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: String(b.reason || "BLOCKED"),
        snapshot: b.snapshot || null,
      });
      countB += 1;
      if (countB > this._stateMaxKeys) break;
    }

    return { ok: true, windows: countW, blocked: countB };
  }

  async loadPersistedState() {
    if (!this._persistEnabled) return { ok: false, reason: "disabled" };
    const doc = await this._readState();
    if (!doc) return { ok: false, reason: "no_state" };
    const out = this._hydrateState(doc);
    if (out.ok) {
      this._stateLoaded = true;
      this._stateLastSavedAt = doc.updatedAt || doc.savedAt || null;
    }
    return out;
  }

  async flushState(opts = {}) {
    const force = !!opts.force;
    if (!this._persistEnabled) return { ok: false, reason: "disabled" };
    if (!force && !this._stateDirty) return { ok: true, skipped: true };

    const doc = this._serializeState();
    const out = await this._writeState(doc);
    if (out.ok) {
      this._stateDirty = false;
      this._stateLastSavedAt = doc.savedAt;
    }
    return out;
  }

  _bucket(nowTs) {
    return bucketForTs(
      nowTs,
      this._env,
      this._bucketOpenEnd,
      this._bucketCloseStart,
    );
  }

  buildOptimizerKeyContext(input = {}) {
    return buildOptimizerKeyContext(input, {
      env: this._env,
      keyMode: this._keyMode,
      includeOptType: this._strategyKeyIncludeOptType,
      includeStyle: this._strategyKeyIncludeStyle,
      bucketOpenEnd: this._bucketOpenEnd,
      bucketCloseStart: this._bucketCloseStart,
    });
  }

  _getWindow(key) {
    const k = String(key || "");
    let w = this._windows.get(k);
    if (!w) {
      w = new RollingWindow(this._lookbackN);
      this._windows.set(k, w);
    }
    return w;
  }

  _getBlocked(key, nowTs) {
    const k = String(key || "");
    const b = this._blocked.get(k);
    if (!b) return null;
    if (Number.isFinite(b.untilTs) && nowTs >= b.untilTs) {
      this._blocked.delete(k);
      this._markStateDirty();
      return null;
    }
    return b;
  }

  _setBlocked(key, nowTs, reason, snapshot) {
    const k = String(key || "");
    const untilTs = nowTs + Math.max(1, this._blockTtlMin) * 60 * 1000;
    this._blocked.set(k, {
      untilTs,
      setAtTs: nowTs,
      reason: String(reason || "BLOCKED"),
      snapshot: snapshot || null,
    });
    this._markStateDirty();
  }

  _volRegime({ atrBase, close }) {
    const atr = n(atrBase, NaN);
    const c = n(close, NaN);
    if (!(atr > 0) || !(c > 0)) {
      return { regime: "UNKNOWN", atrPct: null };
    }
    const atrPct = (atr / c) * 100;
    const low = n(this._env.VOL_LOW_PCT, 0.8);
    const high = n(this._env.VOL_HIGH_PCT, 2.0);
    if (atrPct < low) return { regime: "LOW", atrPct };
    if (atrPct > high) return { regime: "HIGH", atrPct };
    return { regime: "MED", atrPct };
  }

  _rrFromVolRegime(volRegime, rrBase) {
    const base = n(rrBase, 1.0);
    if (volRegime === "LOW") return Math.max(base, n(this._env.RR_VOL_LOW, base));
    if (volRegime === "HIGH")
      return Math.max(base, n(this._env.RR_VOL_HIGH, base));
    if (volRegime === "MED") return Math.max(base, n(this._env.RR_VOL_MED, base));
    return base;
  }

  _spreadRegime(spreadBps) {
    return spreadRegime(spreadBps, this._spreadPenaltyBps, this._spreadBlockBps);
  }

  _ratioFromStats(avg, samples) {
    if (
      !Number.isFinite(avg) ||
      !Number.isFinite(samples) ||
      samples < this._deMinSamples ||
      !(this._feeMultipleMin > 0)
    ) {
      return 1;
    }
    if (avg <= 0) return 0;
    return avg / this._feeMultipleMin;
  }

  _resolveRatioSource(ratioKey, ratioStrategy) {
    const hasKey = Number.isFinite(ratioKey);
    const hasStrategy = Number.isFinite(ratioStrategy);
    if (!hasKey && !hasStrategy) {
      return { ratioUsed: 1, deweightSource: "NONE" };
    }
    if (hasKey && hasStrategy) {
      const ratioUsed = Math.min(ratioKey, ratioStrategy);
      if (ratioUsed >= 1) return { ratioUsed, deweightSource: "NONE" };
      if (Math.abs(ratioKey - ratioStrategy) < 1e-9) {
        return { ratioUsed, deweightSource: "BOTH" };
      }
      return {
        ratioUsed,
        deweightSource: ratioUsed === ratioKey ? "KEY" : "STRATEGY",
      };
    }
    const ratioUsed = hasKey ? ratioKey : ratioStrategy;
    if (ratioUsed >= 1) return { ratioUsed, deweightSource: "NONE" };
    return {
      ratioUsed,
      deweightSource: hasKey ? "KEY" : "STRATEGY",
    };
  }

  _applySpreadSoftControl({ spreadRegime, confidenceMult, qtyMult }) {
    if (spreadRegime !== "WIDE" && spreadRegime !== "EXTREME") {
      return {
        confidenceMult,
        qtyMult,
        spreadSoftApplied: "NONE",
      };
    }

    if (this._spreadSoftAction === "CONF") {
      return {
        confidenceMult: clamp(
          confidenceMult * this._spreadPenaltyConfMult,
          this._deConfMin,
          1,
        ),
        qtyMult,
        spreadSoftApplied: "CONF",
      };
    }

    if (this._spreadSoftAction === "QTY") {
      return {
        confidenceMult,
        qtyMult: clamp(
          qtyMult * this._spreadPenaltyConfMult,
          this._deQtyMin,
          1,
        ),
        spreadSoftApplied: "QTY",
      };
    }

    return {
      confidenceMult,
      qtyMult,
      spreadSoftApplied: this._spreadSoftAction,
    };
  }

  evaluateSignal({
    symbol,
    underlying,
    optType,
    delta,
    expiry,
    dte,
    strategyId,
    nowTs,
    atrBase,
    close,
    rrBase,
    spreadBps,
    signalRegime,
    strategyStyle,
    confidence,
    optionMeta,
  }) {
    if (!this._enabled) {
      return {
        ok: true,
        action: ACTION.PASS,
        reason: null,
        meta: { note: "optimizer_disabled" },
      };
    }

    const ts = Number(nowTs) || Date.now();
    const context = this.buildOptimizerKeyContext({
      symbol,
      underlying,
      optType,
      delta,
      expiry,
      dte,
      strategyId,
      strategyStyle,
      signalRegime,
      nowTs: ts,
      optionMeta,
    });
    const rrBaseNum = n(rrBase, 1.0);
    const sp = this._spreadRegime(spreadBps);
    const baseMeta = {
      keySchemaVersion: this._keySchemaVersion,
      keyMode: this._keyMode,
      keyKey: context.keyKey,
      stratKey: context.stratKey,
      bucket: context.bucket,
      underlying: context.underlying,
      optType: context.optType,
      strategyId: context.strategyId,
      dteBand: context.dteBand,
      deltaBand: context.deltaBand,
      styleBand: context.styleBand,
      rrBase: rrBaseNum,
      spreadRegime: sp.regime,
      spreadBps: sp.bps,
      confidenceRaw: Number.isFinite(Number(confidence))
        ? Number(confidence)
        : null,
    };

    const scope = this._scope();
    const bKey = scope.key ? this._getBlocked(context.keyKey, ts) : null;
    if (bKey) {
      const meta = {
        ...baseMeta,
        scope: "KEY",
        blockedUntilTs: bKey.untilTs,
        snapshot: bKey.snapshot,
      };
      this._log(
        { ...meta, reason: bKey.reason },
        "[optimizer] blocked key context",
      );
      return {
        ok: false,
        action: ACTION.HARD_BLOCK,
        reason: "OPT_BLOCK_KEY",
        meta,
      };
    }

    const bStrat = scope.strategy ? this._getBlocked(context.stratKey, ts) : null;
    if (bStrat) {
      const meta = {
        ...baseMeta,
        scope: "STRATEGY",
        blockedUntilTs: bStrat.untilTs,
        snapshot: bStrat.snapshot,
      };
      this._log(
        { ...meta, reason: bStrat.reason },
        "[optimizer] blocked strategy context",
      );
      return {
        ok: false,
        action: ACTION.HARD_BLOCK,
        reason: "OPT_BLOCK_STRATEGY",
        meta,
      };
    }

    if (this._spreadBlockEnabled && sp.regime === "EXTREME") {
      const meta = { ...baseMeta, spreadSoftAction: this._spreadSoftAction };
      this._log(meta, "[optimizer] blocked extreme spread");
      return {
        ok: false,
        action: ACTION.HARD_BLOCK,
        reason: "OPT_BLOCK_SPREAD_EXTREME",
        meta,
      };
    }

    const vr = this._volRegime({ atrBase, close });
    let rrUsed = this._rrFromVolRegime(vr.regime, rrBaseNum);

    const signalReg = safeUpper(signalRegime, 32, "");
    const style = safeUpper(strategyStyle, 64, "");
    if (signalReg === "TREND" || style.includes("TREND")) {
      rrUsed = Math.max(rrUsed, this._rrTrendMin);
    }
    if (sp.regime === "WIDE" || sp.regime === "EXTREME") {
      rrUsed = Math.max(rrUsed, this._rrWideSpreadMin);
    }

    const keyWindow = this._windows.get(context.keyKey);
    const strategyWindow = this._windows.get(context.stratKey);
    const keyAvg = keyWindow ? keyWindow.avg() : null;
    const keySamples = keyWindow ? keyWindow.n : 0;
    const strategyAvg = strategyWindow ? strategyWindow.avg() : null;
    const strategySamples = strategyWindow ? strategyWindow.n : 0;

    let ratioKey = 1;
    let ratioStrategy = 1;
    let ratioUsed = 1;
    let deweightSource = "NONE";
    let confidenceMult = 1;
    let qtyMult = 1;

    if (this._deweightEnabled) {
      ratioKey = this._ratioFromStats(keyAvg, keySamples);
      ratioStrategy = this._ratioFromStats(strategyAvg, strategySamples);
      const ratioMeta = this._resolveRatioSource(ratioKey, ratioStrategy);
      ratioUsed = ratioMeta.ratioUsed;
      deweightSource = ratioMeta.deweightSource;

      if (ratioUsed < 1) {
        confidenceMult = clamp(ratioUsed, this._deConfMin, 1);
        qtyMult = clamp(ratioUsed, this._deQtyMin, 1);
      }
    }

    const spreadSoft = this._applySpreadSoftControl({
      spreadRegime: sp.regime,
      confidenceMult,
      qtyMult,
    });
    confidenceMult = spreadSoft.confidenceMult;
    qtyMult = spreadSoft.qtyMult;

    const confidenceUsedForTelemetry =
      Number.isFinite(baseMeta.confidenceRaw) && Number.isFinite(confidenceMult)
        ? baseMeta.confidenceRaw * confidenceMult
        : baseMeta.confidenceRaw;

    const meta = {
      ...baseMeta,
      rrUsed,
      volRegime: vr.regime,
      atrPct: vr.atrPct,
      spreadSoftAction: this._spreadSoftAction,
      spreadSoftApplied: spreadSoft.spreadSoftApplied,
      confidenceMult,
      confidenceUsedForTelemetry,
      qtyMult,
      keySamples,
      keyAvg: Number.isFinite(keyAvg) ? keyAvg : null,
      strategySamples,
      strategyAvg: Number.isFinite(strategyAvg) ? strategyAvg : null,
      ratioKey,
      ratioStrategy,
      ratioUsed,
      deweightSource,
    };

    if (this._deweightHardVetoEnabled && ratioUsed < 1) {
      this._log(meta, "[optimizer] hard veto enabled");
      return {
        ok: false,
        action: ACTION.HARD_BLOCK,
        reason: "OPT_DEWEIGHT_HARD_VETO",
        meta,
      };
    }

    let action = ACTION.PASS;
    if (confidenceMult < 1 || qtyMult < 1) {
      action = ACTION.SOFT_DEWEIGHT;
      this._log(meta, "[optimizer] soft deweight applied");
    } else if (rrUsed > rrBaseNum) {
      action = ACTION.RR_TUNE_ONLY;
      this._log(meta, "[optimizer] rr tune applied");
    }

    return { ok: true, action, reason: null, meta };
  }

  _resolveCloseContext(params = {}) {
    const ts = Number(params.startedAtTs) || Number(params.nowTs) || Date.now();
    const frozen = params.optimizerContext;
    if (frozen && typeof frozen === "object" && frozen.keyKey && frozen.stratKey) {
      return {
        context: {
          schemaVersion: Number(
            frozen.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
          ),
          keySchemaVersion:
            frozen.keySchemaVersion || this._keySchemaVersion,
          keyMode: frozen.keyMode || this._keyMode,
          underlying: frozen.underlying || null,
          optType: frozen.optType || NON_OPTION_TYPE,
          strategyId: frozen.strategyId || safeKey(params.strategyId, 64),
          bucket: frozen.bucket || this._bucket(ts),
          dteBand: frozen.dteBand || null,
          deltaBand: frozen.deltaBand || null,
          styleBand: frozen.styleBand || "DEFAULT",
          keyKey: frozen.keyKey,
          stratKey: frozen.stratKey,
        },
        optimizerContextFallback: false,
      };
    }

    return {
      context: this.buildOptimizerKeyContext({
        symbol: params.symbol,
        underlying: params.underlying,
        optType: params.optType,
        delta: params.delta,
        expiry: params.expiry,
        dte: params.dte,
        strategyId: params.strategyId,
        strategyStyle: params.strategyStyle,
        signalRegime: params.signalRegime,
        bucketTs: ts,
        nowTs: ts,
        optionMeta: params.optionMeta,
      }),
      optimizerContextFallback: true,
    };
  }

  recordTradeClose({
    symbol,
    underlying,
    optType,
    delta,
    expiry,
    dte,
    optionMeta,
    strategyId,
    strategyStyle,
    signalRegime,
    feeMultiple,
    startedAtTs,
    nowTs,
    optimizerContext,
    logFallback = true,
  }) {
    if (!this._enabled) return { ok: false, reason: "optimizer_disabled" };

    const fm = Number(feeMultiple);
    if (!Number.isFinite(fm)) return { ok: false, reason: "no_feeMultiple" };

    const started = Number(startedAtTs) || Number(nowTs) || Date.now();
    const ts = Number(nowTs) || Date.now();
    const resolved = this._resolveCloseContext({
      symbol,
      underlying,
      optType,
      delta,
      expiry,
      dte,
      optionMeta,
      strategyId,
      strategyStyle,
      signalRegime,
      startedAtTs: started,
      nowTs: ts,
      optimizerContext,
    });
    const context = resolved.context;

    if (resolved.optimizerContextFallback && logFallback) {
      this._log(
        {
          symbol: symbol || null,
          strategyId: strategyId || null,
          optimizerContextFallback: true,
        },
        "[optimizer] close learning used fallback context",
      );
    }

    const keyKey = context.keyKey;
    const stratKey = context.stratKey;
    const bucket = context.bucket;

    const wKey = this._getWindow(keyKey);
    const wStr = this._getWindow(stratKey);

    wKey.push(fm);
    wStr.push(fm);
    this._markStateDirty();

    const snapKey = wKey.snapshot();
    const snapStr = wStr.snapshot();

    const thr = this._feeMultipleMin;
    const scope = this._scope();

    if (
      scope.key &&
      snapKey.n >= this._minSamplesKey &&
      Number.isFinite(snapKey.avg) &&
      thr > 0
    ) {
      if (snapKey.avg < thr) {
        this._setBlocked(
          keyKey,
          ts,
          `avgFeeMultiple ${snapKey.avg.toFixed(2)} < ${thr}`,
          {
            ...snapKey,
            underlying: context.underlying,
            optType: context.optType,
            strategyId: context.strategyId,
            bucket,
            dteBand: context.dteBand,
            deltaBand: context.deltaBand,
          },
        );
        this._log({ keyKey, bucket, ...snapKey }, "[optimizer] auto-block key");
      } else if (this._blocked.has(keyKey)) {
        this._blocked.delete(keyKey);
        this._markStateDirty();
      }
    }

    if (
      scope.strategy &&
      snapStr.n >= this._minSamplesStrategy &&
      Number.isFinite(snapStr.avg) &&
      thr > 0
    ) {
      if (snapStr.avg < thr) {
        this._setBlocked(
          stratKey,
          ts,
          `avgFeeMultiple ${snapStr.avg.toFixed(2)} < ${thr}`,
          {
            ...snapStr,
            strategyId: context.strategyId,
            bucket,
            optType: context.optType,
            styleBand: context.styleBand,
          },
        );
        this._log(
          { stratKey, bucket, ...snapStr },
          "[optimizer] auto-block strategy",
        );
      } else if (this._blocked.has(stratKey)) {
        this._blocked.delete(stratKey);
        this._markStateDirty();
      }
    }

    return {
      ok: true,
      keyKey,
      stratKey,
      bucket,
      key: snapKey,
      strategy: snapStr,
      optimizerContextFallback: resolved.optimizerContextFallback,
    };
  }

  snapshot() {
    const windows = {};
    const blocked = {};

    for (const [k, w] of this._windows.entries()) {
      if (Object.keys(windows).length > 200) break;
      windows[k] = w.snapshot();
    }

    for (const [k, b] of this._blocked.entries()) {
      blocked[k] = {
        untilTs: b.untilTs,
        setAtTs: b.setAtTs,
        reason: b.reason,
        snapshot: b.snapshot || null,
      };
    }

    return {
      enabled: this._enabled,
      stateVersion: this._stateVersion,
      keySchemaVersion: this._keySchemaVersion,
      keyMode: this._keyMode,
      persist: {
        enabled: this._persistEnabled,
        loaded: this._stateLoaded,
        dirty: this._stateDirty,
        lastSavedAt: this._stateLastSavedAt,
      },
      totalWindowCount: this._windows.size,
      totalBlockedCount: this._blocked.size,
      lookbackN: this._lookbackN,
      feeMultipleMin: this._feeMultipleMin,
      minSamplesKey: this._minSamplesKey,
      minSamplesStrategy: this._minSamplesStrategy,
      blockTtlMin: this._blockTtlMin,
      deweightEnabled: this._deweightEnabled,
      deweightMinSamples: this._deMinSamples,
      deweightHardVetoEnabled: this._deweightHardVetoEnabled,
      rrTrendMin: this._rrTrendMin,
      rrWideSpreadMin: this._rrWideSpreadMin,
      spreadPenaltyBps: this._spreadPenaltyBps,
      spreadBlockBps: this._spreadBlockBps,
      spreadBlockEnabled: this._spreadBlockEnabled,
      spreadSoftAction: this._spreadSoftAction,
      buckets: {
        openEnd: this._bucketOpenEnd,
        closeStart: this._bucketCloseStart,
      },
      windows,
      blocked,
    };
  }

  reset() {
    this._windows.clear();
    this._blocked.clear();
    this._stateLoaded = false;
    this._markStateDirty();
    this._bootstrapped = false;
    this._bootstrapInFlight = null;
  }

  async start() {
    if (!this._enabled) return { ok: false, reason: "disabled" };

    this._startStateTimer();

    let loadedFromState = false;
    const skipPersistLoad = !!this._skipStateLoadOnce;
    this._skipStateLoadOnce = false;
    if (this._persistEnabled && !this._stateLoaded && !skipPersistLoad) {
      try {
        const r = await this.loadPersistedState();
        loadedFromState = !!(r && r.ok);
        if (loadedFromState) {
          this._logger.info(r, "[optimizer] loaded persisted state");
        }
      } catch (err) {
        reportFault({
          code: "OPTIMIZER_ADAPTIVEOPTIMIZER_CATCH",
          err,
          message: "[src/optimizer/adaptiveOptimizer.js] caught and continued",
        });
      }
    }

    const wantBootstrap = toBool(this._env.OPTIMIZER_BOOTSTRAP_FROM_DB, true);
    if (!wantBootstrap) {
      this._bootstrapped = true;
      return { ok: true, bootstrapped: false, loadedFromState };
    }

    if (this._bootstrapped) return { ok: true, bootstrapped: true };

    if (loadedFromState) {
      this._bootstrapped = true;
      return { ok: true, bootstrapped: true, loadedFromState };
    }

    if (this._bootstrapInFlight) return this._bootstrapInFlight;

    this._bootstrapInFlight = this._bootstrapFromDb()
      .then((r) => {
        this._bootstrapped = true;
        this._bootstrapInFlight = null;
        return r;
      })
      .catch((e) => {
        this._bootstrapInFlight = null;
        this._logger.warn(
          { e: e?.message },
          "[optimizer] bootstrap failed; continuing without",
        );
        return { ok: false, reason: "bootstrap_failed" };
      });

    return this._bootstrapInFlight;
  }

  async reloadFromDb() {
    this._skipStateLoadOnce = true;
    this.reset();
    return this.start();
  }

  async _bootstrapFromDb() {
    let db;
    try {
      db = this._dbGetter();
    } catch {
      return { ok: false, reason: "db_not_ready" };
    }

    const days = Number(this._env.OPT_BOOTSTRAP_DAYS ?? 7);
    const since = DateTime.now()
      .setZone(tz(this._env))
      .minus({ days: Math.max(1, days) })
      .toJSDate();

    const col = db.collection(TRADES_COLLECTION);
    const cursor = col
      .find(
        {
          createdAt: { $gte: since },
          feeMultiple: { $ne: null },
          strategyId: { $ne: null },
        },
        {
          projection: {
            createdAt: 1,
            closedAt: 1,
            updatedAt: 1,
            feeMultiple: 1,
            strategyId: 1,
            strategyStyle: 1,
            regime: 1,
            instrument: 1,
            optimizerContext: 1,
            option_meta: 1,
            underlying_symbol: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(Math.max(100, this._lookbackN * 40));

    let count = 0;
    while (await cursor.hasNext()) {
      const t = await cursor.next();
      const sym =
        t?.instrument?.tradingsymbol ||
        t?.instrument?.symbol ||
        t?.instrument?.name ||
        "UNKNOWN";

      const startedAt = t?.createdAt
        ? new Date(t.createdAt).getTime()
        : Date.now();
      const closedAt = t?.closedAt
        ? new Date(t.closedAt).getTime()
        : t?.updatedAt
          ? new Date(t.updatedAt).getTime()
          : Date.now();

      this.recordTradeClose({
        symbol: sym,
        underlying: t?.underlying_symbol || t?.option_meta?.underlying,
        optType: t?.option_meta?.optType,
        delta: t?.option_meta?.delta,
        expiry: t?.option_meta?.expiry,
        dte: t?.option_meta?.meta?.dteDays ?? t?.option_meta?.dteDays,
        optionMeta: t?.option_meta,
        strategyId: t?.strategyId || "UNKNOWN",
        strategyStyle: t?.strategyStyle || null,
        signalRegime: t?.regime || null,
        optimizerContext: t?.optimizerContext || null,
        feeMultiple: t?.feeMultiple,
        startedAtTs: startedAt,
        nowTs: closedAt,
        logFallback: false,
      });

      count += 1;
      if (count > this._lookbackN * 40) break;
    }

    this._logger.info({ count, days }, "[optimizer] bootstrapped from DB");
    return { ok: true, count, days };
  }
}

const optimizer = new AdaptiveOptimizer();

module.exports = {
  ACTION,
  AdaptiveOptimizer,
  buildOptimizerKeyContext,
  normalizeDeltaBand,
  normalizeDteBand,
  normalizeStyleBand,
  optimizer,
};
