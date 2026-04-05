const {
  clamp,
  maxHigh,
  minLow,
  upperWick,
  lowerWick,
  candleRange,
  getCurrentSessionCandles,
  volumeConfirmation,
} = require("./utils");

function buildFakeoutCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  hi,
  lo,
  volume,
  patternQuality,
  anchorQuality,
  structureQuality,
  freshness,
  triggerType,
  returnInsideFamily,
  brokenLevel,
  reversionQuality,
}) {
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      triggerLevel: brokenLevel,
      brokenLevel,
      rangeHigh: hi,
      rangeLow: lo,
      returnInsideFamily,
      breakQuality: patternQuality,
      reversionQuality,
      anchorType: "SESSION_RANGE",
      triggerType,
      setupState,
      patternQuality,
      anchorQuality,
      structureQuality,
      volumeQuality: volume?.quality ?? 55,
      volumeRatio: volume?.ratio ?? null,
      freshness,
      sessionOnly: true,
    },
  };
}

function evaluateFakeoutSetup({
  candles,
  lookback = 20,
  volLookback = 20,
  volMult = 1.0,
  wickFrac = 0.6,
  minRangeFrac = 0.004,
}) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < 5) return null;

  const cur = sessionBars[sessionBars.length - 1];
  const prev = sessionBars[sessionBars.length - 2];
  const structureBars = sessionBars.slice(0, -2);
  const lookbackUsed = Math.min(Number(lookback ?? 20), structureBars.length);
  if (lookbackUsed < 3) return null;

  const base = structureBars.slice(-lookbackUsed);
  const hi = maxHigh(base);
  const lo = minLow(base);
  const prevClose = Number(prev.close);
  const curClose = Number(cur.close);
  const curOpen = Number(cur.open);
  const range = candleRange(cur);
  const rangeFrac = curClose !== 0 ? range / Math.max(Math.abs(curClose), 1) : 0;
  if (range <= 0 || rangeFrac < minRangeFrac) return null;

  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });

  const upsideBreak = prevClose > hi;
  const downsideBreak = prevClose < lo;
  const upperWickFrac = upperWick(cur) / range;
  const lowerWickFrac = lowerWick(cur) / range;
  const structureBase = clamp(
    58 +
      (lookbackUsed / Math.max(1, lookback)) * 18 +
      Math.min(10, rangeFrac * 1500),
    0,
    100,
  );

  if (upsideBreak && curClose < hi && curClose < curOpen && upperWickFrac >= wickFrac && volume.ok) {
    const patternQuality = clamp(62 + upperWickFrac * 30, 0, 100);
    const anchorQuality = clamp(55 + (lookbackUsed / Math.max(1, lookback)) * 20, 0, 100);
    const structureQuality = clamp(structureBase + upperWickFrac * 12, 0, 100);
    const confidence = Math.min(
      92,
      62 + upperWickFrac * 30 + Math.max(0, ((volume.ratio ?? 0) - volMult) * 10),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildFakeoutCandidate({
        side: "SELL",
        reason: `Fakeout SELL: broke above ${hi.toFixed(2)} then closed back below`,
        confidence,
        setupState: "triggered",
        actionable: true,
        hi,
        lo,
        volume,
        patternQuality,
        anchorQuality,
        structureQuality,
        freshness: 84,
        triggerType: "FAKEOUT_REJECTION",
        returnInsideFamily: "ABOVE_THEN_INSIDE",
        brokenLevel: hi,
        reversionQuality: clamp(60 + upperWickFrac * 26, 0, 100),
      }),
    };
  }

  if (downsideBreak && curClose > lo && curClose > curOpen && lowerWickFrac >= wickFrac && volume.ok) {
    const patternQuality = clamp(62 + lowerWickFrac * 30, 0, 100);
    const anchorQuality = clamp(55 + (lookbackUsed / Math.max(1, lookback)) * 20, 0, 100);
    const structureQuality = clamp(structureBase + lowerWickFrac * 12, 0, 100);
    const confidence = Math.min(
      92,
      62 + lowerWickFrac * 30 + Math.max(0, ((volume.ratio ?? 0) - volMult) * 10),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildFakeoutCandidate({
        side: "BUY",
        reason: `Fakeout BUY: broke below ${lo.toFixed(2)} then closed back above`,
        confidence,
        setupState: "triggered",
        actionable: true,
        hi,
        lo,
        volume,
        patternQuality,
        anchorQuality,
        structureQuality,
        freshness: 84,
        triggerType: "FAKEOUT_RECLAIM",
        returnInsideFamily: "BELOW_THEN_INSIDE",
        brokenLevel: lo,
        reversionQuality: clamp(60 + lowerWickFrac * 26, 0, 100),
      }),
    };
  }

  if (upsideBreak && curClose >= hi && upperWickFrac >= wickFrac * 0.8) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: buildFakeoutCandidate({
        side: "SELL",
        reason: "Fakeout watch after upside break awaiting return inside",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        hi,
        lo,
        volume,
        patternQuality: clamp(58 + upperWickFrac * 24, 0, 100),
        anchorQuality: clamp(54 + (lookbackUsed / Math.max(1, lookback)) * 18, 0, 100),
        structureQuality: structureBase,
        freshness: 76,
        triggerType: "FAKEOUT_REJECTION_WATCH",
        returnInsideFamily: "ABOVE_BREAK_ACTIVE",
        brokenLevel: hi,
        reversionQuality: clamp(54 + upperWickFrac * 18, 0, 100),
      }),
    };
  }

  if (downsideBreak && curClose <= lo && lowerWickFrac >= wickFrac * 0.8) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: buildFakeoutCandidate({
        side: "BUY",
        reason: "Fakeout watch after downside break awaiting return inside",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        hi,
        lo,
        volume,
        patternQuality: clamp(58 + lowerWickFrac * 24, 0, 100),
        anchorQuality: clamp(54 + (lookbackUsed / Math.max(1, lookback)) * 18, 0, 100),
        structureQuality: structureBase,
        freshness: 76,
        triggerType: "FAKEOUT_RECLAIM_WATCH",
        returnInsideFamily: "BELOW_BREAK_ACTIVE",
        brokenLevel: lo,
        reversionQuality: clamp(54 + lowerWickFrac * 18, 0, 100),
      }),
    };
  }

  if (upsideBreak || downsideBreak) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: buildFakeoutCandidate({
        side: upsideBreak ? "SELL" : "BUY",
        reason: "Fakeout move lost quality before return-inside confirmation",
        confidence: 56,
        setupState: "confirmed",
        actionable: false,
        hi,
        lo,
        volume,
        patternQuality: 52,
        anchorQuality: clamp(54 + (lookbackUsed / Math.max(1, lookback)) * 14, 0, 100),
        structureQuality: clamp(structureBase - 6, 0, 100),
        freshness: 52,
        triggerType: upsideBreak ? "FAKEOUT_REJECTION_STALE" : "FAKEOUT_RECLAIM_STALE",
        returnInsideFamily: upsideBreak ? "ABOVE_BREAK_STALE" : "BELOW_BREAK_STALE",
        brokenLevel: upsideBreak ? hi : lo,
        reversionQuality: 48,
      }),
    };
  }

  return null;
}

function fakeoutStrategy(args) {
  const setup = evaluateFakeoutSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  fakeoutStrategy,
  evaluateFakeoutSetup,
};
