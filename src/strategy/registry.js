const { env } = require("../config");
const {
  emaCrossStrategy,
  evaluateEmaCrossSetup,
} = require("./emaCrossStrategy");
const {
  emaPullbackStrategy,
  evaluateEmaPullbackSetup,
} = require("./emaPullbackStrategy");
const {
  breakoutStrategy,
  evaluateBreakoutSetup,
} = require("./breakoutStrategy");
const {
  vwapReclaimStrategy,
  evaluateVwapReclaimSetup,
} = require("./vwapReclaimStrategy");
const { orbStrategy, evaluateOrbSetup } = require("./orbStrategy");
const {
  bollingerSqueezeStrategy,
  evaluateBollingerSqueezeSetup,
} = require("./bollingerSqueezeStrategy");
const {
  rsiFadeStrategy,
  evaluateRsiFadeSetup,
} = require("./rsiFadeStrategy");
const {
  volumeSpikeStrategy,
  evaluateVolumeSpikeSetup,
} = require("./volumeSpikeStrategy");
const { fakeoutStrategy, evaluateFakeoutSetup } = require("./fakeoutStrategy");
const {
  wickReversalStrategy,
  evaluateWickReversalSetup,
} = require("./wickReversalStrategy");

/**
 * Strategy metadata (used for strategy-aware filters & telemetry).
 * - style: TREND | RANGE | OPEN
 * - family: high-level grouping for tuning/metrics
 */
const STRATEGY_META = {
  ema_cross: { style: "TREND", family: "TREND" },
  ema_pullback: { style: "TREND", family: "TREND" },
  breakout: { style: "TREND", family: "BREAKOUT" },
  vwap_reclaim: { style: "TREND", family: "VWAP" },
  orb: { style: "OPEN", family: "OPEN" },
  bb_squeeze: { style: "TREND", family: "BREAKOUT" },
  volume_spike: { style: "TREND", family: "MOMENTUM" },
  fakeout: { style: "RANGE", family: "MEAN_REVERSION" },
  rsi_fade: { style: "RANGE", family: "MEAN_REVERSION" },
  wick_reversal: { style: "RANGE", family: "MEAN_REVERSION" },
};

function getStrategyMeta(strategyId) {
  return (
    STRATEGY_META[String(strategyId || "")] || {
      style: "UNKNOWN",
      family: "UNKNOWN",
    }
  );
}

function enabledStrategyIds() {
  return String(env.STRATEGIES || "ema_cross")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function wrapSignalAsSetup(signal, opts = {}) {
  if (!signal) return null;
  return {
    setupState:
      signal?.meta?.setupState ||
      signal?.setupState ||
      (opts.actionable === false ? "armed" : "triggered"),
    actionable: opts.actionable !== false,
    candidate: signal,
    anchorMeta: signal?.meta || null,
    triggerMeta: {
      triggerType: signal?.meta?.triggerType || signal?.triggerType || null,
      anchorType: signal?.meta?.anchorType || signal?.anchorType || null,
      triggerLevel: signal?.meta?.triggerLevel ?? null,
      anchorValue: signal?.meta?.anchorValue ?? null,
    },
  };
}

function attachMetaToSetup(strategyId, setup) {
  if (!setup) return null;
  const meta = getStrategyMeta(strategyId);
  const candidate = setup.candidate
    ? {
        ...setup.candidate,
        strategyId,
        strategyStyle: meta.style,
        strategyFamily: meta.family,
      }
    : null;
  return {
    ...setup,
    strategyId,
    strategyStyle: meta.style,
    strategyFamily: meta.family,
    candidate,
  };
}

function evaluateSetup(strategyId, candles, ctx = {}) {
  const id = String(strategyId || "").trim();
  const fast = Number(env.EMA_FAST ?? 9);
  const slow = Number(env.EMA_SLOW ?? 21);
  if (module.exports.runStrategy && module.exports.runStrategy !== runStrategy) {
    return attachMetaToSetup(id, wrapSignalAsSetup(module.exports.runStrategy(id, candles, ctx)));
  }

  switch (id) {
    case "ema_cross":
      return attachMetaToSetup(
        "ema_cross",
        evaluateEmaCrossSetup({
          candles,
          fast,
          slow,
          priorState: ctx.priorState,
        }),
      );
    case "ema_pullback":
      return attachMetaToSetup(
        "ema_pullback",
        evaluateEmaPullbackSetup({
          candles,
          fast,
          slow,
          pullbackBars: Number(env.PULLBACK_BARS ?? 5),
          volLookback: Number(env.PULLBACK_VOL_LOOKBACK ?? 20),
          volMult: Number(env.PULLBACK_VOL_MULT ?? 1.1),
        }),
      );
    case "breakout":
      return attachMetaToSetup(
        "breakout",
        evaluateBreakoutSetup({
          candles,
          lookback: Number(env.BREAKOUT_LOOKBACK ?? 20),
          volMult: Number(env.BREAKOUT_VOL_MULT ?? 1.2),
          volLookback: 20,
        }),
      );
    case "vwap_reclaim":
      return attachMetaToSetup(
        "vwap_reclaim",
        evaluateVwapReclaimSetup({
          candles,
          lookback: Number(env.VWAP_LOOKBACK ?? 120),
          volLookback: 20,
          volMult: Number(env.VWAP_VOL_MULT ?? 1.0),
          fast,
          slow,
        }),
      );
    case "orb":
      return attachMetaToSetup(
        "orb",
        evaluateOrbSetup({
          candles,
          intervalMin: Number(ctx.intervalMin ?? 1),
          orbMinutes: Number(env.ORB_MINUTES ?? 15),
          marketOpen: env.MARKET_OPEN,
          volLookback: 20,
          volMult: Number(env.ORB_VOL_MULT ?? 1.2),
        }),
      );
    case "bb_squeeze":
      return attachMetaToSetup(
        "bb_squeeze",
        evaluateBollingerSqueezeSetup({
          candles,
          period: Number(env.BB_PERIOD ?? 20),
          std: Number(env.BB_STDDEV ?? env.BB_STD ?? 2),
          squeezePct: Number(env.SQUEEZE_PCT ?? env.BB_SQUEEZE_PCT ?? 0.012),
          volLookback: 20,
          volMult: Number(
            env.SQUEEZE_VOL_MULT ?? env.BB_SQUEEZE_VOL_MULT ?? 1.1,
          ),
          priorState: ctx.priorState,
        }),
      );
    case "rsi_fade":
      return attachMetaToSetup(
        "rsi_fade",
        evaluateRsiFadeSetup({
          candles,
          period: Number(env.RSI_PERIOD ?? 14),
          ob: Number(env.RSI_OVERBOUGHT ?? env.RSI_OB ?? 70),
          os: Number(env.RSI_OVERSOLD ?? env.RSI_OS ?? 30),
        }),
      );
    case "volume_spike":
      if (ctx.disableVolumeStrategies) return null;
      return attachMetaToSetup(
        "volume_spike",
        evaluateVolumeSpikeSetup({
          candles,
          volLookback: Number(env.VOL_SPIKE_LOOKBACK ?? 20),
          volMult: Number(env.VOL_SPIKE_MULT ?? 2),
          bodyFrac: Number(env.MOM_BODY_FRAC ?? 0.6),
          priorState: ctx.priorState,
        }),
      );
    case "fakeout":
      return attachMetaToSetup(
        "fakeout",
        evaluateFakeoutSetup({
          candles,
          lookback: Number(env.FAKEOUT_LOOKBACK ?? 20),
          volLookback: Number(env.FAKEOUT_VOL_LOOKBACK ?? 20),
          volMult: Number(env.FAKEOUT_VOL_MULT ?? 1.0),
          wickFrac: Number(env.FAKEOUT_WICK_FRAC ?? 0.6),
          minRangeFrac: Number(env.FAKEOUT_MIN_RANGE_FRAC ?? 0.004),
        }),
      );
    case "wick_reversal":
      return attachMetaToSetup(
        "wick_reversal",
        evaluateWickReversalSetup({
          candles,
          lookback: Number(env.WICK_LOOKBACK ?? 20),
          minWickFrac: Number(env.WICK_MIN_WICK_FRAC ?? 0.6),
        }),
      );
    default:
      return null;
  }
}

function runStrategy(strategyId, candles, ctx = {}) {
  const id = String(strategyId || "").trim();
  const fast = Number(env.EMA_FAST ?? 9);
  const slow = Number(env.EMA_SLOW ?? 21);

  switch (id) {
    case "ema_cross":
      return emaCrossStrategy({ candles, fast, slow });
    case "ema_pullback":
      return emaPullbackStrategy({
        candles,
        fast,
        slow,
        pullbackBars: Number(env.PULLBACK_BARS ?? 5),
        volLookback: Number(env.PULLBACK_VOL_LOOKBACK ?? 20),
        volMult: Number(env.PULLBACK_VOL_MULT ?? 1.1),
      });
    case "breakout":
      return breakoutStrategy({
        candles,
        lookback: Number(env.BREAKOUT_LOOKBACK ?? 20),
        volMult: Number(env.BREAKOUT_VOL_MULT ?? 1.2),
        volLookback: 20,
      });
    case "vwap_reclaim":
      return vwapReclaimStrategy({
        candles,
        lookback: Number(env.VWAP_LOOKBACK ?? 120),
        volLookback: 20,
        volMult: Number(env.VWAP_VOL_MULT ?? 1.0),
        fast,
        slow,
      });
    case "orb":
      return orbStrategy({
        candles,
        intervalMin: Number(ctx.intervalMin ?? 1),
        orbMinutes: Number(env.ORB_MINUTES ?? 15),
        marketOpen: env.MARKET_OPEN,
        volLookback: 20,
        volMult: Number(env.ORB_VOL_MULT ?? 1.2),
      });
    case "bb_squeeze":
      return bollingerSqueezeStrategy({
        candles,
        period: Number(env.BB_PERIOD ?? 20),
        std: Number(env.BB_STDDEV ?? env.BB_STD ?? 2),
        squeezePct: Number(env.SQUEEZE_PCT ?? env.BB_SQUEEZE_PCT ?? 0.012),
        volLookback: 20,
        volMult: Number(env.SQUEEZE_VOL_MULT ?? env.BB_SQUEEZE_VOL_MULT ?? 1.1),
      });
    case "rsi_fade":
      return rsiFadeStrategy({
        candles,
        period: Number(env.RSI_PERIOD ?? 14),
        ob: Number(env.RSI_OVERBOUGHT ?? env.RSI_OB ?? 70),
        os: Number(env.RSI_OVERSOLD ?? env.RSI_OS ?? 30),
      });
    case "volume_spike":
      if (ctx.disableVolumeStrategies) return null;
      return volumeSpikeStrategy({
        candles,
        volLookback: Number(env.VOL_SPIKE_LOOKBACK ?? 20),
        volMult: Number(env.VOL_SPIKE_MULT ?? 2),
        bodyFrac: Number(env.MOM_BODY_FRAC ?? 0.6),
      });
    case "fakeout":
      return fakeoutStrategy({
        candles,
        lookback: Number(env.FAKEOUT_LOOKBACK ?? 20),
        volLookback: Number(env.FAKEOUT_VOL_LOOKBACK ?? 20),
        volMult: Number(env.FAKEOUT_VOL_MULT ?? 1.0),
        wickFrac: Number(env.FAKEOUT_WICK_FRAC ?? 0.6),
        minRangeFrac: Number(env.FAKEOUT_MIN_RANGE_FRAC ?? 0.004),
      });
    case "wick_reversal":
      return wickReversalStrategy({
        candles,
        lookback: Number(env.WICK_LOOKBACK ?? 20),
        minWickFrac: Number(env.WICK_MIN_WICK_FRAC ?? 0.6),
      });
    default:
      return null;
  }
}

module.exports = {
  enabledStrategyIds,
  evaluateSetup,
  runStrategy,
  getStrategyMeta,
  STRATEGY_META,
  // Direct wrappers remain exported from their own files. These touches keep
  // older code paths working while the engine consumes richer native setup state.
  __legacy: {
    emaPullbackStrategy,
    breakoutStrategy,
    vwapReclaimStrategy,
    orbStrategy,
    rsiFadeStrategy,
    fakeoutStrategy,
    wickReversalStrategy,
  },
};
