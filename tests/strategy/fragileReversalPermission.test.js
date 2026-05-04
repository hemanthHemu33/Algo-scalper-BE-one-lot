const assert = require("node:assert/strict");

const {
  isStrategyStyleAllowedForRegime,
  resolveFragileReversalPermission,
} = require("../../src/strategy/signalLifecycle");

const strictEnv = {
  RANGE_ALLOWED_REGIMES: "RANGE,OPEN",
  TREND_ALLOWED_REGIMES: "TREND,OPEN",
  OPEN_ALLOWED_REGIMES: "OPEN,TREND",
  FRAGILE_REVERSAL_EXCEPTION_ENABLED: true,
  FRAGILE_REVERSAL_TREND_COMPRESSED_STRATEGIES: "wick_reversal",
  FRAGILE_REVERSAL_BREAKOUT_WATCH_STRATEGIES: "wick_reversal",
  FRAGILE_REVERSAL_FAILED_BREAKOUT_STRATEGIES: "fakeout,wick_reversal",
  FRAGILE_REVERSAL_ALLOW_RSI_FADE: false,
  FRAGILE_REVERSAL_MIN_CONFIDENCE: 80,
  FRAGILE_REVERSAL_MIN_MTF_SCORE: 55,
  FRAGILE_REVERSAL_BLOCK_ON_MTF_DISAGREEMENT: true,
  FRAGILE_REVERSAL_REQUIRE_LEVEL_REJECTION: true,
  FRAGILE_REVERSAL_REQUIRE_SESSION_EXTREME: true,
  FRAGILE_REVERSAL_REQUIRE_DANGER_BELOW: 62,
  FRAGILE_REVERSAL_ONE_DTE_MIN_CONFIDENCE: 86,
  FRAGILE_REVERSAL_ONE_DTE_MAX_DANGER: 45,
  LEVEL_REJECTION_MIN_COUNT: 2,
};

function confirmedWickArgs(overrides = {}) {
  return {
    strategyId: "wick_reversal",
    strategyStyle: "RANGE",
    regime: "TREND_COMPRESSED",
    marketState: "TREND_COMPRESSED",
    confidence: 88,
    dteDays: 2,
    mtf: {
      mtfState: "ALIGNED",
      mtfAgreementScore: 68,
    },
    levelAcceptance: {
      repeatedRejectionDetected: true,
      breakoutRejected: false,
      rejectionCount: 2,
      keyLevelType: "SUPPORT",
      acceptanceMeta: {
        nearEnough: true,
        maxDistanceAtr: 0.8,
      },
    },
    dangerStack: {
      dangerStackScore: 34,
    },
    candidate: {
      strategyId: "wick_reversal",
      strategyStyle: "RANGE",
      rawConfidence: 88,
      meta: {
        triggerLevel: 100,
        reversalZone: "SESSION_LOW_EXHAUSTION",
      },
    },
    env: strictEnv,
    ...overrides,
  };
}

function testRsiFadeBlockedByDefaultInTrendCompressed() {
  const out = isStrategyStyleAllowedForRegime({
    strategyStyle: "RANGE",
    strategyId: "rsi_fade",
    regime: "TREND_COMPRESSED",
    marketState: "TREND_COMPRESSED",
    confidence: 90,
    mtf: { mtfState: "ALIGNED", mtfAgreementScore: 70 },
    levelAcceptance: {
      repeatedRejectionDetected: true,
      keyLevelType: "SUPPORT",
      acceptanceMeta: { nearEnough: true },
    },
    dangerStack: { dangerStackScore: 20 },
    env: strictEnv,
  });

  assert.equal(out.allowed, false);
  assert.equal(out.exceptionChecked, true);
  assert.equal(out.exceptionReasonCode, "FRAGILE_REVERSAL_STRATEGY_NOT_ALLOWED");
}

function testWickFailsClosedWhenContextMissing() {
  const out = isStrategyStyleAllowedForRegime({
    strategyStyle: "RANGE",
    strategyId: "wick_reversal",
    regime: "TREND_COMPRESSED",
    marketState: "TREND_COMPRESSED",
    confidence: 88,
    env: strictEnv,
  });

  assert.equal(out.allowed, false);
  assert.equal(out.exceptionReasonCode, "FRAGILE_REVERSAL_CONTEXT_MISSING");
  assert.ok(out.exceptionMeta.failedChecks.includes("CONTEXT_MISSING"));
}

function testWickFailsOnMtfDisagreement() {
  const out = isStrategyStyleAllowedForRegime(
    confirmedWickArgs({
      mtf: {
        mtfState: "DISAGREEMENT",
        mtfAgreementScore: 72,
      },
    }),
  );

  assert.equal(out.allowed, false);
  assert.equal(out.exceptionReasonCode, "FRAGILE_REVERSAL_MTF_DISAGREEMENT");
  assert.ok(out.exceptionMeta.failedChecks.includes("MTF_NOT_DISAGREEMENT"));
}

function testWickPassesOnlyWithStrictConfirmation() {
  const out = isStrategyStyleAllowedForRegime(confirmedWickArgs());

  assert.equal(out.allowed, true);
  assert.equal(out.allowedByException, true);
  assert.equal(out.exceptionType, "FRAGILE_REVERSAL");
  assert.equal(out.exceptionReasonCode, "FRAGILE_REVERSAL_CONFIRMED");
  assert.equal(out.exceptionMeta.allowed, true);
}

function testOneDteStricterConfidenceAndDanger() {
  const lowConfidence = isStrategyStyleAllowedForRegime(
    confirmedWickArgs({
      confidence: 82,
      dteDays: 1,
      candidate: {
        strategyId: "wick_reversal",
        strategyStyle: "RANGE",
        rawConfidence: 82,
        meta: { reversalZone: "SESSION_LOW_EXHAUSTION" },
      },
    }),
  );
  assert.equal(lowConfidence.allowed, false);
  assert.equal(
    lowConfidence.exceptionReasonCode,
    "FRAGILE_REVERSAL_ONE_DTE_LOW_CONFIDENCE",
  );

  const highDanger = isStrategyStyleAllowedForRegime(
    confirmedWickArgs({
      confidence: 88,
      dteDays: 1,
      dangerStack: { dangerStackScore: 60 },
    }),
  );
  assert.equal(highDanger.allowed, false);
  assert.equal(
    highDanger.exceptionReasonCode,
    "FRAGILE_REVERSAL_ONE_DTE_DANGER_TOO_HIGH",
  );

  const pass = isStrategyStyleAllowedForRegime(
    confirmedWickArgs({
      confidence: 88,
      dteDays: 1,
      dangerStack: { dangerStackScore: 34 },
    }),
  );
  assert.equal(pass.allowed, true);
}

function testNormalRangeAndTrendStillPassNormally() {
  const range = isStrategyStyleAllowedForRegime({
    strategyStyle: "RANGE",
    strategyId: "rsi_fade",
    regime: "RANGE",
    env: strictEnv,
  });
  assert.equal(range.allowed, true);
  assert.equal(range.allowedByException, false);

  const trend = isStrategyStyleAllowedForRegime({
    strategyStyle: "TREND",
    strategyId: "ema_pullback",
    regime: "TREND",
    env: strictEnv,
  });
  assert.equal(trend.allowed, true);
  assert.equal(trend.allowedByException, false);
}

function testFakeoutRequiresFailedBreakoutRejection() {
  const out = resolveFragileReversalPermission({
    strategyId: "fakeout",
    strategyStyle: "RANGE",
    regime: "FAILED_BREAKOUT",
    marketState: "FAILED_BREAKOUT",
    confidence: 86,
    dteDays: 2,
    mtf: { mtfState: "ALIGNED", mtfAgreementScore: 66 },
    levelAcceptance: {
      breakoutRejected: true,
      repeatedRejectionDetected: false,
      keyLevelType: "RESISTANCE",
      acceptanceMeta: { nearEnough: true },
    },
    dangerStack: { dangerStackScore: 40 },
    candidate: {
      strategyId: "fakeout",
      strategyStyle: "RANGE",
      rawConfidence: 86,
      meta: { triggerLevel: 100, reversalZone: "SESSION_HIGH_EXHAUSTION" },
    },
    env: strictEnv,
  });

  assert.equal(out.allowed, true);
  assert.equal(out.reasonCode, "FRAGILE_REVERSAL_CONFIRMED");
}

function main() {
  testRsiFadeBlockedByDefaultInTrendCompressed();
  testWickFailsClosedWhenContextMissing();
  testWickFailsOnMtfDisagreement();
  testWickPassesOnlyWithStrictConfirmation();
  testOneDteStricterConfidenceAndDanger();
  testNormalRangeAndTrendStillPassNormally();
  testFakeoutRequiresFailedBreakoutRejection();
  console.log("fragileReversalPermission.test.js passed");
}

main();
