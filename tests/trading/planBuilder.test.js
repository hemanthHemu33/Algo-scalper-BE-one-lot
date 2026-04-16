const assert = require("node:assert/strict");
const { buildTradePlan } = require("../../src/trading/planBuilder");

const BASE_TS = Date.parse("2026-01-15T06:30:00.000Z");
const PREV_DAY_TS = Date.parse("2026-01-14T06:30:00.000Z");

function makePlanEnv(overrides = {}) {
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

function makeTrendCandles({ count = 90, start = 98, step = 0.08, wiggle = 0.35 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const base = start + i * step + Math.sin(i / 4) * 0.08;
    return {
      ts: BASE_TS - (count - i) * 300000,
      open: base - 0.1,
      high: base + wiggle,
      low: base - wiggle,
      close: base + 0.05,
      volume: 1000 + i * 7,
    };
  });
}

function makeBreakoutCandles() {
  const out = [];
  for (let i = 0; i < 70; i += 1) {
    const base = 102 + Math.sin(i / 5) * 0.4 + i * 0.015;
    out.push({
      ts: BASE_TS - (90 - i) * 300000,
      open: base - 0.12,
      high: base + 0.28,
      low: base - 0.28,
      close: base + 0.04,
      volume: 1000 + i * 8,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    const base = 104.7 + i * 0.03;
    out.push({
      ts: BASE_TS - (20 - i) * 300000,
      open: base - 0.08,
      high: base + 0.18,
      low: base - 0.16,
      close: base + 0.03,
      volume: 1800 + i * 12,
    });
  }
  return out;
}

function makeTwoDayBreakoutCandles() {
  const bars = [];
  for (let i = 0; i < 40; i += 1) {
    const base = 101.5 + i * 0.18;
    bars.push({
      ts: PREV_DAY_TS + i * 300000,
      open: base - 0.2,
      high: base + 0.45,
      low: base - 0.35,
      close: base + 0.2,
      volume: 1200 + i * 10,
    });
  }
  for (let i = 0; i < 20; i += 1) {
    const base = 103.8 + i * 0.06;
    bars.push({
      ts: BASE_TS + i * 300000,
      open: base - 0.1,
      high: base + 0.28,
      low: base - 0.16,
      close: base + 0.06,
      volume: 1600 + i * 12,
    });
  }
  return bars;
}

function makeRangeCandles() {
  const bars = [];
  for (let i = 0; i < 70; i += 1) {
    const base = 100.3 + Math.sin(i / 6) * 0.45;
    bars.push({
      ts: Date.parse("2026-01-15T05:45:00.000Z") + i * 300000,
      open: base - 0.08,
      high: base + 0.18,
      low: base - 0.18,
      close: base + 0.01,
      volume: 1100 + i * 4,
    });
  }
  return bars;
}

function makeLegacyFallbackCandles() {
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

function makePremiumCandles() {
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

function makeSignal({
  strategyId,
  strategyStyle,
  side,
  candle,
  candidateAgeBars = 0,
  confidence = 80,
  reason = "test setup",
  meta = {},
}) {
  return {
    strategyId,
    strategyStyle,
    side,
    confidence,
    reason,
    candidateAgeBars,
    candle,
    meta,
  };
}

function assertFiniteNumber(value, label) {
  assert.ok(Number.isFinite(Number(value)), `${label} must be finite`);
}

const env = makePlanEnv();

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  last.close = 101.4;
  last.high = 101.7;
  last.low = 100.9;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 78,
    reason: "ema reclaim",
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.2,
      trendAnchor: 99.7,
      pullbackAnchor: 100.05,
      volumeQuality: 72,
      structureQuality: 70,
      patternQuality: 75,
      anchorQuality: 74,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 101.4,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.meta.planRejectReason, "ENTRY_CHASED");
  assert.deepEqual(plan.validationRejectReasons, ["ENTRY_CHASED", "ENTRY_OVEREXTENDED"]);
}

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.33;
  last.high = 100.52;
  last.low = 100.05;
  prev.low = 99.98;
  prev.high = 100.38;
  prev.close = 100.12;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 78,
    reason: "ema reclaim",
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.18,
      trendAnchor: 99.7,
      pullbackAnchor: 100.05,
      volumeQuality: 72,
      structureQuality: 70,
      patternQuality: 75,
      anchorQuality: 74,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 100.33,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.stop.stopSourceType, "RECLAIM_CANDLE");
  assert.equal(plan.meta.stop.stopFallbackUsed, false);
  assert.notEqual(plan.meta.stop.stopSourceType, "ATR_FALLBACK");
  assert.equal(plan.meta.plannerPathUsed, "MODERN");
  assert.equal(plan.meta.chosenStopSourceType, "RECLAIM_CANDLE");
  assert.ok(plan.meta.stop.stopSelectionReason);
}

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.31;
  last.high = 100.48;
  last.low = 100.04;
  prev.low = 99.97;
  prev.high = 100.34;
  prev.close = 100.1;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: null,
    side: "BUY",
    candle: last,
    confidence: 77,
    reason: "ema reclaim fallback context",
    meta: {
      anchorValue: 100.08,
      pullbackAnchor: 100.08,
      trendAnchor: 99.72,
      volumeQuality: 74,
      structureQuality: 73,
      patternQuality: 75,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    premiumCandles: makePremiumCandles(),
    intervalMin: 5,
    side: "BUY",
    signalStyle: null,
    signal,
    entryUnderlying: 100.31,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    optionMeta: {
      strategyStyle: "TREND",
      delta: 0.46,
      gamma: 0.02,
      expiry: "2026-01-22",
      bps: 18,
    },
    entryPremium: 130,
    premiumTick: 0.05,
    atrPctUnderlying: 0.7,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.setup.family, "ema_pullback");
  assertFiniteNumber(plan.meta.setup.triggerLevel, "resolved trigger level");
  assertFiniteNumber(plan.meta.setup.anchorValue, "resolved anchor value");
  assert.notEqual(plan.meta.planRejectReason, "RICH_CONTEXT_INCOMPLETE");
  assert.equal(plan.meta.planWarnings.includes("MISSING_TRIGGER_LEVEL"), false);
}

{
  const candles = makeBreakoutCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 105.12;
  last.high = 105.26;
  last.low = 104.98;
  prev.low = 104.9;
  prev.high = 105.18;
  const signal = makeSignal({
    strategyId: "breakout",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 81,
    reason: "range breakout",
    meta: {
      anchorType: "RANGE_HIGH",
      anchorValue: 105.0,
      triggerType: "BREAKOUT_LEVEL",
      triggerLevel: 105.0,
      rangeHigh: 105.0,
      rangeLow: 102.4,
      retestState: "BREAKOUT_HOLD",
      volumeQuality: 80,
      structureQuality: 84,
      patternQuality: 82,
      anchorQuality: 83,
      freshness: 91,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 105.12,
    expectedMoveUnderlying: 25,
    atrPeriod: 14,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.stop.stopSourceType, "BREAKOUT_BASE");
  assert.equal(plan.meta.targets.targetSourceTypePrimary === "VWAP", false);
  assert.ok(
    plan.meta.plannerTelemetry.invalidTargetSources.some((value) =>
      String(value).startsWith("VWAP:"),
    ),
    "invalid VWAP target should be dropped before scoring",
  );
  assert.equal(plan.meta.plannerPathUsed, "MODERN");
  assert.equal(plan.meta.chosenTargetSourceType, plan.meta.targets.targetSourceTypePrimary);
  assert.ok(plan.meta.targetSelectionReason);
}

{
  const candles = makeBreakoutCandles();
  const last = candles[candles.length - 1];
  last.close = 105.05;
  last.high = 105.16;
  last.low = 104.92;
  const signal = makeSignal({
    strategyId: "breakout",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    candidateAgeBars: 4,
    confidence: 81,
    reason: "range breakout",
    meta: {
      anchorType: "RANGE_HIGH",
      anchorValue: 105.0,
      triggerType: "BREAKOUT_LEVEL",
      triggerLevel: 105.0,
      rangeHigh: 105.0,
      rangeLow: 102.4,
      retestState: "BREAKOUT_HOLD",
      volumeQuality: 80,
      structureQuality: 84,
      patternQuality: 82,
      anchorQuality: 83,
      freshness: 65,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 105.05,
    expectedMoveUnderlying: 25,
    atrPeriod: 14,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.meta.planRejectReason, "ENTRY_STALE");
}

{
  const candles = makeRangeCandles();
  const last = candles[candles.length - 1];
  last.close = 100.22;
  last.high = 100.38;
  last.low = 100.04;
  const signal = makeSignal({
    strategyId: "vwap_reclaim",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 79,
    reason: "vwap reclaim",
    meta: {
      anchorType: "SESSION_VWAP",
      anchorValue: 100.0,
      triggerType: "VWAP_RECLAIM",
      triggerLevel: 100.0,
      volumeQuality: 78,
      structureQuality: 76,
      patternQuality: 74,
      anchorQuality: 82,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 100.22,
    expectedMoveUnderlying: 12,
    atrPeriod: 14,
    nowTs: Date.parse("2026-01-15T11:30:00.000Z"),
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.entry.entryAnchorType, "SESSION_VWAP");
  assert.ok(["RECLAIM_CANDLE", "VWAP_LOSS"].includes(plan.meta.stop.stopSourceType));
}

{
  const candles = makeRangeCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.36;
  last.high = 100.5;
  last.low = 100.05;
  prev.high = 100.44;
  prev.low = 99.98;
  const signal = makeSignal({
    strategyId: "wick_reversal",
    strategyStyle: "RANGE",
    side: "BUY",
    candle: last,
    confidence: 77,
    reason: "lower wick rejection",
    meta: {
      anchorType: "REVERSAL_ZONE",
      anchorValue: 100.18,
      triggerType: "WICK_REVERSAL",
      triggerLevel: 100.24,
      wickExtreme: 99.98,
      brokenLevel: 100.1,
      volumeQuality: 73,
      structureQuality: 75,
      patternQuality: 80,
      anchorQuality: 78,
      freshness: 92,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "RANGE",
    signal,
    entryUnderlying: 100.36,
    expectedMoveUnderlying: 10,
    atrPeriod: 14,
    nowTs: Date.parse("2026-01-15T10:30:00.000Z"),
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.stop.stopSourceType, "WICK_EXTREME");
}

{
  const candles = makeRangeCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.06;
  last.high = 100.16;
  last.low = 100.0;
  prev.high = 100.14;
  prev.low = 99.99;
  const signal = makeSignal({
    strategyId: "rsi_fade",
    strategyStyle: "RANGE",
    side: "BUY",
    candle: last,
    confidence: 75,
    reason: "oversold fade",
    meta: {
      anchorType: "SESSION_VWAP",
      anchorValue: 100.38,
      triggerType: "RSI_FADE",
      triggerLevel: 100.02,
      wickExtreme: 99.99,
      brokenLevel: 100.0,
      volumeQuality: 70,
      structureQuality: 73,
      patternQuality: 76,
      anchorQuality: 75,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "RANGE",
    signal,
    entryUnderlying: 100.06,
    expectedMoveUnderlying: 8,
    atrPeriod: 14,
    nowTs: Date.parse("2026-01-15T10:30:00.000Z"),
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.targets.targetSourceTypePrimary, "VWAP");
  assert.equal(plan.runnerTarget, null);
}

{
  const candles = makeTwoDayBreakoutCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 104.99;
  last.high = 105.12;
  last.low = 104.9;
  prev.low = 104.86;
  prev.high = 105.06;
  const signal = makeSignal({
    strategyId: "breakout",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 84,
    reason: "opening continuation",
    meta: {
      anchorType: "RANGE_HIGH",
      anchorValue: 104.9,
      triggerType: "BREAKOUT_LEVEL",
      triggerLevel: 104.9,
      rangeHigh: 104.9,
      rangeLow: 103.2,
      retestState: "BREAKOUT_HOLD",
      volumeQuality: 84,
      structureQuality: 86,
      patternQuality: 83,
      anchorQuality: 84,
      freshness: 92,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 104.99,
    expectedMoveUnderlying: 30,
    atrPeriod: 14,
    nowTs: BASE_TS + 19 * 300000,
  });

  assert.equal(plan.ok, true);
  assertFiniteNumber(plan.primaryTarget, "trend primary target");
  assertFiniteNumber(plan.secondaryTarget, "trend secondary target");
  assertFiniteNumber(plan.runnerTarget, "trend runner target");
  assert.equal(plan.meta.targets.targetSourceTypeSecondary, "R1");
  assert.equal(plan.meta.targets.targetSourceTypeRunner, "R2");
}

{
  const candles = makeLegacyFallbackCandles();
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    entryUnderlying: 104,
    expectedMoveUnderlying: 25,
    atrPeriod: 14,
    rrFloorOverride: 2.2,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.meta.planFallbackUsed, true);
  assert.equal(plan.meta.planFallbackReason, "RICH_CONTEXT_INCOMPLETE");
  assert.equal(plan.meta.plannerPathUsed, "LEGACY_FALLBACK");
  assert.equal(plan.meta.legacyFallbackUsed, true);
}

{
  const candles = makeLegacyFallbackCandles();
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    entryUnderlying: 104,
    expectedMoveUnderlying: 25,
    atrPeriod: 14,
    rrFloorOverride: 2.2,
    nowTs: BASE_TS,
  });

  assertFiniteNumber(plan.stopLoss, "legacy-compatible stopLoss");
  assertFiniteNumber(plan.targetPrice, "legacy-compatible targetPrice");
  assertFiniteNumber(plan.rr, "legacy-compatible rr");
  assertFiniteNumber(plan.meta.underlying.entry, "underlying entry");
}

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.33;
  last.high = 100.52;
  last.low = 100.05;
  prev.low = 99.98;
  prev.high = 100.38;
  prev.close = 100.12;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 78,
    reason: "ema reclaim",
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.18,
      trendAnchor: 99.7,
      pullbackAnchor: 100.05,
      volumeQuality: 72,
      structureQuality: 70,
      patternQuality: 75,
      anchorQuality: 74,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    premiumCandles: makePremiumCandles(),
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 100.33,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    optionMeta: {
      strategyStyle: "TREND",
      delta: 0.48,
      gamma: 0.02,
      expiry: "2026-01-22",
      bps: 18,
    },
    entryPremium: 132,
    premiumTick: 0.05,
    atrPctUnderlying: 0.7,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, true);
  assert.ok(Number(plan.stopLoss) < 132, "option stop must be below premium entry");
  assert.ok(Number(plan.stopLoss) > 132 * 0.6, "option stop must stay sane");
  assert.ok(Number(plan.targetPrice) > 132, "option target must be above premium entry");
  assert.equal(plan.meta.option.modelUsed, "PREMIUM_AWARE_BLEND");
  assert.equal(plan.authoritativePrimaryRrUsed, plan.rr);
  assert.equal(plan.meta.authoritativePrimaryRrUsed, plan.rr);
  assert.equal(plan.meta.authoritativePrimaryTarget, plan.targetPrice);
  assert.equal(plan.meta.planRejectReason, null);
  assert.equal(plan.meta.finalPlanBasis, "OPTION_MAPPED");
}

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  last.close = 100.33;
  last.high = 100.52;
  last.low = 100.05;
  prev.low = 99.98;
  prev.high = 100.38;
  prev.close = 100.12;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 78,
    reason: "ema reclaim mixed assist",
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.18,
      trendAnchor: 99.7,
      pullbackAnchor: 100.05,
      volumeQuality: 72,
      structureQuality: 70,
      patternQuality: 75,
      anchorQuality: 74,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    premiumCandles: makePremiumCandles(),
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 100.33,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    optionMeta: {
      strategyStyle: "TREND",
      delta: 0.48,
      gamma: 0.02,
      expiry: "2026-01-22",
      bps: 18,
    },
    entryPremium: null,
    premiumTick: 0.05,
    atrPctUnderlying: 0.7,
    nowTs: BASE_TS,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "OPTION_PREMIUM_MAPPING_FALLBACK");
  assert.equal(plan.meta.plannerPathUsed, "MIXED_ASSIST");
  assert.equal(plan.meta.planFallbackUsed, true);
  assert.equal(plan.meta.legacyFallbackUsed, false);
  assert.equal(plan.targetPrice == null, true);
  assert.ok(Number.isFinite(Number(plan.meta.targets.primaryTarget)));
}

{
  const candles = makeTrendCandles();
  const last = candles[candles.length - 1];
  last.close = 101.4;
  last.high = 101.7;
  last.low = 100.9;
  const signal = makeSignal({
    strategyId: "ema_pullback",
    strategyStyle: "TREND",
    side: "BUY",
    candle: last,
    confidence: 78,
    reason: "ema reclaim",
    meta: {
      anchorType: "EMA_20",
      anchorValue: 100.1,
      triggerType: "EMA_RECLAIM",
      triggerLevel: 100.2,
      trendAnchor: 99.7,
      pullbackAnchor: 100.05,
      volumeQuality: 72,
      structureQuality: 70,
      patternQuality: 75,
      anchorQuality: 74,
      freshness: 90,
    },
  });
  const plan = buildTradePlan({
    env,
    candles,
    intervalMin: 5,
    side: "BUY",
    signalStyle: "TREND",
    signal,
    entryUnderlying: 101.4,
    expectedMoveUnderlying: 20,
    atrPeriod: 14,
    nowTs: BASE_TS,
  });

  assert.equal(plan.meta.planRejectReason, "ENTRY_CHASED");
  assert.deepEqual(plan.meta.validation.validationRejectReasons, ["ENTRY_CHASED", "ENTRY_OVEREXTENDED"]);
}

console.log("planBuilder.test.js passed");
