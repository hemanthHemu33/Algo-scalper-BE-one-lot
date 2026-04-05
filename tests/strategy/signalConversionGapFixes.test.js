const assert = require("node:assert/strict");

const { env } = require("../../src/config");
const {
  decorateSignalCandidate,
  applySetupLifecycle,
  rememberFiredSignal,
  resetSignalLayerState,
} = require("../../src/strategy/signalControls");
const {
  buildSignalConversionSummary,
  shouldEmitLiveCandidate,
} = require("../../src/strategy/signalLifecycle");

function patchEnv(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = env[key];
    env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      env[key] = value;
    }
  };
}

function makeCandles(count, startIso, intervalMin = 1, start = 100, step = 0.35) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    const open = close - 0.2;
    return {
      ts: new Date(startMs + index * intervalMin * 60_000).toISOString(),
      open,
      high: close + 0.4,
      low: open - 0.4,
      close,
      volume: 120 + index,
    };
  });
}

function testMtfMissingVsTrueDisagreement() {
  const restoreEnv = patchEnv({ SIGNAL_INTERVALS: "1,3" });
  resetSignalLayerState();
  try {
    const lowerCandles = makeCandles(
      30,
      "2026-03-24T09:15:00+05:30",
      1,
      100,
      0.3,
    );
    const lowerContext = {
      instrument_token: 99111,
      intervalMin: 1,
      candles: lowerCandles,
      last: lowerCandles[lowerCandles.length - 1],
      regime: "TREND_COMPRESSED",
    };
    const lowerSignal = {
      strategyId: "ema_pullback",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 78,
      meta: {
        patternQuality: 82,
        anchorQuality: 80,
        structureQuality: 84,
        volumeQuality: 68,
        freshness: 86,
        setupState: "confirmed",
      },
    };

    const missingMtf = decorateSignalCandidate(lowerSignal, lowerContext);
    assert.equal(missingMtf.mtfState, "MISSING");
    assert.equal(missingMtf.mtfDegraded, true);
    assert.ok(missingMtf.mtfAgreementScore >= 48);
    assert.notEqual(missingMtf.mtfAgreementScore, 20);
    assert.deepEqual(missingMtf.mtfMissingIntervals, [3]);

    const higherCandles = makeCandles(
      30,
      "2026-03-24T09:15:00+05:30",
      3,
      110,
      -0.45,
    );
    const higherContext = {
      instrument_token: 99111,
      intervalMin: 3,
      candles: higherCandles,
      last: higherCandles[higherCandles.length - 1],
      regime: "TREND",
    };
    const higherSignal = decorateSignalCandidate(
      {
        strategyId: "breakout",
        strategyStyle: "TREND",
        side: "SELL",
        confidence: 86,
        actionable: true,
        signalStage: "bar_close_confirmed",
        meta: {
          patternQuality: 86,
          anchorQuality: 82,
          structureQuality: 84,
          volumeQuality: 74,
          freshness: 90,
          setupState: "confirmed",
        },
      },
      higherContext,
    );
    const lifecycle = applySetupLifecycle(higherSignal, higherContext);
    rememberFiredSignal(lifecycle.candidate, higherContext);

    const conflictingMtf = decorateSignalCandidate(lowerSignal, lowerContext);
    assert.equal(conflictingMtf.mtfState, "DISAGREEMENT");
    assert.equal(conflictingMtf.mtfFallbackReason, null);
    assert.ok(
      conflictingMtf.mtfAgreementScore < missingMtf.mtfAgreementScore,
      "true higher-timeframe contradiction should score below degraded missing-context handling",
    );
  } finally {
    resetSignalLayerState();
    restoreEnv();
  }
}

function testRouteAwarePreEmitUsesSoftPenaltyBeforeRouting() {
  const restoreEnv = patchEnv({
    FNO_ENABLED: "true",
    FNO_MODE: "OPT",
    MIN_SIGNAL_CONFIDENCE: 71,
  });
  try {
    const candidate = {
      strategyId: "ema_pullback",
      strategyStyle: "TREND",
      strategyFamily: "TREND_PULLBACK",
      side: "BUY",
      confidence: 68.9,
      rawConfidence: 68.9,
      normalizedConfidence: 74,
      qualityScore: 64,
      contextScore: 61,
      finalSignalScore: 76,
      mtfAgreementScore: 63,
      mtfState: "DEGRADED_ALIGNMENT",
      freshness: 84,
      stageScore: 93,
      selectorParticipation: 46,
      volumeQuality: 44,
      signalStage: "bar_close_confirmed",
      isProvisional: false,
      setupState: "confirmed",
      scoreBreakdown: {
        selectorParticipation: 46,
        volumeQuality: 44,
      },
    };

    const gate = shouldEmitLiveCandidate({ candidate, env });
    assert.equal(gate.emit, true);
    assert.equal(gate.suppressionReason, null);
    assert.ok(gate.qualityMeta.routeConfidence.routedScore < 71);
    assert.equal(gate.qualityMeta.routeConfidence.preRouteScore, 68.9);
    assert.equal(gate.qualityMeta.routeConfidenceStage, "PRE");
    assert.equal(gate.qualityMeta.routeConfidenceDecision, "SOFT_PENALTY");
    assert.equal(
      gate.qualityMeta.routeDecisionReason,
      "ROUTE_CONFIDENCE_SOFT_PENALTY",
    );
    assert.ok(Number(gate.qualityMeta.routePenaltyApplied ?? 0) >= 2);
    assert.ok(!gate.failedChecks.includes("LOW_ROUTE_AWARE_CONFIDENCE"));
    assert.ok(
      Number(gate.qualityMeta.effectiveFinalSignalScore ?? 0) <
        Number(candidate.finalSignalScore),
    );
  } finally {
    restoreEnv();
  }
}

function testMtfEdgeCaseUsesSoftPenaltyInsteadOfHardReject() {
  const candidate = {
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    strategyFamily: "TREND_PULLBACK",
    side: "BUY",
    confidence: 78,
    rawConfidence: 78,
    normalizedConfidence: 79,
    qualityScore: 72,
    contextScore: 74,
    finalSignalScore: 77,
    mtfAgreementScore: 51.44,
    mtfState: "DEGRADED_ALIGNMENT",
    freshness: 85,
    stageScore: 94,
    signalStage: "bar_close_confirmed",
    isProvisional: false,
    setupState: "confirmed",
  };

  const gate = shouldEmitLiveCandidate({
    candidate,
    env: {
      MIN_SIGNAL_CONFIDENCE: 70,
      SIGNAL_PREEMIT_GLOBAL_MIN_NORMALIZED_CONFIDENCE: 67,
      SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE: 60,
      SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE: 58,
      SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE: 71,
      SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE: 52,
      SIGNAL_PREEMIT_GLOBAL_MIN_FRESHNESS: 58,
    },
  });

  assert.equal(gate.emit, true);
  assert.equal(gate.qualityMeta.mtfDecision, "SOFT_FAIL");
  assert.ok(Number(gate.qualityMeta.mtfPenaltyApplied ?? 0) >= 2);
  assert.ok(
    !gate.failedChecks.includes("LOW_MTF_AGREEMENT_SCORE"),
    "borderline MTF misses should no longer hard fail",
  );
}

function testConversionSummaryIsNormalized() {
  const summary = buildSignalConversionSummary(
    {
      signalId: "sig-42",
      strategyId: "ema_pullback",
      side: "BUY",
      regime: "TREND",
      signalStage: "bar_close_confirmed",
      preEmit: {
        profileId: "strategy:ema_pullback",
      },
      option_meta: {
        instrument_token: 71234,
        underlying: "NIFTY",
        optType: "CE",
        strike: 25200,
        expiry: "2026-04-02",
        ltp: 124.5,
        bps: 18,
        health_score: 74,
        premiumContext: {
          readinessState: "partial",
        },
      },
    },
    {
      preEmitDecision: "EMITTED",
      mtfState: "DEGRADED_ALIGNMENT",
      routeAttempted: true,
      postRouteDecision: "PASSED",
      riskFitDecision: "PASSED",
      finalOutcome: "READY_FOR_EXECUTION",
      finalReasonCode: "ENTRY_PLACED",
    },
  );

  assert.deepEqual(summary, {
    signalId: "sig-42",
    strategyId: "ema_pullback",
    side: "BUY",
    regime: "TREND",
    profileId: "strategy:ema_pullback",
    signalStage: "bar_close_confirmed",
    preEmitDecision: "EMITTED",
    preEmitFailureReasons: [],
    mtfState: "DEGRADED_ALIGNMENT",
    routeAttempted: true,
    selectedContract: {
      token: 71234,
      underlying: "NIFTY",
      optType: "CE",
      strike: 25200,
      expiry: "2026-04-02",
      premium: 124.5,
      spreadBps: 18,
      healthScore: 74,
      selectedByFallback: false,
      fallbackReason: null,
      premiumReadinessState: "partial",
    },
    preRouteScore: null,
    expectedRouteAdjustment: null,
    routedConfidence: null,
    postRouteDecision: "PASSED",
    riskFitDecision: "PASSED",
    finalOutcome: "READY_FOR_EXECUTION",
    finalReasonCode: "ENTRY_PLACED",
  });
}

function main() {
  testMtfMissingVsTrueDisagreement();
  testRouteAwarePreEmitUsesSoftPenaltyBeforeRouting();
  testMtfEdgeCaseUsesSoftPenaltyInsteadOfHardReject();
  testConversionSummaryIsNormalized();
  console.log("signalConversionGapFixes.test.js passed");
}

main();
