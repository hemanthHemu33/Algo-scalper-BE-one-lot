const { env } = require("../config");
const { DateTime } = require("luxon");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("../market/marketCalendar");
const { isHalted } = require("../runtime/halt");
const { evaluateMinTradableRiskFit } = require("./evaluateMinTradableRiskFit");

class RiskEngine {
  constructor({ limits, onStateChange, clock } = {}) {
    this.kill = false;
    this.consecutiveFailures = 0;
    this.tradesToday = 0;
    this.openPositions = new Map(); // token -> {tradeId, side, qty}
    this.cooldownUntil = new Map(); // token -> timestamp
    this.limits = limits || {};
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.clock = clock && typeof clock.nowMs === "function" ? clock : { nowMs: () => Date.now() };
  }

  _keyOf(tokenOrKey) {
    if (typeof tokenOrKey === "string") return tokenOrKey.trim();
    const n = Number(tokenOrKey);
    if (Number.isFinite(n)) return String(n);
    return String(tokenOrKey || "").trim();
  }

  setStateChangeHandler(fn) {
    this.onStateChange = typeof fn === "function" ? fn : null;
  }

  setLimits(limits = {}) {
    this.limits = { ...(this.limits || {}), ...(limits || {}) };
  }

  getLimits() {
    return this.limits || {};
  }

  getState() {
    return {
      kill: this.kill,
      consecutiveFailures: this.consecutiveFailures,
      tradesToday: this.tradesToday,
      openPositions: Array.from(this.openPositions.entries()).map(
        ([token, pos]) => ({
          token,
          ...pos,
        }),
      ),
      cooldownUntil: Array.from(this.cooldownUntil.entries()).reduce(
        (acc, [token, ts]) => {
          acc[String(token)] = ts;
          return acc;
        },
        {},
      ),
    };
  }

  applyState(state) {
    if (!state) return;
    if (typeof state.kill === "boolean") this.kill = state.kill;
    if (Number.isFinite(Number(state.consecutiveFailures))) {
      this.consecutiveFailures = Number(state.consecutiveFailures);
    }
    if (Number.isFinite(Number(state.tradesToday))) {
      this.tradesToday = Number(state.tradesToday);
    }
    if (Array.isArray(state.openPositions)) {
      this.openPositions = new Map(
        state.openPositions.map((p) => [this._keyOf(p.token), { ...p }]),
      );
    }
    if (state.cooldownUntil && typeof state.cooldownUntil === "object") {
      this.cooldownUntil = new Map(
        Object.entries(state.cooldownUntil).map(([token, ts]) => [
          this._keyOf(token),
          Number(ts),
        ]),
      );
    }
  }

  _emitStateChange() {
    if (this.onStateChange) this.onStateChange(this.getState());
  }

  setKillSwitch(enabled) {
    this.kill = !!enabled;
    this._emitStateChange();
  }
  getKillSwitch() {
    return this.kill;
  }

  setTradesToday(n) {
    this.tradesToday = Math.max(0, Number(n ?? 0));
    this._emitStateChange();
  }
  setOpenPosition(token, pos) {
    this.openPositions.set(this._keyOf(token), pos);
    this._emitStateChange();
  }
  clearOpenPosition(token) {
    this.openPositions.delete(this._keyOf(token));
    this._emitStateChange();
  }
  setCooldown(token, seconds, reason) {
    const sec = Math.max(0, Number(seconds ?? 0));
    if (!Number.isFinite(sec) || sec <= 0) return;
    const key = this._keyOf(token);
    this.cooldownUntil.set(key, this.clock.nowMs() + sec * 1000);
    this._emitStateChange();
    return { token: key, seconds: sec, reason: reason || null };
  }

  canTrade(token) {
    token = this._keyOf(token);

    if (isHalted()) return { ok: false, reason: "halted" };

    // Time window guard (MIS) + Holiday Calendar guard
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const now = DateTime.fromMillis(this.clock.nowMs()).setZone(tz);

    // Calendar-aware session (weekends + configured trading holidays + special sessions)
    const session = getSessionForDateTime(now, {
      marketOpen: env.MARKET_OPEN,
      marketClose: env.MARKET_CLOSE,
      stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
    });

    if (!session.allowTradingDay) {
      return {
        ok: false,
        reason: session.isWeekend ? "MARKET_CLOSED_WEEKEND" : "MARKET_HOLIDAY",
        meta: {
          dayKey: session.dayKey,
          holidayName: session.holidayName || undefined,
        },
      };
    }

    const {
      open: marketOpen,
      close: marketClose,
      cutoffToday,
    } = buildBoundsForToday(session, now);

    if (marketOpen.isValid && now < marketOpen) {
      return { ok: false, reason: "BEFORE_MARKET_OPEN" };
    }
    if (marketClose.isValid && now > marketClose) {
      return { ok: false, reason: "AFTER_MARKET_CLOSE" };
    }

    // Entry cutoff (use override from special session if provided)
    if (cutoffToday && cutoffToday.isValid && now >= cutoffToday) {
      return { ok: false, reason: "after_entry_cutoff" };
    }

    if (this.consecutiveFailures >= Number(env.MAX_CONSECUTIVE_FAILURES ?? 3)) {
      return { ok: false, reason: "too_many_failures" };
    }

    if (this.kill) return { ok: false, reason: "kill_switch" };
    const maxTradesPerDay = Number(
      (this.limits?.maxTradesPerDay ?? env.MAX_TRADES_PER_DAY) ?? 8,
    );
    if (Number.isFinite(maxTradesPerDay) && this.tradesToday >= maxTradesPerDay)
      return { ok: false, reason: "max_trades_day" };
    const maxOpenTrades = Number(
      (this.limits?.maxOpenTrades ?? env.MAX_OPEN_POSITIONS) ?? 1,
    );
    if (
      Number.isFinite(maxOpenTrades) &&
      this.openPositions.size >= maxOpenTrades
    )
      return { ok: false, reason: "max_open_positions" };
    if (this.openPositions.has(token))
      return { ok: false, reason: "already_in_position" };
    const until = this.cooldownUntil.get(token) || 0;
    if (this.clock.nowMs() < until) return { ok: false, reason: "cooldown" };
    return { ok: true };
  }

  markTradeOpened(token, pos) {
    this.tradesToday += 1;
    this.openPositions.set(this._keyOf(token), pos);
    this._emitStateChange();
  }

  _resolveCooldownSeconds(reasonMeta = {}) {
    const defaultCooldown = Number(
      env.SYMBOL_COOLDOWN_DEFAULT_SEC ?? env.SYMBOL_COOLDOWN_SECONDS ?? 180,
    );

    const status = String(reasonMeta?.status || "").trim().toUpperCase();
    const closeReason = String(reasonMeta?.closeReason || "")
      .trim()
      .toUpperCase();
    const exitReason = String(reasonMeta?.exitReason || "")
      .trim()
      .toUpperCase();

    const reasonText = `${closeReason} ${exitReason}`;
    const hasAnyReason = !!(status || closeReason || exitReason);

    const isStopLoss =
      status === "EXITED_SL" ||
      closeReason.includes("SL") ||
      exitReason.includes("SL");
    if (isStopLoss) {
      return Number(env.SYMBOL_COOLDOWN_AFTER_SL_SEC ?? defaultCooldown);
    }

    const isTimeStop = reasonText.includes("TIME_STOP");
    if (isTimeStop) {
      return Number(
        env.SYMBOL_COOLDOWN_AFTER_TIME_STOP_SEC ?? defaultCooldown,
      );
    }

    const pnl = Number(reasonMeta?.pnl);
    const hasPnl = Number.isFinite(pnl);
    const isProfitReason =
      status === "EXITED_TARGET" ||
      reasonText.includes("TARGET") ||
      reasonText.includes("TP") ||
      (hasPnl && pnl > 0);
    if (isProfitReason) {
      return Number(
        env.SYMBOL_COOLDOWN_AFTER_PROFIT_SEC ?? defaultCooldown,
      );
    }

    if (!hasAnyReason || !hasPnl) {
      return defaultCooldown;
    }

    return defaultCooldown;
  }

  markTradeClosed(token, reasonMeta = {}) {
    const key = this._keyOf(token);
    this.openPositions.delete(key);
    const cooldown = this._resolveCooldownSeconds(reasonMeta);
    this.cooldownUntil.set(key, this.clock.nowMs() + cooldown * 1000);
    this._emitStateChange();
  }

  markFailure(reason) {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= Number(env.MAX_CONSECUTIVE_FAILURES ?? 3)) {
      this.kill = true;
      this._emitStateChange();
      return { killed: true, reason: reason || "failure_limit" };
    }
    this._emitStateChange();
    return { killed: false };
  }

  resetFailures() {
    this.consecutiveFailures = 0;
    this._emitStateChange();
  }

  evaluateMinTradableRiskFit(args = {}) {
    return evaluateMinTradableRiskFit({
      ...args,
      riskBudgetInr:
        args.riskBudgetInr ??
        args.riskInr ??
        env.RISK_PER_TRADE_INR ??
        250,
      expectedSlippagePts:
        args.expectedSlippagePts ?? env.EXPECTED_SLIPPAGE_POINTS ?? 0,
      feePerLotInr:
        args.feePerLotInr ?? env.EXPECTED_FEES_PER_LOT_INR ?? 0,
    });
  }

  calcQty({
    entryPrice,
    stopLoss,
    riskInr: riskInrOverride,
    lotSize,
    expectedSlippagePts,
    feePerLotInr,
  }) {
    const fit = this.evaluateMinTradableRiskFit({
      entryPrice,
      strategyStopLoss: stopLoss,
      lotSize,
      riskBudgetInr: riskInrOverride,
      expectedSlippagePts,
      feePerLotInr,
    });
    return fit?.maxQtyByRisk ?? 0;
  }
}

module.exports = { RiskEngine };
