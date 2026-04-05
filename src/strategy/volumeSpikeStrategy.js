const {
  clamp,
  candleBody,
  candleRange,
  maxHigh,
  minLow,
  getCurrentSessionCandles,
  sessionVWAP,
  volumeConfirmation,
} = require("./utils");

function volumeSpikeCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  triggerType,
  triggerLevel,
  anchorValue,
  spikeFamily,
  continuationFriendly,
  exhaustionFriendly,
  patternQuality,
  anchorQuality,
  structureQuality,
  volume,
  freshness,
}) {
  return {
    side,
    reason,
    confidence,
    actionable,
    meta: {
      triggerType,
      setupState,
      anchorType: "MOMENTUM_BAR",
      triggerLevel,
      anchorValue,
      spikeFamily,
      continuationFriendly,
      exhaustionFriendly,
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

function evaluateVolumeSpikeSetup({
  candles,
  volLookback = 20,
  volMult = 1.6,
  bodyFrac = 0.6,
  priorState = null,
}) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < 2) return null;

  const last = sessionBars[sessionBars.length - 1];
  const prev = sessionBars[sessionBars.length - 2];
  const base = sessionBars.slice(0, -1);
  const o = Number(last.open);
  const c = Number(last.close);
  const h = Number(last.high);
  const l = Number(last.low);
  const range = candleRange(last);
  if (range <= 0) return null;

  const bodyRatio = candleBody(last) / range;
  const nearHigh = (h - c) / range <= 0.22;
  const nearLow = (c - l) / range <= 0.22;
  const sessionHigh = maxHigh(base.length ? base : sessionBars);
  const sessionLow = minLow(base.length ? base : sessionBars);
  const vwap = sessionVWAP(sessionBars, last.ts);
  const vwapDist = Number.isFinite(vwap) ? (c - vwap) / Math.max(1, Math.abs(c)) : 0;
  const trendMove = base.length
    ? (Number(base[base.length - 1]?.close) - Number(base[0]?.close)) / Math.max(1, Math.abs(c))
    : 0;

  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });
  const bullishSpike = c > o && nearHigh && bodyRatio >= bodyFrac && volume.ok;
  const bearishSpike = c < o && nearLow && bodyRatio >= bodyFrac && volume.ok;
  const extendedUp = c >= sessionHigh && vwapDist > 0.01 && trendMove > 0.01;
  const extendedDown = c <= sessionLow && vwapDist < -0.01 && trendMove < -0.01;

  const priorTrigger = String(priorState?.triggerType || "");
  const priorLevel = Number(priorState?.triggerLevel);
  const priorAnchor = Number(priorState?.anchorValue);
  const priorSide = String(priorState?.side || "");

  if (
    priorTrigger === "VOLUME_CONTINUATION_WATCH" &&
    priorSide === "BUY" &&
    Number.isFinite(priorLevel) &&
    c > priorLevel
  ) {
    return {
      setupState: "triggered",
      actionable: true,
      candidate: volumeSpikeCandidate({
        side: "BUY",
        reason: "Volume continuation confirmed above spike high",
        confidence: clamp(66 + (Number(priorState?.volumeRatio ?? 0) - volMult) * 10, 0, 100),
        setupState: "triggered",
        actionable: true,
        triggerType: "VOLUME_CONTINUATION",
        triggerLevel: priorLevel,
        anchorValue: priorAnchor,
        spikeFamily: "CONTINUATION",
        continuationFriendly: true,
        exhaustionFriendly: false,
        patternQuality: 78,
        anchorQuality: 70,
        structureQuality: 82,
        volume,
        freshness: 86,
      }),
    };
  }

  if (
    priorTrigger === "VOLUME_CONTINUATION_WATCH" &&
    priorSide === "SELL" &&
    Number.isFinite(priorLevel) &&
    c < priorLevel
  ) {
    return {
      setupState: "triggered",
      actionable: true,
      candidate: volumeSpikeCandidate({
        side: "SELL",
        reason: "Volume continuation confirmed below spike low",
        confidence: clamp(66 + (Number(priorState?.volumeRatio ?? 0) - volMult) * 10, 0, 100),
        setupState: "triggered",
        actionable: true,
        triggerType: "VOLUME_CONTINUATION",
        triggerLevel: priorLevel,
        anchorValue: priorAnchor,
        spikeFamily: "CONTINUATION",
        continuationFriendly: true,
        exhaustionFriendly: false,
        patternQuality: 78,
        anchorQuality: 70,
        structureQuality: 82,
        volume,
        freshness: 86,
      }),
    };
  }

  if (
    priorTrigger === "VOLUME_EXHAUSTION_WATCH" &&
    priorSide === "SELL" &&
    Number.isFinite(priorAnchor) &&
    c < priorAnchor
  ) {
    return {
      setupState: "triggered",
      actionable: true,
      candidate: volumeSpikeCandidate({
        side: "SELL",
        reason: "Bullish exhaustion spike reversed below anchor",
        confidence: 72,
        setupState: "triggered",
        actionable: true,
        triggerType: "VOLUME_EXHAUSTION",
        triggerLevel: Number.isFinite(priorLevel) ? priorLevel : h,
        anchorValue: priorAnchor,
        spikeFamily: "EXHAUSTION",
        continuationFriendly: false,
        exhaustionFriendly: true,
        patternQuality: 76,
        anchorQuality: 74,
        structureQuality: 80,
        volume,
        freshness: 84,
      }),
    };
  }

  if (
    priorTrigger === "VOLUME_EXHAUSTION_WATCH" &&
    priorSide === "BUY" &&
    Number.isFinite(priorAnchor) &&
    c > priorAnchor
  ) {
    return {
      setupState: "triggered",
      actionable: true,
      candidate: volumeSpikeCandidate({
        side: "BUY",
        reason: "Bearish exhaustion spike reversed above anchor",
        confidence: 72,
        setupState: "triggered",
        actionable: true,
        triggerType: "VOLUME_EXHAUSTION",
        triggerLevel: Number.isFinite(priorLevel) ? priorLevel : l,
        anchorValue: priorAnchor,
        spikeFamily: "EXHAUSTION",
        continuationFriendly: false,
        exhaustionFriendly: true,
        patternQuality: 76,
        anchorQuality: 74,
        structureQuality: 80,
        volume,
        freshness: 84,
      }),
    };
  }

  if (bullishSpike) {
    const continuationFriendly = !extendedUp;
    const triggerType = continuationFriendly ? "VOLUME_CONTINUATION_WATCH" : "VOLUME_EXHAUSTION_WATCH";
    return {
      setupState: "armed",
      actionable: false,
      candidate: volumeSpikeCandidate({
        side: continuationFriendly ? "BUY" : "SELL",
        reason: continuationFriendly
          ? `Bullish volume spike arming continuation above ${h.toFixed(2)}`
          : "Bullish volume spike looks exhaustion-prone",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        triggerType,
        triggerLevel: h,
        anchorValue: (h + l) / 2,
        spikeFamily: continuationFriendly ? "CONTINUATION" : "EXHAUSTION",
        continuationFriendly,
        exhaustionFriendly: !continuationFriendly,
        patternQuality: clamp(60 + (bodyRatio - bodyFrac) * 42, 0, 100),
        anchorQuality: clamp(56 + (nearHigh ? 16 : 0), 0, 100),
        structureQuality: clamp(58 + Math.abs(vwapDist) * 1400, 0, 100),
        volume,
        freshness: 78,
      }),
    };
  }

  if (bearishSpike) {
    const continuationFriendly = !extendedDown;
    const triggerType = continuationFriendly ? "VOLUME_CONTINUATION_WATCH" : "VOLUME_EXHAUSTION_WATCH";
    return {
      setupState: "armed",
      actionable: false,
      candidate: volumeSpikeCandidate({
        side: continuationFriendly ? "SELL" : "BUY",
        reason: continuationFriendly
          ? `Bearish volume spike arming continuation below ${l.toFixed(2)}`
          : "Bearish volume spike looks exhaustion-prone",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        triggerType,
        triggerLevel: l,
        anchorValue: (h + l) / 2,
        spikeFamily: continuationFriendly ? "CONTINUATION" : "EXHAUSTION",
        continuationFriendly,
        exhaustionFriendly: !continuationFriendly,
        patternQuality: clamp(60 + (bodyRatio - bodyFrac) * 42, 0, 100),
        anchorQuality: clamp(56 + (nearLow ? 16 : 0), 0, 100),
        structureQuality: clamp(58 + Math.abs(vwapDist) * 1400, 0, 100),
        volume,
        freshness: 78,
      }),
    };
  }

  if (priorTrigger.startsWith("VOLUME_")) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: volumeSpikeCandidate({
        side: priorSide || "BUY",
        reason: "Volume spike setup stale without clean confirmation",
        confidence: 56,
        setupState: "confirmed",
        actionable: false,
        triggerType: "VOLUME_SPIKE_STALE",
        triggerLevel: Number.isFinite(priorLevel) ? priorLevel : c,
        anchorValue: Number.isFinite(priorAnchor) ? priorAnchor : c,
        spikeFamily: String(priorState?.spikeFamily || "UNKNOWN"),
        continuationFriendly: priorTrigger === "VOLUME_CONTINUATION_WATCH",
        exhaustionFriendly: priorTrigger === "VOLUME_EXHAUSTION_WATCH",
        patternQuality: 54,
        anchorQuality: 54,
        structureQuality: 56,
        volume,
        freshness: 48,
      }),
    };
  }

  return null;
}

function volumeSpikeStrategy(args) {
  const setup = evaluateVolumeSpikeSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  volumeSpikeStrategy,
  evaluateVolumeSpikeSetup,
};
