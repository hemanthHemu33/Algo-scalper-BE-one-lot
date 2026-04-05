const { DateTime } = require("luxon");
const { env } = require("../config");
const { roundToTick } = require("./priceUtils");
const { rollingVWAP, atr, maxHigh, minLow } = require("../strategy/utils");
const { normalizeTickSize } = require("../utils/tickSize");
const { resolveStrategyStopLoss } = require("./stopRiskSemantics");

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function dayKeyFromTs(ts, tz) {
  try {
    return DateTime.fromJSDate(new Date(ts), { zone: tz }).toFormat(
      "yyyy-LL-dd"
    );
  } catch {
    return null;
  }
}

function computePrevDayOhlc(candles, tz, refTs) {
  if (!Array.isArray(candles) || candles.length < 2) return null;

  const refKey = dayKeyFromTs(refTs || candles[candles.length - 1]?.ts, tz);
  if (!refKey) return null;

  // Aggregate OHLC per day
  const byDay = new Map();
  for (const c of candles) {
    const key = dayKeyFromTs(c?.ts, tz);
    if (!key || key >= refKey) continue; // strictly before ref day

    const hi = safeNum(c?.high);
    const lo = safeNum(c?.low);
    const cl = safeNum(c?.close);
    if (hi == null || lo == null || cl == null) continue;

    let s = byDay.get(key);
    if (!s) {
      s = { high: hi, low: lo, close: cl, lastTs: Number(c.ts) || 0, bars: 1 };
      byDay.set(key, s);
    } else {
      s.high = Math.max(s.high, hi);
      s.low = Math.min(s.low, lo);
      // track last close by timestamp
      const t = Number(c.ts) || 0;
      if (t >= s.lastTs) {
        s.lastTs = t;
        s.close = cl;
      }
      s.bars += 1;
    }
  }

  if (!byDay.size) return null;
  const days = Array.from(byDay.keys()).sort();
  const prevKey = days[days.length - 1];
  const s = byDay.get(prevKey);
  if (!s || s.bars < 5) return null; // require minimal intraday bars
  return { ...s, dayKey: prevKey };
}

function classicPivots({ high, low, close }) {
  const H = safeNum(high);
  const L = safeNum(low);
  const C = safeNum(close);
  if (H == null || L == null || C == null) return null;

  const P = (H + L + C) / 3;
  const R1 = 2 * P - L;
  const S1 = 2 * P - H;
  const R2 = P + (H - L);
  const S2 = P - (H - L);
  const R3 = H + 2 * (P - L);
  const S3 = L - 2 * (H - P);

  return { P, R1, R2, R3, S1, S2, S3 };
}

function parsePriorityList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function computeRR(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.abs(target - entry) / risk;
}

function computeBps(entry, target) {
  if (!(entry > 0)) return null;
  return (Math.abs(target - entry) / entry) * 10000;
}

/**
 * Plan a runner target (TP2) using a priority list:
 * - PIVOT (prev day pivots)
 * - SWING (recent swing high/low)
 * - VWAP (rolling VWAP +/- ATR)
 * - ATR (entry +/- ATR*mult)
 * - RR (fallback: entry +/- risk*fallbackRR)
 */
function planRunnerTarget({ trade, candles }) {
  const side = String(trade?.side || "").toUpperCase();
  const entry = safeNum(trade?.entryPrice || trade?.candle?.close);
  const baseSL = safeNum(resolveStrategyStopLoss(trade));
  const tick = normalizeTickSize(trade?.instrument?.tick_size);
  if (!Number.isFinite(tick)) {
    return {
      price: null,
      mode: "NONE",
      meta: { reason: "NO_TICK_SIZE" },
    };
  }

  if (!entry || !baseSL) {
    return {
      price: null,
      mode: "NONE",
      meta: { reason: "missing_entry_or_sl" },
    };
  }

  const risk = Math.abs(entry - baseSL);
  if (!(risk > 0)) {
    return {
      price: null,
      mode: "NONE",
      meta: { reason: "zero_risk" },
    };
  }

  const minRR = Number(env.RUNNER_MIN_RR ?? 1.5);
  const minBps = Number(env.RUNNER_MIN_TARGET_BPS ?? 0);
  const atrMult = Number(env.RUNNER_ATR_MULT ?? 2);
  const swingLb = Number(env.RUNNER_SWING_LOOKBACK ?? 120);
  const vwapLb = Number(env.RUNNER_VWAP_LOOKBACK ?? 120);
  const fallbackRR = Number(env.RUNNER_FALLBACK_RR ?? 2);
  const prio = parsePriorityList(
    env.RUNNER_TARGET_PRIORITY || "PIVOT,SWING,ATR,RR"
  );

  const inDir = (px) => (side === "BUY" ? px > entry : px < entry);
  const round = (px) => roundToTick(px, tick, side === "BUY" ? "up" : "down");

  const candidates = [];

  // PIVOT candidate (prev day)
  if (prio.includes("PIVOT")) {
    const tz = env.CANDLE_TZ || "Asia/Kolkata";
    const refTs = trade?.entryFilledAt || trade?.createdAt || Date.now();
    const ohlc = computePrevDayOhlc(candles, tz, refTs);
    const piv = ohlc ? classicPivots(ohlc) : null;

    if (piv) {
      const levels =
        side === "BUY" ? [piv.R1, piv.R2, piv.R3] : [piv.S1, piv.S2, piv.S3];
      for (const lv of levels) {
        const px = safeNum(lv);
        if (!px || !inDir(px)) continue;
        candidates.push({
          mode: "PIVOT",
          price: px,
          meta: { dayKey: ohlc.dayKey },
        });
        break; // nearest level only
      }
    }
  }

  // SWING candidate (recent high/low)
  if (prio.includes("SWING")) {
    const px =
      side === "BUY" ? maxHigh(candles, swingLb) : minLow(candles, swingLb);
    if (safeNum(px) && inDir(px)) {
      candidates.push({
        mode: "SWING",
        price: px,
        meta: { lookback: swingLb },
      });
    }
  }

  // VWAP candidate (vwap +/- ATR*mult)
  if (prio.includes("VWAP")) {
    const v = rollingVWAP(candles, vwapLb);
    const a = atr(candles, 14);
    if (safeNum(v) && safeNum(a)) {
      const px = side === "BUY" ? v + atrMult * a : v - atrMult * a;
      if (inDir(px)) {
        candidates.push({
          mode: "VWAP",
          price: px,
          meta: { vwap: v, atr: a, mult: atrMult },
        });
      }
    }
  }

  // ATR candidate (entry +/- ATR*mult)
  if (prio.includes("ATR")) {
    const a = atr(candles, 14);
    if (safeNum(a) && a > 0) {
      const px = side === "BUY" ? entry + atrMult * a : entry - atrMult * a;
      if (inDir(px)) {
        candidates.push({
          mode: "ATR",
          price: px,
          meta: { atr: a, mult: atrMult },
        });
      }
    }
  }

  // RR fallback
  const rrPx =
    side === "BUY" ? entry + fallbackRR * risk : entry - fallbackRR * risk;
  candidates.push({ mode: "RR", price: rrPx, meta: { fallbackRR } });

  // pick based on priority + gates
  for (const key of prio.length ? prio : ["RR"]) {
    const c = candidates.find((x) => x.mode === key);
    if (!c) continue;

    const px = round(c.price);
    if (!inDir(px)) continue;

    const rr = computeRR(entry, baseSL, px);
    const bps = computeBps(entry, px);
    if (rr != null && rr < minRR) continue;
    if (bps != null && bps < minBps) continue;

    return { price: px, mode: c.mode, meta: { ...c.meta, rr, bps } };
  }

  const px = round(rrPx);
  return {
    price: px,
    mode: "RR",
    meta: {
      fallbackRR,
      rr: computeRR(entry, baseSL, px),
      bps: computeBps(entry, px),
    },
  };
}

module.exports = { planRunnerTarget };
