const assert = require("node:assert/strict");

const { buildTradePlan } = require("../../src/trading/planBuilder");
const {
  resolvePostRouteConfidenceDecision,
  shouldAllowMultiTfTrendTransitionPass,
} = require("../../src/trading/tradeManager");
const {
  buildAdmissionContext,
  buildDecisionAudit,
  mergeDecisionStage,
  buildDecisionMeta,
} = require("../../src/trading/admissionDecision");
const { getAdmissionProfile } = require("../../src/trading/admissionProfiles");
const {
  BASE_TS,
  cases: goldenReplayCases,
} = require("./fixtures/admissionGoldenReplayCases");

function env(overrides = {}) {
  return {
    CANDLE_TZ: "Asia/Kolkata",
    EXPECTED_MOVE_ATR_PERIOD: 14,
    PLAN_SWING_LOOKBACK: 60,
    PLAN_RANGE_LOOKBACK: 30,
    PLAN_SL_NOISE_ATR_MIN_MULT: 0.25,
    PLAN_TARGET_EXPECTED_MOVE_MULT: 10,
    PLAN_SL_ATR_K_TREND: 0.8,
    PLAN_SL_ATR_K_RANGE: 0.6,
    PLAN_SL_ATR_K_OPEN: 1.0,
    PLAN_SL_ATR_K_DEFAULT: 0.8,
    PLAN_TARGET_ATR_M_TREND: 1.4,
    PLAN_TARGET_ATR_M_RANGE: 0.9,
    PLAN_TARGET_ATR_M_OPEN: 1.2,
    PLAN_TARGET_ATR_M_DEFAULT: 1.2,
    STYLE_MIN_RR_TREND: 1.6,
    STYLE_MIN_RR_RANGE: 1.3,
    STYLE_MIN_RR_OPEN: 1.4,
    STYLE_MIN_RR_DEFAULT: 1.4,
    VWAP_LOOKBACK: 120,
    OPT_MAX_SL_PCT: 35,
    OPT_PLAN_PREMIUM_AWARE: "true",
    OPT_VOL_REF_ATR_PCT: 0.6,
    OPT_DELTA_ATM: 0.5,
    ...overrides,
  };
}

function trendCandles({ count = 90, start = 98, step = 0.08 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const base = start + i * step + Math.sin(i / 4) * 0.08;
    return {
      ts: BASE_TS - (count - i) * 300000,
      open: base - 0.1,
      high: base + 0.35,
      low: base - 0.35,
      close: base + 0.05,
      volume: 1000 + i * 7,
    };
  });
}

function rangeCandles() {
  return Array.from({ length: 70 }, (_, i) => {
    const base = 100.3 + Math.sin(i / 6) * 0.45;
    return {
      ts: BASE_TS - (70 - i) * 300000,
      open: base - 0.08,
      high: base + 0.18,
      low: base - 0.18,
      close: base + 0.01,
      volume: 1100 + i * 4,
    };
  });
}

function legacyFallbackCandles() {
  return Array.from({ length: 80 }, (_, i) => {
    const base = 100 + i * 0.18;
    return {
      ts: BASE_TS - (80 - i) * 60000,
      open: base - 0.4,
      high: base + 1.6,
      low: base - 1.1,
      close: base + 0.35,
      volume: 1000 + i * 5,
    };
  });
}

function premiumCandles() {
  return Array.from({ length: 60 }, (_, i) => {
    const base = 120 + i * 0.55 + Math.sin(i / 5) * 0.7;
    return {
      ts: BASE_TS - (60 - i) * 300000,
      open: base - 0.4,
      high: base + 1.2,
      low: base - 0.9,
      close: base + 0.5,
      volume: 5000 + i * 30,
    };
  });
}

function signal({
  strategyId,
  strategyStyle,
  side,
  candle,
  confidence = 80,
  reason = "fixture",
  meta = {},
  option_meta = null,
  routeConfidence = null,
}) {
  return {
    signalId: `${strategyId}-${side}-fixture`,
    strategyId,
    strategyStyle,
    side,
    confidence,
    reason,
    candle,
    signalCreatedAt: new Date(BASE_TS).toISOString(),
    signalDecisionTs: new Date(BASE_TS).toISOString(),
    signalEventTs: new Date(BASE_TS).toISOString(),
    regimeSnapshot: {
      snapshotId: "reg-fixture",
      timestamp: new Date(BASE_TS).toISOString(),
      regime: "TREND_COMPRESSED",
      regimeFamily: "TREND",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "BREAKOUT_WATCH",
      compressionActive: true,
    },
    meta,
    option_meta,
    routeConfidence,
  };
}

function candlesForFixture(key) {
  if (key === "legacy_fallback") return legacyFallbackCandles();
  if (key === "range") return rangeCandles();
  return trendCandles();
}

function buildFixtureSignal(definition = null, candles = null) {
  if (!definition) return null;
  const localCandles = candles || trendCandles();
  const last = localCandles[localCandles.length - 1] || { ts: BASE_TS, close: 100 };
  return signal({
    ...definition,
    candle: {
      ...last,
      ...(definition.candle || {}),
    },
  });
}

function buildPlannerFixtureResult(fixture) {
  const candles = candlesForFixture(fixture.candles);
  const sig = buildFixtureSignal(fixture.signal, candles);
  return buildTradePlan({
    env: env(),
    candles,
    nowTs: BASE_TS,
    ...(fixture.planArgs || {}),
    ...(fixture.premiumCandles === "premium"
      ? { premiumCandles: premiumCandles() }
      : {}),
    ...(sig ? { signal: sig } : {}),
    ...(sig
      ? {
          admissionSnapshot: buildAdmissionContext({
            signal: sig,
            profile: getAdmissionProfile(sig.strategyId, sig.strategyStyle),
            nowTs: BASE_TS + Number(fixture.admission?.nowOffsetMs || 0),
          }),
        }
      : {}),
  });
}

function assertPlannerFixture(fixture) {
  const plan = buildPlannerFixtureResult(fixture);
  assert.equal(plan.meta?.plannerPathUsed || null, fixture.expect.plannerPathUsed, fixture.id);
  assert.equal(plan.ok, fixture.expect.planOk, fixture.id);
  if (fixture.expect.planFallbackReason) {
    assert.equal(
      plan.meta?.planFallbackReason || null,
      fixture.expect.planFallbackReason,
      fixture.id,
    );
  }
  if (fixture.expect.readinessState) {
    assert.equal(
      plan.meta?.plannerTelemetry?.readinessState ||
        plan.meta?.readiness?.state ||
        null,
      fixture.expect.readinessState,
      fixture.id,
    );
  }
}

function assertTransitionFixture(fixture) {
  const result = shouldAllowMultiTfTrendTransitionPass({
    strategyId: fixture.signal.strategyId,
    signal: buildFixtureSignal(fixture.signal),
    regimeMeta: fixture.regimeMeta,
    multiTfMeta: fixture.multiTfMeta,
    config: fixture.config,
  });

  assert.equal(result.allowed, fixture.expect.allowed, fixture.id);
  assert.equal(result.reason, fixture.expect.reason, fixture.id);
  if (fixture.expect.transitionPassProfile) {
    assert.equal(
      result.meta?.transitionPassProfile || null,
      fixture.expect.transitionPassProfile,
      fixture.id,
    );
  }
  if (fixture.expect.mismatchStrengthBucket) {
    assert.equal(
      result.meta?.mismatchStrengthBucket || null,
      fixture.expect.mismatchStrengthBucket,
      fixture.id,
    );
  }
}

function assertPostRouteFixture(fixture) {
  const sig = buildFixtureSignal(fixture.signal);
  const result = resolvePostRouteConfidenceDecision({
    signal: sig,
    conf: fixture.conf,
    minConf: fixture.minConf,
    config: fixture.config,
  });

  assert.equal(Boolean(result.blocked), Boolean(fixture.expect.blocked), fixture.id);
  assert.equal(Boolean(result.adjusted), Boolean(fixture.expect.adjusted), fixture.id);
  assert.equal(result.reasonCode || null, fixture.expect.reasonCode, fixture.id);
  if (fixture.expect.contractQualityBucket) {
    assert.equal(
      result.meta?.contractQualityBucket || null,
      fixture.expect.contractQualityBucket,
      fixture.id,
    );
  }

  if (fixture.type !== "post_route_terminal") return;

  const snapshot = buildAdmissionContext({
    signal: sig,
    profile: getAdmissionProfile(sig.strategyId, sig.strategyStyle),
    nowTs: BASE_TS + 1_000,
  });
  let audit = buildDecisionAudit({ snapshot });
  audit = mergeDecisionStage({
    audit,
    snapshot,
    outcome: result.adjusted ? "ADJUSTED" : "BLOCKED",
    stage: "admission",
    reason: result.reasonCode,
    meta: result.meta,
  });
  if (result.adjusted) {
    audit = mergeDecisionStage({
      audit,
      snapshot,
      outcome: "READY_FOR_EXECUTION",
      stage: "entry",
      reason: "READY_FOR_EXECUTION",
      meta: {},
    });
  }
  const meta = buildDecisionMeta({ snapshot, audit, meta: result.meta });

  assert.equal(meta.terminalOutcome, fixture.expect.terminalOutcome, fixture.id);
  assert.equal(meta.terminalReasonCode, fixture.expect.terminalReasonCode, fixture.id);
  assert.equal(meta.softPassUsed, fixture.expect.softPassUsed, fixture.id);
  assert.equal(meta.plannerPathUsed || null, fixture.expect.plannerPathUsed, fixture.id);
}

function assertDecisionMetaFixture(fixture) {
  const sig = buildFixtureSignal(fixture.signal);
  const snapshot = buildAdmissionContext({
    signal: sig,
    profile: getAdmissionProfile(sig.strategyId, sig.strategyStyle),
    nowTs: BASE_TS + 1_000,
  });
  const audit = buildDecisionAudit({ snapshot });
  const meta = buildDecisionMeta({ snapshot, audit, meta: {} });

  assert.equal(meta.softPassSupported, fixture.expect.softPassSupported, fixture.id);
  assert.equal(meta.softPassUsed, fixture.expect.softPassUsed, fixture.id);
  assert.equal(
    meta.transitionPassSupported,
    fixture.expect.transitionPassSupported,
    fixture.id,
  );
  assert.equal(meta.transitionPassUsed, fixture.expect.transitionPassUsed, fixture.id);
  assert.equal(meta.softPassProfile, fixture.expect.softPassProfile, fixture.id);
  assert.equal(
    meta.transitionPassProfile,
    fixture.expect.transitionPassProfile,
    fixture.id,
  );
}

for (const fixture of [...goldenReplayCases].sort(
  (left, right) =>
    Number(left.id !== "legacy_fallback_when_modern_context_missing") -
    Number(right.id !== "legacy_fallback_when_modern_context_missing"),
)) {
  if (fixture.type === "planner") {
    assertPlannerFixture(fixture);
    continue;
  }
  if (fixture.type === "transition") {
    assertTransitionFixture(fixture);
    continue;
  }
  if (fixture.type === "post_route" || fixture.type === "post_route_terminal") {
    assertPostRouteFixture(fixture);
    continue;
  }
  if (fixture.type === "decision_meta") {
    assertDecisionMetaFixture(fixture);
  }
}

console.log("admissionReplay.test.js passed");
