#!/usr/bin/env node
const { DateTime } = require('luxon');

const { env } = require('../src/config');
const { connectMongo, getDb } = require('../src/db');
const { collectionName, ensureIndexes, insertManyCandles } = require('../src/market/candleStore');
const { createKiteConnect } = require('../src/kite/kiteClients');
const { readLatestTokenDoc } = require('../src/tokenStore');

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

function n(v, d = null) {
  if (v === null || v === undefined || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
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

function toDate(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function roundToStep(price, step) {
  const s = Math.max(1, Number(step ?? 1));
  return Math.round(Number(price) / s) * s;
}

function toIso(v) {
  const d = toDate(v);
  return d ? d.toISOString().slice(0, 10) : null;
}

async function maybeSyncNfoInstruments({ db, kite, optionType }) {
  const refresh = String(getArg('--refreshInstruments', 'false')) === 'true';
  if (!refresh) return;
  const rows = await kite.getInstruments('NFO');
  const wantedTypes = optionType === 'ALL' ? new Set(['CE', 'PE']) : new Set([optionType]);
  const ops = rows
    .filter((r) => wantedTypes.has(String(r.instrument_type || '').toUpperCase()))
    .map((r) => ({
      updateOne: {
        filter: { instrument_token: Number(r.instrument_token) },
        update: {
          $set: {
            instrument_token: Number(r.instrument_token),
            exchange: r.exchange,
            tradingsymbol: r.tradingsymbol,
            tick_size: Number(r.tick_size ?? 0.05),
            lot_size: Number(r.lot_size ?? 1),
            segment: r.segment,
            instrument_type: r.instrument_type,
            name: r.name,
            expiry: r.expiry,
            strike: r.strike,
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

  if (ops.length) await db.collection('instruments_cache').bulkWrite(ops, { ordered: false });
  console.log(`Synced NFO instrument cache rows: ${ops.length}`);
}

function pickNearestExpiry(rows, dayIso) {
  const valid = rows
    .map((r) => ({ ...r, expiryISO: toIso(r.expiry) }))
    .filter((r) => r.expiryISO && r.expiryISO >= dayIso)
    .sort((a, b) => String(a.expiryISO).localeCompare(String(b.expiryISO)));
  if (!valid.length) return null;
  return valid[0].expiryISO;
}

async function fetchDayUnderlyingPrice({ candleCol, token, dayIso, tz }) {
  const start = DateTime.fromISO(dayIso, { zone: tz }).startOf('day').toJSDate();
  const end = DateTime.fromISO(dayIso, { zone: tz }).endOf('day').toJSDate();
  const row = await candleCol.findOne(
    { instrument_token: Number(token), ts: { $gte: start, $lte: end } },
    { sort: { ts: 1 }, projection: { close: 1, ts: 1 } },
  );
  return row || null;
}

async function backfillTokenRange({ kite, intervalMin, token, from, to }) {
  const intervalStr = intervalMin === 1 ? 'minute' : `${intervalMin}minute`;
  const rows = await kite.getHistoricalData(String(token), intervalStr, from, to, false, false);
  return (rows || []).map((x) => ({
    instrument_token: Number(token),
    interval_min: intervalMin,
    ts: new Date(x.date),
    open: Number(x.open),
    high: Number(x.high),
    low: Number(x.low),
    close: Number(x.close),
    volume: Number(x.volume ?? 0),
    source: 'historical',
  }));
}

async function main() {
  const underlyingToken = n(getArg('--underlyingToken'), NaN);
  const underlyingSymbol = String(getArg('--underlying', '')).trim();
  const optionType = String(getArg('--optionType', 'ALL')).toUpperCase();
  const from = toDate(getArg('--from'));
  const to = toDate(getArg('--to'));
  const intervalMin = Math.max(1, n(getArg('--interval'), 1));
  const strikeStep = Math.max(1, n(getArg('--strikeStep'), 50));
  const scanSteps = Math.max(0, n(getArg('--scanSteps'), 2));
  const timezone = String(getArg('--tz', env.TIMEZONE || 'Asia/Kolkata'));

  if (!Number.isFinite(underlyingToken)) throw new Error('Missing --underlyingToken=<token>');
  if (!from || !to) throw new Error('Missing --from and --to');

  await connectMongo();
  const db = getDb();
  const candleCol = db.collection(collectionName(intervalMin));

  const { accessToken } = await readLatestTokenDoc();
  if (!accessToken) throw new Error('No Kite access token found for downloader');
  const kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });

  await maybeSyncNfoInstruments({ db, kite, optionType });

  const root = chainRootFromSpot(underlyingSymbol);
  const typeQuery = optionType === 'ALL' ? { $in: ['CE', 'PE'] } : optionType;
  const instruments = await db
    .collection('instruments_cache')
    .find({ name: root, instrument_type: typeQuery })
    .project({ instrument_token: 1, strike: 1, expiry: 1, instrument_type: 1, tradingsymbol: 1, name: 1 })
    .toArray();

  if (!instruments.length) throw new Error(`No instruments_cache options for ${root} ${optionType}`);

  await ensureIndexes(intervalMin);

  let day = DateTime.fromJSDate(from, { zone: timezone }).startOf('day');
  const endDay = DateTime.fromJSDate(to, { zone: timezone }).startOf('day');

  const selectedTokens = new Set();

  while (day <= endDay) {
    const dayIso = day.toISODate();
    const spot = await fetchDayUnderlyingPrice({ candleCol, token: underlyingToken, dayIso, tz: timezone });
    if (!spot) {
      day = day.plus({ days: 1 });
      continue;
    }

    const expiry = pickNearestExpiry(instruments, dayIso);
    if (!expiry) {
      day = day.plus({ days: 1 });
      continue;
    }

    const atm = roundToStep(Number(spot.close), strikeStep);
    const minStrike = atm - scanSteps * strikeStep;
    const maxStrike = atm + scanSteps * strikeStep;

    const dayTokens = instruments
      .filter((r) => toIso(r.expiry) === expiry)
      .filter((r) => Number(r.strike) >= minStrike && Number(r.strike) <= maxStrike)
      .map((r) => Number(r.instrument_token))
      .filter((tok) => Number.isFinite(tok));

    dayTokens.forEach((tok) => selectedTokens.add(tok));
    console.log(`[${dayIso}] expiry=${expiry} spot=${Number(spot.close).toFixed(2)} atm=${atm} tokens=${dayTokens.length}`);
    day = day.plus({ days: 1 });
  }

  const fromDate = new Date(from);
  const toDateObj = new Date(to);
  let totalCandles = 0;

  for (const token of selectedTokens) {
    const candles = await backfillTokenRange({
      kite,
      intervalMin,
      token,
      from: fromDate,
      to: toDateObj,
    });
    await insertManyCandles(intervalMin, candles);
    totalCandles += candles.length;
    console.log(`backfilled token=${token} candles=${candles.length}`);
  }

  console.log(`Done. selectedTokens=${selectedTokens.size} insertedCandles=${totalCandles}`);
}

main().catch((err) => {
  console.error('bt_prepare_option_universe failed', err);
  process.exit(1);
});
