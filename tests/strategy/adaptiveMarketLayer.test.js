const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

const PATHS = {
  config: path.join(ROOT, "src", "config.js"),
  selector: path.join(ROOT, "src", "strategy", "selector.js"),
  marketStateMachine: path.join(ROOT, "src", "strategy", "marketStateMachine.js"),
  levelAcceptance: path.join(ROOT, "src", "strategy", "levelAcceptance.js"),
  dangerStack: path.join(ROOT, "src", "strategy", "dangerStack.js"),
  retryGovernor: path.join(ROOT, "src", "strategy", "retryGovernor.js"),
  signalControls: path.join(ROOT, "src", "strategy", "signalControls.js"),
};

function patchObject(target, overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = target[key];
    target[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      target[key] = value;
    }
  };
}

function makeCandle(tsMs, open, high, low, close, volume = 100) {
  return {
    ts: new Date(tsMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function makeCandlesAroundLevel({
  level = 100,
  side = "BUY",
  mode = "REJECT",
  count = 12,
  startIso = "2026-01-01T09:15:00+05:30",
}) {
  const startMs = Date.parse(startIso);
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    const tsMs = startMs + index * 60_000;
    let open = level - 0.4;
    let high = level + 0.3;
    let low = level - 0.8;
    let close = level - 0.2;
    if (mode === "ACCEPT") {
      open = level + 0.05 + index * 0.01;
      high = level + 1.2 + index * 0.04;
      low = level - 0.06;
      close = level + 0.22 + index * 0.02;
      if (side === "SELL") {
        open = level - 0.05 - index * 0.01;
        high = level + 0.06;
        low = level - 1.2 - index * 0.04;
        close = level - 0.22 - index * 0.02;
      }
    } else if (mode === "REJECT") {
      high = level + (index % 2 === 0 ? 0.4 : 0.25);
      low = level - 0.9;
      close = level - (index % 2 === 0 ? 0.24 : 0.16);
      if (side === "SELL") {
        high = level + 0.9;
        low = level - (index % 2 === 0 ? 0.4 : 0.25);
        close = level + (index % 2 === 0 ? 0.24 : 0.16);
      }
    } else if (mode === "TOUCH_ONLY") {
      high = level + 0.42;
      low = level - 0.8;
      close = level - 0.12;
      if (side === "SELL") {
        high = level + 0.8;
        low = level - 0.42;
        close = level + 0.12;
      }
    }
    candles.push(makeCandle(tsMs, open, high, low, close, 120 + index * 2));
  }
  return candles;
}

function makeStrongTrendCandles({
  start = 100,
  drift = 0.28,
  count = 40,
  startIso = "2026-01-01T09:15:00+05:30",
}) {
  const startMs = Date.parse(startIso);
  const candles = [];
  let prev = start;
  for (let index = 0; index < count; index += 1) {
    const close = prev + drift;
    const open = prev;
    const high = close + 0.2;
    const low = open - 0.1;
    candles.push(
      makeCandle(startMs + index * 60_000, open, high, low, close, 100 + index * 3),
    );
    prev = close;
  }
  return candles;
}

function withEnv(overrides, fn) {
  const { env } = require(PATHS.config);
  const restore = patchObject(env, overrides);
  try {
    return fn(env);
  } finally {
    restore();
  }
}

function testEmaCrossNoLongerAlwaysOnByDefault() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.selector);
  const restore = patchObject(env, {
    STRATEGIES: "ema_cross,ema_pullback,breakout,vwap_reclaim",
    STRATEGIES_ALWAYS: "",
    STRATEGIES_TREND: "ema_pullback,breakout",
    STRATEGIES_TREND_COMPRESSED: "vwap_reclaim",
    STRATEGIES_BREAKOUT_WATCH: "vwap_reclaim",
  });
  try {
    const out = __debug.selectStrategiesFromDetection({
      det: {
        regime: "TREND_COMPRESSED",
        primaryRegime: "TREND_COMPRESSED",
        secondaryRegime: "BREAKOUT_WATCH",
        regimeWeights: {
          TREND_COMPRESSED: 0.62,
          BREAKOUT_WATCH: 0.24,
          TREND: 0.14,
        },
      },
      env,
    });
    assert.equal(out.strategyIds.includes("ema_cross"), false);
  } finally {
    restore();
  }
}

function testBreakoutWatchNoEarlyCollapse() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.selector);
  const restore = patchObject(env, {
    STRATEGIES: "ema_pullback,breakout,vwap_reclaim,wick_reversal",
    STRATEGIES_ALWAYS: "",
    STRATEGIES_TREND: "ema_pullback,breakout",
    STRATEGIES_TREND_COMPRESSED: "vwap_reclaim",
    STRATEGIES_BREAKOUT_WATCH: "wick_reversal",
  });
  try {
    const out = __debug.selectStrategiesFromDetection({
      det: {
        regime: "BREAKOUT_WATCH",
        primaryRegime: "BREAKOUT_WATCH",
        secondaryRegime: "TREND_COMPRESSED",
        regimeWeights: {
          BREAKOUT_WATCH: 0.58,
          TREND_COMPRESSED: 0.27,
          TREND: 0.15,
        },
      },
      env,
    });
    assert.equal(out.marketState, "BREAKOUT_WATCH");
    assert.ok(out.strategyIds.includes("wick_reversal"));
    assert.equal(out.strategyIds.includes("breakout"), false);
  } finally {
    restore();
  }
}

function testTrendCompressedUsesConservativeBucket() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.selector);
  const restore = patchObject(env, {
    STRATEGIES: "ema_pullback,breakout,volume_spike,vwap_reclaim",
    STRATEGIES_ALWAYS: "",
    STRATEGIES_TREND_COMPRESSED: "vwap_reclaim",
    STRATEGIES_TREND: "ema_pullback,breakout,volume_spike",
  });
  try {
    const out = __debug.selectStrategiesFromDetection({
      det: {
        regime: "TREND_COMPRESSED",
        primaryRegime: "TREND_COMPRESSED",
        secondaryRegime: "TREND",
        regimeWeights: {
          TREND_COMPRESSED: 0.7,
          TREND: 0.3,
        },
      },
      env,
    });
    assert.ok(out.strategyIds.includes("vwap_reclaim"));
    assert.equal(out.strategyIds.includes("breakout"), false);
    assert.equal(out.strategyIds.includes("volume_spike"), false);
  } finally {
    restore();
  }
}

function testRsiFadeNotSelectedInTrendCompressedByDefault() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.selector);
  const restore = patchObject(env, {
    STRATEGIES: "vwap_reclaim,wick_reversal,rsi_fade",
    STRATEGIES_ALWAYS: "",
    STRATEGIES_TREND_COMPRESSED: "vwap_reclaim,wick_reversal,rsi_fade",
    STRATEGIES_RANGE_CHOP: "fakeout,rsi_fade,wick_reversal",
    FRAGILE_REVERSAL_ALLOW_RSI_FADE: false,
  });
  try {
    const out = __debug.selectStrategiesFromDetection({
      det: {
        regime: "TREND_COMPRESSED",
        primaryRegime: "TREND_COMPRESSED",
        secondaryRegime: "RANGE",
        regimeWeights: {
          TREND_COMPRESSED: 0.7,
          RANGE: 0.2,
          TREND: 0.1,
        },
      },
      env,
    });
    assert.equal(out.strategyIds.includes("rsi_fade"), false);
    const blocked = out.strategyPermissions.blockedStrategiesWithReasons.find(
      (row) => row.strategyId === "rsi_fade",
    );
    assert.equal(blocked?.reasonCode, "RANGE_FRAGILE_REQUIRES_EXCEPTION");
    assert.equal(
      blocked?.exceptionReasonCode,
      "FRAGILE_REVERSAL_STRATEGY_NOT_ALLOWED",
    );
  } finally {
    restore();
  }
}

function testFailedBreakoutStateFromRepeatedRejection() {
  const { resolveMarketState } = require(PATHS.marketStateMachine);
  const out = resolveMarketState({
    regime: "BREAKOUT_WATCH",
    primaryRegime: "BREAKOUT_WATCH",
    regimeWeights: { BREAKOUT_WATCH: 0.6 },
    levelAcceptance: {
      breakoutAttemptDetected: true,
      breakoutRejected: true,
      repeatedRejectionDetected: true,
    },
    dangerStack: { dangerStackScore: 44 },
    env: { MARKET_STATE_TRAP_RISK_ENABLED: false },
  });
  assert.equal(out.marketState, "FAILED_BREAKOUT");
}

function testTrapRiskStateFromDangerStack() {
  const { resolveMarketState } = require(PATHS.marketStateMachine);
  const out = resolveMarketState({
    regime: "TREND_COMPRESSED",
    primaryRegime: "TREND_COMPRESSED",
    regimeWeights: { TREND_COMPRESSED: 0.62 },
    levelAcceptance: {
      breakoutRejected: true,
      repeatedRejectionDetected: true,
    },
    dangerStack: { dangerStackScore: 70 },
    retryGovernor: { blocked: true },
    env: {},
  });
  assert.equal(out.marketState, "TRAP_RISK_HIGH");
}

function testNoTradeStateDeterministic() {
  const { resolveMarketState } = require(PATHS.marketStateMachine);
  const out = resolveMarketState({
    regime: "FAILED_BREAKOUT",
    primaryRegime: "FAILED_BREAKOUT",
    regimeWeights: { BREAKOUT_WATCH: 0.4, TREND_COMPRESSED: 0.3 },
    levelAcceptance: {
      breakoutRejected: true,
      repeatedRejectionDetected: true,
    },
    dangerStack: { dangerStackScore: 92 },
    dteDays: 0.6,
    env: {
      DANGER_STACK_NO_TRADE_SCORE: 82,
    },
  });
  assert.equal(out.marketState, "NO_TRADE");
}

function testTouchOnlyBreakoutNotAccepted() {
  const { evaluateLevelAcceptance } = require(PATHS.levelAcceptance);
  const candles = makeCandlesAroundLevel({
    level: 100,
    side: "BUY",
    mode: "TOUCH_ONLY",
    count: 10,
  });
  const out = evaluateLevelAcceptance({
    candles,
    signal: {
      side: "BUY",
      strategyId: "breakout",
      meta: { triggerLevel: 100, rangeHigh: 100 },
    },
    context: { candles, last: candles[candles.length - 1] },
    env: {
      LEVEL_ACCEPTANCE_ENABLED: true,
      LEVEL_ACCEPTANCE_RETEST_REQUIRED: true,
      LEVEL_ACCEPTANCE_MIN_CLOSES_BEYOND: 2,
      LEVEL_REJECTION_MIN_COUNT: 2,
      LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR: 2,
      SELECTOR_ATR_PERIOD: 5,
    },
  });
  assert.equal(out.breakoutAttemptDetected, true);
  assert.equal(out.breakoutAccepted, false);
  assert.equal(out.breakoutRejected, true);
}

function testCloseHoldBreakoutAccepted() {
  const { evaluateLevelAcceptance } = require(PATHS.levelAcceptance);
  const candles = makeCandlesAroundLevel({
    level: 100,
    side: "BUY",
    mode: "ACCEPT",
    count: 10,
  });
  const out = evaluateLevelAcceptance({
    candles,
    signal: {
      side: "BUY",
      strategyId: "breakout",
      meta: { triggerLevel: 100, rangeHigh: 100 },
    },
    context: { candles, last: candles[candles.length - 1] },
    env: {
      LEVEL_ACCEPTANCE_ENABLED: true,
      LEVEL_ACCEPTANCE_RETEST_REQUIRED: false,
      LEVEL_ACCEPTANCE_MIN_CLOSES_BEYOND: 2,
      LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR: 5,
    },
  });
  assert.equal(out.breakoutAccepted, true);
}

function testRepeatedResistanceRejectionBlocksLongContinuation() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1,3,5",
    LEVEL_ACCEPTANCE_ENABLED: true,
    LEVEL_REJECTION_HARD_BLOCK_ENABLED: true,
    LEVEL_REJECTION_MIN_COUNT: 2,
    LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR: 2,
    SELECTOR_ATR_PERIOD: 5,
    MARKET_STATE_ENGINE_ENABLED: true,
    MARKET_STATE_FAILED_BREAKOUT_ENABLED: true,
    MARKET_STATE_TRAP_RISK_ENABLED: true,
    ONE_DTE_HARDENING_ENABLED: true,
  });
  try {
    const candles = makeCandlesAroundLevel({
      level: 100,
      side: "BUY",
      mode: "REJECT",
      count: 14,
    });
    const score = __debug.buildScoreBreakdown(
      {
        strategyId: "ema_pullback",
        strategyStyle: "TREND",
        strategyFamily: "TREND",
        side: "BUY",
        confidence: 84,
        meta: { triggerLevel: 100, rangeHigh: 100 },
      },
      {
        instrument_token: 901,
        intervalMin: 1,
        candles,
        last: candles[candles.length - 1],
        regime: "TREND_COMPRESSED",
        regimeMeta: {
          primaryRegime: "TREND_COMPRESSED",
          secondaryRegime: "BREAKOUT_WATCH",
          regimeWeights: { TREND_COMPRESSED: 0.62, BREAKOUT_WATCH: 0.25 },
        },
      },
    );
    assert.equal(score.blockedByLevelRejection, true);
    assert.equal(score.finalDecision, "BLOCK");
  } finally {
    restore();
  }
}

function testRepeatedSupportRejectionBlocksShortContinuation() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1,3,5",
    LEVEL_ACCEPTANCE_ENABLED: true,
    LEVEL_REJECTION_HARD_BLOCK_ENABLED: true,
    LEVEL_REJECTION_MIN_COUNT: 2,
    LEVEL_ACCEPTANCE_MAX_DISTANCE_ATR: 2,
    SELECTOR_ATR_PERIOD: 5,
  });
  try {
    const candles = makeCandlesAroundLevel({
      level: 100,
      side: "SELL",
      mode: "REJECT",
      count: 14,
    });
    const score = __debug.buildScoreBreakdown(
      {
        strategyId: "ema_pullback",
        strategyStyle: "TREND",
        strategyFamily: "TREND",
        side: "SELL",
        confidence: 84,
        meta: { triggerLevel: 100, rangeLow: 100 },
      },
      {
        instrument_token: 902,
        intervalMin: 1,
        candles,
        last: candles[candles.length - 1],
        regime: "BREAKOUT_WATCH",
        regimeMeta: {
          primaryRegime: "BREAKOUT_WATCH",
          secondaryRegime: "TREND_COMPRESSED",
          regimeWeights: { BREAKOUT_WATCH: 0.55, TREND_COMPRESSED: 0.28 },
        },
      },
    );
    assert.equal(score.blockedByLevelRejection, true);
    assert.equal(score.finalDecision, "BLOCK");
  } finally {
    restore();
  }
}

function testCompressedStateMtfIsStricter() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1,3,5",
    COMPRESSED_STRICT_MTF_ENABLED: true,
    STALE_HTF_EXTRA_PENALTY: 4,
    MISSING_HTF_EXTRA_PENALTY: 6,
    PARTIAL_ALIGN_EXTRA_PENALTY: 4,
  });
  try {
    const candles = makeStrongTrendCandles({ start: 100, drift: 0.15, count: 20 });
    const baseContext = {
      instrument_token: 903,
      intervalMin: 1,
      candles,
      last: candles[candles.length - 1],
      regime: "TREND",
      regimeMeta: { primaryRegime: "TREND" },
    };
    const clean = __debug.readMtfAgreement(
      { strategyStyle: "TREND", side: "BUY", marketState: "CLEAN_TREND" },
      baseContext,
    );
    const compressed = __debug.readMtfAgreement(
      { strategyStyle: "TREND", side: "BUY", marketState: "TREND_COMPRESSED" },
      {
        ...baseContext,
        regime: "TREND_COMPRESSED",
        regimeMeta: { primaryRegime: "TREND_COMPRESSED", marketState: "TREND_COMPRESSED" },
      },
    );
    assert.ok(compressed.mtfAgreementScore < clean.mtfAgreementScore);
  } finally {
    restore();
  }
}

function testOneDteUglyStateBlocksFragileContinuation() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    ONE_DTE_HARDENING_ENABLED: true,
    ONE_DTE_BLOCK_BREAKOUT_WATCH_TREND: true,
    ONE_DTE_BLOCK_COMPRESSED_TREND: true,
    ONE_DTE_MAX_DANGER_TO_ALLOW: 90,
    DANGER_STACK_NO_TRADE_SCORE: 95,
    LEVEL_ACCEPTANCE_RETEST_REQUIRED: false,
  });
  try {
    const candles = makeCandlesAroundLevel({
      level: 100,
      side: "BUY",
      mode: "REJECT",
      count: 16,
    });
    const score = __debug.buildScoreBreakdown(
      {
        strategyId: "breakout",
        strategyStyle: "TREND",
        strategyFamily: "BREAKOUT",
        side: "BUY",
        confidence: 86,
        dteDays: 0.6,
        meta: { triggerLevel: 100, rangeHigh: 100 },
      },
      {
        instrument_token: 904,
        intervalMin: 1,
        candles,
        last: candles[candles.length - 1],
        regime: "BREAKOUT_WATCH",
        regimeMeta: {
          primaryRegime: "BREAKOUT_WATCH",
          secondaryRegime: "TREND_COMPRESSED",
          regimeWeights: { BREAKOUT_WATCH: 0.58, TREND_COMPRESSED: 0.22 },
        },
      },
    );
    assert.equal(score.oneDteHardened, true);
    assert.equal(score.blockedByOneDteGate, true);
    assert.equal(score.finalDecision, "BLOCK");
  } finally {
    restore();
  }
}

function testOneDteCleanTrendCanPass() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1,3,5",
    ONE_DTE_HARDENING_ENABLED: true,
    ONE_DTE_BLOCK_BREAKOUT_WATCH_TREND: true,
    ONE_DTE_BLOCK_COMPRESSED_TREND: true,
  });
  try {
    const candles = makeStrongTrendCandles({ start: 100, drift: 0.35, count: 44 });
    const score = __debug.buildScoreBreakdown(
      {
        strategyId: "vwap_reclaim",
        strategyStyle: "TREND",
        strategyFamily: "VWAP",
        side: "BUY",
        confidence: 90,
        dteDays: 0.8,
        meta: {
          triggerLevel: candles[candles.length - 1].close - 1.2,
          anchorValue: candles[candles.length - 1].close - 1.2,
        },
      },
      {
        instrument_token: 905,
        intervalMin: 1,
        candles,
        last: candles[candles.length - 1],
        regime: "TREND",
        regimeMeta: {
          primaryRegime: "TREND",
          regimeWeights: { TREND: 0.72, OPEN: 0.1, TREND_COMPRESSED: 0.08 },
          directionalPersistence: 0.82,
        },
      },
    );
    assert.equal(score.blockedByOneDteGate, false);
    assert.equal(score.finalDecision, "ALLOW");
  } finally {
    restore();
  }
}

function testDangerStackRaisesThresholds() {
  const { resolveAdaptiveThresholds } = require(PATHS.dangerStack);
  const low = resolveAdaptiveThresholds({
    baseMinConfidence: 70,
    baseMinMtfAgreement: 50,
    baseMinAdmissionScore: 71,
    marketState: "CLEAN_TREND",
    dangerStackScore: 10,
    dteDays: 3,
    env: {},
  });
  const high = resolveAdaptiveThresholds({
    baseMinConfidence: 70,
    baseMinMtfAgreement: 50,
    baseMinAdmissionScore: 71,
    marketState: "FAILED_BREAKOUT",
    dangerStackScore: 84,
    dteDays: 0.8,
    levelAcceptance: { repeatedRejectionDetected: true, breakoutRejected: true },
    mtf: { mtfBias: "NEUTRAL", mtfAgreementScore: 54, mtfMissingIntervals: [3], mtfStaleIntervals: [5] },
    optionFragilityScore: 78,
    env: {},
  });
  assert.ok(high.resolvedMinConfidence > low.resolvedMinConfidence);
  assert.ok(high.resolvedMinMtfAgreement > low.resolvedMinMtfAgreement);
}

function testRetryGovernorBlocksRepeatedSameThesis() {
  const { evaluateRetryGovernor, resetRetryGovernor } = require(PATHS.retryGovernor);
  resetRetryGovernor();
  const baseArgs = {
    candidate: {
      strategyId: "breakout",
      strategyStyle: "TREND",
      strategyFamily: "BREAKOUT",
      side: "BUY",
      meta: { triggerLevel: 100, atr: 1.2 },
    },
    context: { instrument_token: 906, intervalMin: 1 },
    levelAcceptance: {
      nearestKeyLevel: 100,
      breakoutRejected: true,
      repeatedRejectionDetected: true,
      acceptanceMeta: { atrValue: 1.2 },
    },
    marketState: "TREND_COMPRESSED",
    env: {
      THESIS_RETRY_GOVERNOR_ENABLED: true,
      THESIS_RETRY_LOOKBACK_MIN: 30,
      THESIS_RETRY_MAX_FAILURES: 2,
      THESIS_RETRY_ZONE_ATR: 0.35,
      THESIS_RETRY_BLOCK_MINUTES: 12,
    },
  };
  evaluateRetryGovernor({ ...baseArgs, nowTs: Date.parse("2026-01-01T09:20:00+05:30") });
  const second = evaluateRetryGovernor({
    ...baseArgs,
    nowTs: Date.parse("2026-01-01T09:22:00+05:30"),
  });
  assert.equal(second.blocked, true);
  assert.equal(second.reasonCode, "RETRY_GOVERNOR_BLOCK");
}

function testCleanTrendAllowsValidTrendEntries() {
  const { env } = require(PATHS.config);
  const { __debug } = require(PATHS.signalControls);
  const restore = patchObject(env, {
    SIGNAL_INTERVALS: "1,3,5",
    ONE_DTE_HARDENING_ENABLED: true,
  });
  try {
    const candles = makeStrongTrendCandles({ start: 100, drift: 0.31, count: 50 });
    const out = __debug.buildScoreBreakdown(
      {
        strategyId: "ema_pullback",
        strategyStyle: "TREND",
        strategyFamily: "TREND",
        side: "BUY",
        confidence: 89,
        dteDays: 3,
        meta: { triggerLevel: candles[candles.length - 1].close - 0.18 },
      },
      {
        instrument_token: 907,
        intervalMin: 1,
        candles,
        last: candles[candles.length - 1],
        regime: "TREND",
        regimeMeta: {
          primaryRegime: "TREND",
          regimeWeights: { TREND: 0.78, OPEN: 0.08 },
          directionalPersistence: 0.84,
        },
      },
    );
    assert.equal(out.finalDecision, "ALLOW");
    assert.equal(out.blockedByMarketState, false);
  } finally {
    restore();
  }
}

function testBackwardCompatibleOutputShape() {
  const { decorateSignalCandidate, __debug } = require(PATHS.signalControls);
  __debug.resetRetryGovernor();
  const candles = makeStrongTrendCandles({ start: 100, drift: 0.22, count: 35 });
  const candidate = decorateSignalCandidate(
    {
      strategyId: "ema_pullback",
      strategyStyle: "TREND",
      strategyFamily: "TREND",
      side: "BUY",
      confidence: 83,
      meta: { triggerLevel: candles[candles.length - 1].close - 0.2 },
    },
    {
      instrument_token: 908,
      intervalMin: 1,
      candles,
      last: candles[candles.length - 1],
      regime: "TREND",
      regimeMeta: { primaryRegime: "TREND", regimeWeights: { TREND: 0.75 } },
    },
  );
  assert.ok(Object.prototype.hasOwnProperty.call(candidate, "rawConfidence"));
  assert.ok(Object.prototype.hasOwnProperty.call(candidate, "normalizedConfidence"));
  assert.ok(Object.prototype.hasOwnProperty.call(candidate, "finalSignalScore"));
  assert.ok(Object.prototype.hasOwnProperty.call(candidate, "scoreBreakdown"));
  assert.ok(Object.prototype.hasOwnProperty.call(candidate, "meta"));
  assert.equal(candidate.strategyId, "ema_pullback");
}

function main() {
  testEmaCrossNoLongerAlwaysOnByDefault();
  testBreakoutWatchNoEarlyCollapse();
  testTrendCompressedUsesConservativeBucket();
  testRsiFadeNotSelectedInTrendCompressedByDefault();
  testFailedBreakoutStateFromRepeatedRejection();
  testTrapRiskStateFromDangerStack();
  testNoTradeStateDeterministic();
  testTouchOnlyBreakoutNotAccepted();
  testCloseHoldBreakoutAccepted();
  testRepeatedResistanceRejectionBlocksLongContinuation();
  testRepeatedSupportRejectionBlocksShortContinuation();
  testCompressedStateMtfIsStricter();
  testOneDteUglyStateBlocksFragileContinuation();
  testOneDteCleanTrendCanPass();
  testDangerStackRaisesThresholds();
  testRetryGovernorBlocksRepeatedSameThesis();
  testCleanTrendAllowsValidTrendEntries();
  testBackwardCompatibleOutputShape();
  console.log("adaptiveMarketLayer.test.js passed");
}

main();
