const assert = require("node:assert/strict");

const {
  createAdmissionSnapshot,
  buildAdmissionContext,
  buildDecisionAudit,
  mergeDecisionStage,
  buildDecisionMeta,
  buildDecisionSignalPatch,
  bucketSpread,
  bucketHealth,
} = require("../../src/trading/admissionDecision");
const {
  getAdmissionProfile,
  hasExplicitAdmissionProfile,
  assertExplicitAdmissionProfiles,
  assertRuntimeAdmissionProfiles,
  shouldEnforceExplicitAdmissionProfiles,
} = require("../../src/trading/admissionProfiles");
const {
  resolveAdmissionThresholds,
} = require("../../src/trading/admissionThresholds");
const {
  enabledStrategyIds,
  STRATEGY_META,
} = require("../../src/strategy/registry");
const {
  resolvePostRouteConfidenceDecision,
} = require("../../src/trading/tradeManager");

const BASE_TS = Date.parse("2026-01-15T06:30:00.000Z");

function iso(ts) {
  return new Date(ts).toISOString();
}

function signal(overrides = {}) {
  return {
    signalId: "sig-breakout-1",
    strategyId: "breakout",
    strategyStyle: "TREND",
    side: "BUY",
    confidence: 79,
    signalCreatedAt: iso(BASE_TS),
    signalEventTs: iso(BASE_TS),
    candle: { ts: iso(BASE_TS), close: 105.1 },
    regimeSnapshot: {
      snapshotId: "reg-1",
      timestamp: iso(BASE_TS),
      regime: "TREND_COMPRESSED",
      regimeFamily: "TREND",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "BREAKOUT_WATCH",
      compressionActive: true,
    },
    meta: {
      anchorType: "RANGE_HIGH",
      anchorValue: 105,
      triggerType: "BREAKOUT_LEVEL",
      triggerLevel: 105,
      rangeHigh: 105,
      freshness: 88,
      retestState: "FIRST_BREAK",
      volumeQuality: 74,
      structureQuality: 78,
      boundaryQuality: 76,
      expansionQuality: 75,
    },
    ...overrides,
  };
}

{
  const snapshot = buildAdmissionContext({
    signal: signal(),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
  });
  let audit = buildDecisionAudit({ snapshot });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "ADJUSTED",
    stage: "admission",
    reason: "POST_ROUTE_CONFIDENCE_SOFT_PASS",
    meta: { softPassUsed: true },
  });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "READY_FOR_EXECUTION",
    stage: "entry",
    reason: "READY_FOR_EXECUTION",
    meta: {},
  });
  const meta = buildDecisionMeta({ snapshot, audit, meta: {} });
  assert.equal(meta.terminalOutcome, "ACCEPTED");
  assert.equal(meta.terminalReasonCode, "READY_FOR_EXECUTION");
}

{
  const snapshot = buildAdmissionContext({
    signal: signal(),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
  });
  let audit = buildDecisionAudit({ snapshot });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "ADJUSTED",
    stage: "admission",
    reason: "POST_ROUTE_CONFIDENCE_SOFT_PASS",
    meta: { softPassUsed: true },
  });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "BLOCKED",
    stage: "planner",
    reason: "TARGET_BELOW_MIN_RR",
    meta: {},
  });
  const meta = buildDecisionMeta({ snapshot, audit, meta: {} });
  assert.equal(meta.terminalOutcome, "BLOCKED");
  assert.equal(meta.terminalReasonCode, "TARGET_BELOW_MIN_RR");
}

{
  const snapshot = buildAdmissionContext({
    signal: signal(),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
  });
  let audit = buildDecisionAudit({ snapshot });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "READY_FOR_EXECUTION",
    stage: "entry",
    reason: "READY_FOR_EXECUTION",
    meta: {},
  });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "ADJUSTED",
    stage: "optimizer",
    reason: "OPTIMIZER_RR_TUNE_ONLY",
    meta: {},
  });
  const meta = buildDecisionMeta({ snapshot, audit, meta: {} });
  assert.equal(meta.terminalOutcome, "ACCEPTED");
  assert.equal(meta.terminalReasonCode, "READY_FOR_EXECUTION");
}

{
  const baseSignal = signal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    signalId: "sig-ema-1",
    confidence: 78,
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.18,
      pullbackAnchor: 100.08,
      trendAnchor: 99.72,
      freshness: 90,
    },
  });
  const profile = getAdmissionProfile("ema_pullback", "TREND");
  const baseSnapshot = createAdmissionSnapshot({
    signal: baseSignal,
    profile,
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });

  const freshStage = buildAdmissionContext({
    baseSnapshot,
    signal: {
      ...baseSignal,
      routeConfidence: {
        preRouteScore: 78,
        routedScore: 75,
        contractMetrics: {
          spreadBps: 18,
          healthScore: 76,
          depth: 40,
          eligibilityPassed: true,
          minEligibilityChecksPassed: true,
        },
      },
      option_meta: {
        bps: 18,
        health_score: 76,
        depth: 40,
      },
    },
    quote: { ts: iso(BASE_TS + 2_000), bps: 18 },
    premiumPlanData: {
      readinessState: "ready",
      lastCandleTs: iso(BASE_TS + 2_000),
    },
    profile,
    nowTs: BASE_TS + 5_000,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });

  const staleStage = buildAdmissionContext({
    baseSnapshot,
    signal: {
      ...baseSignal,
      routeConfidence: {
        preRouteScore: 78,
        routedScore: 75,
        contractMetrics: {
          spreadBps: 18,
          healthScore: 76,
          depth: 40,
          eligibilityPassed: true,
          minEligibilityChecksPassed: true,
        },
      },
      option_meta: {
        bps: 18,
        health_score: 76,
        depth: 40,
      },
    },
    quote: { ts: iso(BASE_TS + 2_000), bps: 18 },
    premiumPlanData: {
      readinessState: "ready",
      lastCandleTs: iso(BASE_TS + 2_000),
    },
    profile,
    nowTs: BASE_TS + 250_000,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });

  assert.equal(baseSnapshot.family, "ema_pullback");
  assert.equal(freshStage.family, baseSnapshot.family);
  assert.equal(staleStage.family, baseSnapshot.family);
  assert.equal(freshStage.triggerLevel, baseSnapshot.triggerLevel);
  assert.equal(staleStage.triggerLevel, baseSnapshot.triggerLevel);
  assert.equal(freshStage.anchorValue, baseSnapshot.anchorValue);
  assert.equal(staleStage.anchorValue, baseSnapshot.anchorValue);
  assert.equal(freshStage.snapshotTs, baseSnapshot.snapshotTs);
  assert.equal(staleStage.snapshotTs, baseSnapshot.snapshotTs);
  assert.notEqual(freshStage.stageEvaluatedAt, staleStage.stageEvaluatedAt);
  assert.equal(freshStage.readiness.state, "READY");
  assert.equal(staleStage.readiness.state, "BLOCKED_STALE");
  assert.ok(staleStage.readiness.quoteAgeMs > freshStage.readiness.quoteAgeMs);
  assert.ok(staleStage.readiness.premiumAgeMs > freshStage.readiness.premiumAgeMs);
}

{
  const snapshot = buildAdmissionContext({
    signal: signal(),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
  });
  const audit = buildDecisionAudit({ snapshot });
  const meta = buildDecisionMeta({ snapshot, audit, meta: {} });
  assert.equal(meta.softPassSupported, true);
  assert.equal(meta.softPassUsed, false);
  assert.equal(meta.softPassProfile, null);
  assert.equal(meta.transitionPassSupported, true);
  assert.equal(meta.transitionPassUsed, false);
  assert.equal(meta.transitionPassProfile, null);
  assert.equal(meta.legacyFallbackSupported, false);
  assert.equal(meta.legacyFallbackUsed, false);
  assert.equal(meta.snapshotTs, snapshot.snapshotTs);
  assert.equal(meta.stageEvaluatedAt, snapshot.stageEvaluatedAt);
}

{
  const activeStrategies = enabledStrategyIds();
  assertExplicitAdmissionProfiles(activeStrategies);
  assert.equal(hasExplicitAdmissionProfile("orb"), true);
  assert.equal(getAdmissionProfile("orb", "OPEN").profileId, "open:orb_core");
  assert.ok(Object.keys(STRATEGY_META).every((strategyId) => hasExplicitAdmissionProfile(strategyId)));
  assert.throws(
    () => assertExplicitAdmissionProfiles(["ema_pullback", "missing_strategy"]),
    /MISSING_ADMISSION_PROFILES:missing_strategy/,
  );
  assert.equal(
    shouldEnforceExplicitAdmissionProfiles({ nodeEnv: "development" }),
    true,
  );
  assert.equal(
    shouldEnforceExplicitAdmissionProfiles({ nodeEnv: "production", strict: false }),
    false,
  );
  assert.equal(
    shouldEnforceExplicitAdmissionProfiles({ nodeEnv: "production", strict: true }),
    true,
  );
  assert.doesNotThrow(() =>
    assertRuntimeAdmissionProfiles(["ema_pullback", "orb"], {
      nodeEnv: "development",
    }),
  );
  assert.throws(
    () =>
      assertRuntimeAdmissionProfiles(["ema_pullback", "missing_strategy"], {
        nodeEnv: "development",
      }),
    /MISSING_ADMISSION_PROFILES:missing_strategy/,
  );
  assert.doesNotThrow(() =>
    assertRuntimeAdmissionProfiles(["ema_pullback", "missing_strategy"], {
      nodeEnv: "production",
      strict: false,
    }),
  );
}

{
  const breakoutThresholds = resolveAdmissionThresholds({
    profile: getAdmissionProfile("breakout", "TREND"),
  });
  const orbThresholds = resolveAdmissionThresholds({
    profile: getAdmissionProfile("orb", "OPEN"),
  });

  assert.equal(breakoutThresholds.routeQuality.maxSpreadBps, 35);
  assert.equal(breakoutThresholds.routeQuality.minHealthScore, 45);
  assert.equal(breakoutThresholds.routeQuality.minDepth, 8);
  assert.equal(
    breakoutThresholds.softPass.profileId,
    "trend_near_threshold_clean_contract",
  );
  assert.equal(breakoutThresholds.softPass.maxConfidenceGap, 5);
  assert.equal(breakoutThresholds.softPass.spreadLimit, 28);
  assert.equal(orbThresholds.softPass.profileId, "open_near_threshold_clean_contract");
  assert.equal(orbThresholds.softPass.maxConfidenceGap, 4);
  assert.equal(orbThresholds.softPass.depthFloor, 10);
}

{
  const profile = getAdmissionProfile("orb", "OPEN");
  const config = {
    OPT_MAX_SPREAD_BPS: 40,
    OPT_HEALTH_SCORE_MIN: 50,
    POST_ROUTE_CONFIDENCE_SOFT_BAND: 3,
  };
  const thresholds = resolveAdmissionThresholds({ config, profile });
  const routeSignal = {
    signalId: "sig-orb-thresholds",
    strategyId: "orb",
    strategyStyle: "OPEN",
    side: "BUY",
    confidence: 71,
    signalCreatedAt: iso(BASE_TS),
    signalEventTs: iso(BASE_TS),
    candle: { ts: iso(BASE_TS), close: 101.2 },
    meta: {
      anchorType: "ORB_HIGH",
      anchorValue: 101.0,
      triggerType: "BREAKOUT_LEVEL",
      triggerLevel: 101.0,
      rangeHigh: 101.0,
      freshness: 87,
    },
    option_meta: {
      bps: 32,
      health_score: 57,
      depth: 16,
    },
    routeConfidence: {
      preRouteScore: 75,
      expectedRouteAdjustment: -4,
      routedScore: 71,
      contractMetrics: {
        spreadBps: 32,
        healthScore: 57,
        depth: 16,
        eligibilityPassed: true,
        minEligibilityChecksPassed: true,
        selectedByFallback: false,
      },
    },
  };
  const snapshot = buildAdmissionContext({
    signal: routeSignal,
    profile,
    nowTs: BASE_TS + 1_000,
    env: config,
  });
  const postRoute = resolvePostRouteConfidenceDecision({
    signal: routeSignal,
    conf: 71,
    minConf: 74,
    config,
  });

  assert.equal(
    snapshot.spreadBucket,
    bucketSpread(routeSignal.option_meta.bps, thresholds.routeQuality.maxSpreadBps),
  );
  assert.equal(
    postRoute.meta.spreadBucket,
    bucketSpread(routeSignal.option_meta.bps, thresholds.routeQuality.maxSpreadBps),
  );
  assert.equal(
    postRoute.meta.healthBucket,
    bucketHealth(
      routeSignal.option_meta.health_score,
      thresholds.routeQuality.weakHealthFloor,
    ),
  );
}

{
  const snapshot = buildAdmissionContext({
    signal: signal(),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
  });
  let audit = buildDecisionAudit({ snapshot });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "ADJUSTED",
    stage: "admission",
    reason: "POST_ROUTE_CONFIDENCE_SOFT_PASS",
    meta: { softPassUsed: true, softPassProfile: "trend_near_threshold_clean_contract" },
  });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: "BLOCKED",
    stage: "planner",
    reason: "TARGET_BELOW_MIN_RR",
    meta: { plannerPathUsed: "MODERN" },
  });
  const finalizedA = buildDecisionSignalPatch({
    signal: signal(),
    priorConversionSummary: { postRouteDecision: "SOFT_PASS" },
    snapshot,
    audit,
    outcome: "BLOCKED",
    stage: "planner",
    reason: "TARGET_BELOW_MIN_RR",
    meta: { plannerPathUsed: "MODERN" },
  });
  const finalizedB = buildDecisionSignalPatch({
    signal: signal(),
    priorConversionSummary: { postRouteDecision: "PASSED" },
    snapshot,
    audit,
    outcome: "BLOCKED",
    stage: "planner",
    reason: "TARGET_BELOW_MIN_RR",
    meta: { plannerPathUsed: "MODERN" },
  });

  assert.equal(finalizedA.decisionMeta.terminalOutcome, "BLOCKED");
  assert.equal(finalizedA.decisionMeta.terminalReasonCode, "TARGET_BELOW_MIN_RR");
  assert.equal(finalizedA.conversionPatch.finalOutcome, "BLOCKED_PLANNER");
  assert.equal(finalizedA.decisionMeta.terminalOutcome, finalizedB.decisionMeta.terminalOutcome);
  assert.equal(
    finalizedA.decisionMeta.terminalReasonCode,
    finalizedB.decisionMeta.terminalReasonCode,
  );
  assert.equal(
    finalizedA.conversionPatch.plannerPathUsed,
    finalizedA.decisionMeta.plannerPathUsed,
  );
  assert.equal(
    finalizedA.conversionPatch.softPassUsed,
    finalizedA.decisionMeta.softPassUsed,
  );
  assert.equal(
    finalizedA.conversionPatch.transitionPassUsed,
    finalizedA.decisionMeta.transitionPassUsed,
  );
  assert.equal(
    finalizedA.conversionPatch.legacyFallbackUsed,
    finalizedA.decisionMeta.legacyFallbackUsed,
  );
}

{
  const snapshot = buildAdmissionContext({
    signal: signal({
      intervalMin: 3,
      candle: { ts: iso(BASE_TS), interval_min: 3, close: 105.1 },
    }),
    quote: { ts: iso(BASE_TS), bps: 18 },
    premiumPlanData: {
      readinessState: "partial",
      lastCandleTs: iso(BASE_TS - 5 * 60_000),
    },
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });

  assert.equal(snapshot.readiness.state, "READY_DEGRADED");
  assert.equal(snapshot.readiness.premiumStaleAfterMs, 540_000);
  assert.equal(snapshot.readiness.premiumStaleThresholdSource, "interval_aware_fallback");
  assert.equal(snapshot.readiness.premiumStaleSource, null);
  assert.equal(snapshot.readiness.blockers.includes("PREMIUM_CONTEXT_STALE"), false);
  assert.equal(snapshot.readiness.degradedBy.includes("PREMIUM_CONTEXT_DEGRADED"), true);
}

{
  const snapshot = buildAdmissionContext({
    signal: signal({
      intervalMin: 3,
      candle: { ts: iso(BASE_TS), interval_min: 3, close: 105.1 },
    }),
    quote: { ts: iso(BASE_TS), bps: 18 },
    premiumPlanData: {
      readinessState: "partial",
      lastCandleTs: iso(BASE_TS - 5 * 60_000),
      staleAfterMs: 540_000,
    },
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });
  const meta = buildDecisionMeta({
    snapshot,
    audit: buildDecisionAudit({ snapshot }),
    meta: {},
  });

  assert.equal(snapshot.readiness.state, "READY_DEGRADED");
  assert.equal(snapshot.readiness.premiumStaleAfterMs, 540_000);
  assert.equal(snapshot.readiness.premiumStaleThresholdSource, "premiumPlanData.staleAfterMs");
  assert.equal(snapshot.readiness.blockers.includes("PREMIUM_CONTEXT_STALE"), false);
  assert.equal(meta.premiumStaleAfterMs, 540_000);
  assert.equal(meta.premiumStaleThresholdSource, "premiumPlanData.staleAfterMs");
}

{
  const snapshot = buildAdmissionContext({
    signal: signal({
      intervalMin: 3,
      candle: { ts: iso(BASE_TS), interval_min: 3, close: 105.1 },
    }),
    quote: { ts: iso(BASE_TS), bps: 18 },
    premiumPlanData: {
      readinessState: "partial",
      lastCandleTs: iso(BASE_TS - 10 * 60_000),
      staleAfterMs: 540_000,
    },
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });
  const meta = buildDecisionMeta({
    snapshot,
    audit: buildDecisionAudit({ snapshot }),
    meta: {},
  });

  assert.equal(snapshot.readiness.state, "BLOCKED_STALE");
  assert.equal(snapshot.readiness.premiumStaleSource, "interval_aware_age_check");
  assert.equal(snapshot.readiness.blockers.includes("PREMIUM_CONTEXT_STALE"), true);
  assert.equal(snapshot.readiness.premiumAgingThresholdMs, 60_000);
  assert.equal(meta.premiumStaleSource, "interval_aware_age_check");
  assert.equal(meta.premiumAgingThresholdMs, 60_000);
}

{
  const snapshot = buildAdmissionContext({
    signal: signal({
      intervalMin: 3,
      candle: { ts: iso(BASE_TS), interval_min: 3, close: 105.1 },
    }),
    quote: { ts: iso(BASE_TS), bps: 18 },
    premiumPlanData: {
      readinessState: "stale",
      lastCandleTs: iso(BASE_TS - 10 * 60_000),
      staleAfterMs: 540_000,
    },
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 1_000_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });

  assert.equal(snapshot.readiness.state, "BLOCKED_STALE");
  assert.equal(snapshot.readiness.premiumStaleSource, "premium_readiness_state");
  assert.equal(snapshot.readiness.blockers.includes("PREMIUM_CONTEXT_STALE"), true);
}

{
  const snapshot = buildAdmissionContext({
    signal: signal({
      signalCreatedAt: null,
      signalEventTs: iso(BASE_TS - 60_000),
      signalDecisionTs: null,
      signalStage: "bar_close_confirmed",
      candle: { ts: iso(BASE_TS - 60_000), interval_min: 1, close: 105.1 },
    }),
    profile: getAdmissionProfile("breakout", "TREND"),
    nowTs: BASE_TS,
    env: {
      ADMISSION_SIGNAL_STALE_MS: 20_000,
      ADMISSION_REGIME_STALE_MS: 1_000_000,
      ADMISSION_QUOTE_STALE_MS: 10_000,
      ADMISSION_PREMIUM_STALE_MS: 60_000,
    },
  });
  const meta = buildDecisionMeta({
    snapshot,
    audit: buildDecisionAudit({ snapshot }),
    meta: {},
  });

  assert.equal(snapshot.readiness.state, "READY");
  assert.equal(snapshot.readiness.signalTsSource, "candleTs_fallback");
  assert.equal(snapshot.readiness.blockers.includes("SIGNAL_STALE"), false);
  assert.equal(snapshot.readiness.degradedBy.includes("SIGNAL_AGING"), false);
  assert.equal(meta.signalTsSource, "candleTs_fallback");
}

console.log("admissionDecision.test.js passed");
