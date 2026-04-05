const { emaSeries } = require("./ema");
const {
  clamp,
  getCurrentSessionCandles,
  volumeConfirmation,
} = require("./utils");

function buildEmaPullbackCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  fast,
  slow,
  pullbackWindow,
  curFast,
  curSlow,
  volume,
  freshness,
  pullbackQuality,
  reclaimQuality,
  trendStrength,
  triggerType,
}) {
  return {
    side,
    reason,
    confidence,
    actionable,
    meta: {
      anchor: `EMA${fast}`,
      anchorValue: curFast,
      fast,
      slow,
      pullbackBars: pullbackWindow,
      pullbackAnchor: curFast,
      trendAnchor: curSlow,
      anchorType: "EMA_FAST",
      triggerType,
      setupState,
      patternQuality: reclaimQuality,
      anchorQuality: clamp(58 + reclaimQuality * 0.24, 0, 100),
      structureQuality: clamp(56 + pullbackQuality * 0.28 + trendStrength * 0.22, 0, 100),
      volumeQuality: volume?.available ? volume.quality : 55,
      volumeRatio: volume?.ratio ?? null,
      freshness,
      trendStrength,
      pullbackQuality,
      reclaimQuality,
      sessionOnly: true,
    },
  };
}

function evaluateEmaPullbackSetup({
  candles,
  fast = 9,
  slow = 21,
  pullbackBars = 5,
  volLookback = 20,
  volMult = 1.1,
}) {
  const pullbackWindow = Math.max(1, Number(pullbackBars ?? 5));
  const minCandles = Math.max(fast, slow, pullbackWindow + 1) + 2;
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < minCandles) return null;

  const closes = sessionBars.map((candle) => Number(candle.close));
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const n = closes.length;
  const cur = sessionBars[n - 1];
  const prev = sessionBars[n - 2];
  const curClose = closes[n - 1];
  const prevClose = closes[n - 2];
  const curFast = emaFast[n - 1];
  const prevFast = emaFast[n - 2];
  const curSlow = emaSlow[n - 1];
  const curLow = Number(cur.low);
  const curHigh = Number(cur.high);

  const recent = sessionBars.slice(-(pullbackWindow + 1), -1);
  const recentFast = emaFast.slice(-(pullbackWindow + 1), -1);
  const recentSlow = emaSlow.slice(-(pullbackWindow + 1), -1);
  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: false,
    minBars: 1,
  });
  const volOk = volume.available ? volume.ok : true;
  const trendStrength = clamp(
    Math.abs(curFast - curSlow) / Math.max(1, Math.abs(curClose)) * 2600 + 56,
    0,
    100,
  );

  const hadPullbackUp = recent.some((candle, index) => Number(candle?.close) <= recentFast[index]);
  const hadPullbackDown = recent.some((candle, index) => Number(candle?.close) >= recentFast[index]);
  const pullbackDepthUp = recent.reduce((best, candle, index) => {
    const depth = (recentFast[index] - Number(candle?.close)) / Math.max(1, Math.abs(curClose));
    return Math.max(best, depth);
  }, 0);
  const pullbackDepthDown = recent.reduce((best, candle, index) => {
    const depth = (Number(candle?.close) - recentFast[index]) / Math.max(1, Math.abs(curClose));
    return Math.max(best, depth);
  }, 0);

  const trendUp = curFast > curSlow;
  const trendDown = curFast < curSlow;
  const aboveSlow = curClose > curSlow;
  const belowSlow = curClose < curSlow;
  const reclaimUp =
    curClose > curFast &&
    aboveSlow &&
    Number.isFinite(curLow) &&
    curLow <= curFast &&
    prevClose <= Math.max(prevFast, curFast);
  const reclaimDown =
    curClose < curFast &&
    belowSlow &&
    Number.isFinite(curHigh) &&
    curHigh >= curFast &&
    prevClose >= Math.min(prevFast, curFast);

  if (trendUp && hadPullbackUp && reclaimUp && volOk) {
    const pullbackQuality = clamp(60 + pullbackDepthUp * 3200 + (hadPullbackUp ? 10 : 0), 0, 100);
    const reclaimQuality = clamp(
      62 + Math.max(0, (curClose - curFast) / Math.max(1, Math.abs(curClose))) * 3200,
      0,
      100,
    );
    const confidence = Math.min(
      90,
      56 +
        Math.round(Math.max(0, (curClose - curFast) / Math.max(1, Math.abs(curClose))) * 450) +
        Math.round(volume.available ? (volume.ratio ?? 0) * 8 : 6),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildEmaPullbackCandidate({
        side: "BUY",
        reason: `EMA pullback reclaim (EMA${fast} reclaimed after ${pullbackWindow}-bar pullback)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: 88,
        pullbackQuality,
        reclaimQuality,
        trendStrength,
        triggerType: "EMA_RECLAIM",
      }),
    };
  }

  if (trendDown && hadPullbackDown && reclaimDown && volOk) {
    const pullbackQuality = clamp(60 + pullbackDepthDown * 3200 + (hadPullbackDown ? 10 : 0), 0, 100);
    const reclaimQuality = clamp(
      62 + Math.max(0, (curFast - curClose) / Math.max(1, Math.abs(curClose))) * 3200,
      0,
      100,
    );
    const confidence = Math.min(
      90,
      56 +
        Math.round(Math.max(0, (curFast - curClose) / Math.max(1, Math.abs(curClose))) * 450) +
        Math.round(volume.available ? (volume.ratio ?? 0) * 8 : 6),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: buildEmaPullbackCandidate({
        side: "SELL",
        reason: `EMA pullback reject (EMA${fast} rejected after ${pullbackWindow}-bar pullback)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: 88,
        pullbackQuality,
        reclaimQuality,
        trendStrength,
        triggerType: "EMA_REJECT",
      }),
    };
  }

  if (trendUp && hadPullbackUp && aboveSlow) {
    const reclaimDistance = Math.abs(curClose - curFast) / Math.max(1, Math.abs(curClose));
    return {
      setupState: reclaimUp ? "confirmed" : "armed",
      actionable: false,
      candidate: buildEmaPullbackCandidate({
        side: "BUY",
        reason: reclaimUp
          ? "EMA pullback already reclaimed and extending"
          : "EMA pullback watch after fresh pullback",
        confidence: reclaimUp ? 60 : 64,
        setupState: reclaimUp ? "confirmed" : "armed",
        actionable: false,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: reclaimUp ? 58 : 76,
        pullbackQuality: clamp(58 + pullbackDepthUp * 2600, 0, 100),
        reclaimQuality: clamp(56 + reclaimDistance * 2800, 0, 100),
        trendStrength,
        triggerType: reclaimUp ? "EMA_RECLAIM_HOLD" : "EMA_RECLAIM_WATCH",
      }),
    };
  }

  if (trendDown && hadPullbackDown && belowSlow) {
    const reclaimDistance = Math.abs(curClose - curFast) / Math.max(1, Math.abs(curClose));
    return {
      setupState: reclaimDown ? "confirmed" : "armed",
      actionable: false,
      candidate: buildEmaPullbackCandidate({
        side: "SELL",
        reason: reclaimDown
          ? "EMA pullback already rejected and extending"
          : "EMA pullback watch after fresh bearish pullback",
        confidence: reclaimDown ? 60 : 64,
        setupState: reclaimDown ? "confirmed" : "armed",
        actionable: false,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: reclaimDown ? 58 : 76,
        pullbackQuality: clamp(58 + pullbackDepthDown * 2600, 0, 100),
        reclaimQuality: clamp(56 + reclaimDistance * 2800, 0, 100),
        trendStrength,
        triggerType: reclaimDown ? "EMA_REJECT_HOLD" : "EMA_REJECT_WATCH",
      }),
    };
  }

  const pullbackFormingUp = trendUp && recent.some((candle, index) => Number(candle?.close) <= recentSlow[index]);
  if (pullbackFormingUp) {
    return {
      setupState: "forming",
      actionable: false,
      candidate: buildEmaPullbackCandidate({
        side: "BUY",
        reason: "EMA pullback forming inside bullish trend",
        confidence: 58,
        setupState: "forming",
        actionable: false,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: 72,
        pullbackQuality: clamp(56 + pullbackDepthUp * 2200, 0, 100),
        reclaimQuality: 54,
        trendStrength,
        triggerType: "EMA_PULLBACK_FORMING",
      }),
    };
  }

  const pullbackFormingDown = trendDown && recent.some((candle, index) => Number(candle?.close) >= recentSlow[index]);
  if (pullbackFormingDown) {
    return {
      setupState: "forming",
      actionable: false,
      candidate: buildEmaPullbackCandidate({
        side: "SELL",
        reason: "EMA pullback forming inside bearish trend",
        confidence: 58,
        setupState: "forming",
        actionable: false,
        fast,
        slow,
        pullbackWindow,
        curFast,
        curSlow,
        volume,
        freshness: 72,
        pullbackQuality: clamp(56 + pullbackDepthDown * 2200, 0, 100),
        reclaimQuality: 54,
        trendStrength,
        triggerType: "EMA_PULLBACK_FORMING",
      }),
    };
  }

  return null;
}

function emaPullbackStrategy(args) {
  const setup = evaluateEmaPullbackSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  emaPullbackStrategy,
  evaluateEmaPullbackSetup,
};
