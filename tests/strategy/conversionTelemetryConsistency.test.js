const assert = require("node:assert/strict");

const {
  buildSignalConversionSummary,
  freezeSignalRegimeSnapshot,
} = require("../../src/strategy/signalLifecycle");

function assertRouteTelemetryAligned(summary, detailedRouteConfidence) {
  assert.equal(
    Number(summary.preRouteScore),
    Number(detailedRouteConfidence.preRouteScore),
  );
  assert.equal(
    Number(summary.expectedRouteAdjustment),
    Number(detailedRouteConfidence.expectedRouteAdjustment),
  );
  assert.equal(
    Number(summary.routedConfidence),
    Number(detailedRouteConfidence.routedScore),
  );
}

function testSuppressedBeforeRoutingUsesEstimatedRouteTelemetry() {
  const detailedRouteConfidence = {
    preRouteScore: 50.4,
    expectedRouteAdjustment: -1.3,
    routedScore: 49.1,
    estimated: true,
  };
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-suppress-pre-route",
      strategyId: "ema_pullback",
      side: "BUY",
      regime: "TREND",
      confidence: 66.7,
      preEmit: {
        routeConfidence: detailedRouteConfidence,
      },
    },
    {
      preEmitDecision: "SUPPRESSED",
      routeAttempted: false,
      finalOutcome: "SUPPRESSED_CONFIDENCE",
      finalReasonCode: "LOW_PREEMIT_CONFIDENCE",
    },
  );

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeAttempted, false);
  assert.equal(summary.routeConfidenceBasis, "ESTIMATED");
}

function testEstimatedPreRouteOnlyTelemetryRemainsConsistent() {
  const detailedRouteConfidence = {
    preRouteScore: 47.8,
    expectedRouteAdjustment: -0.6,
    routedScore: 47.2,
    estimated: true,
  };
  const summary = buildSignalConversionSummary({
    signalId: "sig-estimated-only",
    strategyId: "ema_cross",
    side: "SELL",
    regime: "TREND_COMPRESSED",
    confidence: 67.2,
    preEmit: {
      routeConfidence: detailedRouteConfidence,
    },
  });

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeAttempted, false);
  assert.equal(summary.routeConfidenceBasis, "ESTIMATED");
}

function testActualRoutingTelemetryMatchesSummary() {
  const detailedRouteConfidence = {
    preRouteScore: 51.2,
    expectedRouteAdjustment: -0.4,
    routedScore: 50.8,
    estimated: false,
  };
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-actual-route",
      strategyId: "ema_pullback",
      side: "BUY",
      confidence: 50.8,
      regime: "TREND",
      option_meta: {
        instrument_token: 71001,
        underlying: "NIFTY",
        optType: "CE",
        strike: 25000,
        expiry: "2026-04-23",
      },
      routeConfidence: detailedRouteConfidence,
    },
    {
      routeAttempted: true,
      postRouteDecision: "ROUTED",
    },
  );

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeAttempted, true);
  assert.equal(summary.routeConfidenceBasis, "ACTUAL");
}

function testEstimatedRouteTelemetryOverridesStaleCurrentBasis() {
  const detailedRouteConfidence = {
    preRouteScore: 48.3,
    expectedRouteAdjustment: -0.7,
    routedScore: 47.6,
    estimated: true,
  };
  const summary = buildSignalConversionSummary({
    signalId: "sig-stale-route-basis-estimated",
    strategyId: "ema_cross",
    side: "BUY",
    regime: "TREND",
    preEmit: {
      routeConfidence: detailedRouteConfidence,
    },
    conversionSummary: {
      routeConfidenceBasis: "NONE",
    },
  });

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeConfidenceBasis, "ESTIMATED");
}

function testActualRouteTelemetryOverridesStaleCurrentBasis() {
  const detailedRouteConfidence = {
    preRouteScore: 55.2,
    expectedRouteAdjustment: -0.2,
    routedScore: 55,
    estimated: false,
  };
  const summary = buildSignalConversionSummary({
    signalId: "sig-stale-route-basis-actual",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND",
    confidence: 55,
    routeConfidence: detailedRouteConfidence,
    conversionSummary: {
      routeConfidenceBasis: "NONE",
    },
  });

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeConfidenceBasis, "ACTUAL");
}

function testRouteSoftPenaltySummaryStaysAligned() {
  const detailedRouteConfidence = {
    preRouteScore: 68.9,
    expectedRouteAdjustment: -2.1,
    routedScore: 66.8,
    estimated: true,
  };
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-soft-penalty",
      strategyId: "ema_pullback",
      side: "BUY",
      confidence: 68.9,
      regime: "TREND",
      preEmit: {
        routeConfidence: detailedRouteConfidence,
      },
    },
    {
      routeAttempted: false,
      preRouteScore: detailedRouteConfidence.preRouteScore,
      expectedRouteAdjustment: detailedRouteConfidence.expectedRouteAdjustment,
      routedConfidence: detailedRouteConfidence.routedScore,
    },
  );

  assertRouteTelemetryAligned(summary, detailedRouteConfidence);
  assert.equal(summary.routeAttempted, false);
  assert.equal(summary.routeConfidenceBasis, "ESTIMATED");
}

function testRouteNotAttemptedDoesNotInventRoutedConfidence() {
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-no-route",
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 72,
      regime: "TREND",
    },
    {
      routeAttempted: false,
    },
  );

  assert.equal(summary.preRouteScore, null);
  assert.equal(summary.expectedRouteAdjustment, null);
  assert.equal(summary.routedConfidence, null);
  assert.equal(summary.routeConfidenceBasis, "NONE");
}

function testRegimeSnapshotUsedWhenAvailable() {
  const snapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "TREND",
      primaryRegime: "TREND",
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: "2026-04-21T09:20:00+05:30",
    },
    selectorState: null,
    timestampMs: Date.parse("2026-04-21T09:20:05+05:30"),
  });

  const summary = buildSignalConversionSummary({
    signalId: "sig-regime-snapshot",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND",
    regimeSnapshot: snapshot,
  });

  assert.equal(summary.regime, "TREND");
  assert.equal(summary.regimeSource, "SNAPSHOT");
  assert.equal(summary.regimeFallbackReason, null);
}

function testConversionReusesFrozenRegimeSnapshotAcrossUpdates() {
  const snapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "TREND_COMPRESSED",
      primaryRegime: "TREND_COMPRESSED",
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: "2026-04-21T09:25:00+05:30",
    },
    selectorState: null,
    timestampMs: Date.parse("2026-04-21T09:25:05+05:30"),
  });

  const initialSummary = buildSignalConversionSummary({
    signalId: "sig-regime-freeze",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND_COMPRESSED",
    regimeSnapshot: snapshot,
  });

  const refreshedSummary = buildSignalConversionSummary({
    signalId: "sig-regime-freeze",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "RANGE",
    regimeSnapshot: snapshot,
    conversionSummary: initialSummary,
  });

  assert.equal(refreshedSummary.regime, "TREND_COMPRESSED");
  assert.equal(refreshedSummary.regimeSource, "SNAPSHOT");
}

function testFreshSnapshotRegimeMetaOverridesStaleCurrentFallbackMeta() {
  const snapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "TREND",
      primaryRegime: "TREND",
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: "2026-04-21T09:28:00+05:30",
    },
    selectorState: null,
    timestampMs: Date.parse("2026-04-21T09:28:05+05:30"),
  });

  const summary = buildSignalConversionSummary({
    signalId: "sig-regime-stale-meta",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND",
    regimeSnapshot: snapshot,
    conversionSummary: {
      regime: "TREND",
      regimeSource: "SIGNAL_FALLBACK",
      regimeFallbackReason: "SNAPSHOT_UNKNOWN",
    },
  });

  assert.equal(summary.regime, "TREND");
  assert.equal(summary.regimeSource, "SNAPSHOT");
  assert.equal(summary.regimeFallbackReason, null);
}

function testRegimeFallbackIsExplicitWhenSnapshotUnknown() {
  const unknownSnapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "UNKNOWN",
      primaryRegime: "UNKNOWN",
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: "2026-04-21T09:30:00+05:30",
    },
    selectorState: null,
    timestampMs: Date.parse("2026-04-21T09:30:05+05:30"),
  });

  const signal = {
    signalId: "sig-regime-fallback",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND",
    regimeSnapshot: unknownSnapshot,
  };
  const summary = buildSignalConversionSummary(signal);

  assert.equal(summary.regime, "TREND");
  assert.equal(summary.regimeSource, "SIGNAL_FALLBACK");
  assert.equal(summary.regimeFallbackReason, "SNAPSHOT_UNKNOWN");
  assert.equal(summary.regime, signal.regime);
}

function testCurrentFallbackMetadataCanBePreservedWithoutFreshMeta() {
  const summary = buildSignalConversionSummary({
    signalId: "sig-fallback-preserve",
    strategyId: "ema_cross",
    side: "SELL",
    conversionSummary: {
      regime: "TREND",
      regimeSource: "SIGNAL_FALLBACK",
      regimeFallbackReason: "SNAPSHOT_UNKNOWN",
      routeConfidenceBasis: "ACTUAL_INFERRED",
      routeAttempted: true,
    },
  });

  assert.equal(summary.regime, "TREND");
  assert.equal(summary.regimeSource, "SIGNAL_FALLBACK");
  assert.equal(summary.regimeFallbackReason, "SNAPSHOT_UNKNOWN");
  assert.equal(summary.routeConfidenceBasis, "ACTUAL_INFERRED");
}

function testExplicitPatchMetadataOverridesDerivedAndCurrent() {
  const detailedRouteConfidence = {
    preRouteScore: 52.9,
    expectedRouteAdjustment: -0.5,
    routedScore: 52.4,
    estimated: false,
  };
  const snapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "TREND",
      primaryRegime: "TREND",
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: "2026-04-21T09:35:00+05:30",
    },
    selectorState: null,
    timestampMs: Date.parse("2026-04-21T09:35:05+05:30"),
  });

  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-explicit-patch-meta",
      strategyId: "ema_pullback",
      side: "BUY",
      regime: "TREND",
      regimeSnapshot: snapshot,
      routeConfidence: detailedRouteConfidence,
      conversionSummary: {
        routeConfidenceBasis: "NONE",
        regimeSource: "SIGNAL_FALLBACK",
        regimeFallbackReason: "SNAPSHOT_UNKNOWN",
      },
    },
    {
      routeConfidenceBasis: "PATCH_BASIS",
      regimeSource: "PATCH_SOURCE",
      regimeFallbackReason: "PATCH_REASON",
    },
  );

  assert.equal(summary.routeConfidenceBasis, "PATCH_BASIS");
  assert.equal(summary.regimeSource, "PATCH_SOURCE");
  assert.equal(summary.regimeFallbackReason, "PATCH_REASON");
}

function testBlockedFragileReversalStyleGateTelemetry() {
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-fragile-blocked",
      strategyId: "wick_reversal",
      side: "BUY",
      regime: "TREND_COMPRESSED",
      strategyStyle: "RANGE",
    },
    {
      preEmitDecision: "SUPPRESSED",
      preEmitFailureReasons: ["FRAGILE_REVERSAL_MTF_DISAGREEMENT"],
      routeAttempted: false,
      finalReasonCode: "FRAGILE_REVERSAL_MTF_DISAGREEMENT",
      finalOutcome: "SUPPRESSED_STYLE_REGIME",
      marketState: "TREND_COMPRESSED",
      styleGateDecision: "BLOCK",
      styleGateReasonCode: "FRAGILE_REVERSAL_MTF_DISAGREEMENT",
      styleGateExceptionType: "FRAGILE_REVERSAL",
      styleGateFailedChecks: ["MTF_NOT_DISAGREEMENT"],
      exceptionAllowed: false,
    },
  );

  assert.equal(summary.styleGateDecision, "BLOCK");
  assert.equal(
    summary.styleGateReasonCode,
    "FRAGILE_REVERSAL_MTF_DISAGREEMENT",
  );
  assert.equal(summary.styleGateExceptionType, "FRAGILE_REVERSAL");
  assert.deepEqual(summary.styleGateFailedChecks, ["MTF_NOT_DISAGREEMENT"]);
  assert.equal(summary.marketState, "TREND_COMPRESSED");
  assert.equal(summary.exceptionAllowed, false);
  assert.equal(summary.finalOutcome, "SUPPRESSED_STYLE_REGIME");
}

function testAllowedFragileReversalStyleGateTelemetry() {
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-fragile-allowed",
      strategyId: "wick_reversal",
      side: "BUY",
      regime: "TREND_COMPRESSED",
      strategyStyle: "RANGE",
    },
    {
      preEmitDecision: "EMITTED",
      preEmitFailureReasons: [],
      routeAttempted: false,
      marketState: "TREND_COMPRESSED",
      styleGateDecision: "PASS_EXCEPTION",
      styleGateReasonCode: "FRAGILE_REVERSAL_CONFIRMED",
      styleGateExceptionType: "FRAGILE_REVERSAL",
      styleGateFailedChecks: [],
      exceptionAllowed: true,
    },
  );

  assert.equal(summary.styleGateDecision, "PASS_EXCEPTION");
  assert.equal(summary.styleGateReasonCode, "FRAGILE_REVERSAL_CONFIRMED");
  assert.equal(summary.styleGateExceptionType, "FRAGILE_REVERSAL");
  assert.deepEqual(summary.styleGateFailedChecks, []);
  assert.equal(summary.marketState, "TREND_COMPRESSED");
  assert.equal(summary.exceptionAllowed, true);
}

function main() {
  testSuppressedBeforeRoutingUsesEstimatedRouteTelemetry();
  testEstimatedPreRouteOnlyTelemetryRemainsConsistent();
  testActualRoutingTelemetryMatchesSummary();
  testEstimatedRouteTelemetryOverridesStaleCurrentBasis();
  testActualRouteTelemetryOverridesStaleCurrentBasis();
  testRouteSoftPenaltySummaryStaysAligned();
  testRouteNotAttemptedDoesNotInventRoutedConfidence();
  testRegimeSnapshotUsedWhenAvailable();
  testConversionReusesFrozenRegimeSnapshotAcrossUpdates();
  testFreshSnapshotRegimeMetaOverridesStaleCurrentFallbackMeta();
  testRegimeFallbackIsExplicitWhenSnapshotUnknown();
  testCurrentFallbackMetadataCanBePreservedWithoutFreshMeta();
  testExplicitPatchMetadataOverridesDerivedAndCurrent();
  testBlockedFragileReversalStyleGateTelemetry();
  testAllowedFragileReversalStyleGateTelemetry();
  console.log("conversionTelemetryConsistency.test.js passed");
}

main();
