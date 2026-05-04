const crypto = require("crypto");
const {
  resolveFragileReversalPermission,
} = require("./fragileReversalPermission");

function toFiniteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cloneObject(value) {
  return value && typeof value === "object"
    ? JSON.parse(JSON.stringify(value))
    : null;
}

function clamp(value, lo, hi) {
  let out = Number(value);
  if (!Number.isFinite(out)) return lo;
  if (Number.isFinite(lo)) out = Math.max(lo, out);
  if (Number.isFinite(hi)) out = Math.min(hi, out);
  return out;
}

function normalizeStrategyStyle(style) {
  const value = String(style || "")
    .trim()
    .toUpperCase();
  if (!value) return "UNKNOWN";
  if (value.includes("OPEN")) return "OPEN";
  if (value.includes("TREND")) return "TREND";
  if (value.includes("RANGE")) return "RANGE";
  return value;
}

function normalizeRegime(regime) {
  const value = String(regime || "")
    .trim()
    .toUpperCase();
  return value || "UNKNOWN";
}

function normalizeRegimeFamily(regime) {
  const bucket = normalizeRegime(regime);
  if (bucket.includes("OPEN")) return "OPEN";
  if (bucket === "RANGE") return "RANGE";
  if (bucket === "TREND" || bucket === "TREND_COMPRESSED" || bucket === "BREAKOUT_WATCH") {
    return "TREND";
  }
  return bucket;
}

function parseAllowedRegimes(spec) {
  return String(spec || "")
    .split(",")
    .map((value) => normalizeRegime(value))
    .filter(Boolean);
}

function allowedRegimesForStyle(style, env) {
  switch (normalizeStrategyStyle(style)) {
    case "TREND":
      return parseAllowedRegimes(env?.TREND_ALLOWED_REGIMES || "TREND,OPEN");
    case "RANGE":
      return parseAllowedRegimes(env?.RANGE_ALLOWED_REGIMES || "RANGE,OPEN");
    case "OPEN":
      return parseAllowedRegimes(env?.OPEN_ALLOWED_REGIMES || "OPEN,TREND");
    default:
      return parseAllowedRegimes("TREND,RANGE,OPEN");
  }
}

function isStrategyStyleAllowedForRegime({
  strategyStyle,
  regime,
  env,
  strategyId = null,
  candidate = null,
  marketState = null,
  levelAcceptance = null,
  dangerStack = null,
  mtf = null,
  dteDays = null,
  confidence = null,
  regimeSnapshot = null,
} = {}) {
  const style = normalizeStrategyStyle(strategyStyle);
  const regimeBucket = normalizeRegime(regime);
  const regimeFamily = normalizeRegimeFamily(regimeBucket);
  const allowedRegimes = allowedRegimesForStyle(style, env);
  if (style === "UNKNOWN" || regimeBucket === "UNKNOWN") {
    return {
      allowed: true,
      strategyStyle: style,
      regime: regimeBucket,
      regimeFamily,
      allowedRegimes,
      allowedByException: false,
      exceptionChecked: false,
      exceptionAllowed: false,
      exceptionType: null,
      exceptionReasonCode: null,
      exceptionMeta: null,
    };
  }
  const allowed =
    allowedRegimes.length === 0 ||
    allowedRegimes.includes(regimeBucket) ||
    allowedRegimes.includes(regimeFamily);

  if (allowed) {
    return {
      allowed,
      strategyStyle: style,
      regime: regimeBucket,
      regimeFamily,
      allowedRegimes,
      allowedByException: false,
      exceptionChecked: false,
      exceptionAllowed: false,
      exceptionType: null,
      exceptionReasonCode: null,
      exceptionMeta: null,
    };
  }

  let exceptionMeta = null;
  if (style === "RANGE") {
    exceptionMeta = resolveFragileReversalPermission({
      strategyStyle: style,
      strategyId,
      regime: regimeBucket,
      marketState,
      candidate,
      levelAcceptance,
      dangerStack,
      mtf,
      dteDays,
      confidence,
      regimeSnapshot,
      env,
    });
    if (exceptionMeta.allowed) {
      return {
        allowed: true,
        strategyStyle: style,
        regime: regimeBucket,
        regimeFamily,
        allowedRegimes,
        allowedByException: true,
        exceptionChecked: true,
        exceptionAllowed: true,
        exceptionType: "FRAGILE_REVERSAL",
        exceptionReasonCode: "FRAGILE_REVERSAL_CONFIRMED",
        exceptionMeta,
      };
    }
  }

  return {
    allowed,
    strategyStyle: style,
    regime: regimeBucket,
    regimeFamily,
    allowedRegimes,
    allowedByException: false,
    exceptionChecked: exceptionMeta != null,
    exceptionAllowed: false,
    exceptionType: exceptionMeta?.exceptionType || null,
    exceptionReasonCode:
      exceptionMeta?.reasonCode ||
      (exceptionMeta ? "FRAGILE_REVERSAL_NOT_CONFIRMED" : null),
    exceptionMeta,
  };
}

function signalTimestampFromContext(signal, context = {}) {
  return (
    signal?.candle?.ts ||
    signal?.ts ||
    context?.last?.ts ||
    context?.last ||
    null
  );
}

function buildRegimeSnapshot({
  signal,
  context = {},
  selectorState,
  snapshotId = crypto.randomUUID(),
  timestampMs = Date.now(),
}) {
  const meta =
    signal?.regimeMeta ||
    selectorState?.meta ||
    null;
  const regimeWeights =
    signal?.regimeWeights ||
    selectorState?.regimeWeights ||
    meta?.regimeWeights ||
    null;
  const primaryRegime =
    signal?.primaryRegime ||
    selectorState?.primaryRegime ||
    meta?.primaryRegime ||
    signal?.regime ||
    selectorState?.regime ||
    null;
  const regime =
    signal?.regime ||
    selectorState?.regime ||
    primaryRegime ||
    null;
  const secondaryRegime =
    signal?.secondaryRegime ||
    selectorState?.secondaryRegime ||
    meta?.secondaryRegime ||
    null;
  const intervalMin =
    toFiniteOrNull(context?.intervalMin) ||
    toFiniteOrNull(signal?.intervalMin) ||
    toFiniteOrNull(signal?.candle?.interval_min);
  const primaryBucket = normalizeRegime(primaryRegime || regime);
  const regimeBucket = normalizeRegime(regime || primaryRegime);
  const compressionActive =
    primaryBucket === "TREND_COMPRESSED" ||
    regimeBucket === "TREND_COMPRESSED" ||
    Number(regimeWeights?.TREND_COMPRESSED ?? 0) >= 0.35;

  return Object.freeze({
    snapshotId: String(snapshotId),
    timestamp: new Date(Number(timestampMs) || Date.now()).toISOString(),
    signalTs: signalTimestampFromContext(signal, context),
    regime: regimeBucket,
    regimeFamily: normalizeRegimeFamily(regimeBucket),
    primaryRegime: primaryBucket,
    secondaryRegime: secondaryRegime ? normalizeRegime(secondaryRegime) : null,
    sourceTimeframeMin: intervalMin,
    sourceStage: context?.stage || signal?.stage || null,
    sessionPhase: meta?.sessionPhase || null,
    dayShape: meta?.dayShape || null,
    directionalBias: meta?.bias || null,
    directionalPersistence: toFiniteOrNull(meta?.directionalPersistence),
    diffInAtr: toFiniteOrNull(meta?.diffInAtr),
    rangePct: toFiniteOrNull(meta?.rangePct),
    compressionActive,
    volatilityContext: {
      rangePct: toFiniteOrNull(meta?.rangePct),
      diffInAtr: toFiniteOrNull(meta?.diffInAtr),
      directionalPersistence: toFiniteOrNull(meta?.directionalPersistence),
    },
    expectedMoveRefIntervalMin: intervalMin,
    regimeWeights: cloneObject(regimeWeights),
  });
}

function freezeSignalRegimeSnapshot(args) {
  return buildRegimeSnapshot(args);
}

function buildSignalLifecycleId() {
  return crypto.randomUUID();
}

function resolveSignalRegimeSnapshot({
  signal,
  liveDetection,
  intervalMin,
  nowMs = Date.now(),
  liveTs = null,
}) {
  const frozenSnapshot =
    signal?.regimeSnapshot && typeof signal.regimeSnapshot === "object"
      ? signal.regimeSnapshot
      : null;

  const liveSnapshot = liveDetection
    ? buildRegimeSnapshot({
        signal: {
          regime: liveDetection?.regime,
          primaryRegime: liveDetection?.primaryRegime,
          secondaryRegime: liveDetection?.secondaryRegime,
          regimeWeights: liveDetection?.regimeWeights,
          regimeMeta: liveDetection?.meta || null,
        },
        context: {
          intervalMin,
          stage: "live_regime_recheck",
          last: liveTs,
        },
        selectorState: liveDetection,
        snapshotId: `live:${normalizeRegime(liveDetection?.regime)}:${Number(
          intervalMin ?? 0,
        )}:${Number(nowMs) || Date.now()}`,
        timestampMs: nowMs,
      })
    : null;

  const mismatchReasons = [];
  if (frozenSnapshot && liveSnapshot) {
    if (normalizeRegime(frozenSnapshot.regime) !== normalizeRegime(liveSnapshot.regime)) {
      mismatchReasons.push("REGIME");
    }
    if (
      normalizeRegime(frozenSnapshot.primaryRegime) !==
      normalizeRegime(liveSnapshot.primaryRegime)
    ) {
      mismatchReasons.push("PRIMARY_REGIME");
    }
    if (
      normalizeRegime(frozenSnapshot.secondaryRegime) !==
      normalizeRegime(liveSnapshot.secondaryRegime)
    ) {
      mismatchReasons.push("SECONDARY_REGIME");
    }
    if (
      toFiniteOrNull(frozenSnapshot.sourceTimeframeMin) !==
      toFiniteOrNull(liveSnapshot.sourceTimeframeMin)
    ) {
      mismatchReasons.push("TIMEFRAME");
    }
  }

  return {
    snapshot: frozenSnapshot || liveSnapshot || null,
    frozenSnapshot,
    liveSnapshot,
    mismatch: mismatchReasons.length > 0,
    mismatchReasons,
  };
}

const PREEMIT_REASON_PRIORITY = Object.freeze([
  "PREEMIT_PROFILE_MISSING",
  "STYLE_REGIME_MISMATCH",
  "SETUP_NOT_MATURE",
  "PREVIEW_NOT_STRONG_ENOUGH",
  "LOW_PREEMIT_CONFIDENCE",
  "LOW_PREEMIT_QUALITY",
  "LOW_PREEMIT_CONTEXT",
  "LOW_PREEMIT_FINAL_SCORE",
  "LOW_PREEMIT_MTF_ALIGNMENT",
]);

const PREEMIT_STYLE_PROFILES = Object.freeze({
  TREND: {
    profileId: "style:trend_core",
    minQualityScore: 61,
    minContextScore: 59,
    minFinalSignalScore: 65,
    minMtfAgreementScore: 52,
    minFreshness: 58,
    stages: {
      tick_preview: {
        minQualityScore: 64,
        minContextScore: 62,
        minFinalSignalScore: 70,
        minMtfAgreementScore: 56,
        minFreshness: 64,
        minStageScore: 68,
        allowedSetupStates: ["armed", "triggered", "confirmed"],
      },
      bar_close_confirmed: {
        minStageScore: 88,
        allowedSetupStates: ["triggered", "confirmed", "fired"],
      },
    },
  },
  RANGE: {
    profileId: "style:range_core",
    minQualityScore: 60,
    minContextScore: 62,
    minFinalSignalScore: 65,
    minMtfAgreementScore: 48,
    minFreshness: 61,
    stages: {
      tick_preview: {
        minQualityScore: 63,
        minContextScore: 66,
        minFinalSignalScore: 70,
        minFreshness: 67,
        minStageScore: 68,
        allowedSetupStates: ["armed", "triggered", "confirmed"],
      },
      bar_close_confirmed: {
        minStageScore: 88,
        allowedSetupStates: ["triggered", "confirmed", "fired"],
      },
    },
  },
  OPEN: {
    profileId: "style:open_core",
    minQualityScore: 64,
    minContextScore: 65,
    minFinalSignalScore: 69,
    minMtfAgreementScore: 55,
    minFreshness: 66,
    stages: {
      tick_preview: {
        minQualityScore: 68,
        minContextScore: 69,
        minFinalSignalScore: 75,
        minMtfAgreementScore: 60,
        minFreshness: 73,
        minStageScore: 72,
        allowedSetupStates: ["armed", "triggered", "confirmed"],
      },
      bar_close_confirmed: {
        minStageScore: 90,
        allowedSetupStates: ["triggered", "confirmed", "fired"],
      },
    },
  },
});

const PREEMIT_FAMILY_PROFILES = Object.freeze({
  TREND: {
    profileId: "family:trend",
    minNormalizedConfidence: 64,
    minQualityScore: 62,
    minContextScore: 60,
    minFinalSignalScore: 66,
  },
  BREAKOUT: {
    profileId: "family:breakout",
    minQualityScore: 64,
    minContextScore: 61,
    minFinalSignalScore: 68,
    minMtfAgreementScore: 54,
  },
  VWAP: {
    profileId: "family:vwap",
    minQualityScore: 62,
    minContextScore: 64,
    minFinalSignalScore: 67,
  },
  OPEN: {
    profileId: "family:open",
    minRawConfidence: 58,
    minNormalizedConfidence: 68,
    minFinalSignalScore: 71,
    minFreshness: 68,
  },
  MOMENTUM: {
    profileId: "family:momentum",
    minQualityScore: 65,
    minContextScore: 60,
    minFinalSignalScore: 68,
    minFreshness: 67,
  },
  MEAN_REVERSION: {
    profileId: "family:mean_reversion",
    minQualityScore: 61,
    minContextScore: 64,
    minFinalSignalScore: 66,
    minMtfAgreementScore: 46,
    minFreshness: 63,
  },
});

const PREEMIT_STRATEGY_PROFILES = Object.freeze({
  ema_cross: {
    profileId: "strategy:ema_cross",
    minRawConfidence: 54,
    minNormalizedConfidence: 64,
    minFinalSignalScore: 66,
    stages: {
      tick_preview: {
        minNormalizedConfidence: 68,
        minFinalSignalScore: 72,
      },
    },
  },
  ema_pullback: {
    profileId: "strategy:ema_pullback",
    minQualityScore: 63,
    minContextScore: 60,
    minFinalSignalScore: 66,
  },
  breakout: {
    profileId: "strategy:breakout",
    minQualityScore: 64,
    minContextScore: 61,
    minFinalSignalScore: 68,
    stages: {
      tick_preview: {
        minFinalSignalScore: 74,
        minMtfAgreementScore: 58,
      },
    },
  },
  vwap_reclaim: {
    profileId: "strategy:vwap_reclaim",
    minQualityScore: 62,
    minContextScore: 64,
    minFinalSignalScore: 67,
  },
  orb: {
    profileId: "strategy:orb",
    minRawConfidence: 60,
    minNormalizedConfidence: 68,
    minQualityScore: 66,
    minContextScore: 67,
    minFinalSignalScore: 72,
    minFreshness: 69,
    stages: {
      tick_preview: {
        minNormalizedConfidence: 72,
        minQualityScore: 69,
        minContextScore: 70,
        minFinalSignalScore: 77,
        minFreshness: 75,
        minStageScore: 74,
      },
      bar_close_confirmed: {
        minStageScore: 92,
      },
    },
  },
  bb_squeeze: {
    profileId: "strategy:bb_squeeze",
    minQualityScore: 64,
    minFinalSignalScore: 67,
    stages: {
      tick_preview: {
        minFinalSignalScore: 73,
      },
    },
  },
  volume_spike: {
    profileId: "strategy:volume_spike",
    minRawConfidence: 56,
    minQualityScore: 66,
    minFinalSignalScore: 68,
    minFreshness: 68,
    stages: {
      tick_preview: {
        minFinalSignalScore: 74,
        minFreshness: 74,
      },
    },
  },
  fakeout: {
    profileId: "strategy:fakeout",
    minQualityScore: 61,
    minContextScore: 64,
    minFinalSignalScore: 66,
    minFreshness: 63,
  },
  rsi_fade: {
    profileId: "strategy:rsi_fade",
    minRawConfidence: 58,
    minNormalizedConfidence: 65,
    minContextScore: 64,
    minFinalSignalScore: 67,
    minFreshness: 64,
  },
  wick_reversal: {
    profileId: "strategy:wick_reversal",
    minQualityScore: 63,
    minContextScore: 64,
    minFinalSignalScore: 67,
    minFreshness: 64,
  },
});
const KNOWN_PREEMIT_STRATEGIES = new Set(Object.keys(PREEMIT_STRATEGY_PROFILES));

function toIsoOrNull(value) {
  if (value == null) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function normalizeSignalStage(stage) {
  const value = String(stage || "").trim().toLowerCase();
  if (value === "tick" || value === "tick_preview") return "tick_preview";
  return "bar_close_confirmed";
}

function normalizeSetupState(setupState) {
  return String(setupState || "")
    .trim()
    .toLowerCase();
}

function buildSignalTiming({ signal, context = {}, createdAtMs = Date.now(), decisionTsMs = null }) {
  const signalEventTs = toIsoOrNull(
    signal?.signalEventTs || signalTimestampFromContext(signal, context),
  );
  const signalCreatedAt = toIsoOrNull(signal?.signalCreatedAt || createdAtMs);
  const signalDecisionTs = toIsoOrNull(
    signal?.signalDecisionTs || decisionTsMs || signal?.signalCreatedAt || createdAtMs,
  );
  return {
    signalEventTs,
    signalCreatedAt,
    signalDecisionTs,
  };
}

function buildSignalOutcomeKey(signal, context = {}) {
  const token =
    toFiniteOrNull(signal?.instrument_token) ||
    toFiniteOrNull(signal?.token) ||
    toFiniteOrNull(context?.instrument_token);
  const intervalMin =
    toFiniteOrNull(signal?.intervalMin) ||
    toFiniteOrNull(signal?.candle?.interval_min) ||
    toFiniteOrNull(context?.intervalMin);
  const eventTs = toIsoOrNull(signal?.signalEventTs || signalTimestampFromContext(signal, context));
  const strategyId = String(signal?.strategyId || "").trim();
  const side = String(signal?.side || "").trim().toUpperCase();
  const signalStage = normalizeSignalStage(signal?.signalStage || context?.stage);
  const lineageKey = String(
    signal?.setupId ||
      signal?.meta?.setupId ||
      signal?.lineageId ||
      signal?.meta?.lineageId ||
      "na",
  ).trim();
  if (
    token == null ||
    intervalMin == null ||
    !eventTs ||
    !strategyId ||
    !side ||
    !signalStage
  ) {
    return null;
  }
  return [
    Number(token),
    Number(intervalMin),
    eventTs,
    strategyId,
    side,
    signalStage,
    lineageKey || "na",
  ].join("|");
}

function mergeStageProfiles(baseStages = {}, extraStages = {}) {
  const stages = {};
  const keys = new Set([...Object.keys(baseStages), ...Object.keys(extraStages)]);
  for (const key of keys) {
    stages[key] = {
      ...(baseStages[key] || {}),
      ...(extraStages[key] || {}),
    };
  }
  return stages;
}

function mergeProfileLayers(baseProfile = {}, layer = {}) {
  const next = {
    ...baseProfile,
    ...layer,
  };
  next.stages = mergeStageProfiles(baseProfile.stages, layer.stages);
  return next;
}

function globalPreEmitProfile(env) {
  const baseLiveThreshold = Math.max(0, Number(env?.MIN_SIGNAL_CONFIDENCE ?? 62));
  return {
    profileId: "global:default",
    minRawConfidence: Math.max(48, baseLiveThreshold - 14),
    minNormalizedConfidence: Math.max(
      60,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_NORMALIZED_CONFIDENCE ?? baseLiveThreshold - 8),
    ),
    minQualityScore: Math.max(
      58,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE ?? 60),
    ),
    minContextScore: Math.max(
      56,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE ?? 58),
    ),
    minFinalSignalScore: Math.max(
      62,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE ?? baseLiveThreshold - 4),
    ),
    minMtfAgreementScore: Math.max(
      44,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE ?? 50),
    ),
    minFreshness: Math.max(
      54,
      Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_FRESHNESS ?? 58),
    ),
    minStageScore: 60,
    allowedSetupStates: ["armed", "triggered", "confirmed", "fired"],
    stages: {
      tick_preview: {
        minRawConfidence: Math.max(50, baseLiveThreshold - 10),
        minNormalizedConfidence: Math.max(64, baseLiveThreshold - 4),
        minQualityScore: Math.max(62, Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE ?? 60) + 3),
        minContextScore: Math.max(60, Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE ?? 58) + 4),
        minFinalSignalScore: Math.max(68, baseLiveThreshold + 2),
        minMtfAgreementScore: Math.max(52, Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE ?? 50) + 4),
        minFreshness: Math.max(64, Number(env?.SIGNAL_PREEMIT_GLOBAL_MIN_FRESHNESS ?? 58) + 6),
        minStageScore: 68,
        allowedSetupStates: ["armed", "triggered", "confirmed"],
      },
      bar_close_confirmed: {
        minStageScore: 88,
        allowedSetupStates: ["triggered", "confirmed", "fired"],
      },
    },
  };
}

function isOptionRoutingLikely(env, candidate = {}) {
  return (
    String(env?.FNO_ENABLED || "false").toLowerCase() === "true" &&
    String(env?.FNO_MODE || "FUT").toUpperCase() === "OPT" &&
    !candidate?.option_meta
  );
}

function resolveRoutePremiumBand({ signal, pick, env }) {
  const fromPick = pick?.premiumBand || pick?.meta?.premiumBand || null;
  if (fromPick) {
    return {
      minPrem: toFiniteOrNull(fromPick.minPrem),
      maxPrem: toFiniteOrNull(fromPick.maxPrem),
      enforced: fromPick.enforced === true,
      source: "selected_contract",
      underlying: pick?.underlying || null,
    };
  }

  const underlying = String(
    signal?.underlying_symbol ||
      signal?.underlying ||
      signal?.option_meta?.underlying ||
      pick?.underlying ||
      "",
  )
    .trim()
    .toUpperCase();
  const isNifty = underlying === "NIFTY";

  return {
    minPrem: toFiniteOrNull(
      isNifty
        ? env?.OPT_MIN_PREMIUM_NIFTY ?? env?.OPT_MIN_PREMIUM ?? 80
        : env?.OPT_MIN_PREMIUM ?? 20,
    ),
    maxPrem: toFiniteOrNull(
      isNifty
        ? env?.OPT_MAX_PREMIUM_NIFTY ?? env?.OPT_MAX_PREMIUM ?? 350
        : env?.OPT_MAX_PREMIUM ?? 600,
    ),
    enforced: isNifty
      ? String(env?.OPT_PREMIUM_BAND_ENFORCE_NIFTY ?? "true") !== "false"
      : false,
    source: "env",
    underlying: underlying || null,
  };
}

function resolveRouteDeltaTarget({ pick, env }) {
  const deltaTarget = toFiniteOrNull(
    pick?.meta?.deltaBand?.target ??
      pick?.deltaTarget ??
      env?.OPT_DELTA_TARGET ??
      0.5,
  );
  const deltaMin = toFiniteOrNull(
    pick?.meta?.deltaBand?.min ?? env?.OPT_DELTA_BAND_MIN ?? 0.35,
  );
  const deltaMax = toFiniteOrNull(
    pick?.meta?.deltaBand?.max ?? env?.OPT_DELTA_BAND_MAX ?? 0.65,
  );
  return {
    deltaTarget,
    deltaMin,
    deltaMax,
  };
}

function roundMetric(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num * 10) / 10 : null;
}

function summarizeOptionContract(optionMeta = null) {
  if (!optionMeta || typeof optionMeta !== "object") return null;
  return {
    token: toFiniteOrNull(optionMeta.instrument_token),
    underlying: optionMeta.underlying || null,
    optType: optionMeta.optType || null,
    strike: toFiniteOrNull(optionMeta.strike),
    expiry: optionMeta.expiry || null,
    premium: toFiniteOrNull(optionMeta.ltp),
    spreadBps: toFiniteOrNull(optionMeta.bps),
    healthScore: toFiniteOrNull(optionMeta.health_score),
    selectedByFallback:
      optionMeta?.meta?.selectionObservability?.selectedByFallback === true ||
      optionMeta?.meta?.selectionPath?.selectedByFallback === true,
    fallbackReason:
      optionMeta?.meta?.selectionObservability?.fallbackReason ||
      optionMeta?.meta?.selectionPath?.fallbackReason ||
      null,
    premiumReadinessState:
      optionMeta?.premiumContext?.readinessState ||
      optionMeta?.meta?.premiumContext?.readinessState ||
      null,
  };
}

function buildRouteConfidenceAssessment({
  signal = null,
  baseConfidence,
  pick = null,
  liqMeta = null,
  env = {},
  estimated = false,
  positiveAdjustmentCap = null,
}) {
  const preRouteScore = toFiniteOrNull(baseConfidence);
  if (preRouteScore == null) {
    return {
      preRouteScore: null,
      expectedRouteAdjustment: null,
      routedScore: null,
      estimated,
      components: [],
      contractMetrics: null,
    };
  }

  const selectorParticipation = toFiniteOrNull(
    signal?.selectorParticipation ?? signal?.scoreBreakdown?.selectorParticipation,
  );
  const volumeQuality = toFiniteOrNull(
    signal?.volumeQuality ?? signal?.scoreBreakdown?.volumeQuality,
  );
  const qualityScore = toFiniteOrNull(signal?.qualityScore);
  const contextScore = toFiniteOrNull(signal?.contextScore);

  const qualityInputs = [
    volumeQuality,
    qualityScore,
    contextScore,
    selectorParticipation,
  ].filter((value) => value != null);
  const estimatedLiquidityQuality =
    qualityInputs.length > 0
      ? qualityInputs.reduce((sum, value) => sum + Number(value), 0) /
        qualityInputs.length
      : null;

  const band = resolveRoutePremiumBand({ signal, pick, env });
  const { deltaTarget, deltaMin, deltaMax } = resolveRouteDeltaTarget({
    pick,
    env,
  });
  const deltaUsed = toFiniteOrNull(
    pick?.delta ?? pick?.meta?.selectionObservability?.deltaAbs,
  );
  const deltaSpan =
    deltaMin != null && deltaMax != null && deltaMax > deltaMin
      ? deltaMax - deltaMin
      : 0.3;
  const deltaRelative =
    deltaUsed != null
      ? clamp((Math.abs(deltaUsed) - (deltaMin ?? 0.35)) / deltaSpan, 0.1, 0.9)
      : deltaTarget != null
        ? clamp((deltaTarget - (deltaMin ?? 0.35)) / deltaSpan, 0.15, 0.85)
        : 0.5;

  const premiumValue = toFiniteOrNull(
    pick?.ltp ??
      (band.minPrem != null && band.maxPrem != null
        ? band.minPrem + (band.maxPrem - band.minPrem) * deltaRelative
        : null),
  );
  const premiumRange =
    band.minPrem != null &&
    band.maxPrem != null &&
    Number(band.maxPrem) > Number(band.minPrem)
      ? Number(band.maxPrem) - Number(band.minPrem)
      : null;
  const premiumZone =
    premiumValue != null && premiumRange != null
      ? clamp((premiumValue - Number(band.minPrem)) / premiumRange, 0, 1.25)
      : null;

  const actualHealth = toFiniteOrNull(
    liqMeta?.healthScore ?? pick?.health_score,
  );
  const actualSpreadBps = toFiniteOrNull(liqMeta?.spreadBps ?? pick?.bps);
  const bookDepth =
    (Number(liqMeta?.bidQty ?? 0) + Number(liqMeta?.askQty ?? 0)) / 2;
  const actualDepth = toFiniteOrNull(
    liqMeta?.depthQty ??
      liqMeta?.depth ??
      (bookDepth > 0 ? bookDepth : pick?.depth),
  );
  const fallbackReason =
    pick?.meta?.selectionObservability?.fallbackReason ||
    pick?.meta?.selectionPath?.fallbackReason ||
    null;
  const eligibilityPassed =
    pick?.meta?.selectionObservability?.eligibilityPassed ??
    pick?.meta?.selectionPath?.eligibilityPassed ??
    null;
  const minEligibilityChecksPassed =
    pick?.meta?.selectionObservability?.minEligibilityChecksPassed ??
    pick?.meta?.selectionPath?.minEligibilityChecksPassed ??
    null;
  const selectedReason =
    pick?.meta?.selectionObservability?.selectedReason ||
    pick?.meta?.selectionPath?.selectedReason ||
    null;
  const selectedByFallback =
    pick?.meta?.selectionObservability?.selectedByFallback === true ||
    pick?.meta?.selectionPath?.selectedByFallback === true;

  const estimatedHealth =
    estimatedLiquidityQuality != null
      ? clamp(38 + Number(estimatedLiquidityQuality) * 0.52, 42, 88)
      : null;
  const maxSpreadBps = Math.max(10, Number(env?.OPT_MAX_SPREAD_BPS ?? 35));
  const estimatedSpreadBps =
    estimatedLiquidityQuality != null
      ? clamp(
          maxSpreadBps * (1.18 - Number(estimatedLiquidityQuality) / 180) +
            Number(premiumZone ?? 0) * 8,
          10,
          maxSpreadBps * 1.5,
        )
      : null;
  const estimatedDepth =
    estimatedLiquidityQuality != null
      ? Math.round(
          Math.max(1, Number(estimatedLiquidityQuality)) *
            Math.max(0.35, Number(selectorParticipation ?? 75) / 100) *
            6,
        )
      : null;

  const healthScore = actualHealth ?? estimatedHealth;
  const spreadBps = actualSpreadBps ?? estimatedSpreadBps;
  const depth = actualDepth ?? estimatedDepth;
  const healthAdjustment =
    healthScore != null ? clamp((healthScore - 55) / 4, -6, 12) : 0;
  const maxSpreadPenalty = Math.max(
    0,
    Number(env?.OPT_ROUTE_MAX_SPREAD_PENALTY ?? 6),
  );
  const spreadPenalty =
    spreadBps != null ? -clamp(spreadBps / 20, 0, maxSpreadPenalty) : 0;
  const depthAdjustment =
    depth != null && depth > 0 ? clamp(Math.log(depth + 1) - 2, 0, 6) : 0;

  const liquidityAdjustment =
    healthAdjustment + spreadPenalty + depthAdjustment;

  const premiumPenalty =
    band.enforced && premiumZone != null ? -clamp(premiumZone * 3.5, 0, 3.5) : 0;
  const deltaPenalty =
    deltaUsed != null && deltaTarget != null
      ? -clamp(Math.abs(Math.abs(deltaUsed) - deltaTarget) * 18, 0, 4)
      : 0;
  const selectorPenalty = selectedByFallback
    ? -4
    : selectorParticipation != null
      ? -clamp((100 - selectorParticipation) / 18, 0, 3)
      : 0;
  const estimatePenalty = estimated ? -0.6 : 0;

  const rawAdjustment =
    liquidityAdjustment +
    premiumPenalty +
    deltaPenalty +
    selectorPenalty +
    estimatePenalty;
  let cappedAdjustment =
    Number.isFinite(Number(positiveAdjustmentCap)) &&
    Number(positiveAdjustmentCap) > 0 &&
    rawAdjustment > 0
      ? Math.min(rawAdjustment, Number(positiveAdjustmentCap))
      : rawAdjustment;
  const maxNegativeAdjustment = Math.max(
    0,
    Number(env?.OPT_ROUTE_MAX_NEG_ADJUSTMENT ?? 8),
  );
  if (cappedAdjustment < 0) {
    cappedAdjustment = Math.max(cappedAdjustment, -maxNegativeAdjustment);
  }
  const routedScore = clamp(preRouteScore + cappedAdjustment, 0, 100);

  return {
    preRouteScore: roundMetric(preRouteScore),
    expectedRouteAdjustment: roundMetric(cappedAdjustment),
    routedScore: roundMetric(routedScore),
    estimated,
    components: [
      {
        dimension: "liquidityHealth",
        adjustment: roundMetric(liquidityAdjustment),
      },
      {
        dimension: "premiumBand",
        adjustment: roundMetric(premiumPenalty),
      },
      {
        dimension: "deltaBand",
        adjustment: roundMetric(deltaPenalty),
      },
      {
        dimension: "selectorFallback",
        adjustment: roundMetric(selectorPenalty),
      },
      {
        dimension: "estimatePenalty",
        adjustment: roundMetric(estimatePenalty),
      },
    ],
    contractMetrics: {
      healthScore: roundMetric(healthScore),
      spreadBps: roundMetric(spreadBps),
      depth: roundMetric(depth),
      premium: roundMetric(premiumValue),
      premiumBand: {
        minPrem: roundMetric(band.minPrem),
        maxPrem: roundMetric(band.maxPrem),
        enforced: band.enforced === true,
        source: band.source,
      },
      premiumZone: roundMetric(premiumZone),
      deltaTarget: roundMetric(deltaTarget),
      deltaUsed: roundMetric(deltaUsed),
      selectedByFallback,
      fallbackReason,
      eligibilityPassed:
        typeof eligibilityPassed === "boolean" ? eligibilityPassed : null,
      minEligibilityChecksPassed:
        typeof minEligibilityChecksPassed === "boolean"
          ? minEligibilityChecksPassed
          : null,
      selectedReason,
      selectorParticipation: roundMetric(selectorParticipation),
      liquidityQualityEstimate: roundMetric(estimatedLiquidityQuality),
    },
  };
}

function resolveStageThresholds(profile, signalStage) {
  const stage = normalizeSignalStage(signalStage);
  return {
    ...profile,
    ...(profile?.stages?.[stage] || {}),
    signalStage: stage,
    stages: undefined,
  };
}

function resolvePreEmitProfile(candidate, env) {
  const strategyId = String(candidate?.strategyId || "").trim();
  const strategyStyle = normalizeStrategyStyle(candidate?.strategyStyle);
  const strategyFamily = String(candidate?.strategyFamily || "")
    .trim()
    .toUpperCase();
  const signalStage = normalizeSignalStage(candidate?.signalStage || candidate?.stage);
  const profileChain = [
    {
      source: "global:default",
      profileId: "global:default",
    },
  ];
  let resolved = globalPreEmitProfile(env);

  const styleProfile = PREEMIT_STYLE_PROFILES[strategyStyle];
  if (styleProfile) {
    resolved = mergeProfileLayers(resolved, styleProfile);
    profileChain.push({
      source: `style:${strategyStyle}`,
      profileId: styleProfile.profileId || `style:${strategyStyle}`,
    });
  }

  const familyProfile = PREEMIT_FAMILY_PROFILES[strategyFamily];
  if (familyProfile) {
    resolved = mergeProfileLayers(resolved, familyProfile);
    profileChain.push({
      source: `family:${strategyFamily}`,
      profileId: familyProfile.profileId || `family:${strategyFamily}`,
    });
  }

  const strategyProfile = PREEMIT_STRATEGY_PROFILES[strategyId];
  if (strategyProfile) {
    resolved = mergeProfileLayers(resolved, strategyProfile);
    profileChain.push({
      source: `strategy:${strategyId}`,
      profileId: strategyProfile.profileId || `strategy:${strategyId}`,
    });
  }

  const explicitCoverage =
    KNOWN_PREEMIT_STRATEGIES.has(strategyId) &&
    profileChain.length > 1 &&
    (profileChain.some((entry) => entry.source.startsWith("strategy:")) ||
      profileChain.some((entry) => entry.source.startsWith("family:")) ||
      profileChain.some((entry) => entry.source.startsWith("style:")));
  const leaf = profileChain[profileChain.length - 1] || null;

  return {
    resolved: explicitCoverage && Boolean(strategyId),
    missingReason:
      explicitCoverage && strategyId ? null : "PREEMIT_PROFILE_MISSING",
    strategyId,
    strategyStyle,
    strategyFamily: strategyFamily || null,
    signalStage,
    profileSource: leaf?.source || null,
    profileId: leaf?.profileId || null,
    profileChain,
    thresholds: resolveStageThresholds(resolved, signalStage),
  };
}

function resolveRouteAwarePreEmitTelemetry({
  candidate,
  routeConfidence,
  env,
}) {
  const routeAwareMinConfidence = Math.max(
    0,
    Number(env?.MIN_SIGNAL_CONFIDENCE ?? 0),
  );
  const routedScore = toFiniteOrNull(routeConfidence?.routedScore);
  const hardRejectFloor = Math.max(
    0,
    Number(env?.PRE_ROUTE_ESTIMATE_HARD_REJECT_SCORE ?? 40),
  );
  const penaltyCap = Math.max(
    2,
    Number(env?.PRE_ROUTE_ESTIMATE_SOFT_PENALTY_POINTS ?? 5),
  );

  if (!(routeConfidence && routeAwareMinConfidence > 0 && routedScore != null)) {
    return {
      routeConfidenceStage: "PRE",
      routeConfidenceDecision: "PASS",
      routeDecisionReason: null,
      estimateUsed: routeConfidence != null,
      actualUsed: false,
      routePenaltyApplied: 0,
      routeAwareMinConfidence:
        routeAwareMinConfidence > 0 ? routeAwareMinConfidence : null,
      routedScore,
      hardRejectFloor,
    };
  }

  if (routedScore < hardRejectFloor) {
    return {
      routeConfidenceStage: "PRE",
      routeConfidenceDecision: "HARD_REJECT",
      routeDecisionReason: "EXTREME_PRE_ROUTE_CONFIDENCE",
      estimateUsed: true,
      actualUsed: false,
      routePenaltyApplied: 0,
      routeAwareMinConfidence,
      routedScore,
      hardRejectFloor,
    };
  }

  if (routedScore < routeAwareMinConfidence) {
    const gap = Math.max(0, routeAwareMinConfidence - routedScore);
    const routePenaltyApplied = Math.max(
      2,
      Math.min(penaltyCap, Math.ceil(gap / 2)),
    );
    return {
      routeConfidenceStage: "PRE",
      routeConfidenceDecision: "SOFT_PENALTY",
      routeDecisionReason: "ROUTE_CONFIDENCE_SOFT_PENALTY",
      estimateUsed: true,
      actualUsed: false,
      routePenaltyApplied,
      routeAwareMinConfidence,
      routedScore,
      hardRejectFloor,
    };
  }

  return {
    routeConfidenceStage: "PRE",
    routeConfidenceDecision: "PASS",
    routeDecisionReason: null,
    estimateUsed: true,
    actualUsed: false,
    routePenaltyApplied: 0,
    routeAwareMinConfidence,
    routedScore,
    hardRejectFloor,
  };
}

function resolveMtfPreEmitTelemetry({ candidate, thresholds, env }) {
  const mtfScore = toFiniteOrNull(candidate?.mtfAgreementScore);
  const threshold = toFiniteOrNull(thresholds?.minMtfAgreementScore);
  const softZonePoints = Math.max(
    0,
    Number(env?.SIGNAL_PREEMIT_MTF_SOFT_ZONE_POINTS ?? 3),
  );
  const hardFailMargin = Math.max(
    softZonePoints,
    Number(env?.SIGNAL_PREEMIT_MTF_HARD_FAIL_MARGIN ?? 5),
  );
  const softPenaltyBase = Math.max(
    2,
    Number(env?.SIGNAL_PREEMIT_MTF_SOFT_PENALTY ?? 3),
  );

  if (!(mtfScore != null && threshold != null)) {
    return {
      mtfDecision: "PASS",
      mtfPenaltyApplied: 0,
      mtfThreshold: threshold,
      mtfSoftFloor: threshold != null ? threshold - softZonePoints : null,
      mtfHardFloor: threshold != null ? threshold - hardFailMargin : null,
    };
  }

  const mtfSoftFloor = threshold - softZonePoints;
  const mtfHardFloor = threshold - hardFailMargin;

  if (mtfScore < mtfHardFloor) {
    return {
      mtfDecision: "HARD_FAIL",
      mtfPenaltyApplied: 0,
      mtfThreshold: threshold,
      mtfSoftFloor,
      mtfHardFloor,
    };
  }

  if (mtfScore < threshold) {
    return {
      mtfDecision: "SOFT_FAIL",
      mtfPenaltyApplied: mtfScore < mtfSoftFloor ? softPenaltyBase + 1 : softPenaltyBase,
      mtfThreshold: threshold,
      mtfSoftFloor,
      mtfHardFloor,
    };
  }

  return {
    mtfDecision: "PASS",
    mtfPenaltyApplied: 0,
    mtfThreshold: threshold,
    mtfSoftFloor,
    mtfHardFloor,
  };
}

function buildPreEmitQualityMeta(candidate, profileResolution, env) {
  const scoreBreakdown = candidate?.scoreBreakdown || {};
  const stagePenalty =
    candidate?.isProvisional === true
      ? Math.max(0, 100 - Number(scoreBreakdown.stageScore ?? candidate?.stageScore ?? 64))
      : 0;
  const thresholds = profileResolution?.thresholds || null;
  const routeConfidence = isOptionRoutingLikely(env, candidate)
    ? buildRouteConfidenceAssessment({
        signal: candidate,
        baseConfidence: candidate?.rawConfidence ?? candidate?.confidence,
        env,
        estimated: true,
        positiveAdjustmentCap: Number(env?.OPT_PRE_ROUTE_MAX_CONF_BOOST ?? 14),
      })
    : null;
  const routeTelemetry = resolveRouteAwarePreEmitTelemetry({
    candidate,
    routeConfidence,
    env,
  });
  const mtfTelemetry = resolveMtfPreEmitTelemetry({
    candidate,
    thresholds,
    env,
  });
  const effectiveFinalSignalScore = toFiniteOrNull(
    Number(candidate?.finalSignalScore) -
      Number(routeTelemetry.routePenaltyApplied ?? 0) -
      Number(mtfTelemetry.mtfPenaltyApplied ?? 0),
  );

  return {
    profileSource: profileResolution?.profileSource || null,
    profileId: profileResolution?.profileId || null,
    profileChain: profileResolution?.profileChain || [],
    signalStage: profileResolution?.signalStage || normalizeSignalStage(candidate?.signalStage),
    resolvedThresholds: thresholds,
    rawConfidence: toFiniteOrNull(candidate?.rawConfidence ?? candidate?.confidence),
    normalizedConfidence: toFiniteOrNull(candidate?.normalizedConfidence),
    qualityScore: toFiniteOrNull(candidate?.qualityScore),
    contextScore: toFiniteOrNull(candidate?.contextScore),
    finalSignalScore: toFiniteOrNull(candidate?.finalSignalScore),
    mtfAgreementScore: toFiniteOrNull(candidate?.mtfAgreementScore),
    mtfState: candidate?.mtfState || scoreBreakdown.mtfState || null,
    mtfMissingIntervals:
      candidate?.mtfMissingIntervals || scoreBreakdown.mtfMissingIntervals || [],
    mtfStaleIntervals:
      candidate?.mtfStaleIntervals || scoreBreakdown.mtfStaleIntervals || [],
    mtfFallbackReason:
      candidate?.mtfFallbackReason || scoreBreakdown.mtfFallbackReason || null,
    mtfDegraded:
      candidate?.mtfDegraded === true || scoreBreakdown.mtfDegraded === true,
    freshness: toFiniteOrNull(candidate?.freshness ?? scoreBreakdown.freshness),
    stageScore: toFiniteOrNull(candidate?.stageScore ?? scoreBreakdown.stageScore),
    setupState: normalizeSetupState(candidate?.setupState || candidate?.meta?.setupState),
    routeConfidence,
    routeConfidenceStage: routeTelemetry.routeConfidenceStage,
    routeConfidenceDecision: routeTelemetry.routeConfidenceDecision,
    routeDecisionReason: routeTelemetry.routeDecisionReason || null,
    estimateUsed: routeTelemetry.estimateUsed,
    actualUsed: routeTelemetry.actualUsed,
    routePenaltyApplied: toFiniteOrNull(routeTelemetry.routePenaltyApplied),
    routeAwareMinConfidence: toFiniteOrNull(routeTelemetry.routeAwareMinConfidence),
    mtfDecision: mtfTelemetry.mtfDecision,
    mtfPenaltyApplied: toFiniteOrNull(mtfTelemetry.mtfPenaltyApplied),
    mtfThreshold: toFiniteOrNull(mtfTelemetry.mtfThreshold),
    mtfSoftFloor: toFiniteOrNull(mtfTelemetry.mtfSoftFloor),
    mtfHardFloor: toFiniteOrNull(mtfTelemetry.mtfHardFloor),
    effectiveFinalSignalScore,
    boosts: {
      regimeAlignment: toFiniteOrNull(candidate?.regimeAlignment ?? scoreBreakdown.regimeAlignment),
      selectorParticipation: toFiniteOrNull(
        candidate?.selectorParticipation ?? scoreBreakdown.selectorParticipation,
      ),
      antiChop: toFiniteOrNull(candidate?.antiChop ?? (100 - Number(scoreBreakdown.chopPenalty ?? 0))),
      antiGap: toFiniteOrNull(candidate?.antiGap ?? (100 - Number(scoreBreakdown.gapPenalty ?? 0))),
    },
    penalties: {
      chopPenalty: toFiniteOrNull(scoreBreakdown.chopPenalty),
      gapPenalty: toFiniteOrNull(scoreBreakdown.gapPenalty),
      provisionalPenalty: toFiniteOrNull(stagePenalty),
    },
    suppressionBeforeRouting: true,
  };
}

function shouldEmitLiveCandidate({ candidate, env }) {
  const profileResolution = resolvePreEmitProfile(candidate, env);
  const qualityMeta = buildPreEmitQualityMeta(candidate, profileResolution, env);
  const thresholds = profileResolution?.thresholds || {};
  const failedChecks = [];
  const failingDimensions = [];
  const suppressionReasons = new Set();

  const pushFailure = ({ check, dimension, reason }) => {
    failedChecks.push(check);
    failingDimensions.push(dimension);
    if (reason) suppressionReasons.add(reason);
  };

  if (!profileResolution.resolved) {
    pushFailure({
      check: "PREEMIT_PROFILE_MISSING",
      dimension: "profile",
      reason: "PREEMIT_PROFILE_MISSING",
    });
  }

  const allowedSetupStates = Array.isArray(thresholds.allowedSetupStates)
    ? thresholds.allowedSetupStates.map(normalizeSetupState)
    : [];
  const setupState = normalizeSetupState(candidate?.setupState || candidate?.meta?.setupState);
  if (allowedSetupStates.length && setupState && !allowedSetupStates.includes(setupState)) {
    pushFailure({
      check: "SETUP_STATE_NOT_ALLOWED",
      dimension: "setupState",
      reason: "SETUP_NOT_MATURE",
    });
  }

  const observedChecks = [
    {
      check: "LOW_RAW_CONFIDENCE",
      dimension: "rawConfidence",
      reason: "LOW_PREEMIT_CONFIDENCE",
      value: Number(candidate?.rawConfidence ?? candidate?.confidence),
      threshold: Number(thresholds.minRawConfidence),
    },
    {
      check: "LOW_NORMALIZED_CONFIDENCE",
      dimension: "normalizedConfidence",
      reason: "LOW_PREEMIT_CONFIDENCE",
      value: Number(candidate?.normalizedConfidence),
      threshold: Number(thresholds.minNormalizedConfidence),
    },
    {
      check: "LOW_QUALITY_SCORE",
      dimension: "qualityScore",
      reason: "LOW_PREEMIT_QUALITY",
      value: Number(candidate?.qualityScore),
      threshold: Number(thresholds.minQualityScore),
    },
    {
      check: "LOW_CONTEXT_SCORE",
      dimension: "contextScore",
      reason: "LOW_PREEMIT_CONTEXT",
      value: Number(candidate?.contextScore),
      threshold: Number(thresholds.minContextScore),
    },
    {
      check: "LOW_FINAL_SIGNAL_SCORE",
      dimension: "finalSignalScore",
      reason: "LOW_PREEMIT_FINAL_SCORE",
      value: Number(
        qualityMeta?.effectiveFinalSignalScore ?? candidate?.finalSignalScore,
      ),
      threshold: Number(thresholds.minFinalSignalScore),
    },
    {
      check: "LOW_FRESHNESS",
      dimension: "freshness",
      reason: "SETUP_NOT_MATURE",
      value: Number(candidate?.freshness ?? candidate?.scoreBreakdown?.freshness),
      threshold: Number(thresholds.minFreshness),
    },
    {
      check: "LOW_STAGE_SCORE",
      dimension: "stageScore",
      reason:
        profileResolution.signalStage === "tick_preview"
          ? "PREVIEW_NOT_STRONG_ENOUGH"
          : "SETUP_NOT_MATURE",
      value: Number(candidate?.stageScore ?? candidate?.scoreBreakdown?.stageScore),
      threshold: Number(thresholds.minStageScore),
    },
  ];

  if (qualityMeta.routeConfidenceDecision === "HARD_REJECT") {
    pushFailure({
      check: "EXTREME_PRE_ROUTE_CONFIDENCE",
      dimension: "routeAdjustedConfidence",
      reason: "LOW_PREEMIT_CONFIDENCE",
    });
  }

  if (qualityMeta.mtfDecision === "HARD_FAIL") {
    pushFailure({
      check: "LOW_MTF_AGREEMENT_SCORE",
      dimension: "mtfAgreementScore",
      reason: "LOW_PREEMIT_MTF_ALIGNMENT",
    });
  }

  for (const check of observedChecks) {
    if (!Number.isFinite(check.threshold)) continue;
    if (!Number.isFinite(check.value) || check.value < check.threshold) {
      pushFailure(check);
    }
  }

  if (
    profileResolution.signalStage === "tick_preview" &&
    failedChecks.length > 0
  ) {
    suppressionReasons.add("PREVIEW_NOT_STRONG_ENOUGH");
  }

  const orderedReasons = PREEMIT_REASON_PRIORITY.filter((reason) =>
    suppressionReasons.has(reason),
  );
  const suppressionReason = orderedReasons[0] || null;

  return {
    emit: orderedReasons.length === 0,
    reasonCode: suppressionReason ? `SIGNAL_SUPPRESSED_${suppressionReason}` : null,
    suppressionReason,
    suppressionReasons: orderedReasons,
    failedChecks,
    failingDimensions,
    profile: profileResolution,
    qualityMeta: {
      ...qualityMeta,
      failedChecks,
      failingDimensions,
      suppressionReason,
      suppressionReasons: orderedReasons,
    },
  };
}

function getSignalDecisionBreakdown(signal) {
  if (!signal || typeof signal !== "object") return null;
  const decision = signal?.signalDecision || {};
  const scoreBreakdown = signal?.scoreBreakdown || {};
  return {
    signalId: signal?.signalId || decision?.signalId || null,
    signalOutcomeKey: signal?.signalOutcomeKey || decision?.signalOutcomeKey || null,
    timing: {
      signalEventTs: signal?.signalEventTs || decision?.timing?.signalEventTs || signal?.ts || null,
      signalCreatedAt:
        signal?.signalCreatedAt || decision?.timing?.signalCreatedAt || null,
      signalDecisionTs:
        signal?.signalDecisionTs || decision?.timing?.signalDecisionTs || null,
    },
    score: {
      rawConfidence: toFiniteOrNull(signal?.rawConfidence ?? signal?.confidence),
      normalizedConfidence: toFiniteOrNull(signal?.normalizedConfidence),
      patternQuality: toFiniteOrNull(signal?.patternQuality ?? scoreBreakdown.patternQuality),
      volumeQuality: toFiniteOrNull(signal?.volumeQuality ?? scoreBreakdown.volumeQuality),
      anchorQuality: toFiniteOrNull(signal?.anchorQuality ?? scoreBreakdown.anchorQuality),
      structureQuality: toFiniteOrNull(
        signal?.structureQuality ?? scoreBreakdown.structureQuality,
      ),
      qualityScore: toFiniteOrNull(signal?.qualityScore),
      regimeAlignment: toFiniteOrNull(signal?.regimeAlignment ?? scoreBreakdown.regimeAlignment),
      freshness: toFiniteOrNull(signal?.freshness ?? scoreBreakdown.freshness),
      antiChop: toFiniteOrNull(signal?.antiChop ?? (100 - Number(scoreBreakdown.chopPenalty ?? 0))),
      antiGap: toFiniteOrNull(signal?.antiGap ?? (100 - Number(scoreBreakdown.gapPenalty ?? 0))),
      stageScore: toFiniteOrNull(signal?.stageScore ?? scoreBreakdown.stageScore),
      selectorParticipation: toFiniteOrNull(
        signal?.selectorParticipation ?? scoreBreakdown.selectorParticipation,
      ),
      mtfAgreementScore: toFiniteOrNull(signal?.mtfAgreementScore),
      mtfBias: signal?.mtfBias || scoreBreakdown.mtfBias || null,
      contextScore: toFiniteOrNull(signal?.contextScore),
      finalSignalScore: toFiniteOrNull(signal?.finalSignalScore),
    },
    preEmit: signal?.preEmit || decision?.preEmit || null,
    conversion: cloneObject(
      signal?.conversionSummary || decision?.conversion || null,
    ),
    lifecycle: {
      setupId: signal?.setupId || signal?.meta?.setupId || null,
      parentSetupId: signal?.parentSetupId || signal?.meta?.parentSetupId || null,
      lineageId: signal?.lineageId || signal?.meta?.lineageId || null,
      setupState: signal?.setupState || signal?.meta?.setupState || null,
      setupLineage: signal?.setupLineage || signal?.meta?.setupLineage || null,
      signalStage: signal?.signalStage || null,
      isProvisional: signal?.isProvisional === true,
      candleClosed: signal?.candleClosed === true,
    },
    calibration: {
      calibrationActive: signal?.calibrationActive === true,
      calibrationVersion: signal?.calibrationVersion || null,
      calibrationSource: signal?.calibrationSource || null,
      fallbackReason: signal?.fallbackReason || null,
    },
    mtf: {
      mtfAgreementScore: toFiniteOrNull(signal?.mtfAgreementScore),
      mtfBias: signal?.mtfBias || scoreBreakdown.mtfBias || null,
      mtfState: signal?.mtfState || scoreBreakdown.mtfState || null,
      mtfContributors: cloneObject(
        signal?.mtfContributors || scoreBreakdown.mtfContributors || null,
      ),
      mtfMissingIntervals:
        signal?.mtfMissingIntervals || scoreBreakdown.mtfMissingIntervals || [],
      mtfStaleIntervals:
        signal?.mtfStaleIntervals || scoreBreakdown.mtfStaleIntervals || [],
      mtfFallbackReason:
        signal?.mtfFallbackReason || scoreBreakdown.mtfFallbackReason || null,
      mtfDegraded:
        signal?.mtfDegraded === true || scoreBreakdown.mtfDegraded === true,
    },
    selector: {
      regime: signal?.regime || null,
      primaryRegime: signal?.primaryRegime || null,
      secondaryRegime: signal?.secondaryRegime || null,
      regimeWeights: cloneObject(signal?.regimeWeights),
    },
    routing: {
      accepted: signal?.accepted === true,
      rejectionReason: signal?.rejectionReason || null,
      suppressionReason:
        signal?.suppressionReason ||
        signal?.signalDecision?.routing?.suppressionReason ||
        null,
      suppressionReasons:
        signal?.suppressionReasons ||
        signal?.signalDecision?.routing?.suppressionReasons ||
        null,
      beforeRouting:
        signal?.signalDecision?.routing?.beforeRouting != null
          ? signal.signalDecision.routing.beforeRouting === true
          : null,
    },
    persistence: cloneObject(signal?.signalDecision?.persistence || signal?.persistence || null),
  };
}

function deriveConversionOutcome({ summary = {}, signal = null, patch = {} }) {
  if (patch?.finalOutcome) return patch.finalOutcome;
  if (summary?.finalOutcome) return summary.finalOutcome;

  const suppressionReason =
    patch?.finalReasonCode ||
    signal?.suppressionReason ||
    signal?.preEmit?.suppressionReason ||
    null;
  if (suppressionReason === "STYLE_REGIME_MISMATCH") {
    return "SUPPRESSED_STYLE_REGIME";
  }
  if (
    String(suppressionReason || "").startsWith("FRAGILE_REVERSAL_") ||
    suppressionReason === "RANGE_FRAGILE_REQUIRES_EXCEPTION"
  ) {
    return "SUPPRESSED_STYLE_REGIME";
  }
  if (String(suppressionReason || "").includes("MTF")) {
    return "SUPPRESSED_MTF";
  }
  if (String(suppressionReason || "").includes("CONFIDENCE")) {
    return "SUPPRESSED_CONFIDENCE";
  }
  if (signal?.decisionOutcome === "OUTRANKED") return "OUTRANKED";
  return null;
}

function hasOwnField(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeRegimeCandidate(value) {
  const raw = String(value || "").trim();
  if (!raw) return { present: false, normalized: null };
  return { present: true, normalized: normalizeRegime(raw) };
}

function resolveConversionRegimeMeta({ signal = null, patch = {}, current = {} }) {
  if (hasOwnField(patch, "regime")) {
    const patched = normalizeRegimeCandidate(patch.regime);
    if (!patched.present) {
      return {
        regime: null,
        regimeSource: "PATCH",
        regimeFallbackReason: "PATCH_EMPTY",
        hasFreshMetadata: true,
      };
    }
    return {
      regime: patched.normalized,
      regimeSource: "PATCH",
      regimeFallbackReason:
        patched.normalized === "UNKNOWN" ? "PATCH_UNKNOWN" : null,
      hasFreshMetadata: true,
    };
  }

  const snapshotRegime = normalizeRegimeCandidate(signal?.regimeSnapshot?.regime);
  const signalRegime = normalizeRegimeCandidate(signal?.regime);
  const currentRegime = normalizeRegimeCandidate(current?.regime);

  if (snapshotRegime.present && snapshotRegime.normalized !== "UNKNOWN") {
    return {
      regime: snapshotRegime.normalized,
      regimeSource: "SNAPSHOT",
      regimeFallbackReason: null,
      hasFreshMetadata: true,
    };
  }

  if (signalRegime.present && signalRegime.normalized !== "UNKNOWN") {
    return {
      regime: signalRegime.normalized,
      regimeSource: "SIGNAL_FALLBACK",
      regimeFallbackReason: snapshotRegime.present
        ? "SNAPSHOT_UNKNOWN"
        : "SNAPSHOT_UNAVAILABLE",
      hasFreshMetadata: true,
    };
  }

  if (currentRegime.present && currentRegime.normalized !== "UNKNOWN") {
    return {
      regime: currentRegime.normalized,
      regimeSource: "CURRENT_FALLBACK",
      regimeFallbackReason: snapshotRegime.present
        ? "SNAPSHOT_UNKNOWN"
        : "SNAPSHOT_UNAVAILABLE",
      hasFreshMetadata: snapshotRegime.present || signalRegime.present,
    };
  }

  if (snapshotRegime.present) {
    return {
      regime: snapshotRegime.normalized,
      regimeSource: "SNAPSHOT_UNKNOWN",
      regimeFallbackReason: "SNAPSHOT_UNKNOWN",
      hasFreshMetadata: true,
    };
  }
  if (signalRegime.present) {
    return {
      regime: signalRegime.normalized,
      regimeSource: "SIGNAL_UNKNOWN",
      regimeFallbackReason: "SIGNAL_UNKNOWN",
      hasFreshMetadata: true,
    };
  }
  if (currentRegime.present) {
    return {
      regime: currentRegime.normalized,
      regimeSource: "CURRENT_UNKNOWN",
      regimeFallbackReason: "CURRENT_UNKNOWN",
      hasFreshMetadata: false,
    };
  }
  return {
    regime: null,
    regimeSource: "UNAVAILABLE",
    regimeFallbackReason: "NO_REGIME_DATA",
    hasFreshMetadata: false,
  };
}

function resolveSignalRouteConfidence(signal = null) {
  const signalRouteConfidence =
    signal?.routeConfidence && typeof signal.routeConfidence === "object"
      ? signal.routeConfidence
      : null;
  const preEmitRouteConfidence =
    signal?.preEmit?.routeConfidence &&
    typeof signal.preEmit.routeConfidence === "object"
      ? signal.preEmit.routeConfidence
      : null;

  const actualRouteConfidence =
    signalRouteConfidence && signalRouteConfidence.estimated !== true
      ? signalRouteConfidence
      : null;
  const estimatedRouteConfidence =
    signalRouteConfidence && signalRouteConfidence.estimated === true
      ? signalRouteConfidence
      : preEmitRouteConfidence;

  return {
    actualRouteConfidence,
    estimatedRouteConfidence,
    detailedRouteConfidence:
      actualRouteConfidence || estimatedRouteConfidence || null,
  };
}

function resolveConversionRouteTelemetry({ signal = null, patch = {}, current = {} }) {
  const {
    actualRouteConfidence,
    estimatedRouteConfidence,
    detailedRouteConfidence,
  } = resolveSignalRouteConfidence(signal);

  const routeAttempted = hasOwnField(patch, "routeAttempted")
    ? patch.routeAttempted === true
    : current?.routeAttempted === true ||
      actualRouteConfidence != null ||
      signal?.option_meta != null;

  const preRouteScore = hasOwnField(patch, "preRouteScore")
    ? toFiniteOrNull(patch.preRouteScore)
    : toFiniteOrNull(detailedRouteConfidence?.preRouteScore) ??
      toFiniteOrNull(current?.preRouteScore);
  const expectedRouteAdjustment = hasOwnField(patch, "expectedRouteAdjustment")
    ? toFiniteOrNull(patch.expectedRouteAdjustment)
    : toFiniteOrNull(detailedRouteConfidence?.expectedRouteAdjustment) ??
      toFiniteOrNull(current?.expectedRouteAdjustment);

  let routedConfidence = hasOwnField(patch, "routedConfidence")
    ? toFiniteOrNull(patch.routedConfidence)
    : toFiniteOrNull(detailedRouteConfidence?.routedScore) ??
      toFiniteOrNull(current?.routedConfidence);
  if (routedConfidence == null && routeAttempted) {
    routedConfidence = toFiniteOrNull(signal?.confidence);
  }

  const derivedRouteConfidenceBasis = actualRouteConfidence
    ? "ACTUAL"
    : estimatedRouteConfidence
      ? "ESTIMATED"
      : null;

  const routeConfidenceBasis = hasOwnField(patch, "routeConfidenceBasis")
    ? patch.routeConfidenceBasis || null
    : derivedRouteConfidenceBasis ||
      current?.routeConfidenceBasis ||
      (routeAttempted ? "ACTUAL_INFERRED" : "NONE");

  return {
    routeAttempted,
    preRouteScore,
    expectedRouteAdjustment,
    routedConfidence,
    routeConfidenceBasis,
  };
}

function buildSignalConversionSummary(signal, patch = {}) {
  const current = cloneObject(
    signal?.conversionSummary || signal?.signalDecision?.conversion || null,
  ) || {
    routeAttempted: false,
    preEmitFailureReasons: [],
  };
  const regimeMeta = resolveConversionRegimeMeta({
    signal,
    patch,
    current,
  });
  const routeTelemetry = resolveConversionRouteTelemetry({
    signal,
    patch,
    current,
  });

  const regimeSource = hasOwnField(patch, "regimeSource")
    ? patch.regimeSource ?? null
    : regimeMeta.hasFreshMetadata
      ? regimeMeta.regimeSource
      : current.regimeSource ?? regimeMeta.regimeSource;
  const regimeFallbackReason = hasOwnField(patch, "regimeFallbackReason")
    ? patch.regimeFallbackReason ?? null
    : regimeMeta.hasFreshMetadata
      ? regimeMeta.regimeFallbackReason
      : current.regimeFallbackReason ?? regimeMeta.regimeFallbackReason;

  const next = {
    signalId: patch.signalId ?? signal?.signalId ?? current.signalId ?? null,
    strategyId:
      patch.strategyId ?? signal?.strategyId ?? current.strategyId ?? null,
    side: patch.side ?? signal?.side ?? current.side ?? null,
    regime: regimeMeta.regime,
    regimeSource,
    regimeFallbackReason,
    profileId:
      patch.profileId ??
      signal?.preEmit?.profileId ??
      current.profileId ??
      null,
    signalStage:
      patch.signalStage ??
      signal?.signalStage ??
      current.signalStage ??
      null,
    preEmitDecision:
      patch.preEmitDecision ??
      current.preEmitDecision ??
      (signal?.emitted === true ? "EMITTED" : null),
    preEmitFailureReasons:
      patch.preEmitFailureReasons ??
      current.preEmitFailureReasons ??
      signal?.preEmit?.suppressionReasons ??
      signal?.suppressionReasons ??
      [],
    mtfState:
      patch.mtfState ??
      signal?.mtfState ??
      signal?.scoreBreakdown?.mtfState ??
      current.mtfState ??
      null,
    marketState:
      patch.marketState ??
      signal?.marketState ??
      signal?.meta?.marketState ??
      signal?.scoreBreakdown?.marketState ??
      current.marketState ??
      null,
    styleGateDecision:
      patch.styleGateDecision ?? current.styleGateDecision ?? null,
    styleGateReasonCode:
      patch.styleGateReasonCode ?? current.styleGateReasonCode ?? null,
    styleGateExceptionType:
      patch.styleGateExceptionType ?? current.styleGateExceptionType ?? null,
    styleGateFailedChecks:
      patch.styleGateFailedChecks ??
      current.styleGateFailedChecks ??
      [],
    exceptionAllowed:
      hasOwnField(patch, "exceptionAllowed")
        ? patch.exceptionAllowed === true
        : current.exceptionAllowed ?? null,
    routeAttempted: routeTelemetry.routeAttempted,
    routeConfidenceBasis: routeTelemetry.routeConfidenceBasis,
    selectedContract:
      patch.selectedContract ??
      current.selectedContract ??
      summarizeOptionContract(signal?.option_meta),
    preRouteScore: routeTelemetry.preRouteScore,
    expectedRouteAdjustment: routeTelemetry.expectedRouteAdjustment,
    routedConfidence: routeTelemetry.routedConfidence,
    postRouteDecision:
      patch.postRouteDecision ??
      current.postRouteDecision ??
      null,
    riskFitDecision:
      patch.riskFitDecision ??
      current.riskFitDecision ??
      null,
    family:
      patch.family ??
      current.family ??
      signal?.strategyFamily ??
      signal?.family ??
      null,
    style:
      patch.style ??
      current.style ??
      signal?.strategyStyle ??
      null,
    readinessState:
      patch.readinessState ??
      current.readinessState ??
      signal?.option_meta?.premiumContext?.readinessState ??
      null,
    plannerPathUsed:
      patch.plannerPathUsed ??
      current.plannerPathUsed ??
      null,
    triggerLevelResolved:
      patch.triggerLevelResolved ??
      current.triggerLevelResolved ??
      signal?.meta?.triggerLevel ??
      null,
    anchorValueResolved:
      patch.anchorValueResolved ??
      current.anchorValueResolved ??
      signal?.meta?.anchorValue ??
      null,
    finalAuthoritativeRr:
      patch.finalAuthoritativeRr ??
      current.finalAuthoritativeRr ??
      null,
    transitionPassSupported:
      patch.transitionPassSupported ??
      current.transitionPassSupported ??
      null,
    transitionPassUsed:
      patch.transitionPassUsed ??
      current.transitionPassUsed ??
      null,
    transitionPassProfile:
      patch.transitionPassProfile ??
      current.transitionPassProfile ??
      null,
    softPassSupported:
      patch.softPassSupported ??
      current.softPassSupported ??
      null,
    softPassUsed:
      patch.softPassUsed ??
      current.softPassUsed ??
      null,
    softPassProfile:
      patch.softPassProfile ??
      current.softPassProfile ??
      null,
    legacyFallbackSupported:
      patch.legacyFallbackSupported ??
      current.legacyFallbackSupported ??
      null,
    legacyFallbackUsed:
      patch.legacyFallbackUsed ??
      current.legacyFallbackUsed ??
      null,
    finalReasonCode:
      patch.finalReasonCode ??
      current.finalReasonCode ??
      signal?.rejectionReason ??
      signal?.suppressionReason ??
      null,
  };
  next.finalOutcome = deriveConversionOutcome({
    summary: next,
    signal,
    patch,
  });
  return next;
}

function explainSignalSuppression(signal) {
  const breakdown = getSignalDecisionBreakdown(signal);
  const routing = breakdown?.routing || {};
  if (!routing.suppressionReason && !routing.rejectionReason) return null;
  return {
    signalId: breakdown.signalId,
    signalOutcomeKey: breakdown.signalOutcomeKey,
    suppressionReason: routing.suppressionReason || null,
    suppressionReasons: routing.suppressionReasons || [],
    rejectionReason: routing.rejectionReason || null,
    preEmit: breakdown.preEmit,
    lifecycle: breakdown.lifecycle,
    score: breakdown.score,
  };
}

module.exports = {
  normalizeStrategyStyle,
  normalizeRegime,
  normalizeRegimeFamily,
  isStrategyStyleAllowedForRegime,
  resolveFragileReversalPermission,
  freezeSignalRegimeSnapshot,
  buildSignalLifecycleId,
  buildSignalTiming,
  buildSignalOutcomeKey,
  resolveSignalRegimeSnapshot,
  resolvePreEmitProfile,
  buildRouteConfidenceAssessment,
  buildSignalConversionSummary,
  shouldEmitLiveCandidate,
  getSignalDecisionBreakdown,
  explainSignalSuppression,
};
