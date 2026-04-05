const { env } = require("./config");
const { DateTime } = require("luxon");
const { reportFault } = require("./runtime/errorBus");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("./market/marketCalendar");
const { logger } = require("./logger");
const { ensureInstrument } = require("./instruments/instrumentRepo");
const { CandleBuilder } = require("./market/candleBuilder");
const { CandleCache } = require("./market/candleCache");
const { CandleWriteBuffer } = require("./market/candleWriteBuffer");
const { ensureIndexes } = require("./market/candleStore");
const { backfillCandles } = require("./market/backfill");
const {
  evaluateOnCandleClose,
  evaluateOnCandleTick,
  resetSignalLayerState,
} = require("./strategy/strategyEngine");
const { RiskEngine } = require("./risk/riskEngine");
const { TradeManager } = require("./trading/tradeManager");
const { telemetry } = require("./telemetry/signalTelemetry");
const { marketHealth } = require("./market/marketHealth");
const { alert } = require("./alerts/alertService");

function buildPipeline({ kite, tickerCtrl, marketGate } = {}) {
  const intervals = (env.CANDLE_INTERVALS || "1,3")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const candleBuilder = new CandleBuilder({
    intervalsMinutes: intervals,
    timezone: env.CANDLE_TZ,
  });
  const candleCache = new CandleCache({
    maxCandles: Number(env.CANDLE_CACHE_MAX ?? 800),
  });

  const candleWriter = new CandleWriteBuffer();
  candleWriter.start();

  const risk = new RiskEngine();
  const trader = new TradeManager({ kite, riskEngine: risk });
  let stopped = false;
  let stopPromise = null;
  let candleFinalizerTimer = null;

  let tokensRef = [];
  let tokensSet = new Set();
  // In OPT mode we may subscribe option tokens at runtime for execution/exits.
  // Strategy evaluation must stay limited to the original underlying universe.
  let signalTokensSet = new Set();
  const tickSignalState = new Map();

  function previewEmitEnabled() {
    return String(process.env.SIGNAL_PREVIEW_EMIT ?? env.SIGNAL_PREVIEW_EMIT ?? "true") === "true";
  }

  function previewActionableEnabled() {
    return String(process.env.SIGNAL_PREVIEW_ACTIONABLE ?? env.SIGNAL_PREVIEW_ACTIONABLE ?? "false") === "true";
  }

  async function emitSignalPreview(signal) {
    telemetry.recordDecision({
      signal,
      token: signal.instrument_token,
      outcome: "PREVIEW_DISPATCHED",
      stage: "pipeline_preview",
      reason: signal.reason,
      meta: {
        confidence: signal.confidence,
        regime: signal.regime,
        signalStage: signal.signalStage,
        setupLineage: signal.setupLineage || signal.meta?.setupLineage || null,
      },
    });

    if (!previewEmitEnabled()) return;
    if (typeof trader.onSignalPreview === "function") {
      await trader.onSignalPreview(signal);
    }
  }

  // Separate queue for runtime subscription/backfills (avoid deadlocks with main serial queue)
  let subsSerial = Promise.resolve();
  function enqueueSubs(fn, label) {
    if (stopped) return Promise.resolve({ ok: false, stopped: true });
    subsSerial = subsSerial
      .then(async () => {
        if (stopped) return { ok: false, stopped: true };
        return fn();
      })
      .catch((e) => {
        logger.warn(
          { e: e?.message || String(e), label },
          "[pipeline] subscription task failed",
        );
      });
    return subsSerial;
  }

  // ---- SERIAL QUEUE (prevents tick/order/reconcile overlap) ----
  let serial = Promise.resolve();

  function enqueue(fn, label) {
    if (stopped) return Promise.resolve({ ok: false, stopped: true });
    serial = serial
      .then(async () => {
        if (stopped) return { ok: false, stopped: true };
        return fn();
      })
      .catch((e) => {
        logger.warn(
          { e: e?.message || String(e), label },
          "[pipeline] task failed",
        );
      });
    return serial;
  }

  async function initForTokens(tokens, opts = {}) {
    if (stopped) return;
    resetSignalLayerState();
    tickSignalState.clear();
    tokensRef = Array.isArray(tokens) ? tokens : [];
    tokensSet = new Set(
      tokensRef
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    const explicitSignalTokens = Array.isArray(opts.signalTokens)
      ? opts.signalTokens
      : tokensRef;
    // Freeze only the intended signal-source tokens.
    // Runtime-added tokens (options) should not generate strategy signals.
    signalTokensSet = new Set(
      explicitSignalTokens
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    await trader.init();
    if (stopped) return;

    // Classify index tokens once so candle builder can suppress volume warnings
    // (index ticks are volume-less by design, even in quote/full modes).
    try {
      const idx = [];
      for (const t of tokensRef) {
        if (stopped) return;
        const tok = Number(t);
        if (!Number.isFinite(tok) || tok <= 0) continue;
        try {
          const inst = await ensureInstrument(kite, tok);
          const seg = String(inst?.segment || "").toUpperCase();
          const it = String(inst?.instrument_type || "").toUpperCase();
          if (seg === "INDICES" || it === "INDEX") idx.push(tok);
        } catch {
          // ignore
        }
      }
      if (idx.length) candleBuilder.addIndexTokens(idx);
    } catch {
      // ignore
    }

    for (const intervalMin of intervals) await ensureIndexes(intervalMin);
    if (stopped) return;

    let totalBackfill = 0;
    let weakBackfillCount = 0;
    for (const token of tokensRef) {
      if (stopped) return;
      for (const intervalMin of intervals) {
        if (stopped) return;
        try {
          const candles = await backfillCandles({
            kite,
            instrument_token: token,
            intervalMin,
            timezone: env.CANDLE_TZ,
          });
          candleCache.addCandles(candles);
          const count = Array.isArray(candles) ? candles.length : 0;
          totalBackfill += count;
          logger.info({ token, intervalMin, count }, "[backfill] ok");
          if (count < 50) {
            weakBackfillCount += 1;
            logger.warn(
              { token, intervalMin, count },
              "[backfill] limited initial history primed; some strategies may wait for additional candles",
            );
          }
        } catch (e) {
          logger.warn(
            { token, intervalMin, e: e.message },
            "[backfill] failed",
          );
        }
      }
    }
    if (stopped) return;

    alert("info", "🧩 Pipeline primed", {
      tokens: tokensRef.length,
      intervals,
      totalBackfillCandles: totalBackfill,
      lowHistoryBuckets: weakBackfillCount,
    }).catch((err) => { reportFault({ code: "PIPELINE_ASYNC", err, message: "[src/pipeline.js] async task failed" }); });
  }

  // Allow seeding subscription view (primarily for admin visibility)
  function setSubscribedTokens(tokens) {
    if (stopped) return;
    tokensRef = Array.isArray(tokens) ? tokens : [];
    tokensSet = new Set(
      tokensRef
        .map((t) => Number(t))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  }

  // Runtime subscribe for OPT mode: subscribe chosen option token & optionally backfill candles.
  async function addTokens(tokens, opts = {}) {
    if (stopped) return { ok: false, error: "pipeline_stopped" };
    const enabled = String(env.RUNTIME_SUBSCRIBE_ENABLED || "true") === "true";
    if (!enabled) return { ok: false, error: "runtime_subscribe_disabled" };

    const arr = (tokens || [])
      .map((t) => Number(t))
      .filter((n) => Number.isFinite(n) && n > 0);
    const uniq = Array.from(new Set(arr));
    const toAdd = uniq.filter((t) => !tokensSet.has(t));
    if (!toAdd.length) {
      return { ok: true, added: [], tokens: Array.from(tokensSet) };
    }

    if (!tickerCtrl || typeof tickerCtrl.subscribe !== "function") {
      return { ok: false, error: "tickerCtrl_not_available" };
    }

    // Treat option contracts (selected at runtime) differently:
    // backfilling option candles on every ATM shift can hit 429s and blow up Mongo.
    const isOptRuntime =
      opts?.isOption === true ||
      String(opts?.reason || "") === "OPT_SELECTED_CONTRACT";

    // Serialize subscribe operations (separate queue from tick processing)
    const res = await enqueueSubs(async () => {
      const sub = await tickerCtrl.subscribe(toAdd, {
        reason: opts?.reason || null,
        isOption: isOptRuntime,
        role: isOptRuntime ? "trade" : "underlying",
      });
      if (!sub?.ok) return sub;

      for (const t of toAdd) tokensSet.add(t);
      tokensRef = Array.from(tokensSet);

      // Kick off backfill in background (do not block entry)
      // NOTE:
      // - For option runtime tokens: controlled by OPT_RUNTIME_SUBSCRIBE_BACKFILL (default: false)
      // - For other runtime tokens: controlled by RUNTIME_SUBSCRIBE_BACKFILL
      const backfillFlag = isOptRuntime
        ? String(env.OPT_RUNTIME_SUBSCRIBE_BACKFILL || "false")
        : String(env.RUNTIME_SUBSCRIBE_BACKFILL || "true");

      const doBackfill = backfillFlag === "true" && opts.backfill !== false;

      if (doBackfill) {
        const daysOverride = Number(
          opts.daysOverride ??
            (isOptRuntime
              ? env.RUNTIME_SUBSCRIBE_BACKFILL_DAYS_OPT
              : env.RUNTIME_SUBSCRIBE_BACKFILL_DAYS) ??
            1,
        );

        void enqueueSubs(async () => {
          for (const token of toAdd) {
            for (const intervalMin of intervals) {
              try {
                const candles = await backfillCandles({
                  kite,
                  instrument_token: token,
                  intervalMin,
                  timezone: env.CANDLE_TZ,
                  daysOverride,
                });
                candleCache.addCandles(candles);
                logger.info(
                  { token, intervalMin, daysOverride, isOptRuntime },
                  "[runtime-backfill] ok",
                );
              } catch (e) {
                logger.warn(
                  {
                    token,
                    intervalMin,
                    daysOverride,
                    isOptRuntime,
                    e: e?.message || String(e),
                  },
                  "[runtime-backfill] failed",
                );
              }
            }
          }
        }, "runtimeBackfill");
      } else if (isOptRuntime) {
        logger.info(
          { added: toAdd.length, reason: opts?.reason || null },
          "[runtime-backfill] skipped for option token",
        );
      }

      return { ok: true, added: toAdd, tokens: Array.from(tokensSet) };
    }, "runtimeSubscribe");

    return res;
  }

  function subscriptions() {
    return {
      ok: true,
      tokens: Array.from(tokensSet).sort((a, b) => a - b),
      signalTokens: Array.from(signalTokensSet).sort((a, b) => a - b),
      count: tokensSet.size,
    };
  }

  // Provide runtime token adder to the trader (needed for OPT mode correctness)
  if (typeof trader.setRuntimeAddTokens === "function") {
    trader.setRuntimeAddTokens(addTokens);
  }
  if (typeof trader.setRuntimeGetCandles === "function") {
    trader.setRuntimeGetCandles((token, intervalMin, limit) =>
      candleCache.getCandles(token, intervalMin, limit),
    );
  }

  async function reconcile() {
    if (stopped) return { ok: false, stopped: true };
    return enqueue(async () => {
      if (stopped) return { ok: false, stopped: true };
      await trader.reconcile(tokensRef);
      logger.info("[reconcile] done");
    }, "reconcile");
  }

  async function handleClosedCandles(closed) {
    if (stopped) return;
    for (const c of closed || []) {
      if (stopped) return;

      const tok = Number(c.instrument_token);
      const isSignalTok =
        Number.isFinite(tok) &&
        signalTokensSet.size &&
        signalTokensSet.has(tok);

      candleCache.addCandle(c);

      // Persist candles asynchronously (avoid DB writes in the hot tick loop)
      // Default: persist only signal tokens (underlying universe).
      // Enable CANDLE_PERSIST_NON_SIGNAL_TOKENS=true if you want option candles persisted too.
      const persistNonSignal =
        String(env.CANDLE_PERSIST_NON_SIGNAL_TOKENS || "false") === "true";
      if (isSignalTok || persistNonSignal) candleWriter.enqueue(c);

      // IMPORTANT (OPT mode correctness):
      // We may subscribe option tokens at runtime for execution/exits,
      // but we must NOT generate strategy signals on option tokens.
      if (Number.isFinite(tok) && signalTokensSet.size && !isSignalTok) {
        continue;
      }

      const suppressClose =
        String(env.SIGNAL_TICK_CONFIRM_ENABLED || "false") === "true" &&
        String(env.SIGNAL_TICK_CONFIRM_SUPPRESS_CLOSE || "true") !== "false";
      if (suppressClose) {
        const key = `${tok}:${Number(c.interval_min ?? 0)}`;
        const st = tickSignalState.get(key);
        const candleTs = c?.ts ? new Date(c.ts).getTime() : null;
        if (
          Number.isFinite(candleTs) &&
          st?.lastSignalCandleTs === candleTs &&
          st?.lastSignalStage === "bar_close_confirmed"
        ) {
          continue;
        }
      }

      const allowSignals = allowSignalsNow() && isCandleWithinMarketSession(c);
      if (!allowSignals) {
        continue;
      }

      const cached = candleCache.getCandles(
        c.instrument_token,
        c.interval_min,
        Number(env.CANDLE_CACHE_LIMIT ?? 400),
      );
      const signal = await evaluateOnCandleClose({
        instrument_token: c.instrument_token,
        intervalMin: c.interval_min,
        candles: cached.length ? cached : null,
      });

      if (signal) {
        logger.info(
          {
            signalId: signal.signalId || null,
            token: signal.instrument_token,
            side: signal.side,
            reason: signal.reason,
            strategyId: signal.strategyId,
            confidence: signal.confidence,
            regime: signal.regime,
            regimeSnapshotId: signal.regimeSnapshotId || null,
            signalStage: signal.signalStage,
          },
          "[signal]",
        );
        telemetry.recordDecision({
          signal,
          token: signal.instrument_token,
          outcome: "DISPATCHED",
          stage: "pipeline",
          reason: signal.reason,
          meta: { confidence: signal.confidence, regime: signal.regime },
        });
        tickSignalState.set(`${tok}:${Number(c.interval_min ?? 0)}`, {
          ...(tickSignalState.get(`${tok}:${Number(c.interval_min ?? 0)}`) || {}),
          lastSignalCandleTs: c?.ts ? new Date(c.ts).getTime() : null,
          lastSignalStage: signal.signalStage || "bar_close_confirmed",
        });
        await trader.onSignal(signal);
      }
    }
  }

  async function handleTickSignals(candleTicks) {
    if (stopped) return;
    if (String(env.SIGNAL_TICK_CONFIRM_ENABLED || "false") !== "true") return;
    if (!allowSignalsNow()) return;

    const throttleMs = Number(env.SIGNAL_TICK_CONFIRM_THROTTLE_MS ?? 1500);
    const nowMs = Date.now();

    for (const t of candleTicks || []) {
      if (stopped) return;
      const tok = Number(t.instrument_token);
      if (!Number.isFinite(tok)) continue;
      if (signalTokensSet.size && !signalTokensSet.has(tok)) continue;

      for (const intervalMin of intervals) {
        if (stopped) return;
        const live = candleBuilder.getCurrentCandle(tok, intervalMin);
        if (!live?.ts) continue;

        // Keep tick-confirmed signals inside configured market session,
        // same as close-confirmed candle path.
        if (
          !isCandleWithinMarketSession({
            ts: live.ts,
            interval_min: intervalMin,
          })
        ) {
          continue;
        }

        if (
          String(env.ALLOW_SYNTHETIC_SIGNALS || "false") !== "true" &&
          (live.synthetic || (live.source && live.source !== "live"))
        ) {
          continue;
        }

        const key = `${tok}:${intervalMin}`;
        const st = tickSignalState.get(key) || {};
        const candleTs = new Date(live.ts).getTime();

        if (
          Number.isFinite(st.lastSignalCandleTs) &&
          st.lastSignalCandleTs === candleTs
        ) {
          continue;
        }

        if (
          Number.isFinite(st.lastEvalMs) &&
          throttleMs > 0 &&
          nowMs - st.lastEvalMs < throttleMs
        ) {
          continue;
        }

        tickSignalState.set(key, {
          ...st,
          lastEvalMs: nowMs,
          lastCandleTs: candleTs,
        });

        const cached = candleCache.getCandles(
          tok,
          intervalMin,
          Number(env.CANDLE_CACHE_LIMIT ?? 400),
        );
        const signal = await evaluateOnCandleTick({
          instrument_token: tok,
          intervalMin,
          liveCandle: live,
          candles: cached.length ? cached : null,
        });

        if (signal) {
          logger.info(
            {
              signalId: signal.signalId || null,
              token: signal.instrument_token,
              side: signal.side,
              reason: signal.reason,
              strategyId: signal.strategyId,
              confidence: signal.confidence,
              regime: signal.regime,
              stage: signal.stage,
              regimeSnapshotId: signal.regimeSnapshotId || null,
              signalStage: signal.signalStage,
            },
            "[signal:tick]",
          );
          if (signal.isProvisional === true && !previewActionableEnabled()) {
            await emitSignalPreview(signal);
          } else {
            telemetry.recordDecision({
              signal,
              token: signal.instrument_token,
              outcome: "DISPATCHED",
              stage: "pipeline_tick",
              reason: signal.reason,
              meta: {
                confidence: signal.confidence,
                regime: signal.regime,
                signalStage: signal.signalStage,
                setupLineage: signal.setupLineage || signal.meta?.setupLineage || null,
              },
            });
            await trader.onSignal(signal);
          }
          tickSignalState.set(key, {
            ...tickSignalState.get(key),
            lastSignalCandleTs: candleTs,
            lastSignalStage: signal.signalStage || "tick_preview",
          });
        }
      }
    }
  }

  function allowSignalsNow() {
    if (!marketGate || typeof marketGate.isOpen !== "function") return true;
    return marketGate.isOpen();
  }

  function isCandleWithinMarketSession(candle) {
    if (!candle || !candle.ts) return true;

    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const start = DateTime.fromJSDate(candle.ts, { zone: tz });
    const intervalMin = Number(candle.interval_min ?? 0);
    const closeTs = start.plus({ minutes: Math.max(1, intervalMin) });

    const session = getSessionForDateTime(closeTs, {
      marketOpen: env.MARKET_OPEN,
      marketClose: env.MARKET_CLOSE,
      stopNewEntriesAfter: env.STOP_NEW_ENTRIES_AFTER,
    });

    // Drop candles on weekends/holidays unless a special session explicitly allows trading.
    if (!session.allowTradingDay) return false;

    const { open, close } = buildBoundsForToday(session, closeTs);

    if (!open.isValid || !close.isValid) return true;
    return closeTs >= open && closeTs <= close;
  }
  async function processTicksOnce(ticks) {
    if (stopped) return;
    try {
      marketHealth.onTicks(ticks || []);
    } catch (err) { reportFault({ code: "PIPELINE_CATCH", err, message: "[src/pipeline.js] caught and continued" }); }
    // tick->trader (LTP updates + throttled risk checks)
    for (const t of ticks || []) {
      if (stopped) return;
      try {
        trader.onTick(t);
      } catch (e) {
        logger.warn({ e: e?.message || String(e) }, "[trader] onTick failed");
      }
    }

    // tick->candles (always build candles; signal gating happens separately)
    const candleTicks = ticks || [];

    const closed = candleBuilder.onTicks(candleTicks);
    await handleClosedCandles(closed);
    await handleTickSignals(candleTicks);
  }

  async function onTicks(ticks) {
    if (stopped) return { ok: false, stopped: true };
    // serialize processing to avoid overlap
    return enqueue(() => processTicksOnce(ticks), "onTicks");
  }

  async function onOrderUpdate(order) {
    if (stopped) return { ok: false, stopped: true };
    return enqueue(async () => {
      if (stopped) return { ok: false, stopped: true };
      await trader.onOrderUpdate(order);
    }, "onOrderUpdate");
  }

  async function ocoReconcile() {
    if (stopped) return { ok: false, stopped: true };
    if (typeof trader.positionFirstReconcile !== "function") return;
    return enqueue(
      () => trader.positionFirstReconcile("oco_timer"),
      "ocoReconcile",
    );
  }

  async function setKillSwitch(enabled, reason) {
    if (stopped) return { ok: false, stopped: true };
    // Persist kill-switch in DB via TradeManager so it survives restarts.
    if (typeof trader.setKillSwitch === "function") {
      await trader.setKillSwitch(!!enabled, reason || "ADMIN");
    } else {
      risk.setKillSwitch(!!enabled);
    }
  }

  async function status() {
    if (stopped) return { stopped: true };
    return trader.status();
  }

  function getLiveCandle(token, intervalMin) {
    return candleBuilder.getCurrentCandle(token, intervalMin);
  }

  async function candleFinalizerTick() {
    if (stopped) return;
    if (String(env.CANDLE_TIMER_FINALIZER_ENABLED || "true") !== "true") return;

    const closed = candleBuilder.finalizeDue(new Date(), {
      graceMs: Number(env.CANDLE_FINALIZE_GRACE_MS ?? 1500),
      maxBars: Number(env.CANDLE_FINALIZE_MAX_BARS_PER_RUN ?? 3),
    });

    if (closed.length) {
      await handleClosedCandles(closed);
    }
  }

  if (String(env.CANDLE_TIMER_FINALIZER_ENABLED || "true") === "true") {
    const everyMs = Number(env.CANDLE_FINALIZER_INTERVAL_MS ?? 1000);
    candleFinalizerTimer = setInterval(() => {
      enqueue(() => candleFinalizerTick(), "candleFinalizer").catch((err) => { reportFault({ code: "PIPELINE_ASYNC", err, message: "[src/pipeline.js] async task failed" }); });
    }, everyMs);
  }

  async function stop() {
    if (stopPromise) return stopPromise;

    stopped = true;
    stopPromise = (async () => {
      if (candleFinalizerTimer) {
        clearInterval(candleFinalizerTimer);
        candleFinalizerTimer = null;
      }

      const cleanupStep = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          logger.warn(
            { label, e: e?.message || String(e) },
            "[pipeline] stop cleanup failed",
          );
        }
      };

      await cleanupStep("tradeManager.stop", async () => {
        if (typeof trader.stop === "function") {
          await trader.stop();
        }
      });

      await cleanupStep("candleWriter.stop", async () => {
        if (typeof candleWriter.stop === "function") {
          await candleWriter.stop();
          return;
        }
        if (typeof candleWriter.flush === "function") {
          await candleWriter.flush();
        }
      });

      tickSignalState.clear();
      resetSignalLayerState();
      signalTokensSet.clear();
      tokensSet.clear();
      tokensRef = [];

      logger.info("[pipeline] stopped");
    })();

    return stopPromise;
  }
  return {
    initForTokens,
    setSubscribedTokens,
    addTokens,
    subscriptions,
    onTicks,
    onOrderUpdate,
    reconcile,
    ocoReconcile,
    setKillSwitch,
    status,
    getLiveCandle,
    stop,
    destroy: stop,
    trader,
  };
}

module.exports = { buildPipeline };
