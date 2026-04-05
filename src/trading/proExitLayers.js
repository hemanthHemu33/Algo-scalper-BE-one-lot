const { roundToTick } = require("./priceUtils");
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

function buildWinnerMfeTiers(env) {
  return [
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
  ]
    .filter((tier) => Number.isFinite(tier.atR))
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
  const beProtectionLive = Boolean(beApplied && Number.isFinite(beFloor));
  const trailProtectionLive = Boolean(trailAllowed);
  const protectionGateOpen =
    beProtectionLive ||
    trailProtectionLive ||
    greenLockActive ||
    profitLockArmed ||
    (Number.isFinite(mfeLockTier) && mfeLockTier > 0) ||
    tightenActive ||
    hardGiveback.armed ||
    emergencyProtection ||
    shadowExitActive ||
    tp1RunnerActive;
  const winnerModeActive = Boolean(protectionGateOpen);
  const basePlanDesiredStopLoss = bestStop(
    side,
    n(plan?.meta?.desiredStopLoss, NaN),
    n(plan?.meta?.newSL, NaN),
  );
  const protectedStopSource = plan?.meta?.protectedStopSource ?? null;
  const beFloorActive = beArmed && Number.isFinite(beFloor);
  const greenLockFloorActive =
    greenLockActive && Number.isFinite(greenLockFloorPrice);
  const mfeLockActive = Boolean(mfeLock.active && Number.isFinite(mfeLockFloorPrice));
  const tightenFloorActive =
    tightenActive && Number.isFinite(post1RTrailFloorPrice);
  const protectionSafetyFloor = bestStop(
    side,
    isProtectionSafetySource(protectedStopSource) ? basePlanDesiredStopLoss : null,
    beFloorActive ? beFloor : null,
    greenLockFloorActive ? greenLockFloorPrice : null,
    n(plan?.meta?.beProfitLockFloor, NaN),
    n(plan?.meta?.profitLockFloor, NaN),
  );
  const baseWinnerFloorAuthorized =
    Number.isFinite(basePlanDesiredStopLoss) &&
    Boolean(
      beProtectionLive ||
        trailProtectionLive ||
        profitLockArmed ||
        greenLockFloorActive ||
        mfeLockActive ||
        tightenFloorActive,
    )
      ? basePlanDesiredStopLoss
      : null;
  const telemetryProposalFloor = bestStop(
    side,
    curSL,
    sl0,
    basePlanDesiredStopLoss,
    beFloor,
    greenLockFloorPrice,
    mfeLockFloorPrice,
    post1RTrailFloorPrice,
  );
  const executableHardFloor = bestStop(
    side,
    curSL,
    sl0,
    baseWinnerFloorAuthorized,
    beFloorActive ? beFloor : null,
    greenLockFloorActive ? greenLockFloorPrice : null,
    mfeLockActive ? mfeLockFloorPrice : null,
    tightenFloorActive ? post1RTrailFloorPrice : null,
  );
  const trail = structureFloor({
    trade,
    plan,
    hardFloor: executableHardFloor,
    side,
    underlyingLtp,
    env,
    allowAggressiveTighten: protectionGateOpen,
  });
  const structureTrailAllowed = Boolean(
    trail.source && trail.source !== "GATED" && Number.isFinite(trail.floor),
  );
  const telemetryStopProposal = bestStop(
    side,
    telemetryProposalFloor,
    trail.proposalFloor,
  );
  let desiredStopLoss = bestStop(side, executableHardFloor, trail.floor);
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
    trail.floor,
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
  const forceMove =
    bePriorityForce ||
    Boolean(trade?.shadowExitActive) ||
    mfeLock.upgraded ||
    tighten.newlyActivated ||
    (!trade?.greenLockActive && greenLockActive);
  const action = plan?.action?.exitNow
    ? plan.action
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
  ].includes(String(exitAuthority || "").toUpperCase());
  const safePreBeStopCompressionEnabled =
    env.DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION === true;
  let stopImproveAuthorized = Boolean(
    bePriorityPending ||
      beProtectionLive ||
      trailProtectionLive ||
      greenLockFloorActive ||
      profitLockArmed ||
      mfeLockActive ||
      tightenActive ||
      hardGiveback.armed ||
      emergencyProtection ||
      shadowExitActive ||
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
  if (greenLockActive && Number.isFinite(greenLockFloorPrice)) reasons.push("GREEN_LOCK");
  if (mfeLockTier > 0 && Number.isFinite(mfeLockFloorPrice)) reasons.push(`MFE_LOCK_T${mfeLockTier}`);
  if (mfeLock.upgraded) reasons.push("MFE_LOCK_TIER_UPGRADE");
  if (tightenActive) reasons.push("POST_1R_TIGHTEN_ACTIVE");
  if (hardGiveback.armed) reasons.push("HARD_GIVEBACK_EXIT_ARMED");
  if (hardGiveback.confirmed) reasons.push("HARD_GIVEBACK_EXIT_TRIGGERED");
  if (protectionSafetyUpgrade) reasons.push("PROTECTION_SAFETY_UPGRADE");
  if (optionalTrailUpgrade) reasons.push("OPTIONAL_TRAIL_UPGRADE");
  if (structureTrailAllowed) reasons.push("STRUCTURE_TRAIL");
  if (trail.source === "GATED") reasons.push("STRUCTURE_TRAIL_GATED");
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
  const trailActive = Boolean(
    trailProtectionLive &&
      (
        plan?.meta?.trailActive ||
        tradePatch?.trailActive ||
        trade?.trailActive ||
        structureTrailAllowed
      ),
  );
  const protectedInr = unrealizedPnlInr({ side, entry, ltp: desiredStopLoss, qty: metrics.qty });
  const protectedR = pnlInrToR(protectedInr, metrics.riskInr);

  patchIfChanged(tradePatch, trade, "peakR", peakR, 0.001);
  patchIfChanged(tradePatch, trade, "beEligible", beEligible);
  patchIfChanged(tradePatch, trade, "beLockHit", beArmed);
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
  patchField(tradePatch, trade, "structureTrailFloor", trail.floor, tick / 2);
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
    mfeLockTier,
    mfeLockFloorR,
    mfeLockFloorPrice,
    tightenActive,
    tightenActivatedAtR,
    post1RTrailGapR,
    givebackR,
    givebackPct,
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
      beEligible,
      beLockHit: beArmed,
      trailHit: Boolean(plan?.meta?.trailHit),
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
      structureTrailFloor: trail.floor,
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
