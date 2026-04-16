const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const {
  BASE_NOW,
  makeTrade,
  makeEnv,
  flatCandles,
  applyPlanPatch,
} = require("./_helpers");

function isolatedEarlyWinnerEnv(overrides = {}) {
  return makeEnv({
    MIN_GREEN_ENABLED: "true",
    BE_ARM_R: 0.4,
    BE_ARM_COST_MULT: 0,
    TRAIL_ARM_R: 99,
    GREEN_LOCK_ENABLED: "false",
    MFE_LOCK_LADDER_ENABLED: "false",
    EXIT_TIGHTEN_AT_R: 99,
    PROFIT_LOCK_ENABLED: "false",
    DYN_STEP_TICKS_PRE_BE: 1,
    DYN_STEP_TICKS_POST_BE: 1,
    DYN_BE_COST_MULT: 0,
    EARLY_WINNER_RETENTION_ENABLED: "true",
    EARLY_WINNER_ARM_R: 0.4,
    EARLY_WINNER_CONFIRM_TICKS: 2,
    EARLY_WINNER_CONFIRM_MS: 3000,
    EARLY_WINNER_MIN_KEEP_R: 0.08,
    EARLY_WINNER_MAX_KEEP_R: 0.22,
    EARLY_WINNER_TIER_1_R: 0.5,
    EARLY_WINNER_TIER_1_KEEP_R: 0.12,
    EARLY_WINNER_TIER_2_R: 0.65,
    EARLY_WINNER_TIER_2_KEEP_R: 0.2,
    EARLY_WINNER_TIER_3_R: 0.8,
    EARLY_WINNER_TIER_3_KEEP_R: 0.3,
    EARLY_WINNER_TO_TRAIL_MIN_R: 0.75,
    EARLY_WINNER_TO_TRAIL_REQUIRE_HEALTH: "true",
    EARLY_WINNER_MIN_HOLD_MS: 5000,
    ...overrides,
  });
}

function optionInstrument() {
  return {
    tick_size: 0.05,
    segment: "NFO-OPT",
    tradingsymbol: "NIFTY26JAN20000CE",
    exchange: "NFO",
  };
}

function structuredOptionTrade(overrides = {}) {
  return makeTrade({
    instrument: optionInstrument(),
    underlying_ltp: 20000,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
    minGreenInr: 0,
    minGreenPts: 0,
    beLocked: true,
    beAppliedAt: new Date(BASE_NOW + 2_000).toISOString(),
    beAppliedStopLoss: 100.05,
    stopLoss: 100.05,
    brokerStopLoss: 100.05,
    planMeta: {
      underlying: { entry: 20000, stop: 19980, target: 20050, R: 20 },
      vwap: 20022,
      orb: { high: 20020, low: 19992 },
      prevDay: {
        PDH: 20018,
        PDL: 19970,
        pivots: { P: 19994, R1: 20016, S1: 19982, R2: 20028, S2: 19968 },
      },
      option: { absDelta: 0.5, gamma: 0 },
    },
    ...overrides,
  });
}

function desiredFloor(plan) {
  return Number(plan?.meta?.desiredStopLoss ?? plan?.finalStop ?? 0) || 0;
}

function runPlan({
  trade,
  ltp,
  nowTs,
  env,
  marketQuote,
  underlyingLtp,
  candles = flatCandles(),
}) {
  const plan = computeDynamicExitPlan({
    trade,
    ltp,
    candles,
    nowTs,
    env,
    marketQuote,
    underlyingLtp,
  });
  assert.equal(plan.ok, true);
  return plan;
}

const firstTouchEnv = isolatedEarlyWinnerEnv({
  EARLY_WINNER_CONFIRM_TICKS: 3,
  EARLY_WINNER_CONFIRM_MS: 5000,
});

const firstTouch = runPlan({
  trade: makeTrade({ minGreenInr: 0, minGreenPts: 0 }),
  ltp: 104.55,
  nowTs: BASE_NOW + 1_000,
  env: firstTouchEnv,
});

assert.equal(Boolean(firstTouch.meta?.beArmed), true);
assert.equal(Boolean(firstTouch.meta?.earlyWinnerConfirmed), false);
assert.equal(firstTouch.meta?.earlyWinnerFloor ?? null, null);
assert.equal(Boolean(firstTouch.meta?.beProfitLockDeferredToEarlyWinner), true);
assert.notEqual(firstTouch.meta?.protectedStopSource, "BE_PROFIT_LOCK");
assert.ok(
  ["TRUE_BE", "MIN_GREEN"].includes(
    String(firstTouch.meta?.protectedStopSource || ""),
  ),
);

let retentionTrade = makeTrade({ minGreenInr: 0, minGreenPts: 0 });
const retentionArm = runPlan({
  trade: retentionTrade,
  ltp: 104.45,
  nowTs: BASE_NOW + 1_000,
  env: isolatedEarlyWinnerEnv(),
});
retentionTrade = applyPlanPatch(retentionTrade, retentionArm);
const retentionConfirmed = runPlan({
  trade: retentionTrade,
  ltp: 104.8,
  nowTs: BASE_NOW + 4_500,
  env: isolatedEarlyWinnerEnv(),
});

assert.equal(Boolean(retentionConfirmed.meta?.earlyWinnerConfirmed), true);
assert.equal(
  retentionConfirmed.meta?.protectionPhase,
  "PHASE_2_EARLY_WINNER_RETENTION",
);
assert.equal(
  retentionConfirmed.meta?.arbitrationWinner,
  "EARLY_WINNER_RETENTION",
);
assert.ok(
  Number(retentionConfirmed.meta?.earlyWinnerFloor ?? 0) >
    Number(retentionConfirmed.meta?.beFloor ?? 0),
);
assert.ok(
  Number(retentionConfirmed.meta?.earlyWinnerFloor ?? 0) <
    Number(retentionConfirmed.meta?.beProfitLockFloor ?? 0),
);

const structureContribution = runPlan({
  trade: structuredOptionTrade(),
  ltp: 106.4,
  marketQuote: {
    bid: 106.3,
    ask: 106.5,
    ltp: 106.4,
    timestampMs: BASE_NOW + 8_000,
  },
  underlyingLtp: 20024,
  nowTs: BASE_NOW + 8_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "false",
    EARLY_WINNER_TO_TRAIL_MIN_R: 0.95,
  }),
});

assert.equal(Boolean(structureContribution.meta?.structureCandidateAvailable), true);
assert.equal(
  structureContribution.meta?.structureReferenceType,
  "VWAP",
);
assert.ok(
  Number(structureContribution.meta?.structureMappedFloor ?? 0) >
    Number(structureContribution.meta?.earlyWinnerFloor ?? 0),
);
assert.equal(
  structureContribution.meta?.arbitrationWinner,
  "EARLY_WINNER_STRUCTURE",
);

const structureFallback = runPlan({
  trade: structuredOptionTrade(),
  ltp: 106.4,
  marketQuote: {
    bid: 106.3,
    ask: 106.5,
    ltp: 106.4,
    timestampMs: BASE_NOW - 20_000,
  },
  underlyingLtp: 20024,
  nowTs: BASE_NOW + 8_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "false",
    EARLY_WINNER_TO_TRAIL_MIN_R: 0.95,
    EARLY_WINNER_STRUCTURE_REQUIRE_FRESH: "true",
  }),
});

assert.equal(Boolean(structureFallback.meta?.structureCandidateAvailable), false);
assert.equal(Boolean(structureFallback.meta?.structureFallbackUsed), true);
assert.equal(
  structureFallback.meta?.structureCandidateReason,
  "QUOTE_STALE",
);
assert.notEqual(
  structureFallback.meta?.arbitrationWinner,
  "EARLY_WINNER_STRUCTURE",
);

let ladderTrade = makeTrade({ minGreenInr: 0, minGreenPts: 0 });
let previousEarlyFloor = 0;
for (const [idx, step] of [
  { ltp: 104.8, tier: 0 },
  { ltp: 105.2, tier: 1 },
  { ltp: 106.6, tier: 2 },
  { ltp: 108.2, tier: 3 },
  { ltp: 106.0, tier: 3 },
].entries()) {
  const plan = runPlan({
    trade: ladderTrade,
    ltp: step.ltp,
    nowTs: BASE_NOW + (idx + 1) * 6_000,
    env: isolatedEarlyWinnerEnv({
      EARLY_WINNER_CONFIRM_TICKS: 1,
      EARLY_WINNER_CONFIRM_MS: 0,
    }),
  });
  assert.equal(Number(plan.meta?.earlyWinnerTier ?? 0), step.tier);
  if (Number(plan.meta?.earlyWinnerFloor ?? 0) > 0) {
    assert.ok(Number(plan.meta?.earlyWinnerFloor ?? 0) >= previousEarlyFloor);
    previousEarlyFloor = Number(plan.meta?.earlyWinnerFloor ?? 0);
  }
  ladderTrade = applyPlanPatch(ladderTrade, plan);
}

const handoff = runPlan({
  trade: makeTrade({
    minGreenInr: 0,
    minGreenPts: 0,
    beLocked: true,
    beAppliedAt: new Date(BASE_NOW + 2_000).toISOString(),
    beAppliedStopLoss: 100.05,
    stopLoss: 100.05,
    brokerStopLoss: 100.05,
  }),
  ltp: 108.5,
  nowTs: BASE_NOW + 12_000,
  env: isolatedEarlyWinnerEnv({
    TRAIL_GAP_POST_BE_PCT: 0.02,
    TRAIL_GAP_MIN_PTS: 1,
    DYN_STEP_TICKS_POST_BE: 1,
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
  }),
});

assert.equal(Boolean(handoff.meta?.earlyWinnerHandoffReady), true);
assert.equal(handoff.meta?.protectionPhase, "PHASE_4_MATURE_WINNER");
assert.ok(
  ["TRAIL", "STRUCTURE_TRAIL"].includes(
    String(handoff.meta?.arbitrationWinner || ""),
  ),
);
assert.equal(
  handoff.meta?.arbitrationWinner,
  handoff.meta?.protectedStopSource,
);

const dynamicEarlyHandoff = runPlan({
  trade: structuredOptionTrade(),
  ltp: 106.85,
  marketQuote: {
    bid: 106.75,
    ask: 106.9,
    ltp: 106.85,
    timestampMs: BASE_NOW + 12_000,
  },
  underlyingLtp: 20024,
  nowTs: BASE_NOW + 12_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "true",
    EARLY_WINNER_DYNAMIC_HANDOFF_MIN_R: 0.6,
    EARLY_WINNER_DYNAMIC_HANDOFF_MAX_R: 0.85,
    EARLY_WINNER_HANDOFF_REQUIRE_STRUCTURE_BONUS: "true",
    TRAIL_GAP_POST_BE_PCT: 0.02,
    TRAIL_GAP_MIN_PTS: 1,
    DYN_STEP_TICKS_POST_BE: 1,
  }),
});

assert.ok(Number(dynamicEarlyHandoff.meta?.dynamicTrailArmR ?? 0) < 0.75);
assert.equal(Boolean(dynamicEarlyHandoff.meta?.earlyWinnerHandoffReady), true);
assert.equal(
  dynamicEarlyHandoff.meta?.handoffAdvanceReason,
  "QUALITY_AND_STRUCTURE_CONFIRMED",
);

const dynamicLateHandoff = runPlan({
  trade: structuredOptionTrade(),
  ltp: 106.75,
  marketQuote: {
    bid: 102.5,
    ask: 107.2,
    ltp: 106.75,
    timestampMs: BASE_NOW + 12_000,
  },
  underlyingLtp: 20005,
  nowTs: BASE_NOW + 12_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "true",
    EARLY_WINNER_DYNAMIC_HANDOFF_MIN_R: 0.6,
    EARLY_WINNER_DYNAMIC_HANDOFF_MAX_R: 0.85,
    EARLY_WINNER_HANDOFF_REQUIRE_STRUCTURE_BONUS: "true",
    TRAIL_GAP_POST_BE_PCT: 0.02,
    TRAIL_GAP_MIN_PTS: 1,
    DYN_STEP_TICKS_POST_BE: 1,
  }),
});

assert.ok(Number(dynamicLateHandoff.meta?.dynamicTrailArmR ?? 0) >= 0.75);
assert.equal(Boolean(dynamicLateHandoff.meta?.earlyWinnerHandoffReady), false);
assert.ok(
  [
    "WAITING_CONFIRMATION",
    "STRUCTURE_BONUS_REQUIRED",
    "QUOTE_QUALITY_NOT_CLEAN",
    "BELOW_DYNAMIC_HANDOFF_R",
  ].includes(String(dynamicLateHandoff.meta?.handoffDeferredReason || "")),
);
assert.notEqual(dynamicLateHandoff.meta?.arbitrationWinner, "TRAIL");

let hysteresisTrade = structuredOptionTrade();
const hysteresisReady = runPlan({
  trade: hysteresisTrade,
  ltp: 106.85,
  marketQuote: {
    bid: 106.75,
    ask: 106.9,
    ltp: 106.85,
    timestampMs: BASE_NOW + 12_000,
  },
  underlyingLtp: 20024,
  nowTs: BASE_NOW + 12_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "true",
    EARLY_WINNER_DYNAMIC_HANDOFF_MIN_R: 0.6,
    EARLY_WINNER_DYNAMIC_HANDOFF_MAX_R: 0.85,
    EARLY_WINNER_HANDOFF_REQUIRE_STRUCTURE_BONUS: "true",
    TRAIL_GAP_POST_BE_PCT: 0.02,
    TRAIL_GAP_MIN_PTS: 1,
    DYN_STEP_TICKS_POST_BE: 1,
  }),
});
hysteresisTrade = applyPlanPatch(hysteresisTrade, hysteresisReady);
const hysteresisHold = runPlan({
  trade: hysteresisTrade,
  ltp: 106.45,
  marketQuote: {
    bid: 106.35,
    ask: 106.55,
    ltp: 106.45,
    timestampMs: BASE_NOW + 15_000,
  },
  underlyingLtp: 20023,
  nowTs: BASE_NOW + 15_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED: "true",
    EARLY_WINNER_DYNAMIC_HANDOFF_MIN_R: 0.6,
    EARLY_WINNER_DYNAMIC_HANDOFF_MAX_R: 0.85,
    EARLY_WINNER_HANDOFF_REQUIRE_STRUCTURE_BONUS: "true",
    TRAIL_GAP_POST_BE_PCT: 0.02,
    TRAIL_GAP_MIN_PTS: 1,
    DYN_STEP_TICKS_POST_BE: 1,
  }),
});

assert.equal(Boolean(hysteresisReady.meta?.earlyWinnerHandoffReady), true);
assert.equal(Boolean(hysteresisHold.meta?.earlyWinnerHandoffReady), true);
assert.equal(Boolean(hysteresisHold.meta?.handoffStateStable), true);

let neverLoosenTrade = makeTrade({ minGreenInr: 0, minGreenPts: 0 });
let previousDesired = 0;
for (const [idx, ltp] of [104.8, 106.6, 106.0, 108.2, 107.0].entries()) {
  const plan = runPlan({
    trade: neverLoosenTrade,
    ltp,
    nowTs: BASE_NOW + (idx + 1) * 6_000,
    env: isolatedEarlyWinnerEnv({
      EARLY_WINNER_CONFIRM_TICKS: 1,
      EARLY_WINNER_CONFIRM_MS: 0,
    }),
  });
  const nextDesired = desiredFloor(plan);
  assert.ok(nextDesired >= previousDesired);
  previousDesired = nextDesired;
  neverLoosenTrade = applyPlanPatch(neverLoosenTrade, plan);
}

const noisyQuotePlan = runPlan({
  trade: makeTrade({
    instrument: optionInstrument(),
    minGreenInr: 0,
    minGreenPts: 0,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
  }),
  ltp: 105.4,
  marketQuote: {
    ltp: 105.4,
    timestampMs: BASE_NOW + 10 * 60_000,
  },
  underlyingLtp: 20120,
  nowTs: BASE_NOW + 10 * 60_000 + 500,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
  }),
});

assert.equal(Boolean(noisyQuotePlan.meta?.earlyWinnerConfirmed), true);
assert.equal(Boolean(noisyQuotePlan.meta?.earlyWinnerActive), false);
assert.equal(
  noisyQuotePlan.meta?.rejectedFloorReasons?.MFE_LOCK_TIER_1,
  "UNSAFE_QUOTE_QUALITY",
);
assert.notEqual(noisyQuotePlan.meta?.arbitrationWinner, "MFE_LOCK_TIER_1");

const featureFlagLegacy = runPlan({
  trade: makeTrade({ minGreenInr: 0, minGreenPts: 0 }),
  ltp: 104.55,
  nowTs: BASE_NOW + 1_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_RETENTION_ENABLED: "false",
  }),
});

assert.equal(Boolean(featureFlagLegacy.meta?.earlyWinnerConfirmed), false);
assert.equal(Boolean(featureFlagLegacy.meta?.beProfitLockDeferredToEarlyWinner), false);
assert.equal(featureFlagLegacy.meta?.protectedStopSource, "BE_PROFIT_LOCK");

assert.equal(Boolean(retentionConfirmed.meta?.earlyWinnerStructureEnabled), true);
assert.equal(Boolean(retentionConfirmed.meta?.structureCandidateAvailable), false);
assert.equal(
  typeof retentionConfirmed.meta?.earlyWinnerStructureStatus,
  "string",
);
assert.equal(
  retentionConfirmed.meta?.arbitrationWinner,
  "EARLY_WINNER_RETENTION",
);

let throttleTrade = makeTrade({ minGreenInr: 0, minGreenPts: 0 });
const throttleSeed = runPlan({
  trade: throttleTrade,
  ltp: 104.8,
  nowTs: BASE_NOW + 6_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    DYN_STEP_TICKS_POST_BE: 6,
  }),
});
throttleTrade = applyPlanPatch(throttleTrade, throttleSeed);
const throttled = runPlan({
  trade: throttleTrade,
  ltp: 104.85,
  nowTs: BASE_NOW + 7_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 1,
    EARLY_WINNER_CONFIRM_MS: 0,
    DYN_STEP_TICKS_POST_BE: 6,
  }),
});

assert.equal(throttled.sl, null);
assert.ok(desiredFloor(throttled) >= desiredFloor(throttleSeed));

let replayTrade = makeTrade({ minGreenInr: 0, minGreenPts: 0 });
const replayFirstTouch = runPlan({
  trade: replayTrade,
  ltp: 104.45,
  nowTs: BASE_NOW + 1_000,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 3,
    EARLY_WINNER_CONFIRM_MS: 5000,
  }),
});
replayTrade = applyPlanPatch(replayTrade, replayFirstTouch);
const replayPullback = runPlan({
  trade: replayTrade,
  ltp: 103.95,
  nowTs: BASE_NOW + 2_500,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 3,
    EARLY_WINNER_CONFIRM_MS: 5000,
  }),
});
replayTrade = applyPlanPatch(replayTrade, replayPullback);
const replayResume = runPlan({
  trade: replayTrade,
  ltp: 106.8,
  nowTs: BASE_NOW + 7_500,
  env: isolatedEarlyWinnerEnv({
    EARLY_WINNER_CONFIRM_TICKS: 3,
    EARLY_WINNER_CONFIRM_MS: 5000,
  }),
});

assert.notEqual(replayFirstTouch.meta?.protectedStopSource, "BE_PROFIT_LOCK");
assert.ok(
  Number(replayFirstTouch.meta?.beFloor ?? 0) <
    Number(replayFirstTouch.meta?.beProfitLockFloor ?? 0),
);
assert.equal(Boolean(replayPullback.meta?.earlyWinnerConfirmed), false);
assert.ok(
  desiredFloor(replayPullback) <
    Number(replayPullback.meta?.beProfitLockFloor ?? 0),
);
assert.ok(Number(replayResume.meta?.earlyWinnerTier ?? 0) >= 2);
assert.ok(desiredFloor(replayResume) > desiredFloor(replayPullback));
assert.ok(Array.isArray(replayResume.meta?.candidateFloors));
assert.equal(
  typeof replayResume.meta?.rejectedFloorReasons,
  "object",
);

console.log("earlyWinnerRetention.test.js passed");
