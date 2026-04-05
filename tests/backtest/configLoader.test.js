const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadRunConfig } = require("../../src/backtest/configLoader");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-config-"));
const configPath = path.join(dir, "sample.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    metadata: { name: "cfg_name", seed: 7 },
    data: {
      from: "2026-01-01T00:00:00+05:30",
      to: "2026-01-31T23:59:59+05:30",
      interval: 1,
      warmup: 80,
    },
    instrument: {
      mode: "OPT",
      token: 260105,
      underlying: "NIFTY 50",
      dynamicContracts: true,
      optionType: "CE",
    },
    strategies: {
      qtyMode: "fixed",
      defaultQty: 50,
      confidenceThreshold: 55,
    },
    reports: {
      outputDir: "reports/backtests/test_override",
    },
  }),
  "utf8",
);

const { config } = loadRunConfig({
  argv: [`--config=${configPath}`, "--seed=42", "--qty=75", "--confidenceMin=65"],
});

assert.equal(config.runMeta.seed, 42);
assert.equal(config.strategy.defaultQty, 75);
assert.equal(config.strategy.confidenceMin, 65);
assert.ok(config.reporting.outputDir.endsWith(path.join("reports", "backtests", "test_override")));
assert.equal(config.acceptance.minTrades, 0);

assert.throws(
  () =>
    loadRunConfig({
      configOverrides: {
        metadata: { name: "bad" },
        data: { from: "2026-01-31T00:00:00+05:30", to: "2026-01-01T00:00:00+05:30", interval: 1, warmup: 10 },
        instrument: { mode: "EQ", token: 260105 },
        strategies: { qtyMode: "fixed", defaultQty: 1 },
        reports: { outputDir: "reports/backtests" },
      },
    }),
  /data\.from must be earlier than data\.to/,
);

assert.throws(
  () =>
    loadRunConfig({
      configOverrides: {
        metadata: { name: "bad-cutoff" },
        data: { from: "2026-01-01T00:00:00+05:30", to: "2026-01-02T00:00:00+05:30", interval: 1, warmup: 10 },
        instrument: { mode: "EQ", token: 260105 },
        strategies: { qtyMode: "fixed", defaultQty: 1 },
        reports: { outputDir: "reports/backtests" },
        risk: { entryCutoffTime: "3pm" },
      },
    }),
  /risk\.entryCutoffTime must use HH:mm format/,
);

assert.throws(
  () =>
    loadRunConfig({
      configOverrides: {
        metadata: { name: "unsupported-optimizer" },
        data: { from: "2026-01-01T00:00:00+05:30", to: "2026-01-02T00:00:00+05:30", interval: 1, warmup: 10 },
        instrument: { mode: "EQ", token: 260105 },
        strategies: { qtyMode: "fixed", defaultQty: 1 },
        reports: { outputDir: "reports/backtests" },
        strategy: { optimizerGateEnabled: true },
      },
    }),
  /optimizerGateEnabled is not supported in backtest mode/,
);

const { config: acceptanceCompatConfig } = loadRunConfig({
  configOverrides: {
    metadata: { name: "acceptance-compat", seed: 1 },
    data: {
      from: "2026-01-01T00:00:00+05:30",
      to: "2026-01-02T00:00:00+05:30",
      interval: 1,
      warmup: 10,
    },
    instrument: { mode: "EQ", token: 260105 },
    strategies: { qtyMode: "fixed", defaultQty: 1 },
    reports: { outputDir: "reports/backtests" },
    acceptance: {
      minimumTrades: 12,
      minimumWinRate: 54,
      maxSingleMonthPnlShare: 0.8,
    },
  },
});

assert.equal(acceptanceCompatConfig.acceptance.minTrades, 12);
assert.equal(acceptanceCompatConfig.acceptance.minWinRate, 54);
assert.equal(
  acceptanceCompatConfig.acceptance.maxSingleMonthContributionPct,
  80,
);

console.log("configLoader.test.js passed");
