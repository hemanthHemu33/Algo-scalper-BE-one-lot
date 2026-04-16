const assert = require("node:assert/strict");

const {
  minPremiumPlanCandles,
  premiumReadinessStaleAfterMs,
  resolvePlanPremiumCandles,
} = require("../../src/trading/planPremiumCache");

function makeCandles(count, startIso, intervalMin = 1) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({
    ts: new Date(startMs + index * intervalMin * 60_000).toISOString(),
    open: 100 + index * 0.2,
    high: 100.5 + index * 0.2,
    low: 99.5 + index * 0.2,
    close: 100.2 + index * 0.2,
    volume: 100 + index,
  }));
}

async function testPartialPremiumReadinessIsExplicit() {
  const env = {
    OPT_PLAN_VOL_LOOKBACK: 20,
    OPT_PLAN_PREM_ATR_PERIOD: 14,
  };
  const candles = makeCandles(9, "2026-03-24T09:15:00+05:30", 1);
  const result = await resolvePlanPremiumCandles({
    runtimeGetCandles: () => candles,
    dbGetRecentCandles: async () => [],
    token: 71234,
    intervalMin: 1,
    limit: 100,
    env,
    referenceTs: "2026-03-24T09:24:00+05:30",
  });

  assert.equal(result.source, "runtime_cache_partial");
  assert.equal(result.warmed, false);
  assert.equal(result.candleCount, 9);
  assert.equal(result.minRequired, minPremiumPlanCandles(env));
  assert.equal(result.readinessState, "partial");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.degradedBy, ["INSUFFICIENT_PREMIUM_CANDLES"]);
  assert.equal(result.lastCandleTs, candles[candles.length - 1].ts);
}

function testPremiumStaleThresholdTracksInterval() {
  assert.equal(premiumReadinessStaleAfterMs(1), 180_000);
  assert.equal(premiumReadinessStaleAfterMs(3), 540_000);
}

async function main() {
  testPremiumStaleThresholdTracksInterval();
  await testPartialPremiumReadinessIsExplicit();
  console.log("planPremiumCache.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
