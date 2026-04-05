const fs = require("fs");
const path = require("path");
const { writeCsv } = require("./csvWriter");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function markdownTable(rows = [], columns = []) {
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => row[column] ?? "").join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function renderSummaryMarkdown({
  runId,
  summary,
  acceptanceReport,
  dataQualityReport,
  config,
  analytics,
}) {
  const monthlyRows = (analytics.monthlyReport || []).slice(0, 12).map((row) => ({
    month: row.month,
    trades: row.trades,
    netPnl: Number(row.netPnl || 0).toFixed(2),
    winRate: Number(row.winRate || 0).toFixed(2),
    profitFactor: Number(row.profitFactor || 0).toFixed(2),
  }));
  const strategyRows = (analytics.strategyReport || []).slice(0, 10).map((row) => ({
    strategyId: row.strategyId,
    trades: row.trades,
    netPnl: Number(row.netPnl || 0).toFixed(2),
    expectancy: Number(row.expectancy || 0).toFixed(2),
    profitFactor: Number(row.profitFactor || 0).toFixed(2),
  }));
  const regimeRows = (analytics.regimeReport || []).slice(0, 10).map((row) => ({
    regime: row.regime,
    trades: row.trades,
    netPnl: Number(row.netPnl || 0).toFixed(2),
    expectancy: Number(row.expectancy || 0).toFixed(2),
    profitFactor: Number(row.profitFactor || 0).toFixed(2),
  }));
  const rejectionRows = (analytics.reasonBreakdown || [])
    .filter((row) => row.category === "rejection_reason")
    .slice(0, 10)
    .map((row) => ({
      reasonCode: row.reasonCode,
      count: row.count,
      pct: Number(row.pct || 0).toFixed(2),
    }));

  const interpretationLines = [];
  if (acceptanceReport.passed && Number(summary.netPnl || 0) > 0) interpretationLines.push("The run passed the configured acceptance checks with positive net PnL.");
  else if (!acceptanceReport.passed) interpretationLines.push("The run failed at least one configured acceptance gate and should not be treated as validated.");
  else interpretationLines.push("The run passed, but headline performance remains weak and needs review.");
  if (Number(summary.maxDrawdownPct || 0) > 15) interpretationLines.push("Drawdown remains elevated relative to typical intraday option backtests.");
  if (Number(dataQualityReport?.summary?.fail || 0) > 0) interpretationLines.push("Data-quality failures were detected and materially affect trust in the result.");

  const lines = [];
  lines.push(`# Backtest Summary: ${runId}`);
  lines.push("");
  lines.push("## Run Metadata");
  lines.push("");
  lines.push(`- Name: ${config.runMeta.name}`);
  lines.push(`- Date range: ${config.data.from} -> ${config.data.to}`);
  lines.push(`- Instrument: ${config.data.mode} / ${config.data.underlying || config.data.token}`);
  lines.push(`- Strategies: ${(config.strategy.allowedStrategies || []).length ? config.strategy.allowedStrategies.join(", ") : "env/default selector set"}`);
  lines.push(`- Acceptance verdict: ${acceptanceReport.verdict}`);
  lines.push("");
  lines.push("## Capital And Risk");
  lines.push("");
  lines.push(`- Initial capital: ${Number(config.capital.startingCapital || 0).toFixed(2)}`);
  lines.push(`- Capital per trade: ${Number(config.capital.capitalPerTrade || 0).toFixed(2)}`);
  lines.push(`- Risk per trade INR: ${Number(config.risk.riskPerTradeInr || 0).toFixed(2)}`);
  lines.push(`- Max daily loss INR: ${Number(config.risk.maxDailyLossInr || 0).toFixed(2)}`);
  lines.push(`- Max trades/day: ${Number(config.risk.maxTradesPerDay || 0)}`);
  lines.push(`- Max concurrent positions: ${Number(config.risk.maxConcurrentPositions || 0)}`);
  lines.push("");
  lines.push("## Headline Metrics");
  lines.push("");
  lines.push(`- Trades: ${summary.totalTrades}`);
  lines.push(`- Win rate: ${Number(summary.winRate || 0).toFixed(2)}%`);
  lines.push(`- Gross PnL: ${Number(summary.grossPnl || 0).toFixed(2)}`);
  lines.push(`- Costs: ${Number(summary.totalCosts || 0).toFixed(2)}`);
  lines.push(`- Net PnL: ${Number(summary.netPnl || 0).toFixed(2)}`);
  lines.push(`- Expectancy: ${Number(summary.expectancy || 0).toFixed(2)}`);
  lines.push(`- Profit factor: ${Number(summary.profitFactor || 0).toFixed(2)}`);
  lines.push("");
  lines.push("## Drawdown");
  lines.push("");
  lines.push(`- Max drawdown: ${Number(summary.maxDrawdownInr || 0).toFixed(2)} (${Number(summary.maxDrawdownPct || 0).toFixed(2)}%)`);
  lines.push(`- Longest losing streak: ${Number(summary.longestLosingStreak || 0)}`);
  lines.push(`- Data-quality fails: ${Number(dataQualityReport?.summary?.fail || 0)}`);
  lines.push("");

  if (monthlyRows.length) {
    lines.push("## Monthly Stats");
    lines.push("");
    lines.push(markdownTable(monthlyRows, ["month", "trades", "netPnl", "winRate", "profitFactor"]));
    lines.push("");
  }

  if (strategyRows.length) {
    lines.push("## Strategy Stats");
    lines.push("");
    lines.push(markdownTable(strategyRows, ["strategyId", "trades", "netPnl", "expectancy", "profitFactor"]));
    lines.push("");
  }

  if (regimeRows.length) {
    lines.push("## Regime Stats");
    lines.push("");
    lines.push(markdownTable(regimeRows, ["regime", "trades", "netPnl", "expectancy", "profitFactor"]));
    lines.push("");
  }

  if (rejectionRows.length) {
    lines.push("## Top Rejection Reasons");
    lines.push("");
    lines.push(markdownTable(rejectionRows, ["reasonCode", "count", "pct"]));
    lines.push("");
  }

  lines.push("## Acceptance Verdict");
  lines.push("");
  lines.push(`- Verdict: ${acceptanceReport.verdict}`);
  lines.push(`- Failed rules: ${(acceptanceReport.failedRules || []).length ? acceptanceReport.failedRules.join(", ") : "none"}`);
  if ((acceptanceReport.warnings || []).length) lines.push(`- Warnings: ${acceptanceReport.warnings.join(" | ")}`);
  lines.push("");
  lines.push("## Quick Interpretation");
  lines.push("");
  interpretationLines.forEach((line) => lines.push(`- ${line}`));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeReportPack({
  runId,
  resolvedConfig,
  rawTrades,
  normalizedTrades,
  signalLog,
  admissionLog,
  rejectionLog,
  analytics,
  dataQualityReport,
  acceptanceReport,
  outputDir,
}) {
  const runDir = path.join(outputDir, runId);
  ensureDir(runDir);

  const files = {
    runConfig: path.join(runDir, "run_config.json"),
    runSummaryJson: path.join(runDir, "run_summary.json"),
    runSummaryMd: path.join(runDir, "run_summary.md"),
    tradeJson: path.join(runDir, "trade_log.json"),
    tradeCsv: path.join(runDir, "trade_log.csv"),
    signalJson: path.join(runDir, "signal_log.json"),
    signalCsv: path.join(runDir, "signal_log.csv"),
    admissionJson: path.join(runDir, "admission_log.json"),
    admissionCsv: path.join(runDir, "admission_log.csv"),
    rejectionJson: path.join(runDir, "rejection_log.json"),
    rejectionCsv: path.join(runDir, "rejection_log.csv"),
    dailyCsv: path.join(runDir, "daily_report.csv"),
    strategyCsv: path.join(runDir, "strategy_report.csv"),
    monthlyCsv: path.join(runDir, "monthly_report.csv"),
    regimeCsv: path.join(runDir, "regime_report.csv"),
    reasonCsv: path.join(runDir, "reason_breakdown.csv"),
    equityCsv: path.join(runDir, "equity_curve.csv"),
    drawdownCsv: path.join(runDir, "drawdown_curve.csv"),
    executionJson: path.join(runDir, "execution_report.json"),
    dataQualityJson: path.join(runDir, "data_quality_report.json"),
    acceptanceJson: path.join(runDir, "acceptance_report.json"),
  };

  const runSummary = {
    runId,
    generatedAt: new Date().toISOString(),
    summary: analytics.summary,
    portfolioSummary: analytics.portfolioSummary,
    executionReport: analytics.executionReport,
    acceptanceReport,
    dataQualitySummary: dataQualityReport.summary,
    tradeCount: rawTrades.length,
    artifactDir: runDir,
  };

  if (resolvedConfig.reporting.writeJson !== false) {
    writeJson(files.runConfig, resolvedConfig);
    writeJson(files.runSummaryJson, runSummary);
    writeJson(files.tradeJson, normalizedTrades);
    writeJson(files.signalJson, signalLog);
    writeJson(files.admissionJson, admissionLog);
    writeJson(files.rejectionJson, rejectionLog);
    writeJson(files.executionJson, analytics.executionReport);
    writeJson(files.dataQualityJson, dataQualityReport);
    writeJson(files.acceptanceJson, acceptanceReport);
  }

  if (resolvedConfig.reporting.writeCsv !== false) {
    writeCsv(files.tradeCsv, normalizedTrades);
    writeCsv(files.signalCsv, signalLog);
    writeCsv(files.admissionCsv, admissionLog);
    writeCsv(files.rejectionCsv, rejectionLog);
    writeCsv(files.dailyCsv, analytics.dailyReport);
    writeCsv(files.strategyCsv, analytics.strategyReport);
    writeCsv(files.monthlyCsv, analytics.monthlyReport);
    writeCsv(files.regimeCsv, analytics.regimeReport);
    writeCsv(files.reasonCsv, analytics.reasonBreakdown);
    writeCsv(files.equityCsv, analytics.equityCurve);
    writeCsv(files.drawdownCsv, analytics.drawdownCurve);
  }

  if (resolvedConfig.reporting.writeMarkdown !== false) {
    fs.writeFileSync(
      files.runSummaryMd,
      renderSummaryMarkdown({
        runId,
        summary: analytics.summary,
        acceptanceReport,
        dataQualityReport,
        config: resolvedConfig,
        analytics,
      }),
      "utf8",
    );
  }

  if (resolvedConfig.reporting.legacyOutFile) {
    writeJson(resolvedConfig.reporting.legacyOutFile, {
      runId,
      config: resolvedConfig,
      summary: analytics.summary,
      trades: rawTrades,
      normalizedTrades,
      signalLog,
      admissionLog,
      rejectionLog,
      acceptanceReport,
      dataQualityReport,
    });
  }

  return {
    runDir,
    files,
    runSummary,
  };
}

module.exports = {
  renderSummaryMarkdown,
  writeReportPack,
};
