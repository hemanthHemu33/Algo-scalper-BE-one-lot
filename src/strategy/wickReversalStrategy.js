const {
  clamp,
  candleRange,
  upperWick,
  lowerWick,
  maxHigh,
  minLow,
  getCurrentSessionCandles,
} = require("./utils");

function buildWickCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  triggerLevel,
  reversalZone,
  patternQuality,
  anchorQuality,
  structureQuality,
  freshness,
  triggerType,
}) {
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      triggerLevel,
      wickExtreme: triggerLevel,
      reversalZone,
      anchorType: "SESSION_SWING",
      triggerType,
      setupState,
      patternQuality,
      anchorQuality,
      structureQuality,
      volumeQuality: 55,
      freshness,
      sessionOnly: true,
    },
  };
}

function evaluateWickReversalSetup({ candles, lookback = 20, minWickFrac = 0.6 }) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < 5) return null;

  const cur = sessionBars[sessionBars.length - 1];
  const base = sessionBars.slice(0, -1);
  const lookbackUsed = Math.min(Number(lookback ?? 20), base.length);
  if (lookbackUsed < 3) return null;

  const trendWindow = base.slice(-lookbackUsed);
  const first = Number(trendWindow[0].close);
  const last = Number(trendWindow[trendWindow.length - 1].close);
  const upTrend = last > first;
  const downTrend = last < first;
  const trendMoveFrac = Math.abs(last - first) / Math.max(1, Math.abs(last));

  const r = candleRange(cur);
  if (r <= 0) return null;
  const o = Number(cur.open);
  const c = Number(cur.close);
  const h = Number(cur.high);
  const l = Number(cur.low);
  const uw = upperWick(cur) / r;
  const lw = lowerWick(cur) / r;

  const sessionHigh = maxHigh(base);
  const sessionLow = minLow(base);
  const highExtensionFrac = (h - sessionHigh) / Math.max(1, Math.abs(h));
  const lowExtensionFrac = (sessionLow - l) / Math.max(1, Math.abs(l));
  const atSessionHigh =
    h >= sessionHigh &&
    clamp(highExtensionFrac, 0, 1) <= 0.02;
  const atSessionLow =
    l <= sessionLow &&
    clamp(lowExtensionFrac, 0, 1) <= 0.02;
  const anchorQualityBase = clamp(
    56 +
      (lookbackUsed / Math.max(1, lookback)) * 18 +
      Math.min(16, trendMoveFrac * 1700),
    0,
    100,
  );

  if (upTrend && atSessionHigh && uw >= minWickFrac && c < o) {
    const patternQuality = clamp(60 + uw * 35, 0, 100);
    const structureQuality = clamp(anchorQualityBase + uw * 14, 0, 100);
    const confidence = Math.min(90, 60 + uw * 35);
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildWickCandidate({
        side: "SELL",
        reason: `Exhaustion wick SELL (upper wick ${(uw * 100).toFixed(0)}%)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        triggerLevel: h,
        reversalZone: "SESSION_HIGH_EXHAUSTION",
        patternQuality,
        anchorQuality: anchorQualityBase,
        structureQuality,
        freshness: 82,
        triggerType: "WICK_REVERSAL",
      }),
    };
  }

  if (downTrend && atSessionLow && lw >= minWickFrac && c > o) {
    const patternQuality = clamp(60 + lw * 35, 0, 100);
    const structureQuality = clamp(anchorQualityBase + lw * 14, 0, 100);
    const confidence = Math.min(90, 60 + lw * 35);
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildWickCandidate({
        side: "BUY",
        reason: `Exhaustion wick BUY (lower wick ${(lw * 100).toFixed(0)}%)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        triggerLevel: l,
        reversalZone: "SESSION_LOW_EXHAUSTION",
        patternQuality,
        anchorQuality: anchorQualityBase,
        structureQuality,
        freshness: 82,
        triggerType: "WICK_REVERSAL",
      }),
    };
  }

  if (upTrend && atSessionHigh && uw >= minWickFrac * 0.85) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: buildWickCandidate({
        side: "SELL",
        reason: "Exhaustion wick watch near session high",
        confidence: 62,
        setupState: "armed",
        actionable: false,
        triggerLevel: h,
        reversalZone: "SESSION_HIGH_EXHAUSTION",
        patternQuality: clamp(58 + uw * 28, 0, 100),
        anchorQuality: anchorQualityBase,
        structureQuality: clamp(anchorQualityBase + 6, 0, 100),
        freshness: 74,
        triggerType: "WICK_REVERSAL_WATCH",
      }),
    };
  }

  if (downTrend && atSessionLow && lw >= minWickFrac * 0.85) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: buildWickCandidate({
        side: "BUY",
        reason: "Exhaustion wick watch near session low",
        confidence: 62,
        setupState: "armed",
        actionable: false,
        triggerLevel: l,
        reversalZone: "SESSION_LOW_EXHAUSTION",
        patternQuality: clamp(58 + lw * 28, 0, 100),
        anchorQuality: anchorQualityBase,
        structureQuality: clamp(anchorQualityBase + 6, 0, 100),
        freshness: 74,
        triggerType: "WICK_REVERSAL_WATCH",
      }),
    };
  }

  return null;
}

function wickReversalStrategy(args) {
  const setup = evaluateWickReversalSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  wickReversalStrategy,
  evaluateWickReversalSetup,
};
