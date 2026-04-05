#!/usr/bin/env node
/**
 * Fix candle ts field type for backtesting.
 *
 * Symptom:
 *  - bt:backfill shows candles exist (count by token works)
 *  - bt:run / bt:prepare-options cannot find candles when using ts range ($gte/$lte)
 *
 * Root cause:
 *  - ts stored as STRING (or other non-Date type) so comparisons with Date don't match.
 *
 * This script converts ts to a proper BSON Date for a given token + interval.
 *
 * Usage:
 *   node scripts/bt_fix_candle_ts.js --token=256265 --interval=1
 */

const { DateTime } = require('luxon');
const { connectMongo, getDb } = require('../src/db');
const { collectionName, ensureIndexes } = require('../src/market/candleStore');

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

function n(v, d = null) {
  if (v === null || v === undefined || v === '') return d;
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function isValidDate(d) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function parseToDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return isValidDate(v) ? v : null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return isValidDate(d) ? d : null;
  }
  const s = String(v).trim();
  if (!s) return null;

  // Try native Date first (handles ISO)
  const d1 = new Date(s);
  if (isValidDate(d1)) return d1;

  // Try common formats
  const fmts = [
    "yyyy-LL-dd HH:mm:ss",
    "yyyy-LL-dd'T'HH:mm:ss",
    "yyyy-LL-dd'T'HH:mm:ss.SSS",
    "dd-LLL-yyyy",
    "dd-LLL-yy",
    "dd/MM/yyyy HH:mm:ss",
  ];
  for (const f of fmts) {
    const dt = DateTime.fromFormat(s, f, { zone: 'Asia/Kolkata' });
    if (dt.isValid) return dt.toJSDate();
  }

  // Last attempt: ISO via luxon (sometimes more forgiving)
  const dtIso = DateTime.fromISO(s, { setZone: true });
  if (dtIso.isValid) return dtIso.toJSDate();

  return null;
}

function bsonTypeName(v) {
  if (v == null) return 'null';
  if (v instanceof Date) return 'date';
  return typeof v;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const token = n(getArg('--token'), NaN);
  const intervalMin = Math.max(1, n(getArg('--interval'), 1));
  const batchSize = Math.max(100, n(getArg('--batch'), 1000));

  if (!Number.isFinite(token)) throw new Error('Missing --token=<instrument_token>');

  await connectMongo();
  const db = getDb();
  const colName = collectionName(intervalMin);
  const col = db.collection(colName);

  await ensureIndexes(intervalMin);

  const any = await col.findOne(
    { instrument_token: Number(token) },
    { projection: { ts: 1 }, sort: { ts: 1 } }
  );

  if (!any) {
    console.log(`[bt_fix_ts] No documents found for token=${token} in ${colName}`);
    return;
  }

  console.log(`[bt_fix_ts] token=${token} collection=${colName} sample.tsType=${bsonTypeName(any.ts)} sample.ts=${String(any.ts)}`);

  // Only convert docs where ts is not a Date
  const cursor = col
    .find({ instrument_token: Number(token), ts: { $not: { $type: 'date' } } })
    .project({ _id: 1, ts: 1 });

  const docs = await cursor.toArray();
  if (!docs.length) {
    console.log('[bt_fix_ts] ts already Date for all docs. Nothing to do.');
    return;
  }

  console.log(`[bt_fix_ts] Found ${docs.length} docs with non-Date ts. Converting in batches of ${batchSize}...`);

  let fixed = 0;
  let skipped = 0;
  const ops = [];

  for (const d of docs) {
    const parsed = parseToDate(d.ts);
    if (!parsed) {
      skipped += 1;
      continue;
    }
    ops.push({
      updateOne: {
        filter: { _id: d._id },
        update: { $set: { ts: parsed, updatedAt: new Date() } },
      },
    });

    if (ops.length >= batchSize) {
      await col.bulkWrite(ops, { ordered: false });
      fixed += ops.length;
      ops.length = 0;
      console.log(`[bt_fix_ts] converted ${fixed}/${docs.length} (skipped ${skipped})`);
    }
  }

  if (ops.length) {
    await col.bulkWrite(ops, { ordered: false });
    fixed += ops.length;
    console.log(`[bt_fix_ts] converted ${fixed}/${docs.length} (skipped ${skipped})`);
  }

  // Show min/max ts after conversion
  const minRow = await col.find({ instrument_token: Number(token) }).sort({ ts: 1 }).limit(1).project({ ts: 1 }).toArray();
  const maxRow = await col.find({ instrument_token: Number(token) }).sort({ ts: -1 }).limit(1).project({ ts: 1 }).toArray();

  console.log('[bt_fix_ts] Done.');
  console.log(`[bt_fix_ts] minTs=${minRow?.[0]?.ts?.toISOString?.() || String(minRow?.[0]?.ts)}`);
  console.log(`[bt_fix_ts] maxTs=${maxRow?.[0]?.ts?.toISOString?.() || String(maxRow?.[0]?.ts)}`);
}

main().catch((e) => {
  console.error('bt_fix_ts failed', e);
  process.exit(1);
});
