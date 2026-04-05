const { env } = require("../config");
const { emaSeries } = require("./ema");
const { clamp, getCurrentSessionCandles, sessionVWAP } = require("./utils");

function crossCandidate({
  side,
  reason,
  confidence,
  fast,
  slow,
  curFast,
  curSlow,
  diffBps,
  slopeFast,
  slopeSlow,
  setupState,
  actionable,
  triggerType,
  freshness,
  whipsawPenalty,
}) {
  const separationQuality = clamp(diffBps * 1.3, 0, 100);
  const sessionBias = Number.isFinite(curFast) && Number.isFinite(curSlow) ? clamp(55 + Math.abs(curFast - curSlow) * 8, 0, 100) : 55;
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      fast,
      slow,
      anchorType: "EMA_CROSS",
      anchorValue: curFast,
      triggerType,
      setupState,
      diffBps,
      slopeFast,
      slopeSlow,
      patternQuality: separationQuality,
      anchorQuality: clamp(56 + (freshness - 60) * 0.5, 0, 100),
      structureQuality: clamp(58 + separationQuality * 0.32 + sessionBias * 0.12, 0, 100),
      volumeQuality: 55,
      freshness,
      separationQuality,
      whipsawPenalty,
      sessionOnly: true,
    },
  };
}

function evaluateEmaCrossSetup({ candles, fast = 9, slow = 21, priorState = null }) {
  const sessionBars = getCurrentSessionCandles(candles);
  if (!sessionBars || sessionBars.length < Math.max(fast, slow) + 2) return null;

  const closes = sessionBars.map((candle) => Number(candle.close)).filter(Number.isFinite);
  if (closes.length < Math.max(fast, slow) + 2) return null;

  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const n = closes.length;
  const prevFast = Number(emaFast[n - 2]);
  const prevSlow = Number(emaSlow[n - 2]);
  const curFast = Number(emaFast[n - 1]);
  const curSlow = Number(emaSlow[n - 1]);
  const price = Number(closes[n - 1]);
  const vwap = sessionVWAP(sessionBars, sessionBars[n - 1]?.ts);

  if (![prevFast, prevSlow, curFast, curSlow, price].every(Number.isFinite) || price <= 0) {
    return null;
  }

  const crossedUp = prevFast <= prevSlow && curFast > curSlow;
  const crossedDown = prevFast >= prevSlow && curFast < curSlow;
  const diff = Math.abs(curFast - curSlow);
  const diffBps = (diff / price) * 10000;
  const slopeFast = curFast - prevFast;
  const slopeSlow = curSlow - prevSlow;
  const nearCross = diffBps <= 8;
  const slopesBullish = slopeFast > 0 && slopeSlow >= 0;
  const slopesBearish = slopeFast < 0 && slopeSlow <= 0;
  const avgSlopeBps =
    price > 0
      ? ((Math.abs(slopeFast) + Math.abs(slopeSlow)) / 2 / price) * 10000
      : 0;
  const minSlopeBps = Math.max(
    0,
    Number(env.EMA_CROSS_MIN_SLOPE_BPS ?? 2),
  );
  const minSeparationBps = Math.max(
    0,
    Number(env.EMA_CROSS_MIN_SEPARATION_BPS ?? 6),
  );
  const antiChopBars = Math.max(
    0,
    Number(env.EMA_CROSS_ANTI_CHOP_BARS ?? 4),
  );
  const priorTrigger = String(priorState?.triggerType || "");
  const priorSide = String(priorState?.side || "");
  const priorActive = priorState && Number.isFinite(Number(priorState?.lastSeenTs));
  const priorAgeBars = Math.max(0, Number(priorState?.candidateAgeBars ?? 0));
  const antiChopBlocked =
    priorActive &&
    priorAgeBars < antiChopBars &&
    ((priorSide === "BUY" && crossedUp) || (priorSide === "SELL" && crossedDown));
  const whipsawPenalty =
    priorActive &&
    ((priorSide === "BUY" && crossedDown) || (priorSide === "SELL" && crossedUp))
      ? 16
      : diffBps < 6
        ? 12
        : diffBps < 12
          ? 6
          : 0;
  const slopeQualified = avgSlopeBps >= minSlopeBps;
  const separationQualified = diffBps >= minSeparationBps;

  if (crossedUp && slopeQualified && separationQualified && !antiChopBlocked) {
    const confidence = clamp(58 + diffBps * 1.2 + (slopesBullish ? 12 : 6) - whipsawPenalty, 0, 100);
    return {
      setupState: "triggered",
      actionable: true,
      candidate: crossCandidate({
        side: "BUY",
        reason: `EMA${fast} crossed above EMA${slow}`,
        confidence,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "triggered",
        actionable: true,
        triggerType: "EMA_BULL_CROSS",
        freshness: clamp(88 - whipsawPenalty, 44, 92),
        whipsawPenalty,
      }),
    };
  }

  if (crossedDown && slopeQualified && separationQualified && !antiChopBlocked) {
    const confidence = clamp(58 + diffBps * 1.2 + (slopesBearish ? 12 : 6) - whipsawPenalty, 0, 100);
    return {
      setupState: "triggered",
      actionable: true,
      candidate: crossCandidate({
        side: "SELL",
        reason: `EMA${fast} crossed below EMA${slow}`,
        confidence,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "triggered",
        actionable: true,
        triggerType: "EMA_BEAR_CROSS",
        freshness: clamp(88 - whipsawPenalty, 44, 92),
        whipsawPenalty,
      }),
    };
  }

  if (nearCross && slopesBullish && price >= (vwap || price)) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: crossCandidate({
        side: "BUY",
        reason: "EMA bull cross watch",
        confidence: 63,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "armed",
        actionable: false,
        triggerType: "EMA_BULL_CROSS_WATCH",
        freshness: 74,
        whipsawPenalty,
      }),
    };
  }

  if (nearCross && slopesBearish && price <= (vwap || price)) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: crossCandidate({
        side: "SELL",
        reason: "EMA bear cross watch",
        confidence: 63,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "armed",
        actionable: false,
        triggerType: "EMA_BEAR_CROSS_WATCH",
        freshness: 74,
        whipsawPenalty,
      }),
    };
  }

  if (priorTrigger === "EMA_BULL_CROSS" && priorSide === "BUY" && curFast > curSlow && diffBps > 10) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: crossCandidate({
        side: "BUY",
        reason: "EMA bull cross follow-through",
        confidence: 64,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "confirmed",
        actionable: false,
        triggerType: "EMA_BULL_CROSS_HOLD",
        freshness: 60,
        whipsawPenalty,
      }),
    };
  }

  if (priorTrigger === "EMA_BEAR_CROSS" && priorSide === "SELL" && curFast < curSlow && diffBps > 10) {
    return {
      setupState: "confirmed",
      actionable: false,
      candidate: crossCandidate({
        side: "SELL",
        reason: "EMA bear cross follow-through",
        confidence: 64,
        fast,
        slow,
        curFast,
        curSlow,
        diffBps,
        slopeFast,
        slopeSlow,
        setupState: "confirmed",
        actionable: false,
        triggerType: "EMA_BEAR_CROSS_HOLD",
        freshness: 60,
        whipsawPenalty,
      }),
    };
  }

  return null;
}

function emaCrossStrategy(args) {
  const setup = evaluateEmaCrossSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  emaCrossStrategy,
  evaluateEmaCrossSetup,
};
