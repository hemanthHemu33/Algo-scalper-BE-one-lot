const assert = require("node:assert/strict");
const pkg = require("../../package.json");
const { evaluateAcceptance } = require("../../src/backtest/acceptance");

function buildInput(acceptanceConfig) {
  return {
    summary: {
      totalTrades: 20,
      winRate: 55,
      expectancy: 120,
      profitFactor: 1.8,
      maxDrawdownInr: 1000,
      maxDrawdownPct: 5,
      netPnl: 4000,
    },
    monthlyReport: [
      { month: "2026-01", netPnl: 2000 },
      { month: "2026-02", netPnl: 2000 },
    ],
    acceptanceConfig,
  };
}

function testLegacyAcceptanceAliasesPass() {
  const report = evaluateAcceptance(
    buildInput({
      minimumTrades: 10,
      minimumWinRate: 50,
      minimumExpectancy: 0,
      minimumProfitFactor: 1.2,
      maximumDrawdownPct: 10,
      maxSingleMonthPnlShare: 0.8,
    }),
  );

  assert.equal(report.passed, true);
  assert.equal(report.normalizedAcceptanceConfig.minTrades, 10);
  assert.equal(report.normalizedAcceptanceConfig.minWinRate, 50);
  assert.equal(report.normalizedAcceptanceConfig.maxSingleMonthContributionPct, 80);

  const shareRule = report.rules.find(
    (rule) => rule.rule === "maxSingleMonthContributionPct",
  );
  assert.equal(shareRule.threshold, 80);
  assert.equal(shareRule.actual, 50);
  assert.equal(shareRule.thresholdMeta.sourceField, "maxSingleMonthPnlShare");
  assert.equal(shareRule.thresholdMeta.sourceUnit, "ratio");
  assert.equal(shareRule.actualMeta.unit, "pct");
}

function testCanonicalAcceptanceAliasesPass() {
  const report = evaluateAcceptance(
    buildInput({
      minTrades: 10,
      minWinRate: 50,
      minExpectancy: 0,
      minProfitFactor: 1.2,
      maxDrawdownPct: 10,
      maxSingleMonthContributionPct: 80,
    }),
  );

  assert.equal(report.passed, true);
  assert.equal(report.normalizedAcceptanceConfig.minTrades, 10);
  assert.equal(report.normalizedAcceptanceConfig.minWinRate, 50);
  assert.equal(report.normalizedAcceptanceConfig.maxSingleMonthContributionPct, 80);
}

function testDefaultScriptsIncludeAcceptanceCoverage() {
  assert.match(pkg.scripts["test:backtest"], /acceptance\.test\.js|test:acceptance/);
  assert.match(pkg.scripts.test, /test:backtest|acceptance\.test\.js/);
}

function main() {
  testLegacyAcceptanceAliasesPass();
  testCanonicalAcceptanceAliasesPass();
  testDefaultScriptsIncludeAcceptanceCoverage();
  console.log("acceptance.test.js passed");
}

main();
