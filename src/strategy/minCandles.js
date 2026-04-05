function parseMinByInterval(value) {
  const map = new Map();
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [intervalRaw, minRaw] = entry.split(/[:=]/).map((s) => s.trim());
      const interval = Number(intervalRaw);
      const min = Number(minRaw);
      if (Number.isFinite(interval) && interval > 0 && Number.isFinite(min)) {
        map.set(interval, min);
      }
    });
  return map;
}

function parseStrategyIds(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveRawEnvValue(name, fallback) {
  if (
    Object.prototype.hasOwnProperty.call(process.env, name) &&
    String(process.env[name] ?? "").trim() !== ""
  ) {
    return process.env[name];
  }
  return fallback;
}

function getIntervalMinCandles(env, intervalMin) {
  const interval = Number(intervalMin);
  if (!Number.isFinite(interval) || interval <= 0) return 0;

  const overrides = parseMinByInterval(
    resolveRawEnvValue("MIN_CANDLES_BY_INTERVAL", env.MIN_CANDLES_BY_INTERVAL),
  );
  if (overrides.has(interval)) return Number(overrides.get(interval));
  return 0;
}

function resolveStrategyBaseMinCandles(strategyId, intervalMin, env) {
  const interval = Math.max(1, Number(intervalMin ?? 1));
  const fast = Number(env.EMA_FAST ?? 9);
  const slow = Number(env.EMA_SLOW ?? 21);
  const boundedQualityLookback = (value, fallback = 6) => {
    const raw = Number(value ?? fallback);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.max(3, Math.min(raw, 8));
  };

  switch (String(strategyId || "").trim()) {
    case "orb": {
      const orbMinutes = Number(env.ORB_MINUTES ?? 15);
      const needBars = Math.max(1, Math.ceil(orbMinutes / interval));
      // ORB is intentionally the only early-session strategy with a truly small floor:
      // opening range bars + one trigger bar.
      return needBars + 1;
    }
    case "ema_cross":
      return Math.max(fast, slow) + 2;
    case "ema_pullback": {
      const pullbackBars = Number(env.PULLBACK_BARS ?? 5);
      const indicatorWarmup = Math.max(fast, slow) + 2;
      const structuralContext = pullbackBars + 2;
      const scoringContext = boundedQualityLookback(
        env.PULLBACK_VOL_LOOKBACK ?? 20,
      ) + 1;
      return Math.max(indicatorWarmup, structuralContext, scoringContext);
    }
    case "breakout": {
      const lookback = Number(env.BREAKOUT_LOOKBACK ?? 20);
      const structureContext = Math.max(lookback, 4) + 1;
      const scoringContext = boundedQualityLookback(20) + 1;
      return Math.max(structureContext, scoringContext);
    }
    case "vwap_reclaim": {
      const indicatorWarmup = Math.max(fast, slow) + 1;
      const structuralContext = 3;
      const scoringContext = boundedQualityLookback(20) + 1;
      return Math.max(indicatorWarmup, structuralContext, scoringContext);
    }
    case "bb_squeeze": {
      const period = Number(env.BB_PERIOD ?? 20);
      const indicatorWarmup = period + 2;
      const scoringContext = boundedQualityLookback(
        env.SQUEEZE_VOL_LOOKBACK ?? 20,
      ) + 1;
      return Math.max(indicatorWarmup, scoringContext);
    }
    case "volume_spike": {
      const scoringContext = boundedQualityLookback(
        env.VOL_SPIKE_LOOKBACK ?? 20,
      ) + 1;
      return Math.max(4, scoringContext);
    }
    case "fakeout": {
      const lookback = Number(env.FAKEOUT_LOOKBACK ?? 20);
      const structureContext = Math.max(lookback, 4) + 1;
      const scoringContext = boundedQualityLookback(
        env.FAKEOUT_VOL_LOOKBACK ?? 20,
      ) + 1;
      return Math.max(structureContext, scoringContext);
    }
    case "rsi_fade": {
      const period = Number(env.RSI_PERIOD ?? 14);
      const indicatorWarmup = period + 2;
      const structureContext = 4;
      return Math.max(indicatorWarmup, structureContext);
    }
    case "wick_reversal": {
      const lookback = Number(env.WICK_LOOKBACK ?? 20);
      return Math.max(lookback, 5) + 1;
    }
    default:
      return 2;
  }
}

function resolveStrategyMinCandles(strategyId, intervalMin, env) {
  const base = resolveStrategyBaseMinCandles(strategyId, intervalMin, env);
  return Math.max(base, getIntervalMinCandles(env, intervalMin), 2);
}

function getMaxStrategyMinCandles(env, intervalMin, strategyIds) {
  const ids = Array.isArray(strategyIds) && strategyIds.length
    ? strategyIds
    : parseStrategyIds(resolveRawEnvValue("STRATEGIES", env.STRATEGIES));
  if (!ids.length) return Math.max(getIntervalMinCandles(env, intervalMin), 2);

  return ids.reduce((maxMin, strategyId) => {
    return Math.max(
      maxMin,
      resolveStrategyMinCandles(strategyId, intervalMin, env),
    );
  }, 2);
}

function getMinCandlesForSignal(env, intervalMin, strategyIds) {
  return getMaxStrategyMinCandles(env, intervalMin, strategyIds);
}

function getMinCandlesForRegime(env) {
  const explicit = Number(
    resolveRawEnvValue("MIN_CANDLES_FOR_REGIME", env.MIN_CANDLES_FOR_REGIME),
  );
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const slow = Number(env.SELECTOR_SLOW_EMA ?? 21);
  const lookback = Number(env.SELECTOR_RANGE_LOOKBACK ?? 30);
  const atrPeriod = Number(env.SELECTOR_ATR_PERIOD ?? 14);
  return Math.max(lookback, slow + 2, atrPeriod + 2, 8);
}

module.exports = {
  getIntervalMinCandles,
  resolveStrategyMinCandles,
  getMaxStrategyMinCandles,
  getMinCandlesForSignal,
  getMinCandlesForRegime,
};
