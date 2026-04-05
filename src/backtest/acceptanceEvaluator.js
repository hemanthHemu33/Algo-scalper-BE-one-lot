const { canonicalizeAcceptanceConfig } = require("./acceptanceConfig");

function buildRule({
  rule,
  threshold,
  actual,
  comparator,
  failureText,
  thresholdMeta = null,
  actualMeta = null,
}) {
  if (threshold === undefined || threshold === null || threshold === "") return null;
  const passed = comparator(actual, threshold);
  return {
    rule,
    threshold,
    actual,
    passed,
    message: passed ? `${rule} passed` : failureText,
    thresholdMeta,
    actualMeta,
  };
}

function evaluateAcceptance({
  summary,
  monthlyReport = [],
  acceptanceConfig: rawAcceptanceConfig = {},
  outOfSampleSummary = null,
  rejectionLog = [],
  trades = [],
}) {
  const {
    acceptanceConfig,
    compatibility,
  } = canonicalizeAcceptanceConfig(rawAcceptanceConfig);
  const rules = [];
  const warnings = [];

  const positiveMonths = monthlyReport.filter((row) => Number(row.netPnl || 0) > 0).length;
  const bestMonth = monthlyReport.reduce(
    (best, row) => (Number(row?.netPnl ?? -Infinity) > Number(best?.netPnl ?? -Infinity) ? row : best),
    null,
  );
  const netPnl = Number(summary?.netPnl || 0);
  const singleMonthContributionPct =
    Math.abs(netPnl) > 0 && bestMonth ? (Math.abs(Number(bestMonth.netPnl || 0)) / Math.abs(netPnl)) * 100 : 0;
  const rejectedByDataIssuesPct =
    Number(summary?.totalAdmissions || 0) > 0
      ? (rejectionLog.filter((row) => row.blockedByDataQuality).length / Number(summary.totalAdmissions)) * 100
      : 0;
  const forcedExitPct =
    Number(summary?.totalTrades || 0) > 0
      ? (trades.filter((trade) => Boolean(trade.forcedExit)).length / Number(summary.totalTrades)) * 100
      : 0;

  rules.push(
    buildRule({
      rule: "minTrades",
      threshold: acceptanceConfig.minTrades,
      actual: summary?.totalTrades,
      comparator: (actual, threshold) => Number(actual) >= Number(threshold),
      failureText: "Minimum trade count not met",
      thresholdMeta: compatibility.minTrades,
    }),
    buildRule({
      rule: "minNetPnl",
      threshold: acceptanceConfig.minNetPnl,
      actual: summary?.netPnl,
      comparator: (actual, threshold) => Number(actual) >= Number(threshold),
      failureText: "Net PnL is below the required threshold",
      thresholdMeta: compatibility.minNetPnl,
    }),
    buildRule({
      rule: "minProfitFactor",
      threshold: acceptanceConfig.minProfitFactor,
      actual: summary?.profitFactor,
      comparator: (actual, threshold) => Number(actual) >= Number(threshold),
      failureText: "Profit factor is below the required threshold",
      thresholdMeta: compatibility.minProfitFactor,
    }),
    buildRule({
      rule: "minExpectancy",
      threshold: acceptanceConfig.minExpectancy,
      actual: summary?.expectancy,
      comparator: (actual, threshold) => Number(actual) >= Number(threshold),
      failureText: "Expectancy is below the required threshold",
      thresholdMeta: compatibility.minExpectancy,
    }),
    buildRule({
      rule: "minWinRate",
      threshold: acceptanceConfig.minWinRate,
      actual: summary?.winRate,
      comparator: (actual, threshold) => Number(actual) >= Number(threshold),
      failureText: "Win rate is below the required threshold",
      thresholdMeta: compatibility.minWinRate,
      actualMeta: {
        unit: "pct",
      },
    }),
    buildRule({
      rule: "maxDrawdownAbs",
      threshold: acceptanceConfig.maxDrawdownAbs,
      actual: summary?.maxDrawdownInr,
      comparator: (actual, threshold) => Number(actual) <= Number(threshold),
      failureText: "Absolute drawdown exceeded the threshold",
      thresholdMeta: compatibility.maxDrawdownAbs,
    }),
    buildRule({
      rule: "maxDrawdownPct",
      threshold: acceptanceConfig.maxDrawdownPct,
      actual: summary?.maxDrawdownPct,
      comparator: (actual, threshold) => Number(actual) <= Number(threshold),
      failureText: "Drawdown percentage exceeded the threshold",
      thresholdMeta: compatibility.maxDrawdownPct,
      actualMeta: {
        unit: "pct",
      },
    }),
    buildRule(
      {
        rule: "maxSingleMonthContributionPct",
        threshold: acceptanceConfig.maxSingleMonthContributionPct,
        actual: singleMonthContributionPct,
        comparator: (actual, threshold) => Number(actual) <= Number(threshold),
        failureText: "A single month contributed too much of the total PnL",
        thresholdMeta: compatibility.maxSingleMonthContributionPct,
        actualMeta: {
          unit: "pct",
          normalizedValue: singleMonthContributionPct,
        },
      },
    ),
    buildRule(
      {
        rule: "minMonthsPositive",
        threshold: acceptanceConfig.minMonthsPositive,
        actual: positiveMonths,
        comparator: (actual, threshold) => Number(actual) >= Number(threshold),
        failureText: "Too few positive months",
        thresholdMeta: compatibility.minMonthsPositive,
      },
    ),
    buildRule(
      {
        rule: "maxRejectedByDataIssuesPct",
        threshold: acceptanceConfig.maxRejectedByDataIssuesPct,
        actual: rejectedByDataIssuesPct,
        comparator: (actual, threshold) => Number(actual) <= Number(threshold),
        failureText: "Too many signals were rejected because of data issues",
        thresholdMeta: compatibility.maxRejectedByDataIssuesPct,
        actualMeta: {
          unit: "pct",
        },
      },
    ),
    buildRule(
      {
        rule: "maxForcedExitPct",
        threshold: acceptanceConfig.maxForcedExitPct,
        actual: forcedExitPct,
        comparator: (actual, threshold) => Number(actual) <= Number(threshold),
        failureText: "Too many trades were closed by forced exits",
        thresholdMeta: compatibility.maxForcedExitPct,
        actualMeta: {
          unit: "pct",
        },
      },
    ),
  );

  if (acceptanceConfig.minOOSProfitFactor !== undefined || acceptanceConfig.minOOSNetPnl !== undefined) {
    if (!outOfSampleSummary) {
      warnings.push("OOS acceptance thresholds were configured but no out-of-sample summary was supplied.");
    } else {
      rules.push(
        buildRule(
          {
            rule: "minOOSProfitFactor",
            threshold: acceptanceConfig.minOOSProfitFactor,
            actual: outOfSampleSummary.profitFactor,
            comparator: (actual, threshold) => Number(actual) >= Number(threshold),
            failureText: "Out-of-sample profit factor is below the required threshold",
            thresholdMeta: compatibility.minOOSProfitFactor,
          },
        ),
        buildRule(
          {
            rule: "minOOSNetPnl",
            threshold: acceptanceConfig.minOOSNetPnl,
            actual: outOfSampleSummary.netPnl,
            comparator: (actual, threshold) => Number(actual) >= Number(threshold),
            failureText: "Out-of-sample net PnL is below the required threshold",
            thresholdMeta: compatibility.minOOSNetPnl,
          },
        ),
      );
    }
  }

  if (acceptanceConfig.requireOutOfSampleProfitable) {
    if (!outOfSampleSummary) warnings.push("Out-of-sample profitability rule was configured but no OOS summary was supplied.");
    else {
      rules.push({
        rule: "requireOutOfSampleProfitable",
        threshold: true,
        actual: Number(outOfSampleSummary.netPnl || 0),
        passed: Number(outOfSampleSummary.netPnl || 0) > 0,
        message:
          Number(outOfSampleSummary.netPnl || 0) > 0
            ? "requireOutOfSampleProfitable passed"
            : "Out-of-sample net PnL is not positive",
      });
    }
  }

  const compactRules = rules.filter(Boolean);
  const failedRules = compactRules.filter((rule) => !rule.passed);
  if (!summary?.totalTrades) warnings.push("No closed trades were produced.");
  if (Number(summary?.netPnl || 0) <= 0) warnings.push("Net PnL is not positive.");

  let headlineInterpretation = "Backtest passed the configured acceptance rules.";
  if (failedRules.length) {
    headlineInterpretation = `Backtest failed ${failedRules.length} configured rule${failedRules.length > 1 ? "s" : ""}.`;
  } else if (warnings.length) {
    headlineInterpretation = "Backtest passed, but warnings remain that should be reviewed before promotion.";
  }

  return {
    passed: failedRules.length === 0,
    verdict: failedRules.length === 0 ? "PASS" : "FAIL",
    rules: compactRules,
    failedRules: failedRules.map((rule) => rule.rule),
    warnings,
    headlineInterpretation,
    normalizedAcceptanceConfig: acceptanceConfig,
    acceptanceCompatibility: compatibility,
    stats: {
      positiveMonths,
      singleMonthContributionPct,
      winRate: Number(summary?.winRate || 0),
      rejectedByDataIssuesPct,
      forcedExitPct,
    },
  };
}

module.exports = {
  evaluateAcceptance,
};
