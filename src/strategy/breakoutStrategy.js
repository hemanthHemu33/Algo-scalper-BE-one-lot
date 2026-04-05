const {
  clamp,
  maxHigh,
  minLow,
  getCurrentSessionCandles,
  volumeConfirmation,
} = require("./utils");

function breakoutCandidate({
  side,
  reason,
  confidence,
  hi,
  lo,
  lookback,
  lookbackUsed,
  patternQuality,
  anchorQuality,
  structureQuality,
  volume,
  freshness,
  setupState,
  triggerType,
  actionable,
  retestState,
  boundaryQuality,
  expansionQuality,
  failedBreakRisk,
}) {
  return {
    side,
    reason,
    confidence,
    actionable,
    meta: {
      triggerLevel: side === "BUY" ? hi : lo,
      lookback,
      lookbackUsed,
      rangeHigh: hi,
      rangeLow: lo,
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
      boundaryQuality,
      expansionQuality,
      failedBreakRisk,
      retestState,
    },
  };
}

function evaluateBreakoutSetup({
  candles,
  lookback = 20,
  volMult = 1.2,
  volLookback = 20,
}) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < 4) return null;

  const cur = sessionBars[sessionBars.length - 1];
  const structureBars = sessionBars.slice(0, -1);
  const lookbackUsed = Math.min(Number(lookback ?? 20), structureBars.length);
  if (lookbackUsed < 3) return null;
  const prevRange = structureBars.slice(-lookbackUsed);

  const hi = maxHigh(prevRange);
  const lo = minLow(prevRange);
  const curClose = Number(cur.close);
  const prevClose = Number(structureBars[structureBars.length - 1]?.close);
  const rangeFrac = (hi - lo) / Math.max(1, Math.abs(curClose));
  const boundaryQuality = clamp(
    56 +
      (lookbackUsed / Math.max(1, lookback)) * 18 +
      Math.min(12, rangeFrac * 1800),
    0,
    100,
  );

  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });

  const buyBreakFrac = (curClose - hi) / Math.max(1, Math.abs(curClose));
  const sellBreakFrac = (lo - curClose) / Math.max(1, Math.abs(curClose));
  const nearHigh = (hi - curClose) / Math.max(1, Math.abs(curClose));
  const nearLow = (curClose - lo) / Math.max(1, Math.abs(curClose));

  if (curClose > hi && prevClose <= hi && volume.ok) {
    const patternQuality = clamp(
      60 + buyBreakFrac * 3000 + (lookbackUsed / Math.max(1, lookback)) * 12,
      0,
      100,
    );
    const anchorQuality = clamp(55 + (lookbackUsed / Math.max(1, lookback)) * 25, 0, 100);
    const structureQuality = clamp(
      58 +
        (lookbackUsed / Math.max(1, lookback)) * 18 +
        Math.min(14, rangeFrac * 2200),
      0,
      100,
    );
    const expansionQuality = clamp(60 + buyBreakFrac * 3200, 0, 100);
    const failedBreakRisk = clamp(52 - (volume.ratio ?? 0) * 8, 0, 100);
    const confidence = Math.min(92, 55 + Math.round((volume.ratio ?? 0) * 20));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: breakoutCandidate({
        side: "BUY",
        reason: `Breakout above ${lookbackUsed} session-bar high`,
        confidence,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality,
        anchorQuality,
        structureQuality,
        volume,
        freshness: 88,
        setupState: "triggered",
        triggerType: "SESSION_BREAKOUT",
        actionable: true,
        retestState: "FIRST_BREAK",
        boundaryQuality,
        expansionQuality,
        failedBreakRisk,
      }),
    };
  }

  if (curClose < lo && prevClose >= lo && volume.ok) {
    const patternQuality = clamp(
      60 + sellBreakFrac * 3000 + (lookbackUsed / Math.max(1, lookback)) * 12,
      0,
      100,
    );
    const anchorQuality = clamp(55 + (lookbackUsed / Math.max(1, lookback)) * 25, 0, 100);
    const structureQuality = clamp(
      58 +
        (lookbackUsed / Math.max(1, lookback)) * 18 +
        Math.min(14, rangeFrac * 2200),
      0,
      100,
    );
    const expansionQuality = clamp(60 + sellBreakFrac * 3200, 0, 100);
    const failedBreakRisk = clamp(52 - (volume.ratio ?? 0) * 8, 0, 100);
    const confidence = Math.min(92, 55 + Math.round((volume.ratio ?? 0) * 20));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: breakoutCandidate({
        side: "SELL",
        reason: `Breakdown below ${lookbackUsed} session-bar low`,
        confidence,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality,
        anchorQuality,
        structureQuality,
        volume,
        freshness: 88,
        setupState: "triggered",
        triggerType: "SESSION_BREAKDOWN",
        actionable: true,
        retestState: "FIRST_BREAK",
        boundaryQuality,
        expansionQuality,
        failedBreakRisk,
      }),
    };
  }

  if (curClose > hi && prevClose > hi) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: breakoutCandidate({
        side: "BUY",
        reason: "Breakout already extended above session structure",
        confidence: 66,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality: 58,
        anchorQuality: 60,
        structureQuality: 62,
        volume,
        freshness: 54,
        setupState: "confirmed",
        triggerType: "SESSION_BREAKOUT_HOLD",
        actionable: false,
        retestState: "HOLD_ABOVE",
        boundaryQuality,
        expansionQuality: clamp(55 + buyBreakFrac * 2500, 0, 100),
        failedBreakRisk: 40,
      }),
    };
  }

  if (curClose < lo && prevClose < lo) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: breakoutCandidate({
        side: "SELL",
        reason: "Breakdown already extended below session structure",
        confidence: 66,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality: 58,
        anchorQuality: 60,
        structureQuality: 62,
        volume,
        freshness: 54,
        setupState: "confirmed",
        triggerType: "SESSION_BREAKDOWN_HOLD",
        actionable: false,
        retestState: "HOLD_BELOW",
        boundaryQuality,
        expansionQuality: clamp(55 + sellBreakFrac * 2500, 0, 100),
        failedBreakRisk: 40,
      }),
    };
  }

  if (nearHigh >= 0 && nearHigh <= 0.0025) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: breakoutCandidate({
        side: "BUY",
        reason: "Breakout watch near session high",
        confidence: 62,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality: 56,
        anchorQuality: 58,
        structureQuality: clamp(boundaryQuality + 2, 0, 100),
        volume,
        freshness: 74,
        setupState: "armed",
        triggerType: "SESSION_BREAKOUT_WATCH",
        actionable: false,
        retestState: "ARMED_AT_BOUNDARY",
        boundaryQuality,
        expansionQuality: 52,
        failedBreakRisk: 46,
      }),
    };
  }

  if (nearLow >= 0 && nearLow <= 0.0025) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: breakoutCandidate({
        side: "SELL",
        reason: "Breakdown watch near session low",
        confidence: 62,
        hi,
        lo,
        lookback,
        lookbackUsed,
        patternQuality: 56,
        anchorQuality: 58,
        structureQuality: clamp(boundaryQuality + 2, 0, 100),
        volume,
        freshness: 74,
        setupState: "armed",
        triggerType: "SESSION_BREAKDOWN_WATCH",
        actionable: false,
        retestState: "ARMED_AT_BOUNDARY",
        boundaryQuality,
        expansionQuality: 52,
        failedBreakRisk: 46,
      }),
    };
  }

  return null;
}

function breakoutStrategy(args) {
  const setup = evaluateBreakoutSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  breakoutStrategy,
  evaluateBreakoutSetup,
};
