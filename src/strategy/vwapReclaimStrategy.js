const { emaSeries } = require("./ema");
const {
  clamp,
  sessionCandles,
  sessionVWAP,
  volumeConfirmation,
} = require("./utils");

function vwapCandidate({
  side,
  reason,
  confidence,
  vwapValue,
  triggerType,
  setupState,
  actionable,
  patternQuality,
  anchorQuality,
  structureQuality,
  volume,
  freshness,
  fast,
  slow,
  transition,
}) {
  return {
    side,
    reason,
    confidence,
    actionable,
    meta: {
      anchor: "SESSION_VWAP",
      anchorValue: vwapValue,
      vwapTransition: transition,
      fast,
      slow,
      anchorType: "SESSION_VWAP",
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

function evaluateVwapReclaimSetup({
  candles,
  lookback = 120,
  volLookback = 20,
  volMult = 1.0,
  fast = 9,
  slow = 21,
}) {
  void lookback;
  if (!candles || candles.length < 2) return null;

  const prev = candles[candles.length - 2];
  const cur = candles[candles.length - 1];
  if (!prev?.ts || !cur?.ts) return null;

  const prevSessionCandles = sessionCandles(candles, prev.ts);
  const curSessionCandles = sessionCandles(candles, cur.ts);
  if (
    curSessionCandles.length < Math.max(fast, slow, 2) ||
    prevSessionCandles.length < 1
  ) {
    return null;
  }

  const prevIsSameSession =
    prevSessionCandles[prevSessionCandles.length - 1]?.ts === prev.ts;
  if (!prevIsSameSession) return null;

  const prevClose = Number(prev.close);
  const curClose = Number(cur.close);

  const vwapPrev = sessionVWAP(candles, prev.ts);
  const vwapCur = sessionVWAP(candles, cur.ts);
  if (!Number.isFinite(vwapPrev) || !Number.isFinite(vwapCur)) return null;

  const volume = volumeConfirmation(curSessionCandles, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });

  const closes = curSessionCandles.map((candle) => Number(candle.close));
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const trendUp = emaFast[closes.length - 1] > emaSlow[closes.length - 1];
  const trendDown = emaFast[closes.length - 1] < emaSlow[closes.length - 1];
  const dist = (curClose - vwapCur) / Math.max(1, Math.abs(curClose));

  if (prevClose < vwapPrev && curClose > vwapCur && trendUp && volume.ok) {
    const reclaimFrac = (curClose - vwapCur) / Math.max(1, Math.abs(curClose));
    const patternQuality = clamp(60 + reclaimFrac * 3500, 0, 100);
    const anchorQuality = clamp(
      62 + Math.max(0, 1 - Math.abs(curClose - vwapCur) / Math.max(1, Math.abs(curClose))) * 20,
      0,
      100,
    );
    const structureQuality = clamp(
      58 +
        Math.max(0, reclaimFrac) * 2800 +
        Math.max(0, (emaFast[closes.length - 1] - emaSlow[closes.length - 1]) / Math.max(1, Math.abs(curClose))) * 1800,
      0,
      100,
    );
    const confidence = Math.min(90, 52 + Math.round((volume.ratio ?? 0) * 15));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: vwapCandidate({
        side: "BUY",
        reason: "VWAP reclaim (session)",
        confidence,
        vwapValue: vwapCur,
        triggerType: "VWAP_RECLAIM",
        setupState: "triggered",
        actionable: true,
        patternQuality,
        anchorQuality,
        structureQuality,
        volume,
        freshness: 85,
        fast,
        slow,
        transition: "BELOW_TO_ABOVE",
      }),
    };
  }

  if (prevClose > vwapPrev && curClose < vwapCur && trendDown && volume.ok) {
    const rejectFrac = (vwapCur - curClose) / Math.max(1, Math.abs(curClose));
    const patternQuality = clamp(60 + rejectFrac * 3500, 0, 100);
    const anchorQuality = clamp(
      62 + Math.max(0, 1 - Math.abs(curClose - vwapCur) / Math.max(1, Math.abs(curClose))) * 20,
      0,
      100,
    );
    const structureQuality = clamp(
      58 +
        Math.max(0, rejectFrac) * 2800 +
        Math.max(0, (emaSlow[closes.length - 1] - emaFast[closes.length - 1]) / Math.max(1, Math.abs(curClose))) * 1800,
      0,
      100,
    );
    const confidence = Math.min(90, 52 + Math.round((volume.ratio ?? 0) * 15));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: vwapCandidate({
        side: "SELL",
        reason: "VWAP reject (session)",
        confidence,
        vwapValue: vwapCur,
        triggerType: "VWAP_REJECT",
        setupState: "triggered",
        actionable: true,
        patternQuality,
        anchorQuality,
        structureQuality,
        volume,
        freshness: 85,
        fast,
        slow,
        transition: "ABOVE_TO_BELOW",
      }),
    };
  }

  if (prevClose < vwapPrev && curClose < vwapCur && trendUp && Math.abs(dist) <= 0.0035) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: vwapCandidate({
        side: "BUY",
        reason: "VWAP reclaim watch after loss below session VWAP",
        confidence: 64,
        vwapValue: vwapCur,
        triggerType: "VWAP_RECLAIM_WATCH",
        setupState: "armed",
        actionable: false,
        patternQuality: 60,
        anchorQuality: 64,
        structureQuality: 66,
        volume,
        freshness: 76,
        fast,
        slow,
        transition: "WATCH_BELOW_TO_ABOVE",
      }),
    };
  }

  if (prevClose > vwapPrev && curClose > vwapCur && trendDown && Math.abs(dist) <= 0.0035) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: vwapCandidate({
        side: "SELL",
        reason: "VWAP reject watch after move above session VWAP",
        confidence: 64,
        vwapValue: vwapCur,
        triggerType: "VWAP_REJECT_WATCH",
        setupState: "armed",
        actionable: false,
        patternQuality: 60,
        anchorQuality: 64,
        structureQuality: 66,
        volume,
        freshness: 76,
        fast,
        slow,
        transition: "WATCH_ABOVE_TO_BELOW",
      }),
    };
  }

  if (curClose > vwapCur && trendUp) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: vwapCandidate({
        side: "BUY",
        reason: "Price is already holding above session VWAP",
        confidence: 62,
        vwapValue: vwapCur,
        triggerType: "VWAP_HOLD_ABOVE",
        setupState: "confirmed",
        actionable: false,
        patternQuality: 56,
        anchorQuality: 60,
        structureQuality: 60,
        volume,
        freshness: 58,
        fast,
        slow,
        transition: "HOLD_ABOVE",
      }),
    };
  }

  if (curClose < vwapCur && trendDown) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: vwapCandidate({
        side: "SELL",
        reason: "Price is already holding below session VWAP",
        confidence: 62,
        vwapValue: vwapCur,
        triggerType: "VWAP_HOLD_BELOW",
        setupState: "confirmed",
        actionable: false,
        patternQuality: 56,
        anchorQuality: 60,
        structureQuality: 60,
        volume,
        freshness: 58,
        fast,
        slow,
        transition: "HOLD_BELOW",
      }),
    };
  }

  return null;
}

function vwapReclaimStrategy(args) {
  const setup = evaluateVwapReclaimSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  vwapReclaimStrategy,
  evaluateVwapReclaimSetup,
};
