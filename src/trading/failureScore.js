const {
  adverseUnderlyingBps,
  barMsFromTrade,
  resolveStructureBuffer,
  resolveStructureReference,
  structureBreachAmount,
  structureObservedPrice,
} = require("./lossContainmentExit");
const { getStrategyMeta } = require("../strategy/registry");

function n(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  let next = Number(value);
  if (!Number.isFinite(next)) next = 0;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);
  return next;
}

function tsFrom(value) {
  if (!value) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function isOptionTrade(trade = {}) {
  const segment = String(trade?.instrument?.segment || "").toUpperCase();
  const symbol = String(trade?.instrument?.tradingsymbol || "").toUpperCase();
  return Boolean(
    trade?.option_meta ||
      trade?.optionMeta ||
      trade?.option ||
      segment.includes("OPT") ||
      /\d(?:CE|PE)$/.test(symbol),
  );
}

function oppositeSide(side) {
  return String(side || "BUY").toUpperCase() === "SELL" ? "BUY" : "SELL";
}

function spreadBpsFromQuote(marketQuote) {
  const bid = n(marketQuote?.bid, NaN);
  const ask = n(marketQuote?.ask, NaN);
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid)) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 10000;
}

function resolvePeakR({ plan, metrics, trade }) {
  return [
    n(metrics?.peakExecutableR, NaN),
    n(metrics?.protectedPeakR, NaN),
    n(plan?.meta?.peakExecutableR, NaN),
    n(plan?.meta?.protectedPeakR, NaN),
    n(plan?.meta?.peakR, NaN),
    n(trade?.peakExecutableR, NaN),
    n(trade?.protectedPeakR, NaN),
    n(trade?.peakR, NaN),
  ].find((value) => Number.isFinite(value)) ?? null;
}

function resolveCurrentR({ plan, metrics, trade }) {
  return [
    n(metrics?.protectedCurrentR, NaN),
    n(metrics?.currentExecutableR, NaN),
    n(plan?.meta?.protectedCurrentR, NaN),
    n(plan?.meta?.currentExecutableR, NaN),
    n(plan?.meta?.pnlR, NaN),
    n(trade?.protectedCurrentR, NaN),
    n(trade?.currentExecutableR, NaN),
  ].find((value) => Number.isFinite(value)) ?? null;
}

function resolveSignalMeta(trade = {}, plan = {}) {
  return {
    ...(trade?.sig?.meta || {}),
    ...(trade?.signalMeta || {}),
    ...(trade?.option_meta?.meta || {}),
    ...(trade?.optionMeta?.meta || {}),
    ...(trade?.planMeta?.signal || {}),
    ...(trade?.planMeta?.setup || {}),
    ...(plan?.meta?.signalMeta || {}),
  };
}

function resolveStrategyId(trade = {}) {
  return String(
    trade?.strategyId ||
      trade?.signal?.strategyId ||
      trade?.sig?.strategyId ||
      "",
  ).trim();
}

function directionalLevel(side, longValue, shortValue, fallback = null) {
  return String(side || "BUY").toUpperCase() === "SELL"
    ? n(shortValue, fallback)
    : n(longValue, fallback);
}

function weakFollowThroughScore(peakR, env) {
  const weakCapR = Math.max(0.01, n(env.ALC_MAX_MFE_FOR_FAILURE_R, 0.1));
  if (!Number.isFinite(peakR) || peakR <= 0) return 25;
  if (peakR <= weakCapR) return 25;
  const fadeOutR = weakCapR * 2;
  if (peakR >= fadeOutR) return 0;
  return Math.round(25 * clamp((fadeOutR - peakR) / weakCapR, 0, 1));
}

function adverseProgressionScore(adverseR, env) {
  if (!(Number.isFinite(adverseR) && adverseR > 0)) return 0;
  const l1 = Math.max(0.01, n(env.ALC_ADVERSE_R_L1, 0.4));
  const l2 = Math.max(l1, n(env.ALC_ADVERSE_R_L2, 0.6));
  const exit = Math.max(l2, n(env.ALC_ADVERSE_R_EXIT, 0.85));
  if (adverseR < l1) return 0;
  if (adverseR >= exit) return 25;
  if (adverseR >= l2) {
    const span = Math.max(0.0001, exit - l2);
    return Math.round(16 + 9 * clamp((adverseR - l2) / span, 0, 1));
  }
  const span = Math.max(0.0001, l2 - l1);
  return Math.round(8 + 8 * clamp((adverseR - l1) / span, 0, 1));
}

function makeStructureCandidate({
  type,
  kind = "UNDERLYING",
  level,
  source,
  reasonCode,
  weight = 1,
}) {
  const numericLevel = n(level, NaN);
  if (!Number.isFinite(numericLevel)) return null;
  return {
    type,
    kind,
    level: numericLevel,
    source,
    reasonCode,
    weight: clamp(weight, 0.5, 1.25),
  };
}

function strategyStructureCandidates({
  trade,
  plan,
  side,
  sl0,
}) {
  const signalMeta = resolveSignalMeta(trade, plan);
  const strategyId = resolveStrategyId(trade);
  const strategyMeta = getStrategyMeta(strategyId);
  const planMeta = trade?.planMeta || {};
  const orb = planMeta?.orb || {};
  const prevDay = planMeta?.prevDay || {};
  const useUnderlyingRefs = isOptionTrade(trade) || Number.isFinite(n(planMeta?.underlying?.entry, NaN));
  const refKind = useUnderlyingRefs ? "UNDERLYING" : "PREMIUM";
  const candidates = [];
  const setupState = String(signalMeta?.setupState || "").trim().toUpperCase();
  const triggerType = String(signalMeta?.triggerType || "").trim().toUpperCase();
  const retestState = String(signalMeta?.retestState || "").trim().toUpperCase();

  const breakoutTriggerReason =
    setupState === "CONFIRMED" || retestState.includes("HOLD")
      ? "BREAKOUT_ACCEPTANCE_FAILED"
      : "BREAKOUT_TRIGGER_LOST";
  const breakoutRangeReason = retestState.includes("HOLD")
    ? "BREAKOUT_RETEST_FAILED"
    : "BREAKOUT_REENTERED_RANGE";
  const orbBoundaryReason =
    setupState === "TRIGGERED" || triggerType.includes("OPENING_RANGE")
      ? "ORB_ACCEPTANCE_FAILED"
      : "ORB_REENTERED_RANGE";
  const vwapPivotReason = triggerType.includes("VWAP_REJECT")
    ? "VWAP_REJECT_INVALIDATED"
    : "VWAP_RECLAIM_LOST";
  const pullbackReason = retestState.includes("PULLBACK")
    ? "EMA_PULLBACK_RECOVERY_FAILED"
    : "EMA_PULLBACK_INVALIDATED";
  const fakeoutReason = triggerType.includes("FAKEOUT")
    ? "FAKEOUT_REJECTION_FAILED"
    : "FAKEOUT_INVALIDATED";
  const wickReason = triggerType.includes("REVERSAL")
    ? "WICK_REVERSAL_PIVOT_LOST"
    : "WICK_REVERSAL_INVALIDATED";

  const push = (candidate) => {
    if (candidate) candidates.push(candidate);
  };

  const triggerLevel = directionalLevel(
    side,
    signalMeta?.triggerLevel ?? signalMeta?.rangeHigh ?? signalMeta?.brokenLevel,
    signalMeta?.triggerLevel ?? signalMeta?.rangeLow ?? signalMeta?.brokenLevel,
  );
  const rangeBoundary = directionalLevel(
    side,
    signalMeta?.rangeHigh ?? orb?.high ?? prevDay?.PDH,
    signalMeta?.rangeLow ?? orb?.low ?? prevDay?.PDL,
  );
  const reclaimPivot = directionalLevel(
    side,
    signalMeta?.anchorValue ?? planMeta?.vwap ?? signalMeta?.vwap,
    signalMeta?.anchorValue ?? planMeta?.vwap ?? signalMeta?.vwap,
  );
  const pullbackAnchor = directionalLevel(
    side,
    signalMeta?.pullbackAnchor ?? signalMeta?.anchorValue ?? signalMeta?.trendAnchor,
    signalMeta?.pullbackAnchor ?? signalMeta?.anchorValue ?? signalMeta?.trendAnchor,
  );
  const emaAnchor = directionalLevel(
    side,
    signalMeta?.fast ?? signalMeta?.anchorValue ?? signalMeta?.trendAnchor,
    signalMeta?.slow ?? signalMeta?.anchorValue ?? signalMeta?.trendAnchor,
  );
  const fakeoutLevel = directionalLevel(
    side,
    signalMeta?.brokenLevel ?? signalMeta?.rangeHigh ?? signalMeta?.triggerLevel,
    signalMeta?.brokenLevel ?? signalMeta?.rangeLow ?? signalMeta?.triggerLevel,
  );
  const wickExtreme = directionalLevel(
    side,
    signalMeta?.wickExtreme ?? signalMeta?.triggerLevel ?? signalMeta?.anchorValue,
    signalMeta?.wickExtreme ?? signalMeta?.triggerLevel ?? signalMeta?.anchorValue,
  );

  switch (strategyId) {
    case "breakout":
    case "bb_squeeze":
    case "volume_spike":
      push(
        makeStructureCandidate({
          type: "BREAKOUT_TRIGGER",
          kind: refKind,
          level: triggerLevel,
          source: "SIGNAL_TRIGGER_LEVEL",
          reasonCode: breakoutTriggerReason,
          weight: 1,
        }),
      );
      push(
        makeStructureCandidate({
          type: "BREAKOUT_RANGE",
          kind: refKind,
          level: rangeBoundary,
          source: "SIGNAL_RANGE_BOUNDARY",
          reasonCode: breakoutRangeReason,
          weight: 0.95,
        }),
      );
      break;
    case "orb":
      push(
        makeStructureCandidate({
          type: "ORB_BOUNDARY",
          kind: refKind,
          level: directionalLevel(side, orb?.high, orb?.low),
          source: "PLAN_ORB_BOUNDARY",
          reasonCode: orbBoundaryReason,
          weight: 1,
        }),
      );
      push(
        makeStructureCandidate({
          type: "ORB_TRIGGER",
          kind: refKind,
          level: triggerLevel,
          source: "ORB_TRIGGER_LEVEL",
          reasonCode: "ORB_ACCEPTANCE_FAILED",
          weight: 0.95,
        }),
      );
      break;
    case "vwap_reclaim":
      push(
        makeStructureCandidate({
          type: "VWAP_RECLAIM",
          kind: refKind,
          level: reclaimPivot,
          source: "VWAP_RECLAIM_PIVOT",
          reasonCode: vwapPivotReason,
          weight: 1,
        }),
      );
      push(
        makeStructureCandidate({
          type: "VWAP_TRIGGER",
          kind: refKind,
          level: triggerLevel,
          source: "VWAP_TRIGGER_LEVEL",
          reasonCode: "VWAP_TRIGGER_LOST",
          weight: 0.9,
        }),
      );
      break;
    case "ema_pullback":
      push(
        makeStructureCandidate({
          type: "EMA_PULLBACK",
          kind: refKind,
          level: pullbackAnchor,
          source: "EMA_PULLBACK_ANCHOR",
          reasonCode: pullbackReason,
          weight: 1,
        }),
      );
      break;
    case "ema_cross":
      push(
        makeStructureCandidate({
          type: "EMA_CROSS",
          kind: refKind,
          level: emaAnchor,
          source: "EMA_CROSS_ANCHOR",
          reasonCode: "EMA_CROSS_INVALIDATED",
          weight: 0.95,
        }),
      );
      break;
    case "fakeout":
      push(
        makeStructureCandidate({
          type: "FAKEOUT_LEVEL",
          kind: refKind,
          level: fakeoutLevel,
          source: "FAKEOUT_BROKEN_LEVEL",
          reasonCode: fakeoutReason,
          weight: 1,
        }),
      );
      break;
    case "wick_reversal":
      push(
        makeStructureCandidate({
          type: "WICK_EXTREME",
          kind: refKind,
          level: wickExtreme,
          source: "WICK_REVERSAL_EXTREME",
          reasonCode: wickReason,
          weight: 0.95,
        }),
      );
      break;
    default:
      if (strategyMeta?.family === "BREAKOUT") {
        push(
          makeStructureCandidate({
            type: "GENERIC_BREAKOUT",
            kind: refKind,
            level: triggerLevel ?? rangeBoundary,
            source: "GENERIC_BREAKOUT_REFERENCE",
            reasonCode: "BREAKOUT_TRIGGER_LOST",
            weight: 0.95,
          }),
        );
      }
      break;
  }

  const generic = resolveStructureReference({ trade, env: {}, sl0 });
  push(
    makeStructureCandidate({
      type: "GENERIC_STRUCTURE",
      kind: generic?.kind ?? "PREMIUM",
      level: generic?.level,
      source: generic?.source || "GENERIC_STRUCTURE_REFERENCE",
      reasonCode: "GENERIC_STRUCTURE_LOST",
      weight: 0.85,
    }),
  );
  push(
    makeStructureCandidate({
      type: "PLAN_UNDERLYING_STOP",
      kind: "UNDERLYING",
      level: planMeta?.underlying?.stop,
      source: "PLAN_UNDERLYING_STOP",
      reasonCode: "UNDERLYING_TRIGGER_LOST",
      weight: 1,
    }),
  );
  return candidates.filter(Boolean);
}

function evaluateStructureCandidate({
  candidate,
  trade,
  plan,
  ltp,
  underlyingLtp,
  side,
}) {
  const observedPrice =
    candidate?.kind === "UNDERLYING" ? n(underlyingLtp, NaN) : n(ltp, NaN);
  const breachAmount = structureBreachAmount({
    side,
    referenceLevel: candidate?.level,
    observedPrice,
  });
  const bufferUsed = resolveStructureBuffer({
    trade,
    plan,
    env: {},
    reference: {
      kind: candidate?.kind,
      level: candidate?.level,
      fallbackRisk: Math.abs(
        n(trade?.planMeta?.underlying?.entry, n(trade?.entryPrice, NaN)) -
          candidate?.level,
      ),
    },
  });
  const severity =
    Number.isFinite(breachAmount) && breachAmount > 0
      ? Number.isFinite(bufferUsed) && bufferUsed > 0
        ? breachAmount / bufferUsed
        : Infinity
      : 0;
  const structureBroken =
    Number.isFinite(breachAmount) &&
    breachAmount > 0 &&
    (!Number.isFinite(bufferUsed) || breachAmount > bufferUsed);
  const baseScore = !structureBroken
    ? 0
    : severity >= 2.5
      ? 25
      : severity >= 1.75
        ? 20
        : Math.round(12 + 8 * clamp((severity - 1) / 0.75, 0, 1));

  return {
    ...candidate,
    observedPrice: Number.isFinite(observedPrice) ? observedPrice : null,
    breachAmount: Number.isFinite(breachAmount) ? breachAmount : null,
    bufferUsed: Number.isFinite(bufferUsed) ? bufferUsed : null,
    severity: Number.isFinite(severity) ? severity : null,
    structureBroken,
    score: Math.min(25, Math.round(baseScore * clamp(candidate?.weight, 0.5, 1.25))),
  };
}

function structureComponent({
  trade,
  plan,
  ltp,
  underlyingLtp,
  sl0,
  side,
}) {
  const evaluations = strategyStructureCandidates({
    trade,
    plan,
    side,
    sl0,
  }).map((candidate) =>
    evaluateStructureCandidate({
      candidate,
      trade,
      plan,
      ltp,
      underlyingLtp,
      side,
    }),
  );
  const broken = evaluations
    .filter((candidate) => candidate.structureBroken)
    .sort((left, right) => right.score - left.score || right.weight - left.weight);
  const selected =
    broken[0] ||
    evaluations.sort((left, right) => right.weight - left.weight)[0] ||
    null;

  return {
    score: selected?.structureBroken ? selected.score : 0,
    structureBroken: Boolean(selected?.structureBroken),
    reasonCode: selected?.structureBroken ? selected.reasonCode : null,
    referenceKind: selected?.kind ?? null,
    referenceSource: selected?.source ?? null,
    referenceLevel: selected?.level ?? null,
    observedPrice: selected?.observedPrice ?? null,
    breachAmount: selected?.breachAmount ?? null,
    bufferUsed: selected?.bufferUsed ?? null,
    severity: selected?.severity ?? null,
  };
}

function adverseUnderlyingReferenceBps({
  trade,
  underlyingLtp,
  referenceLevel,
  side,
}) {
  const ref = n(referenceLevel, NaN);
  const current = n(underlyingLtp, NaN);
  if (!(Number.isFinite(ref) && ref > 0 && Number.isFinite(current) && current > 0)) {
    return null;
  }
  if (String(side || "BUY").toUpperCase() === "SELL") {
    return current > ref ? ((current - ref) / ref) * 10000 : 0;
  }
  return current < ref ? ((ref - current) / ref) * 10000 : 0;
}

function underlyingComponent({
  trade,
  side,
  underlyingLtp,
  structure,
  plan,
  env,
}) {
  const signalMeta = resolveSignalMeta(trade, plan);
  const baseThresholdBps = Math.max(1, n(env.ALC_UNDERLYING_FAIL_BPS, n(env.TIME_STOP_NO_PROGRESS_UL_BPS, 12)));
  const fullScoreThresholdBps = Math.max(
    baseThresholdBps + 1,
    n(env.ALC_UNDERLYING_FAIL_BPS_MAX, baseThresholdBps * 2),
  );
  const weight = clamp(n(env.ALC_UNDERLYING_FAIL_WEIGHT, 1), 0, 1.5);
  const requireUnderlyingConfirmation = String(
    env.ALC_REQUIRE_UNDERLYING_CONFIRMATION ?? "false",
  ) === "true";
  const useTriggerReference = String(
    env.ALC_UNDERLYING_FAIL_USE_TRIGGER_REFERENCE ?? "true",
  ) !== "false";
  const useStructureReference = String(
    env.ALC_UNDERLYING_FAIL_USE_STRUCTURE_REFERENCE ?? "true",
  ) !== "false";
  const triggerReference = useTriggerReference
    ? directionalLevel(
        side,
        signalMeta?.triggerLevel ?? signalMeta?.rangeHigh ?? signalMeta?.anchorValue,
        signalMeta?.triggerLevel ?? signalMeta?.rangeLow ?? signalMeta?.anchorValue,
      )
    : null;
  const structureReference =
    useStructureReference && structure?.referenceKind === "UNDERLYING"
      ? structure?.referenceLevel
      : null;
  const adverseBps = adverseUnderlyingBps({ trade, underlyingLtp });
  const triggerReferenceBps = adverseUnderlyingReferenceBps({
    trade,
    underlyingLtp,
    referenceLevel: triggerReference,
    side,
  });
  const structureReferenceBps = adverseUnderlyingReferenceBps({
    trade,
    underlyingLtp,
    referenceLevel: structureReference,
    side,
  });
  const effectiveAdverseBps = Math.max(
    0,
    n(adverseBps, 0),
    n(triggerReferenceBps, 0),
    n(structureReferenceBps, 0),
  );
  const underlyingBroken = effectiveAdverseBps >= baseThresholdBps;
  const baseScore = !underlyingBroken
    ? 0
    : effectiveAdverseBps >= fullScoreThresholdBps
      ? 15
      : Math.round(
          6 +
            9 *
              clamp(
                (effectiveAdverseBps - baseThresholdBps) /
                  Math.max(0.0001, fullScoreThresholdBps - baseThresholdBps),
                0,
                1,
              ),
        );
  const score = requireUnderlyingConfirmation && !underlyingBroken
    ? 0
    : Math.min(15, Math.round(baseScore * weight));

  return {
    score,
    underlyingBroken,
    adverseUnderlyingBps: Number.isFinite(adverseBps) ? adverseBps : null,
    triggerReferenceBps:
      Number.isFinite(triggerReferenceBps) ? triggerReferenceBps : null,
    structureReferenceBps:
      Number.isFinite(structureReferenceBps) ? structureReferenceBps : null,
    thresholdBps: baseThresholdBps,
    maxThresholdBps: fullScoreThresholdBps,
    requireUnderlyingConfirmation,
    triggerReference:
      Number.isFinite(triggerReference) ? triggerReference : null,
    structureReference:
      Number.isFinite(structureReference) ? structureReference : null,
  };
}

function depthQuantity(marketQuote, side) {
  const normalizedSide = String(side || "").toUpperCase();
  const directKey = normalizedSide === "BUY" ? "bid_quantity" : "ask_quantity";
  const directValue = n(marketQuote?.[directKey], NaN);
  if (Number.isFinite(directValue)) return directValue;
  const bookSide =
    normalizedSide === "BUY"
      ? marketQuote?.depth?.buy?.[0]?.quantity
      : marketQuote?.depth?.sell?.[0]?.quantity;
  return n(bookSide, null);
}

function microstructureComponent({ trade, side, metrics, marketQuote, env }) {
  const quoteQuality = String(metrics?.quoteQuality || "UNUSABLE").toUpperCase();
  const confidence = String(metrics?.executablePriceConfidence || "NONE").toUpperCase();
  const quoteFreshnessMs = n(metrics?.quoteFreshnessMs, null);
  const spreadBps = spreadBpsFromQuote(marketQuote);
  const entrySpreadBps = n(
    trade?.quoteAtEntry?.bps ?? trade?.entrySpread ?? trade?.spreadAtEntry,
    NaN,
  );
  const maxSpreadBps = Math.max(
    1,
    n(env.DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS, 120),
  );
  const spreadSoftBps = Math.max(
    1,
    n(env.ALC_MICROSTRUCTURE_SPREAD_BPS_SOFT, maxSpreadBps * 0.5),
  );
  const spreadHardBps = Math.max(
    spreadSoftBps + 1,
    n(env.ALC_MICROSTRUCTURE_SPREAD_BPS_HARD, maxSpreadBps),
  );
  const freshnessSoftMs = Math.max(
    50,
    n(env.ALC_MICROSTRUCTURE_FRESHNESS_MS_SOFT, 1500),
  );
  const freshnessHardMs = Math.max(
    freshnessSoftMs + 1,
    n(env.ALC_MICROSTRUCTURE_FRESHNESS_MS_HARD, 3500),
  );
  const exitSide = oppositeSide(side);
  const exitBookQty = depthQuantity(marketQuote, exitSide);
  const oppositeBookQty = depthQuantity(marketQuote, side);

  let spreadScore = 0;
  let trendScore = 0;
  if (Number.isFinite(spreadBps)) {
    const deterioration = Number.isFinite(entrySpreadBps)
      ? spreadBps - entrySpreadBps
      : 0;
    if (spreadBps >= spreadHardBps) {
      spreadScore = 4;
    } else if (spreadBps >= spreadSoftBps) {
      spreadScore = 2;
    }
    if (deterioration >= spreadSoftBps * 0.5) trendScore = 2;
    else if (deterioration >= spreadSoftBps * 0.25) trendScore = 1;
  }

  let confidenceScore = 0;
  if (quoteQuality === "UNUSABLE") confidenceScore = 3;
  else if (confidence === "NONE") confidenceScore = 3;
  else if (confidence === "LOW") confidenceScore = 2;
  else if (confidence === "MEDIUM" || quoteQuality === "STALE_EXECUTABLE") {
    confidenceScore = 1;
  }

  let freshnessScore = 0;
  if (Number.isFinite(quoteFreshnessMs)) {
    if (quoteFreshnessMs >= freshnessHardMs) freshnessScore = 2;
    else if (quoteFreshnessMs >= freshnessSoftMs) freshnessScore = 1;
  }

  let depthScore = 0;
  let imbalanceScore = 0;
  if (Number.isFinite(exitBookQty) && exitBookQty > 0) {
    const qty = Math.max(1, n(trade?.qty, 1));
    if (exitBookQty < qty) depthScore += 1;
    if (
      Number.isFinite(oppositeBookQty) &&
      oppositeBookQty > 0 &&
      oppositeBookQty / exitBookQty >= 2.5
    ) {
      imbalanceScore += 1;
    }
  }

  const score = Math.min(
    Math.max(0, n(env.ALC_MICROSTRUCTURE_MAX_SCORE, 10)),
    spreadScore +
      trendScore +
      confidenceScore +
      freshnessScore +
      depthScore +
      imbalanceScore,
  );

  return {
    score,
    spreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
    maxSpreadBps,
    quoteQuality,
    quoteFreshnessMs,
    executablePriceConfidence: confidence,
    spreadScore,
    trendScore,
    confidenceScore,
    freshnessScore,
    depthScore,
    imbalanceScore,
    exitBookQty: Number.isFinite(exitBookQty) ? exitBookQty : null,
    oppositeBookQty: Number.isFinite(oppositeBookQty) ? oppositeBookQty : null,
  };
}

function graceState({ trade, now, env }) {
  const holdStart =
    tsFrom(trade?.entryFilledAt) ||
    tsFrom(trade?.entryAt) ||
    tsFrom(trade?.createdAt) ||
    tsFrom(trade?.updatedAt) ||
    now;
  const holdMs = Math.max(0, now - holdStart);
  const barMs = Math.max(1, n(barMsFromTrade(trade), 60_000));
  const barsSinceEntry = Math.max(0, Math.floor(holdMs / barMs));
  const minGraceMs = Math.max(0, n(env.ALC_MIN_GRACE_MS, 15_000));
  const minBars = Math.max(0, Math.round(n(env.ALC_MIN_BARS, 1)));
  const gracePassed =
    (minGraceMs <= 0 || holdMs >= minGraceMs) ||
    (minBars <= 0 || barsSinceEntry >= minBars);

  return {
    holdMs,
    barsSinceEntry,
    minGraceMs,
    minBars,
    gracePassed,
  };
}

function computeFailureScore({
  trade,
  plan,
  metrics,
  ltp,
  underlyingLtp,
  marketQuote,
  now,
  env,
  sl0,
  side,
}) {
  const peakR = resolvePeakR({ plan, metrics, trade });
  const currentR = resolveCurrentR({ plan, metrics, trade });
  const adverseR =
    Number.isFinite(currentR) && currentR < 0 ? Math.abs(currentR) : 0;
  const weakFollowThrough = weakFollowThroughScore(peakR, env);
  const adverseProgression = adverseProgressionScore(adverseR, env);
  const structure = structureComponent({
    trade,
    plan,
    ltp,
    underlyingLtp,
    sl0,
    side,
  });
  const underlying = underlyingComponent({
    trade,
    side,
    underlyingLtp,
    structure,
    plan,
    env,
  });
  const microstructure = microstructureComponent({
    trade,
    side,
    metrics,
    marketQuote,
    env,
  });
  const grace = graceState({ trade, now, env });

  const score = clamp(
    weakFollowThrough +
      adverseProgression +
      structure.score +
      underlying.score +
      microstructure.score,
    0,
    100,
  );

  const reasons = [];
  if (weakFollowThrough > 0) reasons.push("WEAK_FOLLOW_THROUGH");
  if (adverseProgression > 0) reasons.push("ADVERSE_PROGRESSION");
  if (structure.structureBroken) reasons.push("STRUCTURE_BROKEN");
  if (underlying.underlyingBroken) reasons.push("UNDERLYING_BROKEN");
  if (microstructure.score > 0) reasons.push("MICROSTRUCTURE_STRESS");

  return {
    score,
    reasons,
    breakdown: {
      weakFollowThrough,
      adverseProgression,
      structure: structure.score,
      underlying: underlying.score,
      microstructure: microstructure.score,
    },
    mfeR: Number.isFinite(peakR) ? peakR : null,
    adverseR,
    structureBroken: structure.structureBroken,
    structureReasonCode: structure.reasonCode,
    structureReferenceKind: structure.referenceKind,
    structureReferenceSource: structure.referenceSource,
    structureReferenceLevel: structure.referenceLevel,
    structureObservedPrice: structure.observedPrice,
    structureBreachAmount: structure.breachAmount,
    structureBufferUsed: structure.bufferUsed,
    structureSeverity: structure.severity,
    underlyingBroken: underlying.underlyingBroken,
    adverseUnderlyingBps: underlying.adverseUnderlyingBps,
    underlyingTriggerReferenceBps: underlying.triggerReferenceBps,
    underlyingStructureReferenceBps: underlying.structureReferenceBps,
    underlyingThresholdBps: underlying.thresholdBps,
    underlyingThresholdBpsMax: underlying.maxThresholdBps,
    underlyingRequireConfirmation: underlying.requireUnderlyingConfirmation,
    underlyingTriggerReference: underlying.triggerReference,
    underlyingStructureReference: underlying.structureReference,
    quoteQuality: microstructure.quoteQuality,
    quoteFreshnessMs: microstructure.quoteFreshnessMs,
    executablePriceConfidence: microstructure.executablePriceConfidence,
    spreadBps: microstructure.spreadBps,
    microstructureBreakdown: {
      spreadScore: microstructure.spreadScore,
      trendScore: microstructure.trendScore,
      confidenceScore: microstructure.confidenceScore,
      freshnessScore: microstructure.freshnessScore,
      depthScore: microstructure.depthScore,
      imbalanceScore: microstructure.imbalanceScore,
      total: microstructure.score,
      exitBookQty: microstructure.exitBookQty,
      oppositeBookQty: microstructure.oppositeBookQty,
    },
    gracePassed: grace.gracePassed,
    holdMs: grace.holdMs,
    barsSinceEntry: grace.barsSinceEntry,
    minGraceMs: grace.minGraceMs,
    minBars: grace.minBars,
  };
}

module.exports = {
  computeFailureScore,
};
