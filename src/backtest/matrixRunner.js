const fs = require("fs");
const path = require("path");
const { configFingerprint, setByPath } = require("./configLoader");
const { writeCsv } = require("./csvWriter");
const { createRunId } = require("./helpers");
const { runBacktest } = require("./runBacktest");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expandMatrixDimensions(dimensions = {}) {
  const keys = Object.keys(dimensions || {});
  if (!keys.length) return [{ overrides: {}, label: "base" }];
  const rows = [];

  function walk(index, current) {
    if (index >= keys.length) {
      rows.push({
        overrides: { ...current },
        label: keys.map((key) => `${key}=${JSON.stringify(current[key])}`).join(" | "),
      });
      return;
    }
    const key = keys[index];
    const values = Array.isArray(dimensions[key]) ? dimensions[key] : [];
    for (const value of values) {
      current[key] = value;
      walk(index + 1, current);
    }
  }

  walk(0, {});
  return rows;
}

function applyOverrides(baseConfig, overrides = {}) {
  const next = clone(baseConfig);
  for (const [dotPath, value] of Object.entries(overrides)) {
    setByPath(next, dotPath.split("."), value);
  }
  return next;
}

function renderMatrixSummaryMarkdown(results = []) {
  const successRows = results.filter((row) => row.status === "success");
  const failedRows = results.filter((row) => row.status !== "success");
  const lines = [];
  lines.push("# Matrix Summary");
  lines.push("");
  lines.push(`- Total runs: ${results.length}`);
  lines.push(`- Successful runs: ${successRows.length}`);
  lines.push(`- Failed runs: ${failedRows.length}`);
  lines.push("");
  lines.push("| runId | netPnl | winRate | profitFactor | expectancy | maxDrawdown | trades | acceptance | status |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const row of results) {
    lines.push(
      `| ${row.runId || "-"} | ${Number(row.netPnl || 0).toFixed(2)} | ${Number(row.winRate || 0).toFixed(2)} | ${Number(row.profitFactor || 0).toFixed(2)} | ${Number(row.expectancy || 0).toFixed(2)} | ${Number(row.maxDrawdown || 0).toFixed(2)} | ${Number(row.trades || 0)} | ${row.acceptanceVerdict || "-"} | ${row.status} |`,
    );
  }
  if (failedRows.length) {
    lines.push("");
    lines.push("## Failures");
    lines.push("");
    failedRows.forEach((row) => lines.push(`- ${row.label}: ${row.error}`));
  }
  return `${lines.join("\n")}\n`;
}

async function runMatrix({ config, db, runBacktestFn = runBacktest }) {
  const rows = expandMatrixDimensions(config.matrix.dimensions);
  const matrixRunId = createRunId(config.runMeta.name, config.runMeta.seed, "matrix");
  const matrixDir = config.matrix.outputDir || path.join(config.reporting.outputDir, "matrix", matrixRunId);
  const runsRoot = path.join(matrixDir, "runs");
  fs.mkdirSync(runsRoot, { recursive: true });

  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const childConfig = applyOverrides(config, row.overrides);
    childConfig.reporting.outputDir = runsRoot;
    childConfig.reporting.legacyOutFile = undefined;
    childConfig.runMeta.name = `${config.runMeta.name}_m${index + 1}`;
    childConfig.metadata.name = childConfig.runMeta.name;
    childConfig.runMeta.seed = Number(config.runMeta.seed || 0) + index;
    childConfig.metadata.seed = childConfig.runMeta.seed;
    const fingerprint = configFingerprint(childConfig);

    try {
      const result = await runBacktestFn({ config: childConfig, db });
      results.push({
        row: index + 1,
        runId: result.runId,
        label: row.label,
        status: "success",
        configFingerprint: fingerprint,
        netPnl: Number(result.summary.netPnl || 0),
        winRate: Number(result.summary.winRate || 0),
        profitFactor: Number(result.summary.profitFactor || 0),
        expectancy: Number(result.summary.expectancy || 0),
        maxDrawdown: Number(result.summary.maxDrawdownInr || 0),
        trades: Number(result.summary.totalTrades || 0),
        acceptanceVerdict: result.acceptanceReport?.verdict || "UNKNOWN",
        artifactDir: result.artifactDir,
        overrides: JSON.stringify(row.overrides),
      });
    } catch (error) {
      results.push({
        row: index + 1,
        runId: null,
        label: row.label,
        status: "failed",
        configFingerprint: fingerprint,
        netPnl: 0,
        winRate: 0,
        profitFactor: 0,
        expectancy: 0,
        maxDrawdown: 0,
        trades: 0,
        acceptanceVerdict: "ERROR",
        artifactDir: null,
        overrides: JSON.stringify(row.overrides),
        error: error.message,
      });
    }
  }

  const summaryJson = {
    matrixRunId,
    generatedAt: new Date().toISOString(),
    results,
  };
  const summaryCsv = path.join(matrixDir, "matrix_summary.csv");
  const summaryJsonPath = path.join(matrixDir, "matrix_summary.json");
  const summaryMd = path.join(matrixDir, "matrix_summary.md");
  writeCsv(summaryCsv, results);
  fs.writeFileSync(summaryJsonPath, JSON.stringify(summaryJson, null, 2), "utf8");
  fs.writeFileSync(summaryMd, renderMatrixSummaryMarkdown(results), "utf8");

  return {
    matrixRunId,
    matrixDir,
    results,
    summaryCsv,
    summaryJson: summaryJsonPath,
    summaryMd,
  };
}

module.exports = {
  applyOverrides,
  expandMatrixDimensions,
  renderMatrixSummaryMarkdown,
  runMatrix,
};
