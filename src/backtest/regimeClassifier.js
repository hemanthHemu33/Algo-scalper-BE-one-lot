const { DateTime } = require("luxon");

function n(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function averageRange(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const ranges = candles
    .map((candle) => {
      const high = n(candle?.high);
      const low = n(candle?.low);
      return Number.isFinite(high) && Number.isFinite(low) ? Math.abs(high - low) : null;
    })
    .filter((value) => Number.isFinite(value));
  if (!ranges.length) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function classifySessionTag(ts, timezone = "Asia/Kolkata") {
  const dt = DateTime.fromJSDate(new Date(ts), { zone: timezone });
  if (!dt.isValid) return "UNKNOWN_SESSION";
  const minutes = dt.hour * 60 + dt.minute;
  if (minutes < 10 * 60 + 15) return "OPENING_SESSION";
  if (minutes >= 13 * 60 + 30) return "CLOSING_SESSION";
  return "MIDDAY";
}

function classifyVolatilityTag({ candles, currentCandle }) {
  const close = n(currentCandle?.close);
  const avg = averageRange((candles || []).slice(-20));
  if (!(Number.isFinite(close) && close > 0) || !Number.isFinite(avg)) return "LOW_VOL";
  return (avg / close) * 100 >= 0.8 ? "HIGH_VOL" : "LOW_VOL";
}

function classifyTrendTag(candles) {
  const tail = (candles || []).slice(-20);
  if (tail.length < 5) return "RANGE";
  const first = n(tail[0]?.open);
  const last = n(tail[tail.length - 1]?.close);
  const avg = averageRange(tail);
  if (!(Number.isFinite(first) && Number.isFinite(last) && Number.isFinite(avg) && avg > 0)) return "RANGE";
  return Math.abs(last - first) >= avg * 1.5 ? "TREND" : "RANGE";
}

function classifyExpiryTag({ ts, expiry, timezone = "Asia/Kolkata" }) {
  if (!expiry) return "NON_EXPIRY_DAY";
  const left = DateTime.fromJSDate(new Date(ts), { zone: timezone });
  const right = DateTime.fromJSDate(new Date(expiry), { zone: timezone });
  if (!left.isValid || !right.isValid) return "NON_EXPIRY_DAY";
  return left.toISODate() === right.toISODate() ? "EXPIRY_DAY" : "NON_EXPIRY_DAY";
}

function classifyRegimeTags({
  candles,
  currentCandle,
  signal,
  selectedContract,
  timezone = "Asia/Kolkata",
}) {
  return Array.from(
    new Set(
      [
        signal?.regime || classifyTrendTag(candles),
        classifyVolatilityTag({ candles, currentCandle }),
        classifySessionTag(currentCandle?.ts || signal?.ts, timezone),
        classifyExpiryTag({
          ts: currentCandle?.ts || signal?.ts,
          expiry: selectedContract?.selected?.expiry || selectedContract?.selected?.expiryISO || null,
          timezone,
        }),
      ].filter(Boolean),
    ),
  );
}

function primaryRegime(tags, fallback = "UNKNOWN") {
  return Array.isArray(tags) && tags.length ? tags[0] : fallback;
}

module.exports = {
  classifyExpiryTag,
  classifyRegimeTags,
  classifySessionTag,
  classifyTrendTag,
  classifyVolatilityTag,
  primaryRegime,
};
