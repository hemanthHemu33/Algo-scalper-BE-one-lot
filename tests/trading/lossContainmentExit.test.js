const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const {
  BASE_NOW,
  applyPlanPatch,
  makeTrade,
  makeEnv,
  flatCandles,
} = require("./_helpers");

const optionInstrument = {
  tick_size: 0.05,
  segment: "NFO-OPT",
  tradingsymbol: "NIFTY26JAN20000CE",
  exchange: "NFO",
};

const baseEarlyEnv = makeEnv({
  EARLY_FAIL_ENABLED: "true",
  EARLY_FAIL_WINDOW_MS: 90_000,
  EARLY_FAIL_MIN_PEAK_R: 0.25,
  EARLY_FAIL_STRUCTURE_BREAK_ENABLED: "true",
  EARLY_STALL_MIN_TRADE_AGE_MS: 20_000,
  EARLY_STALL_MIN_BARS_SINCE_ENTRY: 1,
  EARLY_STALL_CONFIRM_TICKS: 2,
  EARLY_STALL_CONFIRM_MS: 0,
  EARLY_STALL_MIN_MFE_R: 0.2,
  EARLY_STALL_MAX_ADVERSE_R: -0.08,
  EARLY_STALL_BREAKOUT_GRACE_MS: 15_000,
  EARLY_STALL_ORB_GRACE_MS: 20_000,
  EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 2,
  EARLY_STRUCTURE_FAIL_CONFIRM_MS: 0,
  EARLY_STRUCTURE_FAIL_BUFFER_POINTS: 0,
  EARLY_STRUCTURE_FAIL_BUFFER_TICKS: 6,
  EARLY_STRUCTURE_FAIL_BUFFER_ATR_FRACTION: 0.15,
  EARLY_STRUCTURE_FAIL_USE_UNDERLYING: true,
});

const earlyFailSeededKeys = [
  "earlyFailArmed",
  "earlyFailMode",
  "earlyFailReason",
  "earlyFailCandidateReason",
  "earlyFailEligible",
  "earlyFailAuthority",
  "earlyFailSinceTs",
  "earlyFailTradeAgeMs",
  "earlyFailBarsSinceEntry",
  "earlyFailConfirmTicks",
  "earlyFailConfirmTarget",
  "earlyFailConfirmMs",
  "earlyFailConfirmTargetMs",
  "earlyFailBufferUsed",
  "earlyFailReferenceLevel",
  "earlyFailReferenceSource",
  "earlyFailBreachAmount",
  "earlyFailMfeAtDecision",
  "earlyFailAdverseRAtDecision",
  "earlyFailMaeAtDecision",
  "earlyFailDecisionState",
  "earlyFailHoldReason",
];

function assertEarlyFailTelemetrySeeded(meta, label) {
  for (const key of earlyFailSeededKeys) {
    assert.notEqual(meta?.[key], undefined, `${label}: ${key} should be seeded`);
  }
}

const stallGrace = computeDynamicExitPlan({
  trade: makeTrade({
    strategyId: "breakout",
    strategyStyle: "TREND",
  }),
  ltp: 99.2,
  candles: flatCandles(),
  nowTs: BASE_NOW + 10_000,
  env: baseEarlyEnv,
});

assert.equal(stallGrace.ok, true);
assert.equal(Boolean(stallGrace.action?.exitNow), false);
assert.equal(stallGrace.meta?.earlyFailMode, "STALL");
assert.equal(stallGrace.meta?.earlyFailDecisionState, "HOLD");
assert.equal(stallGrace.meta?.earlyFailHoldReason, "STALL_GRACE_WINDOW_ACTIVE");

const stallConfirmTrade = makeTrade({
  strategyId: "rsi_fade",
  strategyStyle: "RANGE",
});
const stallConfirming = computeDynamicExitPlan({
  trade: stallConfirmTrade,
  ltp: 99,
  candles: flatCandles(),
  nowTs: BASE_NOW + 65_000,
  env: baseEarlyEnv,
});

assert.equal(stallConfirming.ok, true);
assert.equal(Boolean(stallConfirming.action?.exitNow), false);
assert.equal(stallConfirming.meta?.earlyFailMode, "STALL");
assert.equal(stallConfirming.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(stallConfirming.meta?.earlyFailConfirmTicks, 1);
assert.equal(stallConfirming.meta?.earlyFailConfirmTarget, 2);

const stallConfirmed = computeDynamicExitPlan({
  trade: applyPlanPatch(stallConfirmTrade, stallConfirming),
  ltp: 99,
  candles: flatCandles(),
  nowTs: BASE_NOW + 70_000,
  env: baseEarlyEnv,
});

assert.equal(stallConfirmed.ok, true);
assert.equal(Boolean(stallConfirmed.action?.exitNow), true);
assert.equal(stallConfirmed.action?.reason, "EARLY_STALL_EXIT");
assert.equal(stallConfirmed.meta?.exitFamily, "LOSS_CONTAINMENT");
assert.equal(stallConfirmed.meta?.exitReasonCode, "EARLY_STALL_EXIT");
assert.equal(stallConfirmed.meta?.exitAuthority, "EARLY_FAIL_ENGINE");
assert.equal(stallConfirmed.meta?.earlyFailDecisionState, "EXIT_AUTHORIZED");

const stallMsEnv = makeEnv({
  ...baseEarlyEnv,
  EARLY_STALL_CONFIRM_TICKS: 1,
  EARLY_STALL_CONFIRM_MS: 5_000,
});
const stallMsTrade = makeTrade({
  strategyId: "rsi_fade",
  strategyStyle: "RANGE",
});
const stallMsConfirming = computeDynamicExitPlan({
  trade: stallMsTrade,
  ltp: 99,
  candles: flatCandles(),
  nowTs: BASE_NOW + 65_000,
  env: stallMsEnv,
});

assert.equal(stallMsConfirming.ok, true);
assert.equal(Boolean(stallMsConfirming.action?.exitNow), false);
assert.equal(stallMsConfirming.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(stallMsConfirming.meta?.earlyFailConfirmTicks, 1);
assert.equal(stallMsConfirming.meta?.earlyFailConfirmTarget, 1);
assert.equal(stallMsConfirming.meta?.earlyFailConfirmMs, 0);
assert.equal(stallMsConfirming.meta?.earlyFailConfirmTargetMs, 5_000);

const stallMsPending = computeDynamicExitPlan({
  trade: applyPlanPatch(stallMsTrade, stallMsConfirming),
  ltp: 99,
  candles: flatCandles(),
  nowTs: BASE_NOW + 69_000,
  env: stallMsEnv,
});

assert.equal(stallMsPending.ok, true);
assert.equal(Boolean(stallMsPending.action?.exitNow), false);
assert.equal(stallMsPending.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(stallMsPending.meta?.earlyFailConfirmTicks, 2);
assert.equal(stallMsPending.meta?.earlyFailConfirmMs, 4_000);

const stallMsConfirmed = computeDynamicExitPlan({
  trade: applyPlanPatch(stallMsTrade, stallMsPending),
  ltp: 99,
  candles: flatCandles(),
  nowTs: BASE_NOW + 71_000,
  env: stallMsEnv,
});

assert.equal(stallMsConfirmed.ok, true);
assert.equal(Boolean(stallMsConfirmed.action?.exitNow), true);
assert.equal(stallMsConfirmed.action?.reason, "EARLY_STALL_EXIT");
assert.equal(stallMsConfirmed.meta?.earlyFailDecisionState, "EXIT_AUTHORIZED");
assert.ok(Number(stallMsConfirmed.meta?.earlyFailConfirmMs ?? 0) >= 5_000);

const structureTrade = makeTrade({
  strategyId: "breakout",
  strategyStyle: "TREND",
  instrument: optionInstrument,
  option_meta: { optType: "CE", underlyingLtp: 20000 },
  underlying_ltp: 20000,
  planMeta: {
    style: "TREND",
    family: "TREND",
    underlying: { entry: 20000, stop: 19950, target: 20080, R: 50 },
  },
});

const tinyStructureBreach = computeDynamicExitPlan({
  trade: structureTrade,
  ltp: 99.4,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  }),
  underlyingLtp: 19944,
});

assert.equal(tinyStructureBreach.ok, true);
assert.equal(Boolean(tinyStructureBreach.action?.exitNow), false);
assert.equal(tinyStructureBreach.meta?.earlyFailMode, "STRUCTURE");
assert.equal(tinyStructureBreach.meta?.earlyFailDecisionState, "HOLD");
assert.equal(
  tinyStructureBreach.meta?.earlyFailHoldReason,
  "STRUCTURE_BREACH_TOO_SMALL",
);
assert.equal(
  tinyStructureBreach.meta?.earlyFailReferenceSource,
  "PLAN_UNDERLYING_STOP",
);
assert.ok(
  Number(tinyStructureBreach.meta?.earlyFailBufferUsed ?? 0) >
    Number(tinyStructureBreach.meta?.earlyFailBreachAmount ?? 0),
);

const structureConfirming = computeDynamicExitPlan({
  trade: structureTrade,
  ltp: 98.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  }),
  underlyingLtp: 19920,
});

assert.equal(structureConfirming.ok, true);
assert.equal(Boolean(structureConfirming.action?.exitNow), false);
assert.equal(structureConfirming.meta?.earlyFailMode, "STRUCTURE");
assert.equal(structureConfirming.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(structureConfirming.meta?.earlyFailConfirmTicks, 1);
assert.equal(
  structureConfirming.meta?.earlyFailReferenceSource,
  "PLAN_UNDERLYING_STOP",
);

const structureFailure = computeDynamicExitPlan({
  trade: applyPlanPatch(structureTrade, structureConfirming),
  ltp: 98.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 16_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  }),
  underlyingLtp: 19920,
});

assert.equal(structureFailure.ok, true);
assert.equal(Boolean(structureFailure.action?.exitNow), true);
assert.equal(structureFailure.action?.reason, "EARLY_STRUCTURE_FAILURE");
assert.equal(structureFailure.meta?.exitFamily, "LOSS_CONTAINMENT");
assert.equal(structureFailure.meta?.exitReasonCode, "EARLY_STRUCTURE_FAILURE");
assert.equal(structureFailure.meta?.exitAuthority, "EARLY_FAIL_ENGINE");
assert.equal(structureFailure.meta?.earlyFailAuthority, "EARLY_FAIL_ENGINE");
assert.equal(structureFailure.meta?.earlyFailDecisionState, "EXIT_AUTHORIZED");
assert.equal(
  structureFailure.meta?.earlyFailReferenceSource,
  "PLAN_UNDERLYING_STOP",
);
assert.ok(Number(structureFailure.meta?.earlyFailBreachAmount ?? 0) > 0);
assert.equal(
  structureFailure.meta?.earlyFailAdverseRAtDecision,
  structureFailure.meta?.earlyFailMaeAtDecision,
);
assert.ok(Number(structureFailure.meta?.earlyFailMfeAtDecision ?? 0) >= 0);

const structureMsEnv = makeEnv({
  ...baseEarlyEnv,
  EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 1,
  EARLY_STRUCTURE_FAIL_CONFIRM_MS: 4_000,
});
const structureMsConfirming = computeDynamicExitPlan({
  trade: structureTrade,
  ltp: 98.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: structureMsEnv,
  underlyingLtp: 19920,
});

assert.equal(structureMsConfirming.ok, true);
assert.equal(Boolean(structureMsConfirming.action?.exitNow), false);
assert.equal(structureMsConfirming.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(structureMsConfirming.meta?.earlyFailConfirmTicks, 1);
assert.equal(structureMsConfirming.meta?.earlyFailConfirmTarget, 1);
assert.equal(structureMsConfirming.meta?.earlyFailConfirmMs, 0);
assert.equal(structureMsConfirming.meta?.earlyFailConfirmTargetMs, 4_000);

const structureMsPending = computeDynamicExitPlan({
  trade: applyPlanPatch(structureTrade, structureMsConfirming),
  ltp: 98.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 18_000,
  env: structureMsEnv,
  underlyingLtp: 19920,
});

assert.equal(structureMsPending.ok, true);
assert.equal(Boolean(structureMsPending.action?.exitNow), false);
assert.equal(structureMsPending.meta?.earlyFailDecisionState, "CONFIRMING");
assert.equal(structureMsPending.meta?.earlyFailConfirmTicks, 2);
assert.equal(structureMsPending.meta?.earlyFailConfirmMs, 3_000);

const structureMsConfirmed = computeDynamicExitPlan({
  trade: applyPlanPatch(structureTrade, structureMsPending),
  ltp: 98.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 20_000,
  env: structureMsEnv,
  underlyingLtp: 19920,
});

assert.equal(structureMsConfirmed.ok, true);
assert.equal(Boolean(structureMsConfirmed.action?.exitNow), true);
assert.equal(structureMsConfirmed.action?.reason, "EARLY_STRUCTURE_FAILURE");
assert.equal(structureMsConfirmed.meta?.earlyFailDecisionState, "EXIT_AUTHORIZED");
assert.ok(Number(structureMsConfirmed.meta?.earlyFailConfirmMs ?? 0) >= 4_000);

const slightGreenSmallBreach = computeDynamicExitPlan({
  trade: makeTrade({
    ...structureTrade,
    peakLtp: 101.2,
    peakPnlInr: 12,
    peakPnlR: 0.12,
  }),
  ltp: 100.8,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  }),
  underlyingLtp: 19944,
});

assert.equal(slightGreenSmallBreach.ok, true);
assert.equal(Boolean(slightGreenSmallBreach.action?.exitNow), false);
assert.equal(slightGreenSmallBreach.meta?.earlyFailMode, "STRUCTURE");
assert.equal(slightGreenSmallBreach.meta?.earlyFailDecisionState, "HOLD");
assert.equal(
  slightGreenSmallBreach.meta?.earlyFailHoldReason,
  "STRUCTURE_BREACH_TOO_SMALL",
);

const slightGreenStrongBreach = computeDynamicExitPlan({
  trade: makeTrade({
    ...structureTrade,
    peakLtp: 102,
    peakPnlInr: 20,
    peakPnlR: 0.2,
  }),
  ltp: 100.8,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
    EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_CONFIRM_MS: 0,
    EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_MS: 0,
  }),
  underlyingLtp: 19920,
});

assert.equal(slightGreenStrongBreach.ok, true);
assert.equal(Boolean(slightGreenStrongBreach.action?.exitNow), true);
assert.equal(slightGreenStrongBreach.action?.reason, "EARLY_STRUCTURE_FAILURE");
assert.equal(
  slightGreenStrongBreach.meta?.earlyFailDecisionState,
  "EXIT_AUTHORIZED",
);
assert.ok(Number(slightGreenStrongBreach.meta?.earlyFailBreachSeverity ?? 0) >= 2.25);

const slightGreenNoisyOscillation = computeDynamicExitPlan({
  trade: makeTrade({
    ...structureTrade,
    peakLtp: 100.85,
    peakPnlInr: 8.5,
    peakPnlR: 0.085,
  }),
  ltp: 100.8,
  candles: flatCandles(),
  nowTs: BASE_NOW + 15_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 0,
    EARLY_STALL_MIN_BARS_SINCE_ENTRY: 0,
    EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_CONFIRM_MS: 0,
    EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_MS: 0,
  }),
  underlyingLtp: 19920,
});

assert.equal(slightGreenNoisyOscillation.ok, true);
assert.equal(Boolean(slightGreenNoisyOscillation.action?.exitNow), false);
assert.equal(slightGreenNoisyOscillation.meta?.earlyFailMode, "STALL");
assert.equal(slightGreenNoisyOscillation.meta?.earlyFailDecisionState, "HOLD");
assert.equal(
  slightGreenNoisyOscillation.meta?.earlyFailHoldReason,
  "STALL_NO_WEAKNESS",
);

const noisyOptionButUnderlyingIntact = computeDynamicExitPlan({
  trade: structureTrade,
  ltp: 89,
  candles: flatCandles(),
  nowTs: BASE_NOW + 12_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
  }),
  underlyingLtp: 19970,
});

assert.equal(noisyOptionButUnderlyingIntact.ok, true);
assert.equal(Boolean(noisyOptionButUnderlyingIntact.action?.exitNow), false);
assert.equal(noisyOptionButUnderlyingIntact.meta?.earlyFailReason ?? null, null);
assert.equal(noisyOptionButUnderlyingIntact.meta?.exitReasonCode ?? null, null);

const optionLedStructureFailure = computeDynamicExitPlan({
  trade: structureTrade,
  ltp: 89,
  candles: flatCandles(),
  nowTs: BASE_NOW + 12_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_STALL_MIN_TRADE_AGE_MS: 60_000,
    EARLY_STRUCTURE_FAIL_USE_UNDERLYING: false,
    EARLY_STRUCTURE_FAIL_CONFIRM_TICKS: 1,
    EARLY_STRUCTURE_FAIL_CONFIRM_MS: 0,
    EARLY_STRUCTURE_FAIL_BUFFER_POINTS: 0,
    EARLY_STRUCTURE_FAIL_BUFFER_TICKS: 0,
    EARLY_STRUCTURE_FAIL_BUFFER_ATR_FRACTION: 0,
  }),
  underlyingLtp: 19970,
});

assert.equal(optionLedStructureFailure.ok, true);
assert.equal(Boolean(optionLedStructureFailure.action?.exitNow), true);
assert.equal(optionLedStructureFailure.action?.reason, "EARLY_STRUCTURE_FAILURE");
assert.equal(optionLedStructureFailure.meta?.earlyFailMode, "STRUCTURE");
assert.equal(
  optionLedStructureFailure.meta?.earlyFailReferenceSource,
  "STRATEGY_STOP_LOSS",
);
assert.equal(optionLedStructureFailure.meta?.earlyFailReferenceLevel, 90);
assert.equal(optionLedStructureFailure.meta?.exitAuthority, "EARLY_FAIL_ENGINE");

const normalSlOnly = computeDynamicExitPlan({
  trade: makeTrade({
    strategyId: "rsi_fade",
    strategyStyle: "RANGE",
    instrument: optionInstrument,
  }),
  ltp: 89.5,
  candles: flatCandles(),
  nowTs: BASE_NOW + 60_000,
  env: makeEnv({
    ...baseEarlyEnv,
    EARLY_FAIL_ENABLED: "false",
  }),
});

assert.equal(normalSlOnly.ok, true);
assert.equal(Boolean(normalSlOnly.action?.exitNow), false);
assert.equal(normalSlOnly.meta?.earlyFailDecisionState, "DISABLED");
assert.equal(normalSlOnly.meta?.earlyFailReason ?? null, null);
assert.equal(normalSlOnly.meta?.exitReasonCode ?? null, null);
assert.equal(normalSlOnly.meta?.exitAuthority ?? null, null);
assert.equal(normalSlOnly.meta?.exitFamily ?? null, null);
assert.equal(Number(normalSlOnly.finalStop ?? 0), 90);
assert.equal(Number(normalSlOnly.meta?.hardFloor ?? 0), 90);
assert.equal(
  normalSlOnly.meta?.earlyFailAdverseRAtDecision,
  normalSlOnly.meta?.earlyFailMaeAtDecision,
);
assert.ok(Number(normalSlOnly.meta?.earlyFailMfeAtDecision ?? 0) >= 0);

assertEarlyFailTelemetrySeeded(structureFailure.meta, "structureFailure");
assertEarlyFailTelemetrySeeded(normalSlOnly.meta, "normalSlOnly");

const winnerProtectionTakesOver = computeDynamicExitPlan({
  trade: makeTrade({
    beLocked: true,
    beEligible: true,
    beAppliedAt: new Date(BASE_NOW + 20_000).toISOString(),
    beAppliedStopLoss: 100,
    brokerStopLoss: 100,
    stopLoss: 100,
    peakLtp: 112,
    peakPnlInr: 120,
    peakPnlR: 1.2,
  }),
  ltp: 100,
  candles: flatCandles(),
  nowTs: BASE_NOW + 35_000,
  env: baseEarlyEnv,
});

assert.equal(winnerProtectionTakesOver.ok, true);
assert.equal(Boolean(winnerProtectionTakesOver.action?.exitNow), false);
assert.equal(Boolean(winnerProtectionTakesOver.meta?.earlyFailArmed), false);
assert.equal(
  winnerProtectionTakesOver.meta?.earlyFailDecisionState,
  "WINNER_PROTECTION_ACTIVE",
);
assert.equal(winnerProtectionTakesOver.meta?.earlyFailReason ?? null, null);
assert.equal(winnerProtectionTakesOver.meta?.exitReasonCode ?? null, null);
assert.ok(Number(winnerProtectionTakesOver.finalStop ?? 0) > 90);

console.log("lossContainmentExit.test.js passed");
