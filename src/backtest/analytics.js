const { normalizeTradeRow } = require("../trading/tradeNormalization");
const { describeReasonCode, normalizeExitReasonCode, normalizeReasonCode } = require("./reasonCodes");

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeAvg(total, count) {
  return count > 0 ? total / count : 0;
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function isoMonth(value) {
  return new Date(value).toISOString().slice(0, 7);
}

function weekday(value) {
  return new Date(value).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function longestLosingStreak(trades) {
  let best = 0;
  let current = 0;
  for (const trade of trades || []) {
    if (n(trade?.netPnl) < 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
}

function normalizeBacktestTrade(trade, context = {}) {
  const normalized = normalizeTradeRow(trade);
  const exitFill = Array.isArray(trade?.exitFills) && trade.exitFills.length ? trade.exitFills[trade.exitFills.length - 1] : null;
  const qtyFilledEntry = n(trade?.initialQty ?? trade?.qtyFilledEntry ?? trade?.qty);
  const qtyFilledExit = Array.isArray(trade?.exitFills)
    ? trade.exitFills.reduce((acc, fill) => acc + n(fill?.qty), 0)
    : n(trade?.qtyFilledExit ?? trade?.qty);
  const initialStopLoss = n(trade?.initialStopLoss);
  const entryPrice = n(trade?.entryPrice);
  const riskPoints = Math.abs(entryPrice - initialStopLoss);
  const riskInr = riskPoints * qtyFilledEntry;
  const grossPnl = n(trade?.grossPnl ?? trade?.realizedGrossPnl);
  const costs = n(trade?.estCostInr ?? trade?.realizedCostInr);
  const netPnl = n(trade?.netPnl ?? trade?.realizedNetPnl, grossPnl - costs);
  const holdMinutes =
    trade?.entryFilledAt && trade?.exitTs
      ? (new Date(trade.exitTs).getTime() - new Date(trade.entryFilledAt).getTime()) / 60000
      : null;
  const regimeTags = Array.isArray(trade?.regimeTags) ? trade.regimeTags.slice() : [];
  const exitReasonCode = normalizeExitReasonCode(trade.exitReason || exitFill?.reason);

  return {
    tradeId: trade.tradeId || trade.id || null,
    signalTs: trade.signalTs || trade.entryPlacedAt || null,
    entryPlacedAt: trade.entryPlacedAt || null,
    entryFilledAt: trade.entryFilledAt || null,
    exitTs: trade.exitTs || null,
    underlyingToken: n(trade?.option_meta?.underlyingToken ?? context.underlyingToken, null),
    underlyingSymbol: context.underlying || trade?.underlyingSymbol || null,
    contractToken: n(trade?.contractToken ?? normalized.instrument_token, null),
    tradingsymbol: normalized.instrument?.tradingsymbol || null,
    mode: trade.mode || context.mode || null,
    strategyId: normalized.strategyId || null,
    strategyStyle: trade.strategyStyle || trade.sig?.strategyStyle || null,
    regime: trade.regime || regimeTags[0] || null,
    regimeTags,
    side: normalized.side || null,
    confidence: n(trade?.confidence, null),
    qtyRequested: n(trade?.requestedQty, null),
    qtyFilledEntry,
    qtyFilledExit,
    entryPriceExpected: n(trade?.expectedEntryPrice ?? trade?.plannedEntryPrice, null),
    entryPriceFilled: entryPrice,
    exitPriceFilled: n(trade?.exitPrice ?? exitFill?.price, null),
    initialStopLoss,
    finalStopLoss: n(trade?.stopLoss, null),
    initialTargetPrice: n(trade?.initialTargetPrice ?? trade?.targetPrice, null),
    exitReason: trade.exitReason || null,
    exitReasonCode,
    exitReasonText: describeReasonCode(exitReasonCode),
    forcedExit: String(exitReasonCode).startsWith("FORCE_"),
    holdCandles: n(trade?.holdCandles, null),
    holdMinutes,
    grossPnl,
    costs,
    netPnl,
    Rmultiple: riskInr > 0 ? netPnl / riskInr : null,
    MAE: n(trade?.MAE ?? trade?.mae, null),
    MFE: n(trade?.MFE ?? trade?.mfe, null),
    peakR: n(trade?.peakR, null),
    givebackR: n(trade?.givebackR, null),
    beLockHit: Boolean(trade?.beLockHit),
    greenLockActive: Boolean(trade?.greenLockActive),
    mfeLockTier: n(trade?.mfeLockTier, null),
    trailHit: Boolean(trade?.trailHit),
    earlyFailArmed: Boolean(trade?.earlyFailArmed),
    earlyFailReason: trade?.earlyFailReason || null,
    executionSpreadBpsEntry: n(trade?.entryExecutionModel?.spreadBps, null),
    executionSlippageBpsEntry: n(trade?.entryExecutionModel?.slippageBps, null),
    executionLatencyBarsEntry: n(trade?.entryExecutionModel?.latencyBars, null),
    entryFillRatio: n(trade?.entryExecutionModel?.fillRatio, null),
    executionSpreadBpsExit: n(exitFill?.executionModel?.spreadBps, null),
    executionSlippageBpsExit: n(exitFill?.executionModel?.slippageBps, null),
    executionLatencyBarsExit: n(exitFill?.executionModel?.latencyBars, null),
    exitFillRatio: n(exitFill?.executionModel?.fillRatio, null),
  };
}

function computeExecutionReport(trades = []) {
  const average = (rows) => (rows.length ? rows.reduce((acc, value) => acc + Number(value || 0), 0) / rows.length : 0);
  const entrySlippage = trades.map((trade) => n(trade.executionSlippageBpsEntry, null)).filter(Number.isFinite);
  const exitSlippage = trades.map((trade) => n(trade.executionSlippageBpsExit, null)).filter(Number.isFinite);
  const spreads = trades
    .flatMap((trade) => [n(trade.executionSpreadBpsEntry, null), n(trade.executionSpreadBpsExit, null)])
    .filter(Number.isFinite);
  const fillRatios = trades.flatMap((trade) => [n(trade.entryFillRatio, null), n(trade.exitFillRatio, null)]).filter(Number.isFinite);

  return {
    trades: trades.length,
    avgEntrySlippageBps: average(entrySlippage),
    avgExitSlippageBps: average(exitSlippage),
    avgSpreadBps: average(spreads),
    avgFillRatio: average(fillRatios),
    partialFillTrades: trades.filter((trade) => n(trade.entryFillRatio, 1) < 1 || n(trade.exitFillRatio, 1) < 1).length,
  };
}

function computeGroupMetrics(keyName, keyValue, trades = []) {
  const wins = trades.filter((trade) => n(trade.netPnl) > 0);
  const losses = trades.filter((trade) => n(trade.netPnl) <= 0);
  const grossPnl = trades.reduce((acc, trade) => acc + n(trade.grossPnl), 0);
  const netPnl = trades.reduce((acc, trade) => acc + n(trade.netPnl), 0);
  const grossWins = wins.reduce((acc, trade) => acc + n(trade.netPnl), 0);
  const grossLosses = Math.abs(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0));
  const avgWin = safeAvg(grossWins, wins.length);
  const avgLossRaw = safeAvg(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0), losses.length);
  const holdMinutes = trades.map((trade) => n(trade.holdMinutes, null)).filter(Number.isFinite);
  const mfe = trades.map((trade) => n(trade.MFE, null)).filter(Number.isFinite);
  const mae = trades.map((trade) => n(trade.MAE, null)).filter(Number.isFinite);
  let running = 0;
  let peak = 0;
  let maxContribution = 0;
  for (const trade of [...trades].sort((a, b) => new Date(a.exitTs || a.entryFilledAt || 0) - new Date(b.exitTs || b.entryFilledAt || 0))) {
    running += n(trade.netPnl);
    peak = Math.max(peak, running);
    maxContribution = Math.max(maxContribution, peak - running);
  }

  return {
    [keyName]: keyValue,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: safeAvg(wins.length * 100, trades.length),
    grossPnl,
    netPnl,
    avgPnl: safeAvg(netPnl, trades.length),
    avgWin,
    avgLoss: avgLossRaw,
    payoff: losses.length ? Math.abs(avgWin / (avgLossRaw || 1)) : 0,
    expectancy: safeAvg(netPnl, trades.length),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : wins.length ? Number.POSITIVE_INFINITY : 0,
    maxDrawdownContribution: maxContribution,
    avgHoldMin: holdMinutes.length ? holdMinutes.reduce((acc, value) => acc + value, 0) / holdMinutes.length : 0,
    avgMFE: mfe.length ? mfe.reduce((acc, value) => acc + value, 0) / mfe.length : 0,
    avgMAE: mae.length ? mae.reduce((acc, value) => acc + value, 0) / mae.length : 0,
  };
}

function buildGroupedReport(trades, keyName, keyFn) {
  const groups = new Map();
  for (const trade of trades || []) {
    const key = keyFn(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Array.from(groups.entries())
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([key, rows]) => computeGroupMetrics(keyName, key, rows));
}

function buildClosedTradeCurves(trades = [], startingCapital = 0) {
  const ordered = [...(trades || [])].sort((a, b) => new Date(a.exitTs || a.entryFilledAt || 0) - new Date(b.exitTs || b.entryFilledAt || 0));
  const equityCurve = [];
  const drawdownCurve = [];
  let equity = Number(startingCapital || 0);
  let peak = equity;
  for (const trade of ordered) {
    equity += n(trade.netPnl);
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    const drawdownPct = peak > 0 ? (drawdown / peak) * 100 : 0;
    const row = {
      ts: trade.exitTs || trade.entryFilledAt || trade.signalTs || null,
      equity,
      drawdown,
      drawdownPct,
    };
    equityCurve.push(row);
    drawdownCurve.push(row);
  }
  return { equityCurve, drawdownCurve };
}

function buildReasonBreakdown({ trades = [], admissionLog = [], rejectionLog = [] }) {
  const rows = [];
  const appendRows = (category, counter) => {
    const total = Object.values(counter).reduce((acc, value) => acc + value, 0);
    Object.entries(counter)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .forEach(([reasonCode, count]) => {
        rows.push({
          category,
          reasonCode,
          reasonText: describeReasonCode(reasonCode),
          count,
          pct: total > 0 ? (count / total) * 100 : 0,
        });
      });
  };

  const exitCounter = {};
  const rejectionCounter = {};
  const forcedCounter = {};
  const blockCounter = {};

  for (const trade of trades) {
    const code = normalizeExitReasonCode(trade.exitReasonCode || trade.exitReason);
    exitCounter[code] = (exitCounter[code] || 0) + 1;
    if (String(code).startsWith("FORCE_")) forcedCounter[code] = (forcedCounter[code] || 0) + 1;
  }
  for (const row of rejectionLog) {
    const code = normalizeReasonCode(row.rejectionReasonCode);
    rejectionCounter[code] = (rejectionCounter[code] || 0) + 1;
    Object.entries(row)
      .filter(([key, value]) => key.startsWith("blockedBy") && value === true)
      .forEach(([key]) => {
        blockCounter[key] = (blockCounter[key] || 0) + 1;
      });
  }
  appendRows("exit_reason", exitCounter);
  appendRows("rejection_reason", rejectionCounter);
  appendRows("forced_exit", forcedCounter);
  appendRows("block_flag", blockCounter);
  return rows;
}

function buildAnalytics({
  trades = [],
  signalLog = [],
  admissionLog = [],
  rejectionLog = [],
  startingCapital = 0,
  portfolioCurve = [],
  portfolioSummary = null,
}) {
  const wins = trades.filter((trade) => n(trade.netPnl) > 0);
  const losses = trades.filter((trade) => n(trade.netPnl) <= 0);
  const grossPnl = trades.reduce((acc, trade) => acc + n(trade.grossPnl), 0);
  const totalCosts = trades.reduce((acc, trade) => acc + n(trade.costs), 0);
  const netPnl = trades.reduce((acc, trade) => acc + n(trade.netPnl), 0);
  const grossWins = wins.reduce((acc, trade) => acc + n(trade.netPnl), 0);
  const grossLosses = Math.abs(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0));

  const generatedCurves =
    Array.isArray(portfolioCurve) && portfolioCurve.length
      ? {
          equityCurve: portfolioCurve.map((row) => ({
            ts: row.ts,
            equity: n(row.currentEquity ?? row.equity),
            drawdown: n(row.drawdown),
            drawdownPct: n(row.drawdownPct),
            freeCapital: n(row.freeCapital, null),
            usedCapital: n(row.usedCapital, null),
            openRisk: n(row.openRisk, null),
            unrealizedPnL: n(row.unrealizedPnL, null),
          })),
          drawdownCurve: portfolioCurve.map((row) => ({
            ts: row.ts,
            equity: n(row.currentEquity ?? row.equity),
            drawdown: n(row.drawdown),
            drawdownPct: n(row.drawdownPct),
          })),
        }
      : buildClosedTradeCurves(trades, startingCapital);

  const dailyReport = buildGroupedReport(
    trades,
    "day",
    (trade) => isoDate(trade.exitTs || trade.entryFilledAt || trade.signalTs),
  );
  const strategyReport = buildGroupedReport(trades, "strategyId", (trade) => trade.strategyId || "UNKNOWN");
  const monthlyReport = buildGroupedReport(
    trades,
    "month",
    (trade) => isoMonth(trade.exitTs || trade.entryFilledAt || trade.signalTs),
  );
  const regimeReport = buildGroupedReport(trades, "regime", (trade) => trade.regime || "UNKNOWN");
  const entryHourReport = buildGroupedReport(
    trades,
    "entryHour",
    (trade) => new Date(trade.entryFilledAt || trade.signalTs || 0).toISOString().slice(11, 13),
  );
  const dayOfWeekReport = buildGroupedReport(
    trades,
    "dayOfWeek",
    (trade) => weekday(trade.exitTs || trade.entryFilledAt || trade.signalTs),
  );
  const reasonBreakdown = buildReasonBreakdown({ trades, admissionLog, rejectionLog });
  const maxDrawdownInr = generatedCurves.drawdownCurve.length
    ? Math.max(...generatedCurves.drawdownCurve.map((row) => n(row.drawdown)))
    : 0;
  const maxDrawdownPct = generatedCurves.drawdownCurve.length
    ? Math.max(...generatedCurves.drawdownCurve.map((row) => n(row.drawdownPct)))
    : 0;
  const forcedExitCount = trades.filter((trade) => Boolean(trade.forcedExit)).length;
  const rejectedByDataIssues = rejectionLog.filter((row) => row.blockedByDataQuality).length;
  const governorBlockCounts = rejectionLog.reduce((acc, row) => {
    const code = normalizeReasonCode(row.rejectionReasonCode);
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: safeAvg(wins.length * 100, trades.length),
    grossPnl,
    totalCosts,
    netPnl,
    avgPnl: safeAvg(netPnl, trades.length),
    avgPnlPerTrade: safeAvg(netPnl, trades.length),
    expectancy: safeAvg(netPnl, trades.length),
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : wins.length ? Number.POSITIVE_INFINITY : 0,
    avgWin: safeAvg(grossWins, wins.length),
    avgLoss: safeAvg(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0), losses.length),
    payoff: losses.length ? Math.abs(safeAvg(grossWins, wins.length) / (safeAvg(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0), losses.length) || 1)) : 0,
    payoffRatio: losses.length ? Math.abs(safeAvg(grossWins, wins.length) / (safeAvg(losses.reduce((acc, trade) => acc + n(trade.netPnl), 0), losses.length) || 1)) : 0,
    maxDrawdownInr,
    maxDrawdownPct,
    longestLosingStreak: longestLosingStreak(trades),
    bestDay: dailyReport.reduce((best, row) => (n(row.netPnl) > n(best?.netPnl, -Infinity) ? row : best), null),
    worstDay: dailyReport.reduce((worst, row) => (n(row.netPnl) < n(worst?.netPnl, Infinity) ? row : worst), null),
    monthlyPnlTotals: Object.fromEntries(monthlyReport.map((row) => [row.month, row.netPnl])),
    strategyWisePnl: Object.fromEntries(strategyReport.map((row) => [row.strategyId, row.netPnl])),
    regimeWisePnl: Object.fromEntries(regimeReport.map((row) => [row.regime, row.netPnl])),
    drawdownQuality: maxDrawdownInr > 0 ? netPnl / maxDrawdownInr : netPnl > 0 ? Number.POSITIVE_INFINITY : 0,
    totalSignals: signalLog.length,
    totalAdmissions: admissionLog.length,
    totalRejections: rejectionLog.length,
    rejectedByDataIssuesPct: admissionLog.length > 0 ? (rejectedByDataIssues / admissionLog.length) * 100 : 0,
    forcedExitPct: trades.length > 0 ? (forcedExitCount / trades.length) * 100 : 0,
    governorBlockCounts,
    portfolio: portfolioSummary,
  };

  return {
    summary,
    equityCurve: generatedCurves.equityCurve,
    drawdownCurve: generatedCurves.drawdownCurve,
    dailyReport,
    strategyReport,
    monthlyReport,
    regimeReport,
    entryHourReport,
    dayOfWeekReport,
    reasonBreakdown,
    executionReport: computeExecutionReport(trades),
    portfolioSummary,
  };
}

function buildMetrics(trades = [], { startingCapital = 0, signalLog = [], admissionLog = [], rejectionLog = [], portfolioCurve = [], portfolioSummary = null } = {}) {
  return buildAnalytics({
    trades,
    signalLog,
    admissionLog,
    rejectionLog,
    startingCapital,
    portfolioCurve,
    portfolioSummary,
  });
}

module.exports = {
  buildAnalytics,
  buildMetrics,
  buildReasonBreakdown,
  computeExecutionReport,
  normalizeBacktestTrade,
};
