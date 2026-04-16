const { DateTime } = require("luxon");
const { buildPremiumAwareOptionPlan } = require("./optionPremiumPlanner");
const { roundToTick } = require("./priceUtils");
const { normalizeTickSize } = require("../utils/tickSize");
const { getStrategyMeta } = require("../strategy/registry");
const { getAdmissionProfile } = require("./admissionProfiles");

/**
 * Pro-style plan builder:
 *  - SL: structure + ATR (k by style), not too tight
 *  - Target: structure + ATR (m by style), reachable via expected move, meets minRR by style
 *  - Options: build plan on underlying, map to premium via abs(delta) approximation
 *
 * Returns:
 *  { ok, stopLoss, targetPrice, rr, expectedMovePerUnit, meta }
 */

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safePrice(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toTsMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeArr(value) {
  return Array.isArray(value) ? value : [];
}

function avg(values) {
  const numeric = safeArr(values).map((value) => Number(value)).filter(Number.isFinite);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      safeArr(values)
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function lastCandle(candles) {
  return Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null;
}

function prevCandle(candles) {
  return Array.isArray(candles) && candles.length > 1
    ? candles[candles.length - 2]
    : null;
}

function directionSign(side) {
  return String(side || "").toUpperCase() === "SELL" ? -1 : 1;
}

function directionalDistance(side, from, to) {
  const start = safeNum(from);
  const end = safeNum(to);
  if (!(Number.isFinite(start) && Number.isFinite(end))) return null;
  return directionSign(side) > 0 ? end - start : start - end;
}

function inTradeDirection(side, from, to) {
  const dist = directionalDistance(side, from, to);
  return Number.isFinite(dist) ? dist > 0 : false;
}

function resolveSetupFamily(strategyId) {
  const id = String(strategyId || "").trim().toLowerCase();
  if (
    [
      "ema_cross",
      "ema_pullback",
      "breakout",
      "vwap_reclaim",
      "orb",
      "fakeout",
      "wick_reversal",
      "rsi_fade",
    ].includes(id)
  ) {
    return id;
  }
  if (["bb_squeeze", "volume_spike"].includes(id)) return "breakout";
  return "generic";
}

function resolveSetupFamilyFromContext({ strategyId, signalMeta, strategyMeta, signal }) {
  const directFamily = resolveSetupFamily(strategyId);
  if (directFamily !== "generic") return directFamily;

  const triggerType = String(
    signalMeta?.triggerType || signal?.triggerType || "",
  ).toUpperCase();
  if (triggerType.includes("BREAKOUT") || triggerType.includes("BREAKDOWN")) {
    return "breakout";
  }
  if (triggerType.includes("VWAP")) return "vwap_reclaim";
  if (
    triggerType.includes("EMA_RECLAIM") ||
    triggerType.includes("EMA_REJECT") ||
    Number.isFinite(safeNum(signalMeta?.pullbackAnchor, null)) ||
    Number.isFinite(safeNum(signalMeta?.trendAnchor, null))
  ) {
    return "ema_pullback";
  }
  if (
    Number.isFinite(safeNum(signalMeta?.orbHigh, null)) ||
    Number.isFinite(safeNum(signalMeta?.orbLow, null))
  ) {
    return "orb";
  }
  if (Number.isFinite(safeNum(signalMeta?.wickExtreme, null))) {
    if (String(strategyId || "").toLowerCase() === "rsi_fade") return "rsi_fade";
    return "wick_reversal";
  }
  if (String(strategyMeta?.family || "").toUpperCase() === "BREAKOUT") {
    return "breakout";
  }
  return "generic";
}

function resolvePlannerTriggerLevel({ family, side, signal, signalMeta, rangeHigh, rangeLow, orbComputed, vwapValue }) {
  const directTrigger = safePrice(
    signalMeta?.triggerLevel ??
      signal?.triggerLevel ??
      signalMeta?.brokenLevel ??
      signalMeta?.wickExtreme,
    null,
  );
  if (Number.isFinite(directTrigger)) return directTrigger;

  if (family === "ema_pullback" || family === "ema_cross") {
    return safePrice(
      signalMeta?.pullbackAnchor ??
        signalMeta?.anchorValue ??
        signal?.anchorValue ??
        signalMeta?.trendAnchor,
      null,
    );
  }
  if (family === "breakout") {
    return safePrice(side === "BUY" ? rangeHigh : rangeLow, null);
  }
  if (family === "orb") {
    return safePrice(
      side === "BUY"
        ? safeNum(signalMeta?.orbHigh, safeNum(orbComputed?.high, null))
        : safeNum(signalMeta?.orbLow, safeNum(orbComputed?.low, null)),
      null,
    );
  }
  if (family === "vwap_reclaim") {
    return safePrice(vwapValue, null);
  }
  return null;
}

function resolvePlannerAnchorType({ family, signal, signalMeta }) {
  if (signalMeta?.anchorType || signal?.anchorType) {
    return signalMeta?.anchorType || signal?.anchorType || null;
  }
  if (family === "ema_pullback" || family === "ema_cross") return "EMA_FAST";
  if (family === "breakout") return "SESSION_RANGE";
  if (family === "vwap_reclaim") return "SESSION_VWAP";
  if (family === "orb") return "ORB_BOUNDARY";
  return null;
}

function resolvePlannerAnchorValue({
  family,
  side,
  signal,
  signalMeta,
  rangeHigh,
  rangeLow,
  orbComputed,
  vwapValue,
  triggerLevel,
}) {
  const directAnchor = safePrice(
    signalMeta?.anchorValue ??
      signalMeta?.pullbackAnchor ??
      signalMeta?.trendAnchor ??
      signal?.anchorValue,
    null,
  );
  if (Number.isFinite(directAnchor)) return directAnchor;

  if (family === "breakout") {
    return safePrice(side === "BUY" ? rangeHigh : rangeLow, triggerLevel);
  }
  if (family === "orb") {
    return safePrice(
      side === "BUY"
        ? safeNum(signalMeta?.orbHigh, safeNum(orbComputed?.high, null))
        : safeNum(signalMeta?.orbLow, safeNum(orbComputed?.low, null)),
      triggerLevel,
    );
  }
  if (family === "vwap_reclaim") {
    return safePrice(vwapValue, triggerLevel);
  }
  if (family === "ema_pullback" || family === "ema_cross") {
    return safePrice(
      signalMeta?.pullbackAnchor ??
        signalMeta?.trendAnchor ??
        triggerLevel,
      null,
    );
  }
  return Number.isFinite(triggerLevel) ? triggerLevel : null;
}

const FAMILY_SETTINGS = {
  ema_cross: { maxFreshnessBars: 2, chaseAtr: 0.55, warningAtr: 0.4, maxExtensionAtr: 1.2 },
  ema_pullback: { maxFreshnessBars: 2, chaseAtr: 0.45, warningAtr: 0.35, maxExtensionAtr: 1.05 },
  breakout: { maxFreshnessBars: 2, chaseAtr: 0.65, warningAtr: 0.5, maxExtensionAtr: 1.35 },
  vwap_reclaim: { maxFreshnessBars: 2, chaseAtr: 0.4, warningAtr: 0.3, maxExtensionAtr: 1.0 },
  orb: { maxFreshnessBars: 3, chaseAtr: 0.6, warningAtr: 0.45, maxExtensionAtr: 1.3 },
  fakeout: { maxFreshnessBars: 2, chaseAtr: 0.45, warningAtr: 0.35, maxExtensionAtr: 1.0 },
  wick_reversal: { maxFreshnessBars: 2, chaseAtr: 0.35, warningAtr: 0.25, maxExtensionAtr: 0.9 },
  rsi_fade: { maxFreshnessBars: 2, chaseAtr: 0.45, warningAtr: 0.3, maxExtensionAtr: 1.0 },
  generic: { maxFreshnessBars: 3, chaseAtr: 0.6, warningAtr: 0.45, maxExtensionAtr: 1.25 },
};

function familyConfig(family) {
  return FAMILY_SETTINGS[family] || FAMILY_SETTINGS.generic;
}

function atrLast(candles, period = 14) {
  const p = Math.max(2, Number(period ?? 14));
  if (!Array.isArray(candles) || candles.length < p + 2) return null;
  let trs = [];
  for (let i = candles.length - p; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    const high = safeNum(c?.high);
    const low = safeNum(c?.low);
    const prevClose = safeNum(prev?.close);
    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(prevClose)
    )
      continue;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trs.push(tr);
  }
  if (!trs.length) return null;
  const avg = trs.reduce((a, b) => a + b, 0) / trs.length;
  return Number.isFinite(avg) ? avg : null;
}

function tz(env) {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function dayKey(ts, env) {
  const ms = toTsMs(ts);
  if (!Number.isFinite(ms)) return null;
  return DateTime.fromMillis(ms, { zone: tz(env) }).toFormat("yyyy-LL-dd");
}

function minutesOfDay(ts, env) {
  const ms = toTsMs(ts);
  if (!Number.isFinite(ms)) return null;
  const dt = DateTime.fromMillis(ms, { zone: tz(env) });
  return dt.hour * 60 + dt.minute;
}

function hhmmToMinutes(hhmm) {
  const s = String(hhmm || "").trim();
  const m = /^([0-2]?\d):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function computePrevDayLevels(candles, env) {
  if (!Array.isArray(candles) || candles.length < 50) return null;

  const groups = new Map();
  for (const c of candles) {
    const dk = dayKey(c?.ts, env);
    if (!dk) continue;
    if (!groups.has(dk)) groups.set(dk, []);
    groups.get(dk).push(c);
  }
  const keys = Array.from(groups.keys()).sort();
  if (keys.length < 2) return null;

  const prev = keys[keys.length - 2];
  const arr = groups.get(prev) || [];
  if (!arr.length) return null;

  let high = -Infinity,
    low = Infinity;
  for (const c of arr) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    if (Number.isFinite(h)) high = Math.max(high, h);
    if (Number.isFinite(l)) low = Math.min(low, l);
  }
  const close = safeNum(arr[arr.length - 1]?.close);
  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  )
    return null;

  const P = (high + low + close) / 3;
  const R1 = 2 * P - low;
  const S1 = 2 * P - high;
  const R2 = P + (high - low);
  const S2 = P - (high - low);

  return {
    prevDayKey: prev,
    PDH: high,
    PDL: low,
    PDC: close,
    pivots: { P, R1, S1, R2, S2 },
  };
}

function vwap(candles, lookback = 120) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const n = Math.max(5, Number(lookback ?? 120));
  const tail = candles.slice(-n);
  let pv = 0;
  let v = 0;
  for (const c of tail) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    const cl = safeNum(c?.close);
    const vol = safeNum(c?.volume, 0);
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(l) ||
      !Number.isFinite(cl) ||
      !Number.isFinite(vol)
    )
      continue;
    const tp = (h + l + cl) / 3;
    pv += tp * vol;
    v += vol;
  }
  if (!v) return null;
  return pv / v;
}

function computeOpeningRange(candles, env, intervalMin) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const openMin = hhmmToMinutes(env.MARKET_OPEN || "09:15");
  if (openMin == null) return null;
  const win = Math.max(5, Number(env.SELECTOR_OPEN_WINDOW_MIN ?? 20));
  const endMin = openMin + win;
  const todayKey = dayKey(lastCandle(candles)?.ts, env);

  const todays = candles.filter((c) => {
    if (dayKey(c?.ts, env) !== todayKey) return false;
    const m = minutesOfDay(c?.ts, env);
    return m >= openMin && m < endMin;
  });

  if (todays.length < 2) return null;

  let high = -Infinity,
    low = Infinity;
  for (const c of todays) {
    const h = safeNum(c?.high);
    const l = safeNum(c?.low);
    if (Number.isFinite(h)) high = Math.max(high, h);
    if (Number.isFinite(l)) low = Math.min(low, l);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return { high, low, count: todays.length, windowMin: win };
}

function styleOf(signalStyle) {
  const s = String(signalStyle || "").toUpperCase();
  if (s.includes("TREND")) return "TREND";
  if (s.includes("RANGE")) return "RANGE";
  if (s.includes("OPEN")) return "OPEN";
  return "DEFAULT";
}

function pickK(env, style) {
  if (style === "TREND") return safeNum(env.PLAN_SL_ATR_K_TREND, 0.8);
  if (style === "RANGE") return safeNum(env.PLAN_SL_ATR_K_RANGE, 0.6);
  if (style === "OPEN") return safeNum(env.PLAN_SL_ATR_K_OPEN, 1.0);
  return safeNum(env.PLAN_SL_ATR_K_DEFAULT, 0.8);
}

function pickM(env, style) {
  if (style === "TREND") return safeNum(env.PLAN_TARGET_ATR_M_TREND, 1.4);
  if (style === "RANGE") return safeNum(env.PLAN_TARGET_ATR_M_RANGE, 0.9);
  if (style === "OPEN") return safeNum(env.PLAN_TARGET_ATR_M_OPEN, 1.2);
  return safeNum(env.PLAN_TARGET_ATR_M_DEFAULT, 1.2);
}

function minRR(env, style) {
  if (style === "TREND") return safeNum(env.STYLE_MIN_RR_TREND, 1.6);
  if (style === "RANGE") return safeNum(env.STYLE_MIN_RR_RANGE, 1.3);
  if (style === "OPEN") return safeNum(env.STYLE_MIN_RR_OPEN, 1.4);
  return safeNum(env.STYLE_MIN_RR_DEFAULT, 1.4);
}

function optionAbsDelta(env, optionMeta) {
  const m = String(
    optionMeta?.moneyness || env.OPT_MONEYNESS || "ATM",
  ).toUpperCase();
  if (m === "ITM") return safeNum(env.OPT_DELTA_ITM, 0.65);
  if (m === "OTM") return safeNum(env.OPT_DELTA_OTM, 0.4);
  return safeNum(env.OPT_DELTA_ATM, 0.5);
}

function daysToExpiry(optionMeta, nowTs = Date.now()) {
  const exp = optionMeta?.expiry;
  if (!exp) return null;
  const d = new Date(exp);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date(Number(nowTs));
  const diff = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return Number.isFinite(diff) ? diff : null;
}

function currentSessionCandles(candles, env) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const currentDay = dayKey(lastCandle(candles)?.ts, env);
  if (!currentDay) return candles;
  return candles.filter((candle) => dayKey(candle?.ts, env) === currentDay);
}

function inferFreshnessBars({ signal, signalMeta, intervalMin, family }) {
  const directAge = safeNum(
    signal?.candidateAgeBars ??
      signalMeta?.candidateAgeBars ??
      signalMeta?.orbAgeBars,
    null,
  );
  if (Number.isFinite(directAge)) return Math.max(0, Math.round(directAge));

  const eventTs = toTsMs(
    signal?.signalEventTs || signal?.signalDecisionTs || signal?.signalCreatedAt,
  );
  const candleTs = toTsMs(signal?.candle?.ts || signal?.ts);
  if (
    Number.isFinite(eventTs) &&
    Number.isFinite(candleTs) &&
    Number.isFinite(intervalMin) &&
    intervalMin > 0
  ) {
    return Math.max(
      0,
      Math.floor((candleTs - eventTs) / (intervalMin * 60_000)),
    );
  }

  const freshnessScore = safeNum(signalMeta?.freshness ?? signal?.freshness, 84);
  const config = familyConfig(family);
  if (freshnessScore >= 88) return 0;
  if (freshnessScore >= 78) return 1;
  if (freshnessScore >= 64) return Math.min(2, config.maxFreshnessBars);
  if (freshnessScore >= 52) return Math.min(3, config.maxFreshnessBars + 1);
  return config.maxFreshnessBars + 2;
}

function findRecentPivot(candles, side, lookback = 20, strength = 2) {
  const bars = safeArr(candles);
  if (bars.length < strength * 2 + 3) return null;
  const tail = bars.slice(-Math.max(lookback, strength * 2 + 3));
  for (let i = tail.length - strength - 1; i >= strength; i -= 1) {
    const candle = tail[i];
    const price = side === "LOW" ? safeNum(candle?.low) : safeNum(candle?.high);
    if (!Number.isFinite(price)) continue;

    let isPivot = true;
    for (let offset = 1; offset <= strength; offset += 1) {
      const left = safeNum(
        tail[i - offset]?.[side === "LOW" ? "low" : "high"],
      );
      const right = safeNum(
        tail[i + offset]?.[side === "LOW" ? "low" : "high"],
      );
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        isPivot = false;
        break;
      }
      if (side === "LOW") {
        if (!(price <= left && price <= right)) {
          isPivot = false;
          break;
        }
      } else if (!(price >= left && price >= right)) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) return { price, ts: candle?.ts || null };
  }
  return null;
}

function computeSessionTiming(ts, env) {
  const currentMin = minutesOfDay(ts, env);
  const openMin = hhmmToMinutes(env?.MARKET_OPEN || "09:15");
  const closeMin = hhmmToMinutes(env?.MARKET_CLOSE || "15:30");
  if (
    !Number.isFinite(currentMin) ||
    !Number.isFinite(openMin) ||
    !Number.isFinite(closeMin)
  ) {
    return {
      minutesFromOpen: null,
      minutesToClose: null,
      lateSession: false,
    };
  }
  return {
    minutesFromOpen: currentMin - openMin,
    minutesToClose: closeMin - currentMin,
    lateSession: closeMin - currentMin <= 30,
  };
}

function resolveSpreadAbs(currentPrice, quote, optionMeta) {
  const bid = safeNum(quote?.bid);
  const ask = safeNum(quote?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid) {
    return ask - bid;
  }

  const bps = safeNum(quote?.bps ?? optionMeta?.bps, null);
  if (Number.isFinite(bps) && Number.isFinite(currentPrice) && currentPrice > 0) {
    return (currentPrice * bps) / 10000;
  }
  return null;
}

function buildPlannerContext(args, legacyPlan) {
  const admissionSnapshot = args.admissionSnapshot || null;
  const signal = args.signal || null;
  const signalMeta = signal?.meta || {};
  const strategyId =
    admissionSnapshot?.strategyId ||
    signal?.strategyId ||
    signalMeta?.strategyId ||
    args.strategyId ||
    args.optionMeta?.strategyId ||
    null;
  const strategyMeta = getStrategyMeta(strategyId);
  const candles = safeArr(args.candles);
  const intervalMin = Math.max(
    1,
    Number(args.intervalMin ?? signal?.intervalMin ?? signal?.candle?.interval_min ?? 1),
  );
  const side = String(args.side || signal?.side || "").toUpperCase();
  const style = styleOf(
    args.signalStyle ||
      admissionSnapshot?.style ||
      signal?.strategyStyle ||
      strategyMeta?.style ||
      args.optionMeta?.strategyStyle ||
      args.optionMeta?.style,
  );
  const admissionProfile =
    admissionSnapshot?.profile || getAdmissionProfile(strategyId, style);
  const family =
    admissionSnapshot?.family ||
    resolveSetupFamilyFromContext({
      strategyId,
      signalMeta,
      strategyMeta,
      signal,
    });
  const config = familyConfig(family);
  const last = signal?.candle || lastCandle(candles);
  const previous = prevCandle(candles);
  const currentPrice = safePrice(
    args.entryUnderlying ??
      signal?.underlying_ltp ??
      signal?.candle?.close ??
      last?.close,
    null,
  );
  const tickSize = normalizeTickSize(args.instrument?.tick_size ?? 0.05) || 0.05;
  const atr = safeNum(
    atrLast(candles, args.atrPeriod || safeNum(args.env?.EXPECTED_MOVE_ATR_PERIOD, 14)),
    null,
  );
  const sessionBars = currentSessionCandles(candles, args.env);
  const sessionTail = sessionBars.length ? sessionBars : candles;
  const swingLookback = Math.max(10, Number(args.env?.PLAN_SWING_LOOKBACK ?? 60));
  const rangeLookback = Math.max(10, Number(args.env?.PLAN_RANGE_LOOKBACK ?? 30));
  const tailSwing = sessionTail.slice(-swingLookback);
  const tailRange = sessionTail.slice(-rangeLookback);
  const recentHigh = Math.max(
    ...tailSwing.map((candle) => safeNum(candle?.high, -Infinity)),
  );
  const recentLow = Math.min(
    ...tailSwing.map((candle) => safeNum(candle?.low, Infinity)),
  );
  const rangeHigh = safePrice(
    signalMeta?.rangeHigh,
    Math.max(...tailRange.map((candle) => safeNum(candle?.high, -Infinity))),
  );
  const rangeLow = safePrice(
    signalMeta?.rangeLow,
    Math.min(...tailRange.map((candle) => safeNum(candle?.low, Infinity))),
  );
  const rangeMid =
    Number.isFinite(rangeHigh) && Number.isFinite(rangeLow)
      ? (rangeHigh + rangeLow) / 2
      : null;
  const prevDay = computePrevDayLevels(candles, args.env);
  const orbComputed = computeOpeningRange(candles, args.env, intervalMin);
  const vwapValue = safePrice(
    signalMeta?.anchorType === "SESSION_VWAP" ? signalMeta?.anchorValue : null,
    vwap(sessionTail, safeNum(args.env?.VWAP_LOOKBACK, 120)),
  );
  const quote = args.quote || {};
  const triggerLevelBase = resolvePlannerTriggerLevel({
    family,
    side,
    signal,
    signalMeta,
    rangeHigh,
    rangeLow,
    orbComputed,
    vwapValue,
  });
  const triggerLevel = safePrice(admissionSnapshot?.triggerLevel, triggerLevelBase);
  const anchorValue = resolvePlannerAnchorValue({
    family,
    side,
    signal,
    signalMeta,
    rangeHigh,
    rangeLow,
    orbComputed,
    vwapValue,
    triggerLevel,
  });
  const anchorType =
    admissionSnapshot?.anchorType ||
    resolvePlannerAnchorType({ family, signal, signalMeta });
  const resolvedAnchorValue = safePrice(admissionSnapshot?.anchorValue, anchorValue);
  const triggerType =
    admissionSnapshot?.triggerType ||
    signalMeta?.triggerType ||
    signal?.triggerType ||
    (family === "ema_pullback" || family === "ema_cross"
      ? side === "BUY"
        ? "EMA_RECLAIM"
        : "EMA_REJECT"
      : family === "breakout"
        ? side === "BUY"
          ? "SESSION_BREAKOUT"
          : "SESSION_BREAKDOWN"
        : family === "vwap_reclaim"
          ? side === "BUY"
            ? "VWAP_RECLAIM"
            : "VWAP_REJECT"
          : null);

  const context = {
    env: args.env || {},
    candles,
    premiumCandles: safeArr(args.premiumCandles),
    intervalMin,
    side,
    style,
    strategyId,
    strategyMeta,
    admissionProfile,
    admissionSnapshot,
    family,
    config,
    signal,
    signalMeta,
    quote,
    instrument: args.instrument || null,
    optionMeta: args.optionMeta || null,
    currentPrice,
    entryUnderlying: safePrice(args.entryUnderlying, currentPrice),
    entryPremium: safeNum(args.entryPremium, null),
    premiumTick: safeNum(args.premiumTick, null),
    atr,
    atrPctUnderlying: safeNum(args.atrPctUnderlying, null),
    expectedMoveUnderlying: safeNum(args.expectedMoveUnderlying, null),
    requiredMinRr: Number.isFinite(Number(args.rrFloorOverride))
      ? Math.max(minRR(args.env, style), Number(args.rrFloorOverride))
      : minRR(args.env, style),
    k: pickK(args.env, style),
    m: pickM(args.env, style),
    signalReason: signal?.reason || null,
    signalConfidence: safeNum(signal?.confidence, null),
    regime:
      signal?.regime ||
      signal?.regimeSnapshot?.regime ||
      signal?.regimeSnapshot?.primaryRegime ||
      args.regimeMeta?.regime ||
      null,
    setupState: signal?.setupState || signalMeta?.setupState || null,
    triggerType,
    triggerLevel,
    anchorType,
    anchorValue: resolvedAnchorValue,
    retestState: signalMeta?.retestState || null,
    brokenLevel: safePrice(signalMeta?.brokenLevel, triggerLevel),
    wickExtreme: safePrice(signalMeta?.wickExtreme, triggerLevel),
    reversalZone: signalMeta?.reversalZone || null,
    trendAnchor: safePrice(signalMeta?.trendAnchor, null),
    setupFreshnessScore: safeNum(signalMeta?.freshness ?? signal?.freshness, 84),
    setupFreshnessBars: inferFreshnessBars({
      signal,
      signalMeta,
      intervalMin,
      family,
    }),
    volumeQuality: safeNum(signalMeta?.volumeQuality, 55),
    structureQuality: safeNum(signalMeta?.structureQuality, 55),
    patternQuality: safeNum(signalMeta?.patternQuality, 55),
    anchorQuality: safeNum(signalMeta?.anchorQuality, 55),
    spreadBps: safeNum(quote?.bps ?? args.optionMeta?.bps, null),
    spreadAbs: resolveSpreadAbs(currentPrice, quote, args.optionMeta),
    tickSize,
    lastCandle: last,
    prevCandle: previous,
    recentHigh: safePrice(recentHigh, null),
    recentLow: safePrice(recentLow, null),
    pivotHigh: safePrice(findRecentPivot(candles, "HIGH", swingLookback)?.price, null),
    pivotLow: safePrice(findRecentPivot(candles, "LOW", swingLookback)?.price, null),
    rangeHigh: safePrice(rangeHigh, null),
    rangeLow: safePrice(rangeLow, null),
    rangeMid: Number.isFinite(rangeMid) ? rangeMid : null,
    vwap: safePrice(vwapValue, null),
    prevDay,
    orb:
      Number.isFinite(signalMeta?.orbHigh) || Number.isFinite(signalMeta?.orbLow) || orbComputed
        ? {
            high: safeNum(signalMeta?.orbHigh, safeNum(orbComputed?.high, null)),
            low: safeNum(signalMeta?.orbLow, safeNum(orbComputed?.low, null)),
            range:
              Number.isFinite(safeNum(signalMeta?.orbHigh, null)) &&
              Number.isFinite(safeNum(signalMeta?.orbLow, null))
                ? safeNum(signalMeta?.orbHigh, null) - safeNum(signalMeta?.orbLow, null)
                : safeNum(orbComputed?.high, null) - safeNum(orbComputed?.low, null),
            ageBars: safeNum(signalMeta?.orbAgeBars, null),
          }
        : null,
    sessionTiming: computeSessionTiming(signal?.candle?.ts || last?.ts || args.nowTs, args.env),
    nowTs: args.nowTs || Date.now(),
    logger: args.logger || null,
    legacyPlan,
    admissionReadiness: admissionSnapshot?.readiness || null,
  };

  const missingContextFlags = [];
  if (!Number.isFinite(context.currentPrice)) missingContextFlags.push("MISSING_CURRENT_PRICE");
  if (!Number.isFinite(context.atr)) missingContextFlags.push("MISSING_ATR");
  if (!context.strategyId) missingContextFlags.push("MISSING_STRATEGY_ID");
  if (!context.triggerType) missingContextFlags.push("MISSING_TRIGGER_TYPE");
  if (!Number.isFinite(context.anchorValue)) missingContextFlags.push("MISSING_ANCHOR_VALUE");
  if (!Number.isFinite(context.triggerLevel)) missingContextFlags.push("MISSING_TRIGGER_LEVEL");
  context.missingContextFlags = uniqueStrings(missingContextFlags);
  return context;
}

function buildLegacyTradePlan({
  env,
  candles,
  premiumCandles,
  intervalMin,
  side, // underlying BUY/SELL
  signalStyle,
  entryUnderlying,
  expectedMoveUnderlying,
  atrPeriod,
  optionMeta, // if present => map to premium
  entryPremium,
  premiumTick,
  atrPctUnderlying,
  rrFloorOverride,
  nowTs = Date.now(),
}) {
  const dir = String(side || "").toUpperCase();
  if (dir !== "BUY" && dir !== "SELL")
    return { ok: false, reason: "invalid_side" };
  if (!Array.isArray(candles) || candles.length < 30)
    return { ok: false, reason: "insufficient_candles" };

  const style = styleOf(
    signalStyle || optionMeta?.strategyStyle || optionMeta?.style || null,
  );
  const k = pickK(env, style);
  const m = pickM(env, style);
  const styleMinRr = minRR(env, style);
  const rrOverride = safeNum(rrFloorOverride, null);
  const effectiveMinRr = Number.isFinite(rrOverride)
    ? Math.max(styleMinRr, rrOverride)
    : styleMinRr;

  const entryU = safeNum(entryUnderlying);
  if (!Number.isFinite(entryU) || entryU <= 0)
    return { ok: false, reason: "bad_entry" };

  const atr = safeNum(
    atrLast(candles, atrPeriod || safeNum(env.EXPECTED_MOVE_ATR_PERIOD, 14)),
    null,
  );
  const noiseMinMult = safeNum(env.PLAN_SL_NOISE_ATR_MIN_MULT, 0.25);

  const swingLookback = Math.max(20, Number(env.PLAN_SWING_LOOKBACK ?? 60));
  const rangeLookback = Math.max(20, Number(env.PLAN_RANGE_LOOKBACK ?? 30));

  const tailSwing = candles.slice(-swingLookback);
  const tailRange = candles.slice(-rangeLookback);

  const swingLow = Math.min(...tailSwing.map((c) => safeNum(c.low, Infinity)));
  const swingHigh = Math.max(
    ...tailSwing.map((c) => safeNum(c.high, -Infinity)),
  );

  const rangeLow = Math.min(...tailRange.map((c) => safeNum(c.low, Infinity)));
  const rangeHigh = Math.max(
    ...tailRange.map((c) => safeNum(c.high, -Infinity)),
  );

  const orb = computeOpeningRange(candles, env, intervalMin);

  const atrSL =
    dir === "BUY"
      ? entryU - (safeNum(atr, 0) || 0) * k
      : entryU + (safeNum(atr, 0) || 0) * k;

  const structureSL =
    dir === "BUY"
      ? Math.min(
          Number.isFinite(swingLow) ? swingLow : Infinity,
          Number.isFinite(rangeLow) ? rangeLow : Infinity,
          Number.isFinite(orb?.low) ? orb.low : Infinity,
        )
      : Math.max(
          Number.isFinite(swingHigh) ? swingHigh : -Infinity,
          Number.isFinite(rangeHigh) ? rangeHigh : -Infinity,
          Number.isFinite(orb?.high) ? orb.high : -Infinity,
        );

  let stopU = Number.isFinite(structureSL) ? structureSL : atrSL;
  let slReason = Number.isFinite(structureSL) ? "STRUCTURE" : "ATR";

  if (dir === "BUY" && stopU >= entryU) {
    stopU = atrSL;
    slReason = "ATR_FALLBACK";
  }
  if (dir === "SELL" && stopU <= entryU) {
    stopU = atrSL;
    slReason = "ATR_FALLBACK";
  }

  if (Number.isFinite(atr) && atr > 0) {
    const riskU = Math.abs(entryU - stopU);
    if (riskU < noiseMinMult * atr) {
      stopU = atrSL;
      slReason = "ATR_NOISE_WIDEN";
    }
  }

  // Targets
  const prev = computePrevDayLevels(candles, env);
  const vw = vwap(candles, safeNum(env.VWAP_LOOKBACK, 120));
  const rangeMid =
    Number.isFinite(rangeHigh) && Number.isFinite(rangeLow)
      ? (rangeHigh + rangeLow) / 2
      : null;

  const atrTargetU =
    dir === "BUY"
      ? entryU + (safeNum(atr, 0) || 0) * m
      : entryU - (safeNum(atr, 0) || 0) * m;

  const candidates = [];
  const add = (level, tag) => {
    const lv = safeNum(level);
    if (!Number.isFinite(lv)) return;
    candidates.push({ level: lv, tag });
  };

  if (dir === "BUY") {
    add(prev?.PDH, "PDH");
    add(prev?.pivots?.R1, "R1");
    add(prev?.pivots?.R2, "R2");
    add(swingHigh, "SWING_HIGH");
    add(rangeHigh, "RANGE_HIGH");
    if (style === "RANGE") {
      add(vw, "VWAP");
      add(rangeMid, "RANGE_MID");
    }
    add(atrTargetU, "ATR_TARGET");
  } else {
    add(prev?.PDL, "PDL");
    add(prev?.pivots?.S1, "S1");
    add(prev?.pivots?.S2, "S2");
    add(swingLow, "SWING_LOW");
    add(rangeLow, "RANGE_LOW");
    if (style === "RANGE") {
      add(vw, "VWAP");
      add(rangeMid, "RANGE_MID");
    }
    add(atrTargetU, "ATR_TARGET");
  }

  const filtered = candidates
    .filter((c) => (dir === "BUY" ? c.level > entryU : c.level < entryU))
    .sort((a, b) => Math.abs(a.level - entryU) - Math.abs(b.level - entryU));

  const R = Math.abs(entryU - stopU);
  if (!Number.isFinite(R) || R <= 0) return { ok: false, reason: "bad_stop" };

  const em = safeNum(expectedMoveUnderlying, null);
  const reachMult = safeNum(env.PLAN_TARGET_EXPECTED_MOVE_MULT, 1.3);

  let chosen = null;
  for (const cand of filtered) {
    const dist = Math.abs(cand.level - entryU);
    if (Number.isFinite(em) && em > 0 && dist > em * reachMult) continue;
    const rr = dist / R;
    if (rr >= effectiveMinRr) {
      chosen = { ...cand, rr, dist, R };
      break;
    }
  }

  if (!chosen) {
    const dist = Math.abs(atrTargetU - entryU);
    const rr = dist / R;
    if (rr >= effectiveMinRr && Number.isFinite(dist) && dist > 0) {
      chosen = { level: atrTargetU, tag: "ATR_TARGET_FALLBACK", rr, dist, R };
    }
  }

  if (!chosen)
    return {
      ok: false,
      reason: "no_target_meets_minRR",
      meta: { minRr: effectiveMinRr, styleMinRr, effectiveMinRr, R },
    };

  const targetU = chosen.level;
  const rrUnderlying = chosen.rr;

  let stop = stopU;
  let target = targetU;
  let rrFinal = rrUnderlying;
  let expectedMovePerUnit = em;

  const meta = {
    style,
    k,
    m,
    minRr: effectiveMinRr,
    styleMinRr,
    effectiveMinRr,
    slReason,
    targetReason: chosen.tag,
    rrUnderlying,
    underlying: { entry: entryU, stop: stopU, target: targetU, R },
    prevDay: prev
      ? {
          PDH: prev.PDH,
          PDL: prev.PDL,
          pivots: prev.pivots,
          prevDayKey: prev.prevDayKey,
        }
      : null,
    vwap: Number.isFinite(vw) ? vw : null,
    orb,
  };

  if (optionMeta) {
    const premEntry = safeNum(entryPremium);
    if (!Number.isFinite(premEntry) || premEntry <= 0)
      return { ok: false, reason: "bad_premium_entry" };

    const t = normalizeTickSize(premiumTick);
    if (!Number.isFinite(t)) return { ok: false, reason: "NO_TICK_SIZE" };

    // ----------------------------
    // 1) Underlying -> premium map (fallback / reference)
    // ----------------------------
    const delta = safeNum(optionMeta?.delta, null);
    const gamma = safeNum(optionMeta?.gamma, null);

    const deltaAbsRaw = Number.isFinite(delta) ? Math.abs(delta) : null;
    const absDelta = clamp(
      Number.isFinite(deltaAbsRaw)
        ? deltaAbsRaw
        : optionAbsDelta(env, optionMeta),
      0.2,
      0.95,
    );
    const gammaAbs = Number.isFinite(gamma) ? Math.abs(gamma) : null;

    const dte = daysToExpiry(optionMeta, nowTs);
    const near = Number.isFinite(dte) ? clamp((3 - dte) / 3, 0, 1) : 0;

    const atrPct = safeNum(atrPctUnderlying, null);
    const volRef = safeNum(env.OPT_VOL_REF_ATR_PCT, 0.6);
    const volFactor =
      Number.isFinite(atrPct) && Number.isFinite(volRef) && volRef > 0
        ? clamp(atrPct / volRef, 0.6, 1.8)
        : 1.0;

    // Near expiry / high vol => premium is whippy (gamma + IV noise).
    // Widen SL a bit (avoid churn). Keep target mildly conservative.
    const stopScale = clamp(
      1 + 0.2 * near + 0.15 * (volFactor - 1),
      1.0,
      safeNum(env.OPT_GAMMA_SCALE_MAX, 1.35),
    );
    const targetScale = clamp(1 - 0.05 * near, 0.85, 1.15);

    const underlyingRisk = Math.abs(entryU - stopU);
    const underlyingReward = Math.abs(targetU - entryU);

    // Delta + (optional) gamma mapping: premiumMove ~ |d|xdS + 0.5xgammaxdS^2
    const mapMove = (dS) => {
      const ds = Math.max(0, safeNum(dS, 0));
      const linear = ds * absDelta;
      const convex = Number.isFinite(gammaAbs) ? 0.5 * gammaAbs * ds * ds : 0;
      return linear + convex;
    };

    const premDropMapped = mapMove(underlyingRisk) * stopScale;
    const premGainMapped = mapMove(underlyingReward) * targetScale;

    let stopP_mapped = premEntry - premDropMapped;
    let targetP_mapped = premEntry + premGainMapped;

    // Max loss cap on premium
    const maxSlPct = safeNum(env.OPT_MAX_SL_PCT, 35);
    const maxDrop = premEntry * (maxSlPct / 100);
    if (premEntry - stopP_mapped > maxDrop) stopP_mapped = premEntry - maxDrop;

    stopP_mapped = roundToTick(stopP_mapped, t, "down");
    targetP_mapped = roundToTick(targetP_mapped, t, "up");

    if (stopP_mapped >= premEntry)
      stopP_mapped = roundToTick(
        premEntry - Math.max(t * 4, premEntry * 0.08),
        t,
        "down",
      );
    if (targetP_mapped <= premEntry)
      targetP_mapped = roundToTick(
        premEntry + Math.max(t * 4, premEntry * 0.12),
        t,
        "up",
      );

    const Rp_mapped = Math.abs(premEntry - stopP_mapped);
    const rrP_mapped =
      Math.abs(targetP_mapped - premEntry) / (Rp_mapped || 1e-9);

    // ----------------------------
    // 2) Premium-aware plan (preferred when candles exist)
    // ----------------------------
    const enablePremiumAware =
      String(env.OPT_PLAN_PREMIUM_AWARE ?? "true") !== "false";
    const premPlan = enablePremiumAware
      ? buildPremiumAwareOptionPlan({
          env,
          side: "BUY", // option-leg is long (BUY) even if underlying leg is SELL for puts
          entryPremium: premEntry,
          premiumTick: t,
          premiumCandles,
          optionMeta,
          rrMin: effectiveMinRr,
        })
      : { ok: false, reason: "disabled" };

    let stopP = stopP_mapped;
    let targetP = targetP_mapped;
    let rrP = rrP_mapped;

    if (premPlan.ok) {
      // Avoid too-tight stops: pick the wider (more room) stop.
      stopP = Math.min(stopP_mapped, Number(premPlan.stopLoss));

      // Re-apply max loss cap (rare but safe)
      if (premEntry - stopP > maxDrop) stopP = premEntry - maxDrop;
      stopP = roundToTick(stopP, t, "down");

      const Rp = Math.abs(premEntry - stopP);
      const minTarget = premEntry + effectiveMinRr * (Rp || 0);

      // Avoid unrealistic targets: prefer the closer target, but enforce minRR.
      const closerTarget = Math.min(
        targetP_mapped,
        Number(premPlan.targetPrice),
      );

      targetP = Math.max(closerTarget, minTarget);
      targetP = roundToTick(targetP, t, "up");

      rrP = Math.abs(targetP - premEntry) / (Rp || 1e-9);

      expectedMovePerUnit = Math.abs(targetP - premEntry);

      meta.option = {
        modelUsed: "PREMIUM_AWARE_BLEND",
        absDelta,
        delta: Number.isFinite(delta) ? delta : null,
        gamma: Number.isFinite(gamma) ? gamma : null,
        daysToExpiry: Number.isFinite(dte) ? dte : null,
        volFactor,
        entryPremium: premEntry,
        mapped: {
          stopScale,
          targetScale,
          stopPremium: stopP_mapped,
          targetPremium: targetP_mapped,
          rrPremium: rrP_mapped,
        },
        premiumAware: premPlan.meta || null,
        final: {
          stopPremium: stopP,
          targetPremium: targetP,
          rrPremium: rrP,
        },
      };
    } else {
      expectedMovePerUnit = Math.abs(targetP_mapped - premEntry);

      meta.option = {
        modelUsed: "DELTA_GAMMA_MAP_ONLY",
        absDelta,
        delta: Number.isFinite(delta) ? delta : null,
        gamma: Number.isFinite(gamma) ? gamma : null,
        daysToExpiry: Number.isFinite(dte) ? dte : null,
        stopScale,
        targetScale,
        entryPremium: premEntry,
        stopPremium: stopP_mapped,
        targetPremium: targetP_mapped,
        rrPremium: rrP_mapped,
        volFactor,
        premiumAware: premPlan.ok ? premPlan.meta : null,
      };

      stopP = stopP_mapped;
      targetP = targetP_mapped;
      rrP = rrP_mapped;
    }

    stop = stopP;
    target = targetP;
    rrFinal = rrP;
  }

  return {
    ok: true,
    stopLoss: stop,
    targetPrice: target,
    rr: rrFinal,
    expectedMovePerUnit,
    meta,
  };
}

function resolveMaxAllowedChaseDistance(ctx) {
  const config = familyConfig(ctx.family);
  const fallback = Number.isFinite(ctx.currentPrice) ? ctx.currentPrice * 0.004 : 0.5;
  const atrBased = Number.isFinite(ctx.atr) ? ctx.atr * config.chaseAtr : fallback;
  const structureSpan = Math.abs(
    safeNum(ctx.triggerLevel, ctx.currentPrice) - safeNum(ctx.anchorValue, ctx.currentPrice),
  );
  const structureCap =
    Number.isFinite(structureSpan) && structureSpan > 0
      ? Math.max(structureSpan * 1.4, atrBased * 0.7)
      : atrBased;
  return Math.max(fallback * 0.6, Math.min(Math.max(atrBased, fallback), structureCap));
}

function nearestOpposingStructure(ctx) {
  const levels = [];
  const minDistance = Math.max(
    ctx.tickSize * 3,
    Number.isFinite(ctx.atr) ? ctx.atr * 0.18 : 0,
    Number.isFinite(ctx.currentPrice) ? ctx.currentPrice * 0.0006 : 0,
  );
  const add = (level, sourceType) => {
    const lv = safeNum(level);
    if (!Number.isFinite(lv)) return;
    if (!inTradeDirection(ctx.side, ctx.currentPrice, lv)) return;
    const distanceAbs = Math.abs(lv - ctx.currentPrice);
    if (!(distanceAbs > minDistance)) return;
    levels.push({
      level: lv,
      sourceType,
      distanceAbs,
    });
  };

  if (ctx.side === "BUY") {
    add(ctx.rangeHigh, "RANGE_HIGH");
    add(ctx.recentHigh, "RECENT_HIGH");
    add(ctx.pivotHigh, "PIVOT_HIGH");
    add(ctx.prevDay?.PDH, "PDH");
    add(ctx.prevDay?.pivots?.R1, "R1");
    add(ctx.prevDay?.pivots?.R2, "R2");
  } else {
    add(ctx.rangeLow, "RANGE_LOW");
    add(ctx.recentLow, "RECENT_LOW");
    add(ctx.pivotLow, "PIVOT_LOW");
    add(ctx.prevDay?.PDL, "PDL");
    add(ctx.prevDay?.pivots?.S1, "S1");
    add(ctx.prevDay?.pivots?.S2, "S2");
  }

  if (!levels.length) return null;
  levels.sort((a, b) => a.distanceAbs - b.distanceAbs);
  return levels[0];
}

function assessFamilyIntegrity(ctx) {
  const warnings = [];
  const current = ctx.currentPrice;
  const atr = safeNum(ctx.atr, Math.max(current * 0.003, 0.25));
  const holdBuffer = atr * 0.08;
  const buy = ctx.side === "BUY";
  const sell = ctx.side === "SELL";

  if (ctx.family === "ema_pullback" || ctx.family === "ema_cross") {
    const fastAnchor = safeNum(ctx.anchorValue, null);
    const trendAnchor = safeNum(ctx.trendAnchor, null);
    if (buy && Number.isFinite(fastAnchor) && current < fastAnchor - holdBuffer) {
      return { valid: false, reason: "EMA_RECLAIM_LOST", score: 20, warnings };
    }
    if (sell && Number.isFinite(fastAnchor) && current > fastAnchor + holdBuffer) {
      return { valid: false, reason: "EMA_REJECT_LOST", score: 20, warnings };
    }
    let score = 72;
    if (buy && Number.isFinite(trendAnchor) && Number.isFinite(fastAnchor) && fastAnchor > trendAnchor) score += 10;
    if (sell && Number.isFinite(trendAnchor) && Number.isFinite(fastAnchor) && fastAnchor < trendAnchor) score += 10;
    return { valid: true, reason: null, score: clamp(score, 0, 100), warnings };
  }

  if (ctx.family === "breakout") {
    const boundary = safeNum(ctx.triggerLevel, buy ? ctx.rangeHigh : ctx.rangeLow);
    if (buy && Number.isFinite(boundary) && current <= boundary - holdBuffer) {
      return { valid: false, reason: "BREAKOUT_HOLD_LOST", score: 18, warnings };
    }
    if (sell && Number.isFinite(boundary) && current >= boundary + holdBuffer) {
      return { valid: false, reason: "BREAKDOWN_HOLD_LOST", score: 18, warnings };
    }
    const retestState = String(ctx.retestState || "").toUpperCase();
    const score = retestState.includes("HOLD")
      ? 78
      : retestState.includes("FIRST_BREAK")
        ? 72
        : 68;
    return { valid: true, reason: null, score, warnings };
  }

  if (ctx.family === "vwap_reclaim") {
    const vwapValue = safeNum(ctx.vwap ?? ctx.anchorValue, null);
    if (buy && Number.isFinite(vwapValue) && current <= vwapValue - holdBuffer) {
      return { valid: false, reason: "VWAP_RECLAIM_LOST", score: 18, warnings };
    }
    if (sell && Number.isFinite(vwapValue) && current >= vwapValue + holdBuffer) {
      return { valid: false, reason: "VWAP_REJECT_LOST", score: 18, warnings };
    }
    return { valid: true, reason: null, score: 74, warnings };
  }

  if (ctx.family === "orb") {
    const boundary = safeNum(ctx.triggerLevel, buy ? ctx.orb?.high : ctx.orb?.low);
    if (buy && Number.isFinite(boundary) && current <= boundary - holdBuffer) {
      return { valid: false, reason: "ORB_ACCEPTANCE_LOST", score: 18, warnings };
    }
    if (sell && Number.isFinite(boundary) && current >= boundary + holdBuffer) {
      return { valid: false, reason: "ORB_ACCEPTANCE_LOST", score: 18, warnings };
    }
    if (safeNum(ctx.orb?.ageBars, 0) > 3) warnings.push("ORB_GETTING_LATE");
    return { valid: true, reason: null, score: 72, warnings };
  }

  if (ctx.family === "fakeout") {
    const brokenLevel = safeNum(ctx.brokenLevel, ctx.triggerLevel);
    if (buy && Number.isFinite(brokenLevel) && current <= brokenLevel) {
      return { valid: false, reason: "FAKEOUT_RECLAIM_LOST", score: 18, warnings };
    }
    if (sell && Number.isFinite(brokenLevel) && current >= brokenLevel) {
      return { valid: false, reason: "FAKEOUT_REJECTION_LOST", score: 18, warnings };
    }
    return { valid: true, reason: null, score: 73, warnings };
  }

  if (ctx.family === "wick_reversal") {
    const wickExtreme = safeNum(ctx.wickExtreme, ctx.triggerLevel);
    if (buy && Number.isFinite(wickExtreme) && current <= wickExtreme) {
      return { valid: false, reason: "WICK_REVERSAL_LOST", score: 16, warnings };
    }
    if (sell && Number.isFinite(wickExtreme) && current >= wickExtreme) {
      return { valid: false, reason: "WICK_REVERSAL_LOST", score: 16, warnings };
    }
    return { valid: true, reason: null, score: 74, warnings };
  }

  if (ctx.family === "rsi_fade") {
    const vwapValue = safeNum(ctx.vwap ?? ctx.anchorValue, null);
    if (buy && Number.isFinite(vwapValue) && current >= vwapValue + atr * 0.35) {
      return { valid: false, reason: "RSI_FADE_SPENT", score: 20, warnings };
    }
    if (sell && Number.isFinite(vwapValue) && current <= vwapValue - atr * 0.35) {
      return { valid: false, reason: "RSI_FADE_SPENT", score: 20, warnings };
    }
    return { valid: true, reason: null, score: 70, warnings };
  }

  return { valid: true, reason: null, score: 66, warnings };
}

function validateSetupContext(ctx) {
  const warnings = [];
  const rejectReasons = [];
  const currentDistanceFromAnchor = Number.isFinite(ctx.anchorValue)
    ? Math.abs(ctx.currentPrice - ctx.anchorValue)
    : null;
  const currentDistanceFromTrigger = Number.isFinite(ctx.triggerLevel)
    ? Math.abs(ctx.currentPrice - ctx.triggerLevel)
    : currentDistanceFromAnchor;
  const maxAllowedChaseDistance = resolveMaxAllowedChaseDistance(ctx);
  const extensionVsAtr =
    Number.isFinite(ctx.atr) && ctx.atr > 0 && Number.isFinite(currentDistanceFromTrigger)
      ? currentDistanceFromTrigger / ctx.atr
      : null;
  const config = familyConfig(ctx.family);
  const freshnessBars = safeNum(ctx.setupFreshnessBars, 0);

  if (freshnessBars > config.maxFreshnessBars) {
    rejectReasons.push("ENTRY_STALE");
  } else if (freshnessBars === config.maxFreshnessBars) {
    warnings.push("ENTRY_AT_FRESHNESS_LIMIT");
  }

  if (
    Number.isFinite(currentDistanceFromTrigger) &&
    currentDistanceFromTrigger > maxAllowedChaseDistance
  ) {
    rejectReasons.push("ENTRY_CHASED");
  } else if (
    Number.isFinite(currentDistanceFromTrigger) &&
    currentDistanceFromTrigger > maxAllowedChaseDistance * 0.75
  ) {
    warnings.push("ENTRY_NEAR_CHASE_LIMIT");
  }

  if (Number.isFinite(extensionVsAtr) && extensionVsAtr > config.maxExtensionAtr) {
    rejectReasons.push("ENTRY_OVEREXTENDED");
  } else if (Number.isFinite(extensionVsAtr) && extensionVsAtr > config.warningAtr) {
    warnings.push("ENTRY_EXTENDED");
  }

  if (Number.isFinite(ctx.spreadBps) && ctx.spreadBps > 40) warnings.push("WIDE_SPREAD");
  if (Number.isFinite(ctx.spreadBps) && ctx.spreadBps > 90) rejectReasons.push("EXTREME_SPREAD");
  if (ctx.sessionTiming?.lateSession) warnings.push("LATE_SESSION");

  const integrity = assessFamilyIntegrity(ctx);
  warnings.push(...integrity.warnings);
  if (!integrity.valid && integrity.reason) rejectReasons.push(integrity.reason);

  const provisionalRisk =
    (Number.isFinite(currentDistanceFromTrigger)
      ? Math.max(
          currentDistanceFromTrigger * 1.15,
          Number.isFinite(ctx.atr) ? ctx.atr * 0.22 : 0,
          ctx.tickSize * 4,
        )
      : null) ||
    (Number.isFinite(currentDistanceFromAnchor)
      ? Math.max(
          currentDistanceFromAnchor * 0.9,
          Number.isFinite(ctx.atr) ? ctx.atr * 0.24 : 0,
          ctx.tickSize * 4,
        )
      : null) ||
    safeNum(ctx.legacyPlan?.meta?.underlying?.R, null) ||
    (Number.isFinite(ctx.atr)
      ? Math.max(ctx.atr * 0.35, ctx.tickSize * 4)
      : Math.max(ctx.currentPrice * 0.004, ctx.tickSize * 4));
  const opposing = nearestOpposingStructure(ctx);
  const rewardClarity =
    opposing && provisionalRisk > 0 ? opposing.distanceAbs / provisionalRisk : null;
  if (Number.isFinite(rewardClarity) && rewardClarity < Math.max(0.9, ctx.requiredMinRr * 0.8)) {
    rejectReasons.push("IMMEDIATE_PATH_CROWDED");
  } else if (Number.isFinite(rewardClarity) && rewardClarity < ctx.requiredMinRr) {
    warnings.push("IMMEDIATE_PATH_CROWDED");
  }

  const freshnessScore = clamp(
    100 - (freshnessBars / Math.max(1, config.maxFreshnessBars + 1)) * 40,
    25,
    100,
  );
  const chaseScore = Number.isFinite(currentDistanceFromTrigger)
    ? clamp(
        100 - (currentDistanceFromTrigger / Math.max(maxAllowedChaseDistance, 1e-6)) * 55,
        0,
        100,
      )
    : 50;
  const structureCleanlinessScore = clamp(
    avg([ctx.structureQuality, ctx.patternQuality, ctx.anchorQuality, integrity.score]) ?? integrity.score,
    0,
    100,
  );
  const followThroughReadinessScore = clamp(
    avg([
      ctx.volumeQuality,
      ctx.signalConfidence,
      structureCleanlinessScore,
      Number.isFinite(rewardClarity) ? clamp(rewardClarity * 24, 10, 100) : 55,
    ]) ?? 55,
    0,
    100,
  );

  return {
    validationPassed: rejectReasons.length === 0,
    validationScore: Math.round(
      clamp(
        avg([
          freshnessScore,
          chaseScore,
          structureCleanlinessScore,
          followThroughReadinessScore,
        ]) ?? 0,
        0,
        100,
      ),
    ),
    validationRejectReasons: uniqueStrings(rejectReasons),
    validationWarnings: uniqueStrings(warnings),
    chaseScore: Math.round(chaseScore),
    structureCleanlinessScore: Math.round(structureCleanlinessScore),
    followThroughReadinessScore: Math.round(followThroughReadinessScore),
    currentDistanceFromAnchor,
    currentDistanceFromTrigger,
    extensionVsAtr,
    entryFreshnessBars: freshnessBars,
    maxAllowedChaseDistance,
    immediateOpposingStructure: opposing,
    rewardClarity,
  };
}

function buildIdealEntryZone(ctx, maxAllowedChaseDistance) {
  const atr = safeNum(ctx.atr, Math.max(ctx.currentPrice * 0.003, ctx.tickSize * 6));
  const anchor = safeNum(ctx.anchorValue, ctx.currentPrice);
  const trigger = safeNum(ctx.triggerLevel, anchor);
  let lower;
  let upper;

  switch (ctx.family) {
    case "ema_pullback":
    case "ema_cross":
      lower = directionSign(ctx.side) > 0 ? anchor - atr * 0.12 : anchor - atr * 0.38;
      upper = directionSign(ctx.side) > 0 ? anchor + maxAllowedChaseDistance : anchor + atr * 0.12;
      break;
    case "breakout":
    case "orb":
      lower = directionSign(ctx.side) > 0 ? trigger - atr * 0.18 : trigger - maxAllowedChaseDistance;
      upper = directionSign(ctx.side) > 0 ? trigger + maxAllowedChaseDistance : trigger + atr * 0.18;
      break;
    case "vwap_reclaim":
      lower = directionSign(ctx.side) > 0 ? anchor - atr * 0.1 : anchor - maxAllowedChaseDistance;
      upper = directionSign(ctx.side) > 0 ? anchor + maxAllowedChaseDistance : anchor + atr * 0.1;
      break;
    default:
      lower = directionSign(ctx.side) > 0 ? trigger - atr * 0.04 : trigger - maxAllowedChaseDistance;
      upper = directionSign(ctx.side) > 0 ? trigger + maxAllowedChaseDistance : trigger + atr * 0.04;
      break;
  }

  return {
    idealEntryZoneLow: Math.min(lower, upper),
    idealEntryZoneHigh: Math.max(lower, upper),
  };
}

function buildEntryPlan(ctx, validation) {
  const zone = buildIdealEntryZone(ctx, validation.maxAllowedChaseDistance);
  const proximityScore = Number.isFinite(validation.currentDistanceFromTrigger)
    ? clamp(
        100 - (validation.currentDistanceFromTrigger / Math.max(validation.maxAllowedChaseDistance, 1e-6)) * 60,
        0,
        100,
      )
    : 55;

  return {
    entryMode: validation.validationPassed ? "ENTER_NOW" : "REJECT",
    entryAnchorType: ctx.anchorType || null,
    entryAnchorValue: Number.isFinite(ctx.anchorValue) ? ctx.anchorValue : null,
    entryTriggerType: ctx.triggerType || null,
    entryTriggerValue: Number.isFinite(ctx.triggerLevel) ? ctx.triggerLevel : null,
    currentDistanceFromAnchor: validation.currentDistanceFromAnchor,
    currentDistanceFromTrigger: validation.currentDistanceFromTrigger,
    extensionVsAtr: validation.extensionVsAtr,
    entryFreshnessBars: validation.entryFreshnessBars,
    entryQualityScore: Math.round(
      clamp(
        avg([
          validation.validationScore,
          proximityScore,
          ctx.patternQuality,
          ctx.anchorQuality,
        ]) ?? 0,
        0,
        100,
      ),
    ),
    entryAccept: validation.validationPassed,
    entryRejectReason: validation.validationPassed
      ? null
      : validation.validationRejectReasons[0] || "ENTRY_REJECTED",
    entryWarnings: validation.validationWarnings,
    maxAllowedChaseDistance: validation.maxAllowedChaseDistance,
    idealEntryZoneLow: zone.idealEntryZoneLow,
    idealEntryZoneHigh: zone.idealEntryZoneHigh,
  };
}

function stopPaddingAbs(ctx, weight = 1) {
  const atrPad = Number.isFinite(ctx.atr) ? ctx.atr * 0.08 * weight : 0;
  const spreadPad = Number.isFinite(ctx.spreadAbs) ? ctx.spreadAbs * 1.25 * weight : 0;
  const tickPad = ctx.tickSize * 2 * weight;
  return Math.max(tickPad, atrPad, spreadPad, ctx.currentPrice * 0.0005);
}

function finalizeStopCandidate(ctx, candidate) {
  const rawLevel = safeNum(candidate.rawInvalidationLevel);
  if (!Number.isFinite(rawLevel)) return null;

  const pad = stopPaddingAbs(ctx, safeNum(candidate.paddingWeight, 1));
  const padded = ctx.side === "BUY" ? rawLevel - pad : rawLevel + pad;
  if (ctx.side === "BUY" && padded >= ctx.currentPrice) return null;
  if (ctx.side === "SELL" && padded <= ctx.currentPrice) return null;

  const stopDistanceAbs = Math.abs(ctx.currentPrice - padded);
  const stopDistancePct =
    Number.isFinite(ctx.currentPrice) && ctx.currentPrice > 0
      ? (stopDistanceAbs / ctx.currentPrice) * 100
      : null;
  const stopDistanceAtr =
    Number.isFinite(ctx.atr) && ctx.atr > 0 ? stopDistanceAbs / ctx.atr : null;
  const stopTooTightFlag = Number.isFinite(stopDistanceAtr)
    ? stopDistanceAtr < 0.18
    : stopDistanceAbs < ctx.tickSize * 4;
  const stopTooWideFlag = Number.isFinite(stopDistanceAtr)
    ? stopDistanceAtr > 2.9
    : Number.isFinite(stopDistancePct) && stopDistancePct > 3;

  let score = 42;
  score += safeNum(candidate.strategyRelevance, 0) * 0.18;
  score += safeNum(candidate.structureClarity, 0) * 0.18;
  score += safeNum(candidate.noiseRobustness, 0) * 0.16;
  score += safeNum(candidate.tradability, 0) * 0.16;
  if (Number.isFinite(stopDistanceAtr)) {
    if (stopDistanceAtr >= 0.3 && stopDistanceAtr <= 1.5) score += 20;
    else if (stopDistanceAtr >= 0.2 && stopDistanceAtr <= 2.2) score += 10;
  }
  if (stopTooTightFlag) score -= 26;
  if (stopTooWideFlag) score -= 14;
  if (String(candidate.stopSourceType || "").includes("ATR")) score -= 8;
  if (
    String(candidate.stopSourceType || "").includes("WICK_EXTREME") ||
    String(candidate.stopSourceType || "").includes("REVERSAL_EXTREME")
  ) {
    score += 8;
  }
  if (ctx.optionMeta && Number.isFinite(ctx.optionMeta?.bps) && ctx.optionMeta.bps > 40) {
    score -= 6;
  }

  const warnings = [];
  if (stopTooTightFlag) warnings.push("STOP_TOO_TIGHT");
  if (stopTooWideFlag) warnings.push("STOP_TOO_WIDE");

  return {
    ...candidate,
    candidateKey: `${candidate.stopSourceType || "STOP"}:${Math.round(padded / Math.max(ctx.tickSize, 0.01))}`,
    paddedInvalidationLevel: padded,
    stopLoss: padded,
    stopDistanceAbs,
    stopDistancePct,
    stopDistanceAtr,
    stopTooTightFlag,
    stopTooWideFlag,
    stopQualityScore: Math.round(clamp(score, 0, 100)),
    stopWarnings: warnings,
  };
}

function dedupeStopCandidates(ctx, candidates) {
  const tick = Math.max(safeNum(ctx.tickSize, 0.05), 0.01);
  const deduped = [];
  for (const candidate of safeArr(candidates)) {
    const existingIndex = deduped.findIndex(
      (row) =>
        Math.abs(
          safeNum(row?.stopLoss, Number.NaN) - safeNum(candidate?.stopLoss, Number.NaN),
        ) <= tick &&
        String(row?.stopSourceType || "") === String(candidate?.stopSourceType || ""),
    );
    if (existingIndex === -1) {
      deduped.push(candidate);
      continue;
    }
    if (
      safeNum(candidate?.stopQualityScore, 0) >
      safeNum(deduped[existingIndex]?.stopQualityScore, 0)
    ) {
      deduped[existingIndex] = candidate;
    }
  }
  return deduped;
}

function buildStopCandidates(ctx, legacyPlan) {
  const candidates = [];
  const push = (candidate) => {
    const finalized = finalizeStopCandidate(ctx, candidate);
    if (finalized) candidates.push(finalized);
  };

  const currentLow = safeNum(ctx.lastCandle?.low, null);
  const currentHigh = safeNum(ctx.lastCandle?.high, null);
  const previousLow = safeNum(ctx.prevCandle?.low, null);
  const previousHigh = safeNum(ctx.prevCandle?.high, null);
  const buy = ctx.side === "BUY";

  if (ctx.family === "ema_pullback" || ctx.family === "ema_cross") {
    push({
      stopSourceType: "RECLAIM_CANDLE",
      stopSourceDescription: "Trigger/reclaim candle invalidation",
      rawInvalidationLevel: buy ? currentLow : currentHigh,
      strategyRelevance: 96,
      structureClarity: 84,
      noiseRobustness: 72,
      tradability: 76,
    });
    push({
      stopSourceType: "PULLBACK_SWING",
      stopSourceDescription: "Recent pullback swing invalidation",
      rawInvalidationLevel: buy ? ctx.pivotLow || ctx.recentLow : ctx.pivotHigh || ctx.recentHigh,
      strategyRelevance: 92,
      structureClarity: 82,
      noiseRobustness: 80,
      tradability: 70,
      paddingWeight: 1.1,
    });
    push({
      stopSourceType: "TREND_ANCHOR",
      stopSourceDescription: "Continuation structure invalidation",
      rawInvalidationLevel: ctx.trendAnchor,
      strategyRelevance: 78,
      structureClarity: 70,
      noiseRobustness: 72,
      tradability: 66,
      paddingWeight: 1.15,
    });
  } else if (ctx.family === "breakout") {
    push({
      stopSourceType: "BREAKOUT_BASE",
      stopSourceDescription: "Breakout base / reclaimed boundary invalidation",
      rawInvalidationLevel: buy ? ctx.rangeHigh : ctx.rangeLow,
      strategyRelevance: 96,
      structureClarity: 88,
      noiseRobustness: 74,
      tradability: 76,
      paddingWeight: 1.15,
    });
    push({
      stopSourceType: "BREAKOUT_TRIGGER_CANDLE",
      stopSourceDescription: "Breakout trigger candle invalidation",
      rawInvalidationLevel: buy ? previousLow || currentLow : previousHigh || currentHigh,
      strategyRelevance: 88,
      structureClarity: 76,
      noiseRobustness: 66,
      tradability: 78,
    });
    push({
      stopSourceType: "RANGE_STRUCTURE",
      stopSourceDescription: "Session range structure invalidation",
      rawInvalidationLevel: buy ? ctx.rangeLow : ctx.rangeHigh,
      strategyRelevance: 74,
      structureClarity: 72,
      noiseRobustness: 84,
      tradability: 58,
      paddingWeight: 1.2,
    });
  } else if (ctx.family === "vwap_reclaim") {
    push({
      stopSourceType: "RECLAIM_CANDLE",
      stopSourceDescription: "VWAP reclaim candle invalidation",
      rawInvalidationLevel: buy ? currentLow : currentHigh,
      strategyRelevance: 94,
      structureClarity: 84,
      noiseRobustness: 72,
      tradability: 76,
    });
    push({
      stopSourceType: "VWAP_LOSS",
      stopSourceDescription: "VWAP hold-loss invalidation",
      rawInvalidationLevel: ctx.vwap || ctx.anchorValue,
      strategyRelevance: 90,
      structureClarity: 80,
      noiseRobustness: 76,
      tradability: 74,
      paddingWeight: 1.05,
    });
    push({
      stopSourceType: "RECENT_SWING",
      stopSourceDescription: "Recent reclaim structure invalidation",
      rawInvalidationLevel: buy ? ctx.pivotLow || ctx.recentLow : ctx.pivotHigh || ctx.recentHigh,
      strategyRelevance: 82,
      structureClarity: 78,
      noiseRobustness: 80,
      tradability: 68,
      paddingWeight: 1.1,
    });
  } else if (ctx.family === "orb") {
    push({
      stopSourceType: "ORB_RECLAIM_BOUNDARY",
      stopSourceDescription: "ORB breakout boundary invalidation",
      rawInvalidationLevel: buy ? ctx.orb?.high : ctx.orb?.low,
      strategyRelevance: 88,
      structureClarity: 82,
      noiseRobustness: 68,
      tradability: 78,
      paddingWeight: 1.05,
    });
    push({
      stopSourceType: "ORB_OPPOSITE_BOUNDARY",
      stopSourceDescription: "ORB opposite boundary invalidation",
      rawInvalidationLevel: buy ? ctx.orb?.low : ctx.orb?.high,
      strategyRelevance: 92,
      structureClarity: 84,
      noiseRobustness: 88,
      tradability: 56,
      paddingWeight: 1.2,
    });
    push({
      stopSourceType: "ORB_TRIGGER_CANDLE",
      stopSourceDescription: "ORB trigger candle invalidation",
      rawInvalidationLevel: buy ? previousLow || currentLow : previousHigh || currentHigh,
      strategyRelevance: 80,
      structureClarity: 72,
      noiseRobustness: 64,
      tradability: 76,
    });
  } else {
    push({
      stopSourceType: ctx.family === "rsi_fade" ? "REVERSAL_EXTREME" : "WICK_EXTREME",
      stopSourceDescription: "Reversal extreme invalidation",
      rawInvalidationLevel: buy
        ? ctx.wickExtreme || currentLow || ctx.brokenLevel
        : ctx.wickExtreme || currentHigh || ctx.brokenLevel,
      strategyRelevance: 96,
      structureClarity: 86,
      noiseRobustness: 72,
      tradability: 78,
    });
    push({
      stopSourceType: "REVERSAL_ZONE",
      stopSourceDescription: "Reversal zone invalidation",
      rawInvalidationLevel: buy ? ctx.brokenLevel || ctx.rangeLow : ctx.brokenLevel || ctx.rangeHigh,
      strategyRelevance: 90,
      structureClarity: 82,
      noiseRobustness: 80,
      tradability: 68,
      paddingWeight: 1.1,
    });
    push({
      stopSourceType: "RECENT_SWING",
      stopSourceDescription: "Recent swing invalidation",
      rawInvalidationLevel: buy ? ctx.pivotLow || ctx.recentLow : ctx.pivotHigh || ctx.recentHigh,
      strategyRelevance: 80,
      structureClarity: 76,
      noiseRobustness: 84,
      tradability: 66,
      paddingWeight: 1.15,
    });
  }

  push({
    stopSourceType: "SESSION_RANGE",
    stopSourceDescription: "Session structure invalidation",
    rawInvalidationLevel: buy ? ctx.rangeLow : ctx.rangeHigh,
    strategyRelevance: 66,
    structureClarity: 68,
    noiseRobustness: 82,
    tradability: 56,
    paddingWeight: 1.2,
  });
  push({
    stopSourceType: "PREVIOUS_DAY_STRUCTURE",
    stopSourceDescription: "Previous day structure invalidation",
    rawInvalidationLevel: buy ? ctx.prevDay?.PDL : ctx.prevDay?.PDH,
    strategyRelevance: 60,
    structureClarity: 64,
    noiseRobustness: 86,
    tradability: 48,
    paddingWeight: 1.25,
  });
  push({
    stopSourceType: "ATR_FALLBACK",
    stopSourceDescription: "ATR fallback invalidation",
    rawInvalidationLevel:
      buy
        ? ctx.currentPrice - (safeNum(ctx.atr, 0) || 0) * ctx.k
        : ctx.currentPrice + (safeNum(ctx.atr, 0) || 0) * ctx.k,
    strategyRelevance: 48,
    structureClarity: 44,
    noiseRobustness: 62,
    tradability: 74,
  });

  return dedupeStopCandidates(ctx, candidates).sort(
    (a, b) =>
      b.stopQualityScore - a.stopQualityScore ||
      a.stopDistanceAbs - b.stopDistanceAbs ||
      String(a.stopSourceType || "").localeCompare(String(b.stopSourceType || "")),
  );
}

function buildStopPlan(ctx, legacyPlan) {
  const candidates = buildStopCandidates(ctx, legacyPlan);
  let chosen = candidates[0] || null;
  const preferredReversalExtreme = candidates.find((candidate) =>
    ["WICK_EXTREME", "REVERSAL_EXTREME"].includes(
      String(candidate?.stopSourceType || "").toUpperCase(),
    ),
  );
  if (
    preferredReversalExtreme &&
    chosen &&
    !["WICK_EXTREME", "REVERSAL_EXTREME"].includes(
      String(chosen?.stopSourceType || "").toUpperCase(),
    ) &&
    ["wick_reversal", "rsi_fade", "fakeout"].includes(ctx.family) &&
    safeNum(preferredReversalExtreme.stopQualityScore, 0) >=
      safeNum(chosen.stopQualityScore, 0) - 12
  ) {
    chosen = preferredReversalExtreme;
  }

  if (!chosen && legacyPlan?.ok) {
    return {
      ok: true,
      stopSourceType: "LEGACY_GENERIC",
      stopSourceDescription: "Legacy planner fallback",
      rawInvalidationLevel: safeNum(legacyPlan?.meta?.underlying?.stop, legacyPlan?.stopLoss),
      paddedInvalidationLevel: safeNum(legacyPlan?.meta?.underlying?.stop, legacyPlan?.stopLoss),
      stopLoss: safeNum(legacyPlan?.meta?.underlying?.stop, legacyPlan?.stopLoss),
      stopDistanceAbs: Number.isFinite(legacyPlan?.meta?.underlying?.R)
        ? Number(legacyPlan.meta.underlying.R)
        : null,
      stopDistancePct: null,
      stopDistanceAtr: null,
      stopQualityScore: 52,
      stopTooTightFlag: false,
      stopTooWideFlag: false,
      stopFallbackUsed: true,
      stopFallbackReason: "LEGACY_GENERIC",
      stopSelectionReason: "LEGACY_GENERIC_FALLBACK",
      stopWarnings: ["RICH_STOP_CONTEXT_MISSING"],
      stopCandidatesConsidered: [],
    };
  }

  if (!chosen) {
    return {
      ok: false,
      reason: "NO_VALID_STOP_CANDIDATE",
      stopCandidatesConsidered: [],
    };
  }

  return {
    ok: true,
    stopSourceType: chosen.stopSourceType,
    stopSourceDescription: chosen.stopSourceDescription,
    rawInvalidationLevel: chosen.rawInvalidationLevel,
    paddedInvalidationLevel: chosen.paddedInvalidationLevel,
    stopLoss: chosen.stopLoss,
    stopDistanceAbs: chosen.stopDistanceAbs,
    stopDistancePct: chosen.stopDistancePct,
    stopDistanceAtr: chosen.stopDistanceAtr,
    stopQualityScore: chosen.stopQualityScore,
    stopTooTightFlag: chosen.stopTooTightFlag,
    stopTooWideFlag: chosen.stopTooWideFlag,
    chosenStopSourceType: chosen.stopSourceType,
    stopSelectionReason: "TOP_RANKED_STOP",
    stopFallbackUsed:
      String(chosen.stopSourceType || "").includes("ATR") ||
      String(chosen.stopSourceType || "").includes("LEGACY"),
    stopFallbackReason:
      String(chosen.stopSourceType || "").includes("ATR")
        ? "ATR_FALLBACK"
        : String(chosen.stopSourceType || "").includes("LEGACY")
          ? "LEGACY_GENERIC"
          : null,
    stopWarnings: uniqueStrings(chosen.stopWarnings),
    stopCandidatesConsidered: candidates,
  };
}

function validateTargetCandidate(ctx, candidate) {
  const price = safeNum(candidate?.price);
  if (!Number.isFinite(price)) {
    return { ok: false, reason: "NON_FINITE_TARGET", price: null };
  }
  if (!(price > 0)) {
    return { ok: false, reason: "NON_POSITIVE_TARGET", price };
  }
  if (!inTradeDirection(ctx.side, ctx.currentPrice, price)) {
    return { ok: false, reason: "TARGET_WRONG_SIDE", price };
  }
  const minUsableDistance = Math.max(
    ctx.tickSize * 2,
    Number.isFinite(ctx.currentPrice) ? ctx.currentPrice * 0.0002 : 0,
  );
  if (Math.abs(price - ctx.currentPrice) < minUsableDistance) {
    return { ok: false, reason: "TARGET_TOO_CLOSE", price };
  }
  return { ok: true, price };
}

function finalizeTargetCandidate(ctx, stopPlan, candidate) {
  const candidateCheck = validateTargetCandidate(ctx, candidate);
  if (!candidateCheck.ok) return null;
  const price = candidateCheck.price;

  const distanceAbs = Math.abs(price - ctx.currentPrice);
  const rr = stopPlan.stopDistanceAbs > 0 ? distanceAbs / stopPlan.stopDistanceAbs : null;
  const reachabilityScore =
    Number.isFinite(ctx.expectedMoveUnderlying) && ctx.expectedMoveUnderlying > 0
      ? clamp(
          100 -
            (Math.max(0, distanceAbs - ctx.expectedMoveUnderlying * 1.35) /
              Math.max(ctx.expectedMoveUnderlying * 0.5, 1e-6)) *
              65,
          12,
          100,
        )
      : 62;
  const timeScore = ctx.sessionTiming?.lateSession
    ? distanceAbs <= Math.max(ctx.currentPrice * 0.01, safeNum(ctx.atr, 0) * 1.6)
      ? 74
      : 42
    : 72;
  const rrScore = Number.isFinite(rr) ? clamp(36 + rr * 22, 0, 100) : 40;
  const score = clamp(
    safeNum(candidate.structuralScore, 60) * 0.28 +
      rrScore * 0.24 +
      reachabilityScore * 0.2 +
      safeNum(candidate.familyBias, 60) * 0.18 +
      timeScore * 0.1,
    0,
    100,
  );

  return {
    ...candidate,
    candidateKey: `${candidate.sourceType || "TARGET"}:${Math.round(price / Math.max(ctx.tickSize, 0.01))}`,
    targetPrice: price,
    distanceAbs,
    rr,
    targetScore: Math.round(score),
  };
}

function dedupeTargetCandidates(ctx, candidates) {
  const tick = Math.max(safeNum(ctx.tickSize, 0.05), 0.01);
  const deduped = [];
  for (const candidate of safeArr(candidates)) {
    const existingIndex = deduped.findIndex(
      (row) =>
        Math.abs(
          safeNum(row?.targetPrice, Number.NaN) -
            safeNum(candidate?.targetPrice, Number.NaN),
        ) <= tick,
    );
    if (existingIndex === -1) {
      deduped.push(candidate);
      continue;
    }
    const existing = deduped[existingIndex];
    const candidateWins =
      safeNum(candidate?.targetScore, 0) >
        safeNum(existing?.targetScore, 0) ||
      (safeNum(candidate?.targetScore, 0) === safeNum(existing?.targetScore, 0) &&
        safeNum(candidate?.rr, 0) > safeNum(existing?.rr, 0)) ||
      (safeNum(candidate?.targetScore, 0) === safeNum(existing?.targetScore, 0) &&
        safeNum(candidate?.rr, 0) === safeNum(existing?.rr, 0) &&
        String(candidate?.sourceType || "").localeCompare(String(existing?.sourceType || "")) < 0);
    if (candidateWins) deduped[existingIndex] = candidate;
  }
  return deduped;
}

function buildTargetCandidates(ctx, stopPlan, legacyPlan) {
  const candidates = [];
  const droppedTargetCandidates = [];
  const push = (candidate) => {
    const finalized = finalizeTargetCandidate(ctx, stopPlan, candidate);
    if (finalized) {
      candidates.push(finalized);
      return;
    }
    const check = validateTargetCandidate(ctx, candidate);
    droppedTargetCandidates.push({
      sourceType: candidate?.sourceType || "UNKNOWN",
      reason: check?.reason || "INVALID_TARGET",
      price: safeNum(candidate?.price, null),
    });
  };

  const rangeSize =
    Number.isFinite(ctx.rangeHigh) && Number.isFinite(ctx.rangeLow)
      ? Math.max(0, ctx.rangeHigh - ctx.rangeLow)
      : null;
  const measuredMove =
    Number.isFinite(rangeSize) && rangeSize > 0
      ? rangeSize
      : safeNum(ctx.orb?.range, safeNum(ctx.atr, 0) * 1.4);
  const atr = safeNum(ctx.atr, Math.max(ctx.currentPrice * 0.003, 0.25));
  const reaction =
    ctx.family === "rsi_fade" ||
    ctx.family === "wick_reversal" ||
    ctx.family === "fakeout"
      ? ctx.vwap || ctx.rangeMid
      : ctx.style === "RANGE"
        ? ctx.rangeMid || ctx.vwap
        : null;

  if (ctx.side === "BUY") {
    push({
      sourceType: "VWAP",
      price: reaction && reaction > ctx.currentPrice ? reaction : null,
      structuralScore: 82,
      familyBias:
        ctx.style === "RANGE" ||
        ["rsi_fade", "wick_reversal", "fakeout"].includes(ctx.family)
          ? 92
          : 58,
    });
    push({
      sourceType: "RANGE_MID",
      price: Number.isFinite(ctx.rangeMid) && ctx.rangeMid > ctx.currentPrice ? ctx.rangeMid : null,
      structuralScore: 80,
      familyBias: ctx.style === "RANGE" ? 92 : 56,
    });
    push({
      sourceType: "RANGE_HIGH",
      price: ctx.rangeHigh,
      structuralScore: 78,
      familyBias: ctx.style === "RANGE" ? 84 : 68,
    });
    push({
      sourceType: "SWING_HIGH",
      price: ctx.recentHigh,
      structuralScore: 82,
      familyBias: ctx.style === "TREND" ? 80 : 62,
    });
    push({
      sourceType: "PDH",
      price: ctx.prevDay?.PDH,
      structuralScore: 78,
      familyBias: 70,
    });
    push({
      sourceType: "R1",
      price: ctx.prevDay?.pivots?.R1,
      structuralScore: 76,
      familyBias: 74,
    });
    push({
      sourceType: "R2",
      price: ctx.prevDay?.pivots?.R2,
      structuralScore: 74,
      familyBias: 70,
    });
    push({
      sourceType: "ATR_TARGET",
      price: ctx.currentPrice + atr * ctx.m,
      structuralScore: 64,
      familyBias: 60,
    });
    push({
      sourceType: "MEASURED_MOVE",
      price: safeNum(ctx.triggerLevel, ctx.currentPrice) + measuredMove,
      structuralScore: 80,
      familyBias:
        ["breakout", "orb"].includes(ctx.family) || ctx.style === "TREND"
          ? 90
          : 56,
    });
    push({
      sourceType: "ATR_EXTENSION",
      price: ctx.currentPrice + atr * (ctx.m + 0.9),
      structuralScore: 62,
      familyBias: ctx.style === "TREND" ? 74 : 50,
    });
  } else {
    push({
      sourceType: "VWAP",
      price: reaction && reaction < ctx.currentPrice ? reaction : null,
      structuralScore: 82,
      familyBias:
        ctx.style === "RANGE" ||
        ["rsi_fade", "wick_reversal", "fakeout"].includes(ctx.family)
          ? 92
          : 58,
    });
    push({
      sourceType: "RANGE_MID",
      price: Number.isFinite(ctx.rangeMid) && ctx.rangeMid < ctx.currentPrice ? ctx.rangeMid : null,
      structuralScore: 80,
      familyBias: ctx.style === "RANGE" ? 92 : 56,
    });
    push({
      sourceType: "RANGE_LOW",
      price: ctx.rangeLow,
      structuralScore: 78,
      familyBias: ctx.style === "RANGE" ? 84 : 68,
    });
    push({
      sourceType: "SWING_LOW",
      price: ctx.recentLow,
      structuralScore: 82,
      familyBias: ctx.style === "TREND" ? 80 : 62,
    });
    push({
      sourceType: "PDL",
      price: ctx.prevDay?.PDL,
      structuralScore: 78,
      familyBias: 70,
    });
    push({
      sourceType: "S1",
      price: ctx.prevDay?.pivots?.S1,
      structuralScore: 76,
      familyBias: 74,
    });
    push({
      sourceType: "S2",
      price: ctx.prevDay?.pivots?.S2,
      structuralScore: 74,
      familyBias: 70,
    });
    push({
      sourceType: "ATR_TARGET",
      price: ctx.currentPrice - atr * ctx.m,
      structuralScore: 64,
      familyBias: 60,
    });
    push({
      sourceType: "MEASURED_MOVE",
      price: safeNum(ctx.triggerLevel, ctx.currentPrice) - measuredMove,
      structuralScore: 80,
      familyBias:
        ["breakout", "orb"].includes(ctx.family) || ctx.style === "TREND"
          ? 90
          : 56,
    });
    push({
      sourceType: "ATR_EXTENSION",
      price: ctx.currentPrice - atr * (ctx.m + 0.9),
      structuralScore: 62,
      familyBias: ctx.style === "TREND" ? 74 : 50,
    });
  }

  const dedupedCandidates = dedupeTargetCandidates(ctx, candidates).sort((a, b) => {
    if (b.targetScore !== a.targetScore) return b.targetScore - a.targetScore;
    if (b.rr !== a.rr) return safeNum(b.rr, 0) - safeNum(a.rr, 0);
    return a.distanceAbs - b.distanceAbs;
  });
  return {
    candidates: dedupedCandidates,
    droppedTargetCandidates,
  };
}

function preferredTargetSources(ctx, stage) {
  const reversalFamily = ["rsi_fade", "wick_reversal", "fakeout"].includes(ctx.family);
  if (stage === "PRIMARY") {
    if (ctx.style === "RANGE" || reversalFamily) {
      return ["VWAP", "RANGE_MID", ctx.side === "BUY" ? "RANGE_HIGH" : "RANGE_LOW", ctx.side === "BUY" ? "SWING_HIGH" : "SWING_LOW"];
    }
    if (["breakout", "orb"].includes(ctx.family) || ctx.style === "TREND") {
      return [ctx.side === "BUY" ? "SWING_HIGH" : "SWING_LOW", ctx.side === "BUY" ? "RANGE_HIGH" : "RANGE_LOW", ctx.side === "BUY" ? "PDH" : "PDL", ctx.side === "BUY" ? "R1" : "S1"];
    }
    return ["ATR_TARGET", ctx.side === "BUY" ? "SWING_HIGH" : "SWING_LOW"];
  }

  if (stage === "SECONDARY") {
    if (ctx.style === "RANGE" || reversalFamily) {
      return [ctx.side === "BUY" ? "RANGE_HIGH" : "RANGE_LOW", ctx.side === "BUY" ? "SWING_HIGH" : "SWING_LOW", ctx.side === "BUY" ? "PDH" : "PDL"];
    }
    return ["MEASURED_MOVE", ctx.side === "BUY" ? "R1" : "S1", ctx.side === "BUY" ? "PDH" : "PDL", "ATR_TARGET"];
  }

  return ["MEASURED_MOVE", "ATR_EXTENSION", ctx.side === "BUY" ? "R2" : "S2"];
}

function sortTargetCandidatesForStage(ctx, candidates, stage) {
  const preferred = preferredTargetSources(ctx, stage);
  return safeArr(candidates).slice().sort((a, b) => {
    const aIdx = preferred.indexOf(a.sourceType);
    const bIdx = preferred.indexOf(b.sourceType);
    const aRank = aIdx === -1 ? preferred.length + 1 : aIdx;
    const bRank = bIdx === -1 ? preferred.length + 1 : bIdx;
    if (aRank !== bRank) return aRank - bRank;
    if (b.targetScore !== a.targetScore) return b.targetScore - a.targetScore;
    return a.distanceAbs - b.distanceAbs;
  });
}

function chooseTargetLadder(ctx, stopPlan, legacyPlan) {
  const { candidates, droppedTargetCandidates } = buildTargetCandidates(
    ctx,
    stopPlan,
    legacyPlan,
  );
  let primary =
    sortTargetCandidatesForStage(
      ctx,
      candidates.filter((candidate) => Number.isFinite(candidate.rr) && candidate.rr >= ctx.requiredMinRr),
      "PRIMARY",
    )[0] || null;
  let targetFallbackUsed = false;
  let targetFallbackReason = null;

  if (!primary && legacyPlan?.ok) {
    primary = finalizeTargetCandidate(ctx, stopPlan, {
      sourceType: "LEGACY_GENERIC",
      price: legacyPlan?.meta?.underlying?.target ?? legacyPlan?.targetPrice,
      structuralScore: 54,
      familyBias: 48,
    });
    targetFallbackUsed = true;
    targetFallbackReason = "LEGACY_GENERIC";
  }

  if (!primary) {
    return {
      ok: false,
      reason: "NO_TARGET_MEETS_MIN_RR",
      targetCandidatesConsidered: candidates,
      droppedTargetCandidates,
    };
  }

  const secondary =
    sortTargetCandidatesForStage(
      ctx,
      candidates
      .filter(
        (candidate) =>
          candidate !== primary &&
          Number.isFinite(candidate.rr) &&
          candidate.rr > Math.max(primary.rr || 0, ctx.requiredMinRr) + 0.25 &&
          candidate.distanceAbs > primary.distanceAbs &&
          candidate.targetScore >= 56,
      ),
      "SECONDARY",
    )[0] || null;

  const runnerAllowed =
    ctx.style !== "RANGE" &&
    !["rsi_fade", "wick_reversal", "fakeout"].includes(ctx.family) &&
    ctx.sessionTiming?.lateSession !== true;
  const runner = runnerAllowed
    ? sortTargetCandidatesForStage(
        ctx,
        candidates
        .filter(
          (candidate) =>
            candidate !== primary &&
            candidate !== secondary &&
            Number.isFinite(candidate.rr) &&
            candidate.rr >= Math.max((secondary?.rr || primary.rr || 0) + 0.35, 2.1) &&
            candidate.distanceAbs > Math.max(primary.distanceAbs, secondary?.distanceAbs || 0) &&
            candidate.targetScore >= 54 &&
            ["MEASURED_MOVE", "ATR_EXTENSION", "R2", "S2"].includes(candidate.sourceType),
        ),
        "RUNNER",
      )[0] || null
    : null;

  return {
    ok: true,
    primaryTarget: primary.targetPrice,
    secondaryTarget: secondary?.targetPrice ?? null,
    runnerTarget: runner?.targetPrice ?? null,
    targetCandidatesConsidered: candidates,
    droppedTargetCandidates,
    targetSourceTypePrimary: primary.sourceType,
    targetSourceTypeSecondary: secondary?.sourceType ?? null,
    targetSourceTypeRunner: runner?.sourceType ?? null,
    chosenTargetSourceType: primary.sourceType,
    targetSelectionReason: targetFallbackUsed
      ? "LEGACY_GENERIC_FALLBACK"
      : "PRIMARY_STAGE_SORT",
    rrAtPrimary: primary?.rr ?? null,
    rrAtSecondary: secondary?.rr ?? null,
    rrAtRunner: runner?.rr ?? null,
    targetQualityScore: Math.round(
      clamp(
        avg([
          primary?.targetScore,
          secondary?.targetScore ?? primary?.targetScore,
          runner?.targetScore ?? secondary?.targetScore ?? primary?.targetScore,
        ]) ?? 0,
        0,
        100,
      ),
    ),
    targetFallbackUsed,
    targetFallbackReason,
    targetWarnings: uniqueStrings([
      targetFallbackUsed ? "LEGACY_TARGET_FALLBACK" : null,
      runnerAllowed ? null : "RUNNER_SUPPRESSED",
    ]),
  };
}

function mapUnderlyingMoveToPremium({ absDelta, gammaAbs, move }) {
  const dS = Math.max(0, safeNum(move, 0));
  return dS * absDelta + (Number.isFinite(gammaAbs) ? 0.5 * gammaAbs * dS * dS : 0);
}

function mapOptionPlan(ctx, stopPlan, targetPlan) {
  if (!ctx.optionMeta) return null;

  const premEntry = safeNum(ctx.entryPremium, null);
  const tick = normalizeTickSize(ctx.premiumTick);
  if (!(Number.isFinite(premEntry) && premEntry > 0 && Number.isFinite(tick) && tick > 0)) {
    return { ok: false, reason: "BAD_PREMIUM_CONTEXT" };
  }

  const delta = safeNum(ctx.optionMeta?.delta, null);
  const gamma = safeNum(ctx.optionMeta?.gamma, null);
  const absDelta = clamp(
    Number.isFinite(delta) ? Math.abs(delta) : optionAbsDelta(ctx.env, ctx.optionMeta),
    0.2,
    0.95,
  );
  const gammaAbs = Number.isFinite(gamma) ? Math.abs(gamma) : null;
  const dte = daysToExpiry(ctx.optionMeta, ctx.nowTs);
  const nearExpiryFactor = Number.isFinite(dte) ? clamp((3 - dte) / 3, 0, 1) : 0;
  const volRef = safeNum(ctx.env?.OPT_VOL_REF_ATR_PCT, 0.6);
  const volFactor =
    Number.isFinite(ctx.atrPctUnderlying) && Number.isFinite(volRef) && volRef > 0
      ? clamp(ctx.atrPctUnderlying / volRef, 0.6, 1.8)
      : 1;
  const stopScale = clamp(
    1 + 0.22 * nearExpiryFactor + 0.12 * (volFactor - 1),
    1.0,
    safeNum(ctx.env?.OPT_GAMMA_SCALE_MAX, 1.35),
  );
  const targetScale = clamp(1 - 0.05 * nearExpiryFactor, 0.84, 1.1);
  const spreadBps = safeNum(ctx.optionMeta?.bps ?? ctx.spreadBps, null);
  const spreadPadAbs =
    Number.isFinite(spreadBps) && premEntry > 0
      ? Math.max(tick * 2, ((premEntry * spreadBps) / 10000) * 1.25)
      : tick * 2;
  const premiumPlan = buildPremiumAwareOptionPlan({
    env: ctx.env,
    side: "BUY",
    entryPremium: premEntry,
    premiumTick: tick,
    premiumCandles: ctx.premiumCandles,
    optionMeta: ctx.optionMeta,
    rrMin: ctx.requiredMinRr,
  });

  const premiumAtr = safeNum(premiumPlan?.meta?.atrPrem, null);
  const underlyingRisk = Math.abs(ctx.entryUnderlying - stopPlan.stopLoss);
  const minStopAbs = Math.max(
    tick * 4,
    spreadPadAbs * 1.35,
    Number.isFinite(premiumAtr) ? premiumAtr * 0.75 : 0,
    premEntry * 0.05,
  );
  const maxStopAbs = premEntry * (safeNum(ctx.env?.OPT_MAX_SL_PCT, 35) / 100);
  const mappedRiskAbs = mapUnderlyingMoveToPremium({
    absDelta,
    gammaAbs,
    move: underlyingRisk,
  }) * stopScale;
  const preferredRiskAbs = Math.max(
    mappedRiskAbs,
    Number.isFinite(premiumPlan?.stopLoss) ? Math.abs(premEntry - premiumPlan.stopLoss) : 0,
  );
  const finalRiskAbs = clamp(preferredRiskAbs, minStopAbs, Math.max(minStopAbs, maxStopAbs));
  const stopLoss = roundToTick(premEntry - finalRiskAbs, tick, "down");

  const mapTargetPrice = (underlyingTarget, rrFloor) => {
    if (!Number.isFinite(underlyingTarget)) return null;
    const mappedAbs =
      mapUnderlyingMoveToPremium({
        absDelta,
        gammaAbs,
        move: Math.abs(underlyingTarget - ctx.entryUnderlying),
      }) * targetScale;
    const minAbs = Math.max(finalRiskAbs * rrFloor, spreadPadAbs * 1.6, tick * 4);
    const premiumTarget = roundToTick(premEntry + Math.max(mappedAbs, minAbs), tick, "up");
    return premiumTarget > premEntry ? premiumTarget : null;
  };

  const primaryTarget = mapTargetPrice(targetPlan.primaryTarget, ctx.requiredMinRr);
  const secondaryTarget = mapTargetPrice(
    targetPlan.secondaryTarget,
    Math.max(ctx.requiredMinRr + 0.25, safeNum(targetPlan.rrAtSecondary, ctx.requiredMinRr)),
  );
  const runnerTarget = mapTargetPrice(
    targetPlan.runnerTarget,
    Math.max(2.1, safeNum(targetPlan.rrAtRunner, ctx.requiredMinRr + 0.5)),
  );

  return {
    ok: Number.isFinite(stopLoss) && Number.isFinite(primaryTarget),
    stopLoss,
    primaryTarget,
    secondaryTarget: Number.isFinite(secondaryTarget) ? secondaryTarget : null,
    runnerTarget: Number.isFinite(runnerTarget) ? runnerTarget : null,
    rrAtPrimary: Number.isFinite(primaryTarget)
      ? Math.abs(primaryTarget - premEntry) / Math.max(Math.abs(premEntry - stopLoss), 1e-9)
      : null,
    rrAtSecondary: Number.isFinite(secondaryTarget)
      ? Math.abs(secondaryTarget - premEntry) / Math.max(Math.abs(premEntry - stopLoss), 1e-9)
      : null,
    rrAtRunner: Number.isFinite(runnerTarget)
      ? Math.abs(runnerTarget - premEntry) / Math.max(Math.abs(premEntry - stopLoss), 1e-9)
      : null,
    qualityScore: Math.round(
      clamp(
        avg([
          Number.isFinite(delta) ? 82 : 60,
          Number.isFinite(gamma) ? 76 : 60,
          premiumPlan?.ok ? 84 : 60,
          Number.isFinite(spreadBps) ? clamp(100 - spreadBps, 20, 100) : 68,
          84 - nearExpiryFactor * 24,
        ]) ?? 0,
        0,
        100,
      ),
    ),
    warnings: uniqueStrings([
      premiumPlan?.ok ? null : "PREMIUM_AWARE_REFERENCE_UNAVAILABLE",
      Number.isFinite(delta) ? null : "DELTA_MISSING",
      Number.isFinite(gamma) ? null : "GAMMA_MISSING",
      Number.isFinite(spreadBps) && spreadBps > 35 ? "WIDE_OPTION_SPREAD" : null,
      nearExpiryFactor > 0.66 ? "NEAR_EXPIRY_CONVEXITY" : null,
    ]),
    meta: {
      modelUsed: premiumPlan?.ok ? "PREMIUM_AWARE_BLEND" : "DELTA_GAMMA_MAP_ONLY",
      absDelta,
      delta: Number.isFinite(delta) ? delta : null,
      gamma: Number.isFinite(gamma) ? gamma : null,
      daysToExpiry: Number.isFinite(dte) ? dte : null,
      volFactor,
      nearExpiryFactor,
      entryPremium: premEntry,
      mapped: {
        stopScale,
        targetScale,
        spreadPadAbs,
        mappedRiskAbs,
      },
      premiumAware: premiumPlan?.ok ? premiumPlan.meta || null : null,
      final: {
        stopPremium: stopLoss,
        targetPremium: primaryTarget,
        secondaryPremium: Number.isFinite(secondaryTarget) ? secondaryTarget : null,
        runnerPremium: Number.isFinite(runnerTarget) ? runnerTarget : null,
      },
    },
  };
}

function simplifyStopCandidate(candidate) {
  if (!candidate) return null;
  return {
    candidateKey: candidate.candidateKey || null,
    sourceType: candidate.stopSourceType,
    rawInvalidationLevel: safeNum(candidate.rawInvalidationLevel, null),
    paddedInvalidationLevel: safeNum(candidate.paddedInvalidationLevel, null),
    stopDistanceAbs: safeNum(candidate.stopDistanceAbs, null),
    stopDistanceAtr: safeNum(candidate.stopDistanceAtr, null),
    stopQualityScore: safeNum(candidate.stopQualityScore, null),
    stopTooTightFlag: Boolean(candidate.stopTooTightFlag),
    stopTooWideFlag: Boolean(candidate.stopTooWideFlag),
  };
}

function simplifyTargetCandidate(candidate) {
  if (!candidate) return null;
  return {
    candidateKey: candidate.candidateKey || null,
    sourceType: candidate.sourceType,
    targetPrice: safeNum(candidate.targetPrice, null),
    distanceAbs: safeNum(candidate.distanceAbs, null),
    rr: safeNum(candidate.rr, null),
    targetScore: safeNum(candidate.targetScore, null),
  };
}

function rrToleranceFromPlan({ ctx, entryPrice, stopLoss }) {
  const riskAbs =
    Number.isFinite(entryPrice) && Number.isFinite(stopLoss)
      ? Math.abs(entryPrice - stopLoss)
      : null;
  const tick = normalizeTickSize(ctx.optionMeta ? ctx.premiumTick : ctx.tickSize) || 0.05;
  if (!(Number.isFinite(riskAbs) && riskAbs > 0)) return 0.02;
  return Math.max(0.02, Math.min(0.12, (tick * 1.5) / riskAbs));
}

function resolveAuthoritativePrimaryPlan({ ctx, stopPlan, targetPlan, optionPlan }) {
  const entryPrice = ctx.optionMeta ? safePrice(ctx.entryPremium, null) : safePrice(ctx.entryUnderlying, null);
  const stopLoss = ctx.optionMeta ? safePrice(optionPlan?.stopLoss, null) : safePrice(stopPlan?.stopLoss, null);
  const targetPrice = ctx.optionMeta
    ? safePrice(optionPlan?.primaryTarget, null)
    : safePrice(targetPlan?.primaryTarget, null);
  const rrAtPrimary =
    Number.isFinite(entryPrice) &&
    Number.isFinite(stopLoss) &&
    Number.isFinite(targetPrice)
      ? Math.abs(targetPrice - entryPrice) / Math.max(Math.abs(entryPrice - stopLoss), 1e-9)
      : null;
  return {
    entryPrice,
    stopLoss,
    targetPrice,
    rrAtPrimary,
    rrTolerance: rrToleranceFromPlan({ ctx, entryPrice, stopLoss }),
  };
}

function plannerPathUsedForResult({ fallbackReason = null, stopPlan = null, targetPlan = null }) {
  if (
    fallbackReason === "OPTION_PREMIUM_MAPPING_FALLBACK" ||
    fallbackReason === "OPTION_PREMIUM_MAPPING_INVALID"
  ) {
    return "MIXED_ASSIST";
  }
  if (
    fallbackReason ||
    String(stopPlan?.stopSourceType || "").includes("LEGACY") ||
    String(targetPlan?.targetSourceTypePrimary || "").includes("LEGACY")
  ) {
    return "LEGACY_FALLBACK";
  }
  return "MODERN";
}

function buildPlannerRejectOutput(
  ctx,
  reason,
  {
    validation = null,
    entryPlan = null,
    stopPlan = null,
    targetPlan = null,
      warnings = [],
      readiness = null,
      modernPlannerReady = true,
    } = {},
) {
  return {
    ok: false,
    reason: reason || "PLANNER_REJECT",
    meta: {
      plannerVersion: "PRO_PLANNER_V2",
      plannerPathUsed: "MODERN",
      planQualityScore: 0,
      planAccept: false,
      planRejectReason: reason || "PLANNER_REJECT",
        planWarnings: uniqueStrings(warnings),
        planFallbackUsed: false,
        planFallbackReason: null,
        legacyFallbackUsed: false,
        legacyFallbackSupported:
          String(ctx.admissionProfile?.fallbackStrictness || "LEGACY_OK").toUpperCase() !==
            "STRICT" || ctx.family === "generic",
        modernPlannerReady,
        setup: {
        strategyId: ctx.strategyId,
        family: ctx.family,
        style: ctx.style,
        side: ctx.side,
        regime: ctx.regime,
        triggerType: ctx.triggerType,
        triggerLevel: ctx.triggerLevel,
        anchorType: ctx.anchorType,
        anchorValue: ctx.anchorValue,
        missingContextFlags: safeArr(ctx.missingContextFlags),
      },
      validation,
      entry: entryPlan,
      stop: stopPlan,
      targets: targetPlan,
      readiness: readiness || ctx.admissionReadiness || null,
        plannerTelemetry: {
          fallbackUsed: false,
          fallbackReason: null,
          plannerPathUsed: "MODERN",
          modernPlannerReady,
          readinessState:
            readiness?.state ||
            ctx.admissionReadiness?.state ||
            null,
        resolvedTriggerLevel: safePrice(ctx.triggerLevel, null),
        resolvedAnchorValue: safePrice(ctx.anchorValue, null),
      },
    },
  };
}

function buildFallbackPlanOutput(ctx, legacyPlan, fallbackReason, extraWarnings = []) {
  const plannerPathUsed = plannerPathUsedForResult({ fallbackReason });
  const modernPlannerReady = plannerPathUsed === "MIXED_ASSIST";
  const legacyFallbackUsed = plannerPathUsed === "LEGACY_FALLBACK";
  if (!legacyPlan?.ok) {
    return {
      ok: false,
      reason: fallbackReason || legacyPlan?.reason || "PLANNER_CONTEXT_UNAVAILABLE",
      meta: {
        plannerVersion: "PRO_PLANNER_V2",
        plannerPathUsed,
        planAccept: false,
        planRejectReason: fallbackReason || legacyPlan?.reason || "PLANNER_CONTEXT_UNAVAILABLE",
          planWarnings: uniqueStrings([
            "LEGACY_FALLBACK_UNAVAILABLE",
            ...safeArr(extraWarnings),
          ]),
          planFallbackUsed: true,
          planFallbackReason: fallbackReason || legacyPlan?.reason || "PLANNER_CONTEXT_UNAVAILABLE",
          legacyFallbackUsed,
          legacyFallbackSupported: true,
          modernPlannerReady,
          setup: {
          strategyId: ctx.strategyId,
          family: ctx.family,
          style: ctx.style,
          side: ctx.side,
          regime: ctx.regime,
          triggerType: ctx.triggerType,
          triggerLevel: ctx.triggerLevel,
          anchorType: ctx.anchorType,
          anchorValue: ctx.anchorValue,
          missingContextFlags: safeArr(ctx.missingContextFlags),
        },
        plannerTelemetry: {
          fallbackUsed: true,
          fallbackReason: fallbackReason || legacyPlan?.reason || "PLANNER_CONTEXT_UNAVAILABLE",
          plannerPathUsed,
          modernPlannerReady,
          readinessState: ctx.admissionReadiness?.state || null,
          resolvedTriggerLevel: safePrice(ctx.triggerLevel, null),
          resolvedAnchorValue: safePrice(ctx.anchorValue, null),
        },
      },
    };
  }

  const entry = safeNum(legacyPlan?.meta?.underlying?.entry, ctx.entryUnderlying);
  const stop = safeNum(legacyPlan?.meta?.underlying?.stop, null);
  const target = safeNum(legacyPlan?.meta?.underlying?.target, null);
  const riskAbs =
    safeNum(legacyPlan?.meta?.underlying?.R, null) ||
    (Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : null);

  return {
    ok: true,
    stopLoss: safeNum(legacyPlan.stopLoss, null),
    targetPrice: safeNum(legacyPlan.targetPrice, null),
    rr: safeNum(legacyPlan.rr, null),
    expectedMovePerUnit: safeNum(legacyPlan.expectedMovePerUnit, null),
    primaryTarget: safeNum(legacyPlan.targetPrice, null),
    secondaryTarget: null,
    runnerTarget: null,
    validationPassed: true,
    validationScore: null,
    planQualityScore: 58,
    meta: {
      ...(legacyPlan.meta || {}),
      plannerVersion: "PRO_PLANNER_V2",
      plannerPathUsed,
      planAccept: true,
      planRejectReason: null,
        planWarnings: uniqueStrings(["RICH_PLANNER_FALLBACK", ...safeArr(extraWarnings)]),
        planFallbackUsed: true,
        planFallbackReason: fallbackReason || "LEGACY_GENERIC",
        legacyFallbackUsed,
        legacyFallbackSupported: true,
        modernPlannerReady,
        readiness: ctx.admissionReadiness || null,
      setup: {
        strategyId: ctx.strategyId,
        family: ctx.family,
        style: ctx.style,
        side: ctx.side,
        regime: ctx.regime,
        signalReason: ctx.signalReason,
        signalConfidence: ctx.signalConfidence,
        setupState: ctx.setupState,
        triggerType: ctx.triggerType,
        triggerLevel: ctx.triggerLevel,
        anchorType: ctx.anchorType,
        anchorValue: ctx.anchorValue,
        retestState: ctx.retestState,
        setupFreshnessBars: ctx.setupFreshnessBars,
        volumeQuality: ctx.volumeQuality,
        structureQuality: ctx.structureQuality,
        patternQuality: ctx.patternQuality,
        volumeRatio: safeNum(ctx.signalMeta?.volumeRatio, null),
        missingContextFlags: safeArr(ctx.missingContextFlags),
      },
      validation: null,
      entry: {
        entryMode: "LEGACY_FALLBACK",
        entryAccept: true,
        entryRejectReason: null,
      },
      stop: {
        stopSourceType: legacyPlan?.meta?.slReason || "LEGACY_GENERIC",
        stopSourceDescription: "Legacy planner fallback",
        rawInvalidationLevel: stop,
        paddedInvalidationLevel: stop,
        stopDistanceAbs: riskAbs,
        stopDistancePct:
          Number.isFinite(entry) && entry > 0 && Number.isFinite(riskAbs)
            ? (riskAbs / entry) * 100
            : null,
        stopDistanceAtr: null,
        stopQualityScore: 52,
        stopTooTightFlag: false,
        stopTooWideFlag: false,
        stopFallbackUsed: true,
        stopFallbackReason: fallbackReason || "LEGACY_GENERIC",
        stopWarnings: uniqueStrings(["RICH_STOP_CONTEXT_MISSING"]),
        stopCandidatesConsidered: [],
      },
      targets: {
        primaryTarget: target,
        secondaryTarget: null,
        runnerTarget: null,
        targetCandidatesConsidered: [],
        targetSourceTypePrimary: legacyPlan?.meta?.targetReason || "LEGACY_GENERIC",
        targetSourceTypeSecondary: null,
        targetSourceTypeRunner: null,
        rrAtPrimary: safeNum(legacyPlan.rr, null),
        rrAtSecondary: null,
        rrAtRunner: null,
        targetQualityScore: 54,
        targetFallbackUsed: true,
        targetFallbackReason: fallbackReason || "LEGACY_GENERIC",
        targetWarnings: uniqueStrings(["RICH_TARGET_CONTEXT_MISSING"]),
      },
        plannerTelemetry: {
          fallbackUsed: true,
          fallbackReason: fallbackReason || "LEGACY_GENERIC",
          plannerPathUsed,
          modernPlannerReady,
          readinessState: ctx.admissionReadiness?.state || null,
        },
      underlying: {
        entry,
        stop,
        target,
        secondaryTarget: null,
        runnerTarget: null,
        R: riskAbs,
      },
    },
  };
}

function assessPlannerReadiness(ctx) {
  const blockers = [];
  if (!ctx.signal) blockers.push("NO_SIGNAL_CONTEXT");
  if (!(ctx.side === "BUY" || ctx.side === "SELL")) blockers.push("INVALID_SIDE");
  if (!Number.isFinite(ctx.currentPrice)) blockers.push("MISSING_CURRENT_PRICE");
  if (ctx.family !== "generic") {
    if (!Number.isFinite(ctx.anchorValue)) blockers.push("MISSING_ANCHOR_VALUE");
    if (!Number.isFinite(ctx.triggerLevel)) blockers.push("MISSING_TRIGGER_LEVEL");
  }
  return {
    ready: blockers.length === 0,
    blockers: uniqueStrings(blockers),
  };
}

function scoreTradePlan({
  ctx,
  validation,
  entryPlan,
  stopPlan,
  targetPlan,
  optionPlan,
}) {
  const authoritativePrimaryPlan = resolveAuthoritativePrimaryPlan({
    ctx,
    stopPlan,
    targetPlan,
    optionPlan,
  });
  const rrPrimary = safeNum(authoritativePrimaryPlan.rrAtPrimary, null);
  const rrQuality = Number.isFinite(rrPrimary)
    ? clamp(28 + rrPrimary * 26, 0, 100)
    : 24;
  const executionPracticality = clamp(
    avg([
      Number.isFinite(ctx.spreadBps) ? clamp(100 - ctx.spreadBps * 1.1, 12, 100) : 72,
      stopPlan?.stopTooTightFlag ? 28 : 78,
      stopPlan?.stopTooWideFlag ? 48 : 76,
      ctx.sessionTiming?.lateSession ? 58 : 74,
    ]) ?? 64,
    0,
    100,
  );
  const optionQuality =
    ctx.optionMeta != null
      ? clamp(
          avg([
            safeNum(optionPlan?.qualityScore, optionPlan?.ok ? 72 : 38),
            Number.isFinite(ctx.optionMeta?.delta) ? 82 : 60,
            Number.isFinite(ctx.optionMeta?.gamma) ? 76 : 60,
          ]) ?? 50,
          0,
          100,
        )
      : 72;
  const planQualityScore = Math.round(
    clamp(
      avg([
        validation?.validationScore,
        entryPlan?.entryQualityScore,
        stopPlan?.stopQualityScore,
        targetPlan?.targetQualityScore,
        rrQuality,
        validation?.structureCleanlinessScore,
        executionPracticality,
        optionQuality,
      ]) ?? 0,
      0,
      100,
    ),
  );

  const planWarnings = uniqueStrings([
    ...safeArr(validation?.validationWarnings),
    ...safeArr(entryPlan?.entryWarnings),
    ...safeArr(stopPlan?.stopWarnings),
    ...safeArr(targetPlan?.targetWarnings),
    ...(ctx.optionMeta ? safeArr(optionPlan?.warnings) : []),
  ]);

  let planRejectReason = null;
  if (!validation?.validationPassed) {
    planRejectReason = validation?.validationRejectReasons?.[0] || "VALIDATION_REJECTED";
  } else if (!entryPlan?.entryAccept) {
    planRejectReason = entryPlan?.entryRejectReason || "ENTRY_REJECTED";
  } else if (!stopPlan?.ok) {
    planRejectReason = stopPlan?.reason || "STOP_INVALID";
  } else if (!targetPlan?.ok) {
    planRejectReason = targetPlan?.reason || "TARGET_INVALID";
  } else if (ctx.optionMeta && optionPlan && !optionPlan.ok) {
    planRejectReason = optionPlan.reason || "OPTION_PREMIUM_MAPPING_INVALID";
  } else if (stopPlan?.stopTooTightFlag) {
    planRejectReason = "STOP_TOO_TIGHT";
  } else if (
    Number.isFinite(rrPrimary) &&
    rrPrimary + authoritativePrimaryPlan.rrTolerance < ctx.requiredMinRr
  ) {
    planRejectReason = "TARGET_BELOW_MIN_RR";
  } else if (planQualityScore < Math.max(58, Number(ctx.env?.PLAN_MIN_QUALITY_SCORE ?? 58))) {
    planRejectReason = "PLAN_QUALITY_TOO_LOW";
  }

  return {
    authoritativePrimaryPlan,
    planQualityScore,
    planAccept: !planRejectReason,
    planRejectReason,
    planWarnings,
    rrQuality: Math.round(rrQuality),
    executionPracticality: Math.round(executionPracticality),
    optionQualityScore: Math.round(optionQuality),
  };
}

function emitPlannerTelemetry(ctx, payload) {
  const logger = ctx.logger;
  if (!logger || typeof logger.info !== "function") return;

  const { validation, entryPlan, stopPlan, targetPlan, optionPlan, planScore, finalResult } = payload;

  logger.info(
    {
      strategyId: ctx.strategyId,
      family: ctx.family,
      side: ctx.side,
      anchorType: entryPlan?.entryAnchorType || ctx.anchorType,
      anchorValue: safeNum(entryPlan?.entryAnchorValue, ctx.anchorValue),
      triggerType: entryPlan?.entryTriggerType || ctx.triggerType,
      triggerValue: safeNum(entryPlan?.entryTriggerValue, ctx.triggerLevel),
      distanceFromAnchor: safeNum(entryPlan?.currentDistanceFromAnchor, null),
      distanceFromTrigger: safeNum(entryPlan?.currentDistanceFromTrigger, null),
      freshnessBars: safeNum(entryPlan?.entryFreshnessBars, null),
      extensionVsAtr: safeNum(entryPlan?.extensionVsAtr, null),
      entryScore: safeNum(entryPlan?.entryQualityScore, null),
      entryAccept: Boolean(entryPlan?.entryAccept),
      entryRejectReason: entryPlan?.entryRejectReason || null,
      validationRejectReasons: safeArr(validation?.validationRejectReasons),
      validationWarnings: safeArr(validation?.validationWarnings),
    },
    "[planner] entry",
  );

  logger.info(
    {
      strategyId: ctx.strategyId,
      family: ctx.family,
      side: ctx.side,
      chosenStop: stopPlan
        ? {
            sourceType: stopPlan.stopSourceType,
            selectionReason: stopPlan.stopSelectionReason || null,
            rawInvalidationLevel: safeNum(stopPlan.rawInvalidationLevel, null),
            paddedInvalidationLevel: safeNum(stopPlan.paddedInvalidationLevel, null),
            stopDistanceAbs: safeNum(stopPlan.stopDistanceAbs, null),
            stopDistanceAtr: safeNum(stopPlan.stopDistanceAtr, null),
            stopScore: safeNum(stopPlan.stopQualityScore, null),
            fallbackUsed: Boolean(stopPlan.stopFallbackUsed),
          }
        : null,
      stopCandidates: safeArr(stopPlan?.stopCandidatesConsidered)
        .slice(0, 4)
        .map(simplifyStopCandidate),
    },
    "[planner] stop",
  );

  logger.info(
    {
      strategyId: ctx.strategyId,
      family: ctx.family,
      side: ctx.side,
      chosenTargets: targetPlan
        ? {
            primaryTarget: safeNum(targetPlan.primaryTarget, null),
            secondaryTarget: safeNum(targetPlan.secondaryTarget, null),
            runnerTarget: safeNum(targetPlan.runnerTarget, null),
            sourceType: targetPlan.targetSourceTypePrimary || null,
            selectionReason: targetPlan.targetSelectionReason || null,
            rrAtPrimary: safeNum(targetPlan.rrAtPrimary, null),
            rrAtSecondary: safeNum(targetPlan.rrAtSecondary, null),
            rrAtRunner: safeNum(targetPlan.rrAtRunner, null),
            targetScore: safeNum(targetPlan.targetQualityScore, null),
            fallbackUsed: Boolean(targetPlan.targetFallbackUsed),
          }
        : null,
      targetCandidates: safeArr(targetPlan?.targetCandidatesConsidered)
        .slice(0, 5)
        .map(simplifyTargetCandidate),
      droppedTargetSources: safeArr(targetPlan?.droppedTargetCandidates)
        .slice(0, 5)
        .map((candidate) => ({
          sourceType: candidate?.sourceType || "UNKNOWN",
          reason: candidate?.reason || "INVALID_TARGET",
        })),
      optionMapping:
        ctx.optionMeta != null
          ? {
              ok: Boolean(optionPlan?.ok),
              qualityScore: safeNum(optionPlan?.qualityScore, null),
              rrAtPrimary: safeNum(optionPlan?.rrAtPrimary, null),
              warnings: safeArr(optionPlan?.warnings),
            }
          : null,
    },
    "[planner] target",
  );

  logger.info(
    {
      strategyId: ctx.strategyId,
      family: ctx.family,
      side: ctx.side,
      validationScore: safeNum(validation?.validationScore, null),
      planQualityScore: safeNum(planScore?.planQualityScore, null),
      planAccept: Boolean(planScore?.planAccept),
      planRejectReason: planScore?.planRejectReason || null,
      planWarnings: safeArr(planScore?.planWarnings),
      plannerPathUsed: finalResult?.meta?.plannerPathUsed || null,
      readinessState: finalResult?.meta?.plannerTelemetry?.readinessState || null,
      authoritativePrimaryRr: safeNum(
        planScore?.authoritativePrimaryPlan?.rrAtPrimary,
        null,
      ),
      rrAcceptanceTolerance: safeNum(
        planScore?.authoritativePrimaryPlan?.rrTolerance,
        null,
      ),
      finalStopLoss: safeNum(finalResult?.stopLoss, null),
      finalTargetPrice: safeNum(finalResult?.targetPrice, null),
      rr: safeNum(finalResult?.rr, null),
    },
    "[planner] plan",
  );
}

function buildTradePlan(args) {
  let cachedLegacyPlan = null;
  let legacyPlanBuilt = false;
  const ensureLegacyPlan = () => {
    if (!legacyPlanBuilt) {
      cachedLegacyPlan = buildLegacyTradePlan(args);
      legacyPlanBuilt = true;
    }
    return cachedLegacyPlan;
  };

  const ctx = buildPlannerContext(args, null);
  const readiness = assessPlannerReadiness(ctx);
  const strictPlannerFallback =
    String(ctx.admissionProfile?.fallbackStrictness || "LEGACY_OK").toUpperCase() ===
    "STRICT";

  if (
    ctx.admissionReadiness?.state === "BLOCKED_INCOMPLETE" ||
    ctx.admissionReadiness?.state === "BLOCKED_STALE"
  ) {
    return buildPlannerRejectOutput(
      ctx,
      ctx.admissionReadiness.reasonCode || "ADMISSION_SNAPSHOT_INCOMPLETE",
      {
        warnings: [
          ...safeArr(ctx.admissionReadiness.blockers),
          ...safeArr(ctx.admissionReadiness.degradedBy),
        ],
        readiness: ctx.admissionReadiness,
        modernPlannerReady: false,
      },
    );
  }

  if (!readiness.ready) {
    if (strictPlannerFallback && ctx.family !== "generic") {
      return buildPlannerRejectOutput(ctx, "RICH_CONTEXT_INCOMPLETE", {
        warnings: readiness.blockers,
        readiness: ctx.admissionReadiness,
        modernPlannerReady: false,
      });
    }
    return buildFallbackPlanOutput(
      ctx,
      ensureLegacyPlan(),
      "RICH_CONTEXT_INCOMPLETE",
      readiness.blockers,
    );
  }

  const validation = validateSetupContext(ctx);
  const entryPlan = buildEntryPlan(ctx, validation);
  const stopPlan = buildStopPlan(ctx, null);
  const targetPlan = stopPlan?.ok ? chooseTargetLadder(ctx, stopPlan, null) : null;

  if (!stopPlan?.ok || !targetPlan?.ok) {
    const reject = buildPlannerRejectOutput(
      ctx,
      stopPlan?.reason || targetPlan?.reason || "PLAN_COMPONENT_INVALID",
      {
        validation,
        entryPlan,
        stopPlan,
        targetPlan,
        warnings: uniqueStrings([
          ...safeArr(validation?.validationWarnings),
          ...safeArr(stopPlan?.stopWarnings),
          ...safeArr(targetPlan?.targetWarnings),
        ]),
        readiness: ctx.admissionReadiness,
      },
    );

    emitPlannerTelemetry(ctx, {
      validation,
      entryPlan,
      stopPlan,
      targetPlan,
      optionPlan: null,
      planScore: {
        planQualityScore: 0,
        planAccept: false,
        planRejectReason: reject.meta.planRejectReason,
        planWarnings: reject.meta.planWarnings,
      },
      finalResult: reject,
    });

    return reject;
  }

  const optionPlan = ctx.optionMeta ? mapOptionPlan(ctx, stopPlan, targetPlan) : null;

  if (ctx.optionMeta && !optionPlan?.ok) {
    const fallback = buildFallbackPlanOutput(
      ctx,
      ensureLegacyPlan(),
      "OPTION_PREMIUM_MAPPING_FALLBACK",
      [optionPlan?.reason || "OPTION_PREMIUM_MAPPING_INVALID"],
    );
    if (fallback?.meta) {
      fallback.meta.validation = validation;
      fallback.meta.entry = entryPlan;
      fallback.meta.stop = {
        ...stopPlan,
        stopCandidatesConsidered: safeArr(stopPlan.stopCandidatesConsidered).map(simplifyStopCandidate),
      };
      fallback.meta.targets = {
        ...targetPlan,
        targetCandidatesConsidered: safeArr(targetPlan.targetCandidatesConsidered).map(simplifyTargetCandidate),
      };
      fallback.meta.underlying = {
        entry: ctx.entryUnderlying,
        stop: stopPlan.stopLoss,
        target: targetPlan.primaryTarget,
        secondaryTarget: targetPlan.secondaryTarget,
        runnerTarget: targetPlan.runnerTarget,
        R: stopPlan.stopDistanceAbs,
      };
      fallback.meta.option = ensureLegacyPlan()?.meta?.option || null;
      fallback.meta.planWarnings = uniqueStrings([
        ...safeArr(fallback.meta.planWarnings),
        ...safeArr(optionPlan?.warnings),
      ]);
    }
    emitPlannerTelemetry(ctx, {
      validation,
      entryPlan,
      stopPlan,
      targetPlan,
      optionPlan,
      planScore: {
        planQualityScore: fallback?.planQualityScore || 58,
        planAccept: Boolean(fallback?.meta?.planAccept),
        planRejectReason: fallback?.meta?.planRejectReason || null,
        planWarnings: fallback?.meta?.planWarnings || [],
      },
      finalResult: fallback,
    });
    return fallback;
  }

  const planScore = scoreTradePlan({
    ctx,
    validation,
    entryPlan,
    stopPlan,
    targetPlan,
    optionPlan,
  });

  const finalStopLoss = safePrice(planScore.authoritativePrimaryPlan.stopLoss, null);
  const primaryTarget = safePrice(planScore.authoritativePrimaryPlan.targetPrice, null);
  const secondaryTarget = ctx.optionMeta ? optionPlan.secondaryTarget : targetPlan.secondaryTarget;
  const runnerTarget = ctx.optionMeta ? optionPlan.runnerTarget : targetPlan.runnerTarget;
  const rr = safeNum(planScore.authoritativePrimaryPlan.rrAtPrimary, null);
  const expectedMovePerUnit = Number.isFinite(finalStopLoss) && Number.isFinite(primaryTarget)
    ? Math.abs(primaryTarget - (ctx.optionMeta ? ctx.entryPremium : ctx.entryUnderlying))
    : safeNum(ensureLegacyPlan()?.expectedMovePerUnit, null);

  const stopCandidatesConsidered = safeArr(stopPlan.stopCandidatesConsidered).map(simplifyStopCandidate);
  const targetCandidatesConsidered = safeArr(targetPlan.targetCandidatesConsidered).map(simplifyTargetCandidate);
  const plannerPathUsed = plannerPathUsedForResult({
    stopPlan,
    targetPlan,
  });

  const meta = {
    plannerVersion: "PRO_PLANNER_V2",
    plannerPathUsed,
    modernPlannerReady: true,
    legacyFallbackUsed: false,
    style: ctx.style,
    k: ctx.k,
    m: ctx.m,
    minRr: ctx.requiredMinRr,
    styleMinRr: minRR(ctx.env, ctx.style),
    effectiveMinRr: ctx.requiredMinRr,
    slReason: stopPlan.stopSourceType,
    targetReason: targetPlan.targetSourceTypePrimary,
    rrUnderlying: targetPlan.rrAtPrimary,
    setup: {
      strategyId: ctx.strategyId,
      family: ctx.family,
      style: ctx.style,
      side: ctx.side,
      regime: ctx.regime,
      signalReason: ctx.signalReason,
      signalConfidence: ctx.signalConfidence,
      setupState: ctx.setupState,
      triggerType: ctx.triggerType,
      triggerLevel: ctx.triggerLevel,
      anchorType: ctx.anchorType,
      anchorValue: ctx.anchorValue,
      retestState: ctx.retestState,
      setupFreshnessBars: ctx.setupFreshnessBars,
      volumeQuality: ctx.volumeQuality,
      structureQuality: ctx.structureQuality,
      patternQuality: ctx.patternQuality,
      volumeRatio: safeNum(ctx.signalMeta?.volumeRatio, null),
      missingContextFlags: safeArr(ctx.missingContextFlags),
    },
    validation,
    entry: entryPlan,
    stop: {
      ...stopPlan,
      stopCandidatesConsidered,
    },
    targets: {
      ...targetPlan,
      targetCandidatesConsidered,
    },
    authoritativePrimaryRrUsed: rr,
    authoritativePrimaryTarget: primaryTarget,
    authoritativePrimaryStop: finalStopLoss,
    chosenStopSourceType: stopPlan.stopSourceType,
    chosenTargetSourceType: targetPlan.targetSourceTypePrimary,
    targetSelectionReason: targetPlan.targetSelectionReason || null,
    stopSelectionReason: stopPlan.stopSelectionReason || null,
    finalPlanBasis: ctx.optionMeta ? "OPTION_MAPPED" : "UNDERLYING_STRUCTURAL",
    planQualityScore: planScore.planQualityScore,
    planAccept: planScore.planAccept,
    planRejectReason: planScore.planRejectReason,
    planWarnings: planScore.planWarnings,
    planFallbackUsed: false,
    planFallbackReason: null,
    legacyFallbackSupported:
      String(ctx.admissionProfile?.fallbackStrictness || "LEGACY_OK").toUpperCase() !==
        "STRICT" || ctx.family === "generic",
    readiness: ctx.admissionReadiness || null,
    plannerTelemetry: {
      plannerPathUsed,
      modernPlannerReady: true,
      readinessState: ctx.admissionReadiness?.state || null,
      rrQuality: planScore.rrQuality,
      executionPracticality: planScore.executionPracticality,
      optionQualityScore: planScore.optionQualityScore,
      rrAcceptanceTolerance: safeNum(planScore.authoritativePrimaryPlan.rrTolerance, null),
      resolvedTriggerLevel: safePrice(ctx.triggerLevel, null),
      resolvedAnchorValue: safePrice(ctx.anchorValue, null),
      invalidTargetSources: safeArr(targetPlan?.droppedTargetCandidates)
        .map((candidate) => `${candidate.sourceType}:${candidate.reason}`),
      legacyFallbackUsed: false,
    },
    underlying: {
      entry: ctx.entryUnderlying,
      stop: stopPlan.stopLoss,
      target: targetPlan.primaryTarget,
      secondaryTarget: targetPlan.secondaryTarget,
      runnerTarget: targetPlan.runnerTarget,
      R: stopPlan.stopDistanceAbs,
    },
  };

  if (ctx.optionMeta) {
    meta.option = {
      ...(optionPlan?.meta || {}),
      rrAtPrimary: optionPlan?.rrAtPrimary ?? null,
      rrAtSecondary: optionPlan?.rrAtSecondary ?? null,
      rrAtRunner: optionPlan?.rrAtRunner ?? null,
      qualityScore: optionPlan?.qualityScore ?? null,
      warnings: optionPlan?.warnings || [],
    };
  }

  const result = {
    ok: Boolean(planScore.planAccept),
    reason: planScore.planAccept ? null : planScore.planRejectReason,
    stopLoss: planScore.planAccept ? finalStopLoss : null,
    targetPrice: planScore.planAccept ? primaryTarget : null,
    rr: planScore.planAccept ? rr : null,
    expectedMovePerUnit: planScore.planAccept ? expectedMovePerUnit : null,
    primaryTarget: planScore.planAccept ? primaryTarget : null,
    secondaryTarget: planScore.planAccept ? secondaryTarget : null,
    runnerTarget: planScore.planAccept ? runnerTarget : null,
    validationPassed: validation.validationPassed,
    validationScore: validation.validationScore,
    validationRejectReasons: validation.validationRejectReasons,
    validationWarnings: validation.validationWarnings,
    chaseScore: validation.chaseScore,
    structureCleanlinessScore: validation.structureCleanlinessScore,
    followThroughReadinessScore: validation.followThroughReadinessScore,
    entryPlan,
    stopPlan: {
      ...stopPlan,
      stopCandidatesConsidered,
    },
    targetPlan: {
      ...targetPlan,
      targetCandidatesConsidered,
    },
    authoritativePrimaryRrUsed: rr,
    planQualityScore: planScore.planQualityScore,
    planAccept: planScore.planAccept,
    planRejectReason: planScore.planRejectReason,
    planWarnings: planScore.planWarnings,
    meta,
  };

  emitPlannerTelemetry(ctx, {
    validation,
    entryPlan,
    stopPlan,
    targetPlan,
    optionPlan,
    planScore,
    finalResult: result,
  });

  return result;
}

module.exports = { buildTradePlan };
