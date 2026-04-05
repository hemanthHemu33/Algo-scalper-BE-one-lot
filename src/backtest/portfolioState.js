class PortfolioState {
  constructor(config = {}) {
    this.initialCapital = Number(config.initialCapital ?? config.startingCapital ?? 0);
    this.currentEquity = this.initialCapital;
    this.peakEquity = this.initialCapital;
    this.drawdown = 0;
    this.freeCapital = this.initialCapital;
    this.usedCapital = 0;
    this.reservedCapital = 0;
    this.openRisk = 0;
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.consecutiveLosses = 0;
    this.tradesToday = 0;
    this.dailyPnL = 0;
    this.dailyLossHit = false;
    this.dailyTradeLimitHit = false;
    this.currentDay = null;

    this.openPositions = new Map();
    this.pendingReservations = new Map();
    this.equitySnapshots = [];
  }

  ensureDay(ts) {
    const nextDay = new Date(ts).toISOString().slice(0, 10);
    if (this.currentDay === nextDay) return;
    this.currentDay = nextDay;
    this.tradesToday = 0;
    this.dailyPnL = 0;
    this.dailyLossHit = false;
    this.dailyTradeLimitHit = false;
  }

  recalculate() {
    this.usedCapital = Array.from(this.openPositions.values()).reduce(
      (acc, position) => acc + Number(position.capitalUsed || 0),
      0,
    );
    this.reservedCapital = Array.from(this.pendingReservations.values()).reduce(
      (acc, reservation) => acc + Number(reservation.capitalUsed || 0),
      0,
    );
    this.openRisk = Array.from(this.openPositions.values()).reduce(
      (acc, position) => acc + Number(position.riskInr || 0),
      0,
    );
    this.unrealizedPnL = Array.from(this.openPositions.values()).reduce(
      (acc, position) => acc + Number(position.unrealizedPnL || 0),
      0,
    );
    this.currentEquity = this.initialCapital + this.realizedPnL + this.unrealizedPnL;
    this.peakEquity = Math.max(this.peakEquity, this.currentEquity);
    this.drawdown = Math.max(0, this.peakEquity - this.currentEquity);
    this.freeCapital = this.currentEquity - this.usedCapital - this.reservedCapital;
  }

  recordSnapshot(ts, extra = {}) {
    this.recalculate();
    const snapshot = {
      ts: ts ? new Date(ts).toISOString() : null,
      currentEquity: this.currentEquity,
      peakEquity: this.peakEquity,
      drawdown: this.drawdown,
      drawdownPct: this.peakEquity > 0 ? (this.drawdown / this.peakEquity) * 100 : 0,
      freeCapital: this.freeCapital,
      usedCapital: this.usedCapital,
      reservedCapital: this.reservedCapital,
      openRisk: this.openRisk,
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      openPositions: this.openPositions.size,
      reservations: this.pendingReservations.size,
      consecutiveLosses: this.consecutiveLosses,
      tradesToday: this.tradesToday,
      dailyPnL: this.dailyPnL,
      dailyLossHit: this.dailyLossHit,
      dailyTradeLimitHit: this.dailyTradeLimitHit,
      ...extra,
    };

    const last = this.equitySnapshots[this.equitySnapshots.length - 1];
    if (last?.ts && snapshot.ts && last.ts === snapshot.ts) {
      this.equitySnapshots[this.equitySnapshots.length - 1] = snapshot;
    } else {
      this.equitySnapshots.push(snapshot);
    }
    return snapshot;
  }

  getSnapshot(ts = null) {
    return this.recordSnapshot(ts);
  }

  reservePosition(reservationId, sizing = {}) {
    this.pendingReservations.set(reservationId, {
      reservationId,
      capitalUsed: Number(sizing.capitalUsed || 0),
      riskInr: Number(sizing.riskInr || 0),
      sizing,
    });
    this.recordSnapshot(null, { event: "reserve" });
  }

  cancelReservation(reservationId) {
    if (!this.pendingReservations.has(reservationId)) return;
    this.pendingReservations.delete(reservationId);
    this.recordSnapshot(null, { event: "cancel_reservation" });
  }

  activatePosition(reservationId, positionId, actualUsage = {}) {
    const reservation = this.pendingReservations.get(reservationId) || {};
    this.pendingReservations.delete(reservationId);
    this.openPositions.set(positionId, {
      positionId,
      capitalUsed: Number(actualUsage.capitalUsed ?? reservation.capitalUsed ?? 0),
      riskInr: Number(actualUsage.riskInr ?? reservation.riskInr ?? 0),
      unrealizedPnL: 0,
      lastMarkTs: actualUsage.ts ? new Date(actualUsage.ts).toISOString() : null,
    });
    this.recordSnapshot(actualUsage.ts || null, { event: "activate_position" });
  }

  updateMarks(ts, openMarks = []) {
    const unrealizedByTrade = new Map();
    for (const mark of openMarks || []) {
      unrealizedByTrade.set(String(mark.tradeId), Number(mark.unrealizedPnL || 0));
    }
    for (const [positionId, position] of this.openPositions.entries()) {
      this.openPositions.set(positionId, {
        ...position,
        unrealizedPnL: Number(unrealizedByTrade.get(String(positionId)) || 0),
        lastMarkTs: ts ? new Date(ts).toISOString() : position.lastMarkTs,
      });
    }
    this.recordSnapshot(ts, { event: "mark_to_market" });
  }

  closePosition(positionId, { ts, netPnl = 0 } = {}) {
    this.ensureDay(ts);
    this.openPositions.delete(positionId);
    const pnl = Number(netPnl || 0);
    this.realizedPnL += pnl;
    this.dailyPnL += pnl;
    this.tradesToday += 1;
    this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;
    this.recordSnapshot(ts, { event: "close_position" });
  }

  getEquityCurve() {
    return this.equitySnapshots.slice();
  }

  getPortfolioStats(ts = null) {
    return this.recordSnapshot(ts);
  }
}

function createPortfolioState(config) {
  return new PortfolioState(config);
}

module.exports = {
  PortfolioState,
  createPortfolioState,
};
