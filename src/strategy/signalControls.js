const fs = require("node:fs");
const path = require("node:path");
const { emaSeries } = require("./ema");
const {
  clamp,
  rsi,
  sessionVWAP,
  getCurrentSessionCandles,
  sessionContextSummary,
} = require("./utils");
const { resolveScoreCalibration } = require("./scoreCalibration");
const { evaluateLevelAcceptance } = require("./levelAcceptance");
const { computeDangerStack, resolveAdaptiveThresholds } = require("./dangerStack");
const {
  resolveMarketState,
  buildStrategyPermissionMatrix,
  DANGEROUS_STRATEGY_IDS,
  SOFT_PENALTY_STRATEGY_IDS,
  isFragileMarketState,
} = require("./marketStateMachine");
const {
  evaluateRetryGovernor,
  resetRetryGovernor,
  getRetryGovernorSnapshot,
} = require("./retryGovernor");
const { env } = require("../config");
const { logger } = require("../logger");

const TREND_CONTINUATION_STRATEGIES = new Set([
  "ema_cross",
  "ema_pullback",
  "breakout",
  "volume_spike",
  "bb_squeeze",
]);
const ACCEPTANCE_ACTIONABLE_LEVEL_TYPES = new Set([
  "TRIGGER",
  "RESISTANCE",
  "SUPPORT",
  "ANCHOR",
]);

function parseList(spec) {
  return String(spec || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function resolveDteDays(signal, context = {}) {
  const candidates = [
    signal?.dteDays,
    signal?.dte,
    signal?.meta?.dteDays,
    signal?.meta?.dte,
    signal?.regimeMeta?.dteDays,
    context?.regimeMeta?.dteDays,
    context?.dteDays,
  ];
  for (const candidate of candidates) {
    const n = safeNumber(candidate, null);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function continuationStrategy(signal) {
  const strategyId = String(signal?.strategyId || "").trim();
  const style = String(signal?.strategyStyle || "").toUpperCase();
  if (TREND_CONTINUATION_STRATEGIES.has(strategyId)) return true;
  return style === "TREND" || style === "OPEN";
}

function resolveProductAdaptation({
  marketState,
  oneDte,
  dangerStack,
  levelAcceptance,
}) {
  const state = String(marketState || "").toUpperCase();
  const danger = Number(dangerStack?.dangerStackScore ?? 0);
  const repeatedRejection = levelAcceptance?.repeatedRejectionDetected === true;
  let productRiskTier = "LOW";
  let productRecommendation = "ALLOW";
  let suggestedDtePolicy = "NEAREST_OK";
  let riskSizeMultiplierRecommendation = 1;

  if (state === "TREND_COMPRESSED") {
    productRiskTier = "MEDIUM";
    productRecommendation = oneDte ? "PREFER_FARTHER_DTE" : "ALLOW";
    suggestedDtePolicy = "PREFER_2_TO_5_DTE";
    riskSizeMultiplierRecommendation = 0.6;
  } else if (state === "BREAKOUT_WATCH") {
    productRiskTier = "MEDIUM";
    productRecommendation = oneDte ? "PREFER_FARTHER_DTE" : "ALLOW";
    suggestedDtePolicy = "PREFER_2_TO_5_DTE";
    riskSizeMultiplierRecommendation = 0.45;
  } else if (state === "FAILED_BREAKOUT" || state === "RANGE_CHOP") {
    productRiskTier = "HIGH";
    productRecommendation = oneDte ? "BLOCK" : "PREFER_FARTHER_DTE";
    suggestedDtePolicy = "PREFER_3_TO_7_DTE";
    riskSizeMultiplierRecommendation = 0.3;
  } else if (state === "TRAP_RISK_HIGH" || state === "NO_TRADE") {
    productRiskTier = "EXTREME";
    productRecommendation = "BLOCK";
    suggestedDtePolicy = "NO_TRADE";
    riskSizeMultiplierRecommendation = 0;
  }

  if (danger >= 80) {
    productRiskTier = "EXTREME";
    productRecommendation = "BLOCK";
    suggestedDtePolicy = "NO_TRADE";
    riskSizeMultiplierRecommendation = 0;
  } else if (danger >= 62 && productRiskTier === "LOW") {
    productRiskTier = "MEDIUM";
    riskSizeMultiplierRecommendation = Math.min(
      riskSizeMultiplierRecommendation,
      0.65,
    );
  }

  let optionFragilityScore = 0;
  if (oneDte) optionFragilityScore += 42;
  if (danger > 0) optionFragilityScore += Math.min(40, danger * 0.35);
  if (repeatedRejection) optionFragilityScore += 14;
  optionFragilityScore = clamp(optionFragilityScore, 0, 100);

  return {
    productRiskTier,
    productRecommendation,
    suggestedDtePolicy,
    riskSizeMultiplierRecommendation,
    optionFragilityScore,
    allowFragileContinuation:
      productRecommendation === "ALLOW" || productRecommendation === "PREFER_FARTHER_DTE",
  };
}

const STRATEGY_PROFILES = {
  ema_cross: { raw: { floor: 55, ceil: 100, shape: 1.05 }, bias: 0, coolingBars: 1, expiryBars: 6 },
  ema_pullback: { raw: { floor: 55, ceil: 90, shape: 0.95 }, bias: 1, coolingBars: 2, expiryBars: 8 },
  breakout: { raw: { floor: 55, ceil: 92, shape: 0.95 }, bias: 1, coolingBars: 2, expiryBars: 12 },
  vwap_reclaim: { raw: { floor: 52, ceil: 90, shape: 0.9 }, bias: 1, coolingBars: 2, expiryBars: 8 },
  orb: { raw: { floor: 70, ceil: 95, shape: 0.9 }, bias: 3, coolingBars: 3, expiryBars: 10 },
  bb_squeeze: { raw: { floor: 65, ceil: 95, shape: 0.95 }, bias: 0, coolingBars: 2, expiryBars: 10 },
  volume_spike: { raw: { floor: 65, ceil: 95, shape: 0.95 }, bias: 0, coolingBars: 1, expiryBars: 5 },
  fakeout: { raw: { floor: 62, ceil: 92, shape: 1.0 }, bias: 0, coolingBars: 2, expiryBars: 8 },
  rsi_fade: { raw: { floor: 60, ceil: 90, shape: 1.0 }, bias: 0, coolingBars: 2, expiryBars: 8 },
  wick_reversal: { raw: { floor: 60, ceil: 90, shape: 1.0 }, bias: 0, coolingBars: 2, expiryBars: 8 },
};

const ACTIVE_SETUP_STATES = new Set([
  "idle",
  "forming",
  "armed",
  "triggered",
  "confirmed",
  "fired",
  "cooling",
  "reset-ready",
  "seen",
]);

const setupRegistry = new Map();
const intervalSnapshots = new Map();
const SIGNAL_STATE_VERSION = 1;
const signalLayerPersistenceState = {
  persistenceEnabled: false,
  persistenceMode: "memory",
  persistencePath: null,
  restoreSource: "memory:ephemeral",
  restoredAt: null,
  lastFlushAt: null,
  fallbackReason: null,
  restoredSetupCount: 0,
  restoredSnapshotCount: 0,
  prunedSetupCount: 0,
  prunedSnapshotCount: 0,
};
let persistenceInitialized = false;

function clonePlain(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function statePersistenceConfig() {
  const enabled = String(env.SIGNAL_STATE_PERSIST || "false") === "true";
  const persistencePath = path.resolve(
    process.env.SIGNAL_STATE_PERSIST_PATH ||
      env.SIGNAL_STATE_PERSIST_PATH ||
      path.join(process.cwd(), "artifacts", "signal-layer-state.json"),
  );
  return {
    enabled,
    persistencePath,
    ttlMs: Math.max(60_000, Number(env.SIGNAL_STATE_PERSIST_TTL_MIN ?? 180) * 60_000),
    maxSetups: Math.max(50, Number(env.SIGNAL_STATE_PERSIST_MAX_SETUPS ?? 2500)),
  };
}

function updatePersistenceState(patch = {}) {
  Object.assign(signalLayerPersistenceState, patch);
}

function persistedStatePayload(nowTs = Date.now()) {
  return {
    version: SIGNAL_STATE_VERSION,
    savedAt: new Date(Number(nowTs) || Date.now()).toISOString(),
    setupRegistry: Array.from(setupRegistry.entries()).map(([key, value]) => ({
      key,
      ...clonePlain(value),
    })),
    intervalSnapshots: Array.from(intervalSnapshots.entries()).map(([key, value]) => ({
      key,
      ...clonePlain(value),
    })),
  };
}

function persistSignalLayerState(nowTs = Date.now()) {
  const cfg = statePersistenceConfig();
  if (!cfg.enabled) {
    updatePersistenceState({
      persistenceEnabled: false,
      persistenceMode: "memory",
      persistencePath: cfg.persistencePath,
      restoreSource: "memory:ephemeral",
      fallbackReason: null,
    });
    return;
  }

  try {
    const payload = persistedStatePayload(nowTs);
    fs.mkdirSync(path.dirname(cfg.persistencePath), { recursive: true });
    const tmpPath = `${cfg.persistencePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, cfg.persistencePath);
    updatePersistenceState({
      persistenceEnabled: true,
      persistenceMode: "file",
      persistencePath: cfg.persistencePath,
      lastFlushAt: new Date(Number(nowTs) || Date.now()).toISOString(),
      fallbackReason: null,
    });
  } catch (error) {
    updatePersistenceState({
      persistenceEnabled: true,
      persistenceMode: "memory_fallback",
      persistencePath: cfg.persistencePath,
      fallbackReason: `STATE_PERSIST_FAILED:${String(error?.code || error?.message || error).slice(0, 160)}`,
    });
    logger.warn(
      {
        err: error?.message || String(error),
        persistencePath: cfg.persistencePath,
      },
      "[signal] state persistence disabled; continuing in memory-only mode",
    );
  }
}

function restorePersistedSignalLayerState() {
  persistenceInitialized = true;
  const cfg = statePersistenceConfig();
  if (!cfg.enabled) {
    updatePersistenceState({
      persistenceEnabled: false,
      persistenceMode: "memory",
      persistencePath: cfg.persistencePath,
      restoreSource: "memory:ephemeral",
      restoredAt: null,
      fallbackReason: null,
      restoredSetupCount: 0,
      restoredSnapshotCount: 0,
      prunedSetupCount: 0,
      prunedSnapshotCount: 0,
    });
    return;
  }

  try {
    if (!fs.existsSync(cfg.persistencePath)) {
      updatePersistenceState({
        persistenceEnabled: true,
        persistenceMode: "file",
        persistencePath: cfg.persistencePath,
        restoreSource: "file:empty",
        restoredAt: new Date().toISOString(),
        fallbackReason: null,
        restoredSetupCount: 0,
        restoredSnapshotCount: 0,
        prunedSetupCount: 0,
        prunedSnapshotCount: 0,
      });
      return;
    }

    const raw = JSON.parse(fs.readFileSync(cfg.persistencePath, "utf8"));
    const nextSetupRegistry = Array.isArray(raw?.setupRegistry) ? raw.setupRegistry : [];
    const nextSnapshots = Array.isArray(raw?.intervalSnapshots) ? raw.intervalSnapshots : [];

    setupRegistry.clear();
    intervalSnapshots.clear();
    for (const row of nextSetupRegistry) {
      if (!row || typeof row !== "object" || !row.key) continue;
      const { key, ...value } = row;
      setupRegistry.set(String(key), value);
    }
    for (const row of nextSnapshots) {
      if (!row || typeof row !== "object" || !row.key) continue;
      const { key, ...value } = row;
      intervalSnapshots.set(String(key), value);
    }
    const savedAtTs = new Date(raw?.savedAt).getTime();
    cleanupStateStores(Number.isFinite(savedAtTs) ? savedAtTs : Date.now());
    const prunedSetupCount = Math.max(0, nextSetupRegistry.length - setupRegistry.size);
    const prunedSnapshotCount = Math.max(0, nextSnapshots.length - intervalSnapshots.size);

    if (setupRegistry.size > cfg.maxSetups) {
      const staleKeys = Array.from(setupRegistry.entries())
        .sort((a, b) => Number(a[1]?.lastSeenTs ?? 0) - Number(b[1]?.lastSeenTs ?? 0))
        .slice(0, setupRegistry.size - cfg.maxSetups)
        .map(([key]) => key);
      for (const key of staleKeys) setupRegistry.delete(key);
    }

    updatePersistenceState({
      persistenceEnabled: true,
      persistenceMode: "file",
      persistencePath: cfg.persistencePath,
      restoreSource: `file:${path.basename(cfg.persistencePath)}`,
      restoredAt: new Date().toISOString(),
      fallbackReason: null,
      restoredSetupCount: setupRegistry.size,
      restoredSnapshotCount: intervalSnapshots.size,
      prunedSetupCount,
      prunedSnapshotCount,
    });
  } catch (error) {
    setupRegistry.clear();
    intervalSnapshots.clear();
    updatePersistenceState({
      persistenceEnabled: true,
      persistenceMode: "memory_fallback",
      persistencePath: cfg.persistencePath,
      restoreSource: "memory:fallback_after_restore_error",
      restoredAt: new Date().toISOString(),
      fallbackReason: `STATE_RESTORE_FAILED:${String(error?.code || error?.message || error).slice(0, 160)}`,
      restoredSetupCount: 0,
      restoredSnapshotCount: 0,
      prunedSetupCount: 0,
      prunedSnapshotCount: 0,
    });
    logger.warn(
      {
        err: error?.message || String(error),
        persistencePath: cfg.persistencePath,
      },
      "[signal] state restore failed; continuing in memory-only mode",
    );
  }
}

function ensureSignalLayerStateReady() {
  if (persistenceInitialized) return;
  restorePersistedSignalLayerState();
  persistenceInitialized = true;
}

function candleTs(value) {
  const ts = value?.ts ? new Date(value.ts).getTime() : new Date(value).getTime();
  return Number.isFinite(ts) ? ts : NaN;
}

function strategyProfile(strategyId) {
  return STRATEGY_PROFILES[String(strategyId || "")] || {
    raw: { floor: 55, ceil: 95, shape: 1.0 },
    bias: 0,
    coolingBars: 1,
    expiryBars: 6,
  };
}

function normalizeWithProfile(rawConfidence, rawProfile) {
  const raw = clamp(Number(rawConfidence ?? 0), 0, 100);
  const profile = rawProfile || {};
  const floor = Number(profile.floor);
  const ceil = Number(profile.ceil);
  const shape = Number(profile.shape ?? 1.0);
  if (!Number.isFinite(floor) || !Number.isFinite(ceil) || ceil <= floor) return raw;
  const pct = (clamp(raw, floor, ceil) - floor) / (ceil - floor);
  const curved = Math.pow(clamp(pct, 0, 1), Number.isFinite(shape) ? shape : 1);
  return clamp(60 + curved * 30, 0, 100);
}

function normalizeStrategyConfidence(strategyId, rawConfidence, strategyFamily) {
  const calibration = resolveScoreCalibration(strategyId, strategyFamily);
  return normalizeWithProfile(rawConfidence, calibration.raw || strategyProfile(strategyId).raw);
}

function signalStageFor(candidate, context = {}) {
  if (candidate?.signalStage) return String(candidate.signalStage);
  return context.stage === "tick" ? "tick_preview" : "bar_close_confirmed";
}

function strategySessionContext(context = {}) {
  if (context.sessionContext) return context.sessionContext;
  return sessionContextSummary(context.candles || [], {
    endTs: context.last?.ts || context.last,
  });
}

function bucketRegimeAlignment(strategyStyle, regime, sessionPhase) {
  const style = String(strategyStyle || "UNKNOWN").toUpperCase();
  const phase = String(sessionPhase || "").toUpperCase();
  const bucket = String(regime || "UNKNOWN").toUpperCase();
  if (bucket === "OPEN") {
    if (style === "OPEN") return phase === "OPEN_INIT" ? 96 : 92;
    if (style === "TREND") return phase === "OPEN_EXPANSION" ? 82 : 72;
    if (style === "RANGE") return 46;
  }
  if (bucket === "TREND") {
    if (style === "TREND") return 92;
    if (style === "OPEN") return 68;
    if (style === "RANGE") return 42;
  }
  if (bucket === "TREND_COMPRESSED") {
    if (style === "TREND") return 74;
    if (style === "RANGE") return 62;
    if (style === "OPEN") return 60;
  }

  if (bucket === "BREAKOUT_WATCH") {
    if (style === "TREND") return 66;
    if (style === "OPEN") return 55;
    if (style === "RANGE") return 64;
  }
  if (bucket === "FAILED_BREAKOUT") {
    if (style === "TREND") return 48;
    if (style === "OPEN") return 44;
    if (style === "RANGE") return 69;
  }
  if (bucket === "RANGE_CHOP") {
    if (style === "RANGE") return 88;
    if (style === "TREND") return 42;
    if (style === "OPEN") return 46;
  }
  if (bucket === "TRAP_RISK_HIGH") {
    if (style === "TREND") return 35;
    if (style === "OPEN") return 30;
    if (style === "RANGE") return 48;
  }
  if (bucket === "NO_TRADE") {
    return 15;
  }
  if (bucket === "RANGE") {
    if (style === "RANGE") return phase === "MIDDAY_COMPRESSION" ? 95 : 90;
    if (style === "TREND") return 44;
    if (style === "OPEN") return 48;
  }
  if (phase === "LATE_SESSION") {
    if (style === "RANGE") return 74;
    if (style === "TREND") return 68;
  }
  return 60;
}

function scoreRegimeAlignment(strategyStyle, regime, sessionPhase, regimeWeights) {
  const weights = regimeWeights && typeof regimeWeights === "object" ? regimeWeights : null;
  if (!weights || !Object.keys(weights).length) {
    return bucketRegimeAlignment(strategyStyle, regime, sessionPhase);
  }

  let totalWeight = 0;
  let weighted = 0;
  for (const [bucket, weightValue] of Object.entries(weights)) {
    const weight = Number(weightValue);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;
    weighted += bucketRegimeAlignment(strategyStyle, bucket, sessionPhase) * weight;
  }
  if (totalWeight <= 0) {
    return bucketRegimeAlignment(strategyStyle, regime, sessionPhase);
  }
  return clamp(weighted / totalWeight, 0, 100);
}

function inferChopPenalty(candidate, context) {
  const regime = String(
    context?.regimeMeta?.marketState || context?.regime || "",
  ).toUpperCase();
  const style = String(candidate?.strategyStyle || "").toUpperCase();
  if (regime === "RANGE" && style === "TREND") return 18;
  if (regime === "TREND" && style === "RANGE") return 15;
  if (regime === "TREND_COMPRESSED" && style === "RANGE") return 8;
  if (regime === "BREAKOUT_WATCH" && style === "TREND") return 15;
  if (regime === "FAILED_BREAKOUT" && style === "TREND") return 20;
  if (regime === "TRAP_RISK_HIGH" && style === "TREND") return 24;
  if (regime === "NO_TRADE") return 28;
  return 4;
}

function inferGapPenalty(candidate, context, sessionContext) {
  const gap = sessionContext?.gapContext;
  if (!gap || !gap.direction || gap.direction === "UNKNOWN") return 0;
  const style = String(candidate?.strategyStyle || "").toUpperCase();
  const phase = String(candidate?.meta?.sessionPhase || context?.regimeMeta?.sessionPhase || "").toUpperCase();
  if (style === "RANGE" && phase.startsWith("OPEN") && gap.sizeBucket === "LARGE" && gap.direction !== "FLAT") return 12;
  if (style === "TREND" && gap.sizeBucket === "LARGE" && gap.direction !== "FLAT") return 2;
  return 0;
}

function mtfSnapshotKey(token, intervalMin) {
  if (!Number.isFinite(token) || !Number.isFinite(intervalMin) || intervalMin <= 0) return null;
  return `${token}:${intervalMin}`;
}

function configuredSignalIntervals() {
  return String(env.SIGNAL_INTERVALS || "1")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

function isActiveSetupState(setupState) {
  return ACTIVE_SETUP_STATES.has(String(setupState || "").toLowerCase());
}

function setupStateWeight(setupState) {
  switch (String(setupState || "").toLowerCase()) {
    case "confirmed":
    case "fired":
      return 1.0;
    case "triggered":
      return 0.92;
    case "armed":
      return 0.72;
    case "forming":
      return 0.58;
    case "cooling":
      return 0.42;
    case "seen":
    case "reset-ready":
      return 0.62;
    default:
      return 0;
  }
}

function stageWeight(signalStage) {
  return String(signalStage || "") === "tick_preview" ? 0.55 : 1.0;
}

function recencyWeight(state, currentTs) {
  const seenTs = Number(state?.lastSeenTs ?? state?.ts);
  const intervalMin = Math.max(1, Number(state?.intervalMin ?? 1));
  if (!Number.isFinite(seenTs) || !Number.isFinite(currentTs)) return 0.4;
  const ageMs = Math.max(0, currentTs - seenTs);
  const horizonMs = Math.max(intervalMin * 12 * 60_000, Number(state?.ttlMs ?? 0) * 0.25);
  if (horizonMs <= 0) return 0.4;
  return clamp(1 - ageMs / horizonMs, 0.2, 1.0);
}

function mtfRecencyMeta(state, currentTs) {
  const seenTs = Number(state?.lastSeenTs ?? state?.ts);
  const intervalMin = Math.max(1, Number(state?.intervalMin ?? 1));
  const staleAfterMs = Math.max(intervalMin * 3 * 60_000, 180_000);
  if (!Number.isFinite(seenTs) || !Number.isFinite(currentTs)) {
    return {
      ageMs: null,
      ageMin: null,
      staleAfterMs,
      staleAfterMin: Math.round(staleAfterMs / 60_000),
      stale: true,
    };
  }
  const ageMs = Math.max(0, currentTs - seenTs);
  return {
    ageMs,
    ageMin: Number((ageMs / 60_000).toFixed(2)),
    staleAfterMs,
    staleAfterMin: Math.round(staleAfterMs / 60_000),
    stale: ageMs > staleAfterMs,
  };
}

function collectMtfStates(token, currentIntervalMin) {
  const byInterval = new Map();

  const consider = (state, sourceKind) => {
    const intervalMin = Number(state?.intervalMin ?? 0);
    if (
      Number(state?.token) !== token ||
      !Number.isFinite(intervalMin) ||
      intervalMin <= 0 ||
      intervalMin === currentIntervalMin
    ) {
      return;
    }
    const existing = byInterval.get(intervalMin);
    const stateTs = Number(state?.lastSeenTs ?? state?.ts ?? 0);
    const existingTs = Number(existing?.lastSeenTs ?? existing?.ts ?? 0);
    const sourcePriority = sourceKind === "setup_registry" ? 2 : 1;
    const existingPriority = Number(existing?._mtfSourcePriority ?? 0);
    if (
      !existing ||
      stateTs > existingTs ||
      (stateTs === existingTs && sourcePriority > existingPriority)
    ) {
      byInterval.set(intervalMin, {
        ...state,
        _mtfSourceKind: sourceKind,
        _mtfSourcePriority: sourcePriority,
      });
    }
  };

  for (const state of setupRegistry.values()) {
    if (!isActiveSetupState(state?.setupState || state?.status)) continue;
    consider(state, "setup_registry");
  }
  for (const snapshot of intervalSnapshots.values()) {
    consider(snapshot, "interval_snapshot");
  }

  return byInterval;
}

function stateContribution(signal, state, currentTs, options = {}) {
  const intervalMin = Number(state?.intervalMin ?? 0);
  if (!Number.isFinite(intervalMin) || intervalMin <= 0) return null;
  const style = String(signal?.strategyStyle || "").toUpperCase();
  const stateStyle = String(state?.strategyStyle || "").toUpperCase();
  const sideMatch = state.side === signal.side;
  const intervalWeight = intervalMin > Number(signal?.intervalMin ?? 0) ? 1.0 : 0.65;
  const confidenceWeight = clamp(Number(state?.finalSignalScore ?? state?.normalizedConfidence ?? 70) / 100, 0.45, 1.0);
  const compressionActive = options.compressionActive === true;
  const recency = mtfRecencyMeta(state, currentTs);
  let weight = intervalWeight * stageWeight(state.signalStage) * setupStateWeight(state.setupState || state.status) * recencyWeight(state, currentTs) * confidenceWeight;
  if (recency.stale) {
    weight *= compressionActive && sideMatch ? 0.7 : 0.55;
  }
  if (weight <= 0) return null;
  let delta = sideMatch ? 12 : -13;
  if (compressionActive && sideMatch && (style === "TREND" || style === "OPEN") && stateStyle === "TREND") {
    delta += 1.5;
  }
  if (style && style === stateStyle) delta += sideMatch ? 2 : -2;
  if (style === "RANGE" && stateStyle === "TREND") delta += sideMatch ? -1 : -4;
  const contribution = delta * weight;
  return {
    intervalMin,
    side: state.side,
    contribution: Number(contribution.toFixed(2)),
    signalStage: state.signalStage,
    setupState: state.setupState || state.status || null,
    relationship: sideMatch ? "ALIGNED" : "CONFLICT",
    sourceKind: state?._mtfSourceKind || null,
    stale: recency.stale,
    ageMin: recency.ageMin,
    staleAfterMin: recency.staleAfterMin,
  };
}

function readMtfAgreement(signal, context = {}) {
  ensureSignalLayerStateReady();
  const token = Number(context.instrument_token);
  const intervalMin = Number(context.intervalMin ?? 0);
  const currentTs = candleTs(context.last?.ts || context.last);
  const style = String(signal?.strategyStyle || "").toUpperCase();
  const marketState = String(
    signal?.marketState ||
      signal?.meta?.marketState ||
      context?.regimeMeta?.marketState ||
      signal?.regimeSnapshot?.marketState ||
      "",
  )
    .trim()
    .toUpperCase();
  const strictMtfEnabled =
    String(env.COMPRESSED_STRICT_MTF_ENABLED ?? "true") === "true";
  const strictFragileState =
    strictMtfEnabled &&
    (marketState === "TREND_COMPRESSED" ||
      marketState === "BREAKOUT_WATCH" ||
      marketState === "FAILED_BREAKOUT" ||
      marketState === "TRAP_RISK_HIGH");
  const compressionActive =
    signal?.regimeSnapshot?.compressionActive === true ||
    strictFragileState ||
    String(signal?.regime || signal?.primaryRegime || context?.regime || "").toUpperCase() ===
      "TREND_COMPRESSED";
  if (!Number.isFinite(token) || !Number.isFinite(intervalMin) || !Number.isFinite(currentTs)) {
    return {
      mtfAgreementScore: 60,
      mtfBias: "NEUTRAL",
      mtfState: "UNAVAILABLE",
      mtfContributors: [],
      mtfExpectedIntervals: [],
      mtfUsedIntervals: [],
      mtfMissingIntervals: [],
      mtfStaleIntervals: [],
      mtfFallbackReason: "INVALID_CONTEXT",
      mtfDegraded: true,
      mtfPenalty: 0,
      mtfStrictnessPenalty: 0,
      mtfStrictnessState: strictFragileState ? marketState : null,
      mtfInputs: null,
    };
  }

  const expectedIntervals = configuredSignalIntervals().filter((value) => value > intervalMin);
  const availableStates = collectMtfStates(token, intervalMin);
  const contributors = [];
  const staleIntervals = [];
  const usedIntervals = [];
  for (const [otherIntervalMin, state] of availableStates.entries()) {
    if (Number.isFinite(state?.expiryAtTs) && currentTs > Number(state.expiryAtTs)) continue;
    const contribution = stateContribution(signal, state, currentTs, {
      compressionActive,
    });
    if (!contribution) continue;
    usedIntervals.push(otherIntervalMin);
    if (contribution.stale) staleIntervals.push(otherIntervalMin);
    contributors.push(contribution);
  }

  const missingIntervals = expectedIntervals.filter(
    (otherIntervalMin) => !usedIntervals.includes(otherIntervalMin),
  );
  const freshContributors = contributors.filter((item) => item.stale !== true);
  const conflictFresh = freshContributors.filter(
    (item) => item.relationship === "CONFLICT",
  );
  const alignedFresh = freshContributors.filter(
    (item) => item.relationship === "ALIGNED",
  );

  let penalty = 0;
  const strictMissingPenalty = Math.max(
    0,
    Number(env.MISSING_HTF_EXTRA_PENALTY ?? 6),
  );
  const strictStalePenalty = Math.max(
    0,
    Number(env.STALE_HTF_EXTRA_PENALTY ?? 4),
  );
  const strictPartialPenalty = Math.max(
    0,
    Number(env.PARTIAL_ALIGN_EXTRA_PENALTY ?? 4),
  );
  if (missingIntervals.length > 0) {
    const perInterval = strictFragileState && style !== "RANGE" ? 6 : 4;
    const maxPenalty = strictFragileState ? 20 : 12;
    penalty += Math.min(maxPenalty, missingIntervals.length * perInterval);
    if (strictFragileState) penalty += strictMissingPenalty;
  }
  if (staleIntervals.length > 0) {
    const perInterval = strictFragileState && style !== "RANGE" ? 5 : 3;
    const maxPenalty = strictFragileState ? 18 : 10;
    penalty += Math.min(maxPenalty, staleIntervals.length * perInterval);
    if (strictFragileState) penalty += strictStalePenalty;
  }

  if (!contributors.length) {
    const fallbackReason =
      expectedIntervals.length === 0
        ? "NO_HIGHER_INTERVALS_CONFIGURED"
        : missingIntervals.length > 0
          ? "HTF_CONTEXT_MISSING"
          : "HTF_CONTEXT_UNAVAILABLE";
    const degradedScore = clamp(60 - penalty, 48, 62);
    return {
      mtfAgreementScore: degradedScore,
      mtfBias: "NEUTRAL",
      mtfState:
        expectedIntervals.length === 0
          ? "UNAVAILABLE"
          : missingIntervals.length > 0
            ? "MISSING"
            : "DEGRADED_NEUTRAL",
      mtfContributors: [],
      mtfExpectedIntervals: expectedIntervals,
      mtfUsedIntervals: [],
      mtfMissingIntervals: missingIntervals,
      mtfStaleIntervals: staleIntervals,
      mtfFallbackReason: fallbackReason,
      mtfDegraded: true,
      mtfPenalty: penalty,
      mtfStrictnessPenalty: penalty,
      mtfStrictnessState: strictFragileState ? marketState : null,
      mtfInputs: {
        expectedIntervals,
        usedIntervals: [],
        missingIntervals,
        staleIntervals,
        compressionActive,
      },
    };
  }
  const total = contributors.reduce((sum, item) => sum + Number(item.contribution ?? 0), 0);
  let mtfAgreementScore = clamp(60 + total - penalty, conflictFresh.length > 0 ? 20 : 44, 98);
  const mtfBias = total > 3 ? "ALIGNED" : total < -3 ? "CONFLICT" : "NEUTRAL";
  let strictnessPenalty = penalty;
  if (
    strictFragileState &&
    style !== "RANGE" &&
    mtfBias === "NEUTRAL" &&
    Number(mtfAgreementScore) < 66
  ) {
    strictnessPenalty += strictPartialPenalty;
    mtfAgreementScore = clamp(
      Number(mtfAgreementScore) - strictPartialPenalty,
      conflictFresh.length > 0 ? 20 : 38,
      98,
    );
  }
  let mtfState = "NEUTRAL";
  if (conflictFresh.length > 0 && total < -3) {
    mtfState = "DISAGREEMENT";
  } else if (alignedFresh.length > 0 && (missingIntervals.length > 0 || staleIntervals.length > 0)) {
    mtfState = "DEGRADED_ALIGNMENT";
  } else if (alignedFresh.length > 0 && total > 3) {
    mtfState = "ALIGNED";
  } else if (staleIntervals.length > 0 && freshContributors.length === 0) {
    mtfState = "STALE";
  } else if (missingIntervals.length > 0 && alignedFresh.length === 0 && conflictFresh.length === 0) {
    mtfState = "MISSING";
  }
  const fallbackReason =
    conflictFresh.length > 0 && total < -3
      ? null
      : missingIntervals.length > 0 && staleIntervals.length > 0
        ? "HTF_CONTEXT_DEGRADED"
        : staleIntervals.length > 0
          ? "HTF_CONTEXT_STALE"
          : missingIntervals.length > 0
            ? "HTF_CONTEXT_MISSING"
            : null;
  contributors.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    mtfAgreementScore,
    mtfBias,
    mtfState,
    mtfContributors: contributors.slice(0, 4),
    mtfExpectedIntervals: expectedIntervals,
    mtfUsedIntervals: usedIntervals.sort((a, b) => a - b),
    mtfMissingIntervals: missingIntervals,
    mtfStaleIntervals: staleIntervals,
    mtfFallbackReason: fallbackReason,
    mtfDegraded: missingIntervals.length > 0 || staleIntervals.length > 0,
    mtfPenalty: penalty,
    mtfStrictnessPenalty: strictnessPenalty,
    mtfStrictnessState: strictFragileState ? marketState : null,
    mtfInputs: {
      expectedIntervals,
      usedIntervals: usedIntervals.sort((a, b) => a - b),
      missingIntervals,
      staleIntervals,
      compressionActive,
    },
  };
}

function weightedScore(values, weights) {
  let totalWeight = 0;
  let weighted = 0;
  for (const [key, value] of Object.entries(values || {})) {
    const weight = Number(weights?.[key] ?? 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;
    weighted += Number(value ?? 0) * weight;
  }
  if (totalWeight <= 0) return 0;
  return clamp(weighted / totalWeight, 0, 100);
}

function deriveStageScore(signal) {
  const meta = signal?.meta || {};
  const explicitStageScore = Number(signal?.stageScore ?? meta.stageScore);
  if (Number.isFinite(explicitStageScore)) {
    return clamp(explicitStageScore, 0, 100);
  }

  const setupState = String(
    signal?.setupState ||
      meta.setupState ||
      (signal?.actionable === true ? "triggered" : signal?.isProvisional ? "armed" : "forming"),
  )
    .trim()
    .toLowerCase();
  const provisionalStageScoreByState = {
    idle: 52,
    forming: 58,
    armed: 68,
    triggered: 78,
    confirmed: 84,
    fired: 84,
    cooling: 44,
    "reset-ready": 54,
    seen: 62,
  };
  if (signal?.isProvisional === true) {
    const stageScore = provisionalStageScoreByState[setupState];
    return clamp(Number.isFinite(stageScore) ? stageScore : 66, 0, 100);
  }
  const confirmedStageScoreByState = {
    idle: 58,
    forming: 72,
    armed: 78,
    triggered: 92,
    confirmed: 96,
    fired: 98,
    cooling: 46,
    "reset-ready": 56,
    seen: 64,
  };
  const stageScore = confirmedStageScoreByState[setupState];
  return clamp(Number.isFinite(stageScore) ? stageScore : 90, 0, 100);
}

function buildScoreBreakdown(signal, context = {}) {
  const meta = signal?.meta || {};
  const sessionContext = strategySessionContext(context);
  const rawConfidenceOriginal = clamp(Number(signal?.confidence ?? 0), 0, 100);
  const calibration = resolveScoreCalibration(
    signal?.strategyId,
    signal?.strategyFamily,
    context.intervalMin,
  );
  let normalizedConfidence = normalizeWithProfile(
    rawConfidenceOriginal,
    calibration.raw || strategyProfile(signal?.strategyId).raw,
  );
  const patternQuality = clamp(Number(meta.patternQuality ?? rawConfidenceOriginal), 0, 100);
  const volumeQuality = clamp(Number(meta.volumeQuality ?? 55), 0, 100);
  const anchorQuality = clamp(Number(meta.anchorQuality ?? 60), 0, 100);
  const structureQuality = clamp(
    Number(meta.structureQuality ?? meta.patternQuality ?? rawConfidenceOriginal),
    0,
    100,
  );
  const freshness = clamp(Number(meta.setupFreshness ?? meta.freshness ?? 80), 0, 100);
  const rawRegime = String(
    context?.regime || meta?.primaryRegime || signal?.regime || "",
  )
    .trim()
    .toUpperCase();
  const primaryRegime = String(
    meta?.primaryRegime || context?.regimeMeta?.primaryRegime || rawRegime || "UNKNOWN",
  )
    .trim()
    .toUpperCase();
  const secondaryRegime = String(
    meta?.secondaryRegime || context?.regimeMeta?.secondaryRegime || "",
  )
    .trim()
    .toUpperCase();
  const regimeWeights =
    meta?.regimeWeightsSnapshot || context?.regimeMeta?.regimeWeights || null;
  const dteDays = resolveDteDays(signal, context);
  const oneDte = hasFiniteNumber(dteDays) && Number(dteDays) <= 1;

  const baseStateResolution = resolveMarketState({
    regime: rawRegime,
    primaryRegime,
    secondaryRegime,
    regimeWeights,
    dteDays,
    env,
  });
  const baseMarketState = baseStateResolution.marketState;

  const levelAcceptance = evaluateLevelAcceptance({
    candles: context?.candles || [],
    signal,
    context,
    env,
  });

  const mtf = readMtfAgreement(
    {
      ...signal,
      marketState: baseMarketState,
      meta: {
        ...(signal?.meta || {}),
        marketState: baseMarketState,
      },
    },
    {
      ...context,
      regimeMeta: {
        ...(context?.regimeMeta || {}),
        marketState: baseMarketState,
      },
    },
  );

  const retryGovernor = evaluateRetryGovernor({
    candidate: signal,
    context,
    levelAcceptance,
    marketState: baseMarketState,
    env,
  });

  const dangerStack = computeDangerStack({
    marketState: baseMarketState,
    levelAcceptance,
    mtf,
    dteDays,
    directionalPersistence:
      safeNumber(context?.regimeMeta?.directionalPersistence, null) ||
      safeNumber(meta?.directionalPersistence, null),
    retryGovernor,
    env,
  });

  const stateResolution = resolveMarketState({
    regime: rawRegime,
    primaryRegime,
    secondaryRegime,
    regimeWeights,
    levelAcceptance,
    dangerStack,
    retryGovernor,
    dteDays,
    env,
  });
  const marketState = stateResolution.marketState;
  const marketStateFamily = stateResolution.marketStateFamily;
  const uglyState = isFragileMarketState(marketState);
  const continuation = continuationStrategy(signal);
  const strategyIdNorm = String(signal?.strategyId || "").trim();
  const dangerousContinuation =
    DANGEROUS_STRATEGY_IDS.has(strategyIdNorm) ||
    SOFT_PENALTY_STRATEGY_IDS.has(strategyIdNorm) ||
    strategyIdNorm === "ema_pullback";
  const keyLevelTypeNorm = String(levelAcceptance?.keyLevelType || "")
    .trim()
    .toUpperCase();
  const acceptanceActionableLevel =
    ACCEPTANCE_ACTIONABLE_LEVEL_TYPES.has(keyLevelTypeNorm);

  const productAdaptation = resolveProductAdaptation({
    marketState,
    oneDte,
    dangerStack,
    levelAcceptance,
  });

  const thresholds = resolveAdaptiveThresholds({
    baseMinConfidence: Number(env.MIN_SIGNAL_CONFIDENCE ?? 70),
    baseMinMtfAgreement: Number(env.SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE ?? 50),
    baseMinAdmissionScore: Number(env.SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE ?? 71),
    baseMinAcceptanceScore: Number(env.LEVEL_ACCEPTANCE_MIN_SCORE ?? 55),
    marketState,
    dangerStackScore: dangerStack.dangerStackScore,
    dteDays,
    levelAcceptance,
    mtf,
    optionFragilityScore: productAdaptation.optionFragilityScore,
    env,
  });

  const allStrategies = parseList(env.STRATEGIES || process.env.STRATEGIES || "");
  const statePermission = buildStrategyPermissionMatrix({
    marketState,
    allowedStrategies: [String(signal?.strategyId || "").trim()],
    allStrategies,
    env,
  });
  const stateBlockedStrategy =
    statePermission.allowedStrategies.length === 0 ||
    statePermission.blockedStrategies.includes(String(signal?.strategyId || "").trim());

  const oneDteHardeningEnabled =
    String(env.ONE_DTE_HARDENING_ENABLED ?? "true") === "true";
  const oneDteDangerLimit = Number(env.ONE_DTE_MAX_DANGER_TO_ALLOW ?? 62);
  const oneDteBlockedByState =
    oneDteHardeningEnabled &&
    oneDte &&
    dangerousContinuation &&
    ((marketState === "TREND_COMPRESSED" &&
      String(env.ONE_DTE_BLOCK_COMPRESSED_TREND ?? "true") === "true") ||
      (marketState === "BREAKOUT_WATCH" &&
        String(env.ONE_DTE_BLOCK_BREAKOUT_WATCH_TREND ?? "true") === "true") ||
      ((marketState === "FAILED_BREAKOUT" || marketState === "TRAP_RISK_HIGH" || marketState === "NO_TRADE") &&
        String(env.ONE_DTE_BLOCK_FAILED_BREAKOUT ?? "true") === "true"));

  const acceptanceOverrideEnabled =
    String(env.LEVEL_ACCEPTANCE_RETEST_OVERRIDE_ENABLED ?? "true") === "true";
  const blockedByAcceptanceFailure =
    continuation &&
    uglyState &&
    acceptanceActionableLevel &&
    levelAcceptance?.acceptanceMeta?.nearEnough === true &&
    levelAcceptance.breakoutAttemptDetected === true &&
    levelAcceptance.breakoutAccepted !== true &&
    !(acceptanceOverrideEnabled && levelAcceptance.retestAccepted === true);
  const blockedByLevelRejection =
    String(env.LEVEL_REJECTION_HARD_BLOCK_ENABLED ?? "true") === "true" &&
    continuation &&
    acceptanceActionableLevel &&
    levelAcceptance?.acceptanceMeta?.nearEnough === true &&
    levelAcceptance.repeatedRejectionDetected === true;
  const blockedByRetryGovernor = retryGovernor.blocked === true;
  const blockedByDangerStack = dangerStack.noTradeTriggered === true;
  const blockedByMarketState =
    marketState === "NO_TRADE" ||
    (marketState === "TRAP_RISK_HIGH" && continuation);
  const blockedByOneDteGate =
    oneDteBlockedByState ||
    (oneDteHardeningEnabled &&
      oneDte &&
      Number(dangerStack?.dangerStackScore ?? 0) > oneDteDangerLimit);

  let finalReasonCode = "ALLOW_ADAPTIVE";
  if (blockedByRetryGovernor) finalReasonCode = "BLOCKED_RETRY_GOVERNOR";
  else if (blockedByMarketState) finalReasonCode = "BLOCKED_MARKET_STATE_NO_TRADE";
  else if (blockedByDangerStack) finalReasonCode = "BLOCKED_DANGER_STACK_EXTREME";
  else if (blockedByOneDteGate) finalReasonCode = "BLOCKED_ONE_DTE_FRAGILITY";
  else if (blockedByLevelRejection) finalReasonCode = "BLOCKED_LEVEL_REJECTION_STACK";
  else if (blockedByAcceptanceFailure) finalReasonCode = "BLOCKED_ACCEPTANCE_REQUIRED";
  else if (stateBlockedStrategy) finalReasonCode = "BLOCKED_STRATEGY_BY_STATE";

  const finalBlocked =
    blockedByRetryGovernor ||
    blockedByMarketState ||
    blockedByDangerStack ||
    blockedByOneDteGate ||
    blockedByLevelRejection ||
    blockedByAcceptanceFailure ||
    stateBlockedStrategy;

  const chopPenalty = clamp(Number(meta.chopPenalty ?? inferChopPenalty(signal, context)), 0, 40);
  const gapPenalty = clamp(
    Number(meta.gapPenalty ?? inferGapPenalty(signal, context, sessionContext)),
    0,
    20,
  );
  const regimeAlignment = scoreRegimeAlignment(
    signal?.strategyStyle,
    marketState || context?.regime,
    meta.sessionPhase || context?.regimeMeta?.sessionPhase,
    regimeWeights,
  );
  const stageScore = deriveStageScore(signal);
  const selectorParticipation = clamp(
    Number(meta.strategyParticipationWeight ?? 1) * 100,
    0,
    100,
  );

  const qualityScore = weightedScore(
    { patternQuality, volumeQuality, anchorQuality, structureQuality },
    calibration.qualityWeights,
  );
  let contextScore = weightedScore(
    {
      regimeAlignment,
      freshness,
      antiChop: 100 - chopPenalty,
      stageScore,
      mtfAgreementScore: mtf.mtfAgreementScore,
      antiGap: 100 - gapPenalty,
      selectorParticipation,
    },
    calibration.contextWeights,
  );
  let finalSignalScore = clamp(
    weightedScore({ normalizedConfidence, qualityScore, contextScore }, calibration.finalWeights) +
      Number(strategyProfile(signal?.strategyId).bias ?? 0) +
      Number(calibration.bias ?? 0),
    0,
    100,
  );
  let rawConfidence = rawConfidenceOriginal;

  if (finalBlocked) {
    const hardPenalty = Math.max(
      18,
      Math.round(16 + Number(dangerStack.dangerStackScore ?? 0) * 0.22),
    );
    rawConfidence = clamp(rawConfidenceOriginal - Math.round(hardPenalty * 0.58), 0, 100);
    normalizedConfidence = clamp(
      normalizedConfidence - Math.round(hardPenalty * 0.55),
      0,
      100,
    );
    contextScore = clamp(contextScore - Math.round(hardPenalty * 0.7), 0, 100);
    finalSignalScore = clamp(finalSignalScore - hardPenalty, 0, 100);
  } else if (dangerStack.degradedEdgeState === true || uglyState || oneDte) {
    const softPenalty = Math.max(
      4,
      Math.round((Number(dangerStack.dangerStackScore ?? 0) / 100) * 12),
    );
    normalizedConfidence = clamp(normalizedConfidence - softPenalty, 0, 100);
    contextScore = clamp(contextScore - Math.round(softPenalty * 0.7), 0, 100);
    finalSignalScore = clamp(finalSignalScore - softPenalty, 0, 100);
  }

  return {
    rawConfidence,
    rawConfidenceOriginal,
    normalizedConfidence,
    patternQuality,
    volumeQuality,
    anchorQuality,
    structureQuality,
    qualityScore,
    regimeAlignment,
    freshness,
    antiChop: 100 - chopPenalty,
    antiGap: 100 - gapPenalty,
    stageScore,
    selectorParticipation,
    contextScore,
    finalSignalScore,
    mtfAgreementScore: mtf.mtfAgreementScore,
    mtfBias: mtf.mtfBias,
    mtfState: mtf.mtfState,
    mtfContributors: mtf.mtfContributors,
    mtfExpectedIntervals: mtf.mtfExpectedIntervals,
    mtfUsedIntervals: mtf.mtfUsedIntervals,
    mtfMissingIntervals: mtf.mtfMissingIntervals,
    mtfStaleIntervals: mtf.mtfStaleIntervals,
    mtfFallbackReason: mtf.mtfFallbackReason,
    mtfDegraded: mtf.mtfDegraded === true,
    mtfPenalty: mtf.mtfPenalty,
    mtfStrictnessPenalty: mtf.mtfStrictnessPenalty,
    mtfStrictnessState: mtf.mtfStrictnessState || null,
    mtfInputs: mtf.mtfInputs,
    rawRegime,
    primaryRegime,
    secondaryRegime: secondaryRegime || null,
    marketState,
    marketStateFamily,
    compressionActive:
      String(primaryRegime).toUpperCase() === "TREND_COMPRESSED" ||
      Number(regimeWeights?.TREND_COMPRESSED ?? 0) >= 0.35,
    breakoutWatchActive:
      String(primaryRegime).toUpperCase() === "BREAKOUT_WATCH" ||
      Number(regimeWeights?.BREAKOUT_WATCH ?? 0) >= 0.24,
    nearestKeyLevel: levelAcceptance.nearestKeyLevel,
    keyLevelType: levelAcceptance.keyLevelType,
    distanceToLevelAbs: levelAcceptance.distanceToLevelAbs,
    distanceToLevelAtr: levelAcceptance.distanceToLevelAtr,
    breakoutAttemptDetected: levelAcceptance.breakoutAttemptDetected,
    breakoutAccepted: levelAcceptance.breakoutAccepted,
    breakoutRejected: levelAcceptance.breakoutRejected,
    retestAccepted: levelAcceptance.retestAccepted,
    repeatedRejectionDetected: levelAcceptance.repeatedRejectionDetected,
    rejectionSide: levelAcceptance.rejectionSide,
    rejectionCount: levelAcceptance.rejectionCount,
    acceptanceScore: levelAcceptance.acceptanceScore,
    dangerStackScore: dangerStack.dangerStackScore,
    dangerStackReasons: dangerStack.dangerStackReasons,
    degradeTier: dangerStack.degradeTier,
    degradedEdgeState: dangerStack.degradedEdgeState,
    dte: Number.isFinite(Number(dteDays)) ? Number(dteDays) : null,
    oneDteHardened: oneDteHardeningEnabled && oneDte,
    oneDteBlocked: blockedByOneDteGate,
    optionFragilityScore: productAdaptation.optionFragilityScore,
    productRiskTier: productAdaptation.productRiskTier,
    productRecommendation: productAdaptation.productRecommendation,
    suggestedDtePolicy: productAdaptation.suggestedDtePolicy,
    riskSizeMultiplierRecommendation:
      productAdaptation.riskSizeMultiplierRecommendation,
    allowFragileContinuation: productAdaptation.allowFragileContinuation === true,
    baseMinConfidence: thresholds.baseMinConfidence,
    resolvedMinConfidence: thresholds.resolvedMinConfidence,
    baseMinMtfAgreement: thresholds.baseMinMtfAgreement,
    resolvedMinMtfAgreement: thresholds.resolvedMinMtfAgreement,
    baseMinAdmissionScore: thresholds.baseMinAdmissionScore,
    resolvedMinAdmissionScore: thresholds.resolvedMinAdmissionScore,
    baseMinAcceptanceScore: thresholds.baseMinAcceptanceScore,
    resolvedAcceptanceScore: thresholds.resolvedAcceptanceScore,
    thresholdUpliftBreakdown: thresholds.thresholdUpliftBreakdown,
    blockedByMarketState,
    blockedByAcceptanceFailure,
    blockedByLevelRejection,
    blockedByOneDteGate,
    blockedByDangerStack,
    blockedByRetryGovernor,
    blockedByStrategyMatrix: stateBlockedStrategy,
    finalDecision: finalBlocked ? "BLOCK" : "ALLOW",
    finalReasonCode,
    retryGovernorState: retryGovernor.state,
    retryGovernorFailureCount: retryGovernor.failureCount,
    retryGovernorBlockedUntil: retryGovernor.blockedUntil,
    retryGovernorKey: retryGovernor.key,
    calibrationActive: calibration.active === true,
    calibrationVersion: calibration.version,
    calibrationSource: calibration.source,
    fallbackReason: calibration.fallbackReason || null,
    scoreBreakdown: {
      patternQuality,
      volumeQuality,
      anchorQuality,
      structureQuality,
      freshness,
      regimeAlignment,
      chopPenalty,
      gapPenalty,
      stageScore,
      mtfAgreementScore: mtf.mtfAgreementScore,
      mtfBias: mtf.mtfBias,
      mtfState: mtf.mtfState,
      mtfContributors: mtf.mtfContributors,
      mtfExpectedIntervals: mtf.mtfExpectedIntervals,
      mtfUsedIntervals: mtf.mtfUsedIntervals,
      mtfMissingIntervals: mtf.mtfMissingIntervals,
      mtfStaleIntervals: mtf.mtfStaleIntervals,
      mtfFallbackReason: mtf.mtfFallbackReason,
      mtfDegraded: mtf.mtfDegraded === true,
      mtfPenalty: mtf.mtfPenalty,
      mtfStrictnessPenalty: mtf.mtfStrictnessPenalty,
      mtfStrictnessState: mtf.mtfStrictnessState || null,
      mtfInputs: mtf.mtfInputs,
      selectorParticipation,
      calibrationVersion: calibration.version,
      calibrationSource: calibration.source,
      calibrationActive: calibration.active === true,
      fallbackReason: calibration.fallbackReason || null,
      rawRegime,
      primaryRegime,
      secondaryRegime: secondaryRegime || null,
      marketState,
      marketStateFamily,
      levelAcceptance,
      dangerStack,
      productAdaptation,
      thresholds,
      decision: {
        blockedByMarketState,
        blockedByAcceptanceFailure,
        blockedByLevelRejection,
        blockedByOneDteGate,
        blockedByDangerStack,
        blockedByRetryGovernor,
        blockedByStrategyMatrix: stateBlockedStrategy,
        finalDecision: finalBlocked ? "BLOCK" : "ALLOW",
        finalReasonCode,
      },
    },
  };
}

function decorateSignalCandidate(signal, context = {}) {
  if (!signal) return null;
  const sessionContext = strategySessionContext(context);
  const signalStage = signalStageFor(signal, context);
  const isProvisional = signal?.isProvisional === true || signalStage === "tick_preview";
  const candleClosed = signal?.candleClosed === true || !isProvisional;
  const baseSignal = { ...signal, signalStage, isProvisional, candleClosed };
  const scores = buildScoreBreakdown(baseSignal, { ...context, sessionContext });
  const meta = {
    ...(signal.meta || {}),
    sessionDate: signal?.meta?.sessionDate || sessionContext?.sessionDate || null,
    sessionPhase: signal?.meta?.sessionPhase || context?.regimeMeta?.sessionPhase || null,
    gapContext: signal?.meta?.gapContext || sessionContext?.gapContext || null,
    openingRange: signal?.meta?.openingRange || sessionContext?.openingRange || null,
    previousSession: signal?.meta?.previousSession || sessionContext?.previousSession || null,
    currentSession: signal?.meta?.currentSession || sessionContext?.currentSession || null,
    sessionElapsedMin: signal?.meta?.sessionElapsedMin ?? sessionContext?.sessionElapsedMin ?? null,
    setupFreshness: scores.scoreBreakdown.freshness,
    regimeWeightsSnapshot:
      signal?.meta?.regimeWeightsSnapshot || context?.regimeMeta?.regimeWeights || null,
    primaryRegime:
      signal?.meta?.primaryRegime || context?.regimeMeta?.primaryRegime || context?.regime || null,
    secondaryRegime:
      signal?.meta?.secondaryRegime || context?.regimeMeta?.secondaryRegime || null,
    strategyParticipationWeight:
      signal?.meta?.strategyParticipationWeight ??
      context?.regimeMeta?.strategyWeights?.[signal?.strategyId] ??
      1,
    signalStage,
    isProvisional,
    candleClosed,
    setupState:
      signal?.meta?.setupState ||
      signal?.setupState ||
      (signal?.actionable === true ? "triggered" : isProvisional ? "armed" : "forming"),
    triggerType: signal?.meta?.triggerType || signal?.triggerType || "PATTERN_TRIGGER",
    anchorType: signal?.meta?.anchorType || signal?.anchorType || "PRICE",
    freshness: scores.scoreBreakdown.freshness,
    rawRegime: scores.rawRegime || null,
    marketState: scores.marketState || null,
    marketStateFamily: scores.marketStateFamily || null,
    compressionActive: scores.compressionActive === true,
    breakoutWatchActive: scores.breakoutWatchActive === true,
    levelAcceptance: {
      nearestKeyLevel: scores.nearestKeyLevel ?? null,
      keyLevelType: scores.keyLevelType || null,
      distanceToLevelAtr: scores.distanceToLevelAtr ?? null,
      breakoutAttemptDetected: scores.breakoutAttemptDetected === true,
      breakoutAccepted: scores.breakoutAccepted === true,
      breakoutRejected: scores.breakoutRejected === true,
      retestAccepted: scores.retestAccepted === true,
      repeatedRejectionDetected: scores.repeatedRejectionDetected === true,
      rejectionSide: scores.rejectionSide || null,
      rejectionCount: Number(scores.rejectionCount ?? 0),
      acceptanceScore: Number(scores.acceptanceScore ?? 0),
    },
    dangerStack: {
      dangerStackScore: Number(scores.dangerStackScore ?? 0),
      dangerStackReasons: scores.dangerStackReasons || [],
      degradeTier: scores.degradeTier || "LOW",
      degradedEdgeState: scores.degradedEdgeState === true,
    },
    adaptiveThresholds: {
      baseMinConfidence: scores.baseMinConfidence ?? null,
      resolvedMinConfidence: scores.resolvedMinConfidence ?? null,
      baseMinMtfAgreement: scores.baseMinMtfAgreement ?? null,
      resolvedMinMtfAgreement: scores.resolvedMinMtfAgreement ?? null,
      baseMinAdmissionScore: scores.baseMinAdmissionScore ?? null,
      resolvedMinAdmissionScore: scores.resolvedMinAdmissionScore ?? null,
      resolvedAcceptanceScore: scores.resolvedAcceptanceScore ?? null,
      thresholdUpliftBreakdown: scores.thresholdUpliftBreakdown || null,
    },
    productAdaptation: {
      dte: scores.dte ?? null,
      oneDteHardened: scores.oneDteHardened === true,
      oneDteBlocked: scores.oneDteBlocked === true,
      productRiskTier: scores.productRiskTier || null,
      productRecommendation: scores.productRecommendation || null,
      suggestedDtePolicy: scores.suggestedDtePolicy || null,
      riskSizeMultiplierRecommendation:
        scores.riskSizeMultiplierRecommendation ?? null,
      optionFragilityScore: scores.optionFragilityScore ?? null,
    },
    adaptiveDecision: {
      blockedByMarketState: scores.blockedByMarketState === true,
      blockedByAcceptanceFailure: scores.blockedByAcceptanceFailure === true,
      blockedByLevelRejection: scores.blockedByLevelRejection === true,
      blockedByOneDteGate: scores.blockedByOneDteGate === true,
      blockedByDangerStack: scores.blockedByDangerStack === true,
      blockedByRetryGovernor: scores.blockedByRetryGovernor === true,
      blockedByStrategyMatrix: scores.blockedByStrategyMatrix === true,
      finalDecision: scores.finalDecision || "ALLOW",
      finalReasonCode: scores.finalReasonCode || "ALLOW_ADAPTIVE",
    },
  };

  return {
    ...baseSignal,
    ...scores,
    actionable: signal?.actionable === true,
    meta,
    setupState: meta.setupState,
    triggerType: meta.triggerType,
    anchorType: meta.anchorType,
    freshness: meta.freshness,
    calibrationActive: scores.calibrationActive === true,
    fallbackReason: scores.fallbackReason || null,
    signalStage,
    isProvisional,
    candleClosed,
  };
}

function levelKey(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : "na";
}

function buildFingerprint(candidate, context = {}) {
  const strategyId = String(candidate?.strategyId || "");
  const side = String(candidate?.side || "");
  const meta = candidate?.meta || {};
  const sessionDate = String(meta.sessionDate || strategySessionContext(context)?.sessionDate || "na");
  const triggerType = String(meta.triggerType || "PATTERN_TRIGGER");

  switch (strategyId) {
    case "orb":
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.orbHigh), levelKey(meta.orbLow), String(meta.orbCompletedAt || "na")].join(":");
    case "breakout":
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.rangeHigh ?? meta.triggerLevel), levelKey(meta.rangeLow), Number(meta.lookbackUsed ?? meta.lookback ?? 0), String(meta.retestState || "BASE")].join(":");
    case "ema_pullback":
      return [sessionDate, side, strategyId, triggerType, Number(meta.fast ?? 0), Number(meta.slow ?? 0), levelKey(meta.pullbackAnchor ?? meta.anchorValue), levelKey(meta.trendAnchor ?? meta.anchorValue)].join(":");
    case "vwap_reclaim":
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.anchorValue), String(meta.vwapTransition || triggerType)].join(":");
    case "rsi_fade":
      return [sessionDate, side, strategyId, triggerType, String(meta.extremeBucket || "BASE"), Number(meta.period ?? 0)].join(":");
    case "fakeout":
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.brokenLevel ?? meta.rangeHigh ?? meta.triggerLevel), levelKey(meta.rangeLow ?? meta.triggerLevel), String(meta.returnInsideFamily || "INSIDE")].join(":");
    case "wick_reversal":
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.triggerLevel ?? meta.wickExtreme ?? meta.anchorValue), String(meta.reversalZone || "WICK")].join(":");
    default:
      return [sessionDate, side, strategyId, triggerType, levelKey(meta.triggerLevel ?? meta.anchorValue)].join(":");
  }
}

function candlesBetween(candles, fromTs, toTs) {
  return (candles || []).filter((candle) => {
    const ts = candleTs(candle);
    return Number.isFinite(ts) && ts > fromTs && ts < toTs;
  });
}

function detectResetCondition(candidate, state, candles, currentTs) {
  const sinceTs = Number.isFinite(state.firedAtBar)
    ? state.firedAtBar
    : Number.isFinite(state.lastConfirmedTs)
      ? state.lastConfirmedTs
      : state.lastSeenTs;
  if (!Number.isFinite(sinceTs)) return null;

  const between = candlesBetween(candles, sinceTs, currentTs);
  if (!between.length) return null;

  const strategyId = String(candidate?.strategyId || "");
  const side = String(candidate?.side || "");

  if (strategyId === "orb" || strategyId === "breakout" || strategyId === "fakeout") {
    const level = Number(state.triggerLevel);
    if (!Number.isFinite(level)) return null;
    const reset = between.some((candle) =>
      side === "BUY"
        ? Number(candle?.close) <= level
        : Number(candle?.close) >= level,
    );
    return reset ? "TRIGGER_LEVEL_RESET" : null;
  }

  if (strategyId === "ema_pullback") {
    const sessionBars = getCurrentSessionCandles(candles, { endTs: new Date(currentTs) });
    const closes = sessionBars.map((candle) => Number(candle?.close));
    const fast = Number(state.fast ?? 9);
    const emaFast = emaSeries(closes, fast);
    const reset = sessionBars.some((candle, index) => {
      const ts = candleTs(candle);
      if (!Number.isFinite(ts) || ts <= sinceTs || ts >= currentTs) return false;
      const anchor = Number(emaFast[index]);
      if (!Number.isFinite(anchor)) return false;
      return side === "BUY" ? Number(candle?.close) <= anchor : Number(candle?.close) >= anchor;
    });
    return reset ? "FRESH_PULLBACK_REQUIRED" : null;
  }

  if (strategyId === "vwap_reclaim") {
    const reset = (candles || []).some((candle, index) => {
      const ts = candleTs(candle);
      if (!Number.isFinite(ts) || ts <= sinceTs || ts >= currentTs) return false;
      const anchor = sessionVWAP(candles.slice(0, index + 1), candle.ts);
      if (!Number.isFinite(anchor)) return false;
      return side === "BUY" ? Number(candle?.close) < anchor : Number(candle?.close) > anchor;
    });
    return reset ? "VWAP_LOST_AND_REARMED" : null;
  }

  if (strategyId === "rsi_fade") {
    const sessionBars = getCurrentSessionCandles(candles, { endTs: new Date(currentTs) });
    const period = Number(state.period ?? 14);
    const neutralLevel = Number(state.neutralLevel ?? 50);
    const reset = sessionBars.some((candle, index) => {
      const ts = candleTs(candle);
      if (!Number.isFinite(ts) || ts <= sinceTs || ts >= currentTs) return false;
      const value = rsi(sessionBars.slice(0, index + 1), period);
      if (!Number.isFinite(value)) return false;
      return side === "BUY" ? value >= neutralLevel : value <= neutralLevel;
    });
    return reset ? "RSI_REARMED_THROUGH_NEUTRAL" : null;
  }

  return null;
}

function buildLineageKey(candidate, context = {}) {
  const token = Number(context.instrument_token);
  const intervalMin = Number(context.intervalMin ?? 0);
  const strategyId = String(candidate?.strategyId || "");
  const side = String(candidate?.side || "");
  if (!Number.isFinite(token) || !Number.isFinite(intervalMin) || intervalMin <= 0 || !strategyId || !side) return null;
  return `${token}:${intervalMin}:${strategyId}:${side}`;
}

function buildSetupKey(candidate, context = {}, fingerprint) {
  const lineageKey = buildLineageKey(candidate, context);
  if (!lineageKey || !fingerprint) return null;
  return `${lineageKey}:${fingerprint}`;
}

function deriveSetupState(candidate, context = {}) {
  return String(
    candidate?.meta?.setupState ||
      candidate?.setupState ||
      (candidate?.actionable === true
        ? "triggered"
        : signalStageFor(candidate, context) === "tick_preview"
          ? "armed"
          : "forming"),
  ).toLowerCase();
}

function buildStatePatch(candidate, context, currentTs, fingerprint, setupId) {
  const profile = strategyProfile(candidate?.strategyId);
  const intervalMin = Math.max(1, Number(context.intervalMin ?? 1));
  const signalStage = signalStageFor(candidate, context);
  const setupState = deriveSetupState(candidate, context);
  const ttlMs = Math.max(90 * 60_000, intervalMin * (profile.expiryBars + 8) * 60_000);
  const lineageId = `${buildLineageKey(candidate, context) || "lineage"}:${fingerprint}`;
  return {
    token: Number(context.instrument_token),
    intervalMin,
    strategyId: String(candidate?.strategyId || ""),
    strategyStyle: String(candidate?.strategyStyle || ""),
    strategyFamily: String(candidate?.strategyFamily || ""),
    side: String(candidate?.side || ""),
    regime: String(candidate?.regime || candidate?.meta?.primaryRegime || context?.regime || ""),
    rawRegime: String(candidate?.rawRegime || candidate?.regime || context?.regime || ""),
    marketState: String(candidate?.marketState || candidate?.meta?.marketState || ""),
    marketStateFamily: String(
      candidate?.marketStateFamily || candidate?.meta?.marketStateFamily || "",
    ),
    dangerStackScore: Number(candidate?.dangerStackScore ?? 0),
    degradeTier: String(candidate?.degradeTier || ""),
    dte: Number(candidate?.dte),
    oneDteHardened: candidate?.oneDteHardened === true,
    finalDecision: String(candidate?.finalDecision || ""),
    finalReasonCode: String(candidate?.finalReasonCode || ""),
    fingerprint,
    setupId,
    parentSetupId: null,
    lineageId,
    setupState,
    status: setupState,
    actionable: candidate?.actionable === true,
    signalStage,
    signalEventTs: Number(candidate?.signalEventTs ? candleTs(candidate.signalEventTs) : currentTs),
    signalCreatedAt: candidate?.signalCreatedAt || null,
    signalDecisionTs: candidate?.signalDecisionTs || candidate?.signalCreatedAt || null,
    rawConfidence: Number(candidate?.rawConfidence ?? candidate?.confidence ?? 0),
    normalizedConfidence: Number(candidate?.normalizedConfidence ?? 0),
    patternQuality: Number(candidate?.patternQuality ?? candidate?.scoreBreakdown?.patternQuality ?? 0),
    volumeQuality: Number(candidate?.volumeQuality ?? candidate?.scoreBreakdown?.volumeQuality ?? 0),
    anchorQuality: Number(candidate?.anchorQuality ?? candidate?.scoreBreakdown?.anchorQuality ?? 0),
    structureQuality: Number(candidate?.structureQuality ?? candidate?.scoreBreakdown?.structureQuality ?? 0),
    qualityScore: Number(candidate?.qualityScore ?? 0),
    regimeAlignment: Number(candidate?.regimeAlignment ?? candidate?.scoreBreakdown?.regimeAlignment ?? 0),
    freshness: Number(candidate?.freshness ?? candidate?.scoreBreakdown?.freshness ?? 0),
    antiChop: Number(candidate?.antiChop ?? (100 - Number(candidate?.scoreBreakdown?.chopPenalty ?? 0))),
    antiGap: Number(candidate?.antiGap ?? (100 - Number(candidate?.scoreBreakdown?.gapPenalty ?? 0))),
    stageScore: Number(candidate?.stageScore ?? candidate?.scoreBreakdown?.stageScore ?? 0),
    selectorParticipation: Number(
      candidate?.selectorParticipation ?? candidate?.scoreBreakdown?.selectorParticipation ?? 0,
    ),
    contextScore: Number(candidate?.contextScore ?? 0),
    mtfAgreementScore: Number(candidate?.mtfAgreementScore ?? 0),
    mtfBias: String(candidate?.mtfBias || candidate?.scoreBreakdown?.mtfBias || ""),
    mtfState: String(candidate?.mtfState || candidate?.scoreBreakdown?.mtfState || ""),
    mtfFallbackReason:
      candidate?.mtfFallbackReason ||
      candidate?.scoreBreakdown?.mtfFallbackReason ||
      null,
    mtfDegraded:
      candidate?.mtfDegraded === true ||
      candidate?.scoreBreakdown?.mtfDegraded === true,
    finalSignalScore: Number(candidate?.finalSignalScore ?? 0),
    calibrationActive: candidate?.calibrationActive === true,
    calibrationVersion: candidate?.calibrationVersion || null,
    calibrationSource: candidate?.calibrationSource || null,
    anchorType: String(candidate?.meta?.anchorType || ""),
    anchorValue: Number(candidate?.meta?.anchorValue),
    triggerType: String(candidate?.meta?.triggerType || ""),
    triggerLevel: Number(candidate?.meta?.triggerLevel),
    fast: Number(candidate?.meta?.fast),
    slow: Number(candidate?.meta?.slow),
    period: Number(candidate?.meta?.period),
    neutralLevel: Number(candidate?.meta?.neutralLevel),
    sessionDate: String(candidate?.meta?.sessionDate || ""),
    regimeWeightsSnapshot: candidate?.meta?.regimeWeightsSnapshot || null,
    anchorMeta: {
      anchorType: candidate?.anchorType || candidate?.meta?.anchorType || null,
      anchorValue: candidate?.meta?.anchorValue ?? null,
      primaryRegime: candidate?.meta?.primaryRegime || null,
      secondaryRegime: candidate?.meta?.secondaryRegime || null,
    },
    triggerMeta: {
      triggerType: candidate?.triggerType || candidate?.meta?.triggerType || null,
      triggerLevel: candidate?.meta?.triggerLevel ?? null,
      strategyParticipationWeight:
        candidate?.meta?.strategyParticipationWeight ?? null,
    },
    resetMeta: null,
    staleReason: null,
    lastReason: candidate?.reason || null,
    firstSeenTs: currentTs,
    lastSeenTs: currentTs,
    lastCandleTs: currentTs,
    lastSignalStage: signalStage,
    lastState: setupState,
    selectedCount: 0,
    previewCount: signalStage === "tick_preview" ? 1 : 0,
    confirmedCount: signalStage === "bar_close_confirmed" ? 1 : 0,
    observationCount: 0,
    cycleId: 1,
    firedAtBar: NaN,
    lastConfirmedTs: NaN,
    resetConditionMet: false,
    resetReason: null,
    coolingBars: profile.coolingBars,
    expiryBars: profile.expiryBars,
    ttlMs,
    expiryAtTs: currentTs + intervalMin * profile.expiryBars * 60_000,
  };
}

function attachLifecycle(candidate, patch = {}) {
  const meta = { ...(candidate.meta || {}), ...patch };
  return {
    ...candidate,
    meta,
    setupState: meta.setupState || candidate.setupState || null,
    triggerType: meta.triggerType || candidate.triggerType || null,
    anchorType: meta.anchorType || candidate.anchorType || null,
    freshness: Number(meta.freshness ?? candidate.freshness ?? 0),
    signalStage: meta.signalStage || candidate.signalStage || null,
    isProvisional: meta.isProvisional != null ? !!meta.isProvisional : !!candidate.isProvisional,
    candleClosed: meta.candleClosed != null ? !!meta.candleClosed : !!candidate.candleClosed,
    actionable: meta.actionable != null ? meta.actionable === true : candidate.actionable === true,
  };
}

function updateState(state, patch) {
  return { ...state, ...patch };
}

function cleanupStateStores(nowTs = Date.now()) {
  ensureSignalLayerStateReady();
  const cfg = statePersistenceConfig();
  const currentTs = Number(nowTs);
  if (!Number.isFinite(currentTs)) return;
  let prunedSetups = 0;
  let prunedSnapshots = 0;
  for (const [key, state] of setupRegistry.entries()) {
    const ttlMs = Math.max(90 * 60_000, Number(state?.ttlMs ?? 0), cfg.ttlMs);
    if (!Number.isFinite(state?.lastSeenTs) || currentTs - state.lastSeenTs > ttlMs) {
      setupRegistry.delete(key);
      prunedSetups += 1;
    }
  }
  for (const [key, snapshot] of intervalSnapshots.entries()) {
    if (!Number.isFinite(snapshot?.ts) || currentTs - snapshot.ts > Math.max(120 * 60_000, cfg.ttlMs)) {
      intervalSnapshots.delete(key);
      prunedSnapshots += 1;
    }
  }
  if (setupRegistry.size > cfg.maxSetups) {
    const staleKeys = Array.from(setupRegistry.entries())
      .sort((a, b) => Number(a[1]?.lastSeenTs ?? 0) - Number(b[1]?.lastSeenTs ?? 0))
      .slice(0, setupRegistry.size - cfg.maxSetups)
      .map(([key]) => key);
    for (const key of staleKeys) {
      setupRegistry.delete(key);
      prunedSetups += 1;
    }
  }
  if (prunedSetups > 0 || prunedSnapshots > 0) {
    updatePersistenceState({
      prunedSetupCount: Number(signalLayerPersistenceState.prunedSetupCount ?? 0) + prunedSetups,
      prunedSnapshotCount:
        Number(signalLayerPersistenceState.prunedSnapshotCount ?? 0) + prunedSnapshots,
    });
    persistSignalLayerState(currentTs);
  }
}

function refreshStateFromCandidate(state, candidate, context, currentTs) {
  const nextBase = buildStatePatch(
    candidate,
    context,
    state.firstSeenTs || currentTs,
    state.fingerprint,
    state.setupId,
  );
  return updateState(state, {
    strategyStyle: nextBase.strategyStyle,
    strategyFamily: nextBase.strategyFamily,
    actionable: nextBase.actionable,
    signalStage: nextBase.signalStage,
    signalEventTs: nextBase.signalEventTs,
    signalCreatedAt: nextBase.signalCreatedAt,
    signalDecisionTs: nextBase.signalDecisionTs,
    rawConfidence: nextBase.rawConfidence,
    normalizedConfidence: nextBase.normalizedConfidence,
    patternQuality: nextBase.patternQuality,
    volumeQuality: nextBase.volumeQuality,
    anchorQuality: nextBase.anchorQuality,
    structureQuality: nextBase.structureQuality,
    qualityScore: nextBase.qualityScore,
    regime: nextBase.regime,
    rawRegime: nextBase.rawRegime,
    marketState: nextBase.marketState,
    marketStateFamily: nextBase.marketStateFamily,
    dangerStackScore: nextBase.dangerStackScore,
    degradeTier: nextBase.degradeTier,
    dte: nextBase.dte,
    oneDteHardened: nextBase.oneDteHardened,
    finalDecision: nextBase.finalDecision,
    finalReasonCode: nextBase.finalReasonCode,
    regimeAlignment: nextBase.regimeAlignment,
    freshness: nextBase.freshness,
    antiChop: nextBase.antiChop,
    antiGap: nextBase.antiGap,
    stageScore: nextBase.stageScore,
    selectorParticipation: nextBase.selectorParticipation,
    contextScore: nextBase.contextScore,
    mtfAgreementScore: nextBase.mtfAgreementScore,
    mtfBias: nextBase.mtfBias,
    mtfState: nextBase.mtfState,
    mtfFallbackReason: nextBase.mtfFallbackReason,
    mtfDegraded: nextBase.mtfDegraded,
    finalSignalScore: nextBase.finalSignalScore,
    calibrationActive: nextBase.calibrationActive,
    calibrationVersion: nextBase.calibrationVersion,
    calibrationSource: nextBase.calibrationSource,
    anchorType: nextBase.anchorType,
    anchorValue: nextBase.anchorValue,
    triggerType: nextBase.triggerType,
    triggerLevel: nextBase.triggerLevel,
    fast: nextBase.fast,
    slow: nextBase.slow,
    period: nextBase.period,
    neutralLevel: nextBase.neutralLevel,
    sessionDate: nextBase.sessionDate,
    regimeWeightsSnapshot: nextBase.regimeWeightsSnapshot,
    anchorMeta: nextBase.anchorMeta,
    triggerMeta: nextBase.triggerMeta,
    lastReason: nextBase.lastReason,
    lastSeenTs: currentTs,
    lastCandleTs: currentTs,
    lastSignalStage: nextBase.signalStage,
    lastState: nextBase.setupState,
    setupState: nextBase.setupState,
    status: nextBase.setupState,
    expiryAtTs: currentTs + nextBase.intervalMin * Number(state.expiryBars ?? 6) * 60_000,
  });
}

function candidateAgeMeta(firstSeenTs, currentTs, intervalMin) {
  const ageMin = Number.isFinite(firstSeenTs)
    ? Math.max(0, (currentTs - firstSeenTs) / 60_000)
    : 0;
  return {
    candidateAgeMin: Number(ageMin.toFixed(2)),
    candidateAgeBars: Math.max(0, Math.floor(ageMin / Math.max(1, intervalMin))),
  };
}

function applySetupLifecycle(candidate, context = {}) {
  ensureSignalLayerStateReady();
  const currentTs = candleTs(context.last?.ts || context.last);
  if (!candidate || !Number.isFinite(currentTs)) return { suppress: false, candidate };

  cleanupStateStores(currentTs);

  const fingerprint = buildFingerprint(candidate, context);
  const setupKey = buildSetupKey(candidate, context, fingerprint);
  if (!setupKey) return { suppress: false, candidate };

  const signalStage = signalStageFor(candidate, context);
  const provisional = signalStage === "tick_preview";
  const intervalMin = Math.max(1, Number(context.intervalMin ?? 1));
  const desiredState = deriveSetupState(candidate, context);
  const existing = setupRegistry.get(setupKey);

  if (!existing) {
    const setupId = `${fingerprint}:1`;
    const next = updateState(buildStatePatch(candidate, context, currentTs, fingerprint, setupId), {
      observationCount: 1,
    });
    setupRegistry.set(setupKey, next);
    persistSignalLayerState(currentTs);
    return {
      suppress: false,
      candidate: attachLifecycle(candidate, {
        setupId,
        parentSetupId: null,
        lineageId: next.lineageId,
        setupObservationCount: 1,
        setupState: desiredState,
        signalStage,
        isProvisional: provisional,
        candleClosed: !provisional,
        actionable: candidate.actionable === true,
        ...candidateAgeMeta(next.firstSeenTs, currentTs, intervalMin),
        freshness: clamp(Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 88), 0, 100),
      }),
    };
  }

  const sameCandle = Number(existing.lastCandleTs) === currentTs;
  const sameStage = String(existing.lastSignalStage || "") === signalStage;
  const previewToConfirm =
    sameCandle &&
    String(existing.lastSignalStage || "") === "tick_preview" &&
    signalStage === "bar_close_confirmed";
  const resetReason = detectResetCondition(candidate, existing, context.candles, currentTs);
  const observationCount = Number(existing.observationCount ?? 0) + 1;
  const refreshed = refreshStateFromCandidate(existing, candidate, context, currentTs);

  if (resetReason) {
    const cycleId = Number(existing.cycleId ?? 1) + 1;
    const setupId = `${fingerprint}:${cycleId}`;
    const next = updateState(refreshed, {
      cycleId,
      setupId,
      parentSetupId: existing.setupId,
      setupState: desiredState,
      status: desiredState,
      observationCount,
      resetConditionMet: true,
      resetReason,
      resetMeta: { resetReason, resetAtTs: currentTs },
      firedAtBar: NaN,
      lastConfirmedTs: NaN,
    });
    setupRegistry.set(setupKey, next);
    persistSignalLayerState(currentTs);
    return {
      suppress: false,
      candidate: attachLifecycle(candidate, {
        setupId,
        parentSetupId: existing.setupId,
        lineageId: existing.lineageId,
        setupObservationCount: observationCount,
        setupState: desiredState,
        resetReason,
        signalStage,
        isProvisional: provisional,
        candleClosed: !provisional,
        actionable: candidate.actionable === true,
        ...candidateAgeMeta(next.firstSeenTs, currentTs, intervalMin),
        freshness: clamp(Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 84) + 4, 0, 100),
      }),
    };
  }

  if (previewToConfirm) {
    const next = updateState(refreshed, {
      status: desiredState === "triggered" ? "confirmed" : desiredState,
      setupState: desiredState === "triggered" ? "confirmed" : desiredState,
      observationCount,
      lastConfirmedTs: currentTs,
      confirmedCount: Number(existing.confirmedCount ?? 0) + 1,
      previewCount: Math.max(Number(existing.previewCount ?? 0), 1),
      resetConditionMet: false,
      resetReason: null,
    });
    setupRegistry.set(setupKey, next);
    persistSignalLayerState(currentTs);
    return {
      suppress: false,
      candidate: attachLifecycle(candidate, {
        setupId: existing.setupId,
        parentSetupId: existing.parentSetupId || null,
        lineageId: existing.lineageId,
        setupObservationCount: observationCount,
        setupState: desiredState,
        setupLineage: "preview_to_confirmed",
        signalStage,
        isProvisional: false,
        candleClosed: true,
        actionable: candidate.actionable === true,
        ...candidateAgeMeta(existing.firstSeenTs, currentTs, intervalMin),
        freshness: clamp(Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 86) + 2, 0, 100),
      }),
    };
  }

  if (sameCandle && sameStage) {
    const next = updateState(refreshed, { observationCount });
    setupRegistry.set(setupKey, next);
    persistSignalLayerState(currentTs);
    return {
      suppress: candidate.actionable === true,
      reason: "DUPLICATE_SAME_CANDLE",
      candidate: attachLifecycle(candidate, {
        setupId: existing.setupId,
        parentSetupId: existing.parentSetupId || null,
        lineageId: existing.lineageId,
        setupObservationCount: observationCount,
        setupState: desiredState,
        resetReason: "SAME_CANDLE_DUPLICATE",
        signalStage,
        isProvisional: provisional,
        candleClosed: !provisional,
        actionable: candidate.actionable === true,
        staleReason: "SAME_CANDLE_DUPLICATE",
        ...candidateAgeMeta(existing.firstSeenTs, currentTs, intervalMin),
        freshness: clamp(Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 80) - 20, 0, 100),
      }),
    };
  }

  if (Number.isFinite(existing.firedAtBar) && candidate.actionable === true) {
    const barsSinceConfirmed = Math.max(
      0,
      Math.floor((currentTs - existing.firedAtBar) / (intervalMin * 60_000)),
    );
    const status =
      barsSinceConfirmed <= Number(existing.coolingBars ?? 1)
        ? "cooling"
        : barsSinceConfirmed > Number(existing.expiryBars ?? 6)
          ? "expired"
          : "fired";
    const next = updateState(refreshed, {
      observationCount,
      status,
      setupState: status,
      resetConditionMet: false,
      resetReason: null,
      staleReason: status === "expired" ? "SETUP_EXPIRED_WITHOUT_RESET" : "RESET_NOT_MET",
    });
    setupRegistry.set(setupKey, next);
    persistSignalLayerState(currentTs);
    return {
      suppress: true,
      reason: status === "expired" ? "STALE_SETUP" : "SETUP_ALREADY_FIRED",
      candidate: attachLifecycle(candidate, {
        setupId: existing.setupId,
        parentSetupId: existing.parentSetupId || null,
        lineageId: existing.lineageId,
        setupObservationCount: observationCount,
        setupState: status,
        resetReason: status === "expired" ? "SETUP_EXPIRED_WITHOUT_RESET" : "RESET_NOT_MET",
        signalStage,
        isProvisional: provisional,
        candleClosed: !provisional,
        actionable: candidate.actionable === true,
        staleReason: status === "expired" ? "SETUP_EXPIRED_WITHOUT_RESET" : "RESET_NOT_MET",
        ...candidateAgeMeta(existing.firstSeenTs, currentTs, intervalMin),
        freshness: clamp(Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 80) - 18, 0, 100),
      }),
    };
  }

  const next = updateState(refreshed, {
    observationCount,
    resetConditionMet: false,
    resetReason: null,
  });
  setupRegistry.set(setupKey, next);
  persistSignalLayerState(currentTs);
  return {
    suppress: false,
    candidate: attachLifecycle(candidate, {
      setupId: existing.setupId,
      parentSetupId: existing.parentSetupId || null,
      lineageId: existing.lineageId,
      setupObservationCount: observationCount,
      setupState: desiredState,
      signalStage,
      isProvisional: provisional,
      candleClosed: !provisional,
      actionable: candidate.actionable === true,
      ...candidateAgeMeta(existing.firstSeenTs, currentTs, intervalMin),
      freshness: clamp(
        Number(candidate?.meta?.freshness ?? candidate?.freshness ?? 84) - Math.min(10, observationCount - 1),
        0,
        100,
      ),
    }),
  };
}

function rememberFiredSignal(candidate, context = {}) {
  ensureSignalLayerStateReady();
  const currentTs = candleTs(context.last?.ts || context.last);
  if (!candidate || !Number.isFinite(currentTs)) return;

  cleanupStateStores(currentTs);

  const fingerprint = buildFingerprint(candidate, context);
  const setupKey = buildSetupKey(candidate, context, fingerprint);
  const signalStage = signalStageFor(candidate, context);
  const provisional = signalStage === "tick_preview";
  if (!setupKey) return;

  const existing =
    setupRegistry.get(setupKey) ||
    buildStatePatch(candidate, context, currentTs, fingerprint, String(candidate?.meta?.setupId || `${fingerprint}:1`));

  const next = updateState(refreshStateFromCandidate(existing, candidate, context, currentTs), {
    setupId: String(candidate?.meta?.setupId || existing.setupId),
    parentSetupId: candidate?.meta?.parentSetupId || existing.parentSetupId || null,
    observationCount: Math.max(Number(existing.observationCount ?? 0), Number(candidate?.meta?.setupObservationCount ?? 0)),
    selectedCount: Number(existing.selectedCount ?? 0) + 1,
    previewCount: Number(existing.previewCount ?? 0) + (provisional ? 1 : 0),
    confirmedCount: Number(existing.confirmedCount ?? 0) + (provisional ? 0 : 1),
    status: provisional ? "armed" : "fired",
    setupState: provisional ? "armed" : "fired",
    lastConfirmedTs: provisional ? Number(existing.lastConfirmedTs) : currentTs,
    firedAtBar: provisional ? Number(existing.firedAtBar) : currentTs,
    resetConditionMet: false,
    resetReason: null,
  });
  setupRegistry.set(setupKey, next);

  const snapshotKey = mtfSnapshotKey(Number(context.instrument_token), Number(context.intervalMin ?? 0));
  if (snapshotKey) {
    intervalSnapshots.set(snapshotKey, {
      token: Number(context.instrument_token),
      intervalMin: Number(context.intervalMin ?? 0),
      ts: currentTs,
      side: String(candidate?.side || ""),
      strategyId: String(candidate?.strategyId || ""),
      strategyStyle: String(candidate?.strategyStyle || ""),
      strategyFamily: String(candidate?.strategyFamily || ""),
      marketState: String(candidate?.marketState || candidate?.meta?.marketState || ""),
      marketStateFamily: String(
        candidate?.marketStateFamily || candidate?.meta?.marketStateFamily || "",
      ),
      setupId: String(candidate?.meta?.setupId || existing.setupId),
      lineageId: String(candidate?.meta?.lineageId || existing.lineageId || ""),
      finalSignalScore: Number(candidate?.finalSignalScore ?? 0),
      normalizedConfidence: Number(candidate?.normalizedConfidence ?? 0),
      rawConfidence: Number(candidate?.rawConfidence ?? candidate?.confidence ?? 0),
      signalStage,
      setupState: provisional ? "armed" : "fired",
      status: provisional ? "armed" : "fired",
      isProvisional: provisional,
    });
  }
  persistSignalLayerState(currentTs);
}

function resetSignalLayerState() {
  ensureSignalLayerStateReady();
  setupRegistry.clear();
  intervalSnapshots.clear();
  updatePersistenceState({
    restoredSetupCount: 0,
    restoredSnapshotCount: 0,
    prunedSetupCount: 0,
    prunedSnapshotCount: 0,
    restoreSource:
      statePersistenceConfig().enabled === true
        ? "file:reset"
        : "memory:reset",
    restoredAt: new Date().toISOString(),
    fallbackReason: null,
  });
  persistSignalLayerState(Date.now());
}

function getSetupRegistrySnapshot() {
  ensureSignalLayerStateReady();
  return Array.from(setupRegistry.entries()).map(([key, value]) => ({ key, ...value }));
}

function getIntervalSnapshots() {
  ensureSignalLayerStateReady();
  return Array.from(intervalSnapshots.entries()).map(([key, value]) => ({ key, ...value }));
}

function lookupStrategyState({ token, intervalMin, strategyId }) {
  ensureSignalLayerStateReady();
  const candidates = Array.from(setupRegistry.values()).filter((state) => {
    return (
      Number(state?.token) === Number(token) &&
      Number(state?.intervalMin) === Number(intervalMin) &&
      String(state?.strategyId || "") === String(strategyId || "") &&
      isActiveSetupState(state?.setupState || state?.status)
    );
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.lastSeenTs ?? 0) - Number(a.lastSeenTs ?? 0));
  return { ...candidates[0] };
}

function describeSignalLayerPersistence() {
  ensureSignalLayerStateReady();
  return { ...signalLayerPersistenceState };
}

function getSignalLayerStateSnapshot() {
  ensureSignalLayerStateReady();
  return {
    persistence: describeSignalLayerPersistence(),
    setupRegistry: getSetupRegistrySnapshot(),
    intervalSnapshots: getIntervalSnapshots(),
  };
}

module.exports = {
  normalizeStrategyConfidence,
  decorateSignalCandidate,
  applySetupLifecycle,
  rememberFiredSignal,
  lookupStrategyState,
  resetSignalLayerState,
  describeSignalLayerPersistence,
  getSignalLayerStateSnapshot,
  __debug: {
    buildFingerprint,
    buildScoreBreakdown,
    readMtfAgreement,
    evaluateLevelAcceptance,
    computeDangerStack,
    resolveAdaptiveThresholds,
    resolveProductAdaptation,
    evaluateRetryGovernor,
    resetRetryGovernor,
    getRetryGovernorSnapshot,
    getSetupRegistrySnapshot,
    getIntervalSnapshots,
    describeSignalLayerPersistence,
    getSignalLayerStateSnapshot,
  },
};
