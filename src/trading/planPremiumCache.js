function candleTsMs(candle) {
  const time = candle?.ts instanceof Date
    ? candle.ts.getTime()
    : Date.parse(candle?.ts || "");
  return Number.isFinite(time) ? time : null;
}

function mergeCandlesByTs(...sets) {
  const byTs = new Map();
  for (const candles of sets) {
    for (const candle of candles || []) {
      const ts = candleTsMs(candle);
      if (!Number.isFinite(ts)) continue;
      byTs.set(ts, candle);
    }
  }
  return Array.from(byTs.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function minPremiumPlanCandles(config = {}) {
  const volLookback = Math.max(5, Number(config.OPT_PLAN_VOL_LOOKBACK ?? config.OPT_EXIT_VOL_LOOKBACK ?? 20));
  const atrPeriod = Math.max(5, Number(config.OPT_PLAN_PREM_ATR_PERIOD ?? 14));
  return Math.max(volLookback + 2, atrPeriod + 2, 24);
}

function premiumReadinessStaleAfterMs(intervalMin) {
  const effectiveIntervalMin = Math.max(1, Number(intervalMin ?? 1) || 0);
  return Math.max(2 * 60_000, effectiveIntervalMin * 3 * 60_000);
}

function normalizeReferenceTs(value) {
  const ts =
    value instanceof Date
      ? value.getTime()
      : Date.parse(value || "");
  return Number.isFinite(ts) ? ts : null;
}

function buildPremiumReadiness({
  candles,
  minRequired,
  intervalMin,
  referenceTs,
}) {
  const candleCount = Array.isArray(candles) ? candles.length : 0;
  const lastCandle = candleCount > 0 ? candles[candleCount - 1] : null;
  const lastCandleTs = candleTsMs(lastCandle);
  const referenceMs = normalizeReferenceTs(referenceTs);
  const staleAfterMs = premiumReadinessStaleAfterMs(intervalMin);
  const staleByMs =
    Number.isFinite(referenceMs) && Number.isFinite(lastCandleTs)
      ? Math.max(0, referenceMs - lastCandleTs)
      : null;
  const stale = Number.isFinite(staleByMs) && staleByMs > staleAfterMs;

  let readinessState = "ready";
  if (candleCount < 1) readinessState = "unavailable";
  else if (stale) readinessState = "stale";
  else if (candleCount < minRequired) readinessState = "partial";

  const degradeReasons = [];
  if (readinessState === "partial") {
    degradeReasons.push("INSUFFICIENT_PREMIUM_CANDLES");
  } else if (readinessState === "unavailable") {
    degradeReasons.push("PREMIUM_CANDLES_UNAVAILABLE");
  } else if (readinessState === "stale") {
    degradeReasons.push("PREMIUM_CANDLES_STALE");
  }

  return {
    candleCount,
    lastCandleTs:
      Number.isFinite(lastCandleTs) ? new Date(lastCandleTs).toISOString() : null,
    readinessState,
    stale,
    staleByMs,
    staleAfterMs,
    degraded: readinessState !== "ready",
    degradedBy: degradeReasons,
  };
}

async function resolvePlanPremiumCandles({
  runtimeGetCandles,
  dbGetRecentCandles,
  token,
  intervalMin,
  limit,
  env,
  referenceTs = null,
}) {
  const desiredLimit = Math.max(1, Number(limit ?? 0) || 0);
  const minRequired = minPremiumPlanCandles(env);

  const runtimeCandles =
    typeof runtimeGetCandles === "function"
      ? runtimeGetCandles(token, intervalMin, desiredLimit || undefined)
      : [];

  const runtimeCount = Array.isArray(runtimeCandles) ? runtimeCandles.length : 0;
  if (runtimeCount >= minRequired) {
    const candles = runtimeCandles.slice(-(desiredLimit || runtimeCount));
    const readiness = buildPremiumReadiness({
      candles,
      minRequired,
      intervalMin,
      referenceTs,
    });
    return {
      candles,
      source: "runtime_cache",
      warmed: true,
      minRequired,
      ...readiness,
    };
  }

  const dbCandles =
    typeof dbGetRecentCandles === "function"
      ? await dbGetRecentCandles(token, intervalMin, desiredLimit || minRequired)
      : [];
  const dbCount = Array.isArray(dbCandles) ? dbCandles.length : 0;

  if (runtimeCount > 0 && dbCount > 0) {
    const merged = mergeCandlesByTs(dbCandles, runtimeCandles);
    const candles = merged.slice(-(desiredLimit || merged.length));
    const readiness = buildPremiumReadiness({
      candles,
      minRequired,
      intervalMin,
      referenceTs,
    });
    return {
      candles,
      source: "runtime_cache+db",
      warmed: merged.length >= minRequired,
      minRequired,
      ...readiness,
    };
  }

  if (dbCount > 0) {
    const candles = dbCandles.slice(-(desiredLimit || dbCount));
    const readiness = buildPremiumReadiness({
      candles,
      minRequired,
      intervalMin,
      referenceTs,
    });
    return {
      candles,
      source: "db",
      warmed: dbCount >= minRequired,
      minRequired,
      ...readiness,
    };
  }

  const candles =
    runtimeCount > 0 ? runtimeCandles.slice(-(desiredLimit || runtimeCount)) : [];
  const readiness = buildPremiumReadiness({
    candles,
    minRequired,
    intervalMin,
    referenceTs,
  });
  return {
    candles,
    source: runtimeCount > 0 ? "runtime_cache_partial" : "none",
    warmed: false,
    minRequired,
    ...readiness,
  };
}

module.exports = {
  buildPremiumReadiness,
  minPremiumPlanCandles,
  premiumReadinessStaleAfterMs,
  resolvePlanPremiumCandles,
};
