const assert = require("node:assert/strict");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const { BASE_NOW, makeTrade, makeEnv, flatCandles } = require("./_helpers");

const env = makeEnv();

function protectionEnv(overrides = {}) {
  return makeEnv({
    MIN_GREEN_ENABLED: "true",
    BE_ARM_COST_MULT: 0,
    DYN_MOVE_SL_TO_BE_AT_R: 99,
    DYN_TRAIL_START_R: 99,
    GREEN_LOCK_ENABLED: "false",
    MFE_LOCK_LADDER_ENABLED: "false",
    EXIT_TIGHTEN_AT_R: 99,
    PROFIT_LOCK_ENABLED: "false",
    ...overrides,
  });
}

function maxHoldEnv(overrides = {}) {
  return protectionEnv({
    TIME_STOP_MAX_HOLD_MIN: 1,
    TIME_STOP_MAX_HOLD_SKIP_IF_PNL_R: 99,
    TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_R: 99,
    ...overrides,
  });
}

const noLoosen = computeDynamicExitPlan({
  trade: makeTrade({ stopLoss: 106, beLocked: true }),
  ltp: 108,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env,
});

assert.equal(noLoosen.ok, true);
assert.ok(Number(noLoosen.finalStop ?? 0) >= 106);
assert.equal(noLoosen.sl, null);

const recovered = computeDynamicExitPlan({
  trade: makeTrade({
    greenLockActive: true,
    greenLockFloorPrice: 101.2,
    mfeLockTier: 3,
    mfeLockFloorPrice: 107.5,
    peakPnlInr: 190,
    peakPnlR: 1.9,
  }),
  ltp: 116,
  candles: flatCandles(),
  nowTs: BASE_NOW + 5 * 60_000,
  env,
});

assert.equal(recovered.ok, true);
assert.equal(Boolean(recovered.greenLockActive), true);
assert.equal(Number(recovered.mfeLockTier), 4);
assert.equal(Number(recovered.mfeLockFloorR ?? 0), 1);
assert.ok(Number(recovered.mfeLockFloorPrice ?? 0) >= 110);
assert.equal(Boolean(recovered.tightenActive), true);

const optionPlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: {
      tick_size: 0.05,
      segment: "NFO-OPT",
      tradingsymbol: "NIFTY26JAN20000CE",
      exchange: "NFO",
    },
  }),
  ltp: 112,
  marketQuote: { bid: 106, ask: 107, ltp: 112 },
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env,
  underlyingLtp: 20120,
});

assert.equal(optionPlan.ok, true);
assert.ok(Number(optionPlan.meta?.peakExecutableR ?? 0) < 1);
assert.equal(Number(optionPlan.mfeLockTier ?? 0), 0);

const optionInstrument = {
  tick_size: 0.05,
  segment: "NFO-OPT",
  tradingsymbol: "NIFTY26JAN20000CE",
  exchange: "NFO",
};

const gatedStructure = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
  }),
  ltp: 106,
  marketQuote: { bid: 105.8, ask: 106.2, ltp: 106 },
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env: makeEnv({ BE_ARM_R: 0.9, GREEN_LOCK_ARM_R: 0.9, GREEN_LOCK_PEAK_R: 2.0 }),
  underlyingLtp: 20010,
});

assert.equal(gatedStructure.ok, true);
assert.equal(gatedStructure.sl, null);
assert.ok(Number(gatedStructure.finalStop ?? 0) <= 90);
assert.equal(Boolean(gatedStructure.meta?.protectionGateOpen), false);
assert.equal(Boolean(gatedStructure.meta?.winnerModeActive), false);
assert.equal(Boolean(gatedStructure.meta?.structureTrailAllowed), false);
assert.equal(gatedStructure.meta?.structureTrailSource, "GATED");
assert.equal(Boolean(gatedStructure.meta?.stopImproveAuthorized), false);
assert.equal(Boolean(gatedStructure.meta?.trailActive), false);
assert.equal(
  Array.isArray(gatedStructure.meta?.reasonTags) &&
    gatedStructure.meta.reasonTags.includes("STRUCTURE_TRAIL"),
  false,
);
assert.equal(
  Array.isArray(gatedStructure.meta?.reasonTags) &&
    gatedStructure.meta.reasonTags.includes("STRUCTURE_TRAIL_GATED"),
  true,
);

const liveBugGuarded = computeDynamicExitPlan({
  trade: makeTrade({
    entryPrice: 189.6,
    strategyStopLoss: 166.45,
    sizingStopLoss: 166.45,
    brokerStopLoss: 166.45,
    stopLoss: 166.45,
    initialStopLoss: 166.45,
    instrument: optionInstrument,
    beLocked: false,
    beLockHit: false,
    greenLockActive: false,
    profitLockArmed: false,
    mfeLockTier: 0,
    mfeLockFloorR: 0,
    mfeLockFloorPrice: 189.6,
  }),
  ltp: 189.7,
  marketQuote: { bid: 189.55, ask: 189.75, ltp: 189.7 },
  candles: flatCandles(30, 189.6),
  nowTs: BASE_NOW + 7 * 60_000,
  env: makeEnv({ BE_ARM_R: 99, GREEN_LOCK_ARM_R: 99, GREEN_LOCK_PEAK_R: 99 }),
  underlyingLtp: 20010,
});

assert.equal(liveBugGuarded.ok, true);
assert.equal(Number(liveBugGuarded.mfeLockTier ?? 0), 0);
assert.equal(Number(liveBugGuarded.mfeLockFloorR ?? 0), 0);
assert.equal(liveBugGuarded.mfeLockFloorPrice, null);
assert.equal(Boolean(liveBugGuarded.meta?.protectionGateOpen), false);
assert.equal(Boolean(liveBugGuarded.meta?.winnerModeActive), false);
assert.equal(Boolean(liveBugGuarded.meta?.structureTrailAllowed), false);
assert.equal(liveBugGuarded.meta?.structureTrailSource, "GATED");
assert.equal(Boolean(liveBugGuarded.meta?.stopImproveAuthorized), false);
assert.equal(
  Number(liveBugGuarded.meta?.executableHardFloor ?? 0),
  166.45,
);
assert.equal(Number(liveBugGuarded.meta?.desiredStopLoss ?? 0), 166.45);
assert.equal(liveBugGuarded.meta?.finalStopLoss ?? null, null);
assert.equal(
  Array.isArray(liveBugGuarded.meta?.reasonTags) &&
    liveBugGuarded.meta.reasonTags.includes("STRUCTURE_TRAIL_GATED"),
  true,
);

const legacyCompatFieldsIgnored = computeDynamicExitPlan({
  trade: makeTrade({
    minGreenInr: 80,
    minGreenPts: 8,
    beLockHit: true,
    trailHit: true,
  }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 99, TRAIL_ARM_R: 99 }),
});

assert.equal(legacyCompatFieldsIgnored.ok, true);
assert.equal(Boolean(legacyCompatFieldsIgnored.meta?.beArmed), false);
assert.equal(Boolean(legacyCompatFieldsIgnored.meta?.beApplied), false);
assert.equal(Boolean(legacyCompatFieldsIgnored.meta?.trailArmed), false);
assert.equal(Boolean(legacyCompatFieldsIgnored.meta?.trailAllowed), false);

const minHoldBlocked = computeDynamicExitPlan({
  trade: makeTrade({ beLocked: true }),
  ltp: 107,
  candles: flatCandles(),
  nowTs: BASE_NOW + 5_000,
  env: makeEnv({ DYNAMIC_EXIT_MIN_HOLD_MS: 20_000, DYNAMIC_EXIT_EARLY_TIGHTEN_MIN_R: 1.0 }),
});

assert.equal(minHoldBlocked.ok, true);
assert.equal(minHoldBlocked.sl, null);
assert.equal(Boolean(String(minHoldBlocked.reason || "").includes("MIN_HOLD_BLOCK")), true);

const spreadBlocked = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    greenLockActive: true,
    peakPnlInr: 160,
    peakPnlR: 1.6,
  }),
  ltp: 112,
  marketQuote: { bid: 106, ask: 116, ltp: 112 },
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env,
  underlyingLtp: 20110,
});

assert.equal(spreadBlocked.ok, true);
assert.ok(Number(spreadBlocked.finalStop ?? 0) > 90);
assert.equal(Boolean(spreadBlocked.meta?.protectionSafetyUpgrade), true);
assert.equal(Boolean(spreadBlocked.meta?.spreadGuardBypassed), true);
assert.equal(Boolean(spreadBlocked.meta?.protectionGateOpen), true);

const distanceBlocked = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    greenLockActive: true,
    peakPnlInr: 160,
    peakPnlR: 1.6,
  }),
  ltp: 112,
  marketQuote: { bid: 101.25, ask: 101.35, ltp: 112 },
  candles: flatCandles(),
  nowTs: BASE_NOW + 6 * 60_000,
  env,
  underlyingLtp: 20110,
});

assert.equal(distanceBlocked.ok, true);
assert.ok(Number(distanceBlocked.finalStop ?? 0) > 90);
assert.equal(Boolean(distanceBlocked.meta?.protectionSafetyUpgrade), true);
assert.equal(Boolean(distanceBlocked.meta?.distanceGuardBypassed), true);

const strategyAnchorPlan = computeDynamicExitPlan({
  trade: makeTrade({
    strategyStopLoss: 90,
    initialStopLoss: 98,
    brokerStopLoss: 98,
    stopLoss: 98,
  }),
  ltp: 104,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env,
});

assert.equal(strategyAnchorPlan.ok, true);
assert.equal(Boolean(strategyAnchorPlan.greenLockActive), false);
assert.equal(Boolean(strategyAnchorPlan.beLocked), false);

const belowTighten = computeDynamicExitPlan({
  trade: makeTrade({ beLocked: true }),
  ltp: 109,
  candles: flatCandles(),
  nowTs: BASE_NOW + 3 * 60_000,
  env,
});

assert.equal(belowTighten.ok, true);
assert.equal(Boolean(belowTighten.tightenActive), false);

const aboveTighten = computeDynamicExitPlan({
  trade: makeTrade({
    beLocked: true,
    peakExecutablePnlInr: 105,
    peakExecutableR: 1.05,
    peakPnlInr: 105,
    peakPnlR: 1.05,
  }),
  ltp: 109,
  candles: flatCandles(),
  nowTs: BASE_NOW + 3 * 60_000,
  env,
});

assert.equal(aboveTighten.ok, true);
assert.equal(Boolean(aboveTighten.tightenActive), true);
assert.ok(Number(aboveTighten.meta?.tightenActivatedAtR ?? 0) >= 1.0);
assert.equal(Number(aboveTighten.meta?.post1RTrailGapR ?? 0), 0.25);
assert.ok(Number(aboveTighten.meta?.post1RTrailFloorPrice ?? 0) > 0);
assert.ok(Number(aboveTighten.finalStop ?? 0) > Number(belowTighten.finalStop ?? 0));

const weakRegimeTightenSuppressed = computeDynamicExitPlan({
  trade: makeTrade({
    beLocked: true,
    regime: "RANGE",
    peakExecutablePnlInr: 105,
    peakExecutableR: 1.05,
    peakPnlInr: 105,
    peakPnlR: 1.05,
  }),
  ltp: 109,
  candles: flatCandles(),
  nowTs: BASE_NOW + 3 * 60_000,
  env: makeEnv({
    EXIT_TIGHTEN_AT_R: 1.0,
    EXIT_TIGHTEN_WEAK_REGIME_GOVERNOR_ENABLED: true,
    EXIT_TIGHTEN_WEAK_REGIMES: "RANGE,CHOP,WEAK",
  }),
});

const weakRegimeTightenDisabled = computeDynamicExitPlan({
  trade: makeTrade({
    beLocked: true,
    regime: "RANGE",
    peakExecutablePnlInr: 105,
    peakExecutableR: 1.05,
    peakPnlInr: 105,
    peakPnlR: 1.05,
  }),
  ltp: 109,
  candles: flatCandles(),
  nowTs: BASE_NOW + 3 * 60_000,
  env: makeEnv({
    EXIT_TIGHTEN_AT_R: 1.0,
    EXIT_TIGHTEN_WEAK_REGIME_GOVERNOR_ENABLED: false,
  }),
});

assert.equal(Boolean(weakRegimeTightenSuppressed.tightenActive), false);
assert.equal(Boolean(weakRegimeTightenSuppressed.meta?.tightenSuppressedByWeakRegime), true);
assert.equal(weakRegimeTightenSuppressed.meta?.tightenMarketRegime, "RANGE");
assert.equal(Boolean(weakRegimeTightenDisabled.tightenActive), true);

const beBlockedByMinGreen = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 80, minGreenPts: 8 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 1.2 }),
});

assert.equal(beBlockedByMinGreen.ok, true);
assert.equal(Boolean(beBlockedByMinGreen.meta?.minGreenSatisfied), false);
assert.equal(Boolean(beBlockedByMinGreen.meta?.beEligible), false);
assert.equal(Boolean(beBlockedByMinGreen.meta?.beArmed), false);
assert.equal(Boolean(beBlockedByMinGreen.meta?.beApplied), false);
assert.equal(Boolean(beBlockedByMinGreen.meta?.trailAllowed), false);
assert.equal(beBlockedByMinGreen.meta?.protectedStopSource ?? null, null);

const beArmedPendingBroker = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 40, minGreenPts: 4 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 1.2 }),
});

assert.equal(beArmedPendingBroker.ok, true);
assert.equal(Boolean(beArmedPendingBroker.meta?.minGreenSatisfied), true);
assert.equal(Boolean(beArmedPendingBroker.meta?.beEligible), true);
assert.equal(Boolean(beArmedPendingBroker.meta?.beArmed), true);
assert.equal(Boolean(beArmedPendingBroker.meta?.beApplied), false);
assert.equal(Boolean(beArmedPendingBroker.meta?.trailAllowed), false);
assert.equal(Boolean(beArmedPendingBroker.meta?.trailActive), false);
assert.equal(Boolean(beArmedPendingBroker.meta?.forceBePriorityMove), true);
assert.equal(beArmedPendingBroker.meta?.trailBlockReason, "WAITING_FOR_BE_APPLY_OR_TRAIL_ARM");
assert.equal(beArmedPendingBroker.meta?.peakLtp ?? null, null);
assert.equal(beArmedPendingBroker.meta?.trailPeakStartedAt ?? null, null);
assert.ok(Number(beArmedPendingBroker.sl?.stopLoss ?? 0) >= Number(beArmedPendingBroker.meta?.beFloor ?? 0));

const beAppliedTrailAllowed = computeDynamicExitPlan({
  trade: makeTrade({
    minGreenInr: 40,
    minGreenPts: 4,
    beLocked: true,
    stopLoss: 104.35,
    beAppliedAt: new Date(BASE_NOW + 60_000).toISOString(),
    beAppliedStopLoss: 104.35,
  }),
  ltp: 114,
  candles: flatCandles(),
  nowTs: BASE_NOW + 4 * 60_000,
  env: protectionEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 2.5 }),
});

assert.equal(beAppliedTrailAllowed.ok, true);
assert.equal(Boolean(beAppliedTrailAllowed.meta?.beApplied), true);
assert.equal(Boolean(beAppliedTrailAllowed.meta?.trailArmed), false);
assert.equal(Boolean(beAppliedTrailAllowed.meta?.trailAllowed), true);
assert.equal(Boolean(beAppliedTrailAllowed.meta?.trailActive), true);
assert.equal(Number(beAppliedTrailAllowed.meta?.peakLtp ?? 0), 114);
assert.ok(beAppliedTrailAllowed.meta?.trailPeakStartedAt);
assert.equal(beAppliedTrailAllowed.meta?.protectedStopSource, "TRAIL");

const trailBlockedByMinGreen = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 80, minGreenPts: 8 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 99, TRAIL_ARM_R: 0.5 }),
});

assert.equal(trailBlockedByMinGreen.ok, true);
assert.equal(Boolean(trailBlockedByMinGreen.meta?.minGreenSatisfied), false);
assert.equal(Boolean(trailBlockedByMinGreen.meta?.trailEligible), false);
assert.equal(Boolean(trailBlockedByMinGreen.meta?.trailArmed), false);
assert.equal(Boolean(trailBlockedByMinGreen.meta?.trailAllowed), false);
assert.equal(Boolean(trailBlockedByMinGreen.meta?.trailActive), false);
assert.equal(trailBlockedByMinGreen.meta?.trailBlockReason, "MIN_GREEN_NOT_SATISFIED");
assert.equal(trailBlockedByMinGreen.meta?.peakLtp ?? null, null);
assert.equal(trailBlockedByMinGreen.meta?.trailPeakStartedAt ?? null, null);

const trailAllowedWithMinGreen = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 30, minGreenPts: 3 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 99, TRAIL_ARM_R: 0.5 }),
});

assert.equal(trailAllowedWithMinGreen.ok, true);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.minGreenSatisfied), true);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.beArmed), false);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.beApplied), false);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.trailEligible), true);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.trailArmed), true);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.trailAllowed), true);
assert.equal(Boolean(trailAllowedWithMinGreen.meta?.trailActive), true);
assert.equal(Number(trailAllowedWithMinGreen.meta?.peakLtp ?? 0), 106);
assert.ok(trailAllowedWithMinGreen.meta?.trailPeakStartedAt);
assert.equal(trailAllowedWithMinGreen.meta?.protectedStopSource, "TRAIL");
assert.ok(Number(trailAllowedWithMinGreen.sl?.stopLoss ?? 0) > 90);

const aggressiveTrailSettings = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 30, minGreenPts: 3 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({
    BE_ARM_R: 99,
    TRAIL_ARM_R: 0.5,
    TRAIL_GAP_POST_BE_PCT: 0.04,
    TRAIL_GAP_POST_BE_PCT_TIGHT: 0.03,
    TRAIL_TIGHTEN_R: 1.5,
    DYN_STEP_TICKS_POST_BE: 5,
  }),
});

const conservativeTrailSettings = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 30, minGreenPts: 3 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({
    BE_ARM_R: 0.8,
    TRAIL_ARM_R: 1.35,
    TRAIL_GAP_POST_BE_PCT: 0.06,
    TRAIL_GAP_POST_BE_PCT_TIGHT: 0.05,
    TRAIL_TIGHTEN_R: 2.2,
    DYN_STEP_TICKS_POST_BE: 8,
  }),
});

assert.equal(Boolean(aggressiveTrailSettings.meta?.trailAllowed), true);
assert.equal(Boolean(conservativeTrailSettings.meta?.trailAllowed), false);

const tp1OverrideTrailAllowed = computeDynamicExitPlan({
  trade: makeTrade({
    minGreenInr: 40,
    minGreenPts: 4,
    tp1Done: true,
  }),
  ltp: 105,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: protectionEnv({ BE_ARM_R: 99, TRAIL_ARM_R: 99 }),
});

assert.equal(tp1OverrideTrailAllowed.ok, true);
assert.equal(Boolean(tp1OverrideTrailAllowed.meta?.minGreenSatisfied), true);
assert.equal(Boolean(tp1OverrideTrailAllowed.meta?.beApplied), false);
assert.equal(Boolean(tp1OverrideTrailAllowed.meta?.trailArmed), false);
assert.equal(Boolean(tp1OverrideTrailAllowed.meta?.trailAllowed), true);
assert.equal(Boolean(tp1OverrideTrailAllowed.meta?.trailActive), true);
assert.equal(Number(tp1OverrideTrailAllowed.meta?.peakLtp ?? 0), 105);
assert.ok(tp1OverrideTrailAllowed.meta?.trailPeakStartedAt);
assert.equal(tp1OverrideTrailAllowed.meta?.protectedStopSource, "TRAIL");

const beArmedMaxHoldStillExits = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 40, minGreenPts: 4 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: maxHoldEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 99 }),
});

assert.equal(beArmedMaxHoldStillExits.ok, true);
assert.equal(Boolean(beArmedMaxHoldStillExits.meta?.beApplied), false);
assert.equal(Boolean(beArmedMaxHoldStillExits.meta?.trailAllowed), false);
assert.equal(Boolean(beArmedMaxHoldStillExits.meta?.maxHoldProtectionActive), false);
assert.equal(beArmedMaxHoldStillExits.meta?.maxHoldProtectionSource ?? null, null);
assert.equal(beArmedMaxHoldStillExits.meta?.maxHoldSkipReason ?? null, null);
assert.equal(Boolean(beArmedMaxHoldStillExits.action?.exitNow), true);
assert.equal(beArmedMaxHoldStillExits.action?.reason, "TIME_STOP_MAX_HOLD");

const beAppliedMaxHoldSkipped = computeDynamicExitPlan({
  trade: makeTrade({
    minGreenInr: 40,
    minGreenPts: 4,
    beLocked: true,
    stopLoss: 104.35,
    beAppliedAt: new Date(BASE_NOW + 60_000).toISOString(),
    beAppliedStopLoss: 104.35,
  }),
  ltp: 114,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: maxHoldEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 2.5 }),
});

assert.equal(beAppliedMaxHoldSkipped.ok, true);
assert.equal(Boolean(beAppliedMaxHoldSkipped.action?.exitNow), false);
assert.equal(Boolean(beAppliedMaxHoldSkipped.meta?.maxHoldProtectionActive), true);
assert.equal(beAppliedMaxHoldSkipped.meta?.maxHoldProtectionSource, "BE_APPLIED");
assert.equal(beAppliedMaxHoldSkipped.meta?.maxHoldSkipReason, "LIVE_PROTECTION");

const trailAllowedMaxHoldSkipped = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 30, minGreenPts: 3 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: maxHoldEnv({ BE_ARM_R: 99, TRAIL_ARM_R: 0.5 }),
});

assert.equal(trailAllowedMaxHoldSkipped.ok, true);
assert.equal(Boolean(trailAllowedMaxHoldSkipped.action?.exitNow), false);
assert.equal(Boolean(trailAllowedMaxHoldSkipped.meta?.maxHoldProtectionActive), true);
assert.equal(trailAllowedMaxHoldSkipped.meta?.maxHoldProtectionSource, "TRAIL_ALLOWED");
assert.equal(trailAllowedMaxHoldSkipped.meta?.maxHoldSkipReason, "LIVE_PROTECTION");

const thresholdHitButNotLiveMaxHold = computeDynamicExitPlan({
  trade: makeTrade({ minGreenInr: 40, minGreenPts: 4 }),
  ltp: 106,
  candles: flatCandles(),
  nowTs: BASE_NOW + 2 * 60_000,
  env: maxHoldEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 99 }),
});

assert.equal(thresholdHitButNotLiveMaxHold.ok, true);
assert.equal(Boolean(thresholdHitButNotLiveMaxHold.meta?.beApplied), false);
assert.equal(Boolean(thresholdHitButNotLiveMaxHold.meta?.trailAllowed), false);
assert.equal(Boolean(thresholdHitButNotLiveMaxHold.meta?.maxHoldProtectionActive), false);
assert.equal(Boolean(thresholdHitButNotLiveMaxHold.action?.exitNow), true);
assert.equal(thresholdHitButNotLiveMaxHold.action?.reason, "TIME_STOP_MAX_HOLD");

const liveRiskBasisPlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    riskInr: 200,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
  }),
  ltp: 110,
  marketQuote: {
    bid: 109,
    ask: 109.2,
    ltp: 110,
    timestampMs: BASE_NOW + 8 * 60_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 8 * 60_000 + 500,
  env,
  underlyingLtp: 20120,
});

assert.equal(Number(liveRiskBasisPlan.meta?.executionRiskInr ?? 0), 100);
assert.equal(Number(liveRiskBasisPlan.meta?.budgetRiskInr ?? 0), 200);
assert.equal(
  Math.round(Number(liveRiskBasisPlan.meta?.currentExecutableR ?? 0) * 100) /
    100,
  0.9,
);

const freshExecutableQuotePlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
  }),
  ltp: 110,
  marketQuote: {
    bid: 111,
    ask: 111.2,
    ltp: 110,
    timestampMs: BASE_NOW + 9 * 60_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 9 * 60_000 + 200,
  env,
  underlyingLtp: 20120,
});

const staleExecutableQuotePlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
  }),
  ltp: 110,
  marketQuote: {
    bid: 111,
    ask: 111.2,
    ltp: 110,
    timestampMs: BASE_NOW + 9 * 60_000 - 10_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 9 * 60_000 + 200,
  env,
  underlyingLtp: 20120,
});

const ltpOnlyQuotePlan = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    executionRiskPts: 10,
    executionRiskQty: 10,
    executionRiskInr: 100,
  }),
  ltp: 112,
  marketQuote: {
    ltp: 112,
    timestampMs: BASE_NOW + 9 * 60_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 9 * 60_000 + 200,
  env,
  underlyingLtp: 20120,
});

assert.equal(freshExecutableQuotePlan.meta?.quoteQuality, "FRESH_EXECUTABLE");
assert.equal(Number(freshExecutableQuotePlan.meta?.currentExecutablePrice ?? 0), 111);
assert.equal(staleExecutableQuotePlan.meta?.quoteQuality, "STALE_EXECUTABLE");
assert.equal(Number(staleExecutableQuotePlan.meta?.currentExecutablePrice ?? 0), 110);
assert.ok(
  Number(staleExecutableQuotePlan.meta?.currentExecutableR ?? 0) <
    Number(freshExecutableQuotePlan.meta?.currentExecutableR ?? 0),
);
assert.equal(ltpOnlyQuotePlan.meta?.quoteQuality, "LTP_ONLY");
assert.equal(ltpOnlyQuotePlan.meta?.executablePriceSource, "LTP_FALLBACK");
assert.ok(Number(ltpOnlyQuotePlan.meta?.currentExecutablePrice ?? 0) < 112);

const beSafetyBypassesWideSpread = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    minGreenInr: 40,
    minGreenPts: 4,
  }),
  ltp: 106,
  marketQuote: {
    bid: 90,
    ask: 120,
    ltp: 106,
    timestampMs: BASE_NOW + 10 * 60_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 10 * 60_000 + 100,
  env: protectionEnv({ BE_ARM_R: 0.6, TRAIL_ARM_R: 1.2 }),
  underlyingLtp: 20010,
});

assert.equal(Boolean(beSafetyBypassesWideSpread.meta?.beArmed), true);
assert.equal(Boolean(beSafetyBypassesWideSpread.meta?.protectionSafetyUpgrade), true);
assert.equal(Boolean(beSafetyBypassesWideSpread.meta?.spreadGuardBypassed), true);
assert.ok(
  Number(beSafetyBypassesWideSpread.sl?.stopLoss ?? 0) >=
    Number(beSafetyBypassesWideSpread.meta?.beFloor ?? 0),
);

const healthyOptionWidenAllowed = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    stopLoss: 95,
    strategyStopLoss: 90,
    initialStopLoss: 90,
    option_meta: { optType: "CE", underlyingLtp: 20000 },
    planMeta: { underlying: { entry: 20000, stop: 19950 } },
  }),
  ltp: 94,
  marketQuote: {
    bid: 93.95,
    ask: 94.05,
    ltp: 94,
    timestampMs: BASE_NOW + 30_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 60_000,
  env: makeEnv({
    OPT_EXIT_ALLOW_WIDEN_SL: "true",
    OPT_EXIT_WIDEN_WINDOW_MIN: 2,
    OPT_EXIT_WIDEN_MAX_EXEC_SPREAD_BPS: 40,
    OPT_EXIT_WIDEN_MAX_ADVERSE_UNDERLYING_BPS: 18,
  }),
  underlyingLtp: 19998,
});

const thesisFailingWidenBlocked = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    stopLoss: 95,
    strategyStopLoss: 90,
    initialStopLoss: 90,
    option_meta: { optType: "CE", underlyingLtp: 20000 },
    planMeta: { underlying: { entry: 20000, stop: 19950 } },
  }),
  ltp: 94,
  marketQuote: {
    bid: 93.95,
    ask: 94.05,
    ltp: 94,
    timestampMs: BASE_NOW + 30_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 60_000,
  env: makeEnv({
    OPT_EXIT_ALLOW_WIDEN_SL: "true",
    OPT_EXIT_WIDEN_WINDOW_MIN: 2,
    OPT_EXIT_WIDEN_MAX_EXEC_SPREAD_BPS: 40,
    OPT_EXIT_WIDEN_MAX_ADVERSE_UNDERLYING_BPS: 18,
  }),
  underlyingLtp: 19920,
});

const earlyFailActiveWidenBlocked = computeDynamicExitPlan({
  trade: makeTrade({
    instrument: optionInstrument,
    stopLoss: 95,
    strategyStopLoss: 90,
    initialStopLoss: 90,
    option_meta: { optType: "CE", underlyingLtp: 20000 },
    earlyFailCandidateReason: "EARLY_STRUCTURE_FAILURE",
    earlyFailDecisionState: "CONFIRMING",
  }),
  ltp: 94,
  marketQuote: {
    bid: 93.95,
    ask: 94.05,
    ltp: 94,
    timestampMs: BASE_NOW + 30_000,
  },
  candles: flatCandles(),
  nowTs: BASE_NOW + 60_000,
  env: makeEnv({
    OPT_EXIT_ALLOW_WIDEN_SL: "true",
    OPT_EXIT_WIDEN_WINDOW_MIN: 2,
    OPT_EXIT_WIDEN_MAX_EXEC_SPREAD_BPS: 40,
  }),
  underlyingLtp: 19998,
});

assert.equal(Boolean(healthyOptionWidenAllowed.meta?.allowWiden), true);
assert.equal(healthyOptionWidenAllowed.meta?.optionWidenBlockedReason ?? null, null);
assert.equal(Boolean(thesisFailingWidenBlocked.meta?.allowWiden), false);
assert.equal(
  thesisFailingWidenBlocked.meta?.optionWidenBlockedReason,
  "THESIS_INVALIDATING_STRUCTURE_BREAK",
);
assert.equal(Boolean(earlyFailActiveWidenBlocked.meta?.allowWiden), false);
assert.equal(
  earlyFailActiveWidenBlocked.meta?.optionWidenBlockedReason,
  "EARLY_FAIL_ACTIVE",
);

for (const key of [
  "minGreenSatisfied",
  "beArmed",
  "beApplied",
  "trailArmed",
  "trailAllowed",
  "beFloorSource",
]) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(beArmedPendingBroker.meta || {}, key),
    true,
  );
}

console.log("dynamicExitManager.test.js passed");
