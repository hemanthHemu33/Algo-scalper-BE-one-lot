const assert = require("node:assert/strict");
const {
  buildEntryPipelineLatency,
} = require("../../src/trading/entryPipelineLatency");
const {
  resolvePlanPremiumCandles,
} = require("../../src/trading/planPremiumCache");
const {
  evaluateExecutionGate,
} = require("../../src/trading/entryExecutionPolicy");

const BASE_TS = Date.parse("2026-01-01T09:15:00.000Z");

function makeCandles(count) {
  return Array.from({ length: count }, (_, index) => ({
    ts: new Date(BASE_TS - (count - index) * 60_000),
    open: 100 + index * 0.2,
    high: 100.8 + index * 0.2,
    low: 99.6 + index * 0.2,
    close: 100.4 + index * 0.2,
    volume: 1000 + index * 5,
  }));
}

async function testWarmedPremiumCandlesStayOffTheHotPath() {
  let dbCalls = 0;
  const warmedCandles = makeCandles(40);
  const resolved = await resolvePlanPremiumCandles({
    runtimeGetCandles: () => warmedCandles,
    dbGetRecentCandles: async () => {
      dbCalls += 1;
      return [];
    },
    token: 12345,
    intervalMin: 1,
    limit: 80,
    env: {
      OPT_PLAN_VOL_LOOKBACK: 20,
      OPT_PLAN_PREM_ATR_PERIOD: 14,
    },
  });

  assert.equal(resolved.source, "runtime_cache");
  assert.equal(resolved.warmed, true);
  assert.equal(dbCalls, 0);

  const latency = buildEntryPipelineLatency({
    timeline: {
      signalEventTs: new Date(BASE_TS - 900).toISOString(),
      signalCreatedAt: new Date(BASE_TS).toISOString(),
      routeStartAt: new Date(BASE_TS + 100).toISOString(),
      contractSelectedAt: new Date(BASE_TS + 450).toISOString(),
      backfillStartAt: new Date(BASE_TS + 500).toISOString(),
      backfillEndAt: new Date(BASE_TS + 510).toISOString(),
      admissionCheckAt: new Date(BASE_TS + 2_200).toISOString(),
    },
    totalBudgetMs: 5_000,
  });

  assert.ok(
    Number(latency.totalAgeMs) < 5_000,
    "warmed premium-candle resolution should keep admission inside the stale-signal budget",
  );
  assert.equal(latency.marketAgeMs, Number(latency.totalAgeMs) + 900);

  const executionGate = evaluateExecutionGate({
    signalTs: null,
    trade: {
      side: "BUY",
      signalEventTs: new Date(BASE_TS).toISOString(),
      signalCreatedAt: new Date(BASE_TS + 1_200).toISOString(),
      plannedEntry: 100,
      expectedEntryPrice: 100,
      underlying_ltp: 24000,
      instrument: { tick_size: 0.05 },
    },
    quote: { bid: 99.95, ask: 100.05, ltp: 100 },
    underlyingLtp: 24000,
    nowTs: BASE_TS + Number(latency.totalAgeMs),
    env: {
      MAX_EXECUTION_AGE_MS: 5_000,
      MAX_LATENCY_GRACE_MS: 3_000,
      EXEC_MAX_PREMIUM_DRIFT_PCT: 1.0,
      EXEC_MAX_SPREAD_BPS: 45,
      OPT_MAX_SPREAD_BPS: 45,
      EXEC_MAX_CHASE_STEPS: 3,
      EXEC_MAX_ENTRY_DEVIATION_PCT: 1.2,
      ENTRY_PENDING_MAX_ADVERSE_UL_BPS: 12,
    },
  });

  assert.equal(executionGate.ok, true);
  assert.notEqual(executionGate.reasonCode, "EXEC_SIGNAL_STALE");
}

function testLatencyTelemetryContainsFullBreakdown() {
  const latency = buildEntryPipelineLatency({
    timeline: {
      signalEventTs: new Date(BASE_TS - 600).toISOString(),
      signalCreatedAt: new Date(BASE_TS).toISOString(),
      routeStartAt: new Date(BASE_TS + 120).toISOString(),
      contractSelectedAt: new Date(BASE_TS + 660).toISOString(),
      backfillStartAt: new Date(BASE_TS + 700).toISOString(),
      backfillEndAt: new Date(BASE_TS + 715).toISOString(),
      admissionCheckAt: new Date(BASE_TS + 2_050).toISOString(),
      orderIntentCreatedAt: new Date(BASE_TS + 2_320).toISOString(),
    },
    totalBudgetMs: 5_000,
  });

  assert.equal(latency.timestamps.signalEventTs, new Date(BASE_TS - 600).toISOString());
  assert.equal(latency.timestamps.signalCreatedAt, new Date(BASE_TS).toISOString());
  assert.equal(latency.timestamps.orderIntentCreatedAt, new Date(BASE_TS + 2_320).toISOString());
  assert.equal(latency.stageMs.signalToRouteStartMs, 120);
  assert.equal(latency.stageMs.routeToContractSelectionMs, 540);
  assert.equal(latency.stageMs.contractSelectionToBackfillStartMs, 40);
  assert.equal(latency.stageMs.backfillMs, 15);
  assert.equal(latency.stageMs.postSelectionToAdmissionMs, 1_335);
  assert.equal(latency.stageMs.admissionToOrderIntentMs, 270);
  assert.equal(latency.totalAgeMs, 2_320);
}

function testLatencyTelemetryHighlightsDominantStage() {
  const latency = buildEntryPipelineLatency({
    timeline: {
      signalCreatedAt: new Date(BASE_TS).toISOString(),
      routeStartAt: new Date(BASE_TS + 100).toISOString(),
      contractSelectedAt: new Date(BASE_TS + 2_100).toISOString(),
      admissionCheckAt: new Date(BASE_TS + 2_400).toISOString(),
    },
    totalBudgetMs: 5_000,
  });

  assert.equal(latency.culpritStage, "routeToContractSelectionMs");
  assert.equal(latency.culpritDurationMs, 2_000);
  assert.equal(latency.culpritBudgetMs, 1_600);
}

function testExecutionGateUsesSignalCreatedAtForFreshness() {
  const executionGate = evaluateExecutionGate({
    signalTs: null,
    trade: {
      side: "BUY",
      signalEventTs: new Date(BASE_TS - 63_000).toISOString(),
      signalCreatedAt: new Date(BASE_TS + 3_500).toISOString(),
      plannedEntry: 100,
      expectedEntryPrice: 100,
      underlying_ltp: 24000,
      instrument: { tick_size: 0.05 },
    },
    quote: { bid: 99.95, ask: 100.05, ltp: 100 },
    underlyingLtp: 24000,
    nowTs: BASE_TS + 6_500,
    env: {
      MAX_EXECUTION_AGE_MS: 5_000,
      MAX_LATENCY_GRACE_MS: 3_000,
      EXEC_MAX_PREMIUM_DRIFT_PCT: 1.0,
      EXEC_MAX_SPREAD_BPS: 45,
      OPT_MAX_SPREAD_BPS: 45,
      EXEC_MAX_CHASE_STEPS: 3,
      EXEC_MAX_ENTRY_DEVIATION_PCT: 1.2,
      ENTRY_PENDING_MAX_ADVERSE_UL_BPS: 12,
    },
  });

  assert.equal(executionGate.ok, true);
  assert.equal(executionGate.freshnessSource, "CREATED_AT");
  assert.equal(executionGate.reasonCode, "EXECUTION_ACCEPTED");
  assert.ok(executionGate.signalAgeMs < 5_000);
}

function testExecutionGateAppliesLatencyGraceNearFreshnessBoundary() {
  const executionGate = evaluateExecutionGate({
    signalTs: null,
    trade: {
      side: "BUY",
      signalEventTs: new Date(BASE_TS - 30_000).toISOString(),
      signalCreatedAt: new Date(BASE_TS).toISOString(),
      plannedEntry: 100,
      expectedEntryPrice: 100,
      underlying_ltp: 24000,
      instrument: { tick_size: 0.05 },
      entryPipelineLatency: {
        totalAgeMs: 4_500,
      },
    },
    quote: { bid: 99.95, ask: 100.05, ltp: 100 },
    underlyingLtp: 24000,
    nowTs: BASE_TS + 22_500,
    env: {
      MAX_EXECUTION_AGE_MS: 20_000,
      MAX_LATENCY_GRACE_MS: 5_000,
      EXEC_MAX_PREMIUM_DRIFT_PCT: 1.0,
      EXEC_MAX_SPREAD_BPS: 45,
      OPT_MAX_SPREAD_BPS: 45,
      EXEC_MAX_CHASE_STEPS: 3,
      EXEC_MAX_ENTRY_DEVIATION_PCT: 1.2,
      ENTRY_PENDING_MAX_ADVERSE_UL_BPS: 12,
    },
  });

  assert.equal(executionGate.ok, true);
  assert.equal(executionGate.latencyGraceApplied, true);
  assert.equal(executionGate.reasonCode, "EXECUTION_ACCEPTED");
}

async function main() {
  await testWarmedPremiumCandlesStayOffTheHotPath();
  testLatencyTelemetryContainsFullBreakdown();
  testLatencyTelemetryHighlightsDominantStage();
  testExecutionGateUsesSignalCreatedAtForFreshness();
  testExecutionGateAppliesLatencyGraceNearFreshnessBoundary();
  console.log("signalPipelineConsistency.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
