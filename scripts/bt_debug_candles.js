#!/usr/bin/env node

const { DateTime } = require('luxon');

const { env } = require('../src/config');
const { connectMongo, getDb } = require('../src/db');
const { collectionName } = require('../src/market/candleStore');

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

function n(v, d = null) {
  if (v === null || v === undefined || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function parseMs(arg, { tz, endOfDay = false } = {}) {
  if (!arg) return null;
  const s = String(arg).trim();
  // Date-only: treat as local tz day boundary
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const dt = DateTime.fromISO(s, { zone: tz || 'Asia/Kolkata' });
    return (endOfDay ? dt.endOf('day') : dt.startOf('day')).toMillis();
  }
  const d = new Date(s);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

async function main() {
  const token = n(getArg('--token'), NaN);
  const intervalMin = Math.max(1, n(getArg('--interval'), 1));
  const tz = String(getArg('--tz', env.CANDLE_TZ || env.TIMEZONE || 'Asia/Kolkata'));
  const fromMs = parseMs(getArg('--from'), { tz, endOfDay: false });
  const toMs = parseMs(getArg('--to'), { tz, endOfDay: true });
  const limit = Math.max(10, n(getArg('--limit'), 50));

  if (!Number.isFinite(token)) throw new Error('Missing --token=<instrument_token>');

  await connectMongo();
  const db = getDb();
  const colName = collectionName(intervalMin);
  const col = db.collection(colName);

  const baseQ = { instrument_token: Number(token) };

  const total = await col.countDocuments(baseQ);
  const minDoc = await col.find(baseQ).sort({ ts: 1 }).limit(1).project({ ts: 1, close: 1 }).toArray();
  const maxDoc = await col.find(baseQ).sort({ ts: -1 }).limit(1).project({ ts: 1, close: 1 }).toArray();

  const typeAgg = await col
    .aggregate([
      { $match: baseQ },
      { $project: { t: { $type: '$ts' } } },
      { $group: { _id: '$t', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  let rangeCount = null;
  let sample = [];
  if (fromMs || toMs) {
    const q = { ...baseQ, ts: {} };
    if (fromMs) q.ts.$gte = new Date(fromMs);
    if (toMs) q.ts.$lte = new Date(toMs);
    rangeCount = await col.countDocuments(q);
    sample = await col
      .find(q)
      .sort({ ts: 1 })
      .limit(limit)
      .project({ ts: 1, open: 1, high: 1, low: 1, close: 1, source: 1 })
      .toArray();
  }

  console.log(`[bt_debug] db=${env.MONGO_DB} col=${colName} token=${token} interval=${intervalMin}m tz=${tz}`);
  console.log(`[bt_debug] totalForToken=${total}`);
  console.log(`[bt_debug] tsTypes=${JSON.stringify(typeAgg)}`);
  console.log(`[bt_debug] minTs=${minDoc[0]?.ts || null} maxTs=${maxDoc[0]?.ts || null}`);

  if (fromMs || toMs) {
    console.log(`[bt_debug] range from=${fromMs ? new Date(fromMs).toISOString() : null} to=${toMs ? new Date(toMs).toISOString() : null} rangeCount=${rangeCount}`);
    if (sample.length) {
      console.log(`[bt_debug] first ${sample.length} candles in range:`);
      for (const r of sample.slice(0, Math.min(sample.length, 10))) {
        console.log(`  ts=${r.ts?.toISOString?.() || r.ts} O=${r.open} H=${r.high} L=${r.low} C=${r.close} src=${r.source}`);
      }
      if (sample.length > 10) console.log(`  ... (${sample.length - 10} more not shown)`);
    }
  }
}

main().catch((e) => {
  console.error('bt_debug_candles failed', e);
  process.exit(1);
});
