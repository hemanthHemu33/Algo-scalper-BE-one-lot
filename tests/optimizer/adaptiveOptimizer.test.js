const assert = require("node:assert/strict");
const {
  ACTION,
  AdaptiveOptimizer,
  buildOptimizerKeyContext,
} = require("../../src/optimizer/adaptiveOptimizer");

const OPEN_TS = Date.parse("2026-01-15T04:00:00.000Z");
const MID_TS = Date.parse("2026-01-15T06:30:00.000Z");

function makeEnv(overrides = {}) {
  return {
    CANDLE_TZ: "Asia/Kolkata",
    OPTIMIZER_ENABLED: "true",
    OPT_LOOKBACK_N: 60,
    OPT_MIN_SAMPLES_KEY: 99,
    OPT_MIN_SAMPLES_STRATEGY: 99,
    OPT_BLOCK_FEE_MULTIPLE_AVG_MIN: 3,
    OPT_BLOCK_TTL_MIN: 120,
    OPT_BUCKET_OPEN_END: "10:00",
    OPT_BUCKET_CLOSE_START: "15:00",
    OPT_LOG_DECISIONS: "false",
    OPT_DEWEIGHT_ENABLED: "true",
    OPT_DEWEIGHT_MIN_SAMPLES: 2,
    OPT_DEWEIGHT_CONF_MIN: 0.9,
    OPT_DEWEIGHT_QTY_MIN: 0.5,
    OPT_DEWEIGHT_HARD_VETO_ENABLED: "false",
    OPT_SPREAD_PENALTY_BPS: 15,
    OPT_SPREAD_BLOCK_BPS: 30,
    OPT_SPREAD_PENALTY_CONF_MULT: 0.85,
    OPT_SPREAD_SOFT_ACTION: "RR_ONLY",
    OPT_SPREAD_BLOCK_ENABLED: "false",
    OPTIMIZER_BOOTSTRAP_FROM_DB: "false",
    OPT_STATE_PERSIST: "false",
    OPT_STATE_VERSION: 2,
    OPT_KEY_MODE: "NORMALIZED_V2",
    OPT_STRATEGY_KEY_INCLUDE_OPT_TYPE: "true",
    OPT_STRATEGY_KEY_INCLUDE_STYLE: "true",
    OPT_DELTA_ATM: 0.5,
    OPT_DELTA_ITM: 0.65,
    OPT_DELTA_OTM: 0.4,
    RR_TREND_MIN: 1.5,
    RR_WIDE_SPREAD_MIN: 1.8,
    RR_VOL_LOW: 1.8,
    RR_VOL_MED: 1.5,
    RR_VOL_HIGH: 1.2,
    VOL_LOW_PCT: 0.8,
    VOL_HIGH_PCT: 2.0,
    ...overrides,
  };
}

const quietLogger = {
  info() {},
  warn() {},
};

async function main() {
  const baseEnv = makeEnv();

  const familyA = buildOptimizerKeyContext(
    {
      symbol: "NIFTY26JAN24000CE",
      underlying: "NIFTY",
      optType: "CE",
      delta: 0.48,
      expiry: "2026-01-22",
      dte: 2,
      strategyId: "breakout",
      strategyStyle: "TREND",
      nowTs: MID_TS,
    },
    { env: baseEnv },
  );
  const familyB = buildOptimizerKeyContext(
    {
      symbol: "NIFTY26JAN24100CE",
      underlying: "NIFTY",
      optType: "CE",
      delta: 0.52,
      expiry: "2026-01-23",
      dte: 3,
      strategyId: "breakout",
      strategyStyle: "TREND",
      nowTs: MID_TS + 60_000,
    },
    { env: baseEnv },
  );

  assert.equal(
    familyA.keyKey,
    familyB.keyKey,
    "equivalent option families should collapse to the same K2 key",
  );

  const strategyCeTrend = buildOptimizerKeyContext(
    {
      symbol: "NIFTY26JAN24000CE",
      underlying: "NIFTY",
      optType: "CE",
      delta: 0.48,
      dte: 2,
      strategyId: "breakout",
      strategyStyle: "TREND",
      nowTs: MID_TS,
    },
    { env: baseEnv },
  );
  const strategyPeTrend = buildOptimizerKeyContext(
    {
      symbol: "NIFTY26JAN24000PE",
      underlying: "NIFTY",
      optType: "PE",
      delta: 0.48,
      dte: 2,
      strategyId: "breakout",
      strategyStyle: "TREND",
      nowTs: MID_TS,
    },
    { env: baseEnv },
  );
  const strategyCeRange = buildOptimizerKeyContext(
    {
      symbol: "NIFTY26JAN24000CE",
      underlying: "NIFTY",
      optType: "CE",
      delta: 0.48,
      dte: 2,
      strategyId: "breakout",
      strategyStyle: "RANGE",
      nowTs: MID_TS,
    },
    { env: baseEnv },
  );

  assert.notEqual(
    strategyCeTrend.stratKey,
    strategyPeTrend.stratKey,
    "CE and PE strategy aggregates must remain separate",
  );
  assert.notEqual(
    strategyCeTrend.stratKey,
    strategyCeRange.stratKey,
    "style band must remain part of the strategy aggregate",
  );

  const learner = new AdaptiveOptimizer({ env: baseEnv, logger: quietLogger });
  const frozenContext = {
    schemaVersion: 2,
    underlying: familyA.underlying,
    optType: familyA.optType,
    strategyId: familyA.strategyId,
    bucket: familyA.bucket,
    dteBand: familyA.dteBand,
    deltaBand: familyA.deltaBand,
    styleBand: familyA.styleBand,
    keyKey: familyA.keyKey,
    stratKey: familyA.stratKey,
  };

  learner.recordTradeClose({
    symbol: "SHOULD_NOT_BE_USED",
    strategyId: "wrong_strategy",
    feeMultiple: 1.2,
    startedAtTs: MID_TS,
    nowTs: MID_TS + 10_000,
    optimizerContext: frozenContext,
  });
  learner.recordTradeClose({
    symbol: "SHOULD_NOT_BE_USED",
    strategyId: "wrong_strategy",
    feeMultiple: 1.4,
    startedAtTs: MID_TS,
    nowTs: MID_TS + 20_000,
    optimizerContext: frozenContext,
  });

  const deweightResult = learner.evaluateSignal({
    symbol: "NIFTY26FEB24100CE",
    underlying: "NIFTY",
    optType: "CE",
    delta: 0.49,
    expiry: "2026-01-24",
    dte: 2,
    strategyId: "breakout",
    strategyStyle: "TREND",
    signalRegime: "TREND",
    nowTs: MID_TS + 30_000,
    atrBase: 120,
    close: 10000,
    rrBase: 1.4,
    spreadBps: 8,
    confidence: 78,
  });

  assert.equal(deweightResult.ok, true);
  assert.equal(deweightResult.action, ACTION.SOFT_DEWEIGHT);
  assert.ok(
    Number(deweightResult.meta.confidenceMult) < 1,
    "soft deweight should reduce confidence multiplier without blocking",
  );

  const rrOnlyOptimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_SPREAD_SOFT_ACTION: "RR_ONLY" }),
    logger: quietLogger,
  });
  const rrOnlyResult = rrOnlyOptimizer.evaluateSignal({
    symbol: "NIFTY26FEB24100CE",
    underlying: "NIFTY",
    optType: "CE",
    delta: 0.5,
    expiry: "2026-01-24",
    dte: 2,
    strategyId: "spread_probe",
    strategyStyle: "DEFAULT",
    signalRegime: "DEFAULT",
    nowTs: MID_TS + 30_000,
    atrBase: 120,
    close: 10000,
    rrBase: 1.4,
    spreadBps: 20,
    confidence: 78,
  });
  assert.equal(rrOnlyResult.ok, true);
  assert.equal(rrOnlyResult.action, ACTION.RR_TUNE_ONLY);
  assert.equal(rrOnlyResult.meta.confidenceMult, 1);

  const confSpreadOptimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_SPREAD_SOFT_ACTION: "CONF" }),
    logger: quietLogger,
  });
  const confSpreadResult = confSpreadOptimizer.evaluateSignal({
    symbol: "NIFTY26FEB24100CE",
    underlying: "NIFTY",
    optType: "CE",
    delta: 0.5,
    expiry: "2026-01-24",
    dte: 2,
    strategyId: "spread_probe",
    strategyStyle: "DEFAULT",
    signalRegime: "DEFAULT",
    nowTs: MID_TS + 30_000,
    atrBase: 120,
    close: 10000,
    rrBase: 1.4,
    spreadBps: 20,
    confidence: 78,
  });
  assert.equal(confSpreadResult.ok, true);
  assert.equal(confSpreadResult.action, ACTION.SOFT_DEWEIGHT);
  assert.ok(Number(confSpreadResult.meta.confidenceMult) < 1);
  assert.equal(confSpreadResult.meta.qtyMult, 1);

  const qtySpreadOptimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_SPREAD_SOFT_ACTION: "QTY" }),
    logger: quietLogger,
  });
  const qtySpreadResult = qtySpreadOptimizer.evaluateSignal({
    symbol: "NIFTY26FEB24100CE",
    underlying: "NIFTY",
    optType: "CE",
    delta: 0.5,
    expiry: "2026-01-24",
    dte: 2,
    strategyId: "spread_probe",
    strategyStyle: "DEFAULT",
    signalRegime: "DEFAULT",
    nowTs: MID_TS + 30_000,
    atrBase: 120,
    close: 10000,
    rrBase: 1.4,
    spreadBps: 20,
    confidence: 78,
  });
  assert.equal(qtySpreadResult.ok, true);
  assert.equal(qtySpreadResult.action, ACTION.SOFT_DEWEIGHT);
  assert.equal(qtySpreadResult.meta.confidenceMult, 1);
  assert.ok(Number(qtySpreadResult.meta.qtyMult) < 1);

  const extremeSpreadOptimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_SPREAD_BLOCK_ENABLED: "true" }),
    logger: quietLogger,
  });
  const extremeSpreadResult = extremeSpreadOptimizer.evaluateSignal({
    symbol: "NIFTY26FEB24100CE",
    underlying: "NIFTY",
    optType: "CE",
    delta: 0.5,
    expiry: "2026-01-24",
    dte: 2,
    strategyId: "spread_probe",
    strategyStyle: "DEFAULT",
    signalRegime: "DEFAULT",
    nowTs: MID_TS + 30_000,
    atrBase: 120,
    close: 10000,
    rrBase: 1.4,
    spreadBps: 35,
    confidence: 78,
  });
  assert.equal(extremeSpreadResult.ok, false);
  assert.equal(extremeSpreadResult.action, ACTION.HARD_BLOCK);
  assert.equal(extremeSpreadResult.reason, "OPT_BLOCK_SPREAD_EXTREME");

  const closeReuse = learner.recordTradeClose({
    symbol: "BANKNIFTY_FAKE_SYMBOL",
    strategyId: "different_strategy",
    feeMultiple: 2.1,
    startedAtTs: MID_TS,
    nowTs: MID_TS + 40_000,
    optimizerContext: frozenContext,
  });

  assert.equal(closeReuse.optimizerContextFallback, false);
  assert.equal(closeReuse.keyKey, frozenContext.keyKey);

  const v1Optimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_STATE_PERSIST: "true" }),
    persistEnabled: true,
    readState: async () => ({
      version: 1,
      keySchemaVersion: "EXACT_SYMBOL_V1",
      windows: { LEGACY: [1, 2, 3] },
      blocked: {},
    }),
    writeState: async () => ({ ok: true }),
    logger: quietLogger,
  });
  const v1Load = await v1Optimizer.loadPersistedState();
  assert.equal(v1Load.ok, false);
  assert.equal(v1Load.reason, "state_version_mismatch");
  assert.equal(v1Optimizer.snapshot().persist.loaded, false);
  assert.equal(v1Optimizer.snapshot().totalWindowCount, 0);
  assert.equal(v1Optimizer.snapshot().keySchemaVersion, "NORMALIZED_V2");

  const v2Optimizer = new AdaptiveOptimizer({
    env: makeEnv({ OPT_STATE_PERSIST: "true" }),
    persistEnabled: true,
    readState: async () => ({
      version: 2,
      keySchemaVersion: "NORMALIZED_V2",
      windows: { [familyA.keyKey]: [2.5, 3.5] },
      blocked: {},
    }),
    writeState: async () => ({ ok: true }),
    logger: quietLogger,
  });
  const v2Load = await v2Optimizer.loadPersistedState();
  assert.equal(v2Load.ok, true);
  assert.equal(v2Optimizer.snapshot().persist.loaded, true);
  assert.equal(v2Optimizer.snapshot().totalWindowCount, 1);
  assert.equal(v2Optimizer.snapshot().keySchemaVersion, "NORMALIZED_V2");

  console.log("adaptiveOptimizer.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
