const { DateTime } = require("luxon");
const { emaSeries } = require("./ema");
const {
  atr,
  clamp,
  maxHigh,
  minLow,
  sessionVWAP,
  getCurrentSessionCandles,
} = require("./utils");
const { getMinCandlesForRegime } = require("./minCandles");

function parseList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function directionalPersistence(closes, window = 12) {
  if (!closes || closes.length < 3) return 0;
  const recent = closes.slice(-Math.max(3, Math.min(window, closes.length)));
  let up = 0;
  let down = 0;
  for (let i = 1; i < recent.length; i++) {
    const diff = recent[i] - recent[i - 1];
    if (diff > 0) up += 1;
    if (diff < 0) down += 1;
  }
  const total = up + down;
  if (!total) return 0.5;
  return Math.max(up, down) / total;
}

function resolveSessionPhase({
  minsFromOpen,
  minsToClose,
  openWindowMin,
  directionalBias,
  rangePct,
  rangePctMax,
}) {
  if (minsFromOpen >= 0 && minsFromOpen < Math.min(10, openWindowMin)) return "OPEN_INIT";
  if (minsFromOpen >= 0 && minsFromOpen <= openWindowMin) {
    return directionalBias >= 0.55 ? "OPEN_EXPANSION" : "OPEN_INIT";
  }
  if (minsToClose <= 45) return "LATE_SESSION";
  if (minsFromOpen >= 90 && minsToClose >= 90 && rangePct <= rangePctMax * 1.2 && directionalBias < 0.58) {
    return "MIDDAY_COMPRESSION";
  }
  return "REGULAR";
}

function normalizeScores(scores) {
  const cleaned = {};
  let total = 0;
  for (const [key, value] of Object.entries(scores)) {
    const numeric = clamp(Number(value ?? 0), 0, 100);
    cleaned[key] = numeric;
    total += numeric;
  }
  if (total <= 0) {
    return Object.fromEntries(Object.keys(scores).map((key) => [key, 0]));
  }
  const normalized = {};
  for (const [key, value] of Object.entries(cleaned)) {
    normalized[key] = Number((value / total).toFixed(4));
  }
  return normalized;
}

function rankWeights(weights) {
  return Object.entries(weights)
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .map(([key, value]) => ({ regime: key, weight: Number(value ?? 0) }));
}

function detectRegime({ candles, env, now = new Date() }) {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const dt = DateTime.fromJSDate(now, { zone: tz });
  const open = DateTime.fromFormat(env.MARKET_OPEN || "09:15", "HH:mm", {
    zone: tz,
  }).set({ year: dt.year, month: dt.month, day: dt.day });
  const close = DateTime.fromFormat(env.MARKET_CLOSE || "15:30", "HH:mm", {
    zone: tz,
  }).set({ year: dt.year, month: dt.month, day: dt.day });

  const openWinMin = Number(env.SELECTOR_OPEN_WINDOW_MIN ?? 20);
  const minsFromOpen = open.isValid ? dt.diff(open, "minutes").minutes : 9999;
  const minsToClose = close.isValid ? close.diff(dt, "minutes").minutes : 9999;
  const sessionBars = getCurrentSessionCandles(candles, { endTs: now });
  const sessionCloses = sessionBars.map((candle) => Number(candle?.close)).filter(Number.isFinite);
  const sessionBias = directionalPersistence(sessionCloses, 14);
  const rangePctMax = Number(env.SELECTOR_RANGE_PCT_MAX ?? 0.012);

  const openPhase = resolveSessionPhase({
    minsFromOpen,
    minsToClose,
    openWindowMin: openWinMin,
    directionalBias: sessionBias,
    rangePct: 0,
    rangePctMax,
  });

  const minCandles = getMinCandlesForRegime(env);
  if (!sessionBars || sessionBars.length < Math.max(2, minCandles)) {
    return {
      regime: minsFromOpen >= 0 && minsFromOpen <= openWinMin ? "OPEN" : "UNKNOWN",
      primaryRegime: minsFromOpen >= 0 && minsFromOpen <= openWinMin ? "OPEN" : "UNKNOWN",
      secondaryRegime: null,
      regimeWeights: normalizeScores({
        OPEN: minsFromOpen >= 0 && minsFromOpen <= openWinMin ? 100 : 0,
        TREND: 0,
        TREND_COMPRESSED: 0,
        RANGE: 0,
        BREAKOUT_WATCH: 0,
      }),
      meta: {
        reason: "INSUFFICIENT_CANDLES",
        minsFromOpen,
        minsToClose,
        sessionPhase: openPhase,
      },
    };
  }

  const fast = Number(env.SELECTOR_FAST_EMA ?? 9);
  const slow = Number(env.SELECTOR_SLOW_EMA ?? 21);
  const lookback = Number(env.SELECTOR_RANGE_LOOKBACK ?? 30);
  const atrPeriod = Number(env.SELECTOR_ATR_PERIOD ?? 14);
  if (sessionCloses.length < slow + 2) {
    return {
      regime: "UNKNOWN",
      primaryRegime: "UNKNOWN",
      secondaryRegime: null,
      regimeWeights: normalizeScores({
        OPEN: 0,
        TREND: 0,
        TREND_COMPRESSED: 0,
        RANGE: 0,
        BREAKOUT_WATCH: 0,
      }),
      meta: {
        reason: "BAD_CLOSES",
        minsFromOpen,
        minsToClose,
        sessionPhase: openPhase,
      },
    };
  }

  const ef = emaSeries(sessionCloses, fast);
  const es = emaSeries(sessionCloses, slow);
  const cur = sessionCloses[sessionCloses.length - 1];
  const emaDiff = Math.abs(Number(ef[ef.length - 1] || 0) - Number(es[es.length - 1] || 0));
  const atrVal = atr(sessionBars, atrPeriod) || cur * 0.001;
  const diffInAtr = atrVal > 0 ? emaDiff / atrVal : 0;
  const lookbackUsed = Math.min(lookback, sessionBars.length);
  const hi = maxHigh(sessionBars, lookbackUsed);
  const lo = minLow(sessionBars, lookbackUsed);
  const rangePct = cur > 0 ? (hi - lo) / cur : 0;
  const rangeSpan = Math.max(hi - lo, 0.0001);
  const boundaryBias = clamp(
    Math.max((cur - lo) / rangeSpan, (hi - cur) / rangeSpan),
    0,
    1,
  );
  const vwap = sessionVWAP(sessionBars, sessionBars[sessionBars.length - 1]?.ts);
  const vwapDist = cur > 0 && Number.isFinite(vwap) ? Math.abs(cur - vwap) / cur : 0;
  const trendUpBias = ef[ef.length - 1] > es[es.length - 1] && cur >= (vwap || cur);
  const trendDownBias = ef[ef.length - 1] < es[es.length - 1] && cur <= (vwap || cur);
  const persistence = directionalPersistence(sessionCloses, 14);
  const trendDiffAtr = Number(env.SELECTOR_TREND_DIFF_ATR ?? 0.6);
  const rangeDiffAtrMax = Number(env.SELECTOR_RANGE_DIFF_ATR_MAX ?? 0.25);
  const compressedTrendDiffAtr = Math.max(0.2, trendDiffAtr * 0.5);
  const compressedTrendRangePct = Math.max(rangePctMax * 1.5, 0.015);
  const sessionPhase = resolveSessionPhase({
    minsFromOpen,
    minsToClose,
    openWindowMin: openWinMin,
    directionalBias: persistence,
    rangePct,
    rangePctMax,
  });

  const openScore = clamp(
    minsFromOpen >= 0 && minsFromOpen <= openWinMin
      ? 88 - (minsFromOpen / Math.max(1, openWinMin)) * 28 + persistence * 8
      : 0,
    0,
    100,
  );
  const trendScore = clamp(
    diffInAtr / Math.max(0.1, trendDiffAtr) * 48 +
      persistence * 34 +
      (trendUpBias || trendDownBias ? 12 : 0) -
      Math.max(0, (rangePctMax - rangePct) * 1200),
    0,
    100,
  );
  const trendCompressedScore = clamp(
    diffInAtr / Math.max(0.1, compressedTrendDiffAtr) * 34 +
      persistence * 28 +
      Math.max(0, 1 - rangePct / Math.max(compressedTrendRangePct, 0.0001)) * 30 +
      (trendUpBias || trendDownBias ? 8 : 0),
    0,
    100,
  );
  const rangeScore = clamp(
    Math.max(0, 1 - diffInAtr / Math.max(0.1, rangeDiffAtrMax)) * 42 +
      Math.max(0, 1 - Math.abs(persistence - 0.5) / 0.5) * 28 +
      Math.max(0, 1 - rangePct / Math.max(rangePctMax, 0.0001)) * 30,
    0,
    100,
  );
  const breakoutWatchScore = clamp(
    Math.max(0, 1 - rangePct / Math.max(compressedTrendRangePct, 0.0001)) * 38 +
      boundaryBias * 26 +
      persistence * 22 +
      Math.max(0, 1 - vwapDist / 0.01) * 14,
    0,
    100,
  );

  const regimeWeights = normalizeScores({
    OPEN: openScore,
    TREND: trendScore,
    TREND_COMPRESSED: trendCompressedScore,
    RANGE: rangeScore,
    BREAKOUT_WATCH: breakoutWatchScore,
  });
  const ranked = rankWeights(regimeWeights);
  const primaryRegime = ranked[0]?.regime || "UNKNOWN";
  const secondaryRegime = ranked[1]?.weight >= 0.18 ? ranked[1].regime : null;
  const regime = primaryRegime === "BREAKOUT_WATCH" ? "TREND_COMPRESSED" : primaryRegime;
  const dayShape =
    breakoutWatchScore >= 0.22
      ? "BREAKOUT_WATCH"
      : persistence < 0.55 && rangePct <= rangePctMax * 1.2
        ? "CHOP"
        : persistence >= 0.62
          ? "DIRECTIONAL"
          : "BALANCED";

  return {
    regime,
    primaryRegime,
    secondaryRegime,
    regimeWeights,
    meta: {
      diffInAtr,
      rangePct,
      vwapDist,
      minsFromOpen,
      minsToClose,
      sessionPhase,
      dayShape,
      directionalPersistence: persistence,
      bias: trendUpBias ? "UP" : trendDownBias ? "DOWN" : "BALANCED",
      regimeWeights,
      primaryRegime,
      secondaryRegime,
      openScore,
      trendScore,
      trendCompressedScore,
      rangeScore,
      breakoutWatchScore,
    },
  };
}

function addBucketStrategies(target, strategyIds, weight, bonus = 0) {
  for (const id of strategyIds || []) {
    const nextWeight = clamp(Number(weight ?? 0) + bonus, 0, 1);
    target.set(id, Math.max(Number(target.get(id) ?? 0), nextWeight));
  }
}

function pickStrategies({ candles, env, now = new Date() }) {
  const det = detectRegime({ candles, env, now });
  const always = parseList(env.STRATEGIES_ALWAYS || env.STRATEGIES || "ema_cross");
  const strategyWeights = new Map();

  const bucketMap = {
    OPEN: parseList(env.STRATEGIES_OPEN),
    TREND: parseList(env.STRATEGIES_TREND),
    TREND_COMPRESSED: parseList(
      env.STRATEGIES_TREND_COMPRESSED || process.env.STRATEGIES_TREND_COMPRESSED,
    ),
    RANGE: parseList(env.STRATEGIES_RANGE),
    BREAKOUT_WATCH: parseList(
      env.STRATEGIES_BREAKOUT_WATCH ||
        process.env.STRATEGIES_BREAKOUT_WATCH ||
        env.STRATEGIES_TREND_COMPRESSED ||
        env.STRATEGIES_TREND,
    ),
  };

  addBucketStrategies(strategyWeights, always, 0.55, 0);
  for (const [bucket, weight] of Object.entries(det.regimeWeights || {})) {
    if (Number(weight ?? 0) < 0.14 && bucket !== det.primaryRegime && bucket !== det.secondaryRegime) {
      continue;
    }
    const fallbackBucket =
      bucket === "TREND_COMPRESSED" && !bucketMap.TREND_COMPRESSED.length
        ? bucketMap.TREND
        : bucketMap[bucket];
    addBucketStrategies(strategyWeights, fallbackBucket, Number(weight ?? 0), 0);
  }

  const sessionPhase = String(det?.meta?.sessionPhase || "");
  const phaseBucket = parseList(
    env[`STRATEGIES_${sessionPhase}`] || process.env[`STRATEGIES_${sessionPhase}`],
  );
  addBucketStrategies(strategyWeights, phaseBucket, 0.22, 0.08);

  const sortedStrategies = Array.from(strategyWeights.entries())
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([strategyId]) => strategyId);
  const strategyIds = uniq(sortedStrategies);
  const strategyWeightObj = Object.fromEntries(strategyWeights.entries());

  return {
    ...det,
    strategyIds,
    strategyWeights: strategyWeightObj,
    meta: {
      ...(det.meta || {}),
      strategyWeights: strategyWeightObj,
    },
  };
}

module.exports = { detectRegime, pickStrategies };
