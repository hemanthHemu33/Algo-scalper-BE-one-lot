const { env } = require("../config");
const { DateTime } = require("luxon");

/**
 * Lightweight in-process rate limiter for order placement.
 *
 * Zerodha Kite practical limits (commonly cited):
 * - ~10 orders/second
 * - ~400 orders/minute
 * - ~5000 orders/day
 *
 * This limiter enforces per-second and per-minute. Daily is enforced in TradeManager
 * using daily_risk.ordersPlaced (persisted).
 */
class OrderRateLimiter {
  constructor({ maxPerSec, maxPerMin, maxPerDay } = {}) {
    this.secBucketStart = 0;
    this.secCount = 0;

    this.minBucketStart = 0;
    this.minCount = 0;

    this.dayCount = 0;
    this.dayKey = this._dayKey();

    this.maxPerSec = Number.isFinite(Number(maxPerSec))
      ? Number(maxPerSec)
      : Number(env.MAX_ORDERS_PER_SEC ?? 10);
    this.maxPerMin = Number.isFinite(Number(maxPerMin))
      ? Number(maxPerMin)
      : Number(env.MAX_ORDERS_PER_MIN ?? 400);
    this.maxPerDay = Number.isFinite(Number(maxPerDay))
      ? Number(maxPerDay)
      : Number(env.MAX_ORDERS_PER_DAY ?? 5000);
  }

  _bucketStartMs(now, sizeMs) {
    return now - (now % sizeMs);
  }

  _dayKey(now = Date.now()) {
    return DateTime.fromMillis(Number(now) || Date.now())
      .setZone(env.CANDLE_TZ || "Asia/Kolkata")
      .toFormat("yyyy-LL-dd");
  }

  _ensureDay(now = Date.now()) {
    const dayKey = this._dayKey(now);
    if (dayKey !== this.dayKey) {
      this.dayKey = dayKey;
      this.dayCount = 0;
    }
  }

  check({ now = Date.now(), count = 1 } = {}) {
    const perSec = this.maxPerSec;
    const perMin = this.maxPerMin;
    const perDay = this.maxPerDay;

    const secStart = this._bucketStartMs(now, 1000);
    if (secStart !== this.secBucketStart) {
      this.secBucketStart = secStart;
      this.secCount = 0;
    }

    const minStart = this._bucketStartMs(now, 60_000);
    if (minStart !== this.minBucketStart) {
      this.minBucketStart = minStart;
      this.minCount = 0;
    }
    this._ensureDay(now);

    if (this.secCount + count > perSec) {
      return { ok: false, reason: "rate_limit_per_sec", limit: perSec };
    }
    if (this.minCount + count > perMin) {
      return { ok: false, reason: "rate_limit_per_min", limit: perMin };
    }
    if (this.dayCount + count > perDay) {
      return { ok: false, reason: "rate_limit_per_day", limit: perDay };
    }
    return { ok: true };
  }

  record({ now = Date.now(), count = 1 } = {}) {
    const secStart = this._bucketStartMs(now, 1000);
    if (secStart !== this.secBucketStart) {
      this.secBucketStart = secStart;
      this.secCount = 0;
    }

    const minStart = this._bucketStartMs(now, 60_000);
    if (minStart !== this.minBucketStart) {
      this.minBucketStart = minStart;
      this.minCount = 0;
    }
    this._ensureDay(now);

    this.secCount += count;
    this.minCount += count;
    this.dayCount += count;
  }

  setDayCount(count = 0, { now = Date.now() } = {}) {
    this._ensureDay(now);
    const next = Number(count ?? 0);
    this.dayCount = Number.isFinite(next) && next >= 0 ? next : 0;
  }

  snapshot({ now = Date.now(), currentDayCount } = {}) {
    const secStart = this._bucketStartMs(now, 1000);
    const minStart = this._bucketStartMs(now, 60_000);
    if (secStart !== this.secBucketStart) {
      this.secBucketStart = secStart;
      this.secCount = 0;
    }
    if (minStart !== this.minBucketStart) {
      this.minBucketStart = minStart;
      this.minCount = 0;
    }
    this._ensureDay(now);

    const dayCount = Number.isFinite(Number(currentDayCount))
      ? Number(currentDayCount)
      : this.dayCount;

    return {
      limits: {
        perSec: this.maxPerSec,
        perMin: this.maxPerMin,
        perDay: this.maxPerDay,
      },
      usage: {
        currentSecond: this.secCount,
        currentMinute: this.minCount,
        today: dayCount,
      },
      remaining: {
        thisSecond: Math.max(0, this.maxPerSec - this.secCount),
        thisMinute: Math.max(0, this.maxPerMin - this.minCount),
        today: Math.max(0, this.maxPerDay - dayCount),
      },
      windows: {
        secondBucketStartedAt: new Date(this.secBucketStart || secStart).toISOString(),
        minuteBucketStartedAt: new Date(this.minBucketStart || minStart).toISOString(),
        tradingDayKey: this.dayKey,
      },
    };
  }
}

module.exports = { OrderRateLimiter };
