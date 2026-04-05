const { roundToTick } = require("./priceUtils");

function n(v, fb = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function clamp(v, lo, hi) {
  let out = Number(v);
  if (!Number.isFinite(out)) return null;
  if (Number.isFinite(lo)) out = Math.max(lo, out);
  if (Number.isFinite(hi)) out = Math.min(hi, out);
  return out;
}

function enabled(v, fb = false) {
  if (v === null || v === undefined || v === "") return fb;
  return String(v) === "true";
}

function strategyProfileKey(trade = {}) {
  const id = String(trade?.strategyId || "").toLowerCase();
  const family = String(
    trade?.planMeta?.family || trade?.option_meta?.strategyFamily || "",
  ).toLowerCase();
  const style = String(
    trade?.planMeta?.style || trade?.strategyStyle || trade?.option_meta?.strategyStyle || "",
  ).toUpperCase();

  if (
    id.includes("breakout") ||
    id.includes("orb") ||
    id.includes("squeeze") ||
    id.includes("volume_spike") ||
    family.includes("breakout") ||
    family.includes("momentum")
  ) {
    return "BREAKOUT";
  }
  if (style === "OPEN" || family.includes("open")) return "OPEN";
  if (
    style === "RANGE" ||
    id.includes("fade") ||
    id.includes("reversal") ||
    id.includes("fakeout") ||
    id.includes("wick")
  ) {
    return "RANGE";
  }
  if (
    style === "TREND" ||
    id.includes("ema") ||
    id.includes("pullback") ||
    id.includes("reclaim") ||
    id.includes("cross")
  ) {
    return "TREND";
  }
  return "DEFAULT";
}

function urgencyMultiplier(profileKey, env) {
  if (profileKey === "BREAKOUT") return Math.max(1, n(env.ENTRY_LADDER_URGENCY_BREAKOUT_MULT, 2.4));
  if (profileKey === "OPEN") return Math.max(1, n(env.ENTRY_LADDER_URGENCY_OPEN_MULT, 2.0));
  if (profileKey === "TREND") return Math.max(1, n(env.ENTRY_LADDER_URGENCY_TREND_MULT, 1.6));
  if (profileKey === "RANGE") return Math.max(0.5, n(env.ENTRY_LADDER_URGENCY_RANGE_MULT, 0.9));
  return 1;
}

function maxPendingMs(profileKey, env) {
  const globalMs = Math.max(1000, n(env.ENTRY_WATCH_MS, 30000));
  const specific = n(env[`ENTRY_PENDING_MAX_MS_${profileKey}`], NaN);
  return Number.isFinite(specific) && specific > 0 ? specific : globalMs;
}

function buildEntryUrgencyProfile({ trade, env }) {
  const profileKey = enabled(env.ENTRY_LADDER_STYLE_ENABLED, true)
    ? strategyProfileKey(trade)
    : "DEFAULT";
  const mult = urgencyMultiplier(profileKey, env);
  const baseSteps = Math.max(0, n(env.ENTRY_LADDER_TICKS, 2));
  const baseDelayMs = Math.max(100, n(env.ENTRY_LADDER_STEP_DELAY_MS, 350));
  const baseChaseBps = Math.max(0, n(env.ENTRY_LADDER_MAX_CHASE_BPS, 35));

  return {
    profileKey,
    urgencyMult: mult,
    ladderSteps: Math.max(1, Math.ceil(baseSteps * mult)),
    stepDelayMs: Math.max(100, Math.round(baseDelayMs / Math.max(1, mult))),
    maxChaseBps: Math.max(baseChaseBps, baseChaseBps * mult),
    maxPendingMs: maxPendingMs(profileKey, env),
  };
}

function spreadBps(quote) {
  const bid = n(quote?.bid, NaN);
  const ask = n(quote?.ask, NaN);
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid)) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 10000;
}

function adverseDriftBps({ side, expectedEntryPrice, topOfBookPrice }) {
  const ref = n(expectedEntryPrice, NaN);
  const px = n(topOfBookPrice, NaN);
  if (!(Number.isFinite(ref) && ref > 0 && Number.isFinite(px) && px > 0)) {
    return null;
  }
  if (String(side || "BUY").toUpperCase() === "SELL") {
    return px < ref ? ((ref - px) / ref) * 10000 : 0;
  }
  return px > ref ? ((px - ref) / ref) * 10000 : 0;
}

function optionType(trade) {
  const metaType =
    trade?.option_meta?.optType ||
    trade?.optionMeta?.optType ||
    trade?.option?.optType ||
    "";
  const raw = String(metaType || trade?.instrument?.tradingsymbol || "").toUpperCase();
  if (raw.includes("CE")) return "CE";
  if (raw.includes("PE")) return "PE";
  return null;
}

function adverseUnderlyingBps({ trade, underlyingLtp }) {
  const entryUl = n(
    trade?.underlying_ltp ??
      trade?.planMeta?.underlying?.entry ??
      trade?.option_meta?.underlyingLtp ??
      trade?.optionMeta?.underlyingLtp,
    NaN,
  );
  const nowUl = n(underlyingLtp, NaN);
  if (!(Number.isFinite(entryUl) && entryUl > 0 && Number.isFinite(nowUl) && nowUl > 0)) {
    return null;
  }

  const opt = optionType(trade);
  if (opt === "CE") {
    return nowUl < entryUl ? ((entryUl - nowUl) / entryUl) * 10000 : 0;
  }
  if (opt === "PE") {
    return nowUl > entryUl ? ((nowUl - entryUl) / entryUl) * 10000 : 0;
  }

  const side = String(trade?.side || "BUY").toUpperCase();
  if (side === "SELL") {
    return nowUl > entryUl ? ((nowUl - entryUl) / entryUl) * 10000 : 0;
  }
  return nowUl < entryUl ? ((entryUl - nowUl) / entryUl) * 10000 : 0;
}

function pendingAgeMs(trade, nowTs = Date.now()) {
  const ref =
    Date.parse(trade?.entryPlacedAt || "") ||
    Date.parse(trade?.createdAt || "") ||
    Date.parse(trade?.decisionAt || "");
  return Number.isFinite(ref) ? Math.max(0, nowTs - ref) : 0;
}

function topOfBookPrice(side, quote) {
  return String(side || "BUY").toUpperCase() === "SELL"
    ? n(quote?.bid, NaN)
    : n(quote?.ask, NaN);
}

function computeRR(entry, stop, target) {
  const risk = Math.abs(n(entry, NaN) - n(stop, NaN));
  if (!(risk > 0)) return null;
  const reward = Math.abs(n(target, NaN) - n(entry, NaN));
  return reward > 0 ? reward / risk : null;
}

function resolveMaxExecutionAgeMs(env) {
  return Math.max(
    0,
    n(env?.MAX_EXECUTION_AGE_MS, n(env?.EXEC_SIGNAL_MAX_AGE_MS, 5000)),
  );
}

function resolveSignalFreshnessContext(signalTs, trade, env, nowTs = Date.now()) {
  const createdAtMs =
    Date.parse(trade?.signalCreatedAt || "") ||
    Date.parse(trade?.entryPipeline?.signalCreatedAt || "");
  const decisionTsMs =
    Date.parse(trade?.signalDecisionTs || "") ||
    Date.parse(trade?.entryPipeline?.signalDecisionTs || "");
  const eventTsMs =
    Date.parse(trade?.signalEventTs || "") ||
    Date.parse(trade?.entryPipeline?.signalEventTs || "") ||
    Date.parse(signalTs || "") ||
    Date.parse(trade?.signalTs || "") ||
    Date.parse(trade?.decisionAt || "") ||
    Date.parse(trade?.createdAt || "");
  const referenceTs = Number.isFinite(createdAtMs)
    ? createdAtMs
    : Number.isFinite(decisionTsMs)
      ? decisionTsMs
    : Number.isFinite(eventTsMs)
      ? eventTsMs
      : nowTs;
  const freshnessSource = Number.isFinite(createdAtMs)
    ? "CREATED_AT"
    : Number.isFinite(decisionTsMs)
      ? "DECISION_TS"
      : "EVENT_TS";
  const correctedSignalAgeMs = Math.max(0, nowTs - referenceTs);
  const pipelineAdmissionTs = Date.parse(
    trade?.entryPipeline?.admissionCheckAt ||
      trade?.entryPipeline?.orderIntentCreatedAt ||
      "",
  );
  const pipelineReferenceTs = Number.isFinite(createdAtMs)
    ? createdAtMs
    : Number.isFinite(decisionTsMs)
      ? decisionTsMs
      : referenceTs;
  const pipelineLatencyMs =
    n(trade?.entryPipelineLatency?.totalAgeMs, null) ??
    (Number.isFinite(pipelineReferenceTs) && Number.isFinite(pipelineAdmissionTs)
      ? Math.max(0, pipelineAdmissionTs - pipelineReferenceTs)
      : null) ??
    correctedSignalAgeMs;
  const maxExecutionAgeMs = resolveMaxExecutionAgeMs(env);
  const latencyGraceBudgetMs = Math.max(
    0,
    n(env?.MAX_LATENCY_GRACE_MS, n(env?.MAX_SIGNAL_LATENCY_GRACE_MS, 5000)),
  );
  const latencyGraceApplied =
    Number.isFinite(pipelineLatencyMs) &&
    pipelineLatencyMs <= latencyGraceBudgetMs &&
    correctedSignalAgeMs > maxExecutionAgeMs &&
    correctedSignalAgeMs <= maxExecutionAgeMs + latencyGraceBudgetMs;

  return {
    signalMs: referenceTs,
    freshnessSource,
    correctedSignalAgeMs,
    pipelineLatencyMs,
    maxExecutionAgeMs,
    latencyGraceBudgetMs,
    latencyGraceApplied,
  };
}

function absoluteDeviationPct(plannedEntry, candidateEntry) {
  const planned = n(plannedEntry, NaN);
  const candidate = n(candidateEntry, NaN);
  if (!(Number.isFinite(planned) && planned > 0 && Number.isFinite(candidate) && candidate > 0)) {
    return null;
  }
  return (Math.abs(candidate - planned) / planned) * 100;
}

function adverseDriftPct({ side, plannedEntry, candidateEntry }) {
  const bps = adverseDriftBps({
    side,
    expectedEntryPrice: plannedEntry,
    topOfBookPrice: candidateEntry,
  });
  return Number.isFinite(bps) ? bps / 100 : null;
}

function buildRepriceTarget({
  side,
  quote,
  expectedEntryPrice,
  currentOrderPrice,
  maxChaseBps,
  tick,
}) {
  const top = topOfBookPrice(side, quote);
  const ref = n(expectedEntryPrice, NaN);
  if (!(Number.isFinite(top) && top > 0 && Number.isFinite(tick) && tick > 0)) {
    return null;
  }

  let target = top;
  if (Number.isFinite(ref) && ref > 0 && Number.isFinite(maxChaseBps) && maxChaseBps > 0) {
    const ceiling =
      String(side || "BUY").toUpperCase() === "SELL"
        ? ref * (1 - maxChaseBps / 10000)
        : ref * (1 + maxChaseBps / 10000);
    target =
      String(side || "BUY").toUpperCase() === "SELL"
        ? Math.max(top, ceiling)
        : Math.min(top, ceiling);
  }

  const rounded = roundToTick(
    target,
    tick,
    String(side || "BUY").toUpperCase() === "SELL" ? "down" : "up",
  );
  const cur = n(currentOrderPrice, NaN);
  if (Number.isFinite(cur)) {
    if (String(side || "BUY").toUpperCase() === "SELL" && rounded >= cur) return null;
    if (String(side || "BUY").toUpperCase() !== "SELL" && rounded <= cur) return null;
  }
  return rounded;
}

function evaluateExecutionGate({
  signalTs,
  trade,
  quote,
  underlyingLtp,
  optionLiquidity = null,
  nowTs = Date.now(),
  env,
  chaseStep = 0,
  candidateEntryPrice = undefined,
}) {
  const side = String(trade?.side || "BUY").toUpperCase();
  const freshness = resolveSignalFreshnessContext(signalTs, trade, env, nowTs);
  const signalMs = freshness.signalMs;
  const signalAgeMs = freshness.correctedSignalAgeMs;
  const maxSignalAgeMs = freshness.maxExecutionAgeMs;
  const plannedEntry = n(
    trade?.plannedEntry ?? trade?.expectedEntryPrice ?? trade?.entryPrice,
    NaN,
  );
  const top = n(candidateEntryPrice, n(topOfBookPrice(side, quote), NaN));
  const spread = spreadBps(quote);
  const maxSpreadBps = Math.max(
    0,
    n(env.EXEC_MAX_SPREAD_BPS, n(env.OPT_MAX_SPREAD_BPS, 45)),
  );
  const premiumDriftPct = adverseDriftPct({
    side,
    plannedEntry,
    candidateEntry: top,
  });
  const maxPremiumDriftPct = Math.max(
    0,
    n(env.EXEC_MAX_PREMIUM_DRIFT_PCT, 1.0),
  );
  const entryDeviationPct = absoluteDeviationPct(plannedEntry, top);
  const maxEntryDeviationPct = Math.max(
    0,
    n(env.EXEC_MAX_ENTRY_DEVIATION_PCT, 1.2),
  );
  const maxChaseSteps = Math.max(0, Math.round(n(env.EXEC_MAX_CHASE_STEPS, 3)));
  const underlyingThesisDriftBps = adverseUnderlyingBps({
    trade,
    underlyingLtp,
  });
  const maxThesisDriftBps = Math.max(
    0,
    n(env.ENTRY_PENDING_MAX_ADVERSE_UL_BPS, 12),
  );

  let reasonCode = "EXECUTION_ACCEPTED";

  if (!(Number.isFinite(top) && top > 0)) {
    reasonCode = "EXEC_QUOTE_UNAVAILABLE";
  } else if (signalAgeMs > maxSignalAgeMs && !freshness.latencyGraceApplied) {
    reasonCode = "EXEC_SIGNAL_STALE";
  } else if (chaseStep > maxChaseSteps) {
    reasonCode = "EXEC_CHASE_LIMIT_EXCEEDED";
  } else if (
    Number.isFinite(entryDeviationPct) &&
    entryDeviationPct > maxEntryDeviationPct
  ) {
    reasonCode = "EXEC_ENTRY_DEVIATION_EXCEEDED";
  } else if (
    Number.isFinite(premiumDriftPct) &&
    premiumDriftPct > maxPremiumDriftPct
  ) {
    reasonCode = "EXEC_PREMIUM_DRIFT_EXCEEDED";
  } else if (Number.isFinite(spread) && spread > maxSpreadBps) {
    reasonCode = "EXEC_SPREAD_EXCEEDED";
  } else if (
    optionLiquidity &&
    optionLiquidity.ok === false
  ) {
    reasonCode = "EXEC_CONTRACT_UNHEALTHY";
  } else if (
    Number.isFinite(underlyingThesisDriftBps) &&
    underlyingThesisDriftBps > maxThesisDriftBps
  ) {
    reasonCode = "EXEC_THESIS_INVALID";
  }

  return {
    ok: reasonCode === "EXECUTION_ACCEPTED",
    reasonCode,
    freshnessAccepted: reasonCode !== "EXEC_SIGNAL_STALE",
    signalAgeMs,
    signalTs: new Date(signalMs),
    freshnessSource: freshness.freshnessSource,
    correctedSignalAgeMs: freshness.correctedSignalAgeMs,
    pipelineLatencyMs: freshness.pipelineLatencyMs,
    latencyGraceApplied: freshness.latencyGraceApplied,
    executionPrice: Number.isFinite(top) ? top : null,
    spreadBps: Number.isFinite(spread) ? spread : null,
    premiumDriftPct: Number.isFinite(premiumDriftPct) ? premiumDriftPct : null,
    entryDeviationPct: Number.isFinite(entryDeviationPct) ? entryDeviationPct : null,
    adverseUnderlyingBps:
      Number.isFinite(underlyingThesisDriftBps) ? underlyingThesisDriftBps : null,
    chaseStep,
    maxChaseSteps,
    plannedEntry: Number.isFinite(plannedEntry) ? plannedEntry : null,
    optionLiquidityReason:
      optionLiquidity && optionLiquidity.ok === false ? optionLiquidity.reason || null : null,
  };
}

function evaluatePendingEntryState({
  trade,
  quote,
  underlyingLtp,
  nowTs = Date.now(),
  env,
  profile,
  currentOrderPrice,
}) {
  const side = String(trade?.side || "BUY").toUpperCase();
  const tick = Math.max(0.01, n(trade?.instrument?.tick_size, 0.05));
  const ageMs = pendingAgeMs(trade, nowTs);
  const revalidateAfterMs = Math.max(0, n(env.ENTRY_PENDING_REVALIDATE_AFTER_MS, 1500));
  const maxSpreadBps = Math.max(
    0,
    n(env.ENTRY_PENDING_MAX_SPREAD_BPS, n(env.OPT_MAX_SPREAD_BPS, 35)),
  );
  const maxUlAdverseBps = Math.max(0, n(env.ENTRY_PENDING_MAX_ADVERSE_UL_BPS, 12));
  const maxPending = Math.max(1000, n(profile?.maxPendingMs, n(env.ENTRY_WATCH_MS, 30000)));
  const expected = n(
    trade?.expectedEntryPrice ?? trade?.entryPrice ?? trade?.quoteAtEntry?.ltp,
    NaN,
  );
  const top = topOfBookPrice(side, quote);
  const bookSpreadBps = spreadBps(quote);
  const driftBps = adverseDriftBps({
    side,
    expectedEntryPrice: expected,
    topOfBookPrice: top,
  });
  const ulAdverseBps = adverseUnderlyingBps({ trade, underlyingLtp });
  const chaseBudgetBps = Math.max(
    0,
    n(profile?.maxChaseBps, n(env.ENTRY_LADDER_MAX_CHASE_BPS, 35)),
  );

  let cancelReason = null;
  if (ageMs >= maxPending) {
    cancelReason = "ENTRY_PENDING_STALE";
  } else if (ageMs >= revalidateAfterMs) {
    if (Number.isFinite(bookSpreadBps) && bookSpreadBps > maxSpreadBps) {
      cancelReason = "ENTRY_SPREAD_WIDENED";
    } else if (Number.isFinite(driftBps) && driftBps > chaseBudgetBps) {
      cancelReason = "ENTRY_PRICE_DRIFT";
    } else if (Number.isFinite(ulAdverseBps) && ulAdverseBps > maxUlAdverseBps) {
      cancelReason = "ENTRY_EDGE_DECAY";
    }
  }

  return {
    ok: !cancelReason,
    cancelReason,
    ageMs,
    spreadBps: bookSpreadBps,
    adverseDriftBps: driftBps,
    adverseUnderlyingBps: ulAdverseBps,
    targetPrice: buildRepriceTarget({
      side,
      quote,
      expectedEntryPrice: expected,
      currentOrderPrice,
      maxChaseBps: chaseBudgetBps,
      tick,
    }),
  };
}

function evaluateStopFitCompression({
  entryPrice,
  originalStopLoss,
  fittedStopLoss,
  env,
  tickSize,
  plannedTargetPrice,
  rrTarget,
  strategyStyle,
}) {
  const entry = n(entryPrice, NaN);
  const original = n(originalStopLoss, NaN);
  const fitted = n(fittedStopLoss, NaN);
  if (!(Number.isFinite(entry) && Number.isFinite(original) && Number.isFinite(fitted))) {
    return { ok: false, reason: "BAD_INPUT" };
  }

  const originalDistance = Math.abs(entry - original);
  const fittedDistance = Math.abs(entry - fitted);
  if (!(originalDistance > 0) || !(fittedDistance > 0)) {
    return { ok: false, reason: "BAD_DISTANCE" };
  }

  const compressionPts = Math.max(0, originalDistance - fittedDistance);
  const keepPct = (fittedDistance / originalDistance) * 100;
  const minKeepPct = clamp(
    n(
      env.PRE_ENTRY_SL_COMPRESSION_MIN_KEEP_PCT,
      env.OPT_SL_FIT_MIN_DISTANCE_KEEP_PCT,
    ),
    1,
    100,
  );
  const maxCompressionPct = clamp(
    Number.isFinite(Number(env.MAX_SL_COMPRESSION_PCT))
      ? Number(env.MAX_SL_COMPRESSION_PCT)
      : n(env.PRE_ENTRY_SL_COMPRESSION_MAX_PCT, 0.1) * 100,
    0,
    100,
  );
  const safeTick = Math.max(0.01, n(tickSize, 0.05));
  const maxCompressionTicks = Math.max(
    0,
    n(env.PRE_ENTRY_SL_COMPRESSION_MAX_TICKS, 6),
  );
  const maxCompressionPointsRaw = n(
    env.PRE_ENTRY_SL_COMPRESSION_MAX_POINTS,
    null,
  );
  const maxCompressionPoints = Number.isFinite(maxCompressionPointsRaw)
    ? Math.max(0, maxCompressionPointsRaw)
    : null;
  const maxCompressionPtsByPct = originalDistance * (maxCompressionPct / 100);
  const maxCompressionPtsByTick = safeTick * maxCompressionTicks;
  const compressionLimits = [
    {
      source: "PCT",
      maxPts: maxCompressionPtsByPct,
      reason: "SL_FIT_PCT_LIMIT",
    },
    {
      source: "TICKS",
      maxPts: maxCompressionPtsByTick,
      reason: "SL_FIT_TICK_LIMIT",
    },
  ];
  if (Number.isFinite(maxCompressionPoints)) {
    compressionLimits.push({
      source: "POINTS",
      maxPts: maxCompressionPoints,
      reason: "SL_FIT_POINTS_LIMIT",
    });
  }
  const activeCompressionLimits = compressionLimits.filter(
    (limit) => Number.isFinite(limit.maxPts) && limit.maxPts >= 0,
  );
  const maxCompressionPtsEffective = activeCompressionLimits.length
    ? Math.min(...activeCompressionLimits.map((limit) => limit.maxPts))
    : null;
  const activeLimitEntries = activeCompressionLimits.filter(
    (limit) =>
      Number.isFinite(maxCompressionPtsEffective) &&
      Math.abs(limit.maxPts - maxCompressionPtsEffective) <= 1e-9,
  );
  const limitSourceUsed = activeLimitEntries.length
    ? activeLimitEntries.map((limit) => limit.source).join("+")
    : null;
  const limitReason =
    activeLimitEntries.find((limit) => limit.source === "POINTS")?.reason ||
    activeLimitEntries.find((limit) => limit.source === "TICKS")?.reason ||
    activeLimitEntries[0]?.reason ||
    null;
  const style = String(strategyStyle || "").toUpperCase();
  const compressionEnabled = enabled(
    env.ENABLE_SL_COMPRESSION_WHEN_BLOCKED,
    enabled(env.PRE_ENTRY_SL_COMPRESSION_ENABLED, false),
  );
  const openAllowed = enabled(env.PRE_ENTRY_SL_COMPRESSION_ALLOW_OPEN, false);
  const requireRrFloor = enabled(env.PRE_ENTRY_SL_COMPRESSION_REQUIRE_RR_FLOOR, true);
  const minRr = Math.max(0, n(env.PRE_ENTRY_SL_COMPRESSION_MIN_RR, 1.8));
  const target = n(plannedTargetPrice, NaN);
  const rrBefore = Number.isFinite(target) ? computeRR(entry, original, target) : n(rrTarget, null);
  const rrAfter = Number.isFinite(target) ? computeRR(entry, fitted, target) : n(rrTarget, null);
  const baseMeta = {
    originalDistance,
    fittedDistance,
    keepPct,
    compressionPts,
    tightenPct: 100 - keepPct,
    minKeepPct,
    maxCompressionPct,
    maxCompressionTicks,
    maxCompressionPoints,
    maxCompressionPtsByPct,
    maxCompressionPtsByTick,
    maxCompressionPtsEffective,
    limitSourceUsed,
    rrBefore,
    rrAfter,
    minRr,
  };

  if (!compressionEnabled) {
    return {
      ok: false,
      reason: "PRE_ENTRY_COMPRESSION_DISABLED",
      ...baseMeta,
    };
  }

  if (style.includes("OPEN") && !openAllowed) {
    return {
      ok: false,
      reason: "PRE_ENTRY_COMPRESSION_OPEN_BLOCKED",
      ...baseMeta,
    };
  }

  if (
    Number.isFinite(maxCompressionPtsEffective) &&
    compressionPts - 1e-9 > maxCompressionPtsEffective
  ) {
    return {
      ok: false,
      reason: limitReason || "SL_FIT_LIMIT",
      ...baseMeta,
    };
  }

  if (
    requireRrFloor &&
    Number.isFinite(rrAfter) &&
    rrAfter + 1e-9 < minRr
  ) {
    return {
      ok: false,
      reason: "SL_FIT_RR_FLOOR",
      ...baseMeta,
    };
  }

  return {
    ok: keepPct + 1e-9 >= minKeepPct,
    reason: keepPct + 1e-9 >= minKeepPct ? null : "SL_FIT_TOO_AGGRESSIVE",
    ...baseMeta,
  };
}

module.exports = {
  buildEntryUrgencyProfile,
  evaluateExecutionGate,
  evaluatePendingEntryState,
  evaluateStopFitCompression,
};
