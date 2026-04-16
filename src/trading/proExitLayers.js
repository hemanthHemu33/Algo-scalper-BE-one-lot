const { roundToTick } = require("./priceUtils");
const {
  evaluateAdaptiveLoserCompression,
} = require("./adaptiveLoserCompression");
const {
  estimateCostGreenFloor,
  estimateTrueBreakEven,
  pnlInrToR,
  retainedRToPrice,
} = require("./costModel");
const { resolveExitLifecycle } = require("./tradeLifecycleState");

function n(v, fb = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function clamp(v, lo, hi) {
  let out = v;
  if (Number.isFinite(lo)) out = Math.max(lo, out);
  if (Number.isFinite(hi)) out = Math.min(hi, out);
  return out;
}

function enabled(v, fb = false) {
  if (v === null || v === undefined || v === "") return fb;
  return String(v) === "true";
}

function tsFrom(v) {
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function isOptionTrade(trade) {
  const seg = String(trade?.instrument?.segment || "").toUpperCase();
  const sym = String(trade?.instrument?.tradingsymbol || "").toUpperCase();
  return Boolean(
    trade?.option_meta ||
      trade?.optionMeta ||
      trade?.option ||
      seg.includes("OPT") ||
      /\d(?:CE|PE)$/.test(sym),
  );
}

function optionType(trade) {
  const t =
    trade?.option_meta?.optType ||
    trade?.optionMeta?.optType ||
    trade?.option?.optType ||
    "";
  const s = String(t || trade?.instrument?.tradingsymbol || "").toUpperCase();
  if (s.includes("CE")) return "CE";
  if (s.includes("PE")) return "PE";
  return null;
}

function unrealizedPnlInr({ side, entry, ltp, qty }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !Number.isFinite(qty)) return 0;
  return side === "SELL" ? (entry - ltp) * qty : (ltp - entry) * qty;
}

function profitR({ side, entry, ltp, risk }) {
  if (!Number.isFinite(entry) || !Number.isFinite(ltp) || !(risk > 0)) return 0;
  return side === "SELL" ? (entry - ltp) / risk : (ltp - entry) / risk;
}

function bestPeakLtp({ trade, ltp, side }) {
  const prev = n(trade?.peakLtp, NaN);
  if (Number.isFinite(prev)) {
    if (side === "SELL") return Number.isFinite(ltp) ? Math.min(prev, ltp) : prev;
    return Number.isFinite(ltp) ? Math.max(prev, ltp) : prev;
  }
  return Number.isFinite(ltp) ? ltp : null;
}

function underlyingMoveBps({ trade, underlyingLtp }) {
  const entry = n(trade?.underlying_ltp ?? trade?.option_meta?.underlyingLtp, NaN);
  const now = n(underlyingLtp, NaN);
  if (!(entry > 0) || !(now > 0)) return null;
  return ((now - entry) / entry) * 10000;
}

function isBetterStop(side, next, prev) {
  if (!Number.isFinite(next)) return false;
  if (!Number.isFinite(prev)) return true;
  return side === "SELL" ? next < prev : next > prev;
}

function bestStop(side, ...levels) {
  let best = null;
  for (const level of levels) {
    if (!Number.isFinite(level)) continue;
    if (best == null || isBetterStop(side, level, best)) best = level;
  }
  return best;
}

function stopMove(side, next, cur) {
  if (!Number.isFinite(next) || !Number.isFinite(cur)) return Infinity;
  return side === "SELL" ? cur - next : next - cur;
}

function roundStopForSide(side, stop, tick) {
  if (!Number.isFinite(stop)) return null;
  return roundToTick(stop, tick, side === "SELL" ? "up" : "down");
}

function clampStopToMarket({ side, stop, ltp, tick }) {
  if (!Number.isFinite(stop)) return null;
  if (!(Number.isFinite(ltp) && Number.isFinite(tick) && tick > 0)) return stop;
  return side === "SELL"
    ? clamp(stop, ltp + tick, undefined)
    : clamp(stop, undefined, ltp - tick);
}

function roundTriggerForSide(side, stop, tick, triggerBufferTicks) {
  if (!Number.isFinite(stop)) return null;
  const raw =
    side === "SELL"
      ? stop - triggerBufferTicks * tick
      : stop + triggerBufferTicks * tick;
  return roundToTick(raw, tick, side === "SELL" ? "down" : "up");
}

function joinReasons(tags = []) {
  const out = [];
  for (const tag of tags) {
    const v = String(tag || "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.join("|") || null;
}

function isProtectionSafetySource(source) {
  return [
    "TRUE_BE",
    "MIN_GREEN",
    "BE_PROFIT_LOCK",
    "PROFIT_LOCK",
    "GREEN_LOCK",
  ].includes(String(source || "").toUpperCase());
}

const STOP_IMPROVE_BLOCKED_REASON_TAGS = Object.freeze(
  new Set([
    "STRUCTURE_TRAIL_GATED",
    "MIN_HOLD_BLOCK",
    "EXEC_SPREAD_BLOCK",
    "EXEC_DISTANCE_BLOCK",
  ]),
);

const PROTECTION_STATE_VERSION = 3;

const FLOOR_SOURCE_PRIORITY = Object.freeze({
  TRUE_BE: 10,
  MIN_GREEN: 20,
  BE_PROFIT_LOCK: 25,
  GREEN_LOCK: 30,
  EARLY_WINNER_RETENTION: 40,
  EARLY_WINNER_STRUCTURE: 45,
  MFE_LOCK_TIER_1: 50,
  MFE_LOCK_TIER_2: 51,
  MFE_LOCK_TIER_3: 52,
  PROFIT_LOCK: 60,
  MFE_LOCK: 65,
  POST_1R_TIGHTEN: 70,
  TRAIL: 80,
  STRUCTURE_TRAIL: 90,
});

function hasOnlyBlockedReasonTags(tags = []) {
  return (
    Array.isArray(tags) &&
    tags.length > 0 &&
    tags.every((tag) => STOP_IMPROVE_BLOCKED_REASON_TAGS.has(String(tag || "")))
  );
}

function blendStop(side, floor, candidate, weight) {
  if (!Number.isFinite(candidate)) return null;
  if (!Number.isFinite(floor)) return candidate;
  const w = clamp(Number(weight), 0, 1);
  const blended = floor + (candidate - floor) * w;
  return side === "SELL" ? Math.min(floor, blended) : Math.max(floor, blended);
}

function patchIfChanged(patch, trade, key, value, epsilon = 0) {
  if (value === undefined) return;
  const cur = trade?.[key];
  if (value instanceof Date) {
    if (String(cur || "") !== value.toISOString()) patch[key] = value;
    return;
  }
  if (typeof value === "boolean") {
    if (Boolean(cur) !== value) patch[key] = value;
    return;
  }
  if (typeof value === "string") {
    if (String(cur || "") !== value) patch[key] = value;
    return;
  }
  if (Number.isFinite(value)) {
    const curNum = Number(cur);
    if (!Number.isFinite(curNum) || Math.abs(curNum - value) > Math.max(0, epsilon)) {
      patch[key] = value;
    }
  }
}

function patchField(patch, trade, key, value, epsilon = 0) {
  if (value === undefined) return;
  if (value === null) {
    if (trade?.[key] !== null && trade?.[key] !== undefined) {
      patch[key] = null;
    }
    return;
  }
  patchIfChanged(patch, trade, key, value, epsilon);
}

function retainedFloorPrice({ entry, qty, side, retainedR, riskInr, tick }) {
  if (!(Number.isFinite(retainedR) && Number.isFinite(riskInr) && riskInr > 0)) {
    return null;
  }
  return retainedRToPrice({
    entryPrice: entry,
    qty,
    side,
    retainedR,
    riskInr,
    tick,
    roundMode: side === "SELL" ? "down" : "up",
  });
}

function retainedRAtPrice({ entry, qty, side, price, riskInr }) {
  if (
    !(
      Number.isFinite(entry) &&
      Number.isFinite(qty) &&
      qty > 0 &&
      Number.isFinite(price) &&
      Number.isFinite(riskInr) &&
      riskInr > 0
    )
  ) {
    return null;
  }
  const pnlInr = unrealizedPnlInr({ side, entry, ltp: price, qty });
  return pnlInrToR(pnlInr, riskInr);
}

function resolveExecutionRiskState({ trade, entry, sl0, qty }) {
  const liveQty = n(qty ?? trade?.qty ?? trade?.initialQty, 0);
  const strategyStop = n(
    trade?.strategyStopLoss ?? trade?.initialStopLoss ?? sl0,
    NaN,
  );
  const explicitRiskPts = n(trade?.executionRiskPts, NaN);
  const actualRiskPts = n(
    trade?.actualRiskPts ?? trade?.riskStopPts ?? trade?.initialStrategyRiskPts,
    NaN,
  );
  const priceRisk = Math.abs(entry - sl0);
  const riskPts = Number.isFinite(explicitRiskPts)
    ? explicitRiskPts
    : Number.isFinite(actualRiskPts)
      ? actualRiskPts
      : Number.isFinite(strategyStop)
        ? Math.abs(entry - strategyStop)
        : priceRisk;
  const storedRiskQty = Math.max(0, n(trade?.executionRiskQty ?? trade?.riskQty, liveQty));
  const storedRiskInr = n(trade?.executionRiskInr, NaN);
  const riskInr =
    Number.isFinite(storedRiskInr) &&
    storedRiskInr > 0 &&
    storedRiskQty > 0 &&
    Math.abs(storedRiskQty - liveQty) < 0.5
      ? storedRiskInr
      : Number.isFinite(riskPts) && riskPts > 0 && liveQty > 0
        ? riskPts * liveQty
        : n(trade?.riskInr, priceRisk * liveQty);

  return {
    riskPts: Number.isFinite(riskPts) ? riskPts : null,
    riskInr: Number.isFinite(riskInr) ? riskInr : null,
    riskQty: liveQty,
    riskSource: Number.isFinite(explicitRiskPts)
      ? "EXECUTION_RISK_FIELDS"
      : Number.isFinite(actualRiskPts)
        ? "ACTUAL_RISK_FIELDS"
        : Number.isFinite(strategyStop)
          ? "STRATEGY_STOP_DISTANCE"
          : "PRICE_RISK_FALLBACK",
    budgetRiskInr: n(trade?.riskInr, null),
  };
}

function quoteTimestampMs(marketQuote) {
  const raw =
    marketQuote?.timestamp ??
    marketQuote?.timestampMs ??
    marketQuote?.exchangeTimestamp ??
    marketQuote?.exchange_timestamp ??
    marketQuote?.last_trade_time ??
    marketQuote?.fetchedAtMs ??
    null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function classifyExecutableQuote({ trade, ltp, marketQuote, env, now, tick }) {
  const priceLtp = n(ltp, n(marketQuote?.ltp, null));
  if (!isOptionTrade(trade)) {
    return {
      price: priceLtp,
      quality: Number.isFinite(priceLtp) ? "LTP_ONLY" : "UNUSABLE",
      freshnessMs: null,
      source: Number.isFinite(priceLtp) ? "LTP" : "UNUSABLE",
      confidence: Number.isFinite(priceLtp) ? "MEDIUM" : "NONE",
    };
  }

  const side = String(trade?.side || "").toUpperCase();
  const mode = String(env.OPTION_EXECUTABLE_PRICE_MODE || "BID_SIDE").toUpperCase();
  const bid = n(marketQuote?.bid, NaN);
  const ask = n(marketQuote?.ask, NaN);
  const bookUsable =
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
  const topOfBook =
    mode === "BID_SIDE"
      ? side === "BUY"
        ? bid
        : ask
      : side === "BUY"
        ? ask
        : bid;
  const ts = quoteTimestampMs(marketQuote);
  const freshnessMs =
    Number.isFinite(ts) && Number.isFinite(now) ? Math.max(0, now - ts) : null;
  const freshnessLimitMs = Math.max(
    0,
    n(
      env.EXECUTABLE_QUOTE_FRESHNESS_MS,
      n(env.OPTION_EXECUTABLE_QUOTE_FRESHNESS_MS, 2000),
    ),
  );

  if (bookUsable && Number.isFinite(topOfBook) && topOfBook > 0) {
    if (!Number.isFinite(freshnessMs) || freshnessMs <= freshnessLimitMs) {
      return {
        price: topOfBook,
        quality: "FRESH_EXECUTABLE",
        freshnessMs,
        source: side === "BUY" ? "BID" : "ASK",
        confidence: "HIGH",
      };
    }

    const staleConservativePrice = Number.isFinite(priceLtp)
      ? side === "BUY"
        ? Math.min(topOfBook, priceLtp)
        : Math.max(topOfBook, priceLtp)
      : topOfBook;
    return {
      price: staleConservativePrice,
      quality: "STALE_EXECUTABLE",
      freshnessMs,
      source: side === "BUY" ? "STALE_BID" : "STALE_ASK",
      confidence: "MEDIUM",
    };
  }

  if (Number.isFinite(priceLtp) && priceLtp > 0) {
    const padTicks = Math.max(
      1,
      Math.round(n(env.OPTION_EXECUTABLE_LTP_FALLBACK_TICKS, 2)),
    );
    const fallbackRaw =
      side === "BUY"
        ? priceLtp - padTicks * tick
        : priceLtp + padTicks * tick;
    const fallbackPrice =
      tick > 0
        ? roundToTick(
            fallbackRaw,
            tick,
            side === "BUY" ? "down" : "up",
          )
        : fallbackRaw;
    return {
      price: fallbackPrice,
      quality: "LTP_ONLY",
      freshnessMs,
      source: "LTP_FALLBACK",
      confidence: "LOW",
    };
  }

  return {
    price: null,
    quality: "UNUSABLE",
    freshnessMs,
    source: "UNUSABLE",
    confidence: "NONE",
  };
}

function buildMetrics({ trade, entry, sl0, side, ltp, marketQuote, env, now, tick }) {
  const qty = n(trade?.qty ?? trade?.initialQty, 0);
  const riskState = resolveExecutionRiskState({ trade, entry, sl0, qty });
  const priceRisk = Math.abs(entry - sl0);
  const riskInr = n(riskState?.riskInr, priceRisk * qty);
  const quoteState = classifyExecutableQuote({
    trade,
    ltp,
    marketQuote,
    env,
    now,
    tick,
  });
  const currentExecutablePrice = n(quoteState?.price, null);
  const currentPnlInr = unrealizedPnlInr({ side, entry, ltp, qty });
  const currentExecutablePnlInr = Number.isFinite(currentExecutablePrice)
    ? unrealizedPnlInr({
        side,
        entry,
        ltp: currentExecutablePrice,
        qty,
      })
    : null;
  const currentR = pnlInrToR(currentPnlInr, riskInr) ?? profitR({ side, entry, ltp, risk: priceRisk });
  const currentExecutableR =
    pnlInrToR(currentExecutablePnlInr, riskInr) ??
    (Number.isFinite(currentExecutablePrice)
      ? profitR({ side, entry, ltp: currentExecutablePrice, risk: priceRisk })
      : null);
  const peakLtp = bestPeakLtp({ trade, ltp, side });
  const peakPnlInr = Math.max(
    n(trade?.peakPnlInr, currentPnlInr),
    currentPnlInr,
    Number.isFinite(peakLtp)
      ? unrealizedPnlInr({ side, entry, ltp: peakLtp, qty })
      : currentPnlInr,
  );
  const peakR =
    pnlInrToR(peakPnlInr, riskInr) ??
    (Number.isFinite(peakLtp) ? profitR({ side, entry, ltp: peakLtp, risk: priceRisk }) : null);
  const peakExecutablePnlInr = Number.isFinite(currentExecutablePnlInr)
    ? Math.max(
        n(trade?.peakExecutablePnlInr, currentExecutablePnlInr),
        currentExecutablePnlInr,
      )
    : n(trade?.peakExecutablePnlInr, null);
  const peakExecutableR = pnlInrToR(peakExecutablePnlInr, riskInr);
  const protectedPeakR = Number.isFinite(peakExecutableR)
    ? peakExecutableR
    : Number.isFinite(currentExecutableR)
      ? currentExecutableR
      : peakR;
  const protectedCurrentR = Number.isFinite(currentExecutableR)
    ? currentExecutableR
    : currentR;
  const givebackR =
    Number.isFinite(protectedPeakR) && Number.isFinite(protectedCurrentR)
      ? Math.max(0, protectedPeakR - protectedCurrentR)
      : 0;
  const givebackPct =
    Number.isFinite(protectedPeakR) && protectedPeakR > 0 ? givebackR / protectedPeakR : 0;

  return {
    qty,
    executionRiskPts: riskState?.riskPts,
    executionRiskQty: riskState?.riskQty,
    executionRiskSource: riskState?.riskSource ?? null,
    budgetRiskInr: riskState?.budgetRiskInr ?? null,
    riskInr,
    currentExecutablePrice,
    currentExecutablePnlInr,
    currentExecutableR,
    peakExecutablePnlInr,
    peakExecutableR,
    peakR,
    protectedPeakR,
    protectedCurrentR,
    givebackR,
    givebackPct,
    quoteQuality: quoteState?.quality ?? "UNUSABLE",
    quoteFreshnessMs: quoteState?.freshnessMs ?? null,
    executablePriceSource: quoteState?.source ?? null,
    executablePriceConfidence: quoteState?.confidence ?? "NONE",
  };
}

function candleTimestampMs(candle = {}) {
  return tsFrom(
    candle?.ts ??
      candle?.time ??
      candle?.date ??
      candle?.timestamp ??
      candle?.exchangeTimestamp,
  );
}

function floorSourcePriority(source) {
  const label = String(source || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(FLOOR_SOURCE_PRIORITY, label)) {
    return FLOOR_SOURCE_PRIORITY[label];
  }
  const tierMatch = /^MFE_LOCK_TIER_(\d+)$/.exec(label);
  if (tierMatch) return 50 + Number(tierMatch[1] || 0);
  return 0;
}

function makeFloorCandidate({
  source,
  price,
  eligible,
  rejectedReason = null,
  phase = null,
  details = null,
}) {
  const numericPrice = Number(price);
  const hasPrice = Number.isFinite(numericPrice);
  const active = Boolean(eligible) && hasPrice;
  return {
    source: String(source || "").toUpperCase() || null,
    price: hasPrice ? numericPrice : null,
    eligible: active,
    rejectedReason: active
      ? null
      : rejectedReason || (!hasPrice ? "NO_PRICE" : "NOT_ELIGIBLE"),
    priority: floorSourcePriority(source),
    phase: phase || null,
    details: details || null,
  };
}

function selectFloorCandidate({ side, candidates = [], tick }) {
  const epsilon = Math.max(Number(tick ?? 0), 0.01) / 2;
  let winner = null;
  let winnerReason = "NO_ELIGIBLE_FLOOR";
  for (const candidate of candidates) {
    if (!candidate?.eligible || !Number.isFinite(candidate?.price)) continue;
    if (!winner) {
      winner = candidate;
      winnerReason = "BEST_PRICE";
      continue;
    }
    if (isBetterStop(side, candidate.price, winner.price)) {
      winner = candidate;
      winnerReason = "BEST_PRICE";
      continue;
    }
    if (
      Math.abs(Number(candidate.price) - Number(winner.price)) <= epsilon &&
      Number(candidate.priority ?? 0) > Number(winner.priority ?? 0)
    ) {
      winner = candidate;
      winnerReason = "TIE_BREAK_PRIORITY";
    }
  }
  return { winner, winnerReason };
}

function rejectedFloorReasons(candidates = []) {
  return candidates.reduce((out, candidate) => {
    if (!candidate?.source || candidate?.eligible) return out;
    out[candidate.source] = candidate.rejectedReason || "REJECTED";
    return out;
  }, {});
}

function buildEarlyWinnerConfig(env = {}) {
  const dynamicHandoffMinR = n(env.EARLY_WINNER_DYNAMIC_HANDOFF_MIN_R, 0.6);
  const dynamicHandoffMaxR = n(env.EARLY_WINNER_DYNAMIC_HANDOFF_MAX_R, 0.85);
  return {
    enabled: enabled(env.EARLY_WINNER_RETENTION_ENABLED, true),
    armR: n(env.EARLY_WINNER_ARM_R, 0.4),
    confirmTicks: Math.max(
      0,
      Math.round(n(env.EARLY_WINNER_CONFIRM_TICKS, 2)),
    ),
    confirmMs: Math.max(0, n(env.EARLY_WINNER_CONFIRM_MS, 3000)),
    requireBarConfirm: enabled(env.EARLY_WINNER_REQUIRE_BAR_CONFIRM, false),
    minKeepR: n(env.EARLY_WINNER_MIN_KEEP_R, 0.08),
    maxKeepR: n(env.EARLY_WINNER_MAX_KEEP_R, 0.22),
    mfeLockMode: String(env.EARLY_WINNER_MFE_LOCK_MODE || "RATIO")
      .trim()
      .toUpperCase(),
    tiers: [
      {
        tier: 1,
        atR: n(env.EARLY_WINNER_TIER_1_R, 0.5),
        keepR: n(env.EARLY_WINNER_TIER_1_KEEP_R, 0.12),
      },
      {
        tier: 2,
        atR: n(env.EARLY_WINNER_TIER_2_R, 0.65),
        keepR: n(env.EARLY_WINNER_TIER_2_KEEP_R, 0.2),
      },
      {
        tier: 3,
        atR: n(env.EARLY_WINNER_TIER_3_R, 0.8),
        keepR: n(env.EARLY_WINNER_TIER_3_KEEP_R, 0.3),
      },
    ]
      .filter(
        (tier) =>
          Number.isFinite(tier.atR) && Number.isFinite(tier.keepR) && tier.keepR > 0,
      )
      .sort((a, b) => a.atR - b.atR),
    toTrailMinR: n(env.EARLY_WINNER_TO_TRAIL_MIN_R, 0.75),
    toTrailRequireHealth: enabled(
      env.EARLY_WINNER_TO_TRAIL_REQUIRE_HEALTH,
      true,
    ),
    maxGivebackAfterArmR: n(env.EARLY_WINNER_MAX_GIVEBACK_AFTER_ARM_R, 0.1),
    reentryHysteresisR: n(env.EARLY_WINNER_REENTRY_HYSTERESIS_R, 0.03),
    minHoldMs: Math.max(0, n(env.EARLY_WINNER_MIN_HOLD_MS, 5000)),
    useStructure: enabled(env.EARLY_WINNER_USE_STRUCTURE, true),
    structureBufferTicks: Math.max(
      0,
      Math.round(n(env.EARLY_WINNER_STRUCTURE_BUFFER_TICKS, 4)),
    ),
    structureMaxDistanceR: Math.max(
      0,
      n(env.EARLY_WINNER_STRUCTURE_MAX_DISTANCE_R, 0.3),
    ),
    structureRequireFresh: enabled(
      env.EARLY_WINNER_STRUCTURE_REQUIRE_FRESH,
      true,
    ),
    dynamicHandoffEnabled: enabled(
      env.EARLY_WINNER_DYNAMIC_HANDOFF_ENABLED,
      true,
    ),
    dynamicHandoffMinR: Math.min(
      dynamicHandoffMinR,
      dynamicHandoffMaxR,
    ),
    dynamicHandoffMaxR: Math.max(
      dynamicHandoffMinR,
      dynamicHandoffMaxR,
    ),
    handoffSpreadBpsMax: Math.max(
      0,
      n(env.EARLY_WINNER_HANDOFF_SPREAD_BPS_MAX, 25),
    ),
    handoffRequireStructureBonus: enabled(
      env.EARLY_WINNER_HANDOFF_REQUIRE_STRUCTURE_BONUS,
      false,
    ),
  };
}

function resolveUnderlyingStructureDirection({ trade, side }) {
  const opt = optionType(trade);
  if (opt === "PE") return "BEARISH";
  if (opt === "CE") return "BULLISH";
  return String(side || "BUY").toUpperCase() === "SELL" ? "BEARISH" : "BULLISH";
}

function resolveOptionGreekState(trade = {}, env = {}) {
  const optionMeta = trade?.planMeta?.option || {};
  const tradeOptionMeta = trade?.option_meta || trade?.optionMeta || trade?.option || {};
  const absDelta = clamp(
    n(
      optionMeta?.absDelta,
      Math.abs(
        n(
          optionMeta?.delta,
          n(tradeOptionMeta?.delta, n(env.OPT_DELTA_ATM, 0.5)),
        ),
      ),
    ),
    0.2,
    0.95,
  );
  const gammaAbs = Math.max(
    0,
    Math.abs(n(optionMeta?.gamma, n(tradeOptionMeta?.gamma, 0))),
  );
  return { absDelta, gammaAbs };
}

function structureAnchorCandidates(trade = {}) {
  const prevDay = trade?.planMeta?.prevDay || {};
  const pivots = prevDay?.pivots || {};
  const orb = trade?.planMeta?.orb || {};
  const seen = new Set();
  const anchors = [
    ["PLAN_UNDERLYING_STOP", trade?.planMeta?.underlying?.stop, 100],
    ["VWAP", trade?.planMeta?.vwap, 85],
    ["ORB_HIGH", orb?.high, 80],
    ["ORB_LOW", orb?.low, 75],
    ["PDH", prevDay?.PDH, 70],
    ["PDL", prevDay?.PDL, 70],
    ["PIVOT_R1", pivots?.R1, 68],
    ["PIVOT_S1", pivots?.S1, 68],
    ["PIVOT_R2", pivots?.R2, 66],
    ["PIVOT_S2", pivots?.S2, 66],
    ["PIVOT_P", pivots?.P, 64],
  ];
  return anchors
    .map(([type, price, priority]) => ({
      type,
      price: n(price, NaN),
      priority,
    }))
    .filter((anchor) => Number.isFinite(anchor.price))
    .filter((anchor) => {
      const key = `${anchor.type}:${anchor.price.toFixed(4)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function structureDistanceForDirection(direction, currentUnderlying, referencePrice) {
  if (!(Number.isFinite(currentUnderlying) && Number.isFinite(referencePrice))) {
    return null;
  }
  if (direction === "BULLISH") {
    return currentUnderlying > referencePrice
      ? currentUnderlying - referencePrice
      : null;
  }
  return referencePrice > currentUnderlying ? referencePrice - currentUnderlying : null;
}

function mapUnderlyingReferenceToFloor({
  trade,
  env,
  side,
  tick,
  currentUnderlying,
  referencePrice,
  executablePrice,
}) {
  if (
    !(
      Number.isFinite(referencePrice) &&
      Number.isFinite(currentUnderlying) &&
      Number.isFinite(executablePrice)
    )
  ) {
    return null;
  }
  const direction = resolveUnderlyingStructureDirection({ trade, side });
  const underlyingDistance = structureDistanceForDirection(
    direction,
    currentUnderlying,
    referencePrice,
  );
  if (!(Number.isFinite(underlyingDistance) && underlyingDistance > 0)) {
    return null;
  }
  const bufferTicks = Math.max(
    0,
    Math.round(n(env.EARLY_WINNER_STRUCTURE_BUFFER_TICKS, 4)),
  );
  const bufferPrice = bufferTicks * Math.max(0.01, n(tick, 0.05));
  if (!isOptionTrade(trade)) {
    const rawFloor =
      direction === "BEARISH"
        ? referencePrice + bufferPrice
        : referencePrice - bufferPrice;
    return {
      mappedFloor: roundStopForSide(side, rawFloor, tick),
      mappedMove: underlyingDistance,
      underlyingDistance,
      bufferPrice,
      absDelta: 1,
      gammaAbs: 0,
    };
  }
  const greekState = resolveOptionGreekState(trade, env);
  const mappedMove =
    underlyingDistance * greekState.absDelta +
    0.5 * greekState.gammaAbs * underlyingDistance * underlyingDistance;
  if (!(Number.isFinite(mappedMove) && mappedMove >= 0)) {
    return null;
  }
  const rawFloor =
    String(side || "BUY").toUpperCase() === "SELL"
      ? executablePrice + mappedMove + bufferPrice
      : executablePrice - mappedMove - bufferPrice;
  return {
    mappedFloor: roundStopForSide(side, rawFloor, tick),
    mappedMove,
    underlyingDistance,
    bufferPrice,
    absDelta: greekState.absDelta,
    gammaAbs: greekState.gammaAbs,
  };
}

function resolveProtectionPhase({
  beArmed,
  beFloor,
  earlyWinnerActive,
  earlyWinnerTier,
  handoffReady,
  profitLockArmed,
  trailActive,
}) {
  let protectionPhase = "PHASE_0_NO_PROTECTION";
  let protectionPhaseNumber = 0;
  if (beArmed && Number.isFinite(beFloor)) {
    protectionPhase = "PHASE_1_COST_PROTECTION";
    protectionPhaseNumber = 1;
  }
  if (earlyWinnerActive && Number(earlyWinnerTier ?? 0) === 0) {
    protectionPhase = "PHASE_2_EARLY_WINNER_RETENTION";
    protectionPhaseNumber = 2;
  }
  if (earlyWinnerActive && Number(earlyWinnerTier ?? 0) > 0) {
    protectionPhase = "PHASE_3_PRE_TRAIL_MFE_LOCK";
    protectionPhaseNumber = 3;
  }
  if (handoffReady || profitLockArmed || trailActive) {
    protectionPhase = "PHASE_4_MATURE_WINNER";
    protectionPhaseNumber = 4;
  }
  return { protectionPhase, protectionPhaseNumber };
}

function computeDynamicHandoffState({
  trade,
  earlyWinner,
  metrics,
  env,
  structureBonusAvailable = false,
  profitLockArmed = false,
  trailActive = false,
}) {
  const config = buildEarlyWinnerConfig(env);
  const peakR = n(metrics?.protectedPeakR, n(metrics?.peakR, NaN));
  const givebackR = Math.max(0, n(metrics?.givebackR, 0));
  const givebackPct = Math.max(0, n(metrics?.givebackPct, 0));
  const prevHandoffReady = Boolean(trade?.earlyWinnerHandoffReady);
  const prevMaturity = Math.max(0, n(trade?.handoffMaturity, 0));
  const spreadBps = n(earlyWinner?.spreadBps, NaN);
  const quoteQuality = String(earlyWinner?.quoteQuality || "UNUSABLE").toUpperCase();
  const quoteClean = !isOptionTrade(trade)
    ? Boolean(earlyWinner?.protectionDataSafe)
    : ["FRESH_EXECUTABLE", "STALE_EXECUTABLE"].includes(quoteQuality);
  const spreadClean =
    !isOptionTrade(trade) ||
    (Number.isFinite(spreadBps) && spreadBps <= config.handoffSpreadBpsMax);

  let qualityScore = 50;
  if (earlyWinner?.earlyWinnerConfirmed) qualityScore += 8;
  else qualityScore -= 20;
  if (earlyWinner?.holdReady) qualityScore += 10;
  else qualityScore -= 8;
  if (earlyWinner?.protectionDataSafe) qualityScore += 8;
  else qualityScore -= 15;
  if (quoteClean) qualityScore += 8;
  else qualityScore -= 10;
  if (spreadClean) qualityScore += 10;
  else qualityScore -= 15;
  if (givebackR <= 0.05) qualityScore += 8;
  else if (givebackR <= 0.1) qualityScore += 4;
  else qualityScore -= 12;
  if (givebackPct <= 0.2) qualityScore += 6;
  else if (givebackPct > 0.35) qualityScore -= 10;
  if (Number(earlyWinner?.earlyWinnerTier ?? 0) >= 2) qualityScore += 12;
  else if (Number(earlyWinner?.earlyWinnerTier ?? 0) >= 1) qualityScore += 6;
  if (structureBonusAvailable) qualityScore += 10;
  else if (config.handoffRequireStructureBonus) qualityScore -= 12;
  if (Number.isFinite(peakR) && peakR >= n(config.toTrailMinR, 0.75)) {
    qualityScore += 4;
  }
  qualityScore = clamp(qualityScore, 0, 100);

  const dynamicTrailArmR = clamp(
    config.dynamicHandoffEnabled
      ? config.dynamicHandoffMaxR -
          (config.dynamicHandoffMaxR - config.dynamicHandoffMinR) *
            (qualityScore / 100)
      : n(config.toTrailMinR, 0.75),
    config.dynamicHandoffEnabled
      ? config.dynamicHandoffMinR
      : n(config.toTrailMinR, 0.75),
    config.dynamicHandoffEnabled
      ? config.dynamicHandoffMaxR
      : n(config.toTrailMinR, 0.75),
  );
  const handoffThreshold = prevHandoffReady
    ? Math.max(
        0,
        dynamicTrailArmR - Math.max(0, n(config.reentryHysteresisR, 0.03)),
      )
    : dynamicTrailArmR;
  const healthReady = !config.toTrailRequireHealth
    ? true
    : Boolean(
        earlyWinner?.holdReady &&
          earlyWinner?.protectionDataSafe &&
          spreadClean &&
          (!config.handoffRequireStructureBonus || structureBonusAvailable),
      );
  const handoffReadyRaw = Boolean(
    earlyWinner?.earlyWinnerConfirmed &&
      Number.isFinite(peakR) &&
      peakR >= handoffThreshold &&
      healthReady,
  );
  const handoffReady = Boolean(prevHandoffReady || handoffReadyRaw);
  const handoffHysteresisActive = Boolean(
    prevHandoffReady &&
      !handoffReadyRaw &&
      Number.isFinite(peakR) &&
      peakR >= handoffThreshold,
  );

  let deferredReason = null;
  if (!handoffReady) {
    if (!earlyWinner?.earlyWinnerConfirmed) deferredReason = "WAITING_CONFIRMATION";
    else if (config.handoffRequireStructureBonus && !structureBonusAvailable) {
      deferredReason = "STRUCTURE_BONUS_REQUIRED";
    } else if (!(Number.isFinite(peakR) && peakR >= dynamicTrailArmR)) {
      deferredReason = "BELOW_DYNAMIC_HANDOFF_R";
    } else if (config.toTrailRequireHealth && !earlyWinner?.holdReady) {
      deferredReason = "MIN_HOLD_NOT_MET";
    } else if (config.toTrailRequireHealth && !quoteClean) {
      deferredReason = "QUOTE_QUALITY_NOT_CLEAN";
    } else if (config.toTrailRequireHealth && !spreadClean) {
      deferredReason = "SPREAD_NOT_CLEAN";
    } else if (!healthReady) {
      deferredReason = "HANDOFF_HEALTH_NOT_READY";
    }
  }

  let dynamicTrailArmReason = "STATIC_BASELINE";
  if (config.dynamicHandoffEnabled) {
    dynamicTrailArmReason =
      qualityScore >= 78
        ? "STRONG_CLEAN_WINNER"
        : qualityScore <= 45
          ? "NOISY_OR_WEAK_WINNER"
          : structureBonusAvailable
            ? "STRUCTURE_SUPPORTED_WINNER"
            : "BALANCED_WINNER";
  }

  const handoffAdvanceReason = handoffReady
    ? structureBonusAvailable
      ? "QUALITY_AND_STRUCTURE_CONFIRMED"
      : qualityScore >= 70
        ? "QUALITY_CONFIRMED"
        : "THRESHOLD_CONFIRMED"
    : null;
  let maturityCandidate = 0;
  if (earlyWinner?.earlyWinnerConfirmed) maturityCandidate = 1;
  if (
    earlyWinner?.earlyWinnerConfirmed &&
    (qualityScore >= 60 || Number(earlyWinner?.earlyWinnerTier ?? 0) > 0)
  ) {
    maturityCandidate = 2;
  }
  if (handoffReady) maturityCandidate = 3;
  const handoffMaturity = Math.max(prevMaturity, maturityCandidate);
  const handoffStateStable = Boolean(
    prevHandoffReady || !earlyWinner?.earlyWinnerConfirmed || qualityScore >= 50,
  );
  const phase = resolveProtectionPhase({
    beArmed: earlyWinner?.beArmed,
    beFloor: earlyWinner?.beFloor,
    earlyWinnerActive: earlyWinner?.earlyWinnerActive,
    earlyWinnerTier: earlyWinner?.earlyWinnerTier,
    handoffReady,
    profitLockArmed,
    trailActive,
  });

  return {
    dynamicTrailArmR,
    dynamicTrailArmReason,
    handoffQualityScore: qualityScore,
    handoffMaturity,
    handoffAdvanceReason,
    handoffDeferredReason: deferredReason,
    handoffStateStable,
    handoffHysteresisActive,
    earlyWinnerHandoffReady: handoffReady,
    trailDeferredReason: deferredReason,
    ...phase,
  };
}

function computeEarlyWinnerStructureFloor({
  trade,
  earlyWinner,
  metrics,
  env,
  entry,
  ltp,
  underlyingLtp,
  side,
  tick,
}) {
  const config = buildEarlyWinnerConfig(env);
  const currentUnderlying = n(underlyingLtp, NaN);
  const executablePrice = n(metrics?.currentExecutablePrice, n(ltp, NaN));
  const currentR = n(metrics?.protectedCurrentR, n(metrics?.currentExecutableR, NaN));
  const quoteFreshnessMs = n(metrics?.quoteFreshnessMs, null);
  const freshnessLimitMs = Math.max(
    0,
    n(
      env.EXECUTABLE_QUOTE_FRESHNESS_MS,
      n(env.OPTION_EXECUTABLE_QUOTE_FRESHNESS_MS, 2000),
    ),
  );
  const anchors = structureAnchorCandidates(trade);
  const fallback = {
    enabled: Boolean(config.enabled && config.useStructure),
    available: false,
    candidateReason: null,
    referenceType: null,
    referencePrice: null,
    mappedFloor: null,
    bufferApplied: null,
    rejectedReason: null,
    source: null,
    floor: null,
    fallbackUsed: true,
    candidateCount: anchors.length,
  };
  if (!config.enabled) {
    return { ...fallback, enabled: false, candidateReason: "FEATURE_DISABLED" };
  }
  if (!config.useStructure) {
    return { ...fallback, candidateReason: "STRUCTURE_DISABLED" };
  }
  if (!earlyWinner?.earlyWinnerConfirmed) {
    return { ...fallback, candidateReason: "WAITING_CONFIRMATION" };
  }
  if (!earlyWinner?.protectionDataSafe) {
    return {
      ...fallback,
      candidateReason: earlyWinner?.protectionDataReason || "UNSAFE_QUOTE_QUALITY",
    };
  }
  if (
    config.structureRequireFresh &&
    Number.isFinite(quoteFreshnessMs) &&
    quoteFreshnessMs > freshnessLimitMs
  ) {
    return { ...fallback, candidateReason: "QUOTE_STALE" };
  }
  if (!(Number.isFinite(currentUnderlying) && currentUnderlying > 0)) {
    return { ...fallback, candidateReason: "UNDERLYING_LTP_UNAVAILABLE" };
  }
  if (!(Number.isFinite(executablePrice) && executablePrice > 0)) {
    return { ...fallback, candidateReason: "EXECUTABLE_PRICE_UNAVAILABLE" };
  }
  if (!anchors.length) {
    return { ...fallback, candidateReason: "STRUCTURE_REFERENCE_UNAVAILABLE" };
  }

  const direction = resolveUnderlyingStructureDirection({ trade, side });
  const minRoomR = Math.max(
    0.02,
    Number.isFinite(metrics?.riskInr) &&
      metrics.riskInr > 0 &&
      Number.isFinite(metrics?.qty) &&
      metrics.qty > 0
      ? ((tick * metrics.qty) / metrics.riskInr) * 2
      : 0.02,
  );
  const baseEarlyFloor = bestStop(
    side,
    n(earlyWinner?.earlyWinnerFloor, NaN),
    n(earlyWinner?.baseProtectionFloor, NaN),
  );
  let best = null;
  let rejectedReason = "NO_VALID_STRUCTURE_CANDIDATE";

  const rankedAnchors = anchors
    .map((anchor) => ({
      ...anchor,
      distance: structureDistanceForDirection(
        direction,
        currentUnderlying,
        anchor.price,
      ),
    }))
    .sort((a, b) => {
      const distA = Number.isFinite(a.distance) ? a.distance : Infinity;
      const distB = Number.isFinite(b.distance) ? b.distance : Infinity;
      if (distA !== distB) return distA - distB;
      return Number(b.priority ?? 0) - Number(a.priority ?? 0);
    });

  for (const anchor of rankedAnchors) {
    if (!(Number.isFinite(anchor.distance) && anchor.distance > 0)) {
      rejectedReason = "STRUCTURE_DIRECTION_MISMATCH";
      continue;
    }
    const mapped = mapUnderlyingReferenceToFloor({
      trade,
      env,
      side,
      tick,
      currentUnderlying,
      referencePrice: anchor.price,
      executablePrice,
    });
    if (!mapped || !Number.isFinite(mapped.mappedFloor)) {
      rejectedReason = "STRUCTURE_UNMAPPED";
      continue;
    }
    let candidateFloor = clampStopToMarket({
      side,
      stop: mapped.mappedFloor,
      ltp,
      tick,
    });
    candidateFloor = roundStopForSide(side, candidateFloor, tick);
    if (!Number.isFinite(candidateFloor)) {
      rejectedReason = "STRUCTURE_UNMAPPED";
      continue;
    }
    const candidateRetainedR = retainedRAtPrice({
      entry,
      qty: metrics.qty,
      side,
      price: candidateFloor,
      riskInr: metrics.riskInr,
    });
    const structureGapR =
      Number.isFinite(currentR) && Number.isFinite(candidateRetainedR)
        ? Math.max(0, currentR - candidateRetainedR)
        : null;
    if (
      Number.isFinite(structureGapR) &&
      structureGapR > config.structureMaxDistanceR
    ) {
      rejectedReason = "STRUCTURE_TOO_LOOSE";
      continue;
    }
    if (
      Number.isFinite(structureGapR) &&
      structureGapR < minRoomR
    ) {
      rejectedReason = "STRUCTURE_TOO_TIGHT";
      continue;
    }
    if (!isBetterStop(side, candidateFloor, baseEarlyFloor)) {
      rejectedReason = "NOT_STRONGER_THAN_BASE";
      continue;
    }
    if (
      !best ||
      isBetterStop(side, candidateFloor, best.candidateFloor)
    ) {
      best = {
        anchor,
        mapped,
        candidateFloor,
      };
    }
  }

  if (!best) {
    return {
      ...fallback,
      candidateReason: rejectedReason,
      rejectedReason,
    };
  }

  return {
    ...fallback,
    available: true,
    candidateReason: "STRUCTURE_CONFIRMED",
    referenceType: best.anchor.type,
    referencePrice: best.anchor.price,
    mappedFloor: best.candidateFloor,
    bufferApplied: best.mapped.bufferPrice,
    rejectedReason: null,
    source: "EARLY_WINNER_STRUCTURE",
    floor: best.candidateFloor,
    fallbackUsed: false,
    underlyingDistance: best.mapped.underlyingDistance,
    mappedMove: best.mapped.mappedMove,
    absDelta: best.mapped.absDelta,
    gammaAbs: best.mapped.gammaAbs,
  };
}

function interpolate(value, fromLo, fromHi, toLo, toHi) {
  if (!Number.isFinite(value)) return null;
  if (!(Number.isFinite(fromLo) && Number.isFinite(fromHi))) return null;
  if (fromHi <= fromLo) return toHi;
  const t = clamp((value - fromLo) / (fromHi - fromLo), 0, 1);
  return toLo + (toHi - toLo) * t;
}

function resolveEarlyWinnerRetentionKeepR({ config, peakR }) {
  const tierOne = config?.tiers?.[0] || null;
  const endR = Math.max(
    n(config?.armR, 0.4),
    n(tierOne?.atR, n(config?.toTrailMinR, 0.75)),
  );
  const endKeep = Math.min(
    n(config?.maxKeepR, 0.22),
    n(tierOne?.keepR, n(config?.maxKeepR, 0.22)),
  );
  return interpolate(
    peakR,
    n(config?.armR, 0.4),
    endR,
    n(config?.minKeepR, 0.08),
    endKeep,
  );
}

function computeEarlyWinnerState({
  trade,
  plan,
  metrics,
  env,
  entry,
  side,
  tick,
  now,
  candles = [],
  marketQuote,
}) {
  const config = buildEarlyWinnerConfig(env);
  const peakR = n(metrics?.protectedPeakR, n(metrics?.peakR, NaN));
  const currentR = n(metrics?.protectedCurrentR, NaN);
  const beFloor = n(plan?.meta?.beFloor, NaN);
  const beArmed = Boolean(
    plan?.meta?.beArmed ?? plan?.meta?.beLockHit ?? trade?.beLocked,
  );
  const minGreenSatisfied = Boolean(plan?.meta?.minGreenSatisfied);
  const overallEligible = Boolean(
    config.enabled &&
      beArmed &&
      minGreenSatisfied &&
      Number.isFinite(peakR) &&
      peakR >= config.armR,
  );
  const prevArmAt = tsFrom(trade?.earlyWinnerArmAt);
  const prevConfirmedAt = tsFrom(trade?.earlyWinnerConfirmedAt);
  const prevConfirmTicks = Math.max(0, n(trade?.earlyWinnerConfirmTicks, 0));
  const prevTier = Math.max(0, n(trade?.earlyWinnerTier, 0));
  const prevKeepR = n(trade?.earlyWinnerKeepR, NaN);
  const prevFloorPrice = n(trade?.earlyWinnerFloorPrice, NaN);
  const prevHandoffReady = Boolean(trade?.earlyWinnerHandoffReady);
  const givebackR = n(metrics?.givebackR, 0);
  const withinGiveback =
    !Number.isFinite(config.maxGivebackAfterArmR) ||
    givebackR <= config.maxGivebackAfterArmR + 1e-9;
  const reentryFloorR = config.armR - Math.max(0, config.reentryHysteresisR);
  const episodeEligible = Boolean(
    overallEligible &&
      (withinGiveback ||
        (Number.isFinite(currentR) && currentR >= reentryFloorR)),
  );

  let armAt = prevArmAt;
  let confirmTicks = prevConfirmTicks;
  let firstTouchDetected = false;
  let confirmationReset = false;

  if (!config.enabled) {
    armAt = null;
    confirmTicks = 0;
  } else if (Number.isFinite(prevConfirmedAt)) {
    armAt = Number.isFinite(prevArmAt) ? prevArmAt : prevConfirmedAt;
  } else if (episodeEligible) {
    if (Number.isFinite(prevArmAt)) {
      confirmTicks = prevConfirmTicks + 1;
    } else {
      armAt = now;
      confirmTicks = 1;
      firstTouchDetected = true;
    }
  } else {
    if (Number.isFinite(prevArmAt) || prevConfirmTicks > 0) {
      confirmationReset = true;
    }
    armAt = null;
    confirmTicks = 0;
  }

  const confirmMs =
    Number.isFinite(armAt) && config.enabled ? Math.max(0, now - armAt) : 0;
  const lastClosedBarTs =
    Array.isArray(candles) && candles.length
      ? candleTimestampMs(candles[candles.length - 1])
      : null;
  const barConfirmed = Boolean(
    config.requireBarConfirm &&
      Number.isFinite(armAt) &&
      Number.isFinite(lastClosedBarTs) &&
      lastClosedBarTs > armAt,
  );
  const ticksConfirmed =
    config.confirmTicks > 0 && confirmTicks >= config.confirmTicks;
  const msConfirmed = config.confirmMs > 0 && confirmMs >= config.confirmMs;
  const limitedGivebackConfirmed =
    Number.isFinite(peakR) &&
    peakR >= config.armR &&
    withinGiveback &&
    msConfirmed;
  const confirmed = Boolean(
    Number.isFinite(prevConfirmedAt) ||
      (episodeEligible &&
        (ticksConfirmed || msConfirmed || barConfirmed || limitedGivebackConfirmed)),
  );
  const confirmedAt = Number.isFinite(prevConfirmedAt)
    ? new Date(prevConfirmedAt)
    : confirmed
      ? new Date(now)
      : null;

  const spreadBps = spreadBpsFromQuote(marketQuote);
  const requireSafeExecution = enabled(
    env.DYNAMIC_EXIT_REQUIRE_SAFE_EXECUTION,
    true,
  );
  const spreadLimitBps = n(env.DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS, 120);
  const quoteQuality = String(metrics?.quoteQuality || "UNUSABLE").toUpperCase();
  const quoteClean = !isOptionTrade(trade)
    ? Number.isFinite(n(metrics?.currentExecutablePrice, NaN))
    : ["FRESH_EXECUTABLE", "STALE_EXECUTABLE"].includes(quoteQuality);
  const spreadClean =
    !requireSafeExecution ||
    !isOptionTrade(trade) ||
    (Number.isFinite(spreadBps) && spreadBps <= spreadLimitBps);
  const protectionDataSafe = Boolean(quoteClean && spreadClean);
  const tradeHoldMs = holdMsFromTrade(trade, now);
  const holdReady = tradeHoldMs >= config.minHoldMs;

  let tierHit = 0;
  let resolvedTierConfig = null;
  if (confirmed && Number.isFinite(peakR)) {
    for (const tier of config.tiers) {
      if (peakR >= tier.atR) {
        tierHit = tier.tier;
        resolvedTierConfig = tier;
      }
    }
  }

  const tier = Math.max(prevTier, tierHit);
  let keepR = null;
  let floorSource = null;
  let floorPrice = null;
  let mfeLockActive = false;
  let rawKeepR = null;
  const baseProtectionFloor = bestStop(
    side,
    beFloor,
    n(plan?.meta?.minGreenFloor, NaN),
    n(plan?.meta?.costGreenFloorPrice, NaN),
  );
  const baseProtectedR = retainedRAtPrice({
    entry,
    qty: metrics.qty,
    side,
    price: baseProtectionFloor,
    riskInr: metrics.riskInr,
  });
  const tickRetainedR =
    Number.isFinite(metrics?.riskInr) &&
    metrics.riskInr > 0 &&
    Number.isFinite(metrics?.qty) &&
    metrics.qty > 0 &&
    Number.isFinite(tick) &&
    tick > 0
      ? (tick * metrics.qty) / metrics.riskInr
      : 0;
  const retainableCeilingR = (() => {
    const rawCeiling = Number.isFinite(currentR)
      ? currentR
      : Number.isFinite(peakR)
        ? peakR
        : null;
    if (!Number.isFinite(rawCeiling)) return null;
    return Math.max(0, rawCeiling - Math.max(0, tickRetainedR));
  })();

  if (confirmed) {
    if (tier > 0) {
      const tierConfig =
        config.tiers.find((candidate) => candidate.tier === tier) ||
        resolvedTierConfig;
      rawKeepR = n(tierConfig?.keepR, NaN);
      floorSource = `MFE_LOCK_TIER_${tier}`;
      mfeLockActive = Number.isFinite(rawKeepR);
    } else {
      rawKeepR = resolveEarlyWinnerRetentionKeepR({ config, peakR });
      floorSource = "EARLY_WINNER_RETENTION";
    }

    const baseRetainedR = Number.isFinite(baseProtectedR) ? baseProtectedR : 0;
    let resolvedKeepR = null;
    if (String(config.mfeLockMode || "RATIO") === "RATIO") {
      const retentionRatio = clamp(rawKeepR, 0, 1);
      const surplusR = Math.max(
        0,
        (Number.isFinite(peakR) ? peakR : 0) - baseRetainedR,
      );
      resolvedKeepR = baseRetainedR + surplusR * retentionRatio;
    } else if (Number.isFinite(rawKeepR)) {
      resolvedKeepR = Math.max(baseRetainedR, rawKeepR);
    } else if (Number.isFinite(baseProtectedR)) {
      resolvedKeepR = baseProtectedR;
    }
    if (Number.isFinite(retainableCeilingR)) {
      resolvedKeepR = clamp(
        resolvedKeepR,
        baseRetainedR,
        Math.max(baseRetainedR, retainableCeilingR),
      );
    }
    keepR = Number.isFinite(resolvedKeepR)
      ? Math.max(Number.isFinite(prevKeepR) ? prevKeepR : -Infinity, resolvedKeepR)
      : Number.isFinite(prevKeepR)
        ? prevKeepR
        : null;
    floorPrice = retainedFloorPrice({
      entry,
      qty: metrics.qty,
      side,
      retainedR: keepR,
      riskInr: metrics.riskInr,
      tick,
    });
    floorPrice = bestStop(side, baseProtectionFloor, floorPrice, prevFloorPrice);
  }

  const earlyWinnerActive = Boolean(
    config.enabled &&
      confirmed &&
      Number.isFinite(beFloor) &&
      Number.isFinite(floorPrice) &&
      protectionDataSafe,
  );
  const dynamicHandoff = computeDynamicHandoffState({
    trade,
    earlyWinner: {
      beArmed,
      beFloor,
      earlyWinnerConfirmed: confirmed,
      earlyWinnerTier: tier,
      earlyWinnerActive,
      holdReady,
      protectionDataSafe,
      quoteQuality,
      spreadBps,
    },
    metrics,
    env,
    structureBonusAvailable: false,
    profitLockArmed: Boolean(plan?.meta?.profitLockArmed),
    trailActive: Boolean(plan?.meta?.trailActive),
  });

  const structureStatus = !config.useStructure
    ? "DISABLED"
    : structureAnchorCandidates(trade).length
      ? "READY_FOR_MAPPING"
      : "UNAVAILABLE";

  return {
    enabled: config.enabled,
    beArmed,
    beFloor,
    armR: config.armR,
    earlyWinnerEligible: overallEligible,
    earlyWinnerArmed: Boolean(overallEligible || Number.isFinite(armAt) || confirmed),
    earlyWinnerConfirmed: confirmed,
    earlyWinnerConfirmTicks: confirmTicks,
    earlyWinnerConfirmMs: confirmMs,
    earlyWinnerArmAt: Number.isFinite(armAt) ? new Date(armAt) : null,
    earlyWinnerConfirmedAt: confirmedAt,
    earlyWinnerTier: tier,
    earlyWinnerKeepR: Number.isFinite(keepR) ? keepR : null,
    earlyWinnerFloor: Number.isFinite(floorPrice) ? floorPrice : null,
    earlyWinnerFloorSource: floorSource,
    earlyWinnerActive,
    earlyWinnerMfeLockActive: mfeLockActive,
    earlyWinnerHandoffReady: dynamicHandoff.earlyWinnerHandoffReady,
    trailDeferredReason: dynamicHandoff.trailDeferredReason,
    protectionPhase: dynamicHandoff.protectionPhase,
    protectionPhaseNumber: dynamicHandoff.protectionPhaseNumber,
    dynamicTrailArmR: dynamicHandoff.dynamicTrailArmR,
    dynamicTrailArmReason: dynamicHandoff.dynamicTrailArmReason,
    handoffQualityScore: dynamicHandoff.handoffQualityScore,
    handoffMaturity: dynamicHandoff.handoffMaturity,
    handoffAdvanceReason: dynamicHandoff.handoffAdvanceReason,
    handoffDeferredReason: dynamicHandoff.handoffDeferredReason,
    handoffStateStable: dynamicHandoff.handoffStateStable,
    handoffHysteresisActive: dynamicHandoff.handoffHysteresisActive,
    beFirstTouchDetected: firstTouchDetected,
    confirmationProgress: {
      confirmTicks,
      confirmTicksTarget: config.confirmTicks,
      confirmMs,
      confirmMsTarget: config.confirmMs,
      barConfirmed,
      withinGiveback,
      confirmationReset,
      armStartedAt:
        Number.isFinite(armAt) ? new Date(armAt).toISOString() : null,
    },
    floorPersistenceState: {
      armStartedAt:
        Number.isFinite(armAt) ? new Date(armAt).toISOString() : null,
      confirmedAt:
        confirmedAt instanceof Date ? confirmedAt.toISOString() : null,
      previousTier: prevTier,
      previousFloorPrice: Number.isFinite(prevFloorPrice) ? prevFloorPrice : null,
      holdMs: tradeHoldMs,
    },
    protectionDataSafe,
    protectionDataReason: protectionDataSafe
      ? "SAFE"
      : !quoteClean
        ? "UNSAFE_QUOTE_QUALITY"
        : "SPREAD_TOO_WIDE",
    mfeLockMode: config.mfeLockMode,
    baseProtectionFloor: Number.isFinite(baseProtectionFloor)
      ? baseProtectionFloor
      : null,
    baseProtectedR: Number.isFinite(baseProtectedR) ? baseProtectedR : null,
    holdReady,
    tradeHoldMs,
    spreadBps,
    spreadLimitBps,
    quoteQuality,
    structureStatus,
    structureEnabled: config.useStructure,
    structureBufferTicks: config.structureBufferTicks,
    structureMaxDistanceR: config.structureMaxDistanceR,
  };
}

function buildWinnerMfeTiers(env) {
  const tiers = [
    {
      tier: 1,
      atR: n(env.EXIT_MFE_LOCK_T1_R, n(env.MFE_LOCK_1_AT_R, 0.8)),
      resolveKeepR: () => n(env.EXIT_MFE_LOCK_T1_KEEP_R, n(env.MFE_LOCK_1_KEEP_R, 0.2)),
    },
    {
      tier: 2,
      atR: n(env.EXIT_MFE_LOCK_T2_R, n(env.MFE_LOCK_2_AT_R, 1.0)),
      resolveKeepR: () => n(env.EXIT_MFE_LOCK_T2_KEEP_R, n(env.MFE_LOCK_2_KEEP_R, 0.6)),
    },
    {
      tier: 3,
      atR: n(env.EXIT_MFE_LOCK_T3_R, n(env.MFE_LOCK_3_AT_R, 1.25)),
      resolveKeepR: () => n(env.EXIT_MFE_LOCK_T3_KEEP_R, n(env.MFE_LOCK_3_KEEP_R, 0.8)),
    },
    {
      tier: 4,
      atR: n(env.EXIT_MFE_LOCK_T4_R, n(env.MFE_LOCK_4_AT_R, 1.5)),
      resolveKeepR: () => n(env.EXIT_MFE_LOCK_T4_KEEP_R, n(env.MFE_LOCK_4_KEEP_R, 1.0)),
    },
    {
      tier: 5,
      atR: n(env.EXIT_MFE_LOCK_T5_R, n(env.MFE_LOCK_5_AT_R, 2.0)),
      resolveKeepR: (peakR) =>
        Math.max(
          n(env.EXIT_MFE_LOCK_T5_MIN_KEEP_R, n(env.MFE_LOCK_5_KEEP_R, 1.2)),
          Number(peakR) - n(env.EXIT_MFE_LOCK_T5_GIVEBACK_R, 0.4),
        ),
    },
  ];
  const earlyWinnerConfig = buildEarlyWinnerConfig(env);
  const legacyMinActivationR = earlyWinnerConfig.enabled
    ? Math.max(
        n(earlyWinnerConfig.toTrailMinR, 0.75),
        n(env.PROFIT_LOCK_R, 1.0),
        1.0,
      )
    : -Infinity;
  return tiers
    .filter((tier) => Number.isFinite(tier.atR))
    .filter(
      (tier) =>
        !earlyWinnerConfig.enabled || Number(tier.atR) >= legacyMinActivationR,
    )
    .sort((a, b) => a.atR - b.atR);
}

function computeWinnerMfeLock({ trade, metrics, env, entry, side, tick }) {
  const peakR = n(metrics?.protectedPeakR, NaN);
  const tiers = buildWinnerMfeTiers(env);
  const hit = tiers.reduce(
    (best, tier) =>
      Number.isFinite(peakR) && peakR >= tier.atR ? tier : best,
    null,
  );
  const previousTier = Math.max(0, n(trade?.mfeLockTier, 0));
  const tier = Math.max(previousTier, n(hit?.tier, 0));
  if (!(tier > 0)) {
    return {
      tier: 0,
      floorR: 0,
      floorPrice: null,
      peakR: Number.isFinite(peakR) ? peakR : null,
      upgraded: false,
      active: false,
    };
  }
  const config = tiers.find((candidate) => candidate.tier === tier) || hit;
  const previousFloorR = n(trade?.mfeLockFloorR, NaN);
  const resolvedKeepR =
    typeof config?.resolveKeepR === "function" && Number.isFinite(peakR)
      ? config.resolveKeepR(peakR)
      : NaN;
  const floorR = Number.isFinite(resolvedKeepR)
    ? Math.max(Number.isFinite(previousFloorR) ? previousFloorR : -Infinity, resolvedKeepR)
    : Number.isFinite(previousFloorR)
      ? previousFloorR
      : null;
  let floorPrice = retainedFloorPrice({
    entry,
    qty: metrics.qty,
    side,
    retainedR: floorR,
    riskInr: metrics.riskInr,
    tick,
  });
  floorPrice = bestStop(side, floorPrice, n(trade?.mfeLockFloorPrice, NaN));
  return {
    tier,
    floorR: Number.isFinite(floorR) ? floorR : null,
    floorPrice: Number.isFinite(floorPrice) ? floorPrice : null,
    peakR: Number.isFinite(peakR) ? peakR : null,
    upgraded: tier > previousTier,
    active: tier > 0 && Number.isFinite(floorPrice),
  };
}

function resolveTradeRegimeLabel(trade = {}) {
  for (const candidate of [
    trade?.regime,
    trade?.marketRegime,
    trade?.regimeLabel,
    trade?.regime_state,
  ]) {
    const value = String(candidate || "").trim().toUpperCase();
    if (value) return value;
  }
  return null;
}

function matchesConfiguredRegime(label, configured = "") {
  const regime = String(label || "").trim().toUpperCase();
  if (!regime) return false;
  return String(configured || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .some((item) => regime === item || regime.includes(item));
}

function computePost1RTighten({ trade, metrics, env, entry, side, tick }) {
  const peakR = n(metrics?.protectedPeakR, NaN);
  const tightenAtR = n(env.EXIT_TIGHTEN_AT_R, 1.0);
  const gapR = n(env.EXIT_POST_1R_TRAIL_GAP_R, 0.25);
  const previouslyActive = Boolean(trade?.tightenActive);
  const marketRegime = resolveTradeRegimeLabel(trade);
  const weakRegimeGovernorEnabled = enabled(
    env.EXIT_TIGHTEN_WEAK_REGIME_GOVERNOR_ENABLED,
    true,
  );
  const suppressedByWeakRegime = Boolean(
    weakRegimeGovernorEnabled &&
      matchesConfiguredRegime(marketRegime, env.EXIT_TIGHTEN_WEAK_REGIMES),
  );
  const active =
    previouslyActive ||
    (!suppressedByWeakRegime &&
      Number.isFinite(peakR) &&
      Number.isFinite(tightenAtR) &&
      peakR >= tightenAtR);
  const storedActivationR = n(trade?.tightenActivatedAtR, NaN);
  const activatedAtR = Number.isFinite(storedActivationR)
    ? storedActivationR
    : active && Number.isFinite(peakR)
      ? peakR
      : null;
  const retainedR =
    active && Number.isFinite(peakR) && Number.isFinite(gapR)
      ? Math.max(0, peakR - gapR)
      : null;
  let floorPrice = retainedFloorPrice({
    entry,
    qty: metrics.qty,
    side,
    retainedR,
    riskInr: metrics.riskInr,
    tick,
  });
  floorPrice = bestStop(side, floorPrice, n(trade?.post1RTrailFloorPrice, NaN));
  return {
    active,
    activatedAtR: Number.isFinite(activatedAtR) ? activatedAtR : null,
    gapR: Number.isFinite(gapR) ? gapR : null,
    retainedR: Number.isFinite(retainedR) ? retainedR : null,
    floorPrice: Number.isFinite(floorPrice) ? floorPrice : null,
    newlyActivated: active && !previouslyActive,
    marketRegime,
    suppressedByWeakRegime,
  };
}

function selectHardGivebackRule({ peakR, givebackR, givebackPct, env }) {
  const t1PeakR = n(env.EXIT_HARD_GIVEBACK_T1_PEAK_R, 1.0);
  const t1GivebackR = n(env.EXIT_HARD_GIVEBACK_T1_R, 0.3);
  const t2PeakR = n(env.EXIT_HARD_GIVEBACK_T2_PEAK_R, 1.25);
  const t2GivebackR = n(env.EXIT_HARD_GIVEBACK_T2_R, 0.35);
  const t3PeakR = n(env.EXIT_HARD_GIVEBACK_T3_PEAK_R, 1.5);
  const t3GivebackPct = n(env.EXIT_HARD_GIVEBACK_T3_PCT, 0.3);

  if (
    Number.isFinite(peakR) &&
    peakR >= t3PeakR &&
    Number.isFinite(givebackPct) &&
    givebackPct >= t3GivebackPct
  ) {
    return {
      rule: "RULE_C",
      thresholdR: null,
      thresholdPct: t3GivebackPct,
    };
  }
  if (
    Number.isFinite(peakR) &&
    peakR >= t2PeakR &&
    Number.isFinite(givebackR) &&
    givebackR >= t2GivebackR
  ) {
    return {
      rule: "RULE_B",
      thresholdR: t2GivebackR,
      thresholdPct: null,
    };
  }
  if (
    Number.isFinite(peakR) &&
    peakR >= t1PeakR &&
    Number.isFinite(givebackR) &&
    givebackR >= t1GivebackR
  ) {
    return {
      rule: "RULE_A",
      thresholdR: t1GivebackR,
      thresholdPct: null,
    };
  }
  return null;
}

const HARD_GIVEBACK_RULE_RANK = Object.freeze({
  RULE_A: 1,
  RULE_B: 2,
  RULE_C: 3,
});

function hardGivebackRuleRank(rule) {
  return HARD_GIVEBACK_RULE_RANK[String(rule || "").toUpperCase()] ?? 0;
}

function computeHardGivebackState({ trade, peakR, currentR, env, now }) {
  const givebackR =
    Number.isFinite(peakR) && Number.isFinite(currentR)
      ? Math.max(0, peakR - currentR)
      : 0;
  const givebackPct =
    Number.isFinite(peakR) && peakR > 0 ? givebackR / peakR : 0;
  const selectedRule = selectHardGivebackRule({
    peakR,
    givebackR,
    givebackPct,
    env,
  });
  const confirmMsTarget = Math.max(0, n(env.EXIT_HARD_GIVEBACK_CONFIRM_MS, 800));
  const confirmTicksTarget = Math.max(
    1,
    Math.round(n(env.EXIT_HARD_GIVEBACK_CONFIRM_TICKS, 2)),
  );
  const previousRule = String(trade?.hardGivebackRule || "");
  const previousRuleRank = hardGivebackRuleRank(previousRule);
  const previousTicks = Math.max(0, n(trade?.hardGivebackConfirmTicks, 0));
  const previousArmedAt = Date.parse(trade?.hardGivebackArmedAt || "");
  const armed = Boolean(selectedRule);
  const hadActiveEpisode =
    Boolean(trade?.hardGivebackExitArmed) ||
    Number.isFinite(previousArmedAt) ||
    (previousRuleRank > 0 && previousTicks > 0);
  let armedAt = null;
  let confirmTicks = 0;

  if (armed) {
    // Keep a single confirmation episode alive until giveback fully disarms.
    if (hadActiveEpisode) {
      armedAt = Number.isFinite(previousArmedAt) ? previousArmedAt : now;
      confirmTicks = previousTicks + 1;
    } else {
      armedAt = now;
      confirmTicks = 1;
    }
  }

  const givebackConfirmMs =
    armed && Number.isFinite(armedAt) ? Math.max(0, now - armedAt) : 0;
  const confirmed =
    armed &&
    (confirmTicks >= confirmTicksTarget || givebackConfirmMs >= confirmMsTarget);

  return {
    givebackR,
    givebackPct,
    armed,
    confirmed,
    rule: selectedRule?.rule || null,
    thresholdR: selectedRule?.thresholdR ?? null,
    thresholdPct: selectedRule?.thresholdPct ?? null,
    confirmTicks,
    confirmTicksTarget,
    givebackConfirmMs,
    confirmMsTarget,
    armedAt: armed && Number.isFinite(armedAt) ? new Date(armedAt) : null,
    newlyArmed: armed && !hadActiveEpisode,
  };
}

function holdMsFromTrade(trade, nowTs = Date.now()) {
  const ref =
    Date.parse(trade?.entryFilledAt || "") ||
    Date.parse(trade?.createdAt || "") ||
    Date.parse(trade?.updatedAt || "");
  return Number.isFinite(ref) ? Math.max(0, nowTs - ref) : Infinity;
}

function spreadBpsFromQuote(marketQuote) {
  const bid = n(marketQuote?.bid, NaN);
  const ask = n(marketQuote?.ask, NaN);
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid)) {
    return null;
  }
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 10000;
}

function safeExecutableDistanceTicks({ side, executablePrice, stopLoss, tick }) {
  if (!(Number.isFinite(executablePrice) && Number.isFinite(stopLoss) && Number.isFinite(tick) && tick > 0)) {
    return null;
  }
  const dist = side === "SELL" ? stopLoss - executablePrice : executablePrice - stopLoss;
  return dist / tick;
}

function structureFloor({ trade, plan, hardFloor, side, underlyingLtp, env, allowAggressiveTighten }) {
  const base = bestStop(
    side,
    n(plan?.meta?.desiredStopLoss, NaN),
    n(plan?.meta?.newSL, NaN),
    n(plan?.sl?.stopLoss, NaN),
  );
  if (!Number.isFinite(base)) {
    return {
      floor: null,
      proposalFloor: null,
      source: null,
      confirmed: null,
    };
  }
  const requireWinnerGate = enabled(
    env?.DYNAMIC_EXIT_REQUIRE_WINNER_GATE_FOR_STRUCTURE_TRAIL,
    true,
  );
  if (requireWinnerGate && !allowAggressiveTighten) {
    return {
      floor: null,
      proposalFloor: base,
      source: "GATED",
      confirmed: null,
    };
  }
  if (!allowAggressiveTighten && isBetterStop(side, base, hardFloor)) {
    return {
      floor: null,
      proposalFloor: base,
      source: "GATED",
      confirmed: null,
    };
  }
  if (!isOptionTrade(trade) || !enabled(env.OPTION_TRAIL_USE_UNDERLYING_CONFIRM, true)) {
    return { floor: base, proposalFloor: base, source: "BASE", confirmed: null };
  }

  const uMoveBps = underlyingMoveBps({ trade, underlyingLtp });
  const opt = optionType(trade);
  const confirmed =
    opt === "CE" ? Number.isFinite(uMoveBps) && uMoveBps > 0
      : opt === "PE" ? Number.isFinite(uMoveBps) && uMoveBps < 0
      : null;
  if (confirmed === true) {
    return {
      floor: base,
      proposalFloor: base,
      source: "UNDERLYING_CONFIRMED",
      confirmed,
    };
  }

  const premiumWeight = n(env.OPTION_PREMIUM_TRAIL_WEIGHT, 0.35);
  const underlyingWeight = n(env.OPTION_UNDERLYING_TRAIL_WEIGHT, 0.65);
  const total = Math.max(0.0001, premiumWeight + underlyingWeight);
  return {
    floor: blendStop(side, hardFloor, base, premiumWeight / total),
    proposalFloor: blendStop(side, hardFloor, base, premiumWeight / total),
    source: "PREMIUM_WEIGHTED",
    confirmed,
  };
}

function enrichDynamicExitPlan({
  trade,
  plan,
  ltp,
  candles = [],
  underlyingLtp,
  marketQuote,
  now = Date.now(),
  env,
  entry,
  sl0,
  side,
  tick,
}) {
  if (!plan?.ok) return plan;

  const curSL = n(trade?.stopLoss, sl0);
  const tradePatch = { ...(plan?.tradePatch || {}) };
  const metrics = buildMetrics({
    trade,
    entry,
    sl0,
    side,
    ltp,
    marketQuote,
    env,
    now,
    tick,
  });
  patchField(
    tradePatch,
    trade,
    "executionRiskPts",
    metrics.executionRiskPts,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "executionRiskQty",
    metrics.executionRiskQty,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "executionRiskInr",
    metrics.riskInr,
    1,
  );
  patchIfChanged(tradePatch, trade, "peakExecutablePnlInr", metrics.peakExecutablePnlInr, 1);
  patchIfChanged(tradePatch, trade, "peakExecutableR", metrics.peakExecutableR, 0.001);
  patchIfChanged(tradePatch, trade, "currentExecutableR", metrics.currentExecutableR, 0.001);
  patchIfChanged(tradePatch, trade, "protectedPeakR", metrics.protectedPeakR, 0.001);
  patchIfChanged(tradePatch, trade, "protectedCurrentR", metrics.protectedCurrentR, 0.001);
  patchIfChanged(tradePatch, trade, "givebackR", metrics.givebackR, 0.001);
  patchIfChanged(tradePatch, trade, "givebackPct", metrics.givebackPct, 0.001);
  const loserCompression = evaluateAdaptiveLoserCompression({
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
  });

  const fallbackTrueBe = estimateTrueBreakEven({
    entryPrice: entry,
    qty: metrics.qty,
    side,
    tick,
    spreadBps: n(trade?.quoteAtEntry?.bps, 0),
    env,
    instrument: trade?.instrument || null,
    costMultiplier: n(env.DYN_BE_COST_MULT, 1),
  })?.price;
  const trueBePrice = Number.isFinite(n(plan?.meta?.trueBE, NaN))
    ? n(plan?.meta?.trueBE, NaN)
    : fallbackTrueBe;
  const beArmed = Boolean(
    plan?.meta?.beArmed ??
      plan?.meta?.beLockHit ??
      tradePatch?.beLocked ??
      trade?.beLocked,
  );
  const beApplied = Boolean(
    plan?.meta?.beApplied ??
      tradePatch?.beApplied ??
      tradePatch?.beAppliedAt ??
      trade?.beApplied ??
      trade?.beAppliedAt,
  );
  const trailArmed = Boolean(plan?.meta?.trailArmed ?? plan?.meta?.trailHit);
  const trailAllowed = Boolean(
    plan?.meta?.trailAllowed ??
      tradePatch?.trailAllowed ??
      trade?.trailAllowed ??
      plan?.meta?.trailActive ??
      tradePatch?.trailActive ??
      trade?.trailActive,
  );
  const beEligible = Boolean(plan?.meta?.beEligible || beArmed);
  const beBufferTicks = n(env.BE_BUFFER_TICKS, n(env.DYN_BE_BUFFER_TICKS, 1));
  let beFloor = n(plan?.meta?.beFloor, NaN);
  if (!Number.isFinite(beFloor) && beArmed && Number.isFinite(trueBePrice)) {
    const raw = side === "SELL" ? trueBePrice - beBufferTicks * tick : trueBePrice + beBufferTicks * tick;
    beFloor = roundToTick(raw, tick, side === "SELL" ? "down" : "up");
  }
  beFloor = beArmed && Number.isFinite(beFloor) ? beFloor : null;
  const costGreen = estimateCostGreenFloor({
    entryPrice: entry,
    qty: metrics.qty,
    side,
    tick,
    spreadBps: n(trade?.quoteAtEntry?.bps, 0),
    env,
    instrument: trade?.instrument || null,
    costMultiplier: n(env.GREEN_LOCK_COST_MULT, 1),
  });
  const costGreenFloorPrice = n(costGreen?.price, NaN);
  const costGreenFloorInr = n(costGreen?.floorInr, NaN);
  const costGreenFloorR =
    Number.isFinite(costGreenFloorInr) && metrics.riskInr > 0
      ? costGreenFloorInr / metrics.riskInr
      : 0;
  const greenLockActive =
    enabled(env.GREEN_LOCK_ENABLED, true) &&
    (Boolean(trade?.greenLockActive) ||
      n(metrics.protectedCurrentR, -Infinity) >= n(env.GREEN_LOCK_ARM_R, 0.8) ||
      n(metrics.protectedPeakR, -Infinity) >= n(env.GREEN_LOCK_PEAK_R, 1.0));
  const greenLockFloorPrice = greenLockActive
    ? bestStop(
        side,
        costGreenFloorPrice,
        retainedRToPrice({
          entryPrice: entry,
          qty: metrics.qty,
          side,
          retainedR: Math.max(n(env.GREEN_LOCK_MIN_R, 0.12), costGreenFloorR),
          riskInr: metrics.riskInr,
          tick,
          roundMode: side === "SELL" ? "down" : "up",
        }),
      )
    : null;

  let earlyWinner = computeEarlyWinnerState({
    trade,
    plan,
    metrics,
    env,
    entry,
    side,
    tick,
    now,
    candles,
    marketQuote,
  });
  const earlyWinnerStructure = computeEarlyWinnerStructureFloor({
    trade,
    earlyWinner,
    metrics,
    env,
    entry,
    ltp,
    underlyingLtp,
    side,
    tick,
  });
  earlyWinner = {
    ...earlyWinner,
    structureStatus: earlyWinnerStructure.available
      ? "AVAILABLE"
      : earlyWinnerStructure.candidateReason || earlyWinner.structureStatus,
    structureCandidateAvailable: Boolean(earlyWinnerStructure.available),
    structureReferenceType: earlyWinnerStructure.referenceType,
    structureReferencePrice: earlyWinnerStructure.referencePrice,
    structureMappedFloor: earlyWinnerStructure.mappedFloor,
    structureBufferApplied: earlyWinnerStructure.bufferApplied,
    structureRejectedReason:
      earlyWinnerStructure.rejectedReason || earlyWinnerStructure.candidateReason,
    structureFallbackUsed: Boolean(earlyWinnerStructure.fallbackUsed),
  };
  earlyWinner = {
    ...earlyWinner,
    ...computeDynamicHandoffState({
      trade,
      earlyWinner,
      metrics,
      env,
      structureBonusAvailable: Boolean(earlyWinnerStructure.available),
      profitLockArmed: Boolean(plan?.meta?.profitLockArmed),
      trailActive: Boolean(plan?.meta?.trailActive),
    }),
  };

  const mfeLock = computeWinnerMfeLock({
    trade,
    metrics,
    env,
    entry,
    side,
    tick,
  });
  const mfeLockTier = mfeLock.tier;
  const mfeLockFloorR = mfeLock.floorR;
  const mfeLockFloorPrice = mfeLock.floorPrice;

  const tighten = computePost1RTighten({
    trade,
    metrics,
    env,
    entry,
    side,
    tick,
  });
  const tightenActive = tighten.active;
  const tightenActivatedAtR = tighten.activatedAtR;
  const post1RTrailGapR = tighten.gapR;
  const post1RTrailFloorPrice = tighten.floorPrice;
  const tightenSuppressedByWeakRegime = Boolean(tighten.suppressedByWeakRegime);
  const tightenMarketRegime = tighten.marketRegime;

  const hardGiveback = computeHardGivebackState({
    trade,
    peakR: n(metrics.protectedPeakR, NaN),
    currentR: n(metrics.protectedCurrentR, NaN),
    env,
    now,
  });
  const givebackR = hardGiveback.givebackR;
  const givebackPct = hardGiveback.givebackPct;
  const givebackActive = Boolean(trade?.givebackActive || hardGiveback.armed);
  const emergencyProtection = hardGiveback.confirmed;
  const shadowExitActive = Boolean(
    trade?.shadowExitActive || tradePatch?.shadowExitActive,
  );
  const tp1RunnerActive = Boolean(trade?.tp1Done);
  const profitLockArmed = Boolean(
    plan?.meta?.profitLockArmed ?? trade?.profitLockArmed,
  );
  const profitLockFloor = n(plan?.meta?.profitLockFloor, NaN);
  const beProfitLockFloor = n(plan?.meta?.beProfitLockFloor, NaN);
  const beProtectionLive = Boolean(beApplied && Number.isFinite(beFloor));
  const trailProtectionLive = Boolean(
    trailAllowed ||
      plan?.meta?.trailActive ||
      tradePatch?.trailActive ||
      trade?.trailActive,
  );
  const beFloorActive = beArmed && Number.isFinite(beFloor);
  const greenLockFloorActive =
    greenLockActive && Number.isFinite(greenLockFloorPrice);
  const mfeLockActive = Boolean(mfeLock.active && Number.isFinite(mfeLockFloorPrice));
  const tightenFloorActive =
    tightenActive && Number.isFinite(post1RTrailFloorPrice);
  const basePlanDesiredStopLoss = bestStop(
    side,
    n(plan?.meta?.desiredStopLoss, NaN),
    n(plan?.meta?.newSL, NaN),
  );
  const preliminaryProtectionGateOpen =
    beProtectionLive ||
    trailProtectionLive ||
    greenLockActive ||
    earlyWinner.earlyWinnerActive ||
    profitLockArmed ||
    (Number.isFinite(mfeLockTier) && mfeLockTier > 0) ||
    tightenActive ||
    hardGiveback.armed ||
    emergencyProtection ||
    shadowExitActive ||
    tp1RunnerActive;
  let winnerModeActive = Boolean(preliminaryProtectionGateOpen);
  const preStructureHardFloor = bestStop(
    side,
    curSL,
    sl0,
    beFloorActive ? beFloor : null,
    greenLockFloorActive ? greenLockFloorPrice : null,
    earlyWinner.earlyWinnerActive ? earlyWinner.earlyWinnerFloor : null,
    earlyWinnerStructure.available ? earlyWinnerStructure.floor : null,
    !earlyWinner.enabled && Number.isFinite(beProfitLockFloor)
      ? beProfitLockFloor
      : null,
    profitLockArmed ? profitLockFloor : null,
    mfeLockActive ? mfeLockFloorPrice : null,
    tightenFloorActive ? post1RTrailFloorPrice : null,
  );
  const regularTrailAllowedByHandoff = Boolean(
    !earlyWinner.enabled ||
      trailArmed ||
      earlyWinner.earlyWinnerHandoffReady ||
      profitLockArmed ||
      tightenActive ||
      emergencyProtection,
  );
  const trail = structureFloor({
    trade,
    plan,
    hardFloor: preStructureHardFloor,
    side,
    underlyingLtp,
    env,
    allowAggressiveTighten: earlyWinner.enabled
      ? regularTrailAllowedByHandoff
      : preliminaryProtectionGateOpen,
  });
  const regularTrailFloor =
    trailAllowed && regularTrailAllowedByHandoff
      ? bestStop(
          side,
          n(plan?.meta?.trailSl, NaN),
          Boolean(plan?.meta?.trailActive || trailArmed)
            ? basePlanDesiredStopLoss
            : null,
        )
      : null;
  const structureTrailFloor =
    regularTrailAllowedByHandoff &&
    trail.source &&
    trail.source !== "GATED" &&
    trail.source !== "BASE" &&
    Number.isFinite(trail.floor)
      ? trail.floor
      : null;
  const structureTrailAllowed = Boolean(Number.isFinite(structureTrailFloor));

  const candidateFloors = [
    makeFloorCandidate({
      source: loserCompression.candidateFloor?.source || "ALC_L1",
      price: loserCompression.candidateFloor?.price,
      eligible: Boolean(
        loserCompression.loserCompressionActive &&
          Number.isFinite(n(loserCompression.candidateFloor?.price, NaN)),
      ),
      rejectedReason:
        loserCompression.blockedReason ||
        (loserCompression.eligible
          ? loserCompression.reason || "NO_ACTION"
          : "NOT_ELIGIBLE"),
      phase: loserCompression.candidateFloor?.phase || "PHASE_0_LOSS_CONTAINMENT",
      details: loserCompression.candidateFloor?.details || {
        score: loserCompression.failure?.score ?? null,
      },
    }),
    makeFloorCandidate({
      source: beFloorActive ? plan?.meta?.beFloorSource || "TRUE_BE" : "TRUE_BE",
      price: beFloor,
      eligible: beFloorActive,
      rejectedReason: beArmed ? "NO_PRICE" : "NOT_ARMED",
      phase: "PHASE_1_COST_PROTECTION",
    }),
    makeFloorCandidate({
      source: "BE_PROFIT_LOCK",
      price: beProfitLockFloor,
      eligible: !earlyWinner.enabled && Number.isFinite(beProfitLockFloor),
      rejectedReason: earlyWinner.enabled
        ? "DEFERRED_TO_EARLY_WINNER"
        : beArmed
          ? "NO_PRICE"
          : "NOT_ARMED",
      phase: "PHASE_1_COST_PROTECTION",
    }),
    makeFloorCandidate({
      source: "GREEN_LOCK",
      price: greenLockFloorPrice,
      eligible: greenLockFloorActive,
      rejectedReason: greenLockActive ? "NO_PRICE" : "NOT_ARMED",
      phase: earlyWinner.enabled
        ? "PHASE_4_MATURE_WINNER"
        : "PHASE_3_PRE_TRAIL_MFE_LOCK",
    }),
    makeFloorCandidate({
      source: earlyWinner.earlyWinnerFloorSource || "EARLY_WINNER_RETENTION",
      price: earlyWinner.earlyWinnerFloor,
      eligible: earlyWinner.earlyWinnerActive,
      rejectedReason: !earlyWinner.enabled
        ? "FEATURE_DISABLED"
        : !earlyWinner.earlyWinnerConfirmed
          ? "WAITING_CONFIRMATION"
          : !earlyWinner.protectionDataSafe
            ? earlyWinner.protectionDataReason
            : "NO_PRICE",
      phase: earlyWinner.protectionPhase,
      details: {
        tier: earlyWinner.earlyWinnerTier,
        keepR: earlyWinner.earlyWinnerKeepR,
        mode: earlyWinner.mfeLockMode,
        baseFloor: earlyWinner.baseProtectionFloor,
        baseProtectedR: earlyWinner.baseProtectedR,
      },
    }),
    makeFloorCandidate({
      source: "EARLY_WINNER_STRUCTURE",
      price: earlyWinnerStructure.floor,
      eligible: earlyWinnerStructure.available,
      rejectedReason:
        earlyWinnerStructure.rejectedReason ||
        earlyWinnerStructure.candidateReason ||
        "NO_PRICE",
      phase:
        Number(earlyWinner.earlyWinnerTier ?? 0) > 0
          ? "PHASE_3_PRE_TRAIL_MFE_LOCK"
          : "PHASE_2_EARLY_WINNER_RETENTION",
      details: {
        referenceType: earlyWinnerStructure.referenceType,
        referencePrice: earlyWinnerStructure.referencePrice,
        bufferApplied: earlyWinnerStructure.bufferApplied,
        mappedFloor: earlyWinnerStructure.mappedFloor,
      },
    }),
    makeFloorCandidate({
      source: "PROFIT_LOCK",
      price: profitLockFloor,
      eligible: profitLockArmed && Number.isFinite(profitLockFloor),
      rejectedReason: profitLockArmed ? "NO_PRICE" : "NOT_ARMED",
      phase: "PHASE_4_MATURE_WINNER",
    }),
    makeFloorCandidate({
      source: "MFE_LOCK",
      price: mfeLockFloorPrice,
      eligible: mfeLockActive,
      rejectedReason: enabled(env.MFE_LOCK_LADDER_ENABLED, true)
        ? mfeLockTier > 0
          ? "NO_PRICE"
          : "BELOW_THRESHOLD"
        : "FEATURE_DISABLED",
      phase: "PHASE_4_MATURE_WINNER",
      details: { tier: mfeLockTier, keepR: mfeLockFloorR },
    }),
    makeFloorCandidate({
      source: "POST_1R_TIGHTEN",
      price: post1RTrailFloorPrice,
      eligible: tightenFloorActive,
      rejectedReason: tightenActive ? "NO_PRICE" : "BELOW_THRESHOLD",
      phase: "PHASE_4_MATURE_WINNER",
    }),
    makeFloorCandidate({
      source: "TRAIL",
      price: regularTrailFloor,
      eligible: trailAllowed && regularTrailAllowedByHandoff && Number.isFinite(regularTrailFloor),
      rejectedReason: !trailAllowed
        ? plan?.meta?.trailBlockReason || "TRAIL_NOT_ALLOWED"
        : !regularTrailAllowedByHandoff
          ? earlyWinner.trailDeferredReason || "EARLY_WINNER_HANDOFF_PENDING"
          : "NO_PRICE",
      phase: "PHASE_4_MATURE_WINNER",
      details: { trailArmed, trailAllowed },
    }),
    makeFloorCandidate({
      source: "STRUCTURE_TRAIL",
      price: structureTrailFloor,
      eligible: structureTrailAllowed,
      rejectedReason: trail.source === "GATED"
        ? !regularTrailAllowedByHandoff
          ? earlyWinner.trailDeferredReason || "EARLY_WINNER_HANDOFF_PENDING"
          : "STRUCTURE_TRAIL_GATED"
        : !regularTrailAllowedByHandoff
          ? earlyWinner.trailDeferredReason || "EARLY_WINNER_HANDOFF_PENDING"
          : "NO_PRICE",
      phase: "PHASE_4_MATURE_WINNER",
      details: {
        source: trail.source,
        confirmed: trail.confirmed,
      },
    }),
  ];

  const arbitration = selectFloorCandidate({
    side,
    candidates: candidateFloors,
    tick,
  });
  const arbitrationWinner = arbitration.winner?.source ?? null;
  const arbitrationWinnerReason = arbitration.winnerReason;
  const selectedProtectedFloor = n(arbitration.winner?.price, NaN);
  const protectedStopSource = arbitrationWinner;
  const protectionSafetyFloor = bestStop(
    side,
    beFloorActive ? beFloor : null,
    greenLockFloorActive ? greenLockFloorPrice : null,
    earlyWinner.earlyWinnerActive ? earlyWinner.earlyWinnerFloor : null,
    earlyWinnerStructure.available ? earlyWinnerStructure.floor : null,
    !earlyWinner.enabled ? beProfitLockFloor : null,
    profitLockArmed ? profitLockFloor : null,
    mfeLockActive ? mfeLockFloorPrice : null,
    tightenFloorActive ? post1RTrailFloorPrice : null,
  );
  const telemetryStopProposal = bestStop(
    side,
    curSL,
    sl0,
    ...candidateFloors.map((candidate) => candidate.price),
    trail.proposalFloor,
  );
  const executableHardFloor = bestStop(
    side,
    curSL,
    sl0,
    selectedProtectedFloor,
  );
  let desiredStopLoss = bestStop(side, curSL, sl0, selectedProtectedFloor);
  desiredStopLoss = clampStopToMarket({ side, stop: desiredStopLoss, ltp, tick });
  desiredStopLoss = roundStopForSide(side, desiredStopLoss, tick);
  desiredStopLoss = bestStop(side, curSL, desiredStopLoss);

  const curRounded = roundStopForSide(side, curSL, tick);
  const protectionSafetyUpgrade = Boolean(
    Number.isFinite(protectionSafetyFloor) &&
      Number.isFinite(curRounded) &&
      isBetterStop(side, protectionSafetyFloor, curRounded),
  );
  const optionalTrailFloor = bestStop(
    side,
    regularTrailFloor,
    structureTrailFloor,
    mfeLockFloorPrice,
    post1RTrailFloorPrice,
  );
  const optionalTrailUpgrade = Boolean(
    Number.isFinite(optionalTrailFloor) &&
      Number.isFinite(curRounded) &&
      isBetterStop(side, optionalTrailFloor, curRounded),
  );
  const stepTicks = Number(
    (beProtectionLive || trailProtectionLive)
      ? env.DYN_STEP_TICKS_POST_BE ?? 5
      : env.DYN_STEP_TICKS_PRE_BE ?? 10,
  );
  const step = stepTicks * tick;
  const slMove = stopMove(side, desiredStopLoss, curRounded);
  const aggressiveTighten = isBetterStop(side, desiredStopLoss, sl0);
  const holdMs = holdMsFromTrade(trade, now);
  const holdOk =
    !aggressiveTighten ||
    holdMs >= n(env.DYNAMIC_EXIT_MIN_HOLD_MS, 15000) ||
    n(metrics.protectedCurrentR, -Infinity) >= n(env.DYNAMIC_EXIT_EARLY_TIGHTEN_MIN_R, 0.6) ||
    emergencyProtection;
  const currentSpreadBps = spreadBpsFromQuote(marketQuote);
  const spreadOk =
    !enabled(env.DYNAMIC_EXIT_REQUIRE_SAFE_EXECUTION, true) ||
    !isOptionTrade(trade) ||
    (Number.isFinite(currentSpreadBps) &&
      currentSpreadBps <= n(env.DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS, 120)) ||
    emergencyProtection;
  const execDistanceTicks = safeExecutableDistanceTicks({
    side,
    executablePrice: metrics.currentExecutablePrice,
    stopLoss: desiredStopLoss,
    tick,
  });
  const distanceOk =
    !enabled(env.DYNAMIC_EXIT_REQUIRE_SAFE_EXECUTION, true) ||
    !isOptionTrade(trade) ||
    (Number.isFinite(execDistanceTicks) &&
      execDistanceTicks >= n(env.DYNAMIC_EXIT_MIN_EXECUTABLE_DISTANCE_TICKS, 2)) ||
    emergencyProtection;
  const spreadGuardBypassed = protectionSafetyUpgrade && !spreadOk;
  const distanceGuardBypassed = protectionSafetyUpgrade && !distanceOk;
  const spreadOkForMove = spreadOk || protectionSafetyUpgrade;
  const distanceOkForMove = distanceOk || protectionSafetyUpgrade;
  const bePriorityPending =
    beArmed &&
    !beApplied &&
    Number.isFinite(beFloor) &&
    Number.isFinite(curRounded) &&
    (side === "SELL" ? curRounded > beFloor : curRounded < beFloor);
  const bePriorityForce =
    String(plan?.meta?.skipReason || "").includes("be_priority_sl_move") ||
    bePriorityPending;
  const earlyWinnerTierUpgrade =
    Number(earlyWinner.earlyWinnerTier ?? 0) >
    Number(trade?.earlyWinnerTier ?? 0);
  const earlyWinnerJustConfirmed = Boolean(
    earlyWinner.earlyWinnerConfirmed && !trade?.earlyWinnerConfirmedAt,
  );
  const earlyWinnerFloorUpgrade = Boolean(
    earlyWinner.earlyWinnerActive &&
      Number.isFinite(earlyWinner.earlyWinnerFloor) &&
      isBetterStop(
        side,
        earlyWinner.earlyWinnerFloor,
        n(trade?.earlyWinnerFloorPrice, curRounded),
      ),
  );
  const earlyWinnerStructureUpgrade = Boolean(
    earlyWinnerStructure.available &&
      Number.isFinite(earlyWinnerStructure.floor) &&
      isBetterStop(
        side,
        earlyWinnerStructure.floor,
        bestStop(
          side,
          n(trade?.structureMappedFloor, NaN),
          n(trade?.earlyWinnerFloorPrice, curRounded),
        ),
      ),
  );
  const forceMove =
    bePriorityForce ||
    Boolean(trade?.shadowExitActive) ||
    loserCompression.loserCompressionActive ||
    earlyWinnerJustConfirmed ||
    earlyWinnerTierUpgrade ||
    earlyWinnerFloorUpgrade ||
    earlyWinnerStructureUpgrade ||
    mfeLock.upgraded ||
    tighten.newlyActivated ||
    (!trade?.greenLockActive && greenLockActive);
  const action = plan?.action?.exitNow
    ? plan.action
    : loserCompression.exitNow
      ? { exitNow: true, reason: loserCompression.reason }
    : hardGiveback.confirmed
      ? { exitNow: true, reason: "GIVEBACK_CAP" }
      : plan.action || null;
  const shouldExitNowReason = action?.reason || null;
  const exitLifecycle = action?.reason ? resolveExitLifecycle(action.reason) : null;
  const exitAuthority =
    exitLifecycle?.exitAuthority ??
    plan?.meta?.exitAuthority ??
    plan?.tradePatch?.exitAuthority ??
    trade?.exitAuthority ??
    null;
  const explicitLossContainmentAuthority = [
    "EARLY_FAIL_ENGINE",
    "TIME_STOP_ENGINE",
    "POST_FILL_RISK_ENGINE",
    "ADAPTIVE_LOSER_ENGINE",
  ].includes(String(exitAuthority || "").toUpperCase());
  const safePreBeStopCompressionEnabled =
    env.DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION === true;
  let stopImproveAuthorized = Boolean(
    bePriorityPending ||
      beProtectionLive ||
      trailProtectionLive ||
      greenLockFloorActive ||
      earlyWinner.earlyWinnerActive ||
      profitLockArmed ||
      mfeLockActive ||
      tightenActive ||
      hardGiveback.armed ||
      emergencyProtection ||
      shadowExitActive ||
      loserCompression.loserCompressionActive ||
      explicitLossContainmentAuthority ||
      safePreBeStopCompressionEnabled,
  );
  const shouldTighten =
    isBetterStop(side, desiredStopLoss, curRounded) || tightenActive;
  const shouldMoveSL =
    shouldTighten &&
    holdOk &&
    spreadOkForMove &&
    distanceOkForMove &&
    ((Number.isFinite(slMove) && slMove >= step) || forceMove);
  let finalStopLoss = shouldMoveSL
    ? roundTriggerForSide(side, desiredStopLoss, tick, n(env.TRIGGER_BUFFER_TICKS, 1))
    : null;
  if (shouldMoveSL) {
    finalStopLoss = clampStopToMarket({ side, stop: finalStopLoss, ltp, tick });
    finalStopLoss = roundStopForSide(side, finalStopLoss, tick);
  }

  const reasons = [];
  if (beArmed && Number.isFinite(beFloor)) reasons.push("BE_ARM");
  if (earlyWinner.earlyWinnerEligible) reasons.push("EARLY_WINNER_ELIGIBLE");
  if (earlyWinner.earlyWinnerArmed) reasons.push("EARLY_WINNER_ARMED");
  if (earlyWinner.earlyWinnerConfirmed) reasons.push("EARLY_WINNER_CONFIRMED");
  if (
    earlyWinner.earlyWinnerActive &&
    String(earlyWinner.earlyWinnerFloorSource || "") === "EARLY_WINNER_RETENTION"
  ) {
    reasons.push("EARLY_WINNER_RETENTION");
  }
  if (Number(earlyWinner.earlyWinnerTier ?? 0) > 0) {
    reasons.push(`MFE_LOCK_TIER_${Number(earlyWinner.earlyWinnerTier)}`);
  }
  if (earlyWinner.earlyWinnerHandoffReady) reasons.push("EARLY_WINNER_HANDOFF_READY");
  if (earlyWinnerStructure.available) reasons.push("EARLY_WINNER_STRUCTURE");
  if (greenLockActive && Number.isFinite(greenLockFloorPrice)) reasons.push("GREEN_LOCK");
  if (mfeLockTier > 0 && Number.isFinite(mfeLockFloorPrice)) reasons.push(`MFE_LOCK_T${mfeLockTier}`);
  if (mfeLock.upgraded) reasons.push("MFE_LOCK_TIER_UPGRADE");
  if (tightenActive) reasons.push("POST_1R_TIGHTEN_ACTIVE");
  if (loserCompression.reason && loserCompression.reason !== "ALC_HOLD") {
    reasons.push(loserCompression.reason);
  } else if (loserCompression.blockedReason) {
    reasons.push(loserCompression.blockedReason);
  }
  if (hardGiveback.armed) reasons.push("HARD_GIVEBACK_EXIT_ARMED");
  if (hardGiveback.confirmed) reasons.push("HARD_GIVEBACK_EXIT_TRIGGERED");
  if (arbitrationWinner) reasons.push(`ARBITRATION_${arbitrationWinner}`);
  if (protectionSafetyUpgrade) reasons.push("PROTECTION_SAFETY_UPGRADE");
  if (optionalTrailUpgrade) reasons.push("OPTIONAL_TRAIL_UPGRADE");
  if (structureTrailAllowed) reasons.push("STRUCTURE_TRAIL");
  if (trail.source === "GATED") reasons.push("STRUCTURE_TRAIL_GATED");
  if (earlyWinner.enabled && !regularTrailAllowedByHandoff && earlyWinner.trailDeferredReason) {
    reasons.push(`TRAIL_DEFERRED_${String(earlyWinner.trailDeferredReason).toUpperCase()}`);
  }
  if (!holdOk) reasons.push("MIN_HOLD_BLOCK");
  if (!spreadOk && !spreadGuardBypassed) reasons.push("EXEC_SPREAD_BLOCK");
  if (!distanceOk && !distanceGuardBypassed) reasons.push("EXEC_DISTANCE_BLOCK");
  if (spreadGuardBypassed) reasons.push("EXEC_SPREAD_BYPASS_FOR_SAFETY");
  if (distanceGuardBypassed) reasons.push("EXEC_DISTANCE_BYPASS_FOR_SAFETY");
  const blockedOnlyReasonTags = hasOnlyBlockedReasonTags(reasons);
  if (blockedOnlyReasonTags) stopImproveAuthorized = false;

  const normalizedTelemetryProposalFloor = roundStopForSide(
    side,
    clampStopToMarket({ side, stop: telemetryStopProposal, ltp, tick }),
    tick,
  );
  const proposalImprovesCurrentStop =
    isBetterStop(side, normalizedTelemetryProposalFloor, curRounded);
  let stopImproveBlockedReason = null;
  if (proposalImprovesCurrentStop && !stopImproveAuthorized) {
    stopImproveBlockedReason = "NO_AUTHORITY";
  } else if (proposalImprovesCurrentStop && !holdOk) {
    stopImproveBlockedReason = "MIN_HOLD_BLOCK";
  } else if (proposalImprovesCurrentStop && !spreadOk && !spreadGuardBypassed) {
    stopImproveBlockedReason = "EXEC_SPREAD_BLOCK";
  } else if (proposalImprovesCurrentStop && !distanceOk && !distanceGuardBypassed) {
    stopImproveBlockedReason = "EXEC_DISTANCE_BLOCK";
  } else if (proposalImprovesCurrentStop && !shouldMoveSL) {
    stopImproveBlockedReason = "NO_MEANINGFUL_IMPROVEMENT";
  }
  if (!stopImproveAuthorized) {
    finalStopLoss = null;
  }
  const peakR = Number.isFinite(metrics.protectedPeakR) ? metrics.protectedPeakR : metrics.peakR;
  const hardGivebackArmedAtIso =
    hardGiveback.armedAt instanceof Date
      ? hardGiveback.armedAt.toISOString()
      : null;
  const protectionGateOpen = Boolean(
    preliminaryProtectionGateOpen ||
      earlyWinner.earlyWinnerConfirmed ||
      earlyWinner.earlyWinnerActive,
  );
  winnerModeActive = Boolean(protectionGateOpen);
  const trailActive = Boolean(
    plan?.meta?.trailActive ||
      tradePatch?.trailActive ||
      trade?.trailActive ||
      arbitrationWinner === "TRAIL" ||
      arbitrationWinner === "STRUCTURE_TRAIL" ||
      structureTrailAllowed,
  );
  const protectedInr = unrealizedPnlInr({ side, entry, ltp: desiredStopLoss, qty: metrics.qty });
  const protectedR = pnlInrToR(protectedInr, metrics.riskInr);
  const candidateFloorsTelemetry = candidateFloors.map((candidate) => ({
    source: candidate.source,
    price: candidate.price,
    eligible: candidate.eligible,
    rejectedReason: candidate.rejectedReason,
    phase: candidate.phase,
    details: candidate.details,
  }));
  const rejectedFloorReasonsMap = rejectedFloorReasons(candidateFloors);
  const handoffState = !earlyWinner.enabled
    ? "DISABLED"
    : earlyWinner.earlyWinnerHandoffReady
      ? "READY"
      : `DEFERRED:${String(
          earlyWinner.trailDeferredReason || "WAITING_CONFIRMATION",
        ).toUpperCase()}`;

  patchIfChanged(tradePatch, trade, "peakR", peakR, 0.001);
  patchIfChanged(tradePatch, trade, "beEligible", beEligible);
  patchIfChanged(tradePatch, trade, "beLockHit", beArmed);
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerEligible",
    earlyWinner.earlyWinnerEligible,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerArmed",
    earlyWinner.earlyWinnerArmed,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerConfirmed",
    earlyWinner.earlyWinnerConfirmed,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerArmAt",
    earlyWinner.earlyWinnerArmAt,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerConfirmedAt",
    earlyWinner.earlyWinnerConfirmedAt,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerConfirmTicks",
    earlyWinner.earlyWinnerConfirmTicks,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerConfirmMs",
    earlyWinner.earlyWinnerConfirmMs,
    1,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerTier",
    earlyWinner.earlyWinnerTier,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerKeepR",
    earlyWinner.earlyWinnerKeepR,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerFloorPrice",
    earlyWinner.earlyWinnerFloor,
    tick / 2,
  );
  patchField(
    tradePatch,
    trade,
    "earlyWinnerFloorSource",
    earlyWinner.earlyWinnerFloorSource ?? null,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerActive",
    earlyWinner.earlyWinnerActive,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerMfeLockActive",
    earlyWinner.earlyWinnerMfeLockActive,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "earlyWinnerHandoffReady",
    earlyWinner.earlyWinnerHandoffReady,
  );
  patchField(
    tradePatch,
    trade,
    "dynamicTrailArmR",
    earlyWinner.dynamicTrailArmR,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "handoffMaturity",
    earlyWinner.handoffMaturity,
  );
  patchField(
    tradePatch,
    trade,
    "protectionPhase",
    earlyWinner.protectionPhase,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "structureCandidateAvailable",
    earlyWinner.structureCandidateAvailable,
  );
  patchField(
    tradePatch,
    trade,
    "structureReferenceType",
    earlyWinner.structureReferenceType ?? null,
  );
  patchField(
    tradePatch,
    trade,
    "structureReferencePrice",
    earlyWinner.structureReferencePrice,
    tick / 2,
  );
  patchField(
    tradePatch,
    trade,
    "structureMappedFloor",
    earlyWinner.structureMappedFloor,
    tick / 2,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "trailHit",
    Boolean(plan?.meta?.trailHit ?? trade?.trailHit),
  );
  patchIfChanged(tradePatch, trade, "profitLockArmed", profitLockArmed);
  patchIfChanged(tradePatch, trade, "trueBePrice", trueBePrice, tick / 2);
  patchIfChanged(tradePatch, trade, "costGreenFloorInr", costGreenFloorInr, 1);
  patchIfChanged(tradePatch, trade, "costGreenFloorPrice", costGreenFloorPrice, tick / 2);
  patchIfChanged(tradePatch, trade, "greenLockActive", greenLockActive);
  patchIfChanged(tradePatch, trade, "greenLockFloorPrice", greenLockFloorPrice, tick / 2);
  patchIfChanged(tradePatch, trade, "mfeLockTier", mfeLockTier);
  patchField(tradePatch, trade, "mfeLockFloorR", mfeLockFloorR, 0.001);
  patchField(tradePatch, trade, "mfeLockFloorPrice", mfeLockFloorPrice, tick / 2);
  patchIfChanged(tradePatch, trade, "tightenActive", tightenActive);
  patchField(tradePatch, trade, "tightenActivatedAtR", tightenActivatedAtR, 0.001);
  patchField(tradePatch, trade, "post1RTrailGapR", post1RTrailGapR, 0.001);
  patchField(
    tradePatch,
    trade,
    "post1RTrailFloorPrice",
    post1RTrailFloorPrice,
    tick / 2,
  );
  patchIfChanged(tradePatch, trade, "hardGivebackExitArmed", hardGiveback.armed);
  patchField(tradePatch, trade, "hardGivebackRule", hardGiveback.rule);
  patchField(
    tradePatch,
    trade,
    "hardGivebackThresholdR",
    hardGiveback.thresholdR,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "hardGivebackThresholdPct",
    hardGiveback.thresholdPct,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "hardGivebackConfirmTicks",
    hardGiveback.armed ? hardGiveback.confirmTicks : 0,
  );
  patchField(
    tradePatch,
    trade,
    "givebackConfirmMs",
    hardGiveback.armed ? hardGiveback.givebackConfirmMs : 0,
    1,
  );
  patchField(
    tradePatch,
    trade,
    "hardGivebackArmedAt",
    hardGiveback.armed ? hardGiveback.armedAt : null,
  );
  patchIfChanged(tradePatch, trade, "trailActive", trailActive);
  patchIfChanged(tradePatch, trade, "givebackActive", givebackActive);
  patchField(
    tradePatch,
    trade,
    "loserCompressionDesiredAction",
    loserCompression.desiredAction,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionTargetState",
    loserCompression.tradePatch?.loserCompressionTargetState,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionSubmittedState",
    loserCompression.tradePatch?.loserCompressionSubmittedState,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionAppliedState",
    loserCompression.tradePatch?.loserCompressionAppliedState,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionPendingAction",
    loserCompression.tradePatch?.loserCompressionPendingAction,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionPendingSince",
    loserCompression.tradePatch?.loserCompressionPendingSince,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastRequestedStop",
    loserCompression.tradePatch?.loserCompressionLastRequestedStop,
    tick / 2,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastConfirmedStop",
    loserCompression.tradePatch?.loserCompressionLastConfirmedStop,
    tick / 2,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastAttemptAt",
    loserCompression.tradePatch?.loserCompressionLastAttemptAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastConfirmedAt",
    loserCompression.tradePatch?.loserCompressionLastConfirmedAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionAppliedSource",
    loserCompression.tradePatch?.loserCompressionAppliedSource,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionAppliedConfirmed",
    loserCompression.tradePatch?.loserCompressionAppliedConfirmed,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionAttributionConfidence",
    loserCompression.tradePatch?.loserCompressionAttributionConfidence,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionRetryCount",
    loserCompression.tradePatch?.loserCompressionRetryCount,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionState",
    loserCompression.tradePatch?.loserCompressionState,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastActionAt",
    loserCompression.tradePatch?.loserCompressionLastActionAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionActivatedAt",
    loserCompression.tradePatch?.loserCompressionActivatedAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionEscalatedAt",
    loserCompression.tradePatch?.loserCompressionEscalatedAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionScoreAtLastAction",
    loserCompression.tradePatch?.loserCompressionScoreAtLastAction,
    0.001,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionReasonAtLastAction",
    loserCompression.tradePatch?.loserCompressionReasonAtLastAction,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionBlockedReason",
    loserCompression.tradePatch?.loserCompressionBlockedReason,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionLastAction",
    loserCompression.tradePatch?.loserCompressionLastAction,
  );
  patchField(
    tradePatch,
    trade,
    "loserCompressionTriggeredAt",
    loserCompression.tradePatch?.loserCompressionTriggeredAt,
  );
  patchField(
    tradePatch,
    trade,
    "loserExitTriggered",
    loserCompression.tradePatch?.loserExitTriggered,
  );
  patchField(
    tradePatch,
    trade,
    "loserExitReasonCode",
    loserCompression.tradePatch?.loserExitReasonCode,
  );
  patchField(
    tradePatch,
    trade,
    "telemetryProposalFloor",
    normalizedTelemetryProposalFloor,
    tick / 2,
  );
  patchField(
    tradePatch,
    trade,
    "executableHardFloor",
    executableHardFloor,
    tick / 2,
  );
  patchField(tradePatch, trade, "desiredStopLoss", desiredStopLoss, tick / 2);
  patchField(tradePatch, trade, "finalStopLoss", finalStopLoss, tick / 2);
  patchField(tradePatch, trade, "hardFloor", executableHardFloor, tick / 2);
  patchField(
    tradePatch,
    trade,
    "protectedStopSource",
    protectedStopSource,
  );
  patchField(
    tradePatch,
    trade,
    "structureTrailFloor",
    structureTrailFloor,
    tick / 2,
  );
  patchField(tradePatch, trade, "structureTrailSource", trail.source ?? null);
  patchIfChanged(
    tradePatch,
    trade,
    "structureTrailAllowed",
    structureTrailAllowed,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "protectionGateOpen",
    protectionGateOpen,
  );
  patchIfChanged(
    tradePatch,
    trade,
    "winnerModeActive",
    winnerModeActive,
  );
  patchField(tradePatch, trade, "exitFamily", exitLifecycle?.exitFamily ?? null);
  patchField(tradePatch, trade, "exitReasonCode", exitLifecycle?.exitReasonCode ?? null);
  patchField(tradePatch, trade, "exitAuthority", exitAuthority);
  patchIfChanged(
    tradePatch,
    trade,
    "stopImproveAuthorized",
    stopImproveAuthorized,
  );
  patchField(
    tradePatch,
    trade,
    "stopImproveBlockedReason",
    stopImproveBlockedReason,
  );
  patchField(
    tradePatch,
    trade,
    "shouldExitNowReason",
    shouldExitNowReason,
  );
  patchIfChanged(tradePatch, trade, "lastProtectedInr", protectedInr, 1);
  patchIfChanged(tradePatch, trade, "lastProtectedR", protectedR, 0.001);
  patchIfChanged(
    tradePatch,
    trade,
    "lastExitPlanReason",
    joinReasons(action?.exitNow ? [...reasons, action.reason] : reasons),
  );
  const protectionStateTouched = [
    "earlyWinnerEligible",
    "earlyWinnerArmed",
    "earlyWinnerConfirmed",
    "earlyWinnerArmAt",
    "earlyWinnerConfirmedAt",
    "earlyWinnerConfirmTicks",
    "earlyWinnerConfirmMs",
    "earlyWinnerTier",
    "earlyWinnerKeepR",
    "earlyWinnerFloorPrice",
    "earlyWinnerFloorSource",
    "earlyWinnerActive",
    "earlyWinnerMfeLockActive",
    "earlyWinnerHandoffReady",
    "dynamicTrailArmR",
    "handoffMaturity",
    "protectionPhase",
    "structureCandidateAvailable",
    "structureReferenceType",
    "structureReferencePrice",
    "structureMappedFloor",
    "protectedStopSource",
    "desiredStopLoss",
    "finalStopLoss",
  ].some((key) => Object.prototype.hasOwnProperty.call(tradePatch, key));
  const protectionStateVersion = Math.max(
    PROTECTION_STATE_VERSION,
    Number(trade?.protectionStateVersion ?? 0) +
      (protectionStateTouched ? 1 : 0),
  );
  patchField(
    tradePatch,
    trade,
    "protectionStateVersion",
    protectionStateVersion,
  );

  return {
    ...plan,
    action,
    sl:
      shouldMoveSL && stopImproveAuthorized && Number.isFinite(finalStopLoss)
        ? { stopLoss: finalStopLoss }
        : null,
    tradePatch,
    hardFloor: executableHardFloor,
    telemetryProposalFloor: normalizedTelemetryProposalFloor,
    executableHardFloor,
    stopImproveAuthorized,
    stopImproveBlockedReason,
    finalStop: Number.isFinite(finalStopLoss) ? finalStopLoss : desiredStopLoss,
    trueBePrice,
    costGreenFloorPrice,
    greenLockActive,
    earlyWinnerTier: earlyWinner.earlyWinnerTier,
    earlyWinnerFloor: earlyWinner.earlyWinnerFloor,
    earlyWinnerFloorSource: earlyWinner.earlyWinnerFloorSource,
    earlyWinnerKeepR: earlyWinner.earlyWinnerKeepR,
    earlyWinnerConfirmed: earlyWinner.earlyWinnerConfirmed,
    earlyWinnerBaseFloor: earlyWinner.baseProtectionFloor,
    dynamicTrailArmR: earlyWinner.dynamicTrailArmR,
    handoffMaturity: earlyWinner.handoffMaturity,
    protectionPhase: earlyWinner.protectionPhase,
    arbitrationWinner,
    mfeLockTier,
    mfeLockFloorR,
    mfeLockFloorPrice,
    tightenActive,
    tightenActivatedAtR,
    post1RTrailGapR,
    givebackR,
    givebackPct,
    protectionStateVersion,
    shouldTighten,
    shouldExitNow: Boolean(action?.exitNow),
    shouldExitNowReason,
    reason: joinReasons(action?.exitNow ? [...reasons, action.reason] : reasons),
    meta: {
      ...(plan?.meta || {}),
      currentExecutablePrice: metrics.currentExecutablePrice,
      currentExecutablePnlInr: metrics.currentExecutablePnlInr,
      currentExecutableR: metrics.currentExecutableR,
      executionRiskInr: metrics.riskInr,
      executionRiskPts: metrics.executionRiskPts,
      executionRiskQty: metrics.executionRiskQty,
      executionRiskSource: metrics.executionRiskSource,
      budgetRiskInr: metrics.budgetRiskInr,
      peakExecutablePnlInr: metrics.peakExecutablePnlInr,
      peakExecutableR: metrics.peakExecutableR,
      peakR,
      protectedPeakR: metrics.protectedPeakR,
      protectedCurrentR: metrics.protectedCurrentR,
      quoteQuality: metrics.quoteQuality,
      quoteFreshnessMs: metrics.quoteFreshnessMs,
      executablePriceSource: metrics.executablePriceSource,
      executablePriceConfidence: metrics.executablePriceConfidence,
      protectionPhase: earlyWinner.protectionPhase,
      protectionPhaseNumber: earlyWinner.protectionPhaseNumber,
      beEligible,
      beLockHit: beArmed,
      trailHit: Boolean(plan?.meta?.trailHit),
      earlyWinnerEligible: earlyWinner.earlyWinnerEligible,
      earlyWinnerArmed: earlyWinner.earlyWinnerArmed,
      earlyWinnerConfirmed: earlyWinner.earlyWinnerConfirmed,
      earlyWinnerTier: earlyWinner.earlyWinnerTier,
      earlyWinnerFloor: earlyWinner.earlyWinnerFloor,
      earlyWinnerFloorSource: earlyWinner.earlyWinnerFloorSource,
      earlyWinnerKeepR: earlyWinner.earlyWinnerKeepR,
      earlyWinnerMfeLockMode: earlyWinner.mfeLockMode,
      earlyWinnerBaseFloor: earlyWinner.baseProtectionFloor,
      earlyWinnerBaseProtectedR: earlyWinner.baseProtectedR,
      earlyWinnerActive: earlyWinner.earlyWinnerActive,
      earlyWinnerMfeLockActive: earlyWinner.earlyWinnerMfeLockActive,
      earlyWinnerHandoffReady: earlyWinner.earlyWinnerHandoffReady,
      dynamicTrailArmR: earlyWinner.dynamicTrailArmR,
      dynamicTrailArmReason: earlyWinner.dynamicTrailArmReason,
      handoffQualityScore: earlyWinner.handoffQualityScore,
      handoffMaturity: earlyWinner.handoffMaturity,
      handoffAdvanceReason: earlyWinner.handoffAdvanceReason,
      handoffDeferredReason: earlyWinner.handoffDeferredReason,
      handoffStateStable: earlyWinner.handoffStateStable,
      handoffHysteresisActive: earlyWinner.handoffHysteresisActive,
      profitLockArmed,
      costGreenFloorInr,
      costGreenFloorPrice,
      greenLockFloorPrice,
      mfeLockFloorR,
      mfeLockFloorPrice,
      mfeLockTier,
      tightenActive,
      tightenActivatedAtR,
      tightenSuppressedByWeakRegime,
      tightenMarketRegime,
      post1RTrailGapR,
      post1RTrailFloorPrice,
      loserCompressionEligible: loserCompression.eligible,
      loserCompressionActive: loserCompression.loserCompressionActive,
      loserCompressionAction: loserCompression.action,
      loserCompressionDesiredAction: loserCompression.desiredAction,
      loserCompressionReason: loserCompression.reason,
      loserCompressionAuthority: loserCompression.authority,
      loserCompressionLevel: loserCompression.level,
      loserCompressionTargetState: loserCompression.targetState,
      loserCompressionSubmittedState: loserCompression.submittedState,
      loserCompressionAppliedState: loserCompression.appliedState,
      loserCompressionPendingAction: loserCompression.pendingAction,
      loserCompressionPendingSince: loserCompression.pendingSince,
      loserCompressionRetryCount: loserCompression.retryCount,
      loserCompressionLastRequestedStop: loserCompression.lastRequestedStop,
      loserCompressionLastConfirmedStop: loserCompression.lastConfirmedStop,
      loserCompressionLastAttemptAt: loserCompression.lastAttemptAt,
      loserCompressionLastConfirmedAt: loserCompression.lastConfirmedAt,
      loserCompressionAppliedSource: loserCompression.appliedSource,
      loserCompressionRequestOutcome: loserCompression.requestOutcome,
      loserCompressionAppliedConfirmed: loserCompression.appliedConfirmed,
      loserCompressionAttributionConfidence:
        loserCompression.attributionConfidence,
      loserCompressionSuperseded: loserCompression.superseded,
      loserCompressionSupersedeReason: loserCompression.supersedeReason,
      loserCompressionRequestReady: loserCompression.requestReady,
      loserCompressionRequestBlockedReason:
        loserCompression.requestBlockedReason,
      loserCompressionProposedStop: loserCompression.proposedStop,
      loserCompressionFinalStop:
        loserCompression.loserCompressionActive &&
        Number.isFinite(finalStopLoss)
          ? finalStopLoss
          : loserCompression.finalStop,
      loserCompressionBlockedReason: loserCompression.blockedReason,
      loserCompressionTriggeredAt: loserCompression.triggeredAt,
      loserCompressionEscalated: loserCompression.escalated,
      loserCompressionFinalProtectionOwner:
        loserCompression.finalProtectionOwner,
      loserExitTriggered:
        loserCompression.exitNow && action?.reason === loserCompression.reason,
      loserExitReasonCode: loserCompression.exitReasonCode,
      failureScore: loserCompression.failure?.score ?? null,
      failureScoreBreakdown: loserCompression.failure?.breakdown ?? null,
      failureWeakFollowThroughScore:
        loserCompression.failure?.breakdown?.weakFollowThrough ?? null,
      failureAdverseProgressionScore:
        loserCompression.failure?.breakdown?.adverseProgression ?? null,
      failureStructureScore:
        loserCompression.failure?.breakdown?.structure ?? null,
      failureUnderlyingScore:
        loserCompression.failure?.breakdown?.underlying ?? null,
      failureMicrostructureScore:
        loserCompression.failure?.breakdown?.microstructure ?? null,
      failureStructureBroken:
        loserCompression.failure?.structureBroken ?? false,
      failureStructureReasonCode:
        loserCompression.failure?.structureReasonCode ?? null,
      failureUnderlyingBroken:
        loserCompression.failure?.underlyingBroken ?? false,
      failureGracePassed: loserCompression.failure?.gracePassed ?? false,
      failureMfeR: loserCompression.failure?.mfeR ?? null,
      failureAdverseR: loserCompression.failure?.adverseR ?? null,
      failureStructureReferenceSource:
        loserCompression.failure?.structureReferenceSource ?? null,
      failureMicrostructureBreakdown:
        loserCompression.failure?.microstructureBreakdown ?? null,
      microstructureSpreadScore:
        loserCompression.failure?.microstructureBreakdown?.spreadScore ?? null,
      microstructureTrendScore:
        loserCompression.failure?.microstructureBreakdown?.trendScore ?? null,
      microstructureConfidenceScore:
        loserCompression.failure?.microstructureBreakdown?.confidenceScore ??
        null,
      microstructureFreshnessScore:
        loserCompression.failure?.microstructureBreakdown?.freshnessScore ??
        null,
      microstructureDepthScore:
        loserCompression.failure?.microstructureBreakdown?.depthScore ?? null,
      microstructureImbalanceScore:
        loserCompression.failure?.microstructureBreakdown?.imbalanceScore ??
        null,
      microstructureTotal:
        loserCompression.failure?.microstructureBreakdown?.total ?? null,
      alcRequested: loserCompression.requested,
      alcRequestedLevel: loserCompression.requestedLevel,
      alcAppliedLevel: loserCompression.appliedLevel,
      alcAppliedSource: loserCompression.appliedSource,
      alcAttributionConfidence: loserCompression.attributionConfidence,
      alcRequestedButNotApplied: loserCompression.requestedButNotApplied,
      alcAppliedButSuperseded: loserCompression.appliedButSuperseded,
      alcSupersededBy: loserCompression.supersededBy,
      alcFinalProtectionOwner: loserCompression.finalProtectionOwner,
      alcSavedRiskR: loserCompression.savedRiskR ?? null,
      alcSavedRiskInr: loserCompression.savedRiskInr ?? null,
      givebackR,
      givebackPct,
      trailActive,
      givebackActive,
      hardGivebackExitArmed: hardGiveback.armed,
      hardGivebackRule: hardGiveback.rule,
      hardGivebackThresholdR: hardGiveback.thresholdR,
      hardGivebackThresholdPct: hardGiveback.thresholdPct,
      hardGivebackConfirmTicks: hardGiveback.confirmTicks,
      hardGivebackConfirmTarget: hardGiveback.confirmTicksTarget,
      givebackConfirmMs: hardGiveback.givebackConfirmMs,
      hardGivebackArmedAt: hardGivebackArmedAtIso,
      exitFamily: exitLifecycle?.exitFamily ?? null,
      exitReasonCode: exitLifecycle?.exitReasonCode ?? null,
      exitAuthority,
      shouldExitNowReason,
      protectedStopSource,
      arbitrationWinner,
      arbitrationWinnerReason,
      candidateFloors: candidateFloorsTelemetry,
      rejectedFloorReasons: rejectedFloorReasonsMap,
      floorPersistenceState: earlyWinner.floorPersistenceState,
      beFirstTouchDetected: earlyWinner.beFirstTouchDetected,
      beConfirmationProgress: earlyWinner.confirmationProgress,
      handoffState,
      trailDeferredReason: earlyWinner.trailDeferredReason,
      earlyWinnerStructureEnabled: earlyWinner.structureEnabled,
      earlyWinnerStructureStatus: earlyWinner.structureStatus,
      structureCandidateAvailable: earlyWinner.structureCandidateAvailable,
      structureCandidateReason:
        earlyWinnerStructure.candidateReason ?? null,
      structureReferenceType: earlyWinner.structureReferenceType,
      structureReferencePrice: earlyWinner.structureReferencePrice,
      structureMappedFloor: earlyWinner.structureMappedFloor,
      structureBufferApplied: earlyWinner.structureBufferApplied ?? null,
      structureRejectedReason: earlyWinner.structureRejectedReason ?? null,
      structureWonArbitration: arbitrationWinner === "EARLY_WINNER_STRUCTURE",
      structureFallbackUsed: earlyWinner.structureFallbackUsed,
      protectionStateVersion,
      telemetryProposalFloor: normalizedTelemetryProposalFloor,
      executableHardFloor,
      hardFloor: executableHardFloor,
      desiredStopLoss,
      finalStopLoss,
      stopImproveAuthorized,
      stopImproveBlockedReason,
      structureTrailAllowed,
      protectionGateOpen,
      winnerModeActive,
      holdMs,
      holdOk,
      currentSpreadBps,
      spreadOk,
      spreadGuardBypassed,
      execDistanceTicks,
      distanceOk,
      distanceGuardBypassed,
      protectionSafetyUpgrade,
      optionalTrailUpgrade,
      protectionSafetyFloor,
      structureTrailFloor,
      structureTrailSource: trail.source,
      optionUnderlyingConfirmed: trail.confirmed,
      lastProtectedInr: protectedInr,
      lastProtectedR: protectedR,
      shadowExitActive,
      reasonTags: reasons,
    },
  };
}

module.exports = { enrichDynamicExitPlan };
