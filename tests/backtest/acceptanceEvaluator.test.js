const assert = require("node:assert/strict");
const { evaluateAcceptance } = require("../../src/backtest/acceptanceEvaluator");

function buildInput(acceptanceConfig, summaryOverrides = {}) {
  return {
    summary: {
      totalTrades: 20,
      totalAdmissions: 30,
      winRate: 55,
      profitFactor: 1.8,
      expectancy: 120,
      maxDrawdownInr: 1000,
      maxDrawdownPct: 5,
      netPnl: 4000,
      ...summaryOverrides,
    },
    monthlyReport: [
      { month: "2026-01", netPnl: 2000 },
      { month: "2026-02", netPnl: 2000 },
    ],
    rejectionLog: [
      { blockedByDataQuality: false },
      { blockedByDataQuality: true },
    ],
    trades: [{ forcedExit: false }, { forcedExit: true }],
    acceptanceConfig,
  };
}

function testCanonicalThresholdsStillWork() {
  const report = evaluateAcceptance(
    buildInput({
      minTrades: 10,
      minNetPnl: 0,
      minProfitFactor: 1.2,
      minExpectancy: 0,
      maxDrawdownPct: 10,
      maxSingleMonthContributionPct: 80,
      minMonthsPositive: 2,
      maxRejectedByDataIssuesPct: 2,
      maxForcedExitPct: 60,
    }),
  );

  assert.equal(report.passed, false);
  assert.ok(report.failedRules.includes("maxRejectedByDataIssuesPct"));
}

function testMinimumWinRateIsEnforcedForLegacyAndCanonicalFields() {
  const legacyReport = evaluateAcceptance(
    buildInput(
      {
        minimumWinRate: 60,
      },
      {
        winRate: 55,
      },
    ),
  );
  const canonicalReport = evaluateAcceptance(
    buildInput(
      {
        minWinRate: 60,
      },
      {
        winRate: 55,
      },
    ),
  );

  assert.equal(legacyReport.passed, false);
  assert.equal(canonicalReport.passed, false);
  assert.ok(legacyReport.failedRules.includes("minWinRate"));
  assert.ok(canonicalReport.failedRules.includes("minWinRate"));
  assert.equal(legacyReport.normalizedAcceptanceConfig.minWinRate, 60);
  assert.equal(canonicalReport.normalizedAcceptanceConfig.minWinRate, 60);
}

function testSingleMonthContributionNormalizesRatioAndPercentInputs() {
  const ratioReport = evaluateAcceptance(
    buildInput({
      maxSingleMonthPnlShare: 0.4,
    }),
  );
  const percentReport = evaluateAcceptance(
    buildInput({
      maxSingleMonthContributionPct: 40,
    }),
  );

  assert.equal(ratioReport.passed, false);
  assert.equal(percentReport.passed, false);
  assert.equal(
    ratioReport.normalizedAcceptanceConfig.maxSingleMonthContributionPct,
    40,
  );
  assert.equal(
    percentReport.normalizedAcceptanceConfig.maxSingleMonthContributionPct,
    40,
  );

  const ratioRule = ratioReport.rules.find(
    (rule) => rule.rule === "maxSingleMonthContributionPct",
  );
  const percentRule = percentReport.rules.find(
    (rule) => rule.rule === "maxSingleMonthContributionPct",
  );
  assert.equal(ratioRule.thresholdMeta.sourceUnit, "ratio");
  assert.equal(percentRule.thresholdMeta.sourceUnit, "pct");
  assert.equal(ratioRule.thresholdMeta.unit, "pct");
  assert.equal(percentRule.thresholdMeta.unit, "pct");
  assert.equal(ratioRule.actual, 50);
  assert.equal(percentRule.actual, 50);
}

function main() {
  testCanonicalThresholdsStillWork();
  testMinimumWinRateIsEnforcedForLegacyAndCanonicalFields();
  testSingleMonthContributionNormalizesRatioAndPercentInputs();
  console.log("acceptanceEvaluator.test.js passed");
}

main();
