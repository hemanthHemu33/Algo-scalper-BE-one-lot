const assert = require("node:assert/strict");
const { buildTradePlan } = require("../../src/trading/planBuilder");
const {
  buildFrozenOptimizerContext,
  resolveOptimizerAdmission,
  resolveOptimizerRrTarget,
} = require("../../src/trading/tradeManager");

const BASE_TS = Date.parse("2026-01-15T06:30:00.000Z");

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
    ...overrides,
  };
}

function makeCandles(count = 80) {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 0.18;
    return {
      ts: BASE_TS - (count - i) * 60_000,
      open: base - 0.4,
      high: base + 1.6,
      low: base - 1.1,
      close: base + 0.35,
      volume: 1000 + i * 5,
    };
  });
}

const baseOptimizerResult = {
  ok: true,
  action: "SOFT_DEWEIGHT",
  meta: {
    confidenceMult: 0.8,
    qtyMult: 0.7,
    rrUsed: 2.2,
  },
};

const defaultAdmission = resolveOptimizerAdmission({
  env: { OPT_RECHECK_CONF_AFTER_DEWEIGHT: "false" },
  optimizerResult: baseOptimizerResult,
  confidenceRaw: 76,
  minConf: 75,
});

assert.equal(
  defaultAdmission.ok,
  true,
  "soft deweight must not hard-block when compatibility mode is off",
);

const compatibilityAdmission = resolveOptimizerAdmission({
  env: { OPT_RECHECK_CONF_AFTER_DEWEIGHT: "true" },
  optimizerResult: baseOptimizerResult,
  confidenceRaw: 76,
  minConf: 75,
});

assert.equal(compatibilityAdmission.ok, false);
assert.equal(
  compatibilityAdmission.reason,
  "LOW_CONFIDENCE_AFTER_OPT_COMPAT",
);

const plan = buildTradePlan({
  env: makePlanEnv(),
  candles: makeCandles(),
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
assert.equal(plan.meta.styleMinRr, 1.6);
assert.equal(plan.meta.effectiveMinRr, 2.2);
assert.ok(
  Number(plan.rr) >= 2.2,
  "plan RR should respect the optimizer RR floor override",
);

const rrTarget = resolveOptimizerRrTarget({
  plan: { ok: true, rr: 1.9 },
  optimizerResult: { meta: { rrUsed: 2.3 } },
  rrBase: 1.4,
});

assert.equal(rrTarget, 2.3);

const frozenContext = buildFrozenOptimizerContext({
  optimizerResult: {
    action: "SOFT_DEWEIGHT",
    reason: null,
    meta: {
      keySchemaVersion: "NORMALIZED_V2",
      underlying: "NIFTY",
      optType: "CE",
      strategyId: "breakout",
      bucket: "MID",
      dteBand: "D1_3",
      deltaBand: "DELTA_45_55",
      styleBand: "TREND",
      keyKey: "K2|NIFTY|CE|breakout|MID|D1_3|DELTA_45_55",
      stratKey: "S2|breakout|MID|CE|TREND",
      confidenceMult: 0.9,
      qtyMult: 0.7,
      rrUsed: 2.2,
      spreadBps: 18,
      spreadRegime: "WIDE",
    },
  },
  confidenceRaw: 80,
  rrBase: 1.4,
});

assert.equal(frozenContext.schemaVersion, 2);
assert.equal(frozenContext.keySchemaVersion, "NORMALIZED_V2");
assert.equal(frozenContext.action, "SOFT_DEWEIGHT");
assert.equal(frozenContext.reason, null);

console.log("optimizerIntegration.test.js passed");
