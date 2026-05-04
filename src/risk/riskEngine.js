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
    this.recentFailuresByScope = new Map(); // scope -> [{ ts, reason }]
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

  _failureWindowSec() {
    const sec = Number(env.FAILURE_STREAK_WINDOW_SEC ?? 600);
    return Number.isFinite(sec) && sec > 0 ? sec : 600;
  }

  _maxRecentEntryFailures() {
    const max = Number(
      env.MAX_RECENT_ENTRY_FAILURES ?? env.MAX_CONSECUTIVE_FAILURES ?? 3,
    );
    return Number.isFinite(max) && max > 0 ? max : 3;
  }

  _normalizeFailureSide(side) {
    const s = String(side || "")
      .trim()
      .toUpperCase();
    if (s === "BUY" || s === "SELL") return s;
    return "";
  }

  _normalizeFailureUnderlying(underlying) {
    const raw = String(underlying || "")
      .trim()
      .toUpperCase();
    if (!raw) return "";
    return raw.replace(/\s+/g, "");
  }

  _buildFailureScopeKey({
    underlying,
    side,
    token,
    instrumentToken,
  } = {}) {
    const normalizedSide = this._normalizeFailureSide(side);
    if (!normalizedSide) return "";

    const normalizedUnderlying = this._normalizeFailureUnderlying(underlying);
    const fallbackToken = this._keyOf(instrumentToken ?? token);
    const base = normalizedUnderlying || fallbackToken;
    if (!base) return "";
    return `${base}|${normalizedSide}`;
  }

  _sanitizeFailureEvents(events = []) {
    if (!Array.isArray(events)) return [];
    return events
      .map((event) => {
        const ts = Number(event?.ts);
        if (!Number.isFinite(ts) || ts <= 0) return null;
        const reason = String(event?.reason || "ENTRY_FAILURE")
          .trim()
          .toUpperCase();
        return {
          ts,
          reason: reason || "ENTRY_FAILURE",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  _pruneExpiredFailures({
    nowMs = this.clock.nowMs(),
    emit = true,
  } = {}) {
    const cutoff = nowMs - this._failureWindowSec() * 1000;
    let changed = false;

    for (const [scope, events] of this.recentFailuresByScope.entries()) {
      const sanitized = this._sanitizeFailureEvents(events);
      const kept = sanitized.filter((event) => event.ts >= cutoff);
      if (!kept.length) {
        this.recentFailuresByScope.delete(scope);
        changed = true;
        continue;
      }
      const sizeChanged =
        kept.length !== events.length || kept.length !== sanitized.length;
      const orderChanged = sizeChanged
        ? true
        : kept.some((event, idx) => {
            const prev = events[idx] || {};
            return (
              Number(prev.ts) !== Number(event.ts) ||
              String(prev.reason || "") !== String(event.reason || "")
            );
          });
      if (orderChanged) {
        this.recentFailuresByScope.set(scope, kept);
        changed = true;
      }
    }

    if (changed && emit) this._emitStateChange();
    return changed;
  }

  _getRecentFailuresForScope(
    scopeOrContext,
    {
      nowMs = this.clock.nowMs(),
      prune = true,
      emitPrune = false,
    } = {},
  ) {
    const scope =
      typeof scopeOrContext === "string"
        ? scopeOrContext.trim()
        : this._buildFailureScopeKey(scopeOrContext || {});
    if (!scope) return { scope: "", failures: [] };

    const didPrune = prune
      ? this._pruneExpiredFailures({ nowMs, emit: false })
      : false;
    if (didPrune && emitPrune) this._emitStateChange();

    const failures = this._sanitizeFailureEvents(
      this.recentFailuresByScope.get(scope) || [],
    );
    if (
      emitPrune &&
      failures.length !== (this.recentFailuresByScope.get(scope) || []).length
    ) {
      this.recentFailuresByScope.set(scope, failures);
      this._emitStateChange();
    }
    return { scope, failures };
  }

  markEntryFailure(context = {}) {
    const nowMs = this.clock.nowMs();
    const didPrune = this._pruneExpiredFailures({ nowMs, emit: false });
    const failureScope = this._buildFailureScopeKey(context || {});
    const maxAllowed = this._maxRecentEntryFailures();
    const windowSec = this._failureWindowSec();

    if (!failureScope) {
      if (didPrune) this._emitStateChange();
      return {
        recorded: false,
        blocked: false,
        failureScope: null,
        failureCount: 0,
        maxAllowed,
        windowSec,
      };
    }

    const reason = String(context.reason || "ENTRY_FAILURE")
      .trim()
      .toUpperCase();
    const existing = this._sanitizeFailureEvents(
      this.recentFailuresByScope.get(failureScope) || [],
    );
    const next = [...existing, { ts: nowMs, reason: reason || "ENTRY_FAILURE" }];
    this.recentFailuresByScope.set(failureScope, next);

    const oldestTs = next[0]?.ts ?? nowMs;
    const newestTs = next[next.length - 1]?.ts ?? nowMs;
    const failureCount = next.length;
    const blocked = failureCount >= maxAllowed;

    this._emitStateChange();

    return {
      recorded: true,
      blocked,
      failureScope,
      failureCount,
      maxAllowed,
      windowSec,
      recentFailureReasons: next.map((event) => event.reason),
      oldestFailureAt: new Date(oldestTs).toISOString(),
      newestFailureAt: new Date(newestTs).toISOString(),
      unblockEstimateAt: new Date(oldestTs + windowSec * 1000).toISOString(),
    };
  }

  clearRecentFailuresForScope(scopeOrContext = null) {
    const failureScope =
      typeof scopeOrContext === "string"
        ? scopeOrContext.trim()
        : this._buildFailureScopeKey(scopeOrContext || {});
    if (!failureScope) return false;

    const deleted = this.recentFailuresByScope.delete(failureScope);
    if (deleted) this._emitStateChange();
    return deleted;
  }

  getFailureBlockMeta(context = {}) {
    const nowMs = this.clock.nowMs();
    const didPrune = this._pruneExpiredFailures({ nowMs, emit: false });
    const { scope, failures } = this._getRecentFailuresForScope(context, {
      nowMs,
      prune: false,
    });
    const maxAllowed = this._maxRecentEntryFailures();
    const windowSec = this._failureWindowSec();
    const blocked = failures.length >= maxAllowed;

    if (didPrune) this._emitStateChange();
    if (!blocked) {
      return { blocked: false, meta: null };
    }

    const oldestTs = failures[0]?.ts ?? nowMs;
    const newestTs = failures[failures.length - 1]?.ts ?? nowMs;
    return {
      blocked: true,
      meta: {
        failureScope: scope,
        failureCount: failures.length,
        maxAllowed,
        windowSec,
        recentFailureReasons: failures.map((event) => event.reason),
        oldestFailureAt: new Date(oldestTs).toISOString(),
        newestFailureAt: new Date(newestTs).toISOString(),
        unblockEstimateAt: new Date(oldestTs + windowSec * 1000).toISOString(),
      },
    };
  }

  getState() {
    return {
      kill: this.kill,
      consecutiveFailures: this.consecutiveFailures,
      recentFailuresByScope: Array.from(
        this.recentFailuresByScope.entries(),
      ).reduce((acc, [scope, events]) => {
        const sanitized = this._sanitizeFailureEvents(events);
        if (sanitized.length) acc[scope] = sanitized;
        return acc;
      }, {}),
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
    if (
      state.recentFailuresByScope &&
      typeof state.recentFailuresByScope === "object"
    ) {
      const restored = new Map();
      for (const [scope, events] of Object.entries(state.recentFailuresByScope)) {
        const key = String(scope || "").trim();
        if (!key) continue;
        const sanitized = this._sanitizeFailureEvents(events);
        if (sanitized.length) restored.set(key, sanitized);
      }
      this.recentFailuresByScope = restored;
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
    const didPrune = this._pruneExpiredFailures({ emit: false });
    if (didPrune) this._emitStateChange();
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

  canTrade(tokenOrContext, maybeContext = {}) {
    let token = tokenOrContext;
    let failureContext = maybeContext || {};
    if (
      tokenOrContext &&
      typeof tokenOrContext === "object" &&
      !Array.isArray(tokenOrContext)
    ) {
      failureContext = tokenOrContext;
      token =
        tokenOrContext.token ??
        tokenOrContext.riskKey ??
        tokenOrContext.key ??
        tokenOrContext.instrumentToken ??
        tokenOrContext.instrument_token;
    }
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

    const failureBlock = this.getFailureBlockMeta({
      token,
      instrumentToken:
        failureContext.instrumentToken ?? failureContext.instrument_token,
      side: failureContext.side ?? failureContext.entrySide,
      underlying:
        failureContext.underlying ?? failureContext.underlying_symbol,
    });
    if (failureBlock.blocked) {
      return {
        ok: false,
        reason: "too_many_failures",
        meta: failureBlock.meta,
      };
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
    this.recentFailuresByScope.clear();
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
