const { DateTime } = require("luxon");
const { env } = require("../config");
const {
  clamp,
  maxHigh,
  minLow,
  getCurrentSessionCandles,
  volumeConfirmation,
} = require("./utils");

function resolveMarketOpen(tz, marketOpen) {
  const raw = String(marketOpen || env.MARKET_OPEN || "09:15").trim() || "09:15";
  const parsed = DateTime.fromFormat(raw, "HH:mm", { zone: tz });
  if (parsed.isValid) return parsed;
  return DateTime.fromFormat("09:15", "HH:mm", { zone: tz });
}

function orbCandidate({
  side,
  reason,
  confidence,
  setupState,
  actionable,
  orbHigh,
  orbLow,
  orbMinutes,
  orbCompletedAt,
  orbAgeMin,
  orbAgeBars,
  triggerWindowMin,
  volume,
  freshness,
  patternQuality,
  anchorQuality,
  structureQuality,
  triggerType,
  expired,
}) {
  return {
    side,
    confidence,
    reason,
    actionable,
    meta: {
      triggerLevel: side === "BUY" ? orbHigh : orbLow,
      orbMinutes,
      orbHigh,
      orbLow,
      orbCompletedAt,
      orbAgeMin,
      orbAgeBars,
      orbTriggerWindowMin: triggerWindowMin,
      orbExpired: expired === true,
      anchorType: "OPENING_RANGE",
      triggerType,
      setupState,
      patternQuality,
      anchorQuality,
      structureQuality,
      volumeQuality: volume?.quality ?? 55,
      volumeRatio: volume?.ratio ?? null,
      freshness,
      sessionOnly: true,
    },
  };
}

function evaluateOrbSetup({
  candles,
  intervalMin,
  orbMinutes = 15,
  marketOpen = env.MARKET_OPEN,
  volMult = 1.2,
  volLookback = 20,
}) {
  if (!candles || !candles.length) return null;

  const tz = env.CANDLE_TZ || "Asia/Kolkata";
  const last = candles[candles.length - 1];
  if (!last?.ts) return null;
  const sessionBars = getCurrentSessionCandles(candles, { endTs: last.ts });
  if (!sessionBars.length) return null;

  const dtLast = DateTime.fromJSDate(new Date(last.ts)).setZone(tz);
  if (!dtLast.isValid) return null;
  const openDt = resolveMarketOpen(tz, marketOpen);
  const sessionStart = dtLast.startOf("day").set({
    hour: openDt.hour,
    minute: openDt.minute,
    second: 0,
    millisecond: 0,
  });
  const completedAt = sessionStart.plus({ minutes: Number(orbMinutes) });
  const now = DateTime.fromJSDate(new Date(last.ts)).setZone(tz);
  const needBars = Math.max(
    1,
    Math.ceil(Number(orbMinutes) / Math.max(1, Number(intervalMin ?? 1))),
  );

  const opening = sessionBars.filter((candle) => {
    const d = DateTime.fromJSDate(new Date(candle.ts)).setZone(tz);
    return d >= sessionStart && d < completedAt;
  });
  if (!opening.length) return null;

  const orbHigh = maxHigh(opening);
  const orbLow = minLow(opening);
  const midpoint = (orbHigh + orbLow) / 2;
  const close = Number(last.close);
  const prevClose = Number(sessionBars[sessionBars.length - 2]?.close);
  const triggerWindowMinRaw =
    process.env.ORB_TRIGGER_WINDOW_MIN ?? env.ORB_TRIGGER_WINDOW_MIN;
  const triggerWindowMin = Number.isFinite(Number(triggerWindowMinRaw))
    ? Math.max(1, Number(triggerWindowMinRaw))
    : Math.max(Number(orbMinutes), 20);
  const triggerWindowEnd = completedAt.plus({ minutes: triggerWindowMin });
  const orbAgeMin = Math.max(0, now.diff(completedAt, "minutes").minutes);
  const orbAgeBars = Math.max(
    0,
    Math.floor(orbAgeMin / Math.max(1, Number(intervalMin ?? 1))),
  );
  const triggerFreshness = clamp(
    96 - (orbAgeMin / Math.max(1, triggerWindowMin)) * 34,
    44,
    96,
  );
  const completionQuality = clamp(68 + Math.min(16, opening.length * 3), 0, 100);

  if (opening.length < needBars) {
    return {
      setupState: "forming",
      actionable: false,
      candidate: orbCandidate({
        side: close >= midpoint ? "BUY" : "SELL",
        reason: "Opening range still forming",
        confidence: 58,
        setupState: "forming",
        actionable: false,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin: 0,
        orbAgeBars: 0,
        triggerWindowMin,
        volume: null,
        freshness: 82,
        patternQuality: 56,
        anchorQuality: completionQuality,
        structureQuality: 60,
        triggerType: "OPENING_RANGE_FORMING",
        expired: false,
      }),
    };
  }

  if (now < completedAt) {
    return {
      setupState: "forming",
      actionable: false,
      candidate: orbCandidate({
        side: close >= midpoint ? "BUY" : "SELL",
        reason: "Opening range building until ORB completes",
        confidence: 60,
        setupState: "forming",
        actionable: false,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume: null,
        freshness: 84,
        patternQuality: 58,
        anchorQuality: completionQuality,
        structureQuality: 62,
        triggerType: "OPENING_RANGE_FORMING",
        expired: false,
      }),
    };
  }

  if (now > triggerWindowEnd) {
    return {
      setupState: "expired",
      actionable: false,
      candidate: orbCandidate({
        side: close >= midpoint ? "BUY" : "SELL",
        reason: "ORB trigger window expired",
        confidence: 52,
        setupState: "expired",
        actionable: false,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume: null,
        freshness: 28,
        patternQuality: 48,
        anchorQuality: completionQuality,
        structureQuality: 50,
        triggerType: "OPENING_RANGE_EXPIRED",
        expired: true,
      }),
    };
  }

  const volume = volumeConfirmation(sessionBars, {
    lookback: volLookback,
    mult: volMult,
    sessionOnly: true,
    required: true,
    minBars: 1,
  });
  const breakoutFracUp = (close - orbHigh) / Math.max(1, Math.abs(close));
  const breakoutFracDown = (orbLow - close) / Math.max(1, Math.abs(close));
  const nearHigh = Math.abs(close - orbHigh) / Math.max(1, Math.abs(close));
  const nearLow = Math.abs(close - orbLow) / Math.max(1, Math.abs(close));

  if (close > orbHigh && prevClose <= orbHigh && volume.ok) {
    const patternQuality = clamp(66 + breakoutFracUp * 3500 + Math.min(8, opening.length * 2), 0, 100);
    const structureQuality = clamp(64 + breakoutFracUp * 3000 + Math.min(12, opening.length * 2), 0, 100);
    const confidence = Math.min(
      95,
      70 + Math.max(0, ((volume.ratio ?? 0) - volMult) * 10),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: orbCandidate({
        side: "BUY",
        reason: `ORB breakout above ${orbHigh.toFixed(2)} (ORB ${orbMinutes}m)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume,
        freshness: triggerFreshness,
        patternQuality,
        anchorQuality: completionQuality,
        structureQuality,
        triggerType: "OPENING_RANGE_BREAKOUT",
        expired: false,
      }),
    };
  }

  if (close < orbLow && prevClose >= orbLow && volume.ok) {
    const patternQuality = clamp(66 + breakoutFracDown * 3500 + Math.min(8, opening.length * 2), 0, 100);
    const structureQuality = clamp(64 + breakoutFracDown * 3000 + Math.min(12, opening.length * 2), 0, 100);
    const confidence = Math.min(
      95,
      70 + Math.max(0, ((volume.ratio ?? 0) - volMult) * 10),
    );
    return {
      setupState: "triggered",
      actionable: true,
      candidate: orbCandidate({
        side: "SELL",
        reason: `ORB breakdown below ${orbLow.toFixed(2)} (ORB ${orbMinutes}m)`,
        confidence,
        setupState: "triggered",
        actionable: true,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume,
        freshness: triggerFreshness,
        patternQuality,
        anchorQuality: completionQuality,
        structureQuality,
        triggerType: "OPENING_RANGE_BREAKDOWN",
        expired: false,
      }),
    };
  }

  if (nearHigh <= 0.0018) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: orbCandidate({
        side: "BUY",
        reason: "ORB breakout watch near opening range high",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume,
        freshness: clamp(triggerFreshness - 8, 40, 92),
        patternQuality: 60,
        anchorQuality: completionQuality,
        structureQuality: 68,
        triggerType: "OPENING_RANGE_BREAKOUT_WATCH",
        expired: false,
      }),
    };
  }

  if (nearLow <= 0.0018) {
    return {
      setupState: "armed",
      actionable: false,
      candidate: orbCandidate({
        side: "SELL",
        reason: "ORB breakdown watch near opening range low",
        confidence: 64,
        setupState: "armed",
        actionable: false,
        orbHigh,
        orbLow,
        orbMinutes,
        orbCompletedAt: completedAt.toISO(),
        orbAgeMin,
        orbAgeBars,
        triggerWindowMin,
        volume,
        freshness: clamp(triggerFreshness - 8, 40, 92),
        patternQuality: 60,
        anchorQuality: completionQuality,
        structureQuality: 68,
        triggerType: "OPENING_RANGE_BREAKDOWN_WATCH",
        expired: false,
      }),
    };
  }

  return {
    setupState: "armed",
    actionable: false,
    candidate: orbCandidate({
      side: close >= midpoint ? "BUY" : "SELL",
      reason: "ORB armed after range completion",
      confidence: 60,
      setupState: "armed",
      actionable: false,
      orbHigh,
      orbLow,
      orbMinutes,
      orbCompletedAt: completedAt.toISO(),
      orbAgeMin,
      orbAgeBars,
      triggerWindowMin,
      volume,
      freshness: clamp(triggerFreshness - 10, 36, 90),
      patternQuality: 58,
      anchorQuality: completionQuality,
      structureQuality: 64,
      triggerType:
        close >= midpoint ? "OPENING_RANGE_BREAKOUT_WATCH" : "OPENING_RANGE_BREAKDOWN_WATCH",
      expired: false,
    }),
  };
}

function orbStrategy(args) {
  const setup = evaluateOrbSetup(args);
  return setup?.actionable ? setup.candidate : null;
}

module.exports = {
  orbStrategy,
  evaluateOrbSetup,
};
