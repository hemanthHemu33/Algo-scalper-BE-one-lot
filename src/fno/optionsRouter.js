const { DateTime } = require("luxon");
const { env } = require("../config");
const { normalizeTickSize } = require("../utils/tickSize");
const { logger } = require("../logger");
const {
  isQuoteGuardBreakerOpen,
  getQuoteGuardStats,
} = require("../kite/quoteGuard");
const {
  getInstrumentsDump,
  parseCsvList,
  uniq,
} = require("../instruments/instrumentRepo");
const { pickBestExpiryISO } = require("./expiryPolicy");
const {
  getOptionChainSnapshot,
  setLastOptionPick,
} = require("./optionChainCache");

function optionTz() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function expiryDateTime(v, tz = optionTz()) {
  if (!v) return null;

  if (DateTime.isDateTime(v)) {
    return v.isValid ? v.setZone(tz) : null;
  }

  if (v instanceof Date) {
    const dt = DateTime.fromJSDate(v, { zone: tz });
    return dt.isValid ? dt : null;
  }

  if (typeof v === "number") {
    const dt = DateTime.fromMillis(v, { zone: tz });
    return dt.isValid ? dt : null;
  }

  const raw = String(v || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dt = DateTime.fromISO(raw, { zone: tz });
    return dt.isValid ? dt : null;
  }

  const dt = DateTime.fromISO(raw, { setZone: true });
  if (dt.isValid) return dt.setZone(tz);

  const fallback = new Date(raw);
  if (Number.isNaN(fallback.getTime())) return null;
  const fdt = DateTime.fromJSDate(fallback, { zone: tz });
  return fdt.isValid ? fdt : null;
}

function expiryISOInTz(v, tz = optionTz()) {
  const dt = expiryDateTime(v, tz);
  return dt ? dt.toFormat("yyyy-LL-dd") : null;
}

function todayDate(nowMs = Date.now()) {
  return DateTime.fromMillis(Number(nowMs)).setZone(optionTz()).startOf("day");
}

function _dteDays(expiryISO, nowMs = Date.now()) {
  const tz = optionTz();
  const e = String(expiryISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return null;
  const exp = DateTime.fromISO(e, { zone: tz }).set({
    hour: 15,
    minute: 30,
    second: 0,
    millisecond: 0,
  });
  if (!exp.isValid) return null;
  const now = DateTime.fromMillis(Number(nowMs)).setZone(tz);
  const hours = exp.diff(now, "hours").hours;
  if (!Number.isFinite(hours)) return null;
  return hours / 24;
}

function roundToStep(price, step) {
  const s = Number(step ?? 1);
  if (!Number.isFinite(s) || s <= 0) return Math.round(price);
  return Math.round(Number(price) / s) * s;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function strikeStepFallback(underlying) {
  const u = String(underlying || "").toUpperCase();
  if (u === "NIFTY") return Number(env.OPT_STRIKE_STEP_NIFTY ?? 50);
  if (u === "BANKNIFTY") return Number(env.OPT_STRIKE_STEP_BANKNIFTY ?? 100);
  if (u === "SENSEX") return Number(env.OPT_STRIKE_STEP_SENSEX ?? 100);
  return 50;
}

const INDEX_TO_CHAIN = {
  "NIFTY 50": "NIFTY",
  "NIFTY BANK": "BANKNIFTY",
  "NIFTY FIN SERVICE": "FINNIFTY",
  "NIFTY MID SELECT": "MIDCPNIFTY",
};

function chainRootFromSpot(tradingsymbol) {
  const sym = String(tradingsymbol || "").toUpperCase().trim();
  return INDEX_TO_CHAIN[sym] || sym;
}

function getPremiumBandForUnderlying(underlying) {
  const u = String(underlying || "").toUpperCase();
  if (u === "NIFTY") {
    const minPrem = Number(
      env.OPT_MIN_PREMIUM_NIFTY ?? env.OPT_MIN_PREMIUM ?? 80,
    );
    const maxPrem = Number(
      env.OPT_MAX_PREMIUM_NIFTY ?? env.OPT_MAX_PREMIUM ?? 350,
    );
    const enforce = Boolean(env.OPT_PREMIUM_BAND_ENFORCE_NIFTY ?? true);
    return { minPrem, maxPrem, enforce };
  }
  // fallback for other underlyings
  return {
    minPrem: Number(env.OPT_MIN_PREMIUM ?? 20),
    maxPrem: Number(env.OPT_MAX_PREMIUM ?? 600),
    enforce: false,
  };
}

function buildCandidateOffsets(radius) {
  const r = Math.max(0, Number(radius ?? 2));
  const offsets = [0];
  for (let i = 1; i <= r; i++) offsets.push(i, -i);
  return offsets;
}

function resolveUnderlyingFromUniverse({ universe, token, tradingsymbol }) {
  const uni = universe?.universe;
  if (!uni?.contracts) return null;
  const t = Number(token);
  const want = chainRootFromSpot(tradingsymbol);
  for (const [u, c] of Object.entries(uni.contracts)) {
    if (Number(c.instrument_token) === t) return u;
    const cSym = chainRootFromSpot(c?.tradingsymbol);
    const cName = chainRootFromSpot(c?.name);
    if (want && (cSym === want || cName === want || String(u).toUpperCase() === want))
      return u;
  }
  return null;
}

async function buildOptionSubscriptionCandidates({
  kite,
  universe,
  underlyingToken,
  underlyingTradingsymbol,
  underlyingLtp,
  nowMs = Date.now(),
}) {
  const u = resolveUnderlyingFromUniverse({
    universe,
    token: underlyingToken,
    tradingsymbol: underlyingTradingsymbol,
  });
  const underlying = String(u || "").toUpperCase();
  if (!underlying) return [];

  const exchanges = uniq(parseCsvList(env.FNO_EXCHANGES || "NFO,BFO"));
  const optionRows = [];
  for (const ex of exchanges) {
    const rows = await getInstrumentsDump(kite, ex);
    for (const r of rows || []) {
      const name = chainRootFromSpot(r.name);
      const it = String(r.instrument_type || "").toUpperCase();
      if (name !== underlying) continue;
      if (it !== "CE" && it !== "PE") continue;
      optionRows.push({ ...r, exchange: r.exchange || ex });
    }
  }
  if (!optionRows.length) return [];

  const expiryISO = pickBestExpiryISO({
    expiries: optionRows
      .map((r) => expiryISOInTz(r.expiry))
      .filter(Boolean),
    env,
    nowMs,
  })?.expiryISO || pickNearestExpiryISO(optionRows, nowMs);

  const slice = optionRows.filter(
    (r) => expiryISOInTz(r.expiry) === expiryISO,
  );
  if (!slice.length) return [];

  const step = detectStrikeStepFromRows(slice, strikeStepFallback(underlying));
  const atm = roundToStep(Number(underlyingLtp), step);
  const radius = Math.max(0, Number(env.OPT_ATM_SCAN_STEPS ?? 2));
  const picks = [];
  for (const offset of buildCandidateOffsets(radius)) {
    const strike = atm + offset * step;
    for (const optType of ["CE", "PE"]) {
      const row = slice.find(
        (r) =>
          String(r.instrument_type || "").toUpperCase() === optType &&
          Number(r.strike) === Number(strike),
      );
      if (row?.instrument_token) picks.push(Number(row.instrument_token));
    }
  }
  return Array.from(new Set(picks));
}

function detectStrikeStepFromRows(rows, fallbackStep) {
  // Detect common strike spacing for a specific expiry slice.
  const strikes = Array.from(
    new Set(
      (rows || [])
        .map((r) => Number(r.strike))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ).sort((a, b) => a - b);

  if (strikes.length < 5) return fallbackStep;

  const diffs = [];
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.round((strikes[i] - strikes[i - 1]) * 1000) / 1000;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return fallbackStep;

  // Mode of diffs
  const freq = new Map();
  for (const d of diffs) {
    const k = String(d);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  let best = null;
  let bestC = -1;
  for (const [k, c] of freq.entries()) {
    if (c > bestC) {
      bestC = c;
      best = Number(k);
    }
  }

  const step = Number(best);
  if (Number.isFinite(step) && step > 0) return step;
  return fallbackStep;
}

function pickNearestExpiryISO(rows, nowMs = Date.now()) {
  // Returns an ISO yyyy-mm-dd string (nearest non-past expiry).
  const today = todayDate(nowMs);
  let bestExp = null;
  for (const r of rows || []) {
    const exp = expiryDateTime(r.expiry);
    if (!exp) continue;
    if (exp.startOf("day") < today) continue;
    if (!bestExp || exp < bestExp) bestExp = exp;
  }
  return bestExp ? bestExp.toFormat("yyyy-LL-dd") : null;
}

function parseWeights(spec) {
  const s = String(spec || "").trim();
  const out = {
    spread: 1.0,
    spreadTrend: 0.3,
    dist: 0.2,
    depth: 0.25,
    volume: 0.15,
    oi: 0.1,
    delta: 0.2,
    gamma: 0.08,
    iv: 0.06,
    theta: 0.06,
    oiWall: 0.5,
  };
  if (!s) return out;
  for (const part of s.split(",")) {
    const [kRaw, vRaw] = part.split(":");
    const k = String(kRaw || "")
      .trim()
      .toLowerCase();
    const v = Number(vRaw);
    if (!k) continue;
    if (Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function scoreCandidate({
  bps,
  spreadBpsChange,
  distSteps,
  depthQty,
  volume,
  oi,
  deltaAbs,
  deltaTarget,
  gamma,
  ivPts,
  ivNeutralPts,
  thetaPerDay,
  oiWallPenalty,
  weights,
}) {
  const w = weights || {};

  const spread = Number.isFinite(bps) ? bps : 1e6;
  const dSteps = Number.isFinite(distSteps) ? distSteps : 999;

  const dep = Math.max(0, Number(depthQty ?? 0));
  const vol = Math.max(0, Number(volume ?? 0));
  const openInt = Math.max(0, Number(oi ?? 0));

  // Lower is better.
  // Penalize spread & distance, reward depth/volume/OI using log for stability.
  let s =
    Number(w.spread ?? 1.0) * spread +
    Number(w.dist ?? 0.2) * dSteps * 10 -
    Number(w.depth ?? 0.25) * Math.log(dep + 1) * 10 -
    Number(w.volume ?? 0.15) * Math.log(vol + 1) * 2 -
    Number(w.oi ?? 0.1) * Math.log(openInt + 1) * 2;

  // Spread trend: rising spreads hurt limit fills + increase slippage risk.
  if (Number.isFinite(spreadBpsChange) && spreadBpsChange > 0) {
    s += Number(w.spreadTrend ?? 0.3) * spreadBpsChange;
  }

  // Delta: prefer contracts with meaningful responsiveness.
  if (Number.isFinite(deltaAbs) && Number.isFinite(deltaTarget)) {
    s += Number(w.delta ?? 0.2) * Math.abs(deltaAbs - deltaTarget) * 100;
  }

  // Gamma: penalize extremely high gamma (whippy near expiry).
  if (Number.isFinite(gamma) && gamma > 0) {
    const gammaScaled = Math.min(5, gamma * 1e6); // typical gamma is small; scale for stability
    s += Number(w.gamma ?? 0.08) * gammaScaled;
  }

  // IV: avoid very high IV unless you expect a larger move.
  if (Number.isFinite(ivPts)) {
    const over = Math.max(0, ivPts - Number(ivNeutralPts ?? 20));
    s += Number(w.iv ?? 0.06) * over;
  }

  // Theta: avoid contracts bleeding heavily per day (esp. expiry day / late day).
  if (Number.isFinite(thetaPerDay)) {
    s += Number(w.theta ?? 0.06) * Math.abs(thetaPerDay) * 5;
  }

  if (oiWallPenalty) {
    s += Number(w.oiWall ?? 0.5) * oiWallPenalty;
  }

  return s;
}

function buildContractSelectionObservability(
  candidate,
  { selectedByFallback = false, fallbackReason = null } = {},
) {
  const eligibilityPassed = Boolean(candidate?.ok);
  const minEligibilityChecksPassed = Boolean(candidate?.hardOk);
  const rankingScore = Number(candidate?.score);
  const normalizedFallbackReason = selectedByFallback
    ? String(fallbackReason || "ROUTER_RELAXATION")
    : null;

  return {
    ok: eligibilityPassed,
    eligibilityPassed,
    minEligibilityChecksPassed,
    rankingScore: Number.isFinite(rankingScore) ? rankingScore : null,
    rankingScoreSemantics: "LOWER_IS_BETTER",
    selectedByFallback: Boolean(selectedByFallback),
    fallbackReason: normalizedFallbackReason,
    selectedReason: selectedByFallback
      ? `FALLBACK_${normalizedFallbackReason}`
      : eligibilityPassed
        ? "PRIMARY_ELIGIBLE"
        : minEligibilityChecksPassed
          ? "HARD_GATES_ONLY"
          : "FAILED_ELIGIBILITY",
  };
}

function buildCandidateDebugRow(candidate, options = {}) {
  const observability = buildContractSelectionObservability(candidate, options);
  return {
    tradingsymbol: candidate.row.tradingsymbol,
    instrument_token: Number(candidate.row.instrument_token),
    exchange: candidate.row.exchange || null,
    expiry:
      expiryISOInTz(candidate.row.expiry) ||
      candidate.row.expiry ||
      null,
    strike: Number(candidate.row.strike),
    ltp: Number(candidate.row.ltp),
    spread_bps: Number(candidate.row.spread_bps),
    spread_bps_change: Number(candidate.row.spread_bps_change),
    depth_qty_top: Number(candidate.row.depth_qty_top ?? 0),
    liq_score: Number(candidate.liqScore ?? 0),
    liquidityGateOk: !!candidate.liquidityGateOk,
    volume: Number(candidate.row.volume ?? 0),
    oi: Number(candidate.row.oi ?? 0),
    oi_change: Number(candidate.row.oi_change),
    delta: finiteNumberOrNull(candidate.row.delta),
    gamma: Number(candidate.row.gamma),
    iv_pts: Number(candidate.row.iv_pts),
    iv_change_pts: Number(candidate.row.iv_change_pts),
    vega_1pct: Number(candidate.row.vega_1pct),
    theta_per_day: Number(candidate.row.theta_per_day),
    health_score: Number(candidate.row.health_score),
    book_flicker: Number(candidate.row.book_flicker ?? 0),
    impact_cost_bps: Number(candidate.row.impact_cost_bps),
    distSteps: Number(candidate.distSteps),
    score: Number(candidate.score),
    ok: observability.ok,
    eligibilityPassed: observability.eligibilityPassed,
    minEligibilityChecksPassed: observability.minEligibilityChecksPassed,
    rankingScore: observability.rankingScore,
    rankingScoreSemantics: observability.rankingScoreSemantics,
    selectedByFallback: observability.selectedByFallback,
    fallbackReason: observability.fallbackReason,
    selectedReason: observability.selectedReason,
    hardOk: !!candidate.hardOk,
    premOk: !!candidate.premOk,
    spreadOk: !!candidate.spreadOk,
    spreadTrendOk: !!candidate.spreadTrendOk,
    depthOk: !!candidate.depthOk,
    deltaOk: !!candidate.deltaOk,
    gammaOk: !!candidate.gammaOk,
    ivOk: !!candidate.ivOk,
    ivTrendOk: !!candidate.ivTrendOk,
    healthOk: !!candidate.healthOk,
    flickerOk: !!candidate.flickerOk,
  };
}

function buildFallbackTraceEntry({
  stage,
  expiryISO,
  nextExpiry,
  relaxed,
}) {
  return {
    stage: Math.max(0, Number(stage ?? 0)),
    expiry: expiryISO || null,
    nextExpiry: nextExpiry || null,
    relaxed: Array.isArray(relaxed) ? relaxed.slice() : [],
  };
}

function buildAlternateContractSelection(baseSelection, candidate, options = {}) {
  const observability = buildContractSelectionObservability(candidate, options);
  return {
    ...baseSelection,
    instrument_token: Number(candidate?.row?.instrument_token),
    exchange: candidate?.row?.exchange || baseSelection?.exchange || null,
    tradingsymbol:
      candidate?.row?.tradingsymbol || baseSelection?.tradingsymbol || null,
    segment: candidate?.row?.segment || baseSelection?.segment || null,
    lot_size: Number(candidate?.row?.lot_size ?? baseSelection?.lot_size ?? 1),
    tick_size: normalizeTickSize(
      candidate?.row?.tick_size ?? baseSelection?.tick_size,
    ),
    strike: Number(candidate?.row?.strike ?? baseSelection?.strike ?? 0),
    pickedAt: new Date().toISOString(),
    ltp: Number(candidate?.row?.ltp),
    bps: Number(candidate?.row?.spread_bps),
    depth: Number(candidate?.row?.depth_qty_top ?? 0),
    iv: Number.isFinite(Number(candidate?.row?.iv))
      ? Number(candidate.row.iv)
      : null,
    iv_pts: Number.isFinite(Number(candidate?.row?.iv_pts))
      ? Number(candidate.row.iv_pts)
      : null,
    iv_change_pts: Number.isFinite(Number(candidate?.row?.iv_change_pts))
      ? Number(candidate.row.iv_change_pts)
      : null,
    delta: finiteNumberOrNull(candidate?.row?.delta),
    gamma: Number.isFinite(Number(candidate?.row?.gamma))
      ? Number(candidate.row.gamma)
      : null,
    vega_1pct: Number.isFinite(Number(candidate?.row?.vega_1pct))
      ? Number(candidate.row.vega_1pct)
      : null,
    theta_per_day: Number.isFinite(Number(candidate?.row?.theta_per_day))
      ? Number(candidate.row.theta_per_day)
      : null,
    oi: Number(candidate?.row?.oi ?? 0),
    oi_change: Number.isFinite(Number(candidate?.row?.oi_change))
      ? Number(candidate.row.oi_change)
      : null,
    spread_bps_change: Number.isFinite(Number(candidate?.row?.spread_bps_change))
      ? Number(candidate.row.spread_bps_change)
      : null,
    health_score: Number(candidate?.row?.health_score ?? 0),
    meta: {
      ...(baseSelection?.meta || {}),
      selectionObservability: observability,
      topCandidates: undefined,
      alternateContracts: undefined,
      alternateSource: "ROUTER_ALTERNATE_CANDIDATE",
    },
  };
}

function _median(nums) {
  const a = (nums || [])
    .filter((x) => Number.isFinite(x))
    .sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function computeOiWallContext({ rows, optType, desiredStrike, step }) {
  const mult = Number(env.OPT_OI_WALL_MULT ?? 2.5);
  const strikes = Math.max(1, Number(env.OPT_OI_WALL_STRIKES ?? 2));
  const requireChange = Boolean(env.OPT_OI_WALL_REQUIRE_OI_CHANGE ?? true);

  const ois = (rows || [])
    .map((r) => Number(r.oi))
    .filter((x) => Number.isFinite(x) && x > 0);
  const med = _median(ois);
  if (!(med > 0)) return { medianOi: med, wall: null };

  const dir = String(optType || "").toUpperCase();
  const wantAbove = dir === "CE";

  let best = null;
  for (let i = 1; i <= strikes; i++) {
    const k = desiredStrike + (wantAbove ? i : -i) * step;
    const row = (rows || []).find((r) => Number(r.strike) === Number(k));
    if (!row) continue;
    const oi = Number(row.oi);
    const oiCh = Number(row.oi_change);
    if (!Number.isFinite(oi) || oi <= 0) continue;
    const okChange = requireChange
      ? Number.isFinite(oiCh)
        ? oiCh > 0
        : false
      : true;
    if (!okChange) continue;
    if (!best || oi > best.oi) {
      best = { strike: k, oi, oi_change: Number.isFinite(oiCh) ? oiCh : null };
    }
  }

  if (!best) return { medianOi: med, wall: null };

  const wallExists = best.oi >= med * mult;
  return { medianOi: med, wall: wallExists ? best : null };
}

function isOiWallBlockedStrike({ rowStrike, optType, wallStrike }) {
  if (
    !Number.isFinite(Number(rowStrike)) ||
    !Number.isFinite(Number(wallStrike))
  ) {
    return false;
  }
  const strike = Number(rowStrike);
  const wall = Number(wallStrike);
  const dir = String(optType || "").toUpperCase();
  // CE longs are usually hurt by resistance above/at wall strike.
  if (dir === "CE") return strike >= wall;
  // PE longs are usually hurt by support below/at wall strike.
  if (dir === "PE") return strike <= wall;
  return false;
}

function liquidityGateScoreRow({ row, spreadCapBps }) {
  const spreadBps = Number(row?.spread_bps);
  const depthQty = Math.max(0, Number(row?.depth_qty_top ?? 0));
  const volume = Math.max(0, Number(row?.volume ?? 0));
  const oi = Math.max(0, Number(row?.oi ?? 0));
  const health = Number(row?.health_score);

  // Higher is better. Wide spread hurts sharply; depth/volume/OI improve score.
  let score = 0;
  if (Number.isFinite(spreadBps)) {
    const cap = Math.max(1, Number(spreadCapBps ?? 35));
    const spreadRatio = Math.max(0, Math.min(2, spreadBps / cap));
    score += (1 - Math.min(1, spreadRatio)) * 45;
  }
  score += Math.min(20, Math.log(depthQty + 1) * 4);
  score += Math.min(20, Math.log(volume + 1) * 2.6);
  score += Math.min(15, Math.log(oi + 1) * 1.8);
  if (Number.isFinite(health)) {
    score += Math.min(10, Math.max(0, (health - 40) / 6));
  }
  return Math.max(0, Math.min(100, score));
}

function pickDeltaAnchorStrike({ rows, optType, fallbackStrike, deltaTarget, deltaMin, deltaMax }) {
  const target = Number(deltaTarget);
  if (!Number.isFinite(target)) return Number(fallbackStrike);

  const pool = (rows || [])
    .map((r) => {
      const d = finiteNumberOrNull(r?.delta);
      const abs = Number.isFinite(d) ? Math.abs(d) : null;
      const strike = Number(r?.strike);
      if (!Number.isFinite(abs) || !Number.isFinite(strike)) return null;
      const inBand = abs >= Number(deltaMin) && abs <= Number(deltaMax);
      return {
        row: r,
        strike,
        abs,
        inBand,
        deltaGap: Math.abs(abs - target),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.inBand !== b.inBand) return a.inBand ? -1 : 1;
      if (a.deltaGap !== b.deltaGap) return a.deltaGap - b.deltaGap;
      return Math.abs(a.strike - Number(fallbackStrike)) - Math.abs(b.strike - Number(fallbackStrike));
    });

  if (!pool.length) return Number(fallbackStrike);
  const best = pool[0];
  const rowOptType = String(best?.row?.instrument_type || optType || "").toUpperCase();
  if (rowOptType !== "CE" && rowOptType !== "PE") return best.strike;
  return best.strike;
}

async function pickOptionContractForSignal({
  kite,
  universe,
  underlyingToken,
  underlyingTradingsymbol,
  side, // BUY/SELL on underlying
  underlyingLtp,
  // Optional dynamic overrides (pacing policy)
  maxSpreadBpsOverride,
  minPremiumOverride,
  maxPremiumOverride,
  forceExpiryISO,
  gateStage = 0,
  triedExpiries = [],
  fallbackTrace = [],
  nowMs = Date.now(),
}) {
  const u = resolveUnderlyingFromUniverse({
    universe,
    token: underlyingToken,
    tradingsymbol: underlyingTradingsymbol,
  });

  const underlying = chainRootFromSpot(u);
  if (!underlying) {
    logger.warn(
      { underlyingToken, underlyingTradingsymbol },
      "[options] cannot resolve underlying",
    );
    return {
      ok: false,
      reason: "UNDERLYING_NOT_RESOLVED",
      message: `[options] cannot resolve underlying for token=${underlyingToken} symbol=${underlyingTradingsymbol}`,
    };
  }

  // QuoteGuard safety: if breaker is open (rate limits / transient failures),
  // block option selection so we don't pick contracts with partial / missing liquidity fields.
  const blockOnQG =
    String(env.OPT_BLOCK_ON_QUOTE_GUARD_OPEN || "true") !== "false";
  if (
    blockOnQG &&
    typeof isQuoteGuardBreakerOpen === "function" &&
    isQuoteGuardBreakerOpen()
  ) {
    const st =
      typeof getQuoteGuardStats === "function" ? getQuoteGuardStats() : null;
    return {
      ok: false,
      reason: "QUOTE_GUARD_BREAKER_OPEN",
      message:
        "[options] QuoteGuard breaker open; blocking option selection until quotes stabilize",
      underlying,
      optType: null,
      meta: {
        breakerOpenUntil: st?.breakerOpenUntil || null,
        failStreak: st?.stats?.failStreak ?? null,
      },
    };
  }
  const dir = String(side || "").toUpperCase();
  const optType = dir === "BUY" ? "CE" : "PE";

  const exchanges = uniq(parseCsvList(env.FNO_EXCHANGES || "NFO,BFO"));

  // Load option rows (CE/PE) for this underlying across allowed exchanges
  const optionRows = [];
  for (const ex of exchanges) {
    const rows = await getInstrumentsDump(kite, ex);
    for (const r of rows || []) {
      const name = chainRootFromSpot(r.name);
      const it = String(r.instrument_type || "").toUpperCase();
      if (name !== underlying) continue;
      if (it !== optType) continue;
      // Keep exchange explicit (in some dumps it can be blank)
      optionRows.push({ ...r, exchange: r.exchange || ex });
    }
  }

  if (!optionRows.length) {
    logger.warn({ underlying, optType }, "[options] no option rows found");
    return {
      ok: false,
      reason: "NO_OPTION_ROWS",
      message: `[options] no ${optType} rows found for ${underlying}`,
      underlying,
      optType,
    };
  }

  // Build expiry set
  const expiries = optionRows.map((r) => expiryISOInTz(r.expiry)).filter(Boolean);

  let expiryISO = forceExpiryISO || pickNearestExpiryISO(optionRows, nowMs);
  // Apply roll rules (min DTE / avoid expiry-day after cutoff)
  const picked = pickBestExpiryISO({ expiries, env, nowMs });
  if (!forceExpiryISO && picked?.expiryISO) expiryISO = picked.expiryISO;
  const sortedExpiries = Array.from(new Set(expiries)).sort();

  if (!expiryISO) {
    logger.warn(
      { underlying, optType },
      "[options] no valid upcoming expiry found",
    );
    return {
      ok: false,
      reason: "NO_VALID_EXPIRY",
      message: `[options] no valid upcoming expiry found for ${underlying} ${optType}`,
      underlying,
      optType,
    };
  }

  const slice = optionRows.filter(
    (r) => expiryISOInTz(r.expiry) === expiryISO,
  );

  const step = detectStrikeStepFromRows(slice, strikeStepFallback(underlying));
  const atm = roundToStep(Number(underlyingLtp), step);

  const offsetSteps = Number(env.OPT_STRIKE_OFFSET_STEPS ?? 0);
  const baseDesiredStrike = atm + offsetSteps * step;

  const radius = Number(env.OPT_ATM_SCAN_STEPS ?? 2);
  const offsets = buildCandidateOffsets(radius);

  // For cache + ranking: scan a wider band around desired strike.
  const wide = Math.max(radius, Number(env.OPT_CHAIN_STRIKES_AROUND_ATM ?? 10));

  // Build candidate strike set
  const strikeSet = new Set();
  for (let i = -wide; i <= wide; i++) {
    strikeSet.add(baseDesiredStrike + i * step);
  }

  const byStrike = new Map();
  for (const r of slice) {
    const k = Number(r.strike);
    if (!Number.isFinite(k)) continue;
    if (strikeSet.has(k)) byStrike.set(k, r);
  }

  // Keep primary strikes (close to desired) first
  const primaryStrikes = offsets
    .map((o) => baseDesiredStrike + o * step)
    .filter((s) => strikeSet.has(s));

  const candidates = [];
  for (const s of primaryStrikes) {
    const row = byStrike.get(s);
    if (row) candidates.push(row);
  }

  // Fill remaining candidates by closeness (avoid huge arrays)
  // Pro scalping: optionally restrict to ATM±scan only (no far strikes)
  if (!env.OPT_STRICT_ATM_ONLY) {
    if (candidates.length < Math.max(6, offsets.length)) {
      const rest = Array.from(byStrike.entries())
        .map(([strike, row]) => ({
          strike,
          row,
          dist: Math.abs(strike - baseDesiredStrike),
        }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, Math.max(20, wide * 2 + 1))
        .map((x) => x.row);

      for (const r of rest) {
        if (
          candidates.find(
            (c) => String(c.tradingsymbol) === String(r.tradingsymbol),
          )
        )
          continue;
        candidates.push(r);
        if (candidates.length >= Math.min(35, Math.max(20, wide * 2 + 1)))
          break;
      }
    }
  }

  if (!candidates.length) {
    logger.warn(
      { underlying, optType, expiry: expiryISO, atm, desiredStrike: baseDesiredStrike, step },
      "[options] no candidates in strike scan",
    );
    return {
      ok: false,
      reason: "NO_STRIKE_CANDIDATES",
      message: `[options] no candidates for ${underlying} ${optType} ${expiryISO}`,
      underlying,
      optType,
      expiry: expiryISO,
      atm,
      desiredStrike: baseDesiredStrike,
      step,
    };
  }

  const ttlMs = Number(env.OPT_CHAIN_TTL_MS ?? 1500);
  const chain = await getOptionChainSnapshot({
    kite,
    env,
    underlying,
    optType,
    expiryISO,
    exchanges,
    candidates,
    ttlMs,
    underlyingLtp,
    nowMs,
  });

  const band = getPremiumBandForUnderlying(underlying);
  const minPrem = Number(
    Number.isFinite(Number(minPremiumOverride))
      ? minPremiumOverride
      : band.minPrem,
  );
  const maxPrem = Number(
    Number.isFinite(Number(maxPremiumOverride))
      ? maxPremiumOverride
      : band.maxPrem,
  );
  const enforcePremBand = Boolean(band.enforce);

  const maxBpsRaw = Number(
    Number.isFinite(Number(maxSpreadBpsOverride))
      ? maxSpreadBpsOverride
      : env.OPT_MAX_SPREAD_BPS ?? 35,
  );
  const minDepth = Number(env.OPT_MIN_DEPTH_QTY ?? 0);

  const stage = Math.max(0, Number(gateStage ?? 0));
  const maxBps = stage >= 1 ? maxBpsRaw * 1.25 : maxBpsRaw;
  const premiumSlack = stage >= 2 ? 25 : 0;
  const deltaGateEnabled =
    stage >= 3 ? false : Boolean(env.OPT_DELTA_BAND_ENFORCE ?? true);
  const gammaGateEnabled = stage >= 4 ? false : true;
  const greeksRequired = Boolean(
    env.OPT_GREEKS_REQUIRED ?? env.GREEKS_REQUIRED ?? false,
  );

  // New: greeks/microstructure safety
  const enforceDeltaBand = deltaGateEnabled;
  const deltaMin = Number(env.OPT_DELTA_BAND_MIN ?? 0.35);
  const deltaMax = Number(env.OPT_DELTA_BAND_MAX ?? 0.65);
  const deltaTarget = Number(env.OPT_DELTA_TARGET ?? 0.5);

  const gammaMax = Number(env.OPT_GAMMA_MAX ?? 0.004);
  const gammaGateDteDays = Number(env.OPT_GAMMA_GATE_DTE_DAYS ?? 0.5);
  const dteDays = _dteDays(expiryISO, nowMs);
  const gammaGateActive = Number.isFinite(dteDays)
    ? dteDays <= gammaGateDteDays
    : false;

  const spreadRiseBlockBps = Number(env.OPT_SPREAD_RISE_BLOCK_BPS ?? 8);
  const flickerBlock = Number(env.OPT_BOOK_FLICKER_BLOCK ?? 4);
  const minHealthScore = Number(env.OPT_HEALTH_SCORE_MIN ?? 45);

  const ivMaxPts = Number(env.OPT_IV_MAX_PTS ?? 80);
  const ivDropBlockPts = Number(env.OPT_IV_DROP_BLOCK_PTS ?? 2);
  const ivNeutralPts = Number(env.OPT_IV_NEUTRAL_PTS ?? 20);

  const oiWallBlock = Boolean(env.OPT_OI_WALL_BLOCK ?? true);

  const weights = parseWeights(env.OPT_PICK_SCORE_WEIGHTS);

  const liqGateEnabled = Boolean(env.OPT_LIQ_GATE_ENABLED ?? true);
  const liqGateMinScore = Number(env.OPT_LIQ_GATE_MIN_SCORE ?? 45);
  const liqGateMaxSpreadBps = Number(env.OPT_LIQ_GATE_MAX_SPREAD_BPS ?? maxBps);
  const liqGateMinDepthQty = Number(env.OPT_LIQ_GATE_MIN_DEPTH_QTY ?? minDepth);
  const liqGateMinOi = Number(env.OPT_LIQ_GATE_MIN_OI ?? 0);
  const liqGateMinVolume = Number(env.OPT_LIQ_GATE_MIN_VOLUME ?? 0);
  const liqGateTopN = Math.max(0, Number(env.OPT_LIQ_GATE_TOP_N ?? 0));

  const strikeSelectionMode = String(env.OPT_STRIKE_SELECTION_MODE || "DELTA_NEAREST")
    .trim()
    .toUpperCase();

  const liquidityPool = (chain?.snapshot?.rows || [])
    .map((r) => {
      const liqScore = liquidityGateScoreRow({ row: r, spreadCapBps: liqGateMaxSpreadBps });
      const spreadBps = Number(r?.spread_bps);
      const depthQty = Number(r?.depth_qty_top ?? 0);
      const vol = Number(r?.volume ?? 0);
      const oi = Number(r?.oi ?? 0);
      const liqGateOk =
        (!liqGateEnabled || liqScore >= liqGateMinScore) &&
        (Number.isFinite(spreadBps) ? spreadBps <= liqGateMaxSpreadBps : false) &&
        depthQty >= Math.max(0, liqGateMinDepthQty) &&
        vol >= Math.max(0, liqGateMinVolume) &&
        oi >= Math.max(0, liqGateMinOi);
      return { row: r, liqScore, liqGateOk };
    })
    .sort((a, b) => b.liqScore - a.liqScore);

  const liquidityEligible = liquidityPool.filter((x) => x.liqGateOk);
  const liquidityByToken = new Map(
    liquidityPool.map((x) => [Number(x?.row?.instrument_token), x]),
  );
  const liquidityScopedRows =
    liqGateTopN > 0
      ? liquidityEligible.slice(0, liqGateTopN).map((x) => x.row)
      : liquidityEligible.map((x) => x.row);

  const desiredStrike =
    strikeSelectionMode === "DELTA_NEAREST"
      ? pickDeltaAnchorStrike({
          rows: liquidityScopedRows.length ? liquidityScopedRows : chain?.snapshot?.rows || [],
          optType,
          fallbackStrike: baseDesiredStrike,
          deltaTarget,
          deltaMin,
          deltaMax,
        })
      : baseDesiredStrike;

  const oiContext = computeOiWallContext({
    rows: chain?.snapshot?.rows || [],
    optType,
    desiredStrike,
    step,
  });

  // Optional debug payload (kept OFF by default)
  // Helps you see why a specific option was picked (top N candidates).
  // Set OPT_PICK_DEBUG_TOP_N=5 (max 10) to include a small top-candidates list in the pick metadata.
  const debugTopN = Math.max(
    0,
    Math.min(Number(env.OPT_PICK_DEBUG_TOP_N ?? 0), 10),
  );

  const scored = (chain?.snapshot?.rows || [])
    .map((r) => {
      const liqMeta = liquidityByToken.get(Number(r?.instrument_token));
      const ltp = Number(r.ltp);
      const bps = Number(r.spread_bps);
      const bpsCh = Number(r.spread_bps_change);

      const premOk = Number.isFinite(ltp)
        ? ltp >= (minPrem - premiumSlack) && ltp <= (maxPrem + premiumSlack)
        : true;
      const spreadOk = Number.isFinite(bps) ? bps <= maxBps : false; // fail-closed when spread is unknown
      const spreadTrendOk = Number.isFinite(bpsCh)
        ? bpsCh <= spreadRiseBlockBps
        : true;
      const flicker = Number(r.book_flicker ?? 0);
      const flickerOk = flicker <= flickerBlock;
      const health = Number(r.health_score);
      const healthOk = Number.isFinite(health) ? health >= minHealthScore : true;

      const depthTopQty = Number(r.depth_qty_top ?? 0);
      const hasAnyDepth = Number.isFinite(depthTopQty) && depthTopQty > 0;
      const depthOk =
        Number(minDepth) > 0 ? depthTopQty >= Number(minDepth) : hasAnyDepth; // require depth even if minDepth not configured

      const liqScore = Number(liqMeta?.liqScore ?? 0);
      const liquidityGateOk = liqGateEnabled ? !!liqMeta?.liqGateOk : true;

      const delta = finiteNumberOrNull(r.delta);
      const deltaAbs = Number.isFinite(delta) ? Math.abs(delta) : null;
      const deltaOk = Number.isFinite(deltaAbs)
        ? deltaAbs >= deltaMin && deltaAbs <= deltaMax
        : !greeksRequired; // If greeks missing, do not hard-block unless strict mode.

      const gamma = finiteNumberOrNull(r.gamma);
      const gammaOk = Number.isFinite(gamma)
        ? gammaGateEnabled && gammaGateActive
          ? gamma <= gammaMax
          : true
        : !greeksRequired;

      const ivPts = finiteNumberOrNull(r.iv_pts);
      const ivCh = Number(r.iv_change_pts);
      const ivOk = Number.isFinite(ivPts) ? ivPts <= ivMaxPts : !greeksRequired;
      const ivTrendOk = Number.isFinite(ivCh) ? ivCh >= -ivDropBlockPts : true;

      // OI wall context
      const oiWall = oiContext?.wall || null;
      const oiWallBlocked = isOiWallBlockedStrike({
        rowStrike: r.strike,
        optType,
        wallStrike: oiWall?.strike,
      });
      const oiWallOk = oiWallBlock ? !oiWallBlocked : true;
      const oiWallPenalty = oiWallBlocked ? 60 : oiWall ? 10 : 0;

      const dist = Math.abs(Number(r.strike) - desiredStrike);
      const distSteps = step > 0 ? dist / step : dist;

      const score = scoreCandidate({
        bps,
        spreadBpsChange: bpsCh,
        distSteps,
        depthQty: r.depth_qty_top,
        volume: r.volume,
        oi: r.oi,
        deltaAbs,
        deltaTarget,
        gamma,
        ivPts,
        ivNeutralPts,
        thetaPerDay: Number(r.theta_per_day),
        oiWallPenalty,
        weights,
      });

      // "hardOk" = all safety/liquidity/greek gates EXCLUDING the premium band.
      // "ok"     = hardOk + premium band.
      // Why split?
      //  - When premium band is too tight (e.g., decaying 0DTE), you may end up with
      //    NO_OK_CANDIDATE even though plenty of contracts are liquid + greeks-safe.
      //  - We can optionally allow a *premium-band-only* fallback without relaxing other gates.
      const hardOk =
        spreadOk &&
        spreadTrendOk &&
        flickerOk &&
        healthOk &&
        depthOk &&
        liquidityGateOk &&
        ivOk &&
        ivTrendOk &&
        (enforceDeltaBand ? deltaOk : true) &&
        gammaOk &&
        oiWallOk;

      const ok = premOk && hardOk;

      return {
        row: r,
        hardOk,
        ok,
        premOk,
        spreadOk,
        spreadTrendOk,
        depthOk,
        liquidityGateOk,
        liqScore,
        deltaOk,
        gammaOk,
        ivOk,
        ivTrendOk,
        healthOk,
        flickerOk,
        dist,
        distSteps,
        score,
        ctx: {
          deltaAbs,
          gamma: Number.isFinite(gamma) ? gamma : null,
          ivPts: Number.isFinite(ivPts) ? ivPts : null,
          ivChangePts: Number.isFinite(ivCh) ? ivCh : null,
          spreadBpsChange: Number.isFinite(bpsCh) ? bpsCh : null,
          healthScore: Number.isFinite(health) ? health : null,
          bookFlicker: Number.isFinite(flicker) ? flicker : null,
          liquidity: {
            score: liqScore,
            gateOk: liquidityGateOk,
          },
          oiWall: oiWall
            ? { ...oiWall, medianOi: oiContext?.medianOi ?? null }
            : null,
        },
      };
    })
    .sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      return a.dist - b.dist;
    });

  const requireOk = !!env.OPT_PICK_REQUIRE_OK;

  // Eligible candidates:
  // - premium band enforced for NIFTY when enabled
  // - and (pro) require ok => all gates must pass
  const eligible = scored.filter((x) => {
    if (enforcePremBand && !x.premOk) return false;
    if (requireOk && !x.ok) return false;
    return true;
  });

  // If nothing is eligible, optionally allow a *premium-band-only* fallback
  // (i.e., keep all other gates intact).
  let premiumBandFallbackUsed = false;
  let best = eligible[0];

  if (!best) {
    const allowPremiumFallback =
      !!env.OPT_PREMIUM_BAND_FALLBACK && requireOk && enforcePremBand;

    if (allowPremiumFallback) {
      const slackDown = Number(env.OPT_PREMIUM_BAND_FALLBACK_SLACK_DOWN ?? 20);
      const slackUp = Number(env.OPT_PREMIUM_BAND_FALLBACK_SLACK_UP ?? 150);

      // Find best contract that passes ALL gates except premium band.
      // Choose by score then ATM distance.
      let bestHard = null;
      for (const x of scored) {
        if (!x?.hardOk) continue;
        const ltp = Number(x.row.ltp);
        if (!Number.isFinite(ltp)) continue;
        if (ltp < minPrem - slackDown) continue;
        if (ltp > maxPrem + slackUp) continue;
        if (!bestHard) {
          bestHard = x;
          continue;
        }
        if (x.score < bestHard.score) bestHard = x;
        else if (x.score === bestHard.score && x.dist < bestHard.dist) {
          bestHard = x;
        }
      }

      if (bestHard) {
        best = bestHard;
        premiumBandFallbackUsed = true;

        logger.warn(
          {
            underlying,
            optType,
            expiry: expiryISO,
            atm,
            desiredStrike,
            step,
            minPrem,
            maxPrem,
            slackDown,
            slackUp,
            picked: {
              tradingsymbol: bestHard.row.tradingsymbol,
              strike: Number(bestHard.row.strike),
              ltp: Number(bestHard.row.ltp),
              bps: Number(bestHard.row.spread_bps),
              depth: Number(bestHard.row.depth_qty_top ?? 0),
              delta: finiteNumberOrNull(bestHard.row.delta),
              gamma: Number(bestHard.row.gamma),
            },
          },
          "[options] premium band fallback used (all other gates OK)",
        );
      }
    }

    // Still nothing? Return original failure.
    if (!best) {
      const why = requireOk
        ? "no OK candidate (spread/depth/greeks/oi gates)"
        : "no candidate in premium band";

      const msg = `[options] ${why} for ${underlying} ${optType} (minPrem=${minPrem}, maxPrem=${maxPrem}, maxBps=${maxBps}, minDepth=${minDepth})`;

      const debugTop =
        debugTopN > 0
          ? scored.slice(0, debugTopN).map((x) => buildCandidateDebugRow(x))
          : undefined;

      logger.warn(
        {
          underlying,
          optType,
          expiry: expiryISO,
          atm,
          desiredStrike,
          step,
          requireOk,
          minPrem,
          maxPrem,
          maxBps,
          minDepth,
          topCandidates: debugTop,
        },
        "[options] no eligible candidate",
      );

      const triedSet = new Set([...(triedExpiries || []), expiryISO]);
      const nextExpiry = sortedExpiries.find((e) => !triedSet.has(e));
      const canRelax = stage < 4;
      if (nextExpiry || canRelax) {
        const nextStage = nextExpiry ? stage : stage + 1;
        const relaxedByStage = {
          1: ["maxSpreadBps"],
          2: ["premiumBand"],
          3: ["deltaBand"],
          4: ["gammaGate"],
        };
        const relaxed = nextExpiry
          ? ["nextExpiry"]
          : relaxedByStage[nextStage] || [];
        const nextArgs = {
          kite,
          universe,
          underlyingToken,
          underlyingTradingsymbol,
          side,
          underlyingLtp,
          maxSpreadBpsOverride,
          minPremiumOverride,
          maxPremiumOverride,
          forceExpiryISO: nextExpiry || expiryISO,
          gateStage: nextStage,
          triedExpiries: Array.from(triedSet),
          fallbackTrace: [
            ...(fallbackTrace || []),
            buildFallbackTraceEntry({
              stage,
              expiryISO,
              nextExpiry,
              relaxed,
            }),
          ],
        };
        logger.warn(
          {
            underlying,
            optType,
            expiry: expiryISO,
            fallbackLevel: nextStage,
            stage,
            nextExpiry,
            nextStage,
            relaxed,
          },
          "[options] fallback retry triggered",
        );
        return pickOptionContractForSignal(nextArgs);
      }

      return {
        ok: false,
        reason: requireOk ? "NO_OK_CANDIDATE" : "NO_PREMIUM_BAND_CANDIDATE",
        message: msg,
        underlying,
        optType,
        expiry: expiryISO,
        atmStrike: atm,
        desiredStrike,
        strikeStep: step,
        premiumBand: { minPrem, maxPrem, enforced: enforcePremBand },
        meta: {
          micro: { maxBps, spreadRiseBlockBps, minDepth, flickerBlock, minHealthScore },
          deltaBand: enforceDeltaBand
            ? { min: deltaMin, max: deltaMax, target: deltaTarget }
            : null,
          iv: {
            maxPts: ivMaxPts,
            dropBlockPts: ivDropBlockPts,
            neutralPts: ivNeutralPts,
          },
          gamma: {
            max: gammaMax,
            gateActive: gammaGateActive,
            gateDteDays: gammaGateDteDays,
          },
          greeksRequired,
          oiContext,
          topCandidates: debugTop,
          fallbackTrace,
        },
      };
    }
  }

  const poolForDebug = eligible.length > 0 ? eligible : scored;
  const topCandidates =
    debugTopN > 0
      ? poolForDebug.slice(0, debugTopN).map((x) => buildCandidateDebugRow(x))
      : undefined;
  const routerFallbackUsed =
    premiumBandFallbackUsed ||
    stage > 0 ||
    (Array.isArray(fallbackTrace) && fallbackTrace.length > 0);
  const routerFallbackReason = premiumBandFallbackUsed
    ? "PREMIUM_BAND_ONLY"
    : routerFallbackUsed
      ? "ROUTER_RELAXATION"
      : null;
  const selectionObservability = buildContractSelectionObservability(best, {
    selectedByFallback: routerFallbackUsed,
    fallbackReason: routerFallbackReason,
  });

  const selection = {
    underlying,
    optType,
    expiry: expiryISO,
    atmStrike: atm,
    desiredStrike,
    strikeStep: step,
    premiumBand: {
      minPrem,
      maxPrem,
      enforced: enforcePremBand,
    },
    instrument_token: Number(best.row.instrument_token),
    exchange: best.row.exchange,
    tradingsymbol: best.row.tradingsymbol,
    segment: best.row.segment,
    lot_size: Number(best.row.lot_size ?? 1),
    tick_size: normalizeTickSize(best.row.tick_size),
    strike: Number(best.row.strike),
    pickedAt: new Date().toISOString(),

    // attach greeks & microstructure metrics for downstream risk/plan logic
    ltp: Number(best.row.ltp),
    bps: Number(best.row.spread_bps),
    depth: Number(best.row.depth_qty_top ?? 0),
    iv: Number.isFinite(Number(best.row.iv)) ? Number(best.row.iv) : null,
    iv_pts: Number.isFinite(Number(best.row.iv_pts)) ? Number(best.row.iv_pts) : null,
    iv_change_pts: Number.isFinite(Number(best.row.iv_change_pts)) ? Number(best.row.iv_change_pts) : null,
    delta: finiteNumberOrNull(best.row.delta),
    gamma: Number.isFinite(Number(best.row.gamma)) ? Number(best.row.gamma) : null,
    vega_1pct: Number.isFinite(Number(best.row.vega_1pct)) ? Number(best.row.vega_1pct) : null,
    theta_per_day: Number.isFinite(Number(best.row.theta_per_day)) ? Number(best.row.theta_per_day) : null,
    oi: Number(best.row.oi ?? 0),
    oi_change: Number.isFinite(Number(best.row.oi_change)) ? Number(best.row.oi_change) : null,
    spread_bps_change: Number.isFinite(Number(best.row.spread_bps_change)) ? Number(best.row.spread_bps_change) : null,

    meta: {
      policy: picked?.policy || null,
      dteDays: Number.isFinite(dteDays) ? dteDays : null,
      premiumBandFallbackUsed,
      selectionPath: {
        stage,
        selectedByFallback: routerFallbackUsed,
        fallbackReason: routerFallbackReason,
        expiryPolicy: picked?.policy || null,
        triedExpiries: Array.from(new Set([...(triedExpiries || []), expiryISO])),
        fallbackTrace: Array.isArray(fallbackTrace) ? fallbackTrace.slice() : [],
      },
      strikeSelection: {
        mode: strikeSelectionMode,
        baseDesiredStrike,
        finalDesiredStrike: desiredStrike,
      },
      premiumBandFallback: premiumBandFallbackUsed
        ? {
            slackDown: Number(env.OPT_PREMIUM_BAND_FALLBACK_SLACK_DOWN ?? 20),
            slackUp: Number(env.OPT_PREMIUM_BAND_FALLBACK_SLACK_UP ?? 150),
          }
        : null,
      gammaGateActive,
      deltaBand: enforceDeltaBand
        ? { min: deltaMin, max: deltaMax, target: deltaTarget }
        : null,
      iv: {
        maxPts: ivMaxPts,
        dropBlockPts: ivDropBlockPts,
        neutralPts: ivNeutralPts,
      },
      greeksRequired,
      micro: { maxBps, spreadRiseBlockBps, minDepth, flickerBlock, minHealthScore },
      liquidityGate: {
        enabled: liqGateEnabled,
        minScore: liqGateMinScore,
        maxSpreadBps: liqGateMaxSpreadBps,
        minDepthQty: liqGateMinDepthQty,
        minOi: liqGateMinOi,
        minVolume: liqGateMinVolume,
        topN: liqGateTopN,
        eligibleCount: liquidityEligible.length,
      },
      selectionObservability,
      oiContext,
      weights,
      fromCache: !!chain?.fromCache,
      chainCount: Number(chain?.snapshot?.count ?? 0),
      topCandidates,
    },
  };

  const alternateContractTopN = Math.max(
    0,
    Math.min(Number(env.OPT_ALTERNATE_CONTRACT_TOP_N ?? 3), 10),
  );
  const alternateCandidates =
    alternateContractTopN > 0
      ? poolForDebug
          .filter(
            (candidate) =>
              Number(candidate?.row?.instrument_token) !==
              Number(best?.row?.instrument_token),
          )
          .slice(0, alternateContractTopN)
      : [];
  selection.meta.alternateContracts = alternateCandidates.map(
    (candidate, index) => {
      const altSelection = buildAlternateContractSelection(selection, candidate);
      return {
        ...altSelection,
        meta: {
          ...altSelection.meta,
          alternateRank: index + 1,
        },
      };
    },
  );

  // Log selection (helps debugging)
  logger.info(
    {
      underlying,
      optType,
      expiry: expiryISO,
      atm,
      desiredStrike,
      step,
      selected: {
        tradingsymbol: best.row.tradingsymbol,
        strike: best.row.strike,
        exchange: best.row.exchange,
        token: best.row.instrument_token,
        ltp: best.row.ltp,
        bps: best.row.spread_bps,
        spreadBpsChange: best.row.spread_bps_change,
        depth: best.row.depth_qty_top,
        delta: best.row.delta,
        gamma: best.row.gamma,
        ivPts: best.row.iv_pts,
        score: best.score,
        ok: selectionObservability.ok,
        eligibilityPassed: selectionObservability.eligibilityPassed,
        minEligibilityChecksPassed:
          selectionObservability.minEligibilityChecksPassed,
        rankingScore: selectionObservability.rankingScore,
        rankingScoreSemantics: selectionObservability.rankingScoreSemantics,
        selectedByFallback: selectionObservability.selectedByFallback,
        fallbackReason: selectionObservability.fallbackReason,
        selectedReason: selectionObservability.selectedReason,
        premiumBandFallbackUsed,
        oiWall: selection?.meta?.oiContext?.wall || null,
      },
    },
    "[options] selected contract (liquidity-rank)",
  );

  setLastOptionPick(underlying, selection);

  return selection;
}

module.exports = {
  INDEX_TO_CHAIN,
  chainRootFromSpot,
  buildOptionSubscriptionCandidates,
  buildContractSelectionObservability,
  getPremiumBandForUnderlying,
  pickOptionContractForSignal,
};
