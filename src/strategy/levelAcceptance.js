const { atr, clamp, getCurrentSessionCandles } = require("./utils");

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSide(value) {
  const side = String(value || "")
    .trim()
    .toUpperCase();
  return side === "SELL" ? "SELL" : "BUY";
}

function uniqLevels(levels = []) {
  const out = [];
  for (const level of levels) {
    const value = finite(level?.value);
    if (!Number.isFinite(value)) continue;
    const kind = String(level?.kind || "OTHER").toUpperCase();
    const exists = out.some(
      (row) => Math.abs(Number(row.value) - value) <= Math.max(0.02, value * 0.0001),
    );
    if (exists) continue;
    out.push({
      value,
      kind,
      label: String(level?.label || kind),
    });
  }
  return out;
}

function collectLevels({ candles, signal, context }) {
  const meta = signal?.meta || {};
  const regimeMeta = context?.regimeMeta || {};
  const sessionContext = {
    openingRange: regimeMeta?.openingRange || meta?.openingRange || null,
    previousSession: regimeMeta?.previousSession || meta?.previousSession || null,
    currentSession: regimeMeta?.currentSession || meta?.currentSession || null,
  };
  const sessionBars = getCurrentSessionCandles(candles || [], {
    endTs: context?.last?.ts || context?.last || null,
  });
  const sessionHigh = sessionBars.reduce((maxValue, candle) => {
    const value = finite(candle?.high);
    if (!Number.isFinite(value)) return maxValue;
    return Number.isFinite(maxValue) ? Math.max(maxValue, value) : value;
  }, null);
  const sessionLow = sessionBars.reduce((minValue, candle) => {
    const value = finite(candle?.low);
    if (!Number.isFinite(value)) return minValue;
    return Number.isFinite(minValue) ? Math.min(minValue, value) : value;
  }, null);

  return uniqLevels([
    { value: meta.triggerLevel, kind: "TRIGGER", label: "trigger" },
    { value: meta.rangeHigh, kind: "RESISTANCE", label: "range_high" },
    { value: meta.rangeLow, kind: "SUPPORT", label: "range_low" },
    { value: meta.orbHigh, kind: "RESISTANCE", label: "orb_high" },
    { value: meta.orbLow, kind: "SUPPORT", label: "orb_low" },
    { value: meta.anchorValue, kind: "ANCHOR", label: "anchor" },
    {
      value: sessionContext.openingRange?.high,
      kind: "RESISTANCE",
      label: "opening_range_high",
    },
    {
      value: sessionContext.openingRange?.low,
      kind: "SUPPORT",
      label: "opening_range_low",
    },
    {
      value: sessionContext.previousSession?.high,
      kind: "RESISTANCE",
      label: "previous_session_high",
    },
    {
      value: sessionContext.previousSession?.low,
      kind: "SUPPORT",
      label: "previous_session_low",
    },
    { value: sessionHigh, kind: "SESSION_HIGH", label: "session_high" },
    { value: sessionLow, kind: "SESSION_LOW", label: "session_low" },
  ]);
}

function nearestLevel(levels, referencePrice) {
  const px = finite(referencePrice);
  if (!Number.isFinite(px)) return null;
  let best = null;
  for (const level of levels || []) {
    const value = finite(level?.value);
    if (!Number.isFinite(value)) continue;
    const distance = Math.abs(px - value);
    if (!best || distance < best.distance) {
      best = { ...level, distance };
    }
  }
  return best;
}

function beyondClose(side, candle, levelValue) {
  const close = finite(candle?.close);
  if (!Number.isFinite(close)) return false;
  return side === "BUY" ? close > levelValue : close < levelValue;
}

function wickThrough(side, candle, levelValue) {
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  const close = finite(candle?.close);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return false;
  if (side === "BUY") return high > levelValue && close <= levelValue;
  return low < levelValue && close >= levelValue;
}

function attemptDetected(side, candle, levelValue) {
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  if (side === "BUY") return Number.isFinite(high) && high >= levelValue;
  return Number.isFinite(low) && low <= levelValue;
}

function rejectionEvent(side, candle, levelValue) {
  const close = finite(candle?.close);
  if (!Number.isFinite(close)) return false;
  if (!attemptDetected(side, candle, levelValue)) return false;
  return side === "BUY" ? close < levelValue : close > levelValue;
}

function retestTouched(side, candle, levelValue, tolerance) {
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  const close = finite(candle?.close);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return false;
  if (side === "BUY") {
    return low <= levelValue + tolerance && high >= levelValue - tolerance;
  }
  return high >= levelValue - tolerance && low <= levelValue + tolerance;
}

function evaluateLevelAcceptance({ candles = [], signal = null, context = {}, env = {} }) {
  const enabled = String(env.LEVEL_ACCEPTANCE_ENABLED ?? "true") === "true";
  const side = normalizeSide(signal?.side);
  const last = context?.last || candles[candles.length - 1] || null;
  const referenceClose = finite(last?.close);
  const atrPeriod = Math.max(5, Number(env.SELECTOR_ATR_PERIOD ?? 14));
  const atrValue =
    finite(context?.regimeMeta?.atr) ||
    finite(signal?.meta?.atr) ||
    finite(atr(candles, atrPeriod)) ||
    Math.max(0.01, Math.abs(Number(referenceClose || 0)) * 0.001);
  const levels = collectLevels({ candles, signal, context });
  const nearest = nearestLevel(levels, referenceClose);
  const explicitLevels = levels.filter((level) => {
    const kind = String(level?.kind || "").toUpperCase();
    return (
      kind === "TRIGGER" ||
      kind === "RESISTANCE" ||
      kind === "SUPPORT" ||
      kind === "ANCHOR"
    );
  });
  const explicitNearest = nearestLevel(explicitLevels, referenceClose);
  let selectedLevel = nearest;
  if (
    explicitNearest &&
    (!nearest ||
      (explicitNearest.distance <= Math.max(atrValue * 2.2, nearest.distance * 2.5) &&
        explicitNearest.distance <= atrValue * 4))
  ) {
    selectedLevel = explicitNearest;
  }
  const lookbackBars = Math.max(3, Number(env.LEVEL_ACCEPTANCE_LOOKBACK_BARS ?? 8));
  const recent = candles.slice(-lookbackBars);
  const minClosesBeyond = Math.max(1, Number(env.LEVEL_ACCEPTANCE_MIN_CLOSES_BEYOND ?? 2));
  const rejectionMinCount = Math.max(1, Number(env.LEVEL_REJECTION_MIN_COUNT ?? 2));
  const retestRequired =
    String(env.LEVEL_ACCEPTANCE_RETEST_REQUIRED ?? "true") === "true";

  if (!enabled || !selectedLevel) {
    return {
      nearestKeyLevel: selectedLevel?.value ?? null,
      keyLevelType: selectedLevel?.kind || null,
      distanceToLevelAbs: selectedLevel?.distance ?? null,
      distanceToLevelAtr: Number.isFinite(selectedLevel?.distance) && atrValue > 0
        ? Number((selectedLevel.distance / atrValue).toFixed(4))
        : null,
      breakoutAttemptDetected: false,
      breakoutAccepted: false,
      breakoutRejected: false,
      retestAccepted: false,
      repeatedRejectionDetected: false,
      rejectionSide: side === "BUY" ? "RESISTANCE" : "SUPPORT",
      rejectionCount: 0,
      acceptanceScore: enabled ? 50 : null,
      acceptanceEnabled: enabled,
    };
  }

  const maxDistanceAtr = Math.max(0.05, Number(env.LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR ?? 0.8));
  const nearEnough =
    selectedLevel.distance / Math.max(atrValue, 0.0001) <= maxDistanceAtr;
  const beyondCount = recent.filter((candle) => beyondClose(side, candle, selectedLevel.value)).length;
  let holdBeyondCount = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    if (!beyondClose(side, recent[index], selectedLevel.value)) break;
    holdBeyondCount += 1;
  }

  const breakoutAttemptDetected = recent.some((candle) =>
    attemptDetected(side, candle, selectedLevel.value),
  );
  const breakoutAcceptedRaw =
    nearEnough &&
    breakoutAttemptDetected &&
    beyondCount >= minClosesBeyond &&
    holdBeyondCount >= minClosesBeyond;
  const tolerance = Math.max(atrValue * 0.12, Math.abs(selectedLevel.value) * 0.0004);

  let firstBeyondIndex = -1;
  for (let index = 0; index < recent.length; index += 1) {
    if (beyondClose(side, recent[index], selectedLevel.value)) {
      firstBeyondIndex = index;
      break;
    }
  }
  let retestTouch = false;
  if (firstBeyondIndex >= 0) {
    for (let index = firstBeyondIndex + 1; index < recent.length; index += 1) {
      if (retestTouched(side, recent[index], selectedLevel.value, tolerance)) {
        retestTouch = true;
        break;
      }
    }
  }
  const retestAccepted =
    breakoutAcceptedRaw &&
    (!retestRequired || (retestTouch && beyondClose(side, last, selectedLevel.value)));
  const breakoutAccepted = breakoutAcceptedRaw && (!retestRequired || retestAccepted);

  const rejectionCount = recent.filter((candle) =>
    rejectionEvent(side, candle, selectedLevel.value),
  ).length;
  const repeatedRejectionDetected = rejectionCount >= rejectionMinCount;
  const breakoutRejected =
    nearEnough &&
    breakoutAttemptDetected &&
    (recent.some((candle) => wickThrough(side, candle, selectedLevel.value)) ||
      (!breakoutAccepted && (repeatedRejectionDetected || rejectionCount > 0)));

  let acceptanceScore = 52;
  acceptanceScore += Math.min(22, beyondCount * 7);
  acceptanceScore += Math.min(16, holdBeyondCount * 5);
  if (retestAccepted) acceptanceScore += 12;
  acceptanceScore -= Math.min(44, rejectionCount * 14);
  if (breakoutRejected) acceptanceScore -= 8;
  if (!nearEnough) acceptanceScore -= 10;
  acceptanceScore = clamp(acceptanceScore, 0, 100);

  return {
    nearestKeyLevel: selectedLevel.value,
    keyLevelType: selectedLevel.kind,
    distanceToLevelAbs: Number(selectedLevel.distance.toFixed(4)),
    distanceToLevelAtr: Number(
      (selectedLevel.distance / Math.max(atrValue, 0.0001)).toFixed(4),
    ),
    breakoutAttemptDetected,
    breakoutAccepted,
    breakoutRejected,
    retestAccepted,
    repeatedRejectionDetected,
    rejectionSide: side === "BUY" ? "RESISTANCE" : "SUPPORT",
    rejectionCount,
    acceptanceScore,
    acceptanceEnabled: enabled,
    acceptanceMeta: {
      lookbackBars,
      minClosesBeyond,
      retestRequired,
      nearEnough,
      maxDistanceAtr,
      atrValue,
    },
  };
}

module.exports = {
  evaluateLevelAcceptance,
};
