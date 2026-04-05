const { DateTime } = require('luxon');
const { collectionName } = require('../market/candleStore');
const { computeGreeksFromMarket } = require('../fno/greeks');

function n(v, d = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function toIsoDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString().slice(0, 10);
}

function roundToStep(price, step) {
  const s = Math.max(1, Number(step ?? 1));
  return Math.round(Number(price) / s) * s;
}

function chainRootFromSpot(tradingsymbol) {
  const m = {
    'NIFTY 50': 'NIFTY',
    'NIFTY BANK': 'BANKNIFTY',
    'NIFTY FIN SERVICE': 'FINNIFTY',
    'NIFTY MID SELECT': 'MIDCPNIFTY',
  };
  const key = String(tradingsymbol || '').toUpperCase().trim();
  return m[key] || key;
}

function parseExpiryTs(expiry, tz = 'Asia/Kolkata') {
  const iso = toIsoDate(expiry);
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: tz }).set({
    hour: 15,
    minute: 30,
    second: 0,
    millisecond: 0,
  });
  return dt.isValid ? dt.toMillis() : null;
}

async function buildOptionBacktestProvider({
  db,
  intervalMin,
  from,
  to,
  underlyingToken,
  underlyingTradingsymbol,
  optionType = 'CE',
  strikeStep = 50,
  scanSteps = 2,
  greeks = { enabled: false, minDelta: 0.2, maxDelta: 0.85, ivMax: 2.5 },
}) {
  const tsFrom = from ? new Date(from) : null;
  const tsTo = to ? new Date(to) : null;
  const root = chainRootFromSpot(underlyingTradingsymbol || '');

  const instruments = await db
    .collection('instruments_cache')
    .find({
      name: root,
      instrument_type: String(optionType || 'CE').toUpperCase(),
    })
    .toArray();

  if (!instruments.length) {
    return {
      ready: false,
      reason: `No option instruments for ${root} ${optionType}`,
      selectContract: () => null,
      getCandlesByToken: () => [],
    };
  }

  const byToken = new Map();
  for (const i of instruments) byToken.set(Number(i.instrument_token), i);

  const candleCol = db.collection(collectionName(intervalMin));

  const expirySet = new Set(instruments.map((i) => toIsoDate(i.expiry)).filter(Boolean));
  const expiries = Array.from(expirySet).sort();

  const strikeByExpiry = new Map();
  for (const exp of expiries) {
    const rows = instruments
      .filter((i) => toIsoDate(i.expiry) === exp)
      .map((i) => ({ token: Number(i.instrument_token), strike: n(i.strike, null) }))
      .filter((r) => r.strike !== null)
      .sort((a, b) => a.strike - b.strike);
    strikeByExpiry.set(exp, rows);
  }

  const tokenCandleMap = new Map();
  let duplicateTimestampCount = 0;
  const allTokenIds = instruments.map((i) => Number(i.instrument_token)).filter((x) => Number.isFinite(x));
  const q = { instrument_token: { $in: allTokenIds } };
  if (tsFrom || tsTo) {
    q.ts = {};
    if (tsFrom) q.ts.$gte = tsFrom;
    if (tsTo) q.ts.$lte = tsTo;
  }

  const optionCandles = await candleCol.find(q).project({ instrument_token: 1, ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }).toArray();
  for (const c of optionCandles) {
    const tok = Number(c.instrument_token);
    if (!tokenCandleMap.has(tok)) tokenCandleMap.set(tok, new Map());
    const key = new Date(c.ts).toISOString();
    if (tokenCandleMap.get(tok).has(key)) duplicateTimestampCount += 1;
    tokenCandleMap.get(tok).set(key, c);
  }

  function pickExpiry(tsMs) {
    const now = Number(tsMs);
    let chosen = expiries[0] || null;
    for (const exp of expiries) {
      const eTs = parseExpiryTs(exp);
      if (Number.isFinite(eTs) && eTs >= now) {
        chosen = exp;
        break;
      }
    }
    return chosen;
  }

  function getCandidateRows({ underlyingPrice, tsMs }) {
    const expiryISO = pickExpiry(tsMs);
    if (!expiryISO) return [];
    const atm = roundToStep(underlyingPrice, strikeStep);
    const minStrike = atm - Math.max(0, Number(scanSteps ?? 0)) * strikeStep;
    const maxStrike = atm + Math.max(0, Number(scanSteps ?? 0)) * strikeStep;
    const strikes = strikeByExpiry.get(expiryISO) || [];

    return strikes
      .filter((r) => r.strike >= minStrike && r.strike <= maxStrike)
      .map((r) => {
        const row = byToken.get(r.token);
        const candle = tokenCandleMap.get(r.token)?.get(new Date(tsMs).toISOString()) || null;
        if (!candle) return null;

        const close = n(candle.close, null);
        const volume = n(candle.volume, 0);
        const dteYears = Math.max(1 / 365, ((parseExpiryTs(expiryISO) || tsMs) - tsMs) / (365 * 24 * 60 * 60 * 1000));
        const g = greeks?.enabled
          ? computeGreeksFromMarket({
              S: Math.max(0.01, Number(underlyingPrice ?? 0)),
              K: Number(r.strike ?? 0),
              r: 0.06,
              T: dteYears,
              isCall: String(optionType).toUpperCase() === 'CE',
              marketPrice: Math.max(0.01, Number(close ?? 0)),
            })
          : null;

        return {
          token: Number(r.token),
          strike: Number(r.strike),
          expiryISO,
          close,
          volume,
          spreadBps: null,
          instrument: row,
          greeks: g,
          deltaAbs: Number.isFinite(g?.delta) ? Math.abs(g.delta) : null,
          iv: Number.isFinite(g?.iv) ? g.iv : null,
        };
      })
      .filter(Boolean);
  }

  function scoreRow(row, underlyingPrice) {
    const distance = Math.abs(Number(row.strike ?? 0) - Number(underlyingPrice ?? 0));
    const liquidityBoost = Math.log(Number(row.volume ?? 0) + 1);
    return distance - liquidityBoost * 5;
  }

  function passGreeks(row) {
    if (!greeks?.enabled) return true;
    if (!row?.greeks) return false;
    const d = Number(row.deltaAbs);
    const iv = Number(row.iv);
    if (Number.isFinite(greeks.minDelta) && d < Number(greeks.minDelta)) return false;
    if (Number.isFinite(greeks.maxDelta) && d > Number(greeks.maxDelta)) return false;
    if (Number.isFinite(greeks.ivMax) && Number.isFinite(iv) && iv > Number(greeks.ivMax)) return false;
    return true;
  }

  return {
    ready: true,
    stats: {
      optionTokens: allTokenIds.length,
      optionCandles: optionCandles.length,
      expiryCount: expiries.length,
      duplicateTimestampCount,
      tokensWithoutCandles: allTokenIds.filter((token) => !tokenCandleMap.get(token)?.size).length,
    },
    listTokens() {
      return allTokenIds.slice();
    },
    listInstruments() {
      return instruments.slice();
    },
    getInstrument(token) {
      return byToken.get(Number(token)) || null;
    },
    getCandlesByToken(token) {
      return Array.from(tokenCandleMap.get(Number(token))?.values() || []).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    },
    getCandleAtTs(token, ts) {
      const key = new Date(ts).toISOString();
      return tokenCandleMap.get(Number(token))?.get(key) || null;
    },
    getCandlesUpToTs(token, ts) {
      const limitTs = new Date(ts).getTime();
      if (!Number.isFinite(limitTs)) return [];
      return this.getCandlesByToken(token).filter((c) => new Date(c.ts).getTime() <= limitTs);
    },
    selectContract({ ts, underlyingPrice }) {
      const tsMs = new Date(ts).getTime();
      if (!(Number.isFinite(tsMs) && Number.isFinite(Number(underlyingPrice)))) return null;
      const rows = getCandidateRows({ underlyingPrice: Number(underlyingPrice), tsMs });
      if (!rows.length) return null;
      const filtered = rows.filter(passGreeks);
      const pool = filtered.length ? filtered : rows;
      pool.sort((a, b) => scoreRow(a, underlyingPrice) - scoreRow(b, underlyingPrice));
      const best = pool[0];
      return {
        selectedToken: best.token,
        selected: {
          ...best,
          selectionModel: "BACKTEST_SIMPLIFIED",
          liveEquivalent: false,
        },
        snapshot: {
          underlyingToken: Number(underlyingToken),
          underlyingPrice: Number(underlyingPrice),
          ts: new Date(tsMs),
          optionType: String(optionType).toUpperCase(),
          rows: pool,
          selectedToken: best.token,
          selectionModel: "BACKTEST_SIMPLIFIED",
          liveEquivalent: false,
          parity: "NON_LIVE_EQUIVALENT",
        },
      };
    },
  };
}

module.exports = { buildOptionBacktestProvider };
