const assert = require("node:assert/strict");

const { env } = require("../../src/config");
const { evaluateEmaCrossSetup } = require("../../src/strategy/emaCrossStrategy");

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

function makeCandlesFromCloses(closes) {
  const base = Date.parse("2026-03-24T09:15:00+05:30");
  return closes.map((close, index) => ({
    ts: new Date(base + index * 60_000).toISOString(),
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 100 + index,
  }));
}

function makeStrongBullCrossCloses() {
  const closes = [];
  for (let i = 0; i < 20; i += 1) closes.push(100 - i * 0.05);
  closes.push(closes[closes.length - 1]);
  closes.push(closes[closes.length - 1]);
  closes.push(closes[closes.length - 1] + 0.5);
  closes.push(closes[closes.length - 1] + 2);
  return closes;
}

function makeWeakBullCrossCloses() {
  return [
    ...Array(24).fill(100),
    100,
    100,
    100,
    100.04,
    100.08,
    100.12,
  ];
}

function testWeakCrossIsFilteredBeforeEmission() {
  const restoreEnv = patchEnv({
    EMA_CROSS_MIN_SLOPE_BPS: 2,
    EMA_CROSS_MIN_SEPARATION_BPS: 6,
    EMA_CROSS_ANTI_CHOP_BARS: 4,
  });
  try {
    const setup = evaluateEmaCrossSetup({
      candles: makeCandlesFromCloses(makeWeakBullCrossCloses()),
      fast: 9,
      slow: 21,
    });
    assert.ok(
      setup == null || setup.actionable === false,
      "flat/near-cross ema signals should not emit actionable entries",
    );
  } finally {
    restoreEnv();
  }
}

function testStrongCrossStillPasses() {
  const restoreEnv = patchEnv({
    EMA_CROSS_MIN_SLOPE_BPS: 2,
    EMA_CROSS_MIN_SEPARATION_BPS: 6,
    EMA_CROSS_ANTI_CHOP_BARS: 4,
  });
  try {
    const setup = evaluateEmaCrossSetup({
      candles: makeCandlesFromCloses(makeStrongBullCrossCloses()),
      fast: 9,
      slow: 21,
    });
    assert.equal(setup?.setupState, "triggered");
    assert.equal(setup?.candidate?.side, "BUY");
    assert.equal(setup?.actionable, true);
  } finally {
    restoreEnv();
  }
}

function testAntiChopBlocksImmediateRepeatCross() {
  const restoreEnv = patchEnv({
    EMA_CROSS_MIN_SLOPE_BPS: 2,
    EMA_CROSS_MIN_SEPARATION_BPS: 6,
    EMA_CROSS_ANTI_CHOP_BARS: 4,
  });
  try {
    const setup = evaluateEmaCrossSetup({
      candles: makeCandlesFromCloses(makeStrongBullCrossCloses()),
      fast: 9,
      slow: 21,
      priorState: {
        side: "BUY",
        triggerType: "EMA_BULL_CROSS",
        lastSeenTs: Date.now(),
        candidateAgeBars: 1,
      },
    });
    assert.ok(setup == null || setup.actionable === false);
  } finally {
    restoreEnv();
  }
}

function main() {
  testWeakCrossIsFilteredBeforeEmission();
  testStrongCrossStillPasses();
  testAntiChopBlocksImmediateRepeatCross();
  console.log("emaCrossNoiseGate.test.js passed");
}

main();
