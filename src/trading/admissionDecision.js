const {
  getAdmissionProfile,
  normalizeAdmissionFamily,
  normalizeAdmissionStyle,
} = require("./admissionProfiles");
const {
  DEFAULT_ADMISSION_THRESHOLDS,
  resolveAdmissionThresholds,
} = require("./admissionThresholds");
const {
  premiumReadinessStaleAfterMs,
} = require("./planPremiumCache");
const { getStrategyMeta } = require("../strategy/registry");

function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTsMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function quoteTimestamp(quote = {}, contractMetrics = {}) {
  return (
    quote?.ts ||
    quote?.timestamp ||
    quote?.quoteTs ||
    contractMetrics?.quoteTs ||
    contractMetrics?.quoteTimestamp ||
    null
  );
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function resolveAdmissionIntervalMin(snapshot = {}) {
  const intervalMin = toFiniteOrNull(
    snapshot?.premiumPlanData?.intervalMin ??
      snapshot?.optionMeta?.premiumContext?.intervalMin ??
      snapshot?.optionMeta?.meta?.premiumContext?.intervalMin ??
      snapshot?.signal?.intervalMin ??
      snapshot?.signal?.candle?.interval_min ??
      snapshot?.timeframeMin ??
      snapshot?.baseSnapshot?.timeframeMin,
  );
  return Math.max(1, intervalMin ?? 1);
}

function resolveAdmissionSignalTsMs(snapshot = {}) {
  const signalCreatedAtMs = toTsMs(
    snapshot?.signal?.signalCreatedAt ||
      snapshot?.signal?.entryPipeline?.signalCreatedAt ||
      snapshot?.signal?.timing?.signalCreatedAt ||
      snapshot?.signalCreatedAt ||
      snapshot?.baseSnapshot?.signalCreatedAt,
  );
  if (Number.isFinite(signalCreatedAtMs)) {
    return {
      tsMs: signalCreatedAtMs,
      source: "signalCreatedAt",
      staleEligible: true,
    };
  }

  const signalDecisionTsMs = toTsMs(
    snapshot?.signal?.signalDecisionTs ||
      snapshot?.signal?.entryPipeline?.signalDecisionTs ||
      snapshot?.signal?.timing?.signalDecisionTs ||
      snapshot?.signalDecisionTs ||
      snapshot?.baseSnapshot?.signalDecisionTs,
  );
  if (Number.isFinite(signalDecisionTsMs)) {
    return {
      tsMs: signalDecisionTsMs,
      source: "signalDecisionTs",
      staleEligible: true,
    };
  }

  const candleTsMs = toTsMs(
    snapshot?.signal?.candle?.ts ||
      snapshot?.candle?.ts ||
      snapshot?.signal?.ts ||
      snapshot?.ts,
  );
  const signalEventTsMs = toTsMs(
    snapshot?.signal?.signalEventTs ||
      snapshot?.signal?.timing?.signalEventTs ||
      snapshot?.signalEventTs ||
      snapshot?.baseSnapshot?.signalEventTs,
  );
  const eventLooksCandleAligned =
    Number.isFinite(signalEventTsMs) &&
    Number.isFinite(candleTsMs) &&
    signalEventTsMs === candleTsMs;

  if (Number.isFinite(signalEventTsMs) && !eventLooksCandleAligned) {
    return {
      tsMs: signalEventTsMs,
      source: "signalEventTs",
      staleEligible: true,
    };
  }

  const weakFallbackTsMs = Number.isFinite(candleTsMs) ? candleTsMs : signalEventTsMs;
  if (Number.isFinite(weakFallbackTsMs)) {
    return {
      tsMs: weakFallbackTsMs + resolveAdmissionIntervalMin(snapshot) * 60_000,
      source: "candleTs_fallback",
      staleEligible: false,
    };
  }

  return {
    tsMs: null,
    source: null,
    staleEligible: false,
  };
}

function resolveAdmissionPremiumFreshness(snapshot = {}) {
  const premiumPlanStaleAfterMs = toFiniteOrNull(snapshot?.premiumPlanData?.staleAfterMs);
  if (Number.isFinite(premiumPlanStaleAfterMs) && premiumPlanStaleAfterMs > 0) {
    return {
      staleAfterMs: premiumPlanStaleAfterMs,
      thresholdSource: "premiumPlanData.staleAfterMs",
    };
  }

  const premiumContextStaleAfterMs = toFiniteOrNull(
    snapshot?.optionMeta?.premiumContext?.staleAfterMs,
  );
  if (Number.isFinite(premiumContextStaleAfterMs) && premiumContextStaleAfterMs > 0) {
    return {
      staleAfterMs: premiumContextStaleAfterMs,
      thresholdSource: "optionMeta.premiumContext.staleAfterMs",
    };
  }

  const legacyPremiumContextStaleAfterMs = toFiniteOrNull(
    snapshot?.optionMeta?.meta?.premiumContext?.staleAfterMs,
  );
  if (
    Number.isFinite(legacyPremiumContextStaleAfterMs) &&
    legacyPremiumContextStaleAfterMs > 0
  ) {
    return {
      staleAfterMs: legacyPremiumContextStaleAfterMs,
      thresholdSource: "optionMeta.meta.premiumContext.staleAfterMs",
    };
  }

  return {
    staleAfterMs: premiumReadinessStaleAfterMs(resolveAdmissionIntervalMin(snapshot)),
    thresholdSource: "interval_aware_fallback",
  };
}

function resolveFamily({ strategyId, signal, profile }) {
  const direct = normalizeAdmissionFamily(
    signal?.strategyFamily ||
      signal?.family ||
      signal?.meta?.family ||
      profile?.family ||
      strategyId ||
      getStrategyMeta(strategyId)?.family,
  );
  if (direct !== "generic") return direct;
  const triggerType = String(
    signal?.meta?.triggerType || signal?.triggerType || "",
  ).toUpperCase();
  if (triggerType.includes("BREAKOUT") || triggerType.includes("BREAKDOWN")) {
    return "breakout";
  }
  if (triggerType.includes("VWAP")) return "vwap_reclaim";
  return direct;
}

function resolveStructureReady(signal = {}, plan = null) {
  const meta = signal?.meta || {};
  const setup = plan?.meta?.setup || {};
  return Boolean(
    Number.isFinite(Number(meta?.rangeHigh ?? setup?.rangeHigh)) ||
      Number.isFinite(Number(meta?.rangeLow ?? setup?.rangeLow)) ||
      Number.isFinite(Number(meta?.pullbackAnchor ?? setup?.pullbackAnchor)) ||
      Number.isFinite(Number(meta?.trendAnchor ?? setup?.trendAnchor)) ||
      Number.isFinite(Number(meta?.brokenLevel ?? setup?.brokenLevel)) ||
      Number.isFinite(Number(meta?.wickExtreme ?? setup?.wickExtreme)) ||
      Number.isFinite(Number(meta?.anchorValue ?? setup?.anchorValue)),
  );
}

function bucketConfidenceGap(value) {
  const thresholds = DEFAULT_ADMISSION_THRESHOLDS.confidenceGapBuckets;
  const gap = toFiniteOrNull(value);
  if (!(gap > 0)) return "NONE";
  if (gap <= thresholds.tightMax) return "TIGHT";
  if (gap <= thresholds.smallMax) return "SMALL";
  if (gap <= thresholds.nearThresholdMax) return "NEAR_THRESHOLD";
  return "WIDE";
}

function bucketFreshness(value) {
  const thresholds = DEFAULT_ADMISSION_THRESHOLDS.freshnessBuckets;
  const freshness = toFiniteOrNull(value);
  if (freshness == null) return "UNKNOWN";
  if (freshness >= thresholds.freshMin) return "FRESH";
  if (freshness >= thresholds.goodMin) return "GOOD";
  if (freshness >= thresholds.agingMin) return "AGING";
  return "STALE";
}

function bucketMismatchStrength(value, weakLimit = 22) {
  const thresholds = DEFAULT_ADMISSION_THRESHOLDS.mismatchBuckets;
  const strength = toFiniteOrNull(value);
  if (!(strength > 0)) return "NONE";
  if (strength <= Math.max(thresholds.weakFloor, weakLimit * thresholds.weakFactor)) {
    return "WEAK";
  }
  if (strength <= weakLimit) return "MODERATE";
  return "STRONG";
}

function bucketSpread(value, maxSpreadBps = null) {
  const thresholds = resolveAdmissionThresholds().routeQuality;
  const spread = toFiniteOrNull(value);
  if (spread == null || spread < 0) return "UNKNOWN";
  const effectiveMaxSpreadBps =
    toFiniteOrNull(maxSpreadBps) ?? thresholds.maxSpreadBps;
  if (spread <= effectiveMaxSpreadBps * thresholds.spreadTightFactor) return "TIGHT";
  if (spread <= effectiveMaxSpreadBps) return "ACCEPTABLE";
  if (spread <= effectiveMaxSpreadBps * thresholds.spreadElevatedFactor) {
    return "ELEVATED";
  }
  return "WIDE";
}

function bucketHealth(value, minHealth = null) {
  const thresholds = resolveAdmissionThresholds().routeQuality;
  const score = toFiniteOrNull(value);
  if (score == null || score < 0) return "UNKNOWN";
  const effectiveMinHealth = toFiniteOrNull(minHealth) ?? thresholds.minHealthScore;
  if (score >= effectiveMinHealth + thresholds.healthStrongBuffer) return "STRONG";
  if (score >= effectiveMinHealth + thresholds.healthGoodBuffer) return "GOOD";
  if (score >= effectiveMinHealth) return "MARGINAL";
  return "WEAK";
}

function bucketDepth(value, minDepth = null) {
  const thresholds = resolveAdmissionThresholds().routeQuality;
  const depth = toFiniteOrNull(value);
  if (depth == null || depth < 0) return "UNKNOWN";
  const effectiveMinDepth = toFiniteOrNull(minDepth) ?? thresholds.minDepth;
  if (depth >= effectiveMinDepth * thresholds.depthDeepMultiplier) return "DEEP";
  if (depth >= effectiveMinDepth) return "ADEQUATE";
  if (depth >= Math.max(1, effectiveMinDepth * thresholds.depthThinFactor)) {
    return "THIN";
  }
  return "POOR";
}

function bucketContractQuality({
  spreadBps,
  healthScore,
  depth,
  selectedByFallback,
  eligibilityPassed,
  minEligibilityChecksPassed,
  maxSpreadBps = null,
  minHealth = null,
  minDepth = null,
}) {
  const thresholds = resolveAdmissionThresholds().routeQuality;
  if (eligibilityPassed === false || minEligibilityChecksPassed === false) {
    return "FAILED_ELIGIBILITY";
  }
  const spreadBucket = bucketSpread(
    spreadBps,
    toFiniteOrNull(maxSpreadBps) ?? thresholds.maxSpreadBps,
  );
  const healthBucket = bucketHealth(
    healthScore,
    toFiniteOrNull(minHealth) ?? thresholds.minHealthScore,
  );
  const depthBucket = bucketDepth(
    depth,
    toFiniteOrNull(minDepth) ?? thresholds.minDepth,
  );
  if (
    spreadBucket === "WIDE" ||
    healthBucket === "WEAK" ||
    depthBucket === "POOR"
  ) {
    return selectedByFallback ? "WEAK_FALLBACK" : "POOR";
  }
  if (selectedByFallback) return "FALLBACK";
  if (
    spreadBucket === "TIGHT" &&
    (healthBucket === "STRONG" || healthBucket === "GOOD") &&
    (depthBucket === "DEEP" || depthBucket === "ADEQUATE")
  ) {
    return "CLEAN";
  }
  return "USABLE";
}

function evaluateAdmissionReadiness({ snapshot, profile, env = {} }) {
  const cfg = {
    signalStaleMs: Math.max(
      15_000,
      Number(env?.ADMISSION_SIGNAL_STALE_MS ?? env?.MAX_EXECUTION_AGE_MS ?? 60_000),
    ),
    regimeStaleMs: Math.max(
      30_000,
      Number(env?.ADMISSION_REGIME_STALE_MS ?? 180_000),
    ),
    quoteStaleMs: Math.max(
      5_000,
      Number(env?.ADMISSION_QUOTE_STALE_MS ?? 15_000),
    ),
    // ADMISSION_PREMIUM_STALE_MS is only the admission aging threshold.
    // True premium stale authority comes from premium readiness or aligned staleAfterMs.
    premiumAgingThresholdMs: Math.max(
      30_000,
      Number(env?.ADMISSION_PREMIUM_STALE_MS ?? 180_000),
    ),
  };

  const snapshotTs = Number(snapshot?.snapshotTs ?? snapshot?.nowTs) || Date.now();
  const stageNowMs =
    Number(snapshot?.stageEvaluatedAt ?? snapshot?.nowTs) || Date.now();
  const signalFreshness = resolveAdmissionSignalTsMs(snapshot);
  const regimeTsMs = toTsMs(snapshot?.regimeSnapshotTs);
  const quoteTsMs = toTsMs(snapshot?.quoteTs);
  const premiumTsMs = toTsMs(
    snapshot?.premiumPlanData?.lastCandleTs ||
      snapshot?.optionMeta?.premiumContext?.lastCandleTs ||
      snapshot?.optionMeta?.meta?.premiumContext?.lastCandleTs,
  );
  const premiumFreshness = resolveAdmissionPremiumFreshness(snapshot);
  const premiumAgingThresholdMs = Math.min(
    premiumFreshness.staleAfterMs,
    cfg.premiumAgingThresholdMs,
  );
  const premiumReadiness = String(snapshot?.premiumReadinessState || "")
    .trim()
    .toLowerCase();

  const signalAgeMs =
    Number.isFinite(signalFreshness.tsMs)
      ? Math.max(0, stageNowMs - signalFreshness.tsMs)
      : null;
  const regimeAgeMs =
    Number.isFinite(regimeTsMs) ? Math.max(0, stageNowMs - regimeTsMs) : null;
  const quoteAgeMs =
    Number.isFinite(quoteTsMs) ? Math.max(0, stageNowMs - quoteTsMs) : null;
  const premiumAgeMs =
    Number.isFinite(premiumTsMs) ? Math.max(0, stageNowMs - premiumTsMs) : null;

  const blockers = [];
  const degradedBy = [];

  if (profile?.requiresPlannerContextTrio) {
    if (!Number.isFinite(Number(snapshot?.triggerLevel))) {
      pushUnique(blockers, "MISSING_TRIGGER");
    }
    if (!Number.isFinite(Number(snapshot?.anchorValue))) {
      pushUnique(blockers, "MISSING_ANCHOR");
    }
    if (snapshot?.structureReady !== true) {
      pushUnique(blockers, "MISSING_STRUCTURE");
    }
  }

  if (
    signalFreshness.staleEligible &&
    Number.isFinite(signalAgeMs) &&
    signalAgeMs > cfg.signalStaleMs * 2
  ) {
    pushUnique(blockers, "SIGNAL_STALE");
  } else if (Number.isFinite(signalAgeMs) && signalAgeMs > cfg.signalStaleMs) {
    pushUnique(degradedBy, "SIGNAL_AGING");
  }

  if (Number.isFinite(regimeAgeMs) && regimeAgeMs > cfg.regimeStaleMs * 2) {
    pushUnique(blockers, "REGIME_SNAPSHOT_STALE");
  } else if (Number.isFinite(regimeAgeMs) && regimeAgeMs > cfg.regimeStaleMs) {
    pushUnique(degradedBy, "REGIME_SNAPSHOT_AGING");
  }

  if (Number.isFinite(quoteAgeMs) && quoteAgeMs > cfg.quoteStaleMs * 3) {
    pushUnique(blockers, "QUOTE_STALE");
  } else if (Number.isFinite(quoteAgeMs) && quoteAgeMs > cfg.quoteStaleMs) {
    pushUnique(degradedBy, "QUOTE_AGING");
  }

  let premiumStaleSource = null;
  if (premiumReadiness === "unavailable") {
    pushUnique(degradedBy, "PREMIUM_CONTEXT_UNAVAILABLE");
  } else if (premiumReadiness === "partial") {
    pushUnique(degradedBy, "PREMIUM_CONTEXT_DEGRADED");
  }

  if (premiumReadiness === "stale") {
    premiumStaleSource = "premium_readiness_state";
    pushUnique(blockers, "PREMIUM_CONTEXT_STALE");
  } else if (
    Number.isFinite(premiumAgeMs) &&
    premiumAgeMs > premiumFreshness.staleAfterMs
  ) {
    premiumStaleSource = "interval_aware_age_check";
    pushUnique(blockers, "PREMIUM_CONTEXT_STALE");
  } else if (
    Number.isFinite(premiumAgeMs) &&
    premiumAgeMs > premiumAgingThresholdMs
  ) {
    pushUnique(degradedBy, "PREMIUM_CONTEXT_AGING");
  }

  const hasIncomplete = blockers.some((reason) => reason.startsWith("MISSING_"));
  const staleOverages = [
    Number.isFinite(signalAgeMs) ? Math.max(0, signalAgeMs - cfg.signalStaleMs) : null,
    Number.isFinite(regimeAgeMs) ? Math.max(0, regimeAgeMs - cfg.regimeStaleMs) : null,
    Number.isFinite(quoteAgeMs) ? Math.max(0, quoteAgeMs - cfg.quoteStaleMs) : null,
    Number.isFinite(premiumAgeMs)
      ? Math.max(0, premiumAgeMs - premiumFreshness.staleAfterMs)
      : null,
  ].filter((value) => Number.isFinite(value));
  const state = hasIncomplete
    ? "BLOCKED_INCOMPLETE"
    : blockers.length
      ? "BLOCKED_STALE"
      : degradedBy.length
        ? "READY_DEGRADED"
        : "READY";

  return Object.freeze({
    state,
    reasonCode:
      state === "BLOCKED_INCOMPLETE"
        ? "ADMISSION_SNAPSHOT_INCOMPLETE"
        : state === "BLOCKED_STALE"
          ? "ADMISSION_SNAPSHOT_STALE"
          : null,
    blockers,
    degradedBy,
    snapshotTs,
    stageEvaluatedAt: stageNowMs,
    signalAgeMs,
    signalTsSource: signalFreshness.source,
    regimeAgeMs,
    quoteAgeMs,
    premiumAgeMs,
    premiumAgingThresholdMs,
    premiumStaleAfterMs: premiumFreshness.staleAfterMs,
    premiumStaleThresholdSource: premiumFreshness.thresholdSource,
    premiumStaleSource,
    staleByMs: staleOverages.length ? Math.max(...staleOverages) : 0,
  });
}

function extractBaseAdmissionSnapshot(snapshot = {}) {
  const base = {
    signalId: snapshot?.signalId || null,
    strategyId: snapshot?.strategyId || null,
    family: snapshot?.family || null,
    style: snapshot?.style || null,
    side: snapshot?.side || null,
    timeframeMin: toFiniteOrNull(snapshot?.timeframeMin),
    profile: snapshot?.profile || null,
    signalCreatedAt: snapshot?.signalCreatedAt || null,
    signalEventTs: snapshot?.signalEventTs || null,
    regime: snapshot?.regime || null,
    regimeFamily: snapshot?.regimeFamily || null,
    primaryRegime: snapshot?.primaryRegime || null,
    secondaryRegime: snapshot?.secondaryRegime || null,
    compressionActive: snapshot?.compressionActive === true,
    regimeSnapshotId: snapshot?.regimeSnapshotId || null,
    regimeSnapshotTs: snapshot?.regimeSnapshotTs || null,
    triggerType: snapshot?.triggerType || null,
    triggerLevel: toFiniteOrNull(snapshot?.triggerLevel),
    anchorType: snapshot?.anchorType || null,
    anchorValue: toFiniteOrNull(snapshot?.anchorValue),
    structureReady: snapshot?.structureReady === true,
    retestState: snapshot?.retestState || null,
    setupState: snapshot?.setupState || null,
    freshness: toFiniteOrNull(snapshot?.freshness),
    snapshotTs: Number(snapshot?.snapshotTs ?? snapshot?.nowTs) || Date.now(),
  };
  return Object.freeze(base);
}

function buildStageAdmissionSnapshot({
  baseSnapshot,
  signal = null,
  quote = null,
  premiumPlanData = null,
  plan = null,
  routeConfidence = null,
  nowTs = null,
  profile = null,
  env = {},
}) {
  const core = baseSnapshot?.baseSnapshot || baseSnapshot || {};
  const resolvedProfile =
    profile ||
    core?.profile ||
    getAdmissionProfile(core?.strategyId, core?.style);
  const nextSignal = signal || null;
  const nextRouteConfidence = routeConfidence || nextSignal?.routeConfidence || null;
  const contractMetrics = nextRouteConfidence?.contractMetrics || {};
  const optionMeta = nextSignal?.option_meta || null;
  const spreadBps = toFiniteOrNull(
    contractMetrics?.spreadBps ?? optionMeta?.bps ?? quote?.bps,
  );
  const healthScore = toFiniteOrNull(
    contractMetrics?.healthScore ?? optionMeta?.health_score,
  );
  const depth = toFiniteOrNull(contractMetrics?.depth ?? optionMeta?.depth);
  const deltaTarget = toFiniteOrNull(contractMetrics?.deltaTarget);
  const deltaUsed = toFiniteOrNull(contractMetrics?.deltaUsed);
  const routedScore = toFiniteOrNull(
    nextRouteConfidence?.routedScore ?? nextSignal?.confidence,
  );
  const preRouteScore = toFiniteOrNull(nextRouteConfidence?.preRouteScore);
  const confidenceGap =
    preRouteScore != null && routedScore != null
      ? Math.abs(preRouteScore - routedScore)
      : null;
  const selectedByFallback =
    contractMetrics?.selectedByFallback === true ||
    optionMeta?.meta?.selectionObservability?.selectedByFallback === true ||
    optionMeta?.meta?.selectionPath?.selectedByFallback === true;
  const eligibilityPassed =
    typeof contractMetrics?.eligibilityPassed === "boolean"
      ? contractMetrics.eligibilityPassed
      : optionMeta?.meta?.selectionObservability?.eligibilityPassed;
  const minEligibilityChecksPassed =
    typeof contractMetrics?.minEligibilityChecksPassed === "boolean"
      ? contractMetrics.minEligibilityChecksPassed
      : optionMeta?.meta?.selectionObservability?.minEligibilityChecksPassed;

  const snapshot = {
    ...core,
    baseSnapshot: core,
    signal: nextSignal,
    profile: resolvedProfile,
    routeConfidence: nextRouteConfidence,
    contractMetrics,
    spreadBps,
    healthScore,
    depth,
    deltaTarget,
    deltaUsed,
    preRouteScore,
    routedScore,
    confidenceGap,
    selectedByFallback,
    eligibilityPassed,
    minEligibilityChecksPassed,
    quoteTs: quoteTimestamp(quote, contractMetrics),
    optionMeta,
    optionRouted: Boolean(optionMeta?.instrument_token),
    premiumReadinessState:
      premiumPlanData?.readinessState ||
      optionMeta?.premiumContext?.readinessState ||
      optionMeta?.meta?.premiumContext?.readinessState ||
      null,
    premiumLastCandleTs:
      premiumPlanData?.lastCandleTs ||
      optionMeta?.premiumContext?.lastCandleTs ||
      optionMeta?.meta?.premiumContext?.lastCandleTs ||
      null,
    premiumPlanData: premiumPlanData || null,
    plannerPathUsed: plan?.meta?.plannerPathUsed || null,
    softPassUsed:
      plan?.meta?.plannerTelemetry?.softPassUsed === true ||
      plan?.meta?.softPassUsed === true,
    transitionPassUsed:
      plan?.meta?.plannerTelemetry?.transitionPassUsed === true ||
      plan?.meta?.transitionPassUsed === true,
    plan: plan || null,
    snapshotTs: Number(core?.snapshotTs) || Date.now(),
    nowTs: Number(core?.snapshotTs) || Date.now(),
    stageEvaluatedAt: Number(nowTs) || Date.now(),
  };
  const thresholdSet = resolveAdmissionThresholds({
    config: env,
    profile: resolvedProfile,
  });
  snapshot.readiness = evaluateAdmissionReadiness({
    snapshot,
    profile: resolvedProfile,
    env,
  });
  snapshot.contractQualityBucket = bucketContractQuality({
    spreadBps: snapshot.spreadBps,
    healthScore: snapshot.healthScore,
    depth: snapshot.depth,
    selectedByFallback: snapshot.selectedByFallback,
    eligibilityPassed: snapshot.eligibilityPassed,
    minEligibilityChecksPassed: snapshot.minEligibilityChecksPassed,
    maxSpreadBps: thresholdSet.routeQuality.maxSpreadBps,
    minHealth: thresholdSet.routeQuality.minHealthScore,
    minDepth: thresholdSet.routeQuality.minDepth,
  });
  snapshot.spreadBucket = bucketSpread(
    snapshot.spreadBps,
    thresholdSet.routeQuality.maxSpreadBps,
  );
  snapshot.healthBucket = bucketHealth(
    snapshot.healthScore,
    thresholdSet.routeQuality.minHealthScore,
  );
  snapshot.depthBucket = bucketDepth(
    snapshot.depth,
    thresholdSet.routeQuality.minDepth,
  );
  snapshot.confidenceGapBucket = bucketConfidenceGap(snapshot.confidenceGap);
  snapshot.freshnessBucket = bucketFreshness(snapshot.freshness);

  return Object.freeze(snapshot);
}

function plannerLegacyFallbackSupported(snapshot = null) {
  const family = normalizeAdmissionFamily(snapshot?.family);
  const fallbackStrictness = String(
    snapshot?.profile?.fallbackStrictness || "LEGACY_OK",
  )
    .trim()
    .toUpperCase();
  return family === "generic" || fallbackStrictness !== "STRICT";
}

function resolveTerminalState({ outcome, stage, reason, meta = {} }) {
  if (outcome === "BLOCKED") {
    return {
      terminalOutcome: "BLOCKED",
      terminalReasonCode: reason || null,
      terminalCategory: decisionCategory({ outcome, stage, reason, meta }),
    };
  }
  if (outcome === "READY_FOR_EXECUTION" || outcome === "ENTRY_PLACED") {
    return {
      terminalOutcome: "ACCEPTED",
      terminalReasonCode: reason || null,
      terminalCategory: "ACCEPTED",
    };
  }
  if (outcome === "ADJUSTED") {
    return {
      terminalOutcome: "ADJUSTED_PASS",
      terminalReasonCode: reason || null,
      terminalCategory: "ADJUSTED_PASS",
    };
  }
  return null;
}

function finalizeDecisionReason(current = {}, next = null) {
  if (!next) return current;
  if (next.terminalOutcome === "BLOCKED") return next;
  if (next.terminalOutcome === "ACCEPTED") {
    if (current?.terminalOutcome === "BLOCKED") return current;
    return next;
  }
  if (!current?.terminalOutcome) return next;
  return current;
}

function buildAdmissionContext({
  signal = null,
  regimeMeta = null,
  quote = null,
  premiumPlanData = null,
  plan = null,
  prior = null,
  baseSnapshot = null,
  nowTs = Date.now(),
  profile = null,
  env = {},
}) {
  const inheritedBaseSnapshot = baseSnapshot || prior?.baseSnapshot || null;
  if (inheritedBaseSnapshot) {
    return buildStageAdmissionSnapshot({
      baseSnapshot: inheritedBaseSnapshot,
      signal,
      quote,
      premiumPlanData,
      plan,
      routeConfidence: signal?.routeConfidence || prior?.routeConfidence || null,
      nowTs,
      profile,
      env,
    });
  }

  const activePlan = plan || prior?.plan || null;
  const nextSignal = signal || prior?.signal || null;
  const strategyId = String(
    nextSignal?.strategyId || activePlan?.meta?.setup?.strategyId || prior?.strategyId || "",
  )
    .trim()
    .toLowerCase();
  const resolvedProfile =
    profile ||
    prior?.profile ||
    getAdmissionProfile(strategyId, nextSignal?.strategyStyle || plan?.meta?.setup?.style);
  const signalMeta = nextSignal?.meta || {};
  const routeConfidence =
    nextSignal?.routeConfidence || prior?.routeConfidence || null;
  const contractMetrics = routeConfidence?.contractMetrics || {};
  const optionMeta = nextSignal?.option_meta || prior?.optionMeta || null;
  const regimeSnapshot = nextSignal?.regimeSnapshot || prior?.regimeSnapshot || null;
  const setup = activePlan?.meta?.setup || {};
  const family = resolveFamily({
    strategyId,
    signal: nextSignal,
    profile: resolvedProfile,
  });
  const style = normalizeAdmissionStyle(
    nextSignal?.strategyStyle || setup?.style || resolvedProfile?.style,
  );
  const spreadBps = toFiniteOrNull(
    contractMetrics?.spreadBps ?? optionMeta?.bps ?? quote?.bps,
  );
  const healthScore = toFiniteOrNull(
    contractMetrics?.healthScore ?? optionMeta?.health_score,
  );
  const depth = toFiniteOrNull(contractMetrics?.depth ?? optionMeta?.depth);
  const deltaTarget = toFiniteOrNull(contractMetrics?.deltaTarget);
  const deltaUsed = toFiniteOrNull(contractMetrics?.deltaUsed);
  const confidenceGap = toFiniteOrNull(
    contractMetrics?.confidenceGap ??
      (toFiniteOrNull(nextSignal?.routeConfidence?.preRouteScore) != null &&
      toFiniteOrNull(nextSignal?.confidence) != null
        ? Math.abs(
            toFiniteOrNull(nextSignal.routeConfidence.preRouteScore) -
              toFiniteOrNull(nextSignal.confidence),
          )
        : null),
  );
  const snapshot = {
    signalId: nextSignal?.signalId || prior?.signalId || null,
    strategyId: strategyId || null,
    family,
    style,
    side: String(nextSignal?.side || prior?.side || "").toUpperCase() || null,
    timeframeMin: toFiniteOrNull(
      nextSignal?.intervalMin || nextSignal?.candle?.interval_min || prior?.timeframeMin,
    ),
    signal: nextSignal,
    profile: resolvedProfile,
    signalCreatedAt: nextSignal?.signalCreatedAt || prior?.signalCreatedAt || null,
    signalEventTs:
      nextSignal?.signalEventTs ||
      nextSignal?.candle?.ts ||
      nextSignal?.ts ||
      prior?.signalEventTs ||
      null,
    regime: regimeMeta?.regime || regimeSnapshot?.regime || prior?.regime || nextSignal?.regime || null,
    regimeFamily:
      regimeMeta?.regimeFamily ||
      regimeSnapshot?.regimeFamily ||
      prior?.regimeFamily ||
      null,
    primaryRegime:
      regimeMeta?.primaryRegime ||
      regimeSnapshot?.primaryRegime ||
      prior?.primaryRegime ||
      null,
    secondaryRegime:
      regimeMeta?.secondaryRegime ||
      regimeSnapshot?.secondaryRegime ||
      prior?.secondaryRegime ||
      null,
    compressionActive:
      regimeMeta?.compressionActive === true ||
      regimeSnapshot?.compressionActive === true ||
      prior?.compressionActive === true,
    regimeSnapshotId:
      regimeMeta?.regimeSnapshotId ||
      regimeSnapshot?.snapshotId ||
      prior?.regimeSnapshotId ||
      null,
    regimeSnapshotTs:
      regimeMeta?.regimeSnapshotTs ||
      regimeSnapshot?.timestamp ||
      prior?.regimeSnapshotTs ||
      null,
    triggerType:
      setup?.triggerType ||
      signalMeta?.triggerType ||
      nextSignal?.triggerType ||
      prior?.triggerType ||
      null,
    triggerLevel: toFiniteOrNull(
      setup?.triggerLevel ??
        signalMeta?.triggerLevel ??
        nextSignal?.triggerLevel ??
        prior?.triggerLevel,
    ),
    anchorType:
      setup?.anchorType ||
      signalMeta?.anchorType ||
      nextSignal?.anchorType ||
      prior?.anchorType ||
      null,
    anchorValue: toFiniteOrNull(
      setup?.anchorValue ??
        signalMeta?.anchorValue ??
        nextSignal?.anchorValue ??
        prior?.anchorValue,
    ),
    structureReady: resolveStructureReady(nextSignal, plan),
    retestState:
      setup?.retestState || signalMeta?.retestState || prior?.retestState || null,
    setupState:
      setup?.setupState || nextSignal?.setupState || signalMeta?.setupState || prior?.setupState || null,
    freshness: toFiniteOrNull(signalMeta?.freshness ?? prior?.freshness),
    preRouteScore: toFiniteOrNull(routeConfidence?.preRouteScore),
    routedScore: toFiniteOrNull(routeConfidence?.routedScore ?? nextSignal?.confidence),
    confidenceGap: confidenceGap,
    routeConfidence,
    contractMetrics,
    spreadBps,
    healthScore,
    depth,
    selectedByFallback:
      contractMetrics?.selectedByFallback === true ||
      optionMeta?.meta?.selectionObservability?.selectedByFallback === true ||
      optionMeta?.meta?.selectionPath?.selectedByFallback === true,
    eligibilityPassed:
      typeof contractMetrics?.eligibilityPassed === "boolean"
        ? contractMetrics.eligibilityPassed
        : optionMeta?.meta?.selectionObservability?.eligibilityPassed,
    minEligibilityChecksPassed:
      typeof contractMetrics?.minEligibilityChecksPassed === "boolean"
        ? contractMetrics.minEligibilityChecksPassed
        : optionMeta?.meta?.selectionObservability?.minEligibilityChecksPassed,
    deltaTarget,
    deltaUsed,
    quoteTs: quoteTimestamp(quote, contractMetrics),
    optionMeta,
    optionRouted: Boolean(optionMeta?.instrument_token),
    premiumReadinessState:
      premiumPlanData?.readinessState ||
      optionMeta?.premiumContext?.readinessState ||
      optionMeta?.meta?.premiumContext?.readinessState ||
      prior?.premiumReadinessState ||
      null,
    premiumLastCandleTs:
      premiumPlanData?.lastCandleTs ||
      optionMeta?.premiumContext?.lastCandleTs ||
      optionMeta?.meta?.premiumContext?.lastCandleTs ||
      prior?.premiumLastCandleTs ||
      null,
    premiumPlanData: premiumPlanData || prior?.premiumPlanData || null,
    plannerPathUsed: activePlan?.meta?.plannerPathUsed || prior?.plannerPathUsed || null,
    softPassUsed:
      activePlan?.meta?.plannerTelemetry?.softPassUsed === true ||
      prior?.softPassUsed === true,
    transitionPassUsed:
      activePlan?.meta?.plannerTelemetry?.transitionPassUsed === true ||
      prior?.transitionPassUsed === true,
    plan: activePlan,
    snapshotTs: Number(nowTs) || Date.now(),
    nowTs: Number(nowTs) || Date.now(),
    stageEvaluatedAt: Number(nowTs) || Date.now(),
  };
  const thresholdSet = resolveAdmissionThresholds({
    config: env,
    profile: resolvedProfile,
  });
  snapshot.readiness = evaluateAdmissionReadiness({
    snapshot,
    profile: resolvedProfile,
    env,
  });
  snapshot.contractQualityBucket = bucketContractQuality({
    spreadBps: snapshot.spreadBps,
    healthScore: snapshot.healthScore,
    depth: snapshot.depth,
    selectedByFallback: snapshot.selectedByFallback,
    eligibilityPassed: snapshot.eligibilityPassed,
    minEligibilityChecksPassed: snapshot.minEligibilityChecksPassed,
    maxSpreadBps: thresholdSet.routeQuality.maxSpreadBps,
    minHealth: thresholdSet.routeQuality.minHealthScore,
    minDepth: thresholdSet.routeQuality.minDepth,
  });
  snapshot.spreadBucket = bucketSpread(
    snapshot.spreadBps,
    thresholdSet.routeQuality.maxSpreadBps,
  );
  snapshot.healthBucket = bucketHealth(
    snapshot.healthScore,
    thresholdSet.routeQuality.minHealthScore,
  );
  snapshot.depthBucket = bucketDepth(
    snapshot.depth,
    thresholdSet.routeQuality.minDepth,
  );
  snapshot.confidenceGapBucket = bucketConfidenceGap(snapshot.confidenceGap);
  snapshot.freshnessBucket = bucketFreshness(snapshot.freshness);
  snapshot.baseSnapshot = extractBaseAdmissionSnapshot(snapshot);

  return Object.freeze(snapshot);
}

function decisionCategory({ outcome, stage, reason, meta }) {
  if (outcome === "BLOCKED") {
    const readinessState = String(meta?.readinessState || "")
      .trim()
      .toUpperCase();
    if (readinessState === "BLOCKED_INCOMPLETE" || readinessState === "BLOCKED_STALE") {
      return "DATA_READINESS_BLOCK";
    }
    if (stage === "route" || stage === "contract" || stage === "pre_route_tradability") {
      return "ROUTE_QUALITY_BLOCK";
    }
    if (stage === "planner") return "PLANNER_BLOCK";
    if (stage === "admission" || String(reason || "").includes("POLICY")) {
      return "HARD_POLICY_BLOCK";
    }
    return "BLOCKED";
  }
  if (outcome === "ADJUSTED") return "ADJUSTED_PASS";
  if (outcome === "READY_FOR_EXECUTION" || outcome === "ENTRY_PLACED") {
    return "ACCEPTED";
  }
  return "PASS_THROUGH";
}

function buildDecisionAudit({ snapshot }) {
  return Object.freeze({
    signalId: snapshot?.signalId || null,
    strategyId: snapshot?.strategyId || null,
    family: snapshot?.family || null,
    style: snapshot?.style || null,
    readinessState: snapshot?.readiness?.state || null,
    stageTrail: [],
    softPassUsed: false,
    transitionPassUsed: false,
    terminalOutcome: null,
    terminalReasonCode: null,
    terminalCategory: null,
  });
}

function mergeDecisionStage({ audit, snapshot, outcome, stage, reason, meta = {} }) {
  const nextTrail = [...(audit?.stageTrail || []), { stage, outcome, reason }].slice(-8);
  const softPassUsed =
    Boolean(audit?.softPassUsed) ||
    reason === "POST_ROUTE_CONFIDENCE_SOFT_PASS" ||
    meta?.softPassUsed === true;
  const transitionPassUsed =
    Boolean(audit?.transitionPassUsed) ||
    reason === "MULTI_TF_TREND_TRANSITION_PASS" ||
    meta?.transitionPassUsed === true;

  const finalizedTerminal = finalizeDecisionReason(
    {
      terminalOutcome: audit?.terminalOutcome || null,
      terminalReasonCode: audit?.terminalReasonCode || null,
      terminalCategory: audit?.terminalCategory || null,
    },
    resolveTerminalState({ outcome, stage, reason, meta }),
  );

  return Object.freeze({
    signalId: snapshot?.signalId || audit?.signalId || null,
    strategyId: snapshot?.strategyId || audit?.strategyId || null,
    family: snapshot?.family || audit?.family || null,
    style: snapshot?.style || audit?.style || null,
    readinessState: snapshot?.readiness?.state || audit?.readinessState || null,
    stageTrail: nextTrail,
    softPassUsed,
    transitionPassUsed,
    terminalOutcome: finalizedTerminal?.terminalOutcome || null,
    terminalReasonCode: finalizedTerminal?.terminalReasonCode || null,
    terminalCategory: finalizedTerminal?.terminalCategory || null,
  });
}

function buildDecisionMeta({ snapshot, audit, meta = {} }) {
  const plannerPathUsed =
    meta?.plannerPathUsed ||
    snapshot?.plannerPathUsed ||
    snapshot?.plan?.meta?.plannerPathUsed ||
    null;
  const softPassSupported =
    typeof meta?.softPassSupported === "boolean"
      ? meta.softPassSupported
      : snapshot?.profile?.postRouteSoftPass?.enabled === true;
  const softPassUsed =
    meta?.softPassUsed === true ||
    snapshot?.softPassUsed === true ||
    audit?.softPassUsed === true;
  const transitionPassSupported =
    typeof meta?.transitionPassSupported === "boolean"
      ? meta.transitionPassSupported
      : snapshot?.profile?.allowTransitionPass === true;
  const transitionPassUsed =
    meta?.transitionPassUsed === true ||
    snapshot?.transitionPassUsed === true ||
    audit?.transitionPassUsed === true;
  const legacyFallbackSupported =
    typeof meta?.legacyFallbackSupported === "boolean"
      ? meta.legacyFallbackSupported
      : plannerLegacyFallbackSupported(snapshot);
  const legacyFallbackUsed =
    meta?.legacyFallbackUsed === true ||
    snapshot?.plan?.meta?.legacyFallbackUsed === true ||
    plannerPathUsed === "LEGACY_FALLBACK";

  return {
    ...meta,
    admissionProfileId: snapshot?.profile?.profileId || null,
    snapshotTs:
      meta?.snapshotTs ??
      snapshot?.snapshotTs ??
      snapshot?.baseSnapshot?.snapshotTs ??
      null,
    stageEvaluatedAt:
      meta?.stageEvaluatedAt ??
      snapshot?.stageEvaluatedAt ??
      snapshot?.nowTs ??
      null,
    readinessState:
      meta?.readinessState || snapshot?.readiness?.state || audit?.readinessState || null,
    readinessDegradedBy:
      meta?.readinessDegradedBy || snapshot?.readiness?.degradedBy || [],
    signalTsSource:
      meta?.signalTsSource || snapshot?.readiness?.signalTsSource || null,
    staleByMs:
      meta?.staleByMs ??
      snapshot?.readiness?.staleByMs ??
      0,
    premiumAgingThresholdMs:
      meta?.premiumAgingThresholdMs ??
      snapshot?.readiness?.premiumAgingThresholdMs ??
      null,
    premiumStaleAfterMs:
      meta?.premiumStaleAfterMs ??
      snapshot?.readiness?.premiumStaleAfterMs ??
      null,
    premiumStaleSource:
      meta?.premiumStaleSource || snapshot?.readiness?.premiumStaleSource || null,
    premiumStaleThresholdSource:
      meta?.premiumStaleThresholdSource ||
      snapshot?.readiness?.premiumStaleThresholdSource ||
      null,
    family: meta?.family || snapshot?.family || audit?.family || null,
    style: meta?.style || snapshot?.style || audit?.style || null,
    triggerLevelResolved:
      meta?.triggerLevelResolved ?? snapshot?.triggerLevel ?? null,
    anchorValueResolved:
      meta?.anchorValueResolved ?? snapshot?.anchorValue ?? null,
    plannerPathUsed,
    plannerFallbackReason:
      meta?.plannerFallbackReason ||
      meta?.planFallbackReason ||
      snapshot?.plan?.meta?.planFallbackReason ||
      snapshot?.plan?.meta?.plannerTelemetry?.fallbackReason ||
      null,
    finalAuthoritativeRr:
      meta?.finalAuthoritativeRr ??
      snapshot?.plan?.meta?.authoritativePrimaryRrUsed ??
      snapshot?.plan?.authoritativePrimaryRrUsed ??
      null,
    chosenTargetSourceType:
      meta?.chosenTargetSourceType ||
      snapshot?.plan?.meta?.chosenTargetSourceType ||
      null,
    chosenStopSourceType:
      meta?.chosenStopSourceType ||
      snapshot?.plan?.meta?.chosenStopSourceType ||
      null,
    transitionPassSupported,
    transitionPassUsed,
    transitionPassProfile: transitionPassUsed
      ? meta?.transitionPassProfile || snapshot?.profile?.transitionPassProfile || null
      : null,
    softPassSupported,
    softPassUsed,
    softPassProfile: softPassUsed
      ? meta?.softPassProfile || snapshot?.profile?.postRouteSoftPass?.profileId || null
      : null,
    legacyFallbackSupported,
    legacyFallbackUsed,
    contractQualityBucket:
      meta?.contractQualityBucket || snapshot?.contractQualityBucket || null,
    spreadBucket: meta?.spreadBucket || snapshot?.spreadBucket || null,
    healthBucket: meta?.healthBucket || snapshot?.healthBucket || null,
    depthBucket: meta?.depthBucket || snapshot?.depthBucket || null,
    confidenceGapBucket:
      meta?.confidenceGapBucket || snapshot?.confidenceGapBucket || null,
    freshnessBucket: meta?.freshnessBucket || snapshot?.freshnessBucket || null,
    terminalOutcome: audit?.terminalOutcome || null,
    terminalReasonCode: audit?.terminalReasonCode || null,
    terminalCategory: audit?.terminalCategory || null,
    decisionAudit: audit,
  };
}

function defaultPostRouteDecision(priorConversionSummary = null, signal = null) {
  return priorConversionSummary?.postRouteDecision ?? (signal?.option_meta ? "PASSED" : null);
}

function buildDecisionSignalPatch({
  signal = null,
  priorConversionSummary = null,
  snapshot,
  audit,
  outcome,
  stage,
  reason,
  meta = {},
}) {
  const decisionMeta = buildDecisionMeta({ snapshot, audit, meta });
  const patch = {
    family: decisionMeta.family,
    style: decisionMeta.style,
    readinessState: decisionMeta.readinessState,
    plannerPathUsed: decisionMeta.plannerPathUsed,
    triggerLevelResolved: decisionMeta.triggerLevelResolved,
    anchorValueResolved: decisionMeta.anchorValueResolved,
    finalAuthoritativeRr: decisionMeta.finalAuthoritativeRr,
    transitionPassSupported: decisionMeta.transitionPassSupported,
    transitionPassUsed: decisionMeta.transitionPassUsed,
    transitionPassProfile: decisionMeta.transitionPassProfile,
    softPassSupported: decisionMeta.softPassSupported,
    softPassUsed: decisionMeta.softPassUsed,
    softPassProfile: decisionMeta.softPassProfile,
    legacyFallbackSupported: decisionMeta.legacyFallbackSupported,
    legacyFallbackUsed: decisionMeta.legacyFallbackUsed,
  };
  const priorPostRouteDecision = defaultPostRouteDecision(
    priorConversionSummary,
    signal,
  );

  if (stage === "admission" && outcome === "BLOCKED") {
    patch.postRouteDecision =
      reason === "POST_ROUTE_LOW_CONFIDENCE" ? "BLOCKED" : priorPostRouteDecision;
    patch.finalOutcome =
      reason === "POST_ROUTE_LOW_CONFIDENCE"
        ? "BLOCKED_POST_ROUTE_CONFIDENCE"
        : "BLOCKED_ADMISSION";
    patch.finalReasonCode = reason;
    if (reason === "POST_ROUTE_LOW_CONFIDENCE") {
      patch.routedConfidence = toFiniteOrNull(meta?.conf ?? signal?.confidence);
    }
  } else if (stage === "admission" && outcome === "ADJUSTED") {
    if (reason === "POST_ROUTE_CONFIDENCE_SOFT_PASS") {
      patch.postRouteDecision = "SOFT_PASS";
      patch.routedConfidence = toFiniteOrNull(meta?.routedScore ?? meta?.conf);
    } else if (reason === "MULTI_TF_TREND_TRANSITION_PASS") {
      patch.postRouteDecision = priorPostRouteDecision;
    }
  } else if (
    (stage === "risk_fit" || stage === "affordability") &&
    outcome === "BLOCKED"
  ) {
    patch.postRouteDecision = priorPostRouteDecision;
    patch.riskFitDecision =
      meta?.riskFitDecision || (stage === "risk_fit" ? "BLOCKED" : null);
    patch.finalOutcome = "BLOCKED_RISK_FIT";
    patch.finalReasonCode = reason;
  } else if (stage === "risk_fit" && outcome === "ADJUSTED") {
    patch.riskFitDecision = meta?.riskFitDecision || reason || "ADJUSTED";
  } else if (stage === "entry" && outcome === "READY_FOR_EXECUTION") {
    patch.finalOutcome = "READY_FOR_EXECUTION";
    patch.finalReasonCode = reason;
  } else if (stage === "entry" && outcome === "ENTRY_PLACED") {
    patch.postRouteDecision = priorPostRouteDecision;
    patch.riskFitDecision = priorConversionSummary?.riskFitDecision || "FIT";
    patch.finalOutcome = "READY_FOR_EXECUTION";
    patch.finalReasonCode = reason;
  } else if (stage === "entry" && outcome === "BLOCKED") {
    patch.finalOutcome = "BLOCKED_EXECUTION_ADMISSION";
    patch.finalReasonCode = reason;
  } else if (stage === "planner" && outcome === "BLOCKED") {
    patch.postRouteDecision = priorPostRouteDecision;
    patch.finalOutcome = "BLOCKED_PLANNER";
    patch.finalReasonCode = reason;
  } else if (stage === "optimizer" && outcome === "BLOCKED") {
    patch.finalOutcome = "BLOCKED_ADMISSION";
    patch.finalReasonCode = reason;
  }

  return Object.freeze({
    decisionMeta,
    conversionPatch: Object.freeze(patch),
  });
}

module.exports = {
  createAdmissionSnapshot: function createAdmissionSnapshot(args = {}) {
    const seededSnapshot = buildAdmissionContext(args);
    return seededSnapshot?.baseSnapshot || extractBaseAdmissionSnapshot(seededSnapshot);
  },
  buildAdmissionContext,
  buildDecisionAudit,
  mergeDecisionStage,
  buildDecisionMeta,
  buildDecisionSignalPatch,
  evaluateAdmissionReadiness,
  finalizeDecisionReason,
  bucketContractQuality,
  bucketConfidenceGap,
  bucketFreshness,
  bucketMismatchStrength,
  bucketSpread,
  bucketHealth,
  bucketDepth,
};
