const { env, subscribeTokens, subscribeSymbols } = require("../config");
const { reportFault, reportWindowedFault } = require("../runtime/errorBus");
const {
  resolveSubscribeTokens,
  ensureInstrument,
} = require("../instruments/instrumentRepo");
const { buildFnoUniverse, getLastFnoUniverse } = require("../fno/fnoUniverse");
const { logger } = require("../logger");
const { alert } = require("../alerts/alertService");
const { isHalted } = require("../runtime/halt");
const { setTradingEnabled } = require("../runtime/tradingEnabled");
const { createTicker, createKiteConnect } = require("./kiteClients");
const { buildPipeline } = require("../pipeline");
const { updateFromTicks } = require("../market/ltpStream");
const { MarketGate } = require("../market/marketGate");
const { isMarketOpenNow } = require("../market/isMarketOpenNow");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");

let kite = null;
let ticker = null;

let currentToken = null;
let pipeline = null;
let tickerConnected = false;
let lastDisconnect = null;

// Tick batching (prevents overlapping async handlers)
let tickQueue = [];
let draining = false;

let reconcileTimer = null;
let ocoReconcileTimer = null;
let marketGate = null;
let tickWatchdogTimer = null;
let tickTapTimer = null;
let tickTapCount = 0;
let lastTickAt = 0;
let recentOrderUpdateKeys = new Map();

// Track ALL subscribed tokens (base universe + runtime position tokens)
let subscribedTokens = new Set();
let tokenModeByToken = new Map();
let _lastPosResubAt = 0;
let _lastUniverseRebuildAt = 0;
let runtimeInitRetryTimer = null;
let runtimeInitRetryAttempt = 0;
let runtimeInitInFlight = false;
let runtimeInitDegraded = false;
let runtimeInitContext = null;

function _bool(v, def = false) {
  if (v === undefined || v === null) return def;
  return String(v).toLowerCase() === "true";
}

function _num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function _isResubEnabled() {
  return _bool(env.POSITION_RESUBSCRIBE_ENABLED, true);
}

function _isResubOnReconnect() {
  return _bool(env.POSITION_RESUBSCRIBE_ON_RECONNECT, true);
}

function _wantUnderlying() {
  return _bool(env.POSITION_RESUBSCRIBE_UNDERLYING, true);
}

// IMPORTANT: product filtering is dangerous for recovery (can silently skip true open positions).
// Keep it OFF by default; enable only if you REALLY want it.
function _respectProductStrict() {
  // Accept both names (config drift/back-compat)
  return (
    _bool(env.POSITION_RESUBSCRIBE_RESPECT_PRODUCT, false) ||
    _bool(env.POSITION_RESUBSCRIBE_PRODUCT_STRICT, false)
  );
}

function _isOptLikeInstrument(doc) {
  const seg = String(doc?.segment || "").toUpperCase();
  const it = String(doc?.instrument_type || "").toUpperCase();
  return seg.includes("-OPT") || it === "CE" || it === "PE" || it === "OPT";
}

function _modeStrSafe(v, def = "full") {
  const m = String(v || def || "full").toLowerCase();
  if (m === "ltp") return "ltp";
  if (m === "quote") return "quote";
  return "full";
}

function _shouldControlTrading() {
  return _bool(env.MARKET_GATE_CONTROL_TRADING, true);
}

function _isLifecycleEnabled() {
  return _bool(env.ENGINE_LIFECYCLE_ENABLED, false);
}

function _marketGatePollMs() {
  return _num(env.MARKET_GATE_POLL_MS, 5000);
}

function _tickWatchdogEnabled() {
  return _bool(env.TICK_WATCHDOG_ENABLED, true);
}

function _tickWatchdogIntervalMs() {
  return _num(env.TICK_WATCHDOG_INTERVAL_MS, 5000);
}

function _tickWatchdogMaxAgeMs() {
  return _num(env.TICK_WATCHDOG_MAX_AGE_MS, 15000);
}

function _tickTapEnabled() {
  return _bool(env.TICK_TAP_LOG, false);
}

const _alertCooldown = new Map();

function alertWithCooldown(key, minMs, level, message, meta) {
  const now = Date.now();
  const last = Number(_alertCooldown.get(key) || 0);
  if (now - last < minMs) return;
  _alertCooldown.set(key, now);
  alert(level, message, meta).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
}

function startMarketGate() {
  if (marketGate) return marketGate;
  marketGate = new MarketGate({
    isOpenFn: isMarketOpenNow,
    pollMs: _marketGatePollMs(),
  });

  marketGate.on("open", () => {
    logger.info("[market] OPEN -> enabling signals/trading");
    if (_isLifecycleEnabled()) {
      logger.info("[market] OPEN -> lifecycle owns trading state");
      return;
    }
    if (_shouldControlTrading()) {
      setTradingEnabled(null);
    }
  });

  marketGate.on("close", () => {
    logger.info("[market] CLOSE -> disabling new entries");
    if (_isLifecycleEnabled()) {
      logger.info("[market] CLOSE -> lifecycle owns trading state");
      return;
    }
    if (_shouldControlTrading()) {
      setTradingEnabled(false);
    }
  });

  marketGate.start();
  return marketGate;
}

function startTickWatchdog() {
  if (tickWatchdogTimer || !_tickWatchdogEnabled()) return;
  const intervalMs = _tickWatchdogIntervalMs();
  const maxAgeMs = _tickWatchdogMaxAgeMs();
  tickWatchdogTimer = setInterval(() => {
    if (!ticker || !tickerConnected) return;
    if (!marketGate?.isOpen?.()) return;
    if (!subscribedTokens.size) return;
    if (!lastTickAt) return;
    const age = Date.now() - lastTickAt;
    if (age <= maxAgeMs) return;
    const tokens = Array.from(subscribedTokens);
    logger.warn({ age, tokens: tokens.length }, "[ticks] no ticks -> resubscribing");
    alertWithCooldown(
      "tick_watchdog_no_ticks",
      300_000,
      "warn",
      "⚠️ Tick stream stale, re-subscribing",
      { ageMs: age, tokens: tokens.length },
    );
    try {
      ticker.subscribe(tokens);
      _applyModesFromCache(tokens);
    } catch (e) {
      logger.warn({ e: e?.message || String(e) }, "[ticks] resubscribe failed");
    }
  }, Math.max(1000, intervalMs));
}

function startTickTapLogger() {
  if (tickTapTimer || !_tickTapEnabled()) return;
  tickTapTimer = setInterval(() => {
    logger.info({ ticks10s: tickTapCount }, "[ticktap]");
    tickTapCount = 0;
  }, 10000);
}

function stopTickWatchdog() {
  if (tickWatchdogTimer) {
    clearInterval(tickWatchdogTimer);
    tickWatchdogTimer = null;
  }
}

function stopTickTapLogger() {
  if (tickTapTimer) {
    clearInterval(tickTapTimer);
    tickTapTimer = null;
  }
  tickTapCount = 0;
}

function stopMarketGate() {
  if (!marketGate) return;
  try {
    if (typeof marketGate.stop === "function") {
      marketGate.stop();
    }
  } catch (err) {
    logger.warn(
      { step: "marketGate.stop", e: err?.message || String(err) },
      "[kite] cleanup step failed",
    );
  }
  try {
    if (typeof marketGate.removeAllListeners === "function") {
      marketGate.removeAllListeners();
    }
  } catch (err) {
    logger.warn(
      { step: "marketGate.removeAllListeners", e: err?.message || String(err) },
      "[kite] cleanup step failed",
    );
  }
  marketGate = null;
}

async function safeCleanupStep(step, fn) {
  try {
    await fn();
  } catch (err) {
    logger.warn(
      { step, e: err?.message || String(err) },
      "[kite] cleanup step failed",
    );
  }
}

function _modeConst(modeStr) {
  const m = _modeStrSafe(modeStr, "full");
  if (!ticker) return null;
  if (m === "ltp") return ticker.modeLTP;
  if (m === "quote") return ticker.modeQuote;
  return ticker.modeFull;
}

function _uniqNumeric(arr) {
  return Array.from(
    new Set(
      (arr || [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  );
}

function _applyMode(tokens, modeStr) {
  if (!ticker) return;
  const arr = (tokens || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!arr.length) return;
  const mode = _modeConst(modeStr);
  if (!mode) return;
  try {
    ticker.setMode(mode, arr);
  } catch (err) { reportFault({ code: "KITE_TICKERMANAGER_CATCH", err, message: "[src/kite/tickerManager.js] caught and continued" }); }
  const m = _modeStrSafe(modeStr, "full");
  for (const t of arr) tokenModeByToken.set(Number(t), m);
}

function _applyModesFromCache(tokens) {
  const underlyingMode = _modeStrSafe(env.TICK_MODE_UNDERLYING, "quote");
  const full = [];
  const quote = [];
  const ltp = [];
  for (const x of tokens || []) {
    const t = Number(x);
    if (!Number.isFinite(t) || t <= 0) continue;
    const m = tokenModeByToken.get(t) || underlyingMode;
    if (m === "ltp") ltp.push(t);
    else if (m === "quote") quote.push(t);
    else full.push(t);
  }
  if (quote.length) _applyMode(quote, "quote");
  if (ltp.length) _applyMode(ltp, "ltp");
  if (full.length) _applyMode(full, "full");
}

async function _getActiveNetPositionsSafe() {
  try {
    const positions = await kite.getPositions();
    const net = positions?.net || positions?.day || [];
    return Array.isArray(net) ? net : [];
  } catch (e) {
    logger.warn(
      { e: e?.message || String(e) },
      "[pos-resub] getPositions failed",
    );
    return [];
  }
}

async function _maybeRebuildUniverse() {
  const coolSec = _num(
    env.POSITION_RESUBSCRIBE_UNDERLYING_REBUILD_COOLDOWN_SEC,
    300,
  );
  const now = Date.now();
  if (now - _lastUniverseRebuildAt < coolSec * 1000) return false;
  _lastUniverseRebuildAt = now;
  try {
    await buildFnoUniverse({ kite });
    return true;
  } catch {
    return false;
  }
}

async function _positionSubscriptionTokens() {
  const net = await _getActiveNetPositionsSafe();

  const out = new Set();
  const wantUnderlying = _wantUnderlying();
  const uni = getLastFnoUniverse()?.universe || null;

  for (const p of net) {
    const tok = Number(p?.instrument_token);
    if (!Number.isFinite(tok) || tok <= 0) continue;

    const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;

    // Optional strict product gate (OFF by default)
    if (_respectProductStrict()) {
      const product = p?.product ? String(p.product) : null;
      if (
        product &&
        env.DEFAULT_PRODUCT &&
        product !== String(env.DEFAULT_PRODUCT)
      ) {
        continue;
      }
    }

    out.add(tok);

    // For option positions, also subscribe the underlying token (best-effort via FNO universe)
    if (wantUnderlying && _bool(env.FNO_ENABLED, false)) {
      try {
        const doc = await ensureInstrument(kite, tok);
        if (_isOptLikeInstrument(doc)) {
          const underlying = String(doc?.name || "")
            .toUpperCase()
            .trim();

          let underTok = Number(uni?.contracts?.[underlying]?.instrument_token);
          if (Number.isFinite(underTok) && underTok > 0) {
            out.add(underTok);
            continue;
          }

          // Try a throttled rebuild if missing
          const rebuilt = await _maybeRebuildUniverse();
          if (rebuilt) {
            const uni2 = getLastFnoUniverse()?.universe || null;
            underTok = Number(uni2?.contracts?.[underlying]?.instrument_token);
            if (Number.isFinite(underTok) && underTok > 0) out.add(underTok);
          }
        }
      } catch (e) {
        logger.warn(
          { tok, e: e?.message || String(e) },
          "[pos-resub] ensureInstrument failed",
        );
      }
    }
  }

  return Array.from(out);
}

async function _subscribeTokens(tokens, opts = {}) {
  const arr = (tokens || [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!arr.length) return { ok: true, added: [] };

  ticker.subscribe(arr);

  const underlyingMode = _modeStrSafe(env.TICK_MODE_UNDERLYING, "quote");
  const tradeMode = _modeStrSafe(env.TICK_MODE_TRADE, "full");
  const optionMode = _modeStrSafe(env.TICK_MODE_OPTIONS, tradeMode);

  const role = String(opts?.role || "").toLowerCase();
  const reason = String(opts?.reason || "").toUpperCase();
  const hintedTrade =
    role === "trade" || opts?.isOption === true || reason.includes("OPT");

  // Optional classification (small lists only): decide per-token by instrument type.
  const classify = _bool(opts?.classifyByInstrument, false);
  if (classify && typeof ensureInstrument === "function") {
    const trade = [];
    const under = [];
    for (const tok of arr) {
      try {
        const doc = await ensureInstrument(kite, tok);
        if (_isOptLikeInstrument(doc)) trade.push(tok);
        else under.push(tok);
      } catch {
        // If unknown, keep it light
        under.push(tok);
      }
    }
    if (under.length) _applyMode(under, underlyingMode);
    if (trade.length) _applyMode(trade, tradeMode);
  } else {
    const mode = opts?.isOption === true ? optionMode : hintedTrade ? tradeMode : underlyingMode;
    _applyMode(arr, mode);
  }

  for (const t of arr) subscribedTokens.add(t);
  return { ok: true, added: arr };
}

async function ensureActivePositionSubscriptions({
  force = false,
  reason = "periodic",
} = {}) {
  if (!kite || !ticker || !pipeline)
    return { ok: false, added: [], skipped: true };
  if (!_isResubEnabled()) return { ok: true, added: [], skipped: true };

  const minSec = _num(env.POSITION_RESUBSCRIBE_MIN_INTERVAL_SEC, 30);
  const now = Date.now();
  if (!force && minSec > 0 && now - _lastPosResubAt < minSec * 1000) {
    return { ok: true, added: [], throttled: true };
  }
  _lastPosResubAt = now;

  const posTokens = await _positionSubscriptionTokens().catch(() => []);
  const missing = posTokens.filter((t) => !subscribedTokens.has(Number(t)));

  if (!missing.length) return { ok: true, added: [] };

  await _subscribeTokens(missing, {
    role: "trade",
    reason,
    classifyByInstrument: true,
  });

  // If pipeline supports addTokens, let it backfill candles for exits/indicators.
  if (pipeline && typeof pipeline.addTokens === "function") {
    try {
      await pipeline.addTokens(missing, { backfill: true, reason });
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e), missing, reason },
        "[pos-resub] pipeline.addTokens failed",
      );
    }
  }

  logger.info(
    { added: missing, reason },
    "[pos-resub] subscribed missing position tokens",
  );
  return { ok: true, added: missing };
}

function startOcoReconcileLoop() {
  if (ocoReconcileTimer) return;
  const everySec = Number(env.OCO_RECONCILE_INTERVAL_SEC ?? 5);
  if (!Number.isFinite(everySec) || everySec <= 0) return;

  ocoReconcileTimer = setInterval(
    () => {
      if (!tickerConnected) return;
      if (!pipeline || typeof pipeline.ocoReconcile !== "function") return;
      pipeline.ocoReconcile().catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
    },
    Math.max(1, everySec) * 1000,
  );
}

function stopOcoReconcileLoop() {
  if (ocoReconcileTimer) {
    clearInterval(ocoReconcileTimer);
    ocoReconcileTimer = null;
  }
}

function stopReconcileLoop() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  stopOcoReconcileLoop();
}

function startReconcileLoop() {
  stopReconcileLoop();
  const sec = _num(env.RECONCILE_INTERVAL_SEC, 60);
  if (!Number.isFinite(sec) || sec <= 0) return;

  startOcoReconcileLoop();

  reconcileTimer = setInterval(() => {
    if (!pipeline) return;
    if (!tickerConnected) return;

    // Ensure we are subscribed to any broker-side open positions (restart/recovery safety)
    void ensureActivePositionSubscriptions({ reason: "periodic" }).catch(
      () => {},
    );

    pipeline
      .reconcile()
      .catch((e) =>
        logger.warn(
          { e: e?.message || String(e) },
          "[reconcile] periodic failed",
        ),
      );
  }, sec * 1000);
}

function clearRuntimeInitRetry() {
  if (runtimeInitRetryTimer) {
    clearTimeout(runtimeInitRetryTimer);
    runtimeInitRetryTimer = null;
  }
}

function resetRuntimeInitState() {
  clearRuntimeInitRetry();
  runtimeInitRetryAttempt = 0;
  runtimeInitInFlight = false;
  runtimeInitDegraded = false;
  runtimeInitContext = null;
}

function nextRuntimeInitBackoffMs() {
  const delay = Math.min(
    15_000,
    1_000 * Math.pow(2, Math.max(0, runtimeInitRetryAttempt)),
  );
  runtimeInitRetryAttempt += 1;
  return delay;
}

function buildResolvedSignalTokens({
  resolved = [],
  signalTokensIn = [],
  mergeCashUniverse = false,
  fnoUniverseTokens = [],
} = {}) {
  return signalTokensIn?.length
    ? _uniqNumeric(
        mergeCashUniverse
          ? [
              ...resolved.filter(
                (token) => !fnoUniverseTokens.includes(Number(token)),
              ),
              ...signalTokensIn,
            ]
          : signalTokensIn,
      )
    : _uniqNumeric(resolved);
}

function subscribeBrokerBootstrapTokens(tokens = []) {
  const allTokens = _uniqNumeric(tokens);
  if (!allTokens.length) return { ok: true, allTokens };

  ticker.subscribe(allTokens);
  _applyMode(allTokens, _modeStrSafe(env.TICK_MODE_UNDERLYING, "quote"));
  subscribedTokens = new Set(allTokens);

  logger.info(
    {
      subscribeTokens: allTokens,
      fromSymbols: subscribeSymbols,
    },
    "[kite] subscribed",
  );

  alertWithCooldown(
    "kite_subscribed",
    60_000,
    "info",
    "ðŸ“¡ Kite subscriptions active",
    {
      subscribedTokens: allTokens.length,
      posTokensAdded: 0,
    },
  );

  return { ok: true, allTokens };
}

async function buildConnectBootstrapContext() {
  let tokensIn = subscribeTokens;
  let symbolsIn = subscribeSymbols;
  let signalTokensIn = null;
  let fnoUniverseTokens = [];
  let mergeCashUniverse = false;

  if (_bool(env.FNO_ENABLED, false)) {
    try {
      const uni = await buildFnoUniverse({ kite });
      const u = uni?.universe;
      if (u?.tokens?.length) {
        mergeCashUniverse = _bool(env.FNO_MERGE_CASH_UNIVERSE, false);
        fnoUniverseTokens = _uniqNumeric(u.tokens);
        signalTokensIn = _uniqNumeric(
          Array.isArray(u.signalTokens) ? u.signalTokens : u.tokens,
        );
        tokensIn = mergeCashUniverse
          ? Array.from(new Set([...(tokensIn || []), ...u.tokens]))
          : u.tokens;
        symbolsIn = mergeCashUniverse ? symbolsIn : [];
        logger.info(
          {
            mode: u.mode,
            underlyings: u.underlyings,
            tokens: u.tokens,
            signalTokens: signalTokensIn,
            symbols: u.symbols,
          },
          "[fno] universe active",
        );
        alertWithCooldown(
          "fno_universe_active",
          60_000,
          "info",
          "ðŸ§­ F&O universe activated",
          {
            mode: u.mode,
            underlyings: u.underlyings,
            tokens: (u.tokens || []).length,
            symbols: u.symbols,
          },
        );
      }
    } catch (e) {
      logger.error(
        { e: e?.message || String(e) },
        "[fno] universe build failed",
      );
    }
  }

  return {
    tokensIn: _uniqNumeric(tokensIn),
    symbolsIn: Array.isArray(symbolsIn) ? symbolsIn.slice() : [],
    signalTokensIn: _uniqNumeric(signalTokensIn || []),
    fnoUniverseTokens,
    mergeCashUniverse,
  };
}

function scheduleRuntimeInitRetry() {
  if (runtimeInitRetryTimer || runtimeInitInFlight) return;
  if (!runtimeInitContext || !tickerConnected || !pipeline) return;

  const backoffMs = nextRuntimeInitBackoffMs();
  runtimeInitRetryTimer = setTimeout(() => {
    runtimeInitRetryTimer = null;
    if (!runtimeInitContext || !tickerConnected || !pipeline) return;
    void runPostConnectRuntimeInit(runtimeInitContext, {
      reason: "connect_retry",
    }).catch((err) => {
      reportFault({
        code: "KITE_TICKERMANAGER_ASYNC",
        err,
        message: "[src/kite/tickerManager.js] async task failed",
      });
    });
  }, backoffMs);
  runtimeInitRetryTimer.unref?.();
}

async function runPostConnectRuntimeInit(
  context,
  { reason = "connect" } = {},
) {
  if (!context || !pipeline || !tickerConnected) {
    return { ok: false, skipped: true };
  }
  if (runtimeInitInFlight) {
    return { ok: false, skipped: true, reason: "in_flight" };
  }

  runtimeInitInFlight = true;
  clearRuntimeInitRetry();

  try {
    const resolved = await resolveSubscribeTokens(kite, {
      tokens: context.tokensIn,
      symbols: context.symbolsIn,
    });
    const allTokens = _uniqNumeric(resolved);
    const resolvedSignalTokens = buildResolvedSignalTokens({
      resolved,
      signalTokensIn: context.signalTokensIn,
      mergeCashUniverse: context.mergeCashUniverse,
      fnoUniverseTokens: context.fnoUniverseTokens,
    });
    const missing = allTokens.filter((token) => !subscribedTokens.has(token));

    if (missing.length) {
      await _subscribeTokens(missing, { reason: `runtime_init:${reason}` });
    }

    if (!allTokens.length) {
      logger.warn(
        { subscribeTokens, subscribeSymbols },
        "[kite] nothing to subscribe (set SUBSCRIBE_SYMBOLS or SUBSCRIBE_TOKENS)",
      );
      runtimeInitRetryAttempt = 0;
      if (runtimeInitDegraded) {
        runtimeInitDegraded = false;
        logger.info({ reason }, "[kite] runtime init recovered after connect");
      }
      return { ok: true, allTokens, resolvedSignalTokens, skipped: true };
    }

    await pipeline.initForTokens(allTokens, {
      signalTokens: resolvedSignalTokens,
    });
    await pipeline.reconcile();
    await ensureActivePositionSubscriptions({
      force: true,
      reason,
    });
    startReconcileLoop();

    runtimeInitRetryAttempt = 0;
    runtimeInitContext = {
      ...context,
      allTokens,
      resolvedSignalTokens,
    };

    if (runtimeInitDegraded) {
      runtimeInitDegraded = false;
      logger.info({ reason }, "[kite] runtime init recovered after connect");
    }

    return { ok: true, allTokens, resolvedSignalTokens };
  } catch (e) {
    if (isTransientMongoError(e)) {
      runtimeInitDegraded = true;
      reportWindowedFault({
        windowKey: "kite_runtime_init_degraded",
        windowMs: 30_000,
        code: "KITE_RUNTIME_INIT_DEGRADED",
        err: e,
        message: "[kite] runtime init degraded after connect",
        meta: {
          reason,
          connected: tickerConnected,
          retryAttempt: runtimeInitRetryAttempt,
        },
      });
      scheduleRuntimeInitRetry();
      return { ok: false, degraded: true, reason };
    }
    throw e;
  } finally {
    runtimeInitInFlight = false;
  }
}

async function drainTicks() {
  if (draining) return;
  draining = true;
  try {
    while (tickQueue.length) {
      // merge all queued batches into one
      const merged = [];
      for (const batch of tickQueue) {
        if (Array.isArray(batch) && batch.length) merged.push(...batch);
      }
      tickQueue = [];

      if (!pipeline) continue;
      if (isHalted()) continue; // optional: reduce compute when halted

      await pipeline.onTicks(merged);
    }
  } finally {
    draining = false;
  }
}

async function cleanupSessionRuntime({
  reason = "session_refresh",
  stopGate = false,
} = {}) {
  const prevPipeline = pipeline;
  const prevTicker = ticker;

  stopReconcileLoop();
  resetRuntimeInitState();
  stopTickWatchdog();
  stopTickTapLogger();
  tickQueue = [];
  lastTickAt = 0;
  recentOrderUpdateKeys = new Map();

  await safeCleanupStep("pipeline.stop", async () => {
    if (prevPipeline && typeof prevPipeline.stop === "function") {
      await prevPipeline.stop();
    }
  });

  await safeCleanupStep("ticker.removeAllListeners", async () => {
    if (prevTicker && typeof prevTicker.removeAllListeners === "function") {
      prevTicker.removeAllListeners();
    }
  });

  await safeCleanupStep("ticker.disconnect", async () => {
    if (prevTicker && typeof prevTicker.disconnect === "function") {
      prevTicker.disconnect();
    }
  });

  if (stopGate) {
    stopMarketGate();
  }

  pipeline = null;
  ticker = null;
  kite = null;
  tickerConnected = false;
  subscribedTokens = new Set();
  tokenModeByToken = new Map();
  _lastPosResubAt = 0;
  _lastUniverseRebuildAt = 0;
}

async function setSession(accessToken) {
  if (accessToken === currentToken) return;

  logger.info("[kite] session update detected");
  await cleanupSessionRuntime({ reason: "session_refresh", stopGate: false });

  kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });
  ticker = createTicker({ apiKey: env.KITE_API_KEY, accessToken });
  const gate = startMarketGate();
  pipeline = buildPipeline({
    kite,
    tickerCtrl: { subscribe: _subscribeTokens },
    marketGate: gate,
  });

  subscribedTokens = new Set();
  tokenModeByToken = new Map();
  _lastPosResubAt = 0;
  _lastUniverseRebuildAt = 0;

  wireEvents();
  ticker.connect();

  startTickWatchdog();
  startTickTapLogger();

  currentToken = accessToken;
}

async function stopSession(reason = "manual") {
  await cleanupSessionRuntime({ reason, stopGate: true });
  lastDisconnect = new Date().toISOString();
  currentToken = null;

  logger.warn({ reason }, "[kite] session stopped");
  return { ok: true, reason };
}

function wireEvents() {
  ticker.on("connect", async () => {
    tickerConnected = true;
    lastDisconnect = null;

    logger.info("[kite] ticker connected");

    try {
      const context = await buildConnectBootstrapContext();
      runtimeInitContext = context;

      if (context.tokensIn.length) {
        subscribeBrokerBootstrapTokens(context.tokensIn);
      }

      if (!context.tokensIn.length && !context.symbolsIn.length) {
        logger.warn(
          { subscribeTokens, subscribeSymbols },
          "[kite] nothing to subscribe (set SUBSCRIBE_SYMBOLS or SUBSCRIBE_TOKENS)",
        );
      }

      try {
        await runPostConnectRuntimeInit(context, { reason: "connect" });
      } catch (e) {
        logger.error(
          { e: e?.message || String(e) },
          "[kite] runtime init failed after connect",
        );
        alert("error", "âŒ Kite runtime init failed after connect", {
          message: e?.message || String(e),
        }).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
      }
      return;

      if (context.tokensIn.length) {
        try {
          const uni = await buildFnoUniverse({ kite });
          const u = uni?.universe;
          if (u?.tokens?.length) {
            mergeCashUniverse = _bool(env.FNO_MERGE_CASH_UNIVERSE, false);
            fnoUniverseTokens = _uniqNumeric(u.tokens);
            signalTokensIn = _uniqNumeric(
              Array.isArray(u.signalTokens) ? u.signalTokens : u.tokens,
            );
            tokensIn = mergeCashUniverse
              ? Array.from(new Set([...(tokensIn || []), ...u.tokens]))
              : u.tokens;
            symbolsIn = mergeCashUniverse ? symbolsIn : [];
            logger.info(
              {
                mode: u.mode,
                underlyings: u.underlyings,
                tokens: u.tokens,
                signalTokens: signalTokensIn,
                symbols: u.symbols,
              },
              "[fno] universe active",
            );
            alertWithCooldown(
              "fno_universe_active",
              60_000,
              "info",
              "🧭 F&O universe activated",
              {
                mode: u.mode,
                underlyings: u.underlyings,
                tokens: (u.tokens || []).length,
                symbols: u.symbols,
              },
            );
          }
        } catch (e) {
          logger.error(
            { e: e?.message || String(e) },
            "[fno] universe build failed",
          );
        }
      }

      const resolved = await resolveSubscribeTokens(kite, {
        tokens: tokensIn,
        symbols: symbolsIn,
      });
      const resolvedSignalTokens = signalTokensIn?.length
        ? _uniqNumeric(
            mergeCashUniverse
              ? [
                  ...resolved.filter(
                    (token) => !fnoUniverseTokens.includes(Number(token)),
                  ),
                  ...signalTokensIn,
                ]
              : signalTokensIn,
          )
        : _uniqNumeric(resolved);

      // PATCH-3: Recovery safety — also subscribe any broker-side open positions (option tokens etc.)
      const posTokens = await _positionSubscriptionTokens().catch(() => []);
      const allTokens = Array.from(
        new Set([...(resolved || []), ...(posTokens || [])]),
      );

      if (allTokens.length) {
        ticker.subscribe(allTokens);
        // Reduce WS load: underlying universe in quote (or LTP) mode, traded instruments in full.
        _applyMode(allTokens, _modeStrSafe(env.TICK_MODE_UNDERLYING, "quote"));
        _applyMode(posTokens || [], _modeStrSafe(env.TICK_MODE_TRADE, "full"));
        subscribedTokens = new Set(allTokens);

        logger.info(
          {
            subscribeTokens: allTokens,
            fromSymbols: subscribeSymbols,
            posTokensAdded: (posTokens || []).length,
          },
          "[kite] subscribed",
        );

        alertWithCooldown(
          "kite_subscribed",
          60_000,
          "info",
          "📡 Kite subscriptions active",
          {
            subscribedTokens: allTokens.length,
            posTokensAdded: (posTokens || []).length,
          },
        );

        await pipeline.initForTokens(allTokens, {
          signalTokens: resolvedSignalTokens,
        });
        await pipeline.reconcile();

        // One more pass to catch any late-reported positions right after connect
        await ensureActivePositionSubscriptions({
          force: true,
          reason: "connect",
        });

        startReconcileLoop();
      } else {
        logger.warn(
          { subscribeTokens, subscribeSymbols },
          "[kite] nothing to subscribe (set SUBSCRIBE_SYMBOLS or SUBSCRIBE_TOKENS)",
        );
      }
    } catch (e) {
      tickerConnected = false;
      stopReconcileLoop();
      resetRuntimeInitState();
      logger.error(
        { e: e?.message || String(e) },
        "[kite] connect handler failed",
      );
      alert("error", "❌ Kite connect handler failed", {
        message: e?.message || String(e),
      }).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
    }
  });

  ticker.on("ticks", (ticks) => {
    try {
      if (!pipeline) return;

      lastTickAt = Date.now();
      if (tickTapTimer) {
        tickTapCount += Array.isArray(ticks) ? ticks.length : 0;
      }

      updateFromTicks(ticks || []);

      tickQueue.push(ticks || []);

      // safety: if something goes crazy, keep queue bounded
      const max = _num(env.TICK_QUEUE_MAX, 50);
      if (Number.isFinite(max) && max > 0 && tickQueue.length > max) {
        tickQueue = tickQueue.slice(-max);
      }

      void drainTicks().catch((e) =>
        logger.error({ err: e?.message || e }, "[kite] tick drain failed"),
      );
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e) },
        "[pipeline] ticks enqueue error",
      );
    }
  });

  ticker.on("order_update", (order) => {
    const orderId = String(order?.order_id || order?.orderId || "");
    const status = String(order?.status || "").toUpperCase();
    const exTs = String(
      order?.exchange_update_timestamp ||
        order?.exchange_timestamp ||
        order?.order_timestamp ||
        "",
    );
    const dedupeKey = `${orderId}|${status}|${exTs}`;
    const now = Date.now();
    const dedupeTtlMs = 2500;

    for (const [k, ts] of recentOrderUpdateKeys.entries()) {
      if (now - Number(ts ?? 0) > dedupeTtlMs) recentOrderUpdateKeys.delete(k);
    }
    if (orderId && status && exTs && recentOrderUpdateKeys.has(dedupeKey)) {
      logger.info({ order_id: orderId, status, exTs }, "[ticker] duplicate order_update ignored");
      return;
    }
    if (orderId && status && exTs) recentOrderUpdateKeys.set(dedupeKey, now);

    logger.info(
      {
        order_id: order.order_id,
        status: order.status,
        status_message: order.status_message,
        status_message_raw: order.status_message_raw,
      },
      "[ticker] order_update",
    );

    if (!pipeline?.onOrderUpdate) {
      logger.warn("[ticker] order_update ignored (pipeline not ready)");
      return;
    }

    pipeline.onOrderUpdate(order).catch((e) => {
      logger.error({ e: e.message }, "[order_update] handler failed");
    });
  });

  ticker.on("error", (err) => {
    logger.warn({ err }, "[kite] ticker error");
    alert("warn", "⚠️ Kite ticker error", {
      err: String(err?.message || err),
    }).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
  });

  ticker.on("reconnect", () => {
    if (!_isResubOnReconnect()) return;
    try {
      const arr = Array.from(subscribedTokens || []);
      if (arr.length) {
        ticker.subscribe(arr);
        _applyModesFromCache(arr);
        logger.warn(
          { count: arr.length },
          "[kite] reconnect: re-subscribed tokens",
        );
      }
    } catch (e) {
      logger.warn(
        { e: e?.message || String(e) },
        "[kite] reconnect resubscribe failed",
      );
    }

    void ensureActivePositionSubscriptions({
      force: true,
      reason: "reconnect",
    }).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
  });

  ticker.on("close", () => {
    tickerConnected = false;
    lastDisconnect = new Date().toISOString();
    stopReconcileLoop();
    logger.warn("[kite] ticker closed");
    alert("warn", "⚠️ Kite ticker closed").catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
  });

  ticker.on("disconnect", (err) => {
    tickerConnected = false;
    lastDisconnect = new Date().toISOString();
    stopReconcileLoop();
    logger.warn({ err }, "[kite] ticker disconnected");
    alert("warn", "⚠️ Kite ticker disconnected", {
      err: String(err?.message || err),
    }).catch((err) => { reportFault({ code: "KITE_TICKERMANAGER_ASYNC", err, message: "[src/kite/tickerManager.js] async task failed" }); });
  });
}

function getPipeline() {
  if (!pipeline) throw new Error("Pipeline not ready yet");
  return pipeline;
}

function getTickerStatus() {
  return {
    connected: tickerConnected,
    lastDisconnect,
    hasSession: !!currentToken,
  };
}

function getSubscribedTokens() {
  return Array.from(subscribedTokens || []);
}

function getKiteClient() {
  return kite;
}

module.exports = {
  setSession,
  stopSession,
  getPipeline,
  getKiteClient,
  getTickerStatus,
  getSubscribedTokens,
  ensureActivePositionSubscriptions,
};
