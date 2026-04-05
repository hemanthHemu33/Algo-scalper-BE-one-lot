#!/usr/bin/env node
const { loadRunConfig } = require("../src/backtest/configLoader");
const { runBacktest } = require("../src/backtest/runBacktest");

async function main() {
  const { config } = loadRunConfig();
  const result = await runBacktest({ config });
  console.log(`Backtest complete: ${result.artifactDir}`);
  console.log(`Acceptance: ${result.acceptanceReport.verdict}`);
  console.log(result.summary);
}

main().catch((error) => {
  console.error("bt_run failed", error);
  process.exit(1);
});
