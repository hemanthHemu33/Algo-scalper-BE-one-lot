#!/usr/bin/env node
/**
 * Backfill historical candles for a single instrument token into MongoDB for backtesting.
 *
 * Usage (PowerShell-friendly single line):
 *   npm run bt:backfill -- --token=256265 --from=2026-01-01 --to=2026-01-31T23:59:59+05:30 --interval=1 --chunkDays=10
 */

const { DateTime } = require("luxon");
const { env } = require("../src/config");
const { connectMongo, getDb } = require("../src/db");
const {
  ensureIndexes,
  insertManyCandles,
  collectionName,
} = require("../src/market/candleStore");
const { createKiteConnect } = require("../src/kite/kiteClients");
const { readLatestTokenDoc } = require("../src/tokenStore");

function getArg(name, fb = null) {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fb;
}

function toNum(v, fb = null) {
  if (v === null || v === undefined || v === '') return fb;
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function toDate(v) {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isValidDate(d) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function parseKiteDate(v) {
  // Kite may return Date objects or ISO strings depending on client version.
  if (v instanceof Date) return isValidDate(v) ? v : null;
  const s = String(v || '').trim();
  if (!s) return null;

  // Native ISO parse
  const d1 = new Date(s);
  if (isValidDate(d1)) return d1;

  // Some feeds may send without timezone; interpret as Asia/Kolkata
  const dt = DateTime.fromFormat(s, "yyyy-LL-dd HH:mm:ss", { zone: "Asia/Kolkata" });
  if (dt.isValid) return dt.toJSDate();

  const dt2 = DateTime.fromISO(s, { setZone: true });
  if (dt2.isValid) return dt2.toJSDate();

  return null;
}

function intervalStr(intervalMin) {
  // KiteConnect expects: "minute", "3minute", "5minute", etc.
  return intervalMin === 1 ? "minute" : `${intervalMin}minute`;
}

async function fetchChunk({ kite, token, intervalMin, from, to }) {
  const rows = await kite.getHistoricalData(
    String(token),
    intervalStr(intervalMin),
    from,
    to,
    false,
    false
  );

  const out = [];
  let bad = 0;
  for (const x of rows || []) {
    const ts = parseKiteDate(x.date);
    if (!ts) {
      bad += 1;
      continue;
    }
    out.push({
      instrument_token: Number(token),
      interval_min: intervalMin,
      ts,
      open: Number(x.open),
      high: Number(x.high),
      low: Number(x.low),
      close: Number(x.close),
      volume: Number(x.volume ?? 0),
      source: "historical",
    });
  }
  if (bad > 0) {
    console.warn(`[bt_backfill] WARN: skipped ${bad} rows with unparseable date for token=${token}`);
  }
  return out;
}

async function main() {
  const token = toNum(getArg("--token"), NaN);
  const from = toDate(getArg("--from"));
  const to = toDate(getArg("--to"));
  const intervalMin = Math.max(1, toNum(getArg("--interval"), 1));

  const tz = String(getArg("--tz", env.TIMEZONE || "Asia/Kolkata"));
  const chunkDays = Math.max(
    1,
    toNum(getArg("--chunkDays"), intervalMin === 1 ? 10 : 30)
  );

  if (!Number.isFinite(token)) {
    throw new Error("Missing/invalid --token=<instrument_token>");
  }
  if (!from || !to) {
    throw new Error(
      "Missing/invalid --from=<YYYY-MM-DD> and --to=<YYYY-MM-DD or ISO>"
    );
  }

  await connectMongo();
  const db = getDb();

  const colName = collectionName(intervalMin);
  console.log(
    `[bt_backfill] db=${env.MONGO_DB} col=${colName} token=${token} interval=${intervalMin}m tz=${tz}`
  );

  await ensureIndexes(intervalMin);

  const { accessToken } = await readLatestTokenDoc();
  if (!accessToken) {
    throw new Error(
      "No Kite access token found in token store. Ensure TOKENS_COLLECTION is set and contains an access_token."
    );
  }

  const kite = createKiteConnect({ apiKey: env.KITE_API_KEY, accessToken });

  let cursor = DateTime.fromJSDate(from, { zone: tz }).startOf("day");
  const end = DateTime.fromJSDate(to, { zone: tz }).endOf("day");

  let total = 0;
  while (cursor <= end) {
    const chunkEnd = DateTime.min(
      cursor.plus({ days: chunkDays }).endOf("day"),
      end
    );

    const fromIso = cursor.toISO();
    const toIso = chunkEnd.toISO();

    console.log(`[bt_backfill] fetching ${fromIso} -> ${toIso}`);

    const candles = await fetchChunk({
      kite,
      token,
      intervalMin,
      from: new Date(fromIso),
      to: new Date(toIso),
    });

    await insertManyCandles(intervalMin, candles);
    total += candles.length;

    console.log(`[bt_backfill] inserted/upserted ${candles.length} (total ${total})`);

    cursor = chunkEnd.plus({ minutes: 1 });
  }

  const count = await db
    .collection(colName)
    .countDocuments({ instrument_token: Number(token) });
  console.log(
    `[bt_backfill] done. token=${token} now has ${count} candles in ${colName}`
  );
}

main().catch((e) => {
  console.error("bt_backfill failed", e);
  process.exit(1);
});
