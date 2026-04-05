#!/usr/bin/env node
const { connectMongo, getDb } = require("../src/db");
const { loadRunConfig } = require("../src/backtest/configLoader");
const { runMatrix } = require("../src/backtest/matrixRunner");

async function main() {
  const { config } = loadRunConfig();
  await connectMongo();
  const result = await runMatrix({
    config,
    db: getDb(),
  });
  console.log(`Matrix complete: ${result.matrixDir}`);
  console.log(`Rows: ${result.results.length}`);
}

main().catch((error) => {
  console.error("bt_matrix failed", error);
  process.exit(1);
});
