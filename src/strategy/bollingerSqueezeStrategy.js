const {
  clamp,
  bollingerBands,
  getCurrentSessionCandles,
  volumeConfirmation,
} = require("./utils");

function squeezeCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  triggerType,
  triggerLevel,
  widthPct,
  compressionDuration,
  volume,
  patternQuality,
  anchorQuality,
  structureQuality,
  freshness,
}) {
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      anchorType: "BOLLINGER_BAND",
      anchorValue: widthPct,
      triggerType,
      triggerLevel,
      setupState,
      compressionDuration,
      widthPct,
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

function recentCompressionDuration(candles, period, std, squeezePct) {
  let count = 0;
  for (let index = candles.length; index >= period; index -= 1) {
    const bb = bollingerBands(candles.slice(0, index), period, std);
    if (!bb || bb.widthPct > squeezePct) break;
    count += 1;
  }
  return count;
}

function evaluateBollingerSqueezeSetup({
  candles,
  period = 20,
  std = 2,
  squeezePct = 0.012,
  volLookback = 20,
  volMult = 1.1,
  priorState = null,
}) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < period + 2) return null;

  const bb = bollingerBands(sessionBars, period, std);
  if (!bb) return null;
  const last = sessionBars[sessionBars.length - 1];
  const close = Number(last.close);
  const compressionDuration = recentCompressionDuration(sessionBars, period, std, squeezePct);
  const isCompressed = bb.widthPct <= squeezePct;
  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });

  const priorTrigger = String(priorState?.triggerType || "");
  const priorStateName = String(priorState?.setupState || "");
  const delayBars = Math.max(0, Number(priorState?.candidateAgeBars ?? 0));

  if (
    (priorTrigger === "SQUEEZE_ARMED" || priorStateName === "armed") &&
    close > bb.upper &&
    volume.ok
  ) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / Math.max(squeezePct, 1e-6));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: squeezeCandidate({
        side: "BUY",
        reason: `BB squeeze breakout above ${bb.upper.toFixed(2)}`,
        confidence: Math.min(95, 66 + tightScore * 18 + Math.max(0, (volume.ratio ?? 0) - volMult) * 10),
        setupState: "triggered",
        actionable: true,
        triggerType: "SQUEEZE_BREAKOUT",
        triggerLevel: bb.upper,
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: clamp(62 + tightScore * 24, 0, 100),
        anchorQuality: clamp(60 + compressionDuration * 3, 0, 100),
        structureQuality: clamp(60 + compressionDuration * 2 + tightScore * 18, 0, 100),
        freshness: 86,
      }),
    };
  }

  if (
    (priorTrigger === "SQUEEZE_ARMED" || priorStateName === "armed") &&
    close < bb.lower &&
    volume.ok
  ) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / Math.max(squeezePct, 1e-6));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: squeezeCandidate({
        side: "SELL",
        reason: `BB squeeze breakdown below ${bb.lower.toFixed(2)}`,
        confidence: Math.min(95, 66 + tightScore * 18 + Math.max(0, (volume.ratio ?? 0) - volMult) * 10),
        setupState: "triggered",
        actionable: true,
        triggerType: "SQUEEZE_BREAKDOWN",
        triggerLevel: bb.lower,
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: clamp(62 + tightScore * 24, 0, 100),
        anchorQuality: clamp(60 + compressionDuration * 3, 0, 100),
        structureQuality: clamp(60 + compressionDuration * 2 + tightScore * 18, 0, 100),
        freshness: 86,
      }),
    };
  }

  if (isCompressed && compressionDuration >= 2) {
    const squeezeSide = close >= bb.mid ? "BUY" : "SELL";
    return {
      setupState: compressionDuration >= 4 ? "armed" : "forming",
      actionable: false,
      candidate: squeezeCandidate({
        side: squeezeSide,
        reason: compressionDuration >= 4 ? "BB squeeze armed for expansion" : "BB squeeze compression forming",
        confidence: compressionDuration >= 4 ? 64 : 58,
        setupState: compressionDuration >= 4 ? "armed" : "forming",
        actionable: false,
        triggerType: compressionDuration >= 4 ? "SQUEEZE_ARMED" : "SQUEEZE_FORMING",
        triggerLevel: squeezeSide === "BUY" ? bb.upper : bb.lower,
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: clamp(60 + Math.max(0, (squeezePct - bb.widthPct) / Math.max(squeezePct, 1e-6)) * 22, 0, 100),
        anchorQuality: clamp(58 + compressionDuration * 3, 0, 100),
        structureQuality: clamp(58 + compressionDuration * 2, 0, 100),
        freshness: compressionDuration >= 4 ? 76 : 70,
      }),
    };
  }

  if (priorTrigger === "SQUEEZE_ARMED" && delayBars >= 4) {
    return {
      setupState: "expired",
      actionable: false,
      candidate: squeezeCandidate({
        side: String(priorState?.side || "BUY"),
        reason: "BB squeeze went stale without fresh expansion",
        confidence: 54,
        setupState: "expired",
        actionable: false,
        triggerType: "SQUEEZE_STALE",
        triggerLevel: Number(priorState?.triggerLevel ?? close),
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: 52,
        anchorQuality: 54,
        structureQuality: 54,
        freshness: 40,
      }),
    };
  }

  if (isCompressed && close > bb.upper && volume.ok) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / Math.max(squeezePct, 1e-6));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: squeezeCandidate({
        side: "BUY",
        reason: `BB squeeze breakout above ${bb.upper.toFixed(2)}`,
        confidence: Math.min(95, 65 + tightScore * 20 + Math.max(0, (volume.ratio ?? 0) - volMult) * 10),
        setupState: "triggered",
        actionable: true,
        triggerType: "SQUEEZE_BREAKOUT",
        triggerLevel: bb.upper,
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: clamp(60 + tightScore * 20, 0, 100),
        anchorQuality: clamp(58 + Math.max(0, 1 - bb.widthPct / Math.max(squeezePct, 1e-6)) * 22, 0, 100),
        structureQuality: clamp(60 + compressionDuration * 2 + tightScore * 16, 0, 100),
        freshness: 83,
      }),
    };
  }

  if (isCompressed && close < bb.lower && volume.ok) {
    const tightScore = Math.max(0, (squeezePct - bb.widthPct) / Math.max(squeezePct, 1e-6));
    return {
      setupState: "triggered",
      actionable: true,
      candidate: squeezeCandidate({
        side: "SELL",
        reason: `BB squeeze breakdown below ${bb.lower.toFixed(2)}`,
        confidence: Math.min(95, 65 + tightScore * 20 + Math.max(0, (volume.ratio ?? 0) - volMult) * 10),
        setupState: "triggered",
        actionable: true,
        triggerType: "SQUEEZE_BREAKDOWN",
        triggerLevel: bb.lower,
        widthPct: bb.widthPct,
        compressionDuration,
        volume,
        patternQuality: clamp(60 + tightScore * 20, 0, 100),
        anchorQuality: clamp(58 + Math.max(0, 1 - bb.widthPct / Math.max(squeezePct, 1e-6)) * 22, 0, 100),
        structureQuality: clamp(60 + compressionDuration * 2 + tightScore * 16, 0, 100),
        freshness: 83,
      }),
    };
  }

  return null;
}

function bollingerSqueezeStrategy(args) {
  const setup = evaluateBollingerSqueezeSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  bollingerSqueezeStrategy,
  evaluateBollingerSqueezeSetup,
};
