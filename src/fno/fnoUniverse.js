const { DateTime } = require("luxon");
const { env } = require("../config");
const { normalizeTickSize } = require("../utils/tickSize");
const { logger } = require("../logger");
const { isExpiryAllowed } = require("./expiryPolicy");
const {
  getInstrumentsDump,
  parseCsvList,
  uniq,
} = require("../instruments/instrumentRepo");

let lastUniverse = null;

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v;
  }

  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const s = String(v).trim();
  if (!s) return null;

  const dateOnly = DateTime.fromFormat(s, "yyyy-MM-dd", { zone: tz });
  if (dateOnly.isValid) return dateOnly.startOf("day").toJSDate();

  const iso = DateTime.fromISO(s, { zone: tz });
  if (iso.isValid) return iso.toJSDate();

  return null;
}

function underlyingAliases(underlying) {
  const u = String(underlying || "")
    .toUpperCase()
    .trim();
  if (!u) return [];
  const aliases = new Set([u]);
  if (u === "NIFTY") {
    aliases.add("NIFTY 50");
    aliases.add("NIFTY50");
  }
  if (u === "BANKNIFTY") {
    aliases.add("NIFTY BANK");
    aliases.add("BANK NIFTY");
  }
  return Array.from(aliases);
}

function matchesUnderlying(row, underlying) {
  const aliases = underlyingAliases(underlying);
  if (!aliases.length) return false;

  const name = String(row?.name || "").toUpperCase();
  const ts = String(row?.tradingsymbol || "").toUpperCase();
  if (aliases.some((a) => name === a || name.includes(a))) return true;

  // Fallback for derivative dumps where `name` can be inconsistent/blank.
  // For example: NIFTY26FEBFUT, BANKNIFTY26FEBFUT.
  return aliases.some(
    (a) => ts.startsWith(a.replace(/\s+/g, "")) || ts.startsWith(a),
  );
}

function todayYMD(nowMs = Date.now()) {
  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  return DateTime.fromMillis(Number(nowMs)).setZone(tz).toFormat("yyyy-MM-dd");
}

function isEnabled() {
  return String(env.FNO_ENABLED || "false").toLowerCase() === "true";
}

function getLastFnoUniverse() {
  return lastUniverse;
}

function bestRowByNearestExpiry(rows, nowMs = Date.now()) {
  const today = parseDate(todayYMD(nowMs));
  let best = null;
  let bestExp = null;
  let fallback = null;
  let fallbackExp = null;
  for (const r of rows || []) {
    const exp = parseDate(r.expiry);
    if (!exp) continue;
    // choose expiry today or later
    if (today && exp < today) continue;
    if (!fallbackExp || exp < fallbackExp) {
      fallbackExp = exp;
      fallback = r;
    }

    const policy = isExpiryAllowed({
      expiryISO: r.expiry,
      env,
      nowMs,
      minDaysToExpiry: env.FNO_MIN_DAYS_TO_EXPIRY,
      avoidExpiryDayAfter: env.FNO_AVOID_EXPIRY_DAY_AFTER,
    });
    if (!policy.ok) continue;

    if (!bestExp || exp < bestExp) {
      bestExp = exp;
      best = r;
    }
  }
  return best || fallback;
}

async function pickNearestFuture(kite, underlying, exchanges, nowMs = Date.now()) {
  const exList = uniq(exchanges);
  const u = String(underlying || "").toUpperCase();

  for (const ex of exList) {
    const rows = await getInstrumentsDump(kite, ex);
    const futs = (rows || []).filter((r) => {
      const seg = String(r.segment || "").toUpperCase();
      const it = String(r.instrument_type || "").toUpperCase();
      const isFuture =
        it === "FUT" ||
        it === "FUTIDX" ||
        it === "FUTSTK" ||
        seg.endsWith("-FUT");
      return isFuture && matchesUnderlying(r, u);
    });

    const best = bestRowByNearestExpiry(futs, nowMs);
    if (best) {
      return {
        underlying: u,
        instrument_token: Number(best.instrument_token),
        exchange: best.exchange || ex,
        tradingsymbol: best.tradingsymbol,
        segment: best.segment,
        expiry: best.expiry,
        lot_size: Number(best.lot_size ?? 1),
        tick_size: normalizeTickSize(best.tick_size),
      };
    }
  }
  return null;
}

async function pickSpotIndexToken(kite, underlying) {
  const u = String(underlying || "").toUpperCase();
  const rows = await getInstrumentsDump(kite, "NSE");

  const candidates = (rows || []).filter((r) => {
    const ts = String(r.tradingsymbol || "").toUpperCase();
    const name = String(r.name || "").toUpperCase();

    if (u === "NIFTY") {
      return (
        (ts.includes("NIFTY") && ts.includes("50")) ||
        (name.includes("NIFTY") && name.includes("50"))
      );
    }
    if (u === "BANKNIFTY") {
      return (
        (ts.includes("NIFTY") && ts.includes("BANK")) ||
        (name.includes("NIFTY") && name.includes("BANK"))
      );
    }
    if (u === "SENSEX") return ts.includes("SENSEX") || name.includes("SENSEX");

    return ts.includes(u) || name.includes(u);
  });

  const best =
    candidates.find((r) =>
      String(r.segment || "")
        .toUpperCase()
        .includes("IND"),
    ) ||
    candidates[0] ||
    null;

  if (!best) return null;

  return {
    underlying: u,
    instrument_token: Number(best.instrument_token),
    exchange: best.exchange || "NSE",
    tradingsymbol: best.tradingsymbol,
    segment: best.segment,
    expiry: null,
    lot_size: 1,
    tick_size: normalizeTickSize(best.tick_size),
  };
}

async function buildFnoUniverse({ kite, nowMs = Date.now() }) {
  if (!isEnabled()) {
    lastUniverse = {
      ok: true,
      enabled: false,
      universe: null,
      builtAt: new Date().toISOString(),
    };
    return lastUniverse;
  }

  const mode = String(env.FNO_MODE || "FUT").toUpperCase();
  let underlyings = parseCsvList(env.FNO_UNDERLYINGS || "");
  if (env.FNO_SINGLE_UNDERLYING_ENABLED) {
    const only = String(env.FNO_SINGLE_UNDERLYING_SYMBOL || "").trim();
    if (only) underlyings = [only];
  }
  underlyings = uniq(underlyings);
  const exchanges = parseCsvList(env.FNO_EXCHANGES || "NFO,BFO");

  const contracts = {};
  const tokens = [];
  const signalTokens = [];
  const symbols = [];

  for (const u of underlyings) {
    let picked = null;

    if (mode === "FUT") {
      picked = await pickNearestFuture(kite, u, exchanges, nowMs);
    } else if (mode === "OPT") {
      const src = String(env.OPT_UNDERLYING_SOURCE || "FUT").toUpperCase();
      const strikeRefSrc = String(
        env.OPT_STRIKE_REF_SOURCE || "SPOT",
      ).toUpperCase();
      const signalContract =
        src === "SPOT"
          ? await pickSpotIndexToken(kite, u)
          : await pickNearestFuture(kite, u, exchanges, nowMs);

      const spotRefContract = await pickSpotIndexToken(kite, u);
      const strikeRefContract =
        strikeRefSrc === "UNDERLYING"
          ? signalContract
          : spotRefContract || signalContract;

      picked = signalContract
        ? {
            ...signalContract,
            strike_ref_token: Number(
              strikeRefContract?.instrument_token ??
                signalContract.instrument_token,
            ),
            strike_ref_exchange:
              strikeRefContract?.exchange || signalContract.exchange || null,
            strike_ref_symbol:
              strikeRefContract?.tradingsymbol ||
              signalContract.tradingsymbol ||
              null,
          }
        : null;
    } else {
      throw new Error(`[fno] unsupported FNO_MODE: ${mode}`);
    }

    if (!picked) {
      logger.warn(
        { underlying: u, mode, exchanges },
        "[fno] contract not found",
      );
      continue;
    }

    contracts[u] = picked;
    if (!tokens.includes(Number(picked.instrument_token))) {
      tokens.push(Number(picked.instrument_token));
    }
    if (!signalTokens.includes(Number(picked.instrument_token))) {
      signalTokens.push(Number(picked.instrument_token));
    }
    if (
      Number.isFinite(Number(picked.strike_ref_token)) &&
      Number(picked.strike_ref_token) > 0
    ) {
      if (!tokens.includes(Number(picked.strike_ref_token))) {
        tokens.push(Number(picked.strike_ref_token));
      }
    }
    symbols.push(`${picked.exchange}:${picked.tradingsymbol}`);
  }

  const uni = {
    ok: true,
    enabled: true,
    universe: {
      ok: true,
      mode,
      underlyings,
      contracts,
      tokens,
      signalTokens,
      symbols,
      builtAt: new Date().toISOString(),
    },
  };

  lastUniverse = uni;

  if (String(env.FNO_LOG_UNIVERSE || "true").toLowerCase() === "true") {
    logger.info(uni.universe, "[fno] universe built");
  }

  return uni;
}

module.exports = {
  buildFnoUniverse,
  getLastFnoUniverse,
};
