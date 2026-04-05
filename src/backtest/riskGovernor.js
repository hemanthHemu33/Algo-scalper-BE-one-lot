const { DateTime } = require("luxon");
const { createPortfolioState } = require("./portfolioState");

function clampPositiveInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toLotMultiple(value, lotSize) {
  const safeLot = Math.max(1, clampPositiveInteger(lotSize, 1));
  return Math.floor(Number(value || 0) / safeLot) * safeLot;
}

function buildSizingPreview({
  portfolio,
  config,
  entryPrice,
  stopLoss,
  instrument = {},
  qtyMode = "fixed",
  defaultQty = 1,
  fixedQty,
  lotQty,
}) {
  const price = Number(entryPrice);
  const stop = Number(stopLoss);
  const lotSize = clampPositiveInteger(instrument?.lot_size, 1);
  const marginMultiplier = Number(config.marginMultiplier || 1);
  const reserveBufferPct = Number(config.reserveBufferPct || 0);
  const riskPoints = Math.abs(price - stop);
  const equity = Number(portfolio.currentEquity || portfolio.initialCapital || 0);
  const availableCapital = Number(portfolio.freeCapital || 0);
  const capitalPerTrade = Number(config.capitalPerTrade || 0);
  const capitalBudgetBeforeBuffer = capitalPerTrade > 0 ? Math.min(capitalPerTrade, availableCapital) : availableCapital;
  const capitalBudget = capitalBudgetBeforeBuffer * (1 - reserveBufferPct / 100);
  const riskBudgets = [];
  if (Number(config.riskPerTradeInr || 0) > 0) riskBudgets.push(Number(config.riskPerTradeInr));
  if (Number(config.riskPerTradePct || 0) > 0) riskBudgets.push((equity * Number(config.riskPerTradePct)) / 100);
  const riskBudget = riskBudgets.length ? Math.min(...riskBudgets) : Number.POSITIVE_INFINITY;
  const perLotCapital = price * lotSize * marginMultiplier;
  const perLotRisk = riskPoints > 0 ? riskPoints * lotSize : 0;
  const maxLotsByCapital = perLotCapital > 0 ? Math.floor(capitalBudget / perLotCapital) : 0;
  const maxLotsByAvailableCapital = perLotCapital > 0 ? Math.floor(availableCapital / perLotCapital) : 0;
  const maxLotsByRisk = perLotRisk > 0 ? Math.floor(riskBudget / perLotRisk) : Number.POSITIVE_INFINITY;

  let intendedQty = 0;
  if (qtyMode === "lot_based") intendedQty = clampPositiveInteger(lotQty ?? defaultQty, 1) * lotSize;
  else if (qtyMode === "fixed") intendedQty = clampPositiveInteger(fixedQty ?? defaultQty, lotSize);
  else if (qtyMode === "risk_based" || qtyMode === "capital_capped") intendedQty = Number.POSITIVE_INFINITY;
  else intendedQty = clampPositiveInteger(defaultQty, lotSize);

  const intendedLots = Number.isFinite(intendedQty) ? Math.max(0, Math.floor(intendedQty / lotSize)) : Number.POSITIVE_INFINITY;
  let allowedLots = 0;
  if (qtyMode === "capital_capped") {
    allowedLots = Math.max(0, Math.min(maxLotsByCapital, maxLotsByAvailableCapital, intendedLots));
  } else if (qtyMode === "risk_based") {
    allowedLots = Math.max(0, Math.min(maxLotsByCapital, maxLotsByAvailableCapital, maxLotsByRisk, intendedLots));
  } else {
    allowedLots = Math.max(0, Math.min(maxLotsByCapital, maxLotsByAvailableCapital, maxLotsByRisk, intendedLots));
  }

  const qty = allowedLots * lotSize;
  const requestedQty = Number.isFinite(intendedQty) ? intendedQty : allowedLots * lotSize;
  const sizing = {
    qty,
    lots: allowedLots,
    lotSize,
    requestedQty,
    requestedLots: Number.isFinite(intendedLots) ? intendedLots : allowedLots,
    allowedQty: qty,
    riskPoints,
    riskInr: perLotRisk * allowedLots,
    capitalUsed: perLotCapital * allowedLots,
    capitalBudget,
    availableCapital,
    riskBudget,
    maxLotsByCapital,
    maxLotsByAvailableCapital,
    maxLotsByRisk,
    intendedRisk: perLotRisk * (Number.isFinite(intendedLots) ? intendedLots : allowedLots),
    allowedRisk: perLotRisk * allowedLots,
  };

  let rejectionReason = null;
  if (qty < lotSize) {
    if (maxLotsByCapital < 1 || maxLotsByAvailableCapital < 1) rejectionReason = "INSUFFICIENT_CAPITAL";
    else if (maxLotsByRisk < 1) rejectionReason = "INSUFFICIENT_RISK_BUDGET";
    else rejectionReason = "SIZE_LT_ONE_LOT";
  }

  return {
    ok: !rejectionReason,
    rejectionReason,
    sizing,
  };
}

class RiskGovernor {
  constructor(config = {}) {
    this.config = {
      initialCapital: Number(config.initialCapital ?? config.startingCapital ?? 0),
      startingCapital: Number(config.initialCapital ?? config.startingCapital ?? 0),
      capitalPerTrade: Number(config.capitalPerTrade || 0),
      marginMultiplier: Number(config.marginMultiplier || 1),
      reserveBufferPct: Number(config.reserveBufferPct || 0),
      riskPerTradeInr: Number(config.riskPerTradeInr || 0),
      riskPerTradePct: Number(config.riskPerTradePct || 0),
      maxDailyLossInr: Number(config.maxDailyLossInr || 0),
      maxDrawdownInr: Number(config.maxDrawdownInr || 0),
      maxDrawdownPct: Number(config.maxDrawdownPct || 0),
      maxConsecutiveLosses: Number(config.maxConsecutiveLosses || 0),
      haltAfterConsecutiveLosses: Number(config.haltAfterConsecutiveLosses || 0),
      maxTradesPerDay: Number(config.maxTradesPerDay || 0),
      maxConcurrentPositions: Number(config.maxConcurrentPositions || 1),
      maxOpenRiskInr: Number(config.maxOpenRiskInr || 0),
      entryCutoffTime: config.entryCutoffTime || null,
      timezone: config.timezone || "Asia/Kolkata",
      skipEntriesAfterDrawdownPct: Number(config.skipEntriesAfterDrawdownPct || 0),
      skipEntriesAfterDrawdownInr: Number(config.skipEntriesAfterDrawdownInr || 0),
    };
    this.portfolio = createPortfolioState(this.config);
  }

  currentDrawdownPct() {
    return this.portfolio.peakEquity > 0 ? (this.portfolio.drawdown / this.portfolio.peakEquity) * 100 : 0;
  }

  afterCutoff(ts) {
    if (!this.config.entryCutoffTime || !ts) return false;
    const rawTs = typeof ts === "string" ? DateTime.fromISO(ts, { setZone: true }) : null;
    const dt =
      rawTs?.isValid
        ? rawTs.setZone(this.config.timezone)
        : DateTime.fromJSDate(new Date(ts), { zone: this.config.timezone });
    if (!dt.isValid) return false;
    const [hour, minute] = String(this.config.entryCutoffTime)
      .split(":")
      .map((value) => Number(value));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const cutoff = dt.set({ hour, minute, second: 0, millisecond: 0 });
    return dt >= cutoff;
  }

  getHaltState(ts) {
    this.portfolio.ensureDay(ts);
    this.portfolio.recalculate();
    const reasons = [];
    const dailyLoss = Math.abs(Math.min(0, Number(this.portfolio.dailyPnL || 0)));
    const drawdownPct = this.currentDrawdownPct();
    const lossHaltThreshold = Number(this.config.haltAfterConsecutiveLosses || this.config.maxConsecutiveLosses || 0);

    if (this.config.maxDailyLossInr > 0 && dailyLoss >= this.config.maxDailyLossInr) reasons.push("DAILY_LOSS_HALT");
    if (this.config.maxDrawdownInr > 0 && this.portfolio.drawdown >= this.config.maxDrawdownInr) reasons.push("MAX_DRAWDOWN_HALT");
    if (this.config.maxDrawdownPct > 0 && drawdownPct >= this.config.maxDrawdownPct) reasons.push("MAX_DRAWDOWN_PCT_HALT");
    if (lossHaltThreshold > 0 && this.portfolio.consecutiveLosses >= lossHaltThreshold) {
      reasons.push("MAX_CONSECUTIVE_LOSSES_HALT");
    }
    if (this.config.maxTradesPerDay > 0 && this.portfolio.tradesToday >= this.config.maxTradesPerDay) {
      reasons.push("MAX_TRADES_PER_DAY_HALT");
    }
    if (this.config.maxOpenRiskInr > 0 && this.portfolio.openRisk >= this.config.maxOpenRiskInr) {
      reasons.push("MAX_OPEN_RISK_HALT");
    }
    if (this.config.skipEntriesAfterDrawdownInr > 0 && this.portfolio.drawdown >= this.config.skipEntriesAfterDrawdownInr) {
      reasons.push("SKIP_ON_DRAWDOWN_BLOCK");
    }
    if (this.config.skipEntriesAfterDrawdownPct > 0 && drawdownPct >= this.config.skipEntriesAfterDrawdownPct) {
      reasons.push("SKIP_ON_DRAWDOWN_BLOCK");
    }

    this.portfolio.dailyLossHit = reasons.includes("DAILY_LOSS_HALT");
    this.portfolio.dailyTradeLimitHit = reasons.includes("MAX_TRADES_PER_DAY_HALT");

    return {
      halted: reasons.length > 0,
      reasons,
      currentDay: this.portfolio.currentDay,
      dailyPnL: this.portfolio.dailyPnL,
      dailyLossHit: this.portfolio.dailyLossHit,
      tradesToday: this.portfolio.tradesToday,
      dailyTradeLimitHit: this.portfolio.dailyTradeLimitHit,
      consecutiveLosses: this.portfolio.consecutiveLosses,
      currentEquity: this.portfolio.currentEquity,
      peakEquity: this.portfolio.peakEquity,
      drawdownInr: this.portfolio.drawdown,
      drawdownPct,
      freeCapital: this.portfolio.freeCapital,
      usedCapital: this.portfolio.usedCapital,
      reservedCapital: this.portfolio.reservedCapital,
      openRisk: this.portfolio.openRisk,
      openPositions: this.portfolio.openPositions.size,
      pendingReservations: this.portfolio.pendingReservations.size,
    };
  }

  previewPosition({
    ts,
    entryPrice,
    stopLoss,
    instrument = {},
    qtyMode = "fixed",
    defaultQty = 1,
    fixedQty,
    lotQty,
  }) {
    this.portfolio.ensureDay(ts);
    this.portfolio.recalculate();
    const haltState = this.getHaltState(ts);
    if (haltState.halted) {
      return {
        ok: false,
        rejectionReason: haltState.reasons[0],
        haltState,
        sizing: null,
      };
    }

    if (this.afterCutoff(ts)) {
      return {
        ok: false,
        rejectionReason: "ENTRY_CUTOFF_BLOCK",
        haltState,
        sizing: null,
      };
    }

    const activeCount = this.portfolio.openPositions.size + this.portfolio.pendingReservations.size;
    if (this.config.maxConcurrentPositions > 0 && activeCount >= this.config.maxConcurrentPositions) {
      return {
        ok: false,
        rejectionReason: "MAX_CONCURRENT_BLOCK",
        haltState,
        sizing: null,
      };
    }

    const preview = buildSizingPreview({
      portfolio: this.portfolio,
      config: this.config,
      entryPrice,
      stopLoss,
      instrument,
      qtyMode,
      defaultQty,
      fixedQty,
      lotQty,
    });

    if (!preview.ok) {
      return {
        ok: false,
        rejectionReason: preview.rejectionReason,
        haltState,
        details: preview.sizing,
        sizing: preview.sizing,
      };
    }

    if (this.config.maxOpenRiskInr > 0 && this.portfolio.openRisk + Number(preview.sizing.riskInr || 0) > this.config.maxOpenRiskInr) {
      return {
        ok: false,
        rejectionReason: "MAX_OPEN_RISK_HALT",
        haltState,
        details: preview.sizing,
        sizing: preview.sizing,
      };
    }

    return {
      ok: true,
      haltState,
      sizing: preview.sizing,
    };
  }

  reservePosition(reservationId, preview) {
    if (!preview?.ok || !preview?.sizing) return preview;
    this.portfolio.reservePosition(reservationId, preview.sizing);
    return {
      ok: true,
      reservationId,
      sizing: preview.sizing,
    };
  }

  cancelReservation(reservationId) {
    this.portfolio.cancelReservation(reservationId);
  }

  activatePosition(reservationId, positionId, actualUsage = {}) {
    this.portfolio.activatePosition(reservationId, positionId, actualUsage);
  }

  closePosition(positionId, payload = {}) {
    this.portfolio.closePosition(positionId, payload);
  }

  markToMarket(ts, openTrades = []) {
    const marks = (openTrades || []).map((trade) => {
      const sideMultiplier = String(trade.side).toUpperCase() === "BUY" ? 1 : -1;
      const qty = Number(trade.qty || 0);
      const entryPrice = Number(trade.entryPrice || 0);
      const lastLtp = Number(trade.lastLtp ?? trade.entryPrice ?? 0);
      return {
        tradeId: trade.tradeId,
        unrealizedPnL: (lastLtp - entryPrice) * qty * sideMultiplier,
      };
    });
    this.portfolio.updateMarks(ts, marks);
  }

  getEquityCurve() {
    return this.portfolio.getEquityCurve();
  }

  getPortfolioStats(ts = null) {
    return this.portfolio.getPortfolioStats(ts);
  }
}

function createRiskGovernor(config) {
  return new RiskGovernor(config);
}

module.exports = {
  RiskGovernor,
  buildSizingPreview,
  createRiskGovernor,
  toLotMultiple,
};
