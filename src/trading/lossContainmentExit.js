const { isWinnerProtectionActive, resolveExitLifecycle } = require("./tradeLifecycleState");

const EARLY_FAIL_ENGINE_AUTHORITY = "EARLY_FAIL_ENGINE";

function n(v, fb = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function enabled(v, fb = false) {
  if (v === null || v === undefined || v === "") return fb;
  return String(v) === "true";
}

function tsFrom(v) {
  if (!v) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ts = Date.parse(v);
  return Number.isFinite(ts) ? ts : null;
}

function profitR({ side, entry, ltp, risk }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !(risk > 0)) return 0;
  return side === "SELL" ? (entry - ltp) / risk : (ltp - entry) / risk;
}

function toFiniteOrNull(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function adverseUnderlyingBps({ trade, underlyingLtp }) {
  const entry = n(
    trade?.underlying_ltp ??
      trade?.planMeta?.underlying?.entry ??
      trade?.option_meta?.underlyingLtp ??
      trade?.optionMeta?.underlyingLtp,
    NaN,
  );
  const now = n(underlyingLtp, NaN);
  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(now) && now > 0)) {
    return null;
  }
  const optType = String(
    trade?.option_meta?.optType ||
      trade?.optionMeta?.optType ||
      trade?.instrument?.tradingsymbol ||
      "",
  ).toUpperCase();
  if (optType.includes("PE")) {
    return now > entry ? ((now - entry) / entry) * 10000 : 0;
  }
  return now < entry ? ((entry - now) / entry) * 10000 : 0;
}

function strategyProfileKey(trade = {}) {
  const id = String(trade?.strategyId || "").toLowerCase();
  const family = String(
    trade?.planMeta?.family || trade?.option_meta?.strategyFamily || "",
  ).toLowerCase();
  const style = String(
    trade?.planMeta?.style || trade?.strategyStyle || trade?.option_meta?.strategyStyle || "",
  ).toUpperCase();

  if (id.includes("orb")) return "ORB";
  if (
    id.includes("breakout") ||
    id.includes("squeeze") ||
    id.includes("volume_spike") ||
    id.includes("reclaim") ||
    id.includes("ema_pullback") ||
    family.includes("breakout") ||
    family.includes("momentum") ||
    style === "TREND"
  ) {
    return "BREAKOUT";
  }
  if (
    style === "RANGE" ||
    id.includes("fade") ||
    id.includes("reversal") ||
    id.includes("fakeout") ||
    id.includes("wick")
  ) {
    return "MEAN_REVERSION";
  }
  return "DEFAULT";
}

function barMsFromTrade(trade = {}) {
  const intervalMin = Math.max(
    1,
    n(trade?.intervalMin ?? trade?.candle?.interval_min, 1),
  );
  return intervalMin * 60 * 1000;
}

function resolveStallGraceMs({ trade, env }) {
  const profileKey = strategyProfileKey(trade);
  if (profileKey === "ORB") {
    return Math.max(0, n(env.EARLY_STALL_ORB_GRACE_MS, 20_000));
  }
  if (profileKey === "BREAKOUT") {
    return Math.max(0, n(env.EARLY_STALL_BREAKOUT_GRACE_MS, 15_000));
  }
  return 0;
}

function resolveStructureReference({ trade, env, sl0 }) {
  const useUnderlying = enabled(env.EARLY_STRUCTURE_FAIL_USE_UNDERLYING, true);
  const planUnderlyingStop = n(trade?.planMeta?.underlying?.stop, NaN);
  const planUnderlyingEntry = n(trade?.planMeta?.underlying?.entry, NaN);
  const planUnderlyingRisk =
    Number.isFinite(planUnderlyingStop) && Number.isFinite(planUnderlyingEntry)
      ? Math.abs(planUnderlyingEntry - planUnderlyingStop)
      : null;

  if (useUnderlying && Number.isFinite(planUnderlyingStop)) {
    return {
      kind: "UNDERLYING",
      level: planUnderlyingStop,
      source: "PLAN_UNDERLYING_STOP",
      fallbackRisk: planUnderlyingRisk,
    };
  }

  const strategyStop = n(
    trade?.strategyStopLoss ?? trade?.initialStopLoss ?? sl0,
    NaN,
  );
  return Number.isFinite(strategyStop)
    ? {
        kind: "PREMIUM",
        level: strategyStop,
        source: "STRATEGY_STOP_LOSS",
        fallbackRisk:
          Number.isFinite(n(trade?.entryPrice, NaN)) && Number.isFinite(strategyStop)
            ? Math.abs(Number(trade.entryPrice) - strategyStop)
            : null,
      }
    : {
        kind: null,
        level: null,
        source: null,
        fallbackRisk: null,
      };
}

function structureObservedPrice({ reference, ltp, underlyingLtp }) {
  if (reference?.kind === "UNDERLYING") return n(underlyingLtp, NaN);
  return n(ltp, NaN);
}

function structureBreachAmount({ side, referenceLevel, observedPrice }) {
  if (!Number.isFinite(referenceLevel) || !Number.isFinite(observedPrice)) {
    return null;
  }
  if (String(side || "BUY").toUpperCase() === "SELL") {
    return observedPrice - referenceLevel;
  }
  return referenceLevel - observedPrice;
}

function resolveStructureBuffer({
  trade,
  plan,
  env,
  reference,
}) {
  const tickBuffer =
    Math.max(0, n(env.EARLY_STRUCTURE_FAIL_BUFFER_TICKS, 6)) *
    Math.max(0.01, n(trade?.instrument?.tick_size, 0.05));
  const pointBuffer = Math.max(0, n(env.EARLY_STRUCTURE_FAIL_BUFFER_POINTS, 0));
  const frac = Math.max(0, n(env.EARLY_STRUCTURE_FAIL_BUFFER_ATR_FRACTION, 0.15));
  const atrBase =
    [
      n(plan?.meta?.atr, NaN),
      n(trade?.planMeta?.underlying?.R, NaN),
      n(reference?.fallbackRisk, NaN),
    ].find((value) => Number.isFinite(value) && value > 0) ?? null;
  const atrBuffer =
    Number.isFinite(atrBase) && atrBase > 0 && frac > 0 ? atrBase * frac : 0;
  return Math.max(pointBuffer, tickBuffer, atrBuffer);
}

function resolveEarlyFailConfirmationState({
  trade,
  now,
  candidateReason,
  targetTicks,
  targetMs,
}) {
  const prevReason = String(trade?.earlyFailCandidateReason || "");
  const prevSinceTs = tsFrom(trade?.earlyFailSinceTs);
  const prevTicks = Math.max(0, Math.round(n(trade?.earlyFailConfirmTicks, 0)));
  const active = Boolean(candidateReason);
  const sameCandidate = active && prevReason === String(candidateReason || "");
  const sinceTs = active ? (sameCandidate && prevSinceTs ? prevSinceTs : now) : null;
  const confirmTicks = active ? (sameCandidate ? prevTicks + 1 : 1) : 0;
  const confirmMs =
    active && Number.isFinite(sinceTs) ? Math.max(0, now - sinceTs) : 0;
  const ticksOk = !Number.isFinite(targetTicks) || targetTicks <= 0 || confirmTicks >= targetTicks;
  const msOk = !Number.isFinite(targetMs) || targetMs <= 0 || confirmMs >= targetMs;

  return {
    active,
    sinceTs,
    confirmTicks,
    confirmMs,
    confirmed: active && ticksOk && msOk,
  };
}

function buildStructureFailureDecision({
  trade,
  env,
  plan,
  ltp,
  underlyingLtp,
  sl0,
  side,
  currentR,
  peakR,
  rejectionR,
}) {
  const structureBreakEnabled = enabled(env.EARLY_FAIL_STRUCTURE_BREAK_ENABLED, true);
  const reference = resolveStructureReference({ trade, env, sl0 });
  const observedPrice = structureObservedPrice({ reference, ltp, underlyingLtp });
  const referenceLevel = n(reference?.level, NaN);
  const breachAmount = structureBreachAmount({
    side,
    referenceLevel,
    observedPrice,
  });
  const bufferUsed = resolveStructureBuffer({
    trade,
    plan,
    env,
    reference,
  });
  const confirmTargetTicks = Math.max(
    1,
    Math.round(n(env.EARLY_STRUCTURE_FAIL_CONFIRM_TICKS, 2)),
  );
  const confirmTargetMs = Math.max(
    0,
    n(env.EARLY_STRUCTURE_FAIL_CONFIRM_MS, 4_000),
  );
  const breachSeverity =
    Number.isFinite(breachAmount) && Number.isFinite(bufferUsed) && bufferUsed > 0
      ? breachAmount / bufferUsed
      : Number.isFinite(breachAmount) && breachAmount > 0
        ? Infinity
        : 0;
  const greenExitMaxR = Math.max(
    0,
    n(env.EARLY_STRUCTURE_FAIL_GREEN_EXIT_MAX_R, 0.12),
  );
  const greenExitMinRejectionR = Math.max(
    0,
    n(env.EARLY_STRUCTURE_FAIL_GREEN_MIN_REJECTION_R, 0.1),
  );
  const greenSeverityMult = Math.max(
    1,
    n(env.EARLY_STRUCTURE_FAIL_GREEN_SEVERITY_MULT, 2.25),
  );
  const greenExitAllowed =
    Number.isFinite(currentR) &&
    currentR >= 0 &&
    currentR <= greenExitMaxR &&
    Number.isFinite(breachSeverity) &&
    breachSeverity >= greenSeverityMult &&
    (!Number.isFinite(rejectionR) || rejectionR >= greenExitMinRejectionR) &&
    (!Number.isFinite(peakR) || peakR <= Math.max(0.45, greenExitMaxR + 0.2));

  let holdReason = null;
  let candidateReason = null;
  let confirmTicks = confirmTargetTicks;
  let confirmMs = confirmTargetMs;
  if (!structureBreakEnabled) {
    holdReason = "STRUCTURE_DISABLED";
  } else if (!Number.isFinite(referenceLevel) || !Number.isFinite(observedPrice)) {
    holdReason = "STRUCTURE_REFERENCE_UNAVAILABLE";
  } else if (!Number.isFinite(breachAmount) || breachAmount <= 0) {
    holdReason =
      reference?.kind === "UNDERLYING"
        ? "UNDERLYING_INTACT"
        : "STRUCTURE_INTACT";
  } else if (breachAmount <= bufferUsed) {
    holdReason = "STRUCTURE_BREACH_TOO_SMALL";
  } else if (!Number.isFinite(currentR)) {
    holdReason = "INSUFFICIENT_ADVERSE_FOLLOW_THROUGH";
  } else if (currentR > 0 && !greenExitAllowed) {
    holdReason = "GREEN_THESIS_NOT_INVALIDATED";
  } else if (currentR > 0 && greenExitAllowed) {
    candidateReason = "EARLY_STRUCTURE_FAILURE";
    confirmTicks = Math.max(
      confirmTargetTicks,
      Math.round(n(env.EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_TICKS, confirmTargetTicks + 1)),
    );
    confirmMs = Math.max(
      confirmTargetMs,
      n(env.EARLY_STRUCTURE_FAIL_GREEN_CONFIRM_MS, confirmTargetMs),
    );
  } else {
    candidateReason = "EARLY_STRUCTURE_FAILURE";
  }

  return {
    mode: "STRUCTURE",
    candidateReason,
    holdReason,
    confirmTargetTicks: confirmTicks,
    confirmTargetMs: confirmMs,
    bufferUsed,
    referenceLevel: toFiniteOrNull(referenceLevel),
    referenceSource: reference?.source ?? null,
    breachAmount: toFiniteOrNull(breachAmount),
    breachSeverity: toFiniteOrNull(breachSeverity),
  };
}

function buildStallDecision({
  trade,
  env,
  holdMs,
  barsSinceEntry,
  currentR,
  peakR,
  rejectionR,
}) {
  const minAgeBaseMs = Math.max(
    0,
    n(
      env.EARLY_STALL_MIN_TRADE_AGE_MS,
      n(env.EARLY_FAIL_MAX_STALL_MS, 20_000),
    ),
  );
  const minAgeMs = minAgeBaseMs + resolveStallGraceMs({ trade, env });
  const minBarsSinceEntry = Math.max(
    0,
    Math.round(n(env.EARLY_STALL_MIN_BARS_SINCE_ENTRY, 1)),
  );
  const confirmTargetTicks = Math.max(
    1,
    Math.round(n(env.EARLY_STALL_CONFIRM_TICKS, 3)),
  );
  const confirmTargetMs = Math.max(
    0,
    n(env.EARLY_STALL_CONFIRM_MS, 10_000),
  );
  const minMfeR = Math.max(0, n(env.EARLY_STALL_MIN_MFE_R, 0.2));
  const maxAdverseR = Math.min(0, n(env.EARLY_STALL_MAX_ADVERSE_R, -0.08));
  const peakTooSmall = !Number.isFinite(peakR) || peakR < minMfeR;
  const weakened =
    Number.isFinite(currentR) && currentR <= maxAdverseR;
  const noProgress =
    Number.isFinite(rejectionR) && rejectionR >= Math.max(0.08, minMfeR * 0.5);

  let holdReason = null;
  let candidateReason = null;
  if (holdMs < minAgeMs) {
    holdReason = "STALL_GRACE_WINDOW_ACTIVE";
  } else if (barsSinceEntry < minBarsSinceEntry) {
    holdReason = "STALL_MIN_BARS_NOT_MET";
  } else if (!peakTooSmall) {
    holdReason = "STALL_MFE_OK";
  } else if (!(weakened || noProgress)) {
    holdReason = "STALL_NO_WEAKNESS";
  } else if (!weakened) {
    holdReason = "STALL_INSUFFICIENT_ADVERSE_FOLLOW_THROUGH";
  } else {
    candidateReason = "EARLY_STALL_EXIT";
  }

  return {
    mode: "STALL",
    candidateReason,
    holdReason,
    confirmTargetTicks,
    confirmTargetMs,
    bufferUsed: null,
    referenceLevel: null,
    referenceSource: null,
    breachAmount: null,
  };
}

function buildNoFollowThroughDecision({
  env,
  holdMs,
  currentR,
  peakR,
  rejectionR,
  minPeakR,
}) {
  const confirmMs = Math.max(
    5_000,
    Math.min(
      Math.max(0, n(env.EARLY_FAIL_WINDOW_MS, 90_000)),
      Math.max(10_000, Math.round(n(env.EARLY_FAIL_WINDOW_MS, 90_000) * 0.4)),
    ),
  );
  const peakTooSmall = !Number.isFinite(peakR) || peakR < minPeakR;
  const candidateReason =
    holdMs >= confirmMs &&
    peakTooSmall &&
    (currentR <= -0.12 || rejectionR >= Math.max(minPeakR, 0.18))
      ? "EARLY_NO_FOLLOW_THROUGH"
      : null;

  return {
    mode: "NO_FOLLOW_THROUGH",
    candidateReason,
    holdReason: candidateReason ? null : "NO_FOLLOW_THROUGH_NOT_MET",
    confirmTargetTicks: 1,
    confirmTargetMs: 0,
    bufferUsed: null,
    referenceLevel: null,
    referenceSource: null,
    breachAmount: null,
    confirmMs,
  };
}

function applyLossContainmentExitRules({
  trade,
  plan,
  ltp,
  underlyingLtp,
  now,
  env,
  entry,
  sl0,
  side,
}) {
  if (!plan?.ok) return plan;

  const tradePatch = { ...(plan?.tradePatch || {}) };
  const risk = Math.abs(n(entry, NaN) - n(sl0, NaN));
  const holdStart =
    tsFrom(trade?.entryFilledAt) ||
    tsFrom(trade?.entryAt) ||
    tsFrom(trade?.createdAt) ||
    now;
  const holdMs = Math.max(0, now - holdStart);
  const currentR = Number.isFinite(n(plan?.meta?.protectedCurrentR, NaN))
    ? n(plan?.meta?.protectedCurrentR, NaN)
    : Number.isFinite(n(plan?.meta?.currentExecutableR, NaN))
      ? n(plan?.meta?.currentExecutableR, NaN)
      : Number.isFinite(n(plan?.meta?.pnlPriceR, NaN))
        ? n(plan?.meta?.pnlPriceR, NaN)
        : profitR({ side, entry, ltp, risk });
  const peakR = Number.isFinite(n(plan?.meta?.mfeR, NaN))
    ? n(plan?.meta?.mfeR, NaN)
    : Number.isFinite(n(plan?.meta?.protectedPeakR, NaN))
      ? n(plan?.meta?.protectedPeakR, NaN)
    : Number.isFinite(n(plan?.meta?.peakPriceR, NaN))
      ? n(plan?.meta?.peakPriceR, NaN)
      : currentR;
  const beEligible =
    Boolean(plan?.meta?.beEligible) ||
    Boolean(trade?.beEligible) ||
    (Number.isFinite(n(plan?.meta?.pnlInr, NaN)) &&
      Number.isFinite(n(plan?.meta?.beLockAt, NaN)) &&
      n(plan?.meta?.pnlInr, NaN) >= n(plan?.meta?.beLockAt, NaN));
  const beApplied = Boolean(plan?.meta?.beApplied ?? trade?.beAppliedAt);
  const trailAllowed = Boolean(plan?.meta?.trailAllowed ?? trade?.trailAllowed);
  const trailActive = Boolean(plan?.meta?.trailActive ?? trade?.trailActive);
  const winnerModeActive = isWinnerProtectionActive({
    ...trade,
    beEligible,
    beApplied,
    trailAllowed,
    trailActive,
    greenLockActive: Boolean(plan?.meta?.greenLockActive ?? trade?.greenLockActive),
    profitLockArmed: Boolean(plan?.meta?.profitLockArmed ?? trade?.profitLockArmed),
    mfeLockTier: Number(plan?.meta?.mfeLockTier ?? trade?.mfeLockTier ?? 0),
    givebackActive: Boolean(
      plan?.meta?.givebackActive ??
        trade?.givebackActive ??
        trade?.hardGivebackExitArmed,
    ),
  });

  const earlyFailEnabled = enabled(env.EARLY_FAIL_ENABLED, true);
  const windowMs = Math.max(0, n(env.EARLY_FAIL_WINDOW_MS, 90_000));
  const minPeakR = Math.max(0, n(env.EARLY_FAIL_MIN_PEAK_R, 0.25));
  const withinWindow = windowMs > 0 && holdMs <= windowMs;
  const rejectionR =
    Number.isFinite(peakR) && Number.isFinite(currentR) ? Math.max(0, peakR - currentR) : 0;
  const adverseUnderlyingMoveBps = adverseUnderlyingBps({ trade, underlyingLtp });
  const barsSinceEntry = Math.max(
    0,
    Math.floor(holdMs / Math.max(1, barMsFromTrade(trade))),
  );
  const earlyFailMfeAtDecision =
    Number.isFinite(peakR) ? Math.max(0, peakR) : null;
  const earlyFailAdverseRAtDecision =
    Number.isFinite(currentR) ? Math.max(0, -currentR) : null;

  const earlyFailArmed = Boolean(earlyFailEnabled && withinWindow && !winnerModeActive);
  const earlyFailEligible = Boolean(earlyFailArmed && !plan?.action?.exitNow);
  const earlyFailAuthority = earlyFailEligible
    ? EARLY_FAIL_ENGINE_AUTHORITY
    : null;
  let earlyFailReason = null;
  let earlyFailMode = null;
  let earlyFailDecisionState = "IDLE";
  let earlyFailHoldReason = null;
  let earlyFailBufferUsed = null;
  let earlyFailReferenceLevel = null;
  let earlyFailReferenceSource = null;
  let earlyFailBreachAmount = null;
  let earlyFailBreachSeverity = null;
  let earlyFailConfirmTarget = 0;
  let earlyFailConfirmTargetMs = 0;
  let earlyFailSinceTs = null;
  let earlyFailConfirmTicks = 0;
  let earlyFailConfirmMs = 0;
  let earlyFailCandidateReason = null;

  if (!earlyFailEnabled) {
    earlyFailDecisionState = "DISABLED";
  } else if (!withinWindow) {
    earlyFailDecisionState = "WINDOW_EXPIRED";
  } else if (winnerModeActive) {
    earlyFailDecisionState = "WINNER_PROTECTION_ACTIVE";
  } else if (plan?.action?.exitNow) {
    earlyFailDecisionState = "ALREADY_EXITING";
  } else {
    const structureDecision = buildStructureFailureDecision({
      trade,
      env,
      plan,
      ltp,
      underlyingLtp,
      sl0,
      side,
      currentR,
      peakR,
      rejectionR,
    });
    const stallDecision = buildStallDecision({
      trade,
      env,
      holdMs,
      barsSinceEntry,
      currentR,
      peakR,
      rejectionR,
    });
    const noFollowThroughDecision = buildNoFollowThroughDecision({
      env,
      holdMs,
      currentR,
      peakR,
      rejectionR,
      minPeakR,
    });

    let decision = null;
    if (
      structureDecision.candidateReason ||
      [
        "STRUCTURE_BREACH_TOO_SMALL",
        "INSUFFICIENT_ADVERSE_FOLLOW_THROUGH",
      ].includes(structureDecision.holdReason)
    ) {
      decision = structureDecision;
    } else if (stallDecision.candidateReason || stallDecision.holdReason) {
      decision = stallDecision;
    } else if (noFollowThroughDecision.candidateReason) {
      decision = noFollowThroughDecision;
    }

    earlyFailMode = decision?.mode ?? null;
    earlyFailHoldReason = decision?.holdReason ?? null;
    earlyFailBufferUsed = toFiniteOrNull(decision?.bufferUsed);
    earlyFailReferenceLevel = toFiniteOrNull(decision?.referenceLevel);
    earlyFailReferenceSource = decision?.referenceSource ?? null;
    earlyFailBreachAmount = toFiniteOrNull(decision?.breachAmount);
    earlyFailBreachSeverity = toFiniteOrNull(decision?.breachSeverity);
    earlyFailConfirmTarget = Number(decision?.confirmTargetTicks ?? 0) || 0;
    earlyFailConfirmTargetMs = Number(decision?.confirmTargetMs ?? 0) || 0;
    earlyFailCandidateReason = decision?.candidateReason ?? null;

    const confirmation = resolveEarlyFailConfirmationState({
      trade,
      now,
      candidateReason: earlyFailCandidateReason,
      targetTicks: earlyFailConfirmTarget,
      targetMs: earlyFailConfirmTargetMs,
    });
    earlyFailSinceTs = confirmation.sinceTs;
    earlyFailConfirmTicks = confirmation.confirmTicks;
    earlyFailConfirmMs = confirmation.confirmMs;

    if (confirmation.confirmed) {
      earlyFailReason = earlyFailCandidateReason;
      earlyFailDecisionState = "EXIT_AUTHORIZED";
    } else if (confirmation.active) {
      earlyFailDecisionState = "CONFIRMING";
      if (!earlyFailHoldReason) earlyFailHoldReason = "CONFIRMATION_PENDING";
    } else if (earlyFailHoldReason) {
      earlyFailDecisionState = "HOLD";
    } else {
      earlyFailDecisionState = "ARMED_IDLE";
    }
  }

  tradePatch.earlyFailArmed = earlyFailArmed;
  tradePatch.earlyFailReason = earlyFailReason;
  tradePatch.earlyFailMode = earlyFailMode;
  tradePatch.earlyFailCandidateReason = earlyFailCandidateReason;
  tradePatch.earlyFailEligible = earlyFailEligible;
  tradePatch.earlyFailAuthority = earlyFailAuthority;
  tradePatch.earlyFailSinceTs = Number.isFinite(earlyFailSinceTs)
    ? new Date(earlyFailSinceTs)
    : null;
  tradePatch.earlyFailConfirmTicks = earlyFailConfirmTicks;
  tradePatch.earlyFailConfirmTarget = earlyFailConfirmTarget;
  tradePatch.earlyFailConfirmMs = earlyFailConfirmMs;
  tradePatch.earlyFailConfirmTargetMs = earlyFailConfirmTargetMs;
  tradePatch.earlyFailBufferUsed = earlyFailBufferUsed;
  tradePatch.earlyFailReferenceLevel = earlyFailReferenceLevel;
  tradePatch.earlyFailReferenceSource = earlyFailReferenceSource;
  tradePatch.earlyFailBreachAmount = earlyFailBreachAmount;
  tradePatch.earlyFailTradeAgeMs = holdMs;
  tradePatch.earlyFailBarsSinceEntry = barsSinceEntry;
  tradePatch.earlyFailMfeAtDecision = toFiniteOrNull(earlyFailMfeAtDecision);
  tradePatch.earlyFailAdverseRAtDecision = toFiniteOrNull(
    earlyFailAdverseRAtDecision,
  );
  // Legacy alias kept for existing consumers; this path does not track true historical MAE.
  tradePatch.earlyFailMaeAtDecision = toFiniteOrNull(
    earlyFailAdverseRAtDecision,
  );
  tradePatch.earlyFailDecisionState = earlyFailDecisionState;
  tradePatch.earlyFailHoldReason = earlyFailHoldReason;

  let action = plan?.action || null;
  if (earlyFailReason && !action?.exitNow) {
    action = { exitNow: true, reason: earlyFailReason };
    Object.assign(tradePatch, resolveExitLifecycle(earlyFailReason));
  }

  return {
    ...plan,
    action,
    tradePatch,
    meta: {
      ...(plan?.meta || {}),
      beEligible,
      earlyFailArmed,
      earlyFailMode,
      earlyFailReason,
      earlyFailCandidateReason,
      earlyFailEligible,
      earlyFailAuthority,
      earlyFailSinceTs: Number.isFinite(earlyFailSinceTs)
        ? new Date(earlyFailSinceTs).toISOString()
        : null,
      earlyFailTradeAgeMs: holdMs,
      earlyFailBarsSinceEntry: barsSinceEntry,
      earlyFailConfirmTicks,
      earlyFailConfirmTarget,
      earlyFailConfirmMs,
      earlyFailConfirmTargetMs: earlyFailConfirmTargetMs || null,
      earlyFailBufferUsed,
      earlyFailReferenceLevel,
      earlyFailReferenceSource,
      earlyFailBreachAmount,
      earlyFailBreachSeverity,
      earlyFailMfeAtDecision: toFiniteOrNull(earlyFailMfeAtDecision),
      earlyFailAdverseRAtDecision: toFiniteOrNull(
        earlyFailAdverseRAtDecision,
      ),
      // Legacy alias kept for existing consumers; this path does not track true historical MAE.
      earlyFailMaeAtDecision: toFiniteOrNull(earlyFailAdverseRAtDecision),
      earlyFailDecisionState,
      earlyFailHoldReason,
      earlyFailWindowMs: windowMs,
      earlyFailPeakR: peakR,
      earlyFailCurrentR: currentR,
      earlyFailRejectionR: rejectionR,
      earlyFailHoldMs: holdMs,
      earlyFailAdverseUnderlyingBps: adverseUnderlyingMoveBps,
      winnerModeActive,
    },
  };
}

module.exports = {
  adverseUnderlyingBps,
  applyLossContainmentExitRules,
  barMsFromTrade,
  resolveStructureBuffer,
  resolveStructureReference,
  structureBreachAmount,
  structureObservedPrice,
};
