const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildMetrics } = require("../../src/backtest/analytics");
const { writeReportPack } = require("../../src/backtest/reportWriter");

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-report-"));
const trades = [
  {
    tradeId: "t1",
    strategyId: "ema_pullback",
    regime: "TREND",
    regimeTags: ["TREND", "HIGH_VOL"],
    side: "BUY",
    signalTs: "2026-01-01T09:15:00.000Z",
    entryFilledAt: "2026-01-01T09:16:00.000Z",
    exitTs: "2026-01-01T09:30:00.000Z",
    grossPnl: 500,
    costs: 50,
    netPnl: 450,
    exitReason: "TARGET",
  },
];
const analytics = buildMetrics(trades, {
  startingCapital: 50000,
  signalLog: [],
  admissionLog: [],
  rejectionLog: [],
  portfolioCurve: [],
});

const result = writeReportPack({
  runId: "bt_test",
  resolvedConfig: {
    runMeta: { name: "test" },
    data: { mode: "OPT", token: 260105, underlying: "NIFTY 50", from: "2026-01-01", to: "2026-01-31" },
    capital: { startingCapital: 50000, capitalPerTrade: 20000 },
    risk: { maxDailyLossInr: 1500, maxTradesPerDay: 3, maxConcurrentPositions: 1, riskPerTradeInr: 500 },
    strategy: { allowedStrategies: [] },
    reporting: { writeCsv: true, writeJson: true, writeMarkdown: true, legacyOutFile: undefined },
  },
  rawTrades: trades,
  normalizedTrades: trades,
  signalLog: [],
  admissionLog: [],
  rejectionLog: [],
  analytics,
  dataQualityReport: { summary: { fail: 0 } },
  acceptanceReport: { verdict: "PASS", passed: true, rules: [], failedRules: [], warnings: [] },
  outputDir: outDir,
});

assert.ok(fs.existsSync(path.join(result.runDir, "run_summary.json")));
assert.ok(fs.existsSync(path.join(result.runDir, "trade_log.csv")));
assert.ok(fs.existsSync(path.join(result.runDir, "rejection_log.json")));
assert.ok(fs.existsSync(path.join(result.runDir, "reason_breakdown.csv")));

console.log("reportWriter.test.js passed");
