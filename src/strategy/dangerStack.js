function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function stateBaseDanger(marketState) {
  const state = String(marketState || "").toUpperCase();
  if (state === "TREND_COMPRESSED") return 12;
  if (state === "BREAKOUT_WATCH") return 18;
  if (state === "FAILED_BREAKOUT") return 28;
  if (state === "RANGE_CHOP") return 20;
  if (state === "TRAP_RISK_HIGH") return 36;
  if (state === "NO_TRADE") return 45;
  return 0;
}

function stateConfidenceUplift(marketState) {
  const state = String(marketState || "").toUpperCase();
  if (state === "TREND_COMPRESSED") return 4;
  if (state === "BREAKOUT_WATCH") return 6;
  if (state === "FAILED_BREAKOUT") return 9;
  if (state === "RANGE_CHOP") return 7;
  if (state === "TRAP_RISK_HIGH") return 12;
  if (state === "NO_TRADE") return 20;
  return 0;
}

function stateAdmissionUplift(marketState) {
  const state = String(marketState || "").toUpperCase();
  if (state === "TREND_COMPRESSED") return 4;
  if (state === "BREAKOUT_WATCH") return 6;
  if (state === "FAILED_BREAKOUT") return 8;
  if (state === "RANGE_CHOP") return 7;
  if (state === "TRAP_RISK_HIGH") return 12;
  if (state === "NO_TRADE") return 20;
  return 0;
}

function stateMtfUplift(marketState, env = {}) {
  const state = String(marketState || "").toUpperCase();
  if (state === "TREND_COMPRESSED") return numeric(env.COMPRESSED_MTF_UPLIFT, 4);
  if (state === "BREAKOUT_WATCH") return numeric(env.BREAKOUT_WATCH_MTF_UPLIFT, 6);
  if (state === "FAILED_BREAKOUT") return numeric(env.FAILED_BREAKOUT_MTF_UPLIFT, 8);
  if (state === "TRAP_RISK_HIGH") return numeric(env.TRAP_RISK_MTF_UPLIFT, 10);
  if (state === "NO_TRADE") return 20;
  return 0;
}

function computeDangerStack({
  marketState,
  levelAcceptance = null,
  mtf = null,
  dteDays = null,
  directionalPersistence = null,
  retryGovernor = null,
  env = {},
}) {
  const enabled = String(env.DANGER_STACK_ENABLED ?? "true") === "true";
  if (!enabled) {
    return {
      dangerStackScore: 0,
      dangerStackReasons: [],
      degradeTier: "LOW",
      degradedEdgeState: false,
      noTradeTriggered: false,
    };
  }

  const reasons = [];
  let score = stateBaseDanger(marketState);
  if (score > 0) reasons.push(`STATE_${String(marketState || "UNKNOWN").toUpperCase()}`);

  if (levelAcceptance?.repeatedRejectionDetected === true) {
    score += numeric(env.DANGER_STACK_REJECTION_WEIGHT, 18);
    reasons.push("REPEATED_LEVEL_REJECTION");
  }
  if (levelAcceptance?.breakoutRejected === true) {
    score += numeric(env.DANGER_STACK_WHIPSAW_WEIGHT, 12);
    reasons.push("FAILED_BREAKOUT_WHIPSAW");
  }
  if (
    Number.isFinite(Number(levelAcceptance?.distanceToLevelAtr)) &&
    Number(levelAcceptance.distanceToLevelAtr) <= 0.35
  ) {
    score += 8;
    reasons.push("NEAR_KEY_LEVEL");
  }

  const mtfScore = numeric(mtf?.mtfAgreementScore, 60);
  const mtfWeak =
    mtfScore < 58 ||
    mtf?.mtfBias === "CONFLICT" ||
    mtf?.mtfDegraded === true ||
    mtf?.mtfState === "DISAGREEMENT";
  if (mtfWeak) {
    score += numeric(env.DANGER_STACK_WEAK_MTF_WEIGHT, 14);
    reasons.push("WEAK_OR_DEGRADED_MTF");
  }

  const persistence = numeric(directionalPersistence, null);
  if (Number.isFinite(persistence) && persistence < 0.56) {
    score += 10;
    reasons.push("WEAK_DIRECTIONAL_PERSISTENCE");
  }

  const oneDte = hasFiniteNumber(dteDays) && Number(dteDays) <= 1;
  if (oneDte) {
    score += numeric(env.DANGER_STACK_ONE_DTE_WEIGHT, 16);
    reasons.push("ONE_DTE_FRAGILITY");
  }

  if (retryGovernor?.blocked === true) {
    score += 18;
    reasons.push("RETRY_GOVERNOR_BLOCK");
  } else if (Number(retryGovernor?.failureCount ?? 0) > 0) {
    score += 7;
    reasons.push("RETRY_FAILURE_CLUSTER");
  }

  score = clamp(score, 0, 100);
  const aPlusOnly = numeric(env.DANGER_STACK_A_PLUS_ONLY_SCORE, 62);
  const noTradeScore = numeric(env.DANGER_STACK_NO_TRADE_SCORE, 82);
  let degradeTier = "LOW";
  if (score >= noTradeScore) degradeTier = "EXTREME";
  else if (score >= aPlusOnly) degradeTier = "HIGH";
  else if (score >= 38) degradeTier = "MEDIUM";
  const degradedEdgeState = degradeTier === "MEDIUM" || degradeTier === "HIGH" || degradeTier === "EXTREME";
  const noTradeTriggered = degradeTier === "EXTREME";

  return {
    dangerStackScore: score,
    dangerStackReasons: reasons,
    degradeTier,
    degradedEdgeState,
    noTradeTriggered,
  };
}

function resolveAdaptiveThresholds({
  baseMinConfidence,
  baseMinMtfAgreement,
  baseMinAdmissionScore,
  baseMinAcceptanceScore = 55,
  marketState,
  dangerStackScore,
  dteDays = null,
  levelAcceptance = null,
  mtf = null,
  optionFragilityScore = 0,
  env = {},
}) {
  const oneDte = hasFiniteNumber(dteDays) && Number(dteDays) <= 1;
  const breakdown = {
    marketStateConfidence: stateConfidenceUplift(marketState),
    marketStateMtf: stateMtfUplift(marketState, env),
    marketStateAdmission: stateAdmissionUplift(marketState),
    marketStateAcceptance: Math.floor(stateAdmissionUplift(marketState) * 0.7),
    dangerStackConfidence: Math.floor(numeric(dangerStackScore, 0) / 15),
    dangerStackMtf: Math.floor(numeric(dangerStackScore, 0) / 18),
    dangerStackAdmission: Math.floor(numeric(dangerStackScore, 0) / 16),
    dangerStackAcceptance: Math.floor(numeric(dangerStackScore, 0) / 22),
    oneDteConfidence: oneDte ? numeric(env.ONE_DTE_CONFIDENCE_UPLIFT, 8) : 0,
    oneDteMtf: oneDte ? numeric(env.ONE_DTE_MTF_UPLIFT, 8) : 0,
    rejectionConfidence:
      levelAcceptance?.repeatedRejectionDetected === true
        ? Math.max(3, numeric(env.LEVEL_REJECTION_MIN_COUNT, 2))
        : 0,
    rejectionAdmission: levelAcceptance?.breakoutRejected === true ? 5 : 0,
    rejectionAcceptance:
      levelAcceptance?.repeatedRejectionDetected === true ? 8 : 0,
    staleHtfPenalty:
      Array.isArray(mtf?.mtfStaleIntervals) && mtf.mtfStaleIntervals.length > 0
        ? numeric(env.STALE_HTF_EXTRA_PENALTY, 4)
        : 0,
    missingHtfPenalty:
      Array.isArray(mtf?.mtfMissingIntervals) && mtf.mtfMissingIntervals.length > 0
        ? numeric(env.MISSING_HTF_EXTRA_PENALTY, 6)
        : 0,
    partialAlignPenalty:
      mtf?.mtfBias === "NEUTRAL" && numeric(mtf?.mtfAgreementScore, 0) < 62
        ? numeric(env.PARTIAL_ALIGN_EXTRA_PENALTY, 4)
        : 0,
    productFragilityPenalty: Math.floor(numeric(optionFragilityScore, 0) / 20),
  };

  const resolvedMinConfidence = clamp(
    numeric(baseMinConfidence, 70) +
      breakdown.marketStateConfidence +
      breakdown.dangerStackConfidence +
      breakdown.oneDteConfidence +
      breakdown.rejectionConfidence +
      breakdown.staleHtfPenalty +
      breakdown.missingHtfPenalty +
      breakdown.partialAlignPenalty +
      breakdown.productFragilityPenalty,
    45,
    99,
  );

  const resolvedMinMtfAgreement = clamp(
    numeric(baseMinMtfAgreement, 50) +
      breakdown.marketStateMtf +
      breakdown.dangerStackMtf +
      breakdown.oneDteMtf +
      breakdown.staleHtfPenalty +
      breakdown.missingHtfPenalty +
      breakdown.partialAlignPenalty,
    40,
    99,
  );

  const resolvedMinAdmissionScore = clamp(
    numeric(baseMinAdmissionScore, 70) +
      breakdown.marketStateAdmission +
      breakdown.dangerStackAdmission +
      breakdown.oneDteConfidence +
      breakdown.rejectionAdmission +
      breakdown.productFragilityPenalty,
    50,
    99,
  );

  const resolvedAcceptanceScore = clamp(
    numeric(baseMinAcceptanceScore, 55) +
      breakdown.marketStateAcceptance +
      breakdown.dangerStackAcceptance +
      breakdown.rejectionAcceptance +
      breakdown.oneDteMtf,
    40,
    99,
  );

  return {
    baseMinConfidence: numeric(baseMinConfidence, 70),
    resolvedMinConfidence,
    baseMinMtfAgreement: numeric(baseMinMtfAgreement, 50),
    resolvedMinMtfAgreement,
    baseMinAdmissionScore: numeric(baseMinAdmissionScore, 70),
    resolvedMinAdmissionScore,
    baseMinAcceptanceScore: numeric(baseMinAcceptanceScore, 55),
    resolvedAcceptanceScore,
    thresholdUpliftBreakdown: breakdown,
  };
}

module.exports = {
  computeDangerStack,
  resolveAdaptiveThresholds,
};
