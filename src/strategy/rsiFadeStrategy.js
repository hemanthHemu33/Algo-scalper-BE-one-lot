const {
  clamp,
  sessionVWAP,
  rsi,
  getCurrentSessionCandles,
} = require("./utils");

function rsiCandidate({
  side,
  reason,
  confidence,
  vwapValue,
  oscillator,
  period,
  setupState,
  actionable,
  patternQuality,
  anchorQuality,
  structureQuality,
  freshness,
  extremeBucket,
  triggerType,
}) {
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      anchor: "SESSION_VWAP",
      anchorValue: vwapValue,
      oscillator,
      period,
      neutralLevel: 50,
      extremeBucket,
      anchorType: "SESSION_VWAP",
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

function evaluateRsiFadeSetup({
  candles,
  period = 14,
  ob = 70,
  os = 30,
  vwapLookback = 120,
}) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < period + 3) return null;

  const last = sessionBars[sessionBars.length - 1];
  const prev = sessionBars[sessionBars.length - 2];
  const close = Number(last.close);
  const open = Number(last.open);
  const prevClose = Number(prev.close);
  void vwapLookback;

  const v = sessionVWAP(sessionBars, last?.ts);
  const val = rsi(sessionBars, period);
  const prevVal = rsi(sessionBars.slice(0, -1), period);
  if (!Number.isFinite(v) || !Number.isFinite(val) || !Number.isFinite(prevVal)) {
    return null;
  }

  const dist = v !== 0 ? (close - v) / v : 0;
  const recentOsc = sessionBars
    .slice(-(Math.max(4, Math.min(6, period))))
    .map((_, index, arr) => {
      return rsi(sessionBars.slice(0, sessionBars.length - arr.length + index + 1), period);
    })
    .filter(Number.isFinite);
  const recentHigh = recentOsc.length ? Math.max(...recentOsc) : val;
  const recentLow = recentOsc.length ? Math.min(...recentOsc) : val;

  const buyExtremeReached = recentLow <= os;
  const sellExtremeReached = recentHigh >= ob;
  const buyRejection = close >= prevClose || close >= open;
  const sellRejection = close <= prevClose || close <= open;
  const buyNormalization = val > prevVal;
  const sellNormalization = val < prevVal;

  if (buyExtremeReached && close < v && buyRejection && buyNormalization) {
    const patternQuality = clamp(60 + (os - Math.min(val, prevVal)) * 1.1, 0, 100);
    const anchorQuality = clamp(55 + Math.min(20, Math.abs(dist) * 1500), 0, 100);
    const structureQuality = clamp(
      58 +
        (buyRejection ? 10 : 0) +
        (buyNormalization ? 10 : 0) +
        Math.min(10, Math.abs(dist) * 900),
      0,
      100,
    );
    const confidence = Math.min(
      90,
      60 + (os - Math.min(val, prevVal)) * 0.8 + Math.min(12, Math.abs(dist) * 900),
    );
    const extremeBucket =
      recentLow <= os - 10 ? "EXTREME" : recentLow <= os - 5 ? "STRONG" : "BASE";
    return {
      setupState: "triggered",
      actionable: true,
      candidate: rsiCandidate({
        side: "BUY",
        reason: `RSI fade BUY after oversold rejection (RSI ${val.toFixed(1)})`,
        confidence,
        vwapValue: v,
        oscillator: val,
        period,
        setupState: "triggered",
        actionable: true,
        patternQuality,
        anchorQuality,
        structureQuality,
        freshness: 84,
        extremeBucket,
        triggerType: "RSI_FADE",
      }),
    };
  }

  if (sellExtremeReached && close > v && sellRejection && sellNormalization) {
    const patternQuality = clamp(60 + (Math.max(val, prevVal) - ob) * 1.1, 0, 100);
    const anchorQuality = clamp(55 + Math.min(20, Math.abs(dist) * 1500), 0, 100);
    const structureQuality = clamp(
      58 +
        (sellRejection ? 10 : 0) +
        (sellNormalization ? 10 : 0) +
        Math.min(10, Math.abs(dist) * 900),
      0,
      100,
    );
    const confidence = Math.min(
      90,
      60 + (Math.max(val, prevVal) - ob) * 0.8 + Math.min(12, Math.abs(dist) * 900),
    );
    const extremeBucket =
      recentHigh >= ob + 10 ? "EXTREME" : recentHigh >= ob + 5 ? "STRONG" : "BASE";
    return {
      setupState: "triggered",
      actionable: true,
      candidate: rsiCandidate({
        side: "SELL",
        reason: `RSI fade SELL after overbought rejection (RSI ${val.toFixed(1)})`,
        confidence,
        vwapValue: v,
        oscillator: val,
        period,
        setupState: "triggered",
        actionable: true,
        patternQuality,
        anchorQuality,
        structureQuality,
        freshness: 84,
        extremeBucket,
        triggerType: "RSI_FADE",
      }),
    };
  }

  if (buyExtremeReached && close < v) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: rsiCandidate({
        side: "BUY",
        reason: "RSI fade watch after oversold extreme",
        confidence: 62,
        vwapValue: v,
        oscillator: val,
        period,
        setupState: "armed",
        actionable: false,
        patternQuality: 58,
        anchorQuality: 60,
        structureQuality: clamp(58 + (buyRejection ? 8 : 0), 0, 100),
        freshness: 74,
        extremeBucket:
          recentLow <= os - 10 ? "EXTREME" : recentLow <= os - 5 ? "STRONG" : "BASE",
        triggerType: "RSI_FADE_WATCH",
      }),
    };
  }

  if (sellExtremeReached && close > v) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: rsiCandidate({
        side: "SELL",
        reason: "RSI fade watch after overbought extreme",
        confidence: 62,
        vwapValue: v,
        oscillator: val,
        period,
        setupState: "armed",
        actionable: false,
        patternQuality: 58,
        anchorQuality: 60,
        structureQuality: clamp(58 + (sellRejection ? 8 : 0), 0, 100),
        freshness: 74,
        extremeBucket:
          recentHigh >= ob + 10 ? "EXTREME" : recentHigh >= ob + 5 ? "STRONG" : "BASE",
        triggerType: "RSI_FADE_WATCH",
      }),
    };
  }

  return null;
}

function rsiFadeStrategy(args) {
  const setup = evaluateRsiFadeSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  rsiFadeStrategy,
  evaluateRsiFadeSetup,
};
