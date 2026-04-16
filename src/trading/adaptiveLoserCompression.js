const { retainedRToPrice } = require("./costModel");
const { computeFailureScore } = require("./failureScore");
const { isWinnerProtectionActive } = require("./tradeLifecycleState");
const {
  alcAppliedSourceForState,
  deriveAlcAttribution,
} = require("./alcAttribution");

const ALC_AUTHORITY = "ADAPTIVE_LOSER_ENGINE";
const ACTIONS = Object.freeze({
  HOLD: "HOLD",
  COMPRESS_L1: "COMPRESS_L1",
  COMPRESS_L2: "COMPRESS_L2",
  EXIT_NOW: "EXIT_NOW",
});
const COMPRESSION_STATES = Object.freeze({
  NONE: "NONE",
  L1: "L1",
  L2: "L2",
  EXIT: "EXIT",
});
const REQUEST_OUTCOMES = Object.freeze({
  HOLD: "ALC_HOLD",
  READY: "ALC_REQUEST_READY",
  SUBMITTED: "ALC_REQUEST_SUBMITTED",
  CONFIRMED: "ALC_APPLIED_CONFIRMED",
  RETRY_L1: "ALC_RETRY_L1",
  RETRY_L2: "ALC_RETRY_L2",
  RETRY_EXIT: "ALC_RETRY_EXIT",
  SUPERSEDE_L1_TO_L2: "ALC_SUPERSEDE_L1_TO_L2",
  STALE: "ALC_REQUEST_STALE",
});
const PENDING_ACTIONS = Object.freeze({
  NONE: null,
  STOP_MODIFY: "STOP_MODIFY",
  EXIT_REQUEST: "EXIT_REQUEST",
});
const STATE_RANK = Object.freeze({
  NONE: 0,
  L1: 1,
  L2: 2,
  EXIT: 3,
});

function n(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function enabled(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value) === "true";
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
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

function normalizeCompressionState(state, fallback = COMPRESSION_STATES.NONE) {
  const raw = String(state || fallback).trim().toUpperCase();
  if (raw === "EXITED") return COMPRESSION_STATES.EXIT;
  if (Object.prototype.hasOwnProperty.call(STATE_RANK, raw)) return raw;
  return fallback;
}

function legacyCompressionState(state) {
  return normalizeCompressionState(state) === COMPRESSION_STATES.EXIT
    ? "EXITED"
    : normalizeCompressionState(state);
}

function stateRank(state) {
  return STATE_RANK[normalizeCompressionState(state)] ?? 0;
}

function maxState(...states) {
  return states
    .map((state) => normalizeCompressionState(state))
    .sort((left, right) => stateRank(right) - stateRank(left))[0] || COMPRESSION_STATES.NONE;
}

function actionState(action) {
  if (action === ACTIONS.COMPRESS_L1) return COMPRESSION_STATES.L1;
  if (action === ACTIONS.COMPRESS_L2) return COMPRESSION_STATES.L2;
  if (action === ACTIONS.EXIT_NOW) return COMPRESSION_STATES.EXIT;
  return COMPRESSION_STATES.NONE;
}

function actionLevel(action) {
  return stateRank(actionState(action));
}

function actionReason(action) {
  if (action === ACTIONS.COMPRESS_L1) return "ALC_COMPRESS_L1";
  if (action === ACTIONS.COMPRESS_L2) return "ALC_COMPRESS_L2";
  if (action === ACTIONS.EXIT_NOW) return "ALC_EXIT_NOW";
  return "ALC_HOLD";
}

function sourceForState(state) {
  if (normalizeCompressionState(state) === COMPRESSION_STATES.L1) return "ALC_L1";
  if (normalizeCompressionState(state) === COMPRESSION_STATES.L2) return "ALC_L2";
  return null;
}

function pendingActionForState(state) {
  return normalizeCompressionState(state) === COMPRESSION_STATES.EXIT
    ? PENDING_ACTIONS.EXIT_REQUEST
    : normalizeCompressionState(state) === COMPRESSION_STATES.NONE
      ? PENDING_ACTIONS.NONE
      : PENDING_ACTIONS.STOP_MODIFY;
}

function stateLossCapR(state, env) {
  const normalized = normalizeCompressionState(state);
  if (normalized === COMPRESSION_STATES.L2) {
    return Math.max(0.01, n(env.ALC_L2_REMAINING_R_CAP, 0.5));
  }
  if (normalized === COMPRESSION_STATES.L1) {
    return Math.max(0.01, n(env.ALC_L1_REMAINING_R_CAP, 0.7));
  }
  return null;
}

function resolveCurrentStop(trade = {}, fallbackStop = NaN) {
  return [
    n(trade?.brokerStopLoss, NaN),
    n(trade?.stopLoss, NaN),
    n(trade?.slTrigger, NaN),
    n(fallbackStop, NaN),
  ].find((value) => Number.isFinite(value)) ?? null;
}

function isBetterStop(side, next, prev, epsilon = 0) {
  if (!Number.isFinite(next)) return false;
  if (!Number.isFinite(prev)) return true;
  const buffer = Math.max(0, Number(epsilon) || 0);
  return String(side || "BUY").toUpperCase() === "SELL"
    ? next < prev - buffer
    : next > prev + buffer;
}

function stopDistance(side, next, prev) {
  if (!(Number.isFinite(next) && Number.isFinite(prev))) return Infinity;
  return String(side || "BUY").toUpperCase() === "SELL" ? prev - next : next - prev;
}

function betterStop(side, current, candidate) {
  if (!Number.isFinite(candidate)) return Number.isFinite(current) ? current : null;
  if (!Number.isFinite(current)) return candidate;
  return String(side || "BUY").toUpperCase() === "SELL"
    ? Math.min(current, candidate)
    : Math.max(current, candidate);
}

function compressionStop({
  side,
  entry,
  qty,
  riskInr,
  retainedLossCapR,
  tick,
}) {
  if (
    !(
      Number.isFinite(entry) &&
      Number.isFinite(qty) &&
      qty > 0 &&
      Number.isFinite(riskInr) &&
      riskInr > 0 &&
      Number.isFinite(retainedLossCapR)
    )
  ) {
    return null;
  }
  return retainedRToPrice({
    entryPrice: entry,
    qty,
    side,
    retainedR: -Math.abs(retainedLossCapR),
    riskInr,
    tick,
    roundMode: String(side || "BUY").toUpperCase() === "SELL" ? "down" : "up",
  });
}

function stopForState({
  state,
  side,
  entry,
  qty,
  riskInr,
  tick,
  env,
}) {
  const retainedLossCapR = stateLossCapR(state, env);
  if (!Number.isFinite(retainedLossCapR)) return null;
  return compressionStop({
    side,
    entry,
    qty,
    riskInr,
    retainedLossCapR,
    tick,
  });
}

function retryCooldownMs(env) {
  return Math.max(0, n(env.ALC_RETRY_COOLDOWN_MS, 4000));
}

function stalePendingMs(env) {
  return Math.max(retryCooldownMs(env), n(env.ALC_PENDING_STALE_MS, 8000));
}

function maxRetriesForState(state, env) {
  const normalized = normalizeCompressionState(state);
  if (normalized === COMPRESSION_STATES.L2) {
    return Math.max(0, Math.round(n(env.ALC_MAX_RETRIES_L2, n(env.ALC_MAX_RETRIES_PER_LEVEL, 3))));
  }
  if (normalized === COMPRESSION_STATES.L1) {
    return Math.max(0, Math.round(n(env.ALC_MAX_RETRIES_L1, n(env.ALC_MAX_RETRIES_PER_LEVEL, 3))));
  }
  if (normalized === COMPRESSION_STATES.EXIT) {
    return Math.max(0, Math.round(n(env.ALC_MAX_RETRIES_EXIT, 2)));
  }
  return 0;
}

function blockingWinnerProtection({ trade, plan }) {
  const meta = plan?.meta || {};
  return Boolean(
    meta?.winnerModeActive ||
      meta?.minGreenSatisfied ||
      meta?.beEligible ||
      meta?.beArmed ||
      meta?.beApplied ||
      meta?.trailArmed ||
      meta?.trailAllowed ||
      meta?.trailActive ||
      meta?.greenLockActive ||
      meta?.profitLockArmed ||
      Number(meta?.mfeLockTier ?? 0) > 0 ||
      meta?.hardGivebackExitArmed ||
      meta?.earlyWinnerActive ||
      meta?.earlyWinnerConfirmed ||
      Number(meta?.earlyWinnerTier ?? 0) > 0 ||
      isWinnerProtectionActive({
        ...trade,
        ...meta,
      }),
  );
}

function closePending(trade = {}, plan = null) {
  return Boolean(
    trade?.panicExitPending === true ||
      trade?.panicExitOrderId ||
      trade?.closeRequestedAt ||
      trade?.closeInitiatedAt ||
      trade?.exitOrderId ||
      plan?.action?.exitNow,
  );
}

function isClosedTrade(trade = {}) {
  const status = String(trade?.status || "").trim().toUpperCase();
  return Boolean(
    trade?.closedAt ||
      trade?.exitAt ||
      [
        "PANIC_EXIT_CONFIRMED",
        "GUARD_FAILED",
        "CLOSED",
        "EXITED_TARGET",
        "EXITED_SL",
      ].includes(status),
  );
}

function executableQuoteEligible({ trade, metrics }) {
  const quality = String(metrics?.quoteQuality || "UNUSABLE").toUpperCase();
  if (!Number.isFinite(n(metrics?.currentExecutablePrice, NaN))) return false;
  if (isOptionTrade(trade)) return quality === "FRESH_EXECUTABLE";
  return quality !== "UNUSABLE";
}

function assignPatch(patch, key, value) {
  if (value !== undefined) patch[key] = value;
}

function setRequestTelemetry(result, {
  requestOutcome = REQUEST_OUTCOMES.HOLD,
  requestReady = false,
  requestBlockedReason = null,
  superseded = false,
  supersedeReason = null,
}) {
  result.requestOutcome = requestOutcome;
  result.requestReady = Boolean(requestReady);
  result.requestBlockedReason = requestBlockedReason || null;
  result.superseded = Boolean(superseded);
  result.supersedeReason = supersedeReason || null;
}

function evaluateAdaptiveLoserCompression({
  trade,
  plan,
  metrics,
  ltp,
  underlyingLtp,
  marketQuote,
  now,
  env,
  entry,
  sl0,
  side,
  tick,
}) {
  const currentStop = resolveCurrentStop(trade, sl0);
  const pendingTargetStop = n(trade?.protectionUpgradeTargetStopLoss, NaN);
  const minImproveTicks = Math.max(
    1,
    Math.round(n(env.DYNAMIC_EXIT_BROKER_AUTH_MIN_TICKS, 1)),
  );
  const minImproveDistance = Math.max(
    0.000001,
    minImproveTicks * Math.max(0.01, n(tick, 0.05)),
  );
  const failure = computeFailureScore({
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
  });
  const currentTargetState = normalizeCompressionState(
    trade?.loserCompressionTargetState ?? trade?.loserCompressionState,
  );
  const currentSubmittedState = normalizeCompressionState(
    trade?.loserCompressionSubmittedState,
  );
  const currentAppliedState = normalizeCompressionState(
    trade?.loserCompressionAppliedState ?? trade?.loserCompressionState,
  );
  const attribution = deriveAlcAttribution(trade, {
    side,
    entryPrice: entry,
    initialStopLoss: sl0,
    riskInr: metrics?.riskInr,
    finalProtectionOwner: trade?.protectedStopSource ?? null,
  });
  const effectiveAppliedState = normalizeCompressionState(
    attribution.alcAppliedLevel ?? COMPRESSION_STATES.NONE,
    COMPRESSION_STATES.NONE,
  );
  const retryCount = Math.max(0, Math.round(n(trade?.loserCompressionRetryCount, 0)));
  const pendingAction = trade?.loserCompressionPendingAction ?? null;
  const pendingSinceTs = tsFrom(trade?.loserCompressionPendingSince);
  const lastAttemptTs = tsFrom(trade?.loserCompressionLastAttemptAt);
  const lastConfirmedTs = tsFrom(trade?.loserCompressionLastConfirmedAt);
  const lastRequestedStop = n(trade?.loserCompressionLastRequestedStop, NaN);
  const lastConfirmedStop = n(trade?.loserCompressionLastConfirmedStop, NaN);
  const stalePending = Boolean(
    pendingAction &&
      Number.isFinite(pendingSinceTs) &&
      now - pendingSinceTs >= stalePendingMs(env),
  );
  const retryCooldownActive = Boolean(
    Number.isFinite(lastAttemptTs) &&
      now - lastAttemptTs < retryCooldownMs(env),
  );
  const closeAlreadyPending = closePending(trade, plan);
  const nowDate = new Date(now);
  const next = {
    enabled: enabled(env.ADAPTIVE_LOSER_COMPRESSION_ENABLED, true),
    eligible: false,
    authority: ALC_AUTHORITY,
    action: ACTIONS.HOLD,
    desiredAction: ACTIONS.HOLD,
    reason: "ALC_HOLD",
    blockedReason: null,
    level: stateRank(maxState(currentTargetState, effectiveAppliedState)),
    failure,
    candidateFloor: null,
    tradePatch: {},
    state: legacyCompressionState(maxState(currentTargetState, effectiveAppliedState)),
    targetState: currentTargetState,
    submittedState: currentSubmittedState,
    appliedState: effectiveAppliedState,
    pendingAction,
    pendingSince: isoOrNull(trade?.loserCompressionPendingSince),
    retryCount,
    lastRequestedStop: Number.isFinite(lastRequestedStop) ? lastRequestedStop : null,
    lastConfirmedStop: Number.isFinite(lastConfirmedStop)
      ? lastConfirmedStop
      : Number.isFinite(currentStop)
        ? currentStop
        : null,
    lastAttemptAt: isoOrNull(trade?.loserCompressionLastAttemptAt),
    lastConfirmedAt: isoOrNull(trade?.loserCompressionLastConfirmedAt),
    requestOutcome: REQUEST_OUTCOMES.HOLD,
    requestReady: false,
    requestBlockedReason: null,
    appliedConfirmed: Boolean(attribution.alcAppliedConfirmed),
    appliedSource: attribution.alcAppliedSource ?? null,
    attributionConfidence: attribution.alcAttributionConfidence ?? null,
    superseded: false,
    supersedeReason: null,
    exitNow: false,
    exitReasonCode: null,
    loserCompressionActive: false,
    escalated: false,
    proposedStop: null,
    finalStop: null,
    triggeredAt:
      trade?.loserCompressionLastActionAt ??
      trade?.loserCompressionActivatedAt ??
      null,
    finalProtectionOwner: attribution.alcFinalProtectionOwner ?? null,
    requested: Boolean(attribution.alcRequested),
    requestedLevel: attribution.alcRequestedLevel ?? null,
    appliedLevel: attribution.alcAppliedLevel ?? null,
    requestedButNotApplied: Boolean(attribution.alcRequestedButNotApplied),
    appliedButSuperseded: Boolean(attribution.alcAppliedButSuperseded),
    supersededBy: attribution.alcSupersededBy ?? null,
    savedRiskR: attribution.alcSavedRiskR ?? null,
    savedRiskInr: attribution.alcSavedRiskInr ?? null,
  };

  assignPatch(next.tradePatch, "loserCompressionTargetState", currentTargetState);
  assignPatch(next.tradePatch, "loserCompressionSubmittedState", currentSubmittedState);
  assignPatch(next.tradePatch, "loserCompressionAppliedState", effectiveAppliedState);
  assignPatch(next.tradePatch, "loserCompressionPendingAction", pendingAction);
  assignPatch(
    next.tradePatch,
    "loserCompressionPendingSince",
    trade?.loserCompressionPendingSince ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionLastRequestedStop",
    Number.isFinite(lastRequestedStop) ? lastRequestedStop : null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionLastConfirmedStop",
    Number.isFinite(lastConfirmedStop)
      ? lastConfirmedStop
      : Number.isFinite(currentStop)
        ? currentStop
        : null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionLastAttemptAt",
    trade?.loserCompressionLastAttemptAt ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionLastConfirmedAt",
    trade?.loserCompressionLastConfirmedAt ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionAppliedSource",
    trade?.loserCompressionAppliedSource ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionAppliedConfirmed",
    Boolean(trade?.loserCompressionAppliedConfirmed),
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionAttributionConfidence",
    trade?.loserCompressionAttributionConfidence ?? null,
  );
  assignPatch(next.tradePatch, "loserCompressionRetryCount", retryCount);
  assignPatch(
    next.tradePatch,
    "loserCompressionBlockedReason",
    trade?.loserCompressionBlockedReason ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionLastAction",
    trade?.loserCompressionLastAction ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionTriggeredAt",
    trade?.loserCompressionTriggeredAt ?? trade?.loserCompressionActivatedAt ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserCompressionEscalatedAt",
    trade?.loserCompressionEscalatedAt ?? null,
  );
  assignPatch(
    next.tradePatch,
    "loserExitTriggered",
    Boolean(trade?.loserExitTriggered),
  );
  assignPatch(
    next.tradePatch,
    "loserExitReasonCode",
    trade?.loserExitReasonCode ?? null,
  );

  if (stateRank(effectiveAppliedState) > stateRank(currentAppliedState)) {
    next.appliedConfirmed = true;
    next.appliedSource =
      attribution.alcAppliedSource ||
      alcAppliedSourceForState(effectiveAppliedState);
    next.attributionConfidence =
      attribution.alcAttributionConfidence ||
      "MEDIUM";
    assignPatch(next.tradePatch, "loserCompressionAppliedState", effectiveAppliedState);
    assignPatch(
      next.tradePatch,
      "loserCompressionLastConfirmedStop",
      Number.isFinite(currentStop) ? currentStop : null,
    );
    assignPatch(next.tradePatch, "loserCompressionLastConfirmedAt", nowDate);
    assignPatch(
      next.tradePatch,
      "loserCompressionAppliedSource",
      next.appliedSource,
    );
    assignPatch(next.tradePatch, "loserCompressionAppliedConfirmed", true);
    assignPatch(
      next.tradePatch,
      "loserCompressionAttributionConfidence",
      next.attributionConfidence,
    );
    assignPatch(next.tradePatch, "loserCompressionPendingAction", null);
    assignPatch(next.tradePatch, "loserCompressionPendingSince", null);
    assignPatch(next.tradePatch, "loserCompressionRetryCount", 0);
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", "ALC_APPLIED_CONFIRMED");
    assignPatch(next.tradePatch, "loserCompressionLastAction", "APPLIED_CONFIRMED");
    next.lastConfirmedStop = Number.isFinite(currentStop) ? currentStop : next.lastConfirmedStop;
    next.lastConfirmedAt = nowDate.toISOString();
    setRequestTelemetry(next, {
      requestOutcome: REQUEST_OUTCOMES.CONFIRMED,
    });
  }

  if (!next.enabled) {
    next.blockedReason = "ALC_DISABLED";
    next.reason = next.blockedReason;
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }
  if (isClosedTrade(trade)) {
    next.blockedReason = "ALC_BLOCKED_CLOSING";
    next.reason = next.blockedReason;
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }
  if (!executableQuoteEligible({ trade, metrics })) {
    next.blockedReason = "ALC_BLOCKED_STALE_QUOTE";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }
  if (blockingWinnerProtection({ trade, plan })) {
    next.blockedReason = "ALC_BLOCKED_WINNER_MODE";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }
  if (!failure.gracePassed) {
    next.blockedReason = "ALC_BLOCKED_GRACE";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  next.eligible = true;

  const weakMfeCap = Math.max(0.01, n(env.ALC_MAX_MFE_FOR_FAILURE_R, 0.1));
  const weakEnough =
    !Number.isFinite(failure.mfeR) || failure.mfeR <= Math.max(0.2, weakMfeCap * 2);
  const noMfe =
    !Number.isFinite(failure.mfeR) || failure.mfeR <= weakMfeCap;
  const requireStructure = enabled(env.ALC_REQUIRE_STRUCTURE_FOR_COMPRESSION, true);
  const allowExitWithoutStructure = enabled(
    env.ALC_ALLOW_EXIT_WITHOUT_STRUCTURE_ON_EXTREME_FAILURE,
    true,
  );
  const scoreL1 = Math.max(0, n(env.ALC_SCORE_COMPRESS_L1, 70));
  const scoreL2 = Math.max(scoreL1, n(env.ALC_SCORE_COMPRESS_L2, 85));
  const scoreExit = Math.max(scoreL2, n(env.ALC_SCORE_EXIT_NOW, 95));
  const adverseL1 = Math.max(0, n(env.ALC_ADVERSE_R_L1, 0.4));
  const adverseL2 = Math.max(adverseL1, n(env.ALC_ADVERSE_R_L2, 0.6));
  const adverseExit = Math.max(adverseL2, n(env.ALC_ADVERSE_R_EXIT, 0.85));

  let desiredAction = ACTIONS.HOLD;
  if (
    (
      failure.score >= scoreExit ||
      (noMfe &&
        failure.adverseR >= adverseExit &&
        (failure.structureBroken || allowExitWithoutStructure))
    ) &&
    (
      failure.structureBroken ||
      (allowExitWithoutStructure &&
        noMfe &&
        failure.adverseR >= adverseExit)
    )
  ) {
    desiredAction = ACTIONS.EXIT_NOW;
  } else if (
    failure.score >= scoreL2 &&
    weakEnough &&
    failure.adverseR >= adverseL2 &&
    (!requireStructure || failure.structureBroken)
  ) {
    desiredAction = ACTIONS.COMPRESS_L2;
  } else if (
    failure.score >= scoreL1 &&
    weakEnough &&
    failure.adverseR >= adverseL1 &&
    (!requireStructure || failure.structureBroken)
  ) {
    desiredAction = ACTIONS.COMPRESS_L1;
  } else if (
    requireStructure &&
    failure.score >= scoreL1 &&
    !failure.structureBroken
  ) {
    next.blockedReason = "ALC_BLOCKED_NO_STRUCTURE";
    next.reason = next.blockedReason;
  }

  next.desiredAction = desiredAction;

  const desiredState = actionState(desiredAction);
  const targetState = maxState(currentTargetState, effectiveAppliedState, desiredState);
  const escalated =
    stateRank(targetState) > stateRank(currentTargetState) &&
    currentTargetState !== COMPRESSION_STATES.NONE;
  next.targetState = targetState;
  next.appliedState = effectiveAppliedState;
  next.level = stateRank(targetState);
  next.state = legacyCompressionState(targetState);
  next.escalated = escalated;
  next.requested = targetState !== COMPRESSION_STATES.NONE;
  next.requestedLevel =
    targetState !== COMPRESSION_STATES.NONE ? targetState : null;
  next.appliedLevel =
    effectiveAppliedState !== COMPRESSION_STATES.NONE
      ? effectiveAppliedState
      : null;
  next.requestedButNotApplied = Boolean(
    next.requested && !next.appliedConfirmed,
  );
  next.finalProtectionOwner =
    targetState === COMPRESSION_STATES.EXIT
      ? "ALC_EXIT_NOW"
      : targetState !== COMPRESSION_STATES.NONE
        ? alcAppliedSourceForState(targetState)
        : attribution.alcFinalProtectionOwner ?? null;

  assignPatch(next.tradePatch, "loserCompressionTargetState", targetState);
  assignPatch(next.tradePatch, "loserCompressionState", legacyCompressionState(targetState));

  if (targetState !== COMPRESSION_STATES.NONE && !trade?.loserCompressionActivatedAt) {
    assignPatch(next.tradePatch, "loserCompressionActivatedAt", nowDate);
    assignPatch(next.tradePatch, "loserCompressionTriggeredAt", nowDate);
  }
  if (escalated) {
    assignPatch(next.tradePatch, "loserCompressionEscalatedAt", nowDate);
  }

  if (targetState === COMPRESSION_STATES.NONE) {
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  const targetStop = stopForState({
    state: targetState,
    side,
    entry,
    qty: metrics?.qty,
    riskInr: metrics?.riskInr,
    tick,
    env,
  });
  const finalStop = betterStop(side, currentStop, targetStop);
  next.proposedStop = Number.isFinite(targetStop) ? targetStop : null;
  next.finalStop = Number.isFinite(finalStop) ? finalStop : null;

  const supersedeAllowed = enabled(env.ALC_SUPERSEDE_PENDING_L1_WITH_L2, true);
  const canSupersedePendingL1 =
    supersedeAllowed &&
    targetState === COMPRESSION_STATES.L2 &&
    currentSubmittedState === COMPRESSION_STATES.L1 &&
    pendingAction === PENDING_ACTIONS.STOP_MODIFY;

  if (
    targetState === COMPRESSION_STATES.EXIT &&
    (closeAlreadyPending || pendingAction === PENDING_ACTIONS.EXIT_REQUEST)
  ) {
    next.blockedReason = "ALC_BLOCKED_PENDING_CLOSE";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (targetState !== COMPRESSION_STATES.EXIT && closeAlreadyPending) {
    next.blockedReason = "ALC_BLOCKED_PENDING_CLOSE";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (targetState !== COMPRESSION_STATES.EXIT && stateRank(effectiveAppliedState) >= stateRank(targetState)) {
    next.blockedReason = "ALC_BLOCKED_ALREADY_CONFIRMED";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    assignPatch(next.tradePatch, "loserCompressionPendingAction", null);
    assignPatch(next.tradePatch, "loserCompressionPendingSince", null);
    assignPatch(next.tradePatch, "loserCompressionRetryCount", 0);
    setRequestTelemetry(next, {
      requestOutcome: REQUEST_OUTCOMES.CONFIRMED,
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (
    targetState !== COMPRESSION_STATES.EXIT &&
    Number.isFinite(finalStop) &&
    !isBetterStop(side, finalStop, currentStop, Math.max(0.000001, Number(tick ?? 0.05) / 2))
  ) {
    next.blockedReason = "ALC_BLOCKED_ALREADY_TIGHTER_NON_ALC";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (
    targetState !== COMPRESSION_STATES.EXIT &&
    Number.isFinite(finalStop) &&
    stopDistance(side, finalStop, currentStop) < minImproveDistance
  ) {
    next.blockedReason = "ALC_BLOCKED_MIN_STEP";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (
    targetState !== COMPRESSION_STATES.EXIT &&
    pendingAction === PENDING_ACTIONS.STOP_MODIFY &&
    !stalePending &&
    !canSupersedePendingL1 &&
    Boolean(trade?.protectionUpgradePending) &&
    Number.isFinite(pendingTargetStop) &&
    !isBetterStop(side, finalStop, pendingTargetStop)
  ) {
    next.blockedReason = "ALC_BLOCKED_PENDING_MODIFY";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (pendingAction && !stalePending && !canSupersedePendingL1) {
    next.blockedReason =
      pendingAction === PENDING_ACTIONS.EXIT_REQUEST
        ? "ALC_BLOCKED_PENDING_CLOSE"
        : "ALC_BLOCKED_PENDING_MODIFY";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  const maxRetries = maxRetriesForState(targetState, env);
  if (retryCount >= maxRetries && !stalePending && !canSupersedePendingL1) {
    next.blockedReason = "ALC_BLOCKED_RETRY_LIMIT";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  if (retryCount > 0 && retryCooldownActive && !stalePending && !canSupersedePendingL1) {
    next.blockedReason = "ALC_BLOCKED_RETRY_COOLDOWN";
    next.reason = next.blockedReason;
    assignPatch(next.tradePatch, "loserCompressionBlockedReason", next.blockedReason);
    setRequestTelemetry(next, {
      requestBlockedReason: next.blockedReason,
    });
    return next;
  }

  const supersedeReason = canSupersedePendingL1
    ? REQUEST_OUTCOMES.SUPERSEDE_L1_TO_L2
    : null;
  const retrying = retryCount > 0 || stalePending;
  next.action =
    targetState === COMPRESSION_STATES.EXIT
      ? ACTIONS.EXIT_NOW
      : targetState === COMPRESSION_STATES.L2
        ? ACTIONS.COMPRESS_L2
        : ACTIONS.COMPRESS_L1;
  next.reason = actionReason(next.action);
  next.level = actionLevel(next.action);
  next.triggeredAt = nowDate.toISOString();
  next.exitNow = targetState === COMPRESSION_STATES.EXIT;
  next.exitReasonCode = next.exitNow ? "ALC_EXIT_NOW" : null;
  next.loserCompressionActive = targetState !== COMPRESSION_STATES.EXIT;

  assignPatch(next.tradePatch, "loserCompressionScoreAtLastAction", failure.score);
  assignPatch(next.tradePatch, "loserCompressionReasonAtLastAction", next.reason);
  assignPatch(next.tradePatch, "loserCompressionLastActionAt", nowDate);
  assignPatch(next.tradePatch, "loserCompressionLastAction", next.action);
  assignPatch(next.tradePatch, "loserCompressionBlockedReason", null);
  assignPatch(
    next.tradePatch,
    "loserExitTriggered",
    targetState === COMPRESSION_STATES.EXIT,
  );
  assignPatch(
    next.tradePatch,
    "loserExitReasonCode",
    targetState === COMPRESSION_STATES.EXIT ? "ALC_EXIT_NOW" : null,
  );

  if (next.exitNow) {
    setRequestTelemetry(next, {
      requestReady: true,
      requestOutcome: retrying
        ? REQUEST_OUTCOMES.RETRY_EXIT
        : REQUEST_OUTCOMES.READY,
      superseded: Boolean(supersedeReason),
      supersedeReason,
    });
    return next;
  }

  next.candidateFloor = {
    source: sourceForState(targetState),
    price: finalStop,
    eligible: Number.isFinite(finalStop),
    phase: "PHASE_0_LOSS_CONTAINMENT",
    details: {
      action: next.action,
      targetState,
      retainedLossCapR: stateLossCapR(targetState, env),
      score: failure.score,
      adverseR: failure.adverseR,
      mfeR: failure.mfeR,
      structureBroken: failure.structureBroken,
      retryCount,
      stalePending,
    },
  };
  setRequestTelemetry(next, {
    requestReady: Number.isFinite(finalStop),
    requestOutcome: supersedeReason
      ? supersedeReason
      : retrying
        ? targetState === COMPRESSION_STATES.L2
          ? REQUEST_OUTCOMES.RETRY_L2
          : REQUEST_OUTCOMES.RETRY_L1
        : REQUEST_OUTCOMES.READY,
    superseded: Boolean(supersedeReason),
    supersedeReason,
  });
  return next;
}

module.exports = {
  ACTIONS,
  ALC_AUTHORITY,
  COMPRESSION_STATES,
  REQUEST_OUTCOMES,
  evaluateAdaptiveLoserCompression,
  normalizeCompressionState,
};
