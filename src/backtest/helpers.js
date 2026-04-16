const { execSync } = require("child_process");
const { DateTime } = require("luxon");
const { buildTradePlan } = require("../trading/planBuilder");
const { env } = require("../config");

function n(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

function toMs(value, fallback = null) {
  const dt = value instanceof Date ? value : new Date(value);
  const ts = dt.getTime();
  return Number.isFinite(ts) ? ts : fallback;
}

function pickEnvSnapshot() {
  const prefixes = [
    "STRATEGY_",
    "RR_",
    "RISK_",
    "DYN_",
    "OPT_",
    "COST_",
    "CANDLE_",
    "FNO_",
    "MIN_GREEN_",
    "TIME_STOP_",
    "BE_",
    "TRAIL_",
  ];
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) || ["NODE_ENV", "ALLOW_SYNTHETIC_SIGNALS"].includes(key)) {
      out[key] = value;
    }
  }
  return out;
}

function gitHash() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function buildCalibrationFallback() {
  return {
    sampleSize: 0,
    avgEntrySlipBps: 0,
    avgSpreadBps: 0,
    avgFillRatio: 1,
    avgFillLatencyMs: 0,
    source: "fallback",
  };
}

function resolveExitPrice({ side, candle, stopLoss, targetPrice, conservative = true }) {
  const high = n(candle?.high);
  const low = n(candle?.low);
  const close = n(candle?.close);
  const hasStop = Number.isFinite(stopLoss);
  const hasTarget = Number.isFinite(targetPrice);

  if (side === "BUY") {
    const stopHit = hasStop && Number.isFinite(low) && low <= stopLoss;
    const targetHit = hasTarget && Number.isFinite(high) && high >= targetPrice;
    if (stopHit && targetHit) {
      return { hit: true, reason: conservative ? "STOPLOSS" : "TARGET", price: conservative ? stopLoss : targetPrice };
    }
    if (stopHit) return { hit: true, reason: "STOPLOSS", price: stopLoss };
    if (targetHit) return { hit: true, reason: "TARGET", price: targetPrice };
  } else {
    const stopHit = hasStop && Number.isFinite(high) && high >= stopLoss;
    const targetHit = hasTarget && Number.isFinite(low) && low <= targetPrice;
    if (stopHit && targetHit) {
      return { hit: true, reason: conservative ? "STOPLOSS" : "TARGET", price: conservative ? stopLoss : targetPrice };
    }
    if (stopHit) return { hit: true, reason: "STOPLOSS", price: stopLoss };
    if (targetHit) return { hit: true, reason: "TARGET", price: targetPrice };
  }

  if (Number.isFinite(close)) return { hit: false, reason: null, price: close };
  return { hit: false, reason: null, price: null };
}

function isTargetEnabledForMode(mode, config) {
  if (typeof config?.strategy?.targetEnabled === "boolean") return config.strategy.targetEnabled;
  if (String(mode).toUpperCase() === "OPT") return String(env.OPT_TP_ENABLED || "false") === "true";
  return true;
}

function buildBacktestTradePlan({
  mode,
  config,
  intervalMin,
  replaySlice,
  baseCandle,
  pendingEntry,
  optionProvider,
  tradedCandle,
}) {
  const entryUnderlying = Number(baseCandle?.close);
  const regimeMeta = pendingEntry?.sig?.regimeMeta || null;
  const atr = Number(regimeMeta?.atr);
  const close = Number(regimeMeta?.close);
  const atrPctUnderlying =
    Number.isFinite(atr) && Number.isFinite(close) && close > 0 ? (atr / close) * 100 : null;
  const isOpt = String(mode).toUpperCase() === "OPT";

  const optionMeta = isOpt
    ? {
        strategyStyle: pendingEntry?.sig?.strategyStyle || null,
        optionType: pendingEntry?.selectedContract?.snapshot?.optionType || null,
        strike: Number(pendingEntry?.selectedContract?.selected?.strike ?? 0) || null,
        expiry: pendingEntry?.selectedContract?.selected?.expiry || null,
        delta: Number(pendingEntry?.selectedContract?.selected?.greeks?.delta),
        gamma: Number(pendingEntry?.selectedContract?.selected?.greeks?.gamma),
      }
    : null;

  const premiumCandles =
    isOpt && pendingEntry?.selectedContract?.selectedToken
      ? optionProvider?.getCandlesUpToTs?.(pendingEntry.selectedContract.selectedToken, baseCandle.ts) || null
      : null;

  return buildTradePlan({
    env,
    candles: replaySlice,
    premiumCandles,
    intervalMin,
    side: pendingEntry?.side,
    signalStyle: pendingEntry?.sig?.strategyStyle,
    signal: pendingEntry?.sig || null,
    instrument: pendingEntry?.instrument || null,
    regimeMeta,
    entryUnderlying,
    expectedMoveUnderlying: Number(regimeMeta?.expectedMovePerShare),
    atrPeriod: Number(env.EXPECTED_MOVE_ATR_PERIOD ?? 14),
    optionMeta,
    entryPremium: isOpt ? Number(tradedCandle?.close) : null,
    premiumTick: Number(pendingEntry?.selectedContract?.selected?.instrument?.tick_size ?? 0.05),
    atrPctUnderlying,
    rrFloorOverride: Number(config?.strategy?.rrTarget),
    nowTs: toMs(baseCandle?.ts, Date.now()),
  });
}

function evaluateEodBoundary({ candles, idx, intervalMin, timezone, forceEodExit }) {
  if (!forceEodExit) return { shouldExitNow: false, reason: null };
  const cur = candles[idx];
  const next = candles[idx + 1] || null;
  if (!cur) return { shouldExitNow: false, reason: null };
  if (!next) return { shouldExitNow: true, reason: "FORCE_EOD_DATA_END" };

  const curDt = DateTime.fromJSDate(new Date(cur.ts), { zone: timezone });
  const nextDt = DateTime.fromJSDate(new Date(next.ts), { zone: timezone });
  if (!curDt.isValid || !nextDt.isValid) return { shouldExitNow: false, reason: null };
  if (curDt.toFormat("yyyy-LL-dd") !== nextDt.toFormat("yyyy-LL-dd")) {
    return { shouldExitNow: true, reason: "FORCE_EOD_SESSION_BOUNDARY" };
  }
  const diff = nextDt.toMillis() - curDt.toMillis();
  if (diff > intervalMin * 60 * 1000) return { shouldExitNow: true, reason: "FORCE_EOD_GAP_BOUNDARY" };
  return { shouldExitNow: false, reason: null };
}

function upsertOptionManagedCandles({ optionProvider, token, ts, trade }) {
  if (!trade || !Number.isFinite(Number(token))) return [];
  if (!Array.isArray(trade._managedCandles)) {
    trade._managedCandles = optionProvider?.getCandlesUpToTs?.(token, ts) || [];
    const lastTs = trade._managedCandles.length
      ? new Date(trade._managedCandles[trade._managedCandles.length - 1].ts).getTime()
      : null;
    trade._lastManagedTs = Number.isFinite(lastTs) ? lastTs : null;
    return trade._managedCandles;
  }
  const next = optionProvider?.getCandleAtTs?.(token, ts) || null;
  const nextTs = new Date(ts).getTime();
  if (next && Number.isFinite(nextTs) && (!Number.isFinite(trade._lastManagedTs) || nextTs > trade._lastManagedTs)) {
    trade._managedCandles.push(next);
    trade._lastManagedTs = nextTs;
  }
  return trade._managedCandles;
}

function instrumentFromContract({ fallbackToken, fallbackInstrument, selected, mode }) {
  const selectedInstrument = selected?.instrument || null;
  const inferredMode = String(mode || "").toUpperCase();
  const token = Number(selected?.token ?? fallbackInstrument?.instrument_token ?? fallbackToken);
  const tick = Number(selectedInstrument?.tick_size ?? fallbackInstrument?.tick_size ?? 0.05);
  const lot = Number(selectedInstrument?.lot_size ?? fallbackInstrument?.lot_size ?? 1);
  const tradingsymbol =
    String(selectedInstrument?.tradingsymbol || fallbackInstrument?.tradingsymbol || "").toUpperCase() || null;
  const segmentRaw =
    String(selectedInstrument?.segment || fallbackInstrument?.segment || "").toUpperCase() ||
    (inferredMode === "OPT" ? "NFO-OPT" : inferredMode === "FUT" ? "NFO-FUT" : "NSE");
  const instrumentType =
    String(selectedInstrument?.instrument_type || fallbackInstrument?.instrument_type || "").toUpperCase() ||
    (inferredMode === "OPT" ? "CE" : inferredMode === "FUT" ? "FUT" : "EQ");
  return {
    instrument_token: token,
    tick_size: Number.isFinite(tick) && tick > 0 ? tick : 0.05,
    lot_size: Number.isFinite(lot) && lot > 0 ? lot : 1,
    tradingsymbol,
    segment: segmentRaw,
    instrument_type: instrumentType,
  };
}

function createRunId(name, seed, prefix = "bt") {
  const safe = String(name || "run")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "run";
  const stamp = DateTime.now().toFormat("yyyyLLdd_HHmmss");
  return `${prefix}_${safe}_${stamp}_s${Number(seed ?? 0)}`;
}

function asIso(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

module.exports = {
  asIso,
  buildBacktestTradePlan,
  buildCalibrationFallback,
  clamp01,
  createRunId,
  evaluateEodBoundary,
  gitHash,
  instrumentFromContract,
  isTargetEnabledForMode,
  n,
  pickEnvSnapshot,
  resolveExitPrice,
  toMs,
  upsertOptionManagedCandles,
};
