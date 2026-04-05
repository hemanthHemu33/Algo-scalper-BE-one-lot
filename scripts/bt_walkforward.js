#!/usr/bin/env node
const { connectMongo, getDb } = require("../src/db");
const { loadRunConfig } = require("../src/backtest/configLoader");
const { runWalkForward } = require("../src/backtest/walkForward");

async function main() {
  const { config } = loadRunConfig();
  await connectMongo();
  const result = await runWalkForward({
    config,
    db: getDb(),
  });
  console.log(`Walk-forward complete: ${result.walkDir}`);
  console.log(`OOS acceptance: ${result.oosAcceptance.verdict}`);
  console.log(result.aggregateTest.summary);
}

main().catch((error) => {
  console.error("bt_walkforward failed", error);
  process.exit(1);
});
