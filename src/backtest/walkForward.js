const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { evaluateAcceptance } = require("./acceptanceEvaluator");
const { buildMetrics } = require("./analytics");
const { createRunId } = require("./helpers");
const { expandMatrixDimensions, applyOverrides } = require("./matrixRunner");
const { loadUnderlyingCandles, runBacktest } = require("./runBacktest");
const { writeCsv } = require("./csvWriter");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueTradingDays(candles = []) {
  return Array.from(new Set(candles.map((candle) => new Date(candle.ts).toISOString().slice(0, 10)))).sort();
}

function buildWalkForwardSegments(tradingDays = [], walkForwardConfig = {}) {
  const trainWindowDays = Number(walkForwardConfig.trainWindowDays || 20);
  const testWindowDays = Number(walkForwardConfig.testWindowDays || 5);
  const stepDays = Number(walkForwardConfig.stepDays || testWindowDays || 1);
  const anchorMode =
    String(walkForwardConfig.anchorMode || (walkForwardConfig.anchored ? "expanding" : "rolling")).toLowerCase() ===
    "expanding"
      ? "expanding"
      : "rolling";
  const segments = [];

  let cursor = 0;
  let foldId = 1;
  while (cursor + trainWindowDays + testWindowDays <= tradingDays.length) {
    const trainStartIdx = anchorMode === "expanding" ? 0 : cursor;
    const trainEndIdx = trainStartIdx + trainWindowDays - 1;
    const testStartIdx = trainEndIdx + 1;
    const testEndIdx = testStartIdx + testWindowDays - 1;
    segments.push({
      foldId,
      anchorMode,
      trainDays: tradingDays.slice(trainStartIdx, trainEndIdx + 1),
      testDays: tradingDays.slice(testStartIdx, testEndIdx + 1),
    });
    cursor += stepDays;
    foldId += 1;
  }
  return segments;
}

function toBoundary(day, timezone, endOfDay = false) {
  const dt = DateTime.fromISO(day, { zone: timezone });
  return endOfDay ? dt.endOf("day").toISO() : dt.startOf("day").toISO();
}

function metricValue(summary, metric) {
  const value = Number(summary?.[metric] || 0);
  if (["maxDrawdownInr", "maxDrawdownPct"].includes(metric)) return -value;
  return value;
}

function pickBestCandidate(results = [], selectionMetric = "netPnl") {
  return [...results]
    .sort((left, right) => metricValue(right.summary, selectionMetric) - metricValue(left.summary, selectionMetric))
    .at(0);
}

function renderFoldSummaryMarkdown({ foldRows, aggregateTrain, aggregateTest, oosAcceptance }) {
  const lines = [];
  lines.push("# Walk-Forward Summary");
  lines.push("");
  lines.push(`- Folds: ${foldRows.length}`);
  lines.push(`- Aggregate train net PnL: ${Number(aggregateTrain.summary.netPnl || 0).toFixed(2)}`);
  lines.push(`- Aggregate test net PnL: ${Number(aggregateTest.summary.netPnl || 0).toFixed(2)}`);
  lines.push(`- OOS acceptance verdict: ${oosAcceptance.verdict}`);
  lines.push("");
  lines.push("| foldId | trainFrom | trainTo | testFrom | testTo | trainNetPnl | testNetPnl | selectedParams |");
  lines.push("| --- | --- | --- | --- | --- | ---: | ---: | --- |");
  for (const row of foldRows) {
    lines.push(
      `| ${row.foldId} | ${row.trainFrom} | ${row.trainTo} | ${row.testFrom} | ${row.testTo} | ${Number(row.trainNetPnl || 0).toFixed(2)} | ${Number(row.testNetPnl || 0).toFixed(2)} | ${row.selectedParams || "{}"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function runWalkForward({
  config,
  db,
  runBacktestFn = runBacktest,
  loadUnderlyingCandlesFn = loadUnderlyingCandles,
}) {
  const candles = await loadUnderlyingCandlesFn({ db, config });
  const days = uniqueTradingDays(candles);
  const folds = buildWalkForwardSegments(days, config.walkForward);
  const candidateRows = expandMatrixDimensions(config.walkForward.candidateParamGrid || {});
  const wfaRunId = createRunId(config.runMeta.name, config.runMeta.seed, "wfa");
  const wfaDir = config.walkForward.outputDir || path.join(config.reporting.outputDir, "wfa", wfaRunId);
  fs.mkdirSync(wfaDir, { recursive: true });

  const allTrainTrades = [];
  const allTestTrades = [];
  const combinedRejections = [];
  const foldRows = [];
  const bestParamsByFold = [];

  for (const fold of folds) {
    const foldDir = path.join(wfaDir, `fold_${String(fold.foldId).padStart(2, "0")}`);
    fs.mkdirSync(foldDir, { recursive: true });

    const baseTrainConfig = clone(config);
    baseTrainConfig.data.from = toBoundary(fold.trainDays[0], config.market.timezone, false);
    baseTrainConfig.data.to = toBoundary(fold.trainDays[fold.trainDays.length - 1], config.market.timezone, true);
    baseTrainConfig.reporting.legacyOutFile = undefined;

    const baseTestConfig = clone(config);
    baseTestConfig.data.from = toBoundary(fold.testDays[0], config.market.timezone, false);
    baseTestConfig.data.to = toBoundary(fold.testDays[fold.testDays.length - 1], config.market.timezone, true);
    baseTestConfig.reporting.legacyOutFile = undefined;

    let selectedCandidate = {
      overrides: {},
      summary: null,
    };

    if (candidateRows.length > 1 || Object.keys(candidateRows[0]?.overrides || {}).length) {
      const candidateResults = [];
      for (let index = 0; index < candidateRows.length; index += 1) {
        const candidate = candidateRows[index];
        const trainConfig = applyOverrides(baseTrainConfig, candidate.overrides);
        trainConfig.reporting.outputDir = path.join(foldDir, "train_candidates");
        trainConfig.runMeta.name = `${config.runMeta.name}_wf${fold.foldId}_train_${index + 1}`;
        trainConfig.metadata.name = trainConfig.runMeta.name;
        const result = await runBacktestFn({ config: trainConfig, db });
        candidateResults.push({
          candidate,
          result,
          summary: result.summary,
        });
      }
      const best = pickBestCandidate(candidateResults, config.walkForward.selectionMetric || "netPnl");
      selectedCandidate = {
        overrides: best?.candidate?.overrides || {},
        summary: best?.summary || null,
      };
      bestParamsByFold.push({
        foldId: fold.foldId,
        selectionMetric: config.walkForward.selectionMetric || "netPnl",
        selectedOverrides: selectedCandidate.overrides,
        trainSummary: selectedCandidate.summary,
      });
    } else {
      bestParamsByFold.push({
        foldId: fold.foldId,
        selectionMetric: config.walkForward.selectionMetric || "netPnl",
        selectedOverrides: {},
        trainSummary: null,
      });
    }

    const trainConfig = applyOverrides(baseTrainConfig, selectedCandidate.overrides);
    trainConfig.reporting.outputDir = path.join(foldDir, "train");
    trainConfig.runMeta.name = `${config.runMeta.name}_wf${fold.foldId}_train`;
    trainConfig.metadata.name = trainConfig.runMeta.name;

    const testConfig = applyOverrides(baseTestConfig, selectedCandidate.overrides);
    testConfig.reporting.outputDir = path.join(foldDir, "test");
    testConfig.runMeta.name = `${config.runMeta.name}_wf${fold.foldId}_test`;
    testConfig.metadata.name = testConfig.runMeta.name;

    const trainResult = await runBacktestFn({ config: trainConfig, db });
    const testResult = await runBacktestFn({ config: testConfig, db });

    allTrainTrades.push(...trainResult.normalizedTrades);
    allTestTrades.push(...testResult.normalizedTrades);
    combinedRejections.push(...(testResult.rejectionLog || []));

    foldRows.push({
      foldId: fold.foldId,
      anchorMode: fold.anchorMode,
      trainFrom: fold.trainDays[0],
      trainTo: fold.trainDays[fold.trainDays.length - 1],
      testFrom: fold.testDays[0],
      testTo: fold.testDays[fold.testDays.length - 1],
      trainNetPnl: Number(trainResult.summary.netPnl || 0),
      testNetPnl: Number(testResult.summary.netPnl || 0),
      trainTrades: Number(trainResult.summary.totalTrades || 0),
      testTrades: Number(testResult.summary.totalTrades || 0),
      trainProfitFactor: Number(trainResult.summary.profitFactor || 0),
      testProfitFactor: Number(testResult.summary.profitFactor || 0),
      selectedParams: JSON.stringify(selectedCandidate.overrides || {}),
      trainAcceptanceVerdict: trainResult.acceptanceReport?.verdict || "UNKNOWN",
      testAcceptanceVerdict: testResult.acceptanceReport?.verdict || "UNKNOWN",
    });
  }

  const aggregateTrain = buildMetrics(allTrainTrades, { startingCapital: config.capital.startingCapital });
  const aggregateTest = buildMetrics(allTestTrades, { startingCapital: config.capital.startingCapital });
  const oosAcceptance = evaluateAcceptance({
    summary: aggregateTest.summary,
    monthlyReport: aggregateTest.monthlyReport,
    acceptanceConfig: config.validation.acceptance,
    outOfSampleSummary: aggregateTest.summary,
    rejectionLog: combinedRejections,
    trades: allTestTrades,
  });

  const foldSummaryJson = {
    wfaRunId,
    generatedAt: new Date().toISOString(),
    folds: foldRows,
    aggregateTrain,
    aggregateTest,
    oosAcceptance,
  };
  const foldSummaryCsv = path.join(wfaDir, "fold_summary.csv");
  const foldSummaryJsonPath = path.join(wfaDir, "fold_summary.json");
  const foldSummaryMd = path.join(wfaDir, "fold_summary.md");
  const oosSummaryCsv = path.join(wfaDir, "oos_summary.csv");
  const oosSummaryJson = path.join(wfaDir, "oos_summary.json");
  const bestParamsPath = path.join(wfaDir, "best_params_by_fold.json");

  writeCsv(foldSummaryCsv, foldRows);
  fs.writeFileSync(foldSummaryJsonPath, JSON.stringify(foldSummaryJson, null, 2), "utf8");
  fs.writeFileSync(
    foldSummaryMd,
    renderFoldSummaryMarkdown({
      foldRows,
      aggregateTrain,
      aggregateTest,
      oosAcceptance,
    }),
    "utf8",
  );
  writeCsv(oosSummaryCsv, [{ ...aggregateTest.summary, verdict: oosAcceptance.verdict }]);
  fs.writeFileSync(
    oosSummaryJson,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary: aggregateTest.summary,
        acceptance: oosAcceptance,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(bestParamsPath, JSON.stringify(bestParamsByFold, null, 2), "utf8");

  return {
    wfaRunId,
    walkDir: wfaDir,
    foldRows,
    aggregateTrain,
    aggregateTest,
    oosAcceptance,
    bestParamsByFold,
  };
}

module.exports = {
  buildWalkForwardSegments,
  pickBestCandidate,
  runWalkForward,
  uniqueTradingDays,
};
