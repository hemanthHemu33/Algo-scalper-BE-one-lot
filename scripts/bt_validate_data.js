#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { connectMongo, getDb } = require("../src/db");
const { loadRunConfig } = require("../src/backtest/configLoader");
const { createRunId } = require("../src/backtest/helpers");
const { prepareBacktestContext } = require("../src/backtest/runBacktest");
const { hasHardFailures } = require("../src/backtest/dataValidation");

async function main() {
  const { config } = loadRunConfig();
  const runId = createRunId(`${config.runMeta.name}_validate`, config.runMeta.seed, "validate");
  await connectMongo();
  const context = await prepareBacktestContext({
    config,
    db: getDb(),
    includeSignalScan: config.data.mode === "OPT" && config.data.dynamicContracts,
  });

  const outDir = path.join(config.reporting.outputDir, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "data_quality_report.json");
  fs.writeFileSync(outFile, JSON.stringify(context.dataQualityReport, null, 2), "utf8");

  const summary = context.dataQualityReport.summary;
  console.log(`Data validation complete: ${outFile}`);
  console.log(
    `lookAheadGuard=${Boolean(context.dataQualityReport.settings?.lookAheadGuardEnabled)} issues=${summary.totalIssues} fail=${summary.fail} warn=${summary.warn} continuity=${Number(
      context.dataQualityReport.underlyingCoverage?.continuityPct || 0,
    ).toFixed(2)}%`,
  );

  if (config.validation.dataQualityMode === "strict" && hasHardFailures(context.dataQualityReport)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("bt_validate_data failed", error);
  process.exit(1);
});
