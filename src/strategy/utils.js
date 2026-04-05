const { DateTime } = require("luxon");
const { env } = require("../config");
const {
  getSessionForDateTime,
  buildBoundsForToday,
} = require("../market/marketCalendar");

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  const s = arr.reduce((a, b) => a + Number(b ?? 0), 0);
  return s / arr.length;
}

function strategyTimezone() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function toDateTime(value, tz = strategyTimezone()) {
  if (value == null) return DateTime.invalid("missing ts");
  return DateTime.fromJSDate(new Date(value)).setZone(tz);
}

function buildSessionBounds(reference, opts = {}) {
  const ref = DateTime.isDateTime(reference)
    ? reference.setZone(strategyTimezone())
    : toDateTime(reference, opts.timezone || strategyTimezone());
  if (!ref.isValid) return null;

  const session = getSessionForDateTime(ref, {
    marketOpen: opts.marketOpen || env.MARKET_OPEN,
    marketClose: opts.marketClose || env.MARKET_CLOSE,
    stopNewEntriesAfter: opts.stopNewEntriesAfter || env.STOP_NEW_ENTRIES_AFTER,
  });
  const bounds = buildBoundsForToday(session, ref);
  if (!bounds.open?.isValid || !bounds.close?.isValid) return null;

  return {
    open: bounds.open,
    close: bounds.close,
    session,
  };
}

function getSessionWindow(candles, sessionDate, opts = {}) {
  const bounds = buildSessionBounds(sessionDate, opts);
  if (!bounds) return [];
  const endBound = opts.endTs
    ? DateTime.min(
        toDateTime(opts.endTs, opts.timezone || strategyTimezone()),
        bounds.close,
      )
    : bounds.close;

  return (candles || []).filter((candle) => {
    const candleTs = toDateTime(candle?.ts, opts.timezone || strategyTimezone());
    if (!candleTs.isValid) return false;
    return candleTs >= bounds.open && candleTs <= endBound;
  });
}

function getCurrentSessionCandles(candles, opts = {}) {
  const refTs = opts.endTs ?? candles?.[candles.length - 1]?.ts;
  if (!refTs) return [];
  return getSessionWindow(candles, refTs, opts);
}

function sessionCandles(candles, endTs) {
  return getCurrentSessionCandles(candles, { endTs });
}

function splitCurrentVsPreviousSession(candles, opts = {}) {
  const currentSession = getCurrentSessionCandles(candles, opts);
  if (!currentSession.length) {
    return { currentSession: [], previousSession: [], priorBars: [] };
  }

  const currentOpenMs = new Date(currentSession[0].ts).getTime();
  const priorBars = (candles || []).filter((candle) => {
    const ts = candle?.ts ? new Date(candle.ts).getTime() : NaN;
    return Number.isFinite(ts) && ts < currentOpenMs;
  });
  const previousSessionRef = priorBars[priorBars.length - 1]?.ts || null;
  const previousSession = previousSessionRef
    ? getSessionWindow(priorBars, previousSessionRef, opts)
    : [];

  return {
    currentSession,
    previousSession,
    priorBars,
  };
}

function previousSessionLevels(candles, opts = {}) {
  const { previousSession } = splitCurrentVsPreviousSession(candles, opts);
  if (!previousSession.length) return null;

  return {
    high: maxHigh(previousSession),
    low: minLow(previousSession),
    close: Number(previousSession[previousSession.length - 1]?.close),
    open: Number(previousSession[0]?.open),
    ts: previousSession[previousSession.length - 1]?.ts || null,
  };
}

function currentSessionLevels(candles, opts = {}) {
  const currentSession = getCurrentSessionCandles(candles, opts);
  if (!currentSession.length) return null;

  return {
    high: maxHigh(currentSession),
    low: minLow(currentSession),
    close: Number(currentSession[currentSession.length - 1]?.close),
    open: Number(currentSession[0]?.open),
    startTs: currentSession[0]?.ts || null,
    endTs: currentSession[currentSession.length - 1]?.ts || null,
  };
}

function openingRangeLevels(candles, opts = {}) {
  const refTs = opts.endTs ?? candles?.[candles.length - 1]?.ts;
  const sessionBars = getCurrentSessionCandles(candles, { ...opts, endTs: refTs });
  const bounds = refTs ? buildSessionBounds(refTs, opts) : null;
  const orbMinutes = Math.max(1, Number(opts.orbMinutes ?? env.ORB_MINUTES ?? 15));
  if (!sessionBars.length || !bounds) {
    return {
      high: null,
      low: null,
      open: null,
      close: null,
      barsUsed: 0,
      complete: false,
      completedAt: null,
      orbMinutes,
    };
  }

  const completedAt = bounds.open.plus({ minutes: orbMinutes });
  const opening = sessionBars.filter((candle) => {
    const candleTs = toDateTime(candle?.ts, opts.timezone || strategyTimezone());
    return candleTs.isValid && candleTs >= bounds.open && candleTs < completedAt;
  });

  return {
    high: opening.length ? maxHigh(opening) : null,
    low: opening.length ? minLow(opening) : null,
    open: opening.length ? Number(opening[0]?.open) : null,
    close: opening.length ? Number(opening[opening.length - 1]?.close) : null,
    barsUsed: opening.length,
    complete:
      opening.length > 0 &&
      toDateTime(refTs, opts.timezone || strategyTimezone()) >= completedAt,
    completedAt: completedAt.toISO(),
    orbMinutes,
  };
}

function sessionGapContext(candles, opts = {}) {
  const currentSession = getCurrentSessionCandles(candles, opts);
  const previous = previousSessionLevels(candles, opts);
  if (!currentSession.length) return null;

  const currentOpen = Number(currentSession[0]?.open);
  const prevClose = Number(previous?.close);
  if (!Number.isFinite(currentOpen) || !Number.isFinite(prevClose) || prevClose === 0) {
    return {
      direction: "UNKNOWN",
      sizeBucket: "UNKNOWN",
      gapPct: null,
      previousClose: Number.isFinite(prevClose) ? prevClose : null,
      currentOpen: Number.isFinite(currentOpen) ? currentOpen : null,
    };
  }

  const gapPct = (currentOpen - prevClose) / prevClose;
  const absGap = Math.abs(gapPct);
  const direction =
    gapPct > 0.001 ? "UP" : gapPct < -0.001 ? "DOWN" : "FLAT";
  const sizeBucket =
    absGap >= 0.008
      ? "LARGE"
      : absGap >= 0.003
        ? "MEDIUM"
        : absGap >= 0.001
          ? "SMALL"
          : "NONE";

  return {
    direction,
    sizeBucket,
    gapPct,
    previousClose: prevClose,
    currentOpen,
  };
}

function sessionContextSummary(candles, opts = {}) {
  const refTs = opts.endTs ?? candles?.[candles.length - 1]?.ts;
  if (!refTs) return null;

  const bounds = buildSessionBounds(refTs, opts);
  const ref = toDateTime(refTs, opts.timezone || strategyTimezone());
  const currentSession = currentSessionLevels(candles, { ...opts, endTs: refTs });
  const previousSession = previousSessionLevels(candles, { ...opts, endTs: refTs });
  const openingRange = openingRangeLevels(candles, { ...opts, endTs: refTs });
  const gapContext = sessionGapContext(candles, { ...opts, endTs: refTs });

  return {
    sessionDate: ref.isValid ? ref.toISODate() : null,
    sessionElapsedMin:
      bounds?.open && ref.isValid
        ? Math.max(0, Math.round(ref.diff(bounds.open, "minutes").minutes))
        : null,
    currentSession,
    previousSession,
    previousClose: Number.isFinite(Number(previousSession?.close))
      ? Number(previousSession.close)
      : null,
    openingRange,
    gapContext,
  };
}

function avgVolume(candles, lookback = 20) {
  const slice = (candles || []).slice(-lookback);
  return avg(slice.map((c) => Number(c?.volume ?? 0)));
}

function avgVolumePriorBars(candles, lookback = 20, opts = {}) {
  const sessionOnly = opts.sessionOnly === true;
  const endTs = opts.endTs ?? candles?.[candles.length - 1]?.ts;
  const minBars = Math.max(1, Number(opts.minBars ?? 1));
  const excludeCurrent = Math.max(1, Number(opts.excludeCurrent ?? 1));
  const requestedBars = Math.max(1, Number(lookback ?? 1));
  const fallbackMode = String(opts.fallbackMode || "none");

  const source = sessionOnly
    ? getCurrentSessionCandles(candles, { ...opts, endTs })
    : (candles || []);
  let priorBars = source.slice(0, Math.max(0, source.length - excludeCurrent));
  let validBars = priorBars.filter((candle) => {
    const vol = Number(candle?.volume ?? 0);
    return Number.isFinite(vol) && vol > 0;
  });

  let usedBars = validBars.slice(-requestedBars);
  let fallbackUsed = false;
  let sourceMode = sessionOnly ? "SESSION" : "ALL";

  if (usedBars.length < minBars && fallbackMode === "prior-valid") {
    priorBars = (candles || []).slice(0, Math.max(0, (candles || []).length - excludeCurrent));
    validBars = priorBars.filter((candle) => {
      const vol = Number(candle?.volume ?? 0);
      return Number.isFinite(vol) && vol > 0;
    });
    usedBars = validBars.slice(-Math.max(requestedBars, minBars));
    fallbackUsed = usedBars.length >= minBars;
    if (fallbackUsed) sourceMode = "ALL_PRIOR_VALID";
  }

  const average = usedBars.length
    ? avg(usedBars.map((candle) => Number(candle?.volume ?? 0)))
    : null;
  return {
    average: Number.isFinite(average) && average > 0 ? average : null,
    barsUsed: usedBars.length,
    requestedBars,
    completeness: requestedBars > 0 ? clamp(usedBars.length / requestedBars, 0, 1) : 1,
    fallbackUsed,
    sessionOnly: sessionOnly && !fallbackUsed,
    sourceMode,
  };
}

function volumeConfirmation(candles, opts = {}) {
  const lookback = Number(opts.lookback ?? 20);
  const mult = Number(opts.mult ?? 1);
  const required = opts.required !== false;
  const baseline = avgVolumePriorBars(candles, lookback, opts);
  const current = candles?.[candles.length - 1];
  const currentVolume = Number(current?.volume ?? 0);

  if (!Number.isFinite(currentVolume) || currentVolume <= 0) {
    return {
      ok: false,
      available: false,
      currentVolume,
      baseline: null,
      ratio: null,
      quality: 0,
      barsUsed: baseline.barsUsed,
      completeness: baseline.completeness,
      fallbackUsed: baseline.fallbackUsed,
      sessionOnly: baseline.sessionOnly,
      sourceMode: baseline.sourceMode,
    };
  }

  if (!Number.isFinite(baseline.average) || baseline.average <= 0) {
    return {
      ok: !required,
      available: false,
      currentVolume,
      baseline: null,
      ratio: null,
      quality: required ? 0 : 55,
      barsUsed: baseline.barsUsed,
      completeness: baseline.completeness,
      fallbackUsed: baseline.fallbackUsed,
      sessionOnly: baseline.sessionOnly,
      sourceMode: baseline.sourceMode,
    };
  }

  const ratio = currentVolume / baseline.average;
  const quality = clamp(
    45 +
      (ratio - 1) * 35 +
      baseline.completeness * 15 -
      (baseline.fallbackUsed ? 8 : 0),
    0,
    100,
  );

  return {
    ok: ratio >= mult,
    available: true,
    currentVolume,
    baseline: baseline.average,
    ratio,
    quality,
    barsUsed: baseline.barsUsed,
    completeness: baseline.completeness,
    fallbackUsed: baseline.fallbackUsed,
    sessionOnly: baseline.sessionOnly,
    sourceMode: baseline.sourceMode,
  };
}

function rollingVWAP(candles, lookback = 120) {
  const slice = (candles || []).slice(-lookback);
  let tpv = 0;
  let v = 0;
  for (const candle of slice) {
    const vol = Number(candle?.volume ?? 0);
    const tp =
      (Number(candle?.high) + Number(candle?.low) + Number(candle?.close)) / 3;
    if (!Number.isFinite(vol) || !Number.isFinite(tp)) continue;
    tpv += tp * vol;
    v += vol;
  }
  return v > 0 ? tpv / v : Number(slice[slice.length - 1]?.close ?? 0);
}

function sessionVWAP(candles, endTs) {
  const slice = getCurrentSessionCandles(candles, { endTs });
  let tpv = 0;
  let v = 0;

  for (const candle of slice) {
    const vol = Number(candle?.volume ?? 0);
    if (!Number.isFinite(vol) || vol <= 0) continue;

    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);
    if (![high, low, close].every(Number.isFinite)) continue;

    const typicalPrice = (high + low + close) / 3;
    tpv += typicalPrice * vol;
    v += vol;
  }

  if (!Number.isFinite(v) || v <= 0) return null;
  return tpv / v;
}

function maxHigh(candles, lookback = 0) {
  const arr = Array.isArray(candles) ? candles : [];
  const lb = Number(lookback ?? 0);
  const use = lb > 0 ? arr.slice(-lb) : arr;

  let m = -Infinity;
  for (const candle of use) {
    const h = Number(candle?.high);
    if (Number.isFinite(h) && h > m) m = h;
  }
  return Number.isFinite(m) ? m : 0;
}

function minLow(candles, lookback = 0) {
  const arr = Array.isArray(candles) ? candles : [];
  const lb = Number(lookback ?? 0);
  const use = lb > 0 ? arr.slice(-lb) : arr;

  let m = Infinity;
  for (const candle of use) {
    const l = Number(candle?.low);
    if (Number.isFinite(l) && l < m) m = l;
  }
  return Number.isFinite(m) ? m : 0;
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return avg(slice);
}

function stddev(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  const m = avg(slice);
  const v = avg(
    slice.map((x) => {
      const d = Number(x) - m;
      return d * d;
    }),
  );
  return Math.sqrt(v);
}

function bollingerBands(candles, period = 20, std = 2) {
  const closes = (candles || []).map((c) => Number(c.close));
  const mid = sma(closes, period);
  const sd = stddev(closes, period);
  if (mid == null || sd == null) return null;
  const upper = mid + std * sd;
  const lower = mid - std * sd;
  const widthPct = mid !== 0 ? (upper - lower) / mid : 0;
  return { mid, upper, lower, widthPct };
}

// Wilder RSI so intraday behavior is stable and closer to standard charting platforms.
function rsi(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const closes = candles
    .map((candle) => Number(candle?.close))
    .filter(Number.isFinite);
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function candleBody(candle) {
  const open = Number(candle?.open);
  const close = Number(candle?.close);
  return Math.abs(close - open);
}

function candleRange(candle) {
  return Math.max(0, Number(candle?.high) - Number(candle?.low));
}

function upperWick(candle) {
  const hi = Number(candle?.high);
  const top = Math.max(Number(candle?.open), Number(candle?.close));
  return Math.max(0, hi - top);
}

function lowerWick(candle) {
  const lo = Number(candle?.low);
  const bot = Math.min(Number(candle?.open), Number(candle?.close));
  return Math.max(0, bot - lo);
}

function atr(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let sum = 0;

  for (let i = candles.length - period; i < candles.length; i++) {
    const candle = candles[i];
    const prevClose = Number(candles[i - 1]?.close);
    const high = Number(candle?.high);
    const low = Number(candle?.low);

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    sum += Number.isFinite(tr) ? tr : 0;
  }

  return sum / period;
}

function percentileRank(values, x) {
  if (!values || !values.length) return null;
  const v = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!v.length) return null;

  const n = v.length;
  let count = 0;
  for (const a of v) {
    if (a <= x) count += 1;
  }
  return (count / n) * 100;
}

module.exports = {
  clamp,
  avgVolume,
  avgVolumePriorBars,
  volumeConfirmation,
  rollingVWAP,
  getSessionWindow,
  getCurrentSessionCandles,
  splitCurrentVsPreviousSession,
  currentSessionLevels,
  previousSessionLevels,
  openingRangeLevels,
  sessionGapContext,
  sessionContextSummary,
  sessionCandles,
  sessionVWAP,
  maxHigh,
  minLow,
  sma,
  stddev,
  bollingerBands,
  rsi,
  candleBody,
  candleRange,
  upperWick,
  lowerWick,
  atr,
  percentileRank,
};
