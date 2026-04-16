const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const {
  BASE_NOW,
  applyPlanPatch,
  flatCandles,
  makeEnv,
  makeTrade,
} = require("./_helpers");

function loserEnv(overrides = {}) {
  return makeEnv({
    MIN_GREEN_ENABLED: "true",
    BE_ARM_R: 99,
    BE_ARM_COST_MULT: 0,
    TRAIL_ARM_R: 99,
    GREEN_LOCK_ENABLED: "false",
    MFE_LOCK_LADDER_ENABLED: "false",
    PROFIT_LOCK_ENABLED: "false",
    EARLY_WINNER_RETENTION_ENABLED: "true",
    DYNAMIC_EXIT_MIN_HOLD_MS: 0,
    TIME_STOP_MIN: 0,
    TIME_STOP_NO_PROGRESS_MIN: 0,
    TIME_STOP_MAX_HOLD_MIN: 0,
    ...overrides,
  });
}

const optionInstrument = {
  tick_size: 0.05,
  segment: "NFO-OPT",
  tradingsymbol: "NIFTY26JAN20000CE",
  exchange: "NFO",
};

function makeFailingBuyTrade(overrides = {}) {
  return makeTrade({
    instrument: optionInstrument,
    minGreenInr: 40,
    minGreenPts: 4,
    option_meta: { optType: "CE", underlyingLtp: 20000 },
    planMeta: { underlying: { entry: 20000, stop: 19950 } },
    ...overrides,
  });
}

function makeFailingSellTrade(overrides = {}) {
  return makeTrade({
    side: "SELL",
    minGreenInr: 40,
    minGreenPts: 4,
    entryPrice: 100,
    strategyStopLoss: 110,
    sizingStopLoss: 110,
    brokerStopLoss: 110,
    stopLoss: 110,
    initialStopLoss: 110,
    instrument: {
      ...optionInstrument,
      tradingsymbol: "NIFTY26JAN20000PE",
    },
    option_meta: { optType: "PE", underlyingLtp: 20000 },
    planMeta: { underlying: { entry: 20000, stop: 20050 } },
    ...overrides,
  });
}

function withFreshQuote(quote, nowTs) {
  return {
    ...quote,
    timestampMs: nowTs - 200,
  };
}

const winnerTrade = makeTrade({
  minGreenInr: 40,
  minGreenPts: 4,
  beLocked: true,
  stopLoss: 104.35,
  beAppliedAt: new Date(BASE_NOW + 60_000).toISOString(),
  beAppliedStopLoss: 104.35,
});

const winnerEnv = loserEnv({
  BE_ARM_R: 0.6,
  TRAIL_ARM_R: 2.5,
  GREEN_LOCK_ENABLED: "true",
  MFE_LOCK_LADDER_ENABLED: "true",
});

const winnerWithAlc = computeDynamicExitPlan({
  trade: winnerTrade,
  ltp: 114,
  candles: flatCandles(),
  nowTs: BASE_NOW + 4 * 60_000,
  env: winnerEnv,
});

const winnerWithoutAlc = computeDynamicExitPlan({
  trade: winnerTrade,
  ltp: 114,
  candles: flatCandles(),
  nowTs: BASE_NOW + 4 * 60_000,
  env: { ...winnerEnv, ADAPTIVE_LOSER_COMPRESSION_ENABLED: "false" },
});

assert.equal(winnerWithAlc.ok, true);
assert.equal(
  winnerWithAlc.meta?.protectedStopSource,
  winnerWithoutAlc.meta?.protectedStopSource,
);
assert.equal(
  Number(winnerWithAlc.meta?.finalStopLoss ?? 0),
  Number(winnerWithoutAlc.meta?.finalStopLoss ?? 0),
);
assert.equal(
  Boolean(winnerWithAlc.meta?.beApplied),
  Boolean(winnerWithoutAlc.meta?.beApplied),
);
assert.equal(
  Boolean(winnerWithAlc.meta?.trailActive),
  Boolean(winnerWithoutAlc.meta?.trailActive),
);
assert.equal(winnerWithAlc.meta?.loserCompressionAction, "HOLD");
assert.equal(
  winnerWithAlc.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_WINNER_MODE",
);

const l1Now = BASE_NOW + 60_000;
const failingL1Plan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade(),
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, l1Now),
  candles: flatCandles(),
  nowTs: l1Now,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(failingL1Plan.ok, true);
assert.equal(failingL1Plan.meta?.loserCompressionAction, "COMPRESS_L1");
assert.equal(failingL1Plan.meta?.loserCompressionDesiredAction, "COMPRESS_L1");
assert.equal(Boolean(failingL1Plan.meta?.loserCompressionActive), true);
assert.equal(failingL1Plan.meta?.protectedStopSource, "ALC_L1");
assert.equal(failingL1Plan.meta?.loserCompressionTargetState, "L1");
assert.equal(failingL1Plan.meta?.loserCompressionAppliedState, "NONE");
assert.equal(failingL1Plan.meta?.loserCompressionRequestReady, true);
assert.ok(Number(failingL1Plan.meta?.failureScore ?? 0) >= 70);
assert.ok(Number(failingL1Plan.sl?.stopLoss ?? 0) > 90);
assert.equal(Boolean(failingL1Plan.meta?.beApplied), false);
assert.equal(Boolean(failingL1Plan.meta?.trailActive), false);

const l1RequestedStop = Number(failingL1Plan.sl?.stopLoss ?? 0);
const l1PendingTrade = makeFailingBuyTrade({
  desiredStopLoss: l1RequestedStop,
  finalStopLoss: l1RequestedStop,
  protectedStopSource: "ALC_L1",
  loserCompressionDesiredAction: "COMPRESS_L1",
  loserCompressionTargetState: "L1",
  loserCompressionSubmittedState: "L1",
  loserCompressionAppliedState: "NONE",
  loserCompressionPendingAction: "STOP_MODIFY",
  loserCompressionPendingSince: new Date(l1Now).toISOString(),
  loserCompressionLastRequestedStop: l1RequestedStop,
  loserCompressionLastAttemptAt: new Date(l1Now).toISOString(),
  loserCompressionRetryCount: 1,
});

const l1PendingHoldPlan = computeDynamicExitPlan({
  trade: l1PendingTrade,
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, l1Now + 2_000),
  candles: flatCandles(),
  nowTs: l1Now + 2_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(l1PendingHoldPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  l1PendingHoldPlan.meta?.loserCompressionRequestBlockedReason,
  "ALC_BLOCKED_PENDING_MODIFY",
);
assert.equal(
  l1PendingHoldPlan.meta?.loserCompressionAppliedState,
  "NONE",
);

const l1RetryPlan = computeDynamicExitPlan({
  trade: {
    ...l1PendingTrade,
    loserCompressionPendingSince: new Date(l1Now - 9_000).toISOString(),
    loserCompressionLastAttemptAt: new Date(l1Now - 9_000).toISOString(),
  },
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, l1Now + 9_000),
  candles: flatCandles(),
  nowTs: l1Now + 9_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(l1RetryPlan.meta?.loserCompressionAction, "COMPRESS_L1");
assert.equal(l1RetryPlan.meta?.loserCompressionRequestOutcome, "ALC_RETRY_L1");

const l1ConfirmedPlan = computeDynamicExitPlan({
  trade: {
    ...l1PendingTrade,
    protectionUpgradePending: false,
    loserCompressionPendingAction: null,
    loserCompressionPendingSince: null,
    loserCompressionLastConfirmedStop: l1RequestedStop,
    loserCompressionAppliedSource: "ALC_L1",
    loserCompressionAppliedConfirmed: true,
    loserCompressionAttributionConfidence: "HIGH",
    loserCompressionAppliedState: "L1",
    stopLoss: l1RequestedStop,
    slTrigger: l1RequestedStop,
    brokerStopLoss: l1RequestedStop,
  },
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, l1Now + 12_000),
  candles: flatCandles(),
  nowTs: l1Now + 12_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(l1ConfirmedPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(l1ConfirmedPlan.meta?.loserCompressionAppliedState, "L1");
assert.equal(
  l1ConfirmedPlan.meta?.loserCompressionRequestOutcome,
  "ALC_APPLIED_CONFIRMED",
);
assert.equal(
  l1ConfirmedPlan.meta?.loserCompressionAppliedConfirmed,
  true,
);
assert.equal(l1ConfirmedPlan.meta?.loserCompressionAppliedSource, "ALC_L1");
assert.equal(l1ConfirmedPlan.meta?.alcAppliedLevel, "L1");
assert.equal(l1ConfirmedPlan.meta?.alcAppliedSource, "ALC_L1");

const l1AppliedTrade = makeFailingBuyTrade({
  desiredStopLoss: l1RequestedStop,
  finalStopLoss: l1RequestedStop,
  protectedStopSource: "ALC_L1",
  loserCompressionDesiredAction: "COMPRESS_L1",
  loserCompressionTargetState: "L1",
  loserCompressionSubmittedState: "L1",
  loserCompressionAppliedState: "L1",
  loserCompressionPendingAction: null,
  loserCompressionLastRequestedStop: l1RequestedStop,
  loserCompressionLastConfirmedStop: l1RequestedStop,
  loserCompressionLastAttemptAt: new Date(l1Now).toISOString(),
  loserCompressionLastConfirmedAt: new Date(l1Now + 12_000).toISOString(),
  loserCompressionAppliedSource: "ALC_L1",
  loserCompressionAppliedConfirmed: true,
  loserCompressionAttributionConfidence: "HIGH",
  stopLoss: l1RequestedStop,
  slTrigger: l1RequestedStop,
  brokerStopLoss: l1RequestedStop,
});
const l2Now = BASE_NOW + 2 * 60_000;
const failingL2Plan = computeDynamicExitPlan({
  trade: l1AppliedTrade,
  ltp: 95.4,
  marketQuote: withFreshQuote({ bid: 95.2, ask: 95.3, ltp: 95.4 }, l2Now),
  candles: flatCandles(),
  nowTs: l2Now,
  env: loserEnv({ ALC_SCORE_COMPRESS_L2: 75, ALC_ADVERSE_R_L2: 0.45 }),
  underlyingLtp: 19910,
});

assert.equal(failingL2Plan.ok, true);
assert.equal(failingL2Plan.meta?.loserCompressionAction, "COMPRESS_L2");
assert.equal(Boolean(failingL2Plan.meta?.loserCompressionEscalated), true);
assert.equal(failingL2Plan.meta?.protectedStopSource, "ALC_L2");
assert.ok(
  Number(failingL2Plan.sl?.stopLoss ?? 0) >
    Number(failingL1Plan.sl?.stopLoss ?? 0),
);
assert.ok(
  Number(failingL2Plan.meta?.finalStopLoss ?? 0) >=
    Number(failingL1Plan.meta?.finalStopLoss ?? 0),
);
assert.equal(failingL2Plan.meta?.loserCompressionTargetState, "L2");

const l2SupersedePlan = computeDynamicExitPlan({
  trade: {
    ...l1PendingTrade,
    stopLoss: Number(failingL1Plan.sl?.stopLoss ?? 0),
    brokerStopLoss: Number(failingL1Plan.sl?.stopLoss ?? 0),
    loserCompressionPendingSince: new Date(l2Now - 1_000).toISOString(),
    loserCompressionLastAttemptAt: new Date(l2Now - 1_000).toISOString(),
  },
  ltp: 95.4,
  marketQuote: withFreshQuote({ bid: 95.2, ask: 95.3, ltp: 95.4 }, l2Now),
  candles: flatCandles(),
  nowTs: l2Now,
  env: loserEnv({ ALC_SCORE_COMPRESS_L2: 75, ALC_ADVERSE_R_L2: 0.45 }),
  underlyingLtp: 19910,
});

assert.equal(l2SupersedePlan.meta?.loserCompressionAction, "COMPRESS_L2");
assert.equal(
  l2SupersedePlan.meta?.loserCompressionRequestOutcome,
  "ALC_SUPERSEDE_L1_TO_L2",
);
assert.equal(l2SupersedePlan.meta?.loserCompressionSuperseded, true);

const exitNowPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade(),
  ltp: 93.4,
  marketQuote: withFreshQuote({ bid: 91.0, ask: 91.2, ltp: 93.4 }, BASE_NOW + 3 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 3 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19900,
});

assert.equal(Boolean(exitNowPlan.action?.exitNow), true);
assert.equal(exitNowPlan.action?.reason, "ALC_EXIT_NOW");
assert.equal(Boolean(exitNowPlan.meta?.loserExitTriggered), true);
assert.equal(exitNowPlan.meta?.loserExitReasonCode, "ALC_EXIT_NOW");
assert.equal(exitNowPlan.meta?.loserCompressionDesiredAction, "EXIT_NOW");
assert.equal(exitNowPlan.meta?.loserCompressionTargetState, "EXIT");

const goodFollowThroughPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade({
    peakLtp: 103.5,
    peakPnlInr: 35,
    peakPnlR: 0.35,
    peakExecutablePnlInr: 35,
    peakExecutableR: 0.35,
  }),
  ltp: 98.7,
  marketQuote: withFreshQuote({ bid: 98.2, ask: 98.4, ltp: 98.7 }, BASE_NOW + 4 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 4 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19980,
});

assert.equal(goodFollowThroughPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(Boolean(goodFollowThroughPlan.meta?.loserCompressionActive), false);
assert.equal(goodFollowThroughPlan.meta?.protectedStopSource ?? null, null);

const staleQuotePlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade(),
  ltp: 94.8,
  marketQuote: {
    bid: 94.4,
    ask: 94.6,
    ltp: 94.8,
    timestampMs: BASE_NOW + 5 * 60_000 - 10_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 5 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(staleQuotePlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  staleQuotePlan.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_STALE_QUOTE",
);

const alreadyTighterPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade({ stopLoss: 96, brokerStopLoss: 96 }),
  ltp: 98.5,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 98.5 }, BASE_NOW + 6 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(alreadyTighterPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  alreadyTighterPlan.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_ALREADY_TIGHTER_NON_ALC",
);
assert.equal(alreadyTighterPlan.meta?.loserCompressionAppliedState, "NONE");

const l2AlreadyConfirmedPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade({
    loserCompressionTargetState: "L2",
    loserCompressionSubmittedState: "L2",
    loserCompressionAppliedState: "L2",
    loserCompressionAppliedSource: "ALC_L2",
    loserCompressionAppliedConfirmed: true,
    loserCompressionAttributionConfidence: "HIGH",
    stopLoss: 96.0,
    brokerStopLoss: 96.0,
    loserCompressionLastConfirmedStop: 96.0,
  }),
  ltp: 95.8,
  marketQuote: withFreshQuote({ bid: 95.4, ask: 95.5, ltp: 95.8 }, BASE_NOW + 6 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env: loserEnv({ ALC_SCORE_COMPRESS_L2: 75, ALC_ADVERSE_R_L2: 0.45 }),
  underlyingLtp: 19910,
});

assert.equal(l2AlreadyConfirmedPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  l2AlreadyConfirmedPlan.meta?.loserCompressionAppliedState,
  "L2",
);
assert.equal(
  l2AlreadyConfirmedPlan.meta?.loserCompressionAppliedSource,
  "ALC_L2",
);
assert.equal(
  l2AlreadyConfirmedPlan.meta?.loserCompressionRequestBlockedReason,
  "ALC_BLOCKED_ALREADY_CONFIRMED",
);

const sellSymmetryPlan = computeDynamicExitPlan({
  trade: makeFailingSellTrade(),
  ltp: 104.5,
  marketQuote: withFreshQuote({ bid: 105.8, ask: 106.0, ltp: 104.5 }, BASE_NOW + 7 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 7 * 60_000,
  env: loserEnv(),
  underlyingLtp: 20080,
});

assert.equal(sellSymmetryPlan.meta?.loserCompressionAction, "COMPRESS_L1");
assert.equal(sellSymmetryPlan.meta?.protectedStopSource, "ALC_L1");
assert.ok(Number(sellSymmetryPlan.sl?.stopLoss ?? 0) < 110);
assert.ok(Number(sellSymmetryPlan.meta?.finalStopLoss ?? 0) < 110);

const sellRetryEscalationPlan = computeDynamicExitPlan({
  trade: {
    ...makeFailingSellTrade({
      stopLoss: Number(sellSymmetryPlan.sl?.stopLoss ?? 0),
      brokerStopLoss: Number(sellSymmetryPlan.sl?.stopLoss ?? 0),
      loserCompressionTargetState: "L1",
      loserCompressionSubmittedState: "L1",
      loserCompressionPendingAction: "STOP_MODIFY",
      loserCompressionPendingSince: new Date(BASE_NOW + 7 * 60_000 - 9_000).toISOString(),
      loserCompressionLastAttemptAt: new Date(BASE_NOW + 7 * 60_000 - 9_000).toISOString(),
      loserCompressionRetryCount: 1,
      loserCompressionLastRequestedStop: Number(sellSymmetryPlan.sl?.stopLoss ?? 0),
    }),
  },
  ltp: 106.1,
  marketQuote: withFreshQuote({ bid: 106.0, ask: 106.2, ltp: 106.1 }, BASE_NOW + 7 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 7 * 60_000,
  env: loserEnv({ ALC_SCORE_COMPRESS_L2: 75, ALC_ADVERSE_R_L2: 0.45 }),
  underlyingLtp: 20100,
});

assert.equal(sellRetryEscalationPlan.meta?.loserCompressionAction, "COMPRESS_L2");
assert.equal(
  sellRetryEscalationPlan.meta?.loserCompressionRequestOutcome,
  "ALC_SUPERSEDE_L1_TO_L2",
);
assert.ok(
  Number(sellRetryEscalationPlan.sl?.stopLoss ?? 0) <
    Number(sellSymmetryPlan.sl?.stopLoss ?? 0),
);

const graceBlockedPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade(),
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, BASE_NOW + 5_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 5_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(graceBlockedPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  graceBlockedPlan.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_GRACE",
);

const noStructurePlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: {
      ...optionInstrument,
      tradingsymbol: "NIFTY26JAN20000PE",
    },
    minGreenInr: 40,
    minGreenPts: 4,
    option_meta: { optType: "PE", underlyingLtp: 20000 },
  }),
  ltp: 96.0,
  marketQuote: withFreshQuote({ bid: 91.5, ask: 93.6, ltp: 96.0 }, BASE_NOW + 8 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 8 * 60_000,
  env: loserEnv({
    ALC_SCORE_COMPRESS_L1: 65,
    ALC_REQUIRE_STRUCTURE_FOR_COMPRESSION: "true",
    ALC_ALLOW_EXIT_WITHOUT_STRUCTURE_ON_EXTREME_FAILURE: "false",
  }),
  underlyingLtp: 20040,
});

assert.equal(noStructurePlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  noStructurePlan.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_NO_STRUCTURE",
);

const minGreenWinnerPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade(),
  ltp: 105.0,
  marketQuote: withFreshQuote({ bid: 104.8, ask: 105.0, ltp: 105.0 }, BASE_NOW + 9 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 9 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(Boolean(minGreenWinnerPlan.meta?.minGreenSatisfied), true);
assert.equal(minGreenWinnerPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  minGreenWinnerPlan.meta?.loserCompressionBlockedReason,
  "ALC_BLOCKED_WINNER_MODE",
);

const pendingClosePlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade({
    panicExitPending: true,
    loserCompressionTargetState: "L1",
  }),
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, BASE_NOW + 9 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 9 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(pendingClosePlan.meta?.loserCompressionAction, "HOLD");
assert.equal(
  pendingClosePlan.meta?.loserCompressionRequestBlockedReason,
  "ALC_BLOCKED_PENDING_CLOSE",
);

const replayTrade = { ...l1AppliedTrade };
const replayPlan = computeDynamicExitPlan({
  trade: replayTrade,
  ltp: 94.8,
  marketQuote: withFreshQuote({ bid: 94.4, ask: 94.6, ltp: 94.8 }, BASE_NOW + 10 * 60_000),
  candles: flatCandles(),
  nowTs: BASE_NOW + 10 * 60_000,
  env: loserEnv(),
  underlyingLtp: 19920,
});

assert.equal(replayPlan.meta?.loserCompressionAction, "HOLD");
assert.equal(Boolean(replayPlan.meta?.loserCompressionActive), false);
assert.equal(replayPlan.sl, null);

const earlyFailConflictPlan = computeDynamicExitPlan({
  trade: makeFailingBuyTrade({
    strategyId: "breakout",
    entryFilledAt: new Date(BASE_NOW - 60_000).toISOString(),
    createdAt: new Date(BASE_NOW - 60_000).toISOString(),
    updatedAt: new Date(BASE_NOW - 60_000).toISOString(),
  }),
  ltp: 94.7,
  marketQuote: withFreshQuote({ bid: 94.5, ask: 94.6, ltp: 94.7 }, BASE_NOW),
  candles: flatCandles(),
  nowTs: BASE_NOW,
  env: loserEnv({
    EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_CONFIRM_MS: 0,
  }),
  underlyingLtp: 19910,
});

assert.equal(Boolean(earlyFailConflictPlan.action?.exitNow), true);
assert.ok(/^EARLY_/.test(String(earlyFailConflictPlan.action?.reason || "")));
assert.equal(
  earlyFailConflictPlan.meta?.loserCompressionRequestBlockedReason,
  "ALC_BLOCKED_PENDING_CLOSE",
);

console.log("adaptiveLoserCompression.test.js passed");
