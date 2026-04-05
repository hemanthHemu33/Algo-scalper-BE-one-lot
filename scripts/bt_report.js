#!/usr/bin/env node
const { loadRunConfig } = require("../src/backtest/configLoader");
const { runBacktest } = require("../src/backtest/runBacktest");

async function main() {
  const { config } = loadRunConfig();
  const result = await runBacktest({ config });
  console.log(`Report pack generated: ${result.artifactDir}`);
}

main().catch((error) => {
  console.error("bt_report failed", error);
  process.exit(1);
});
