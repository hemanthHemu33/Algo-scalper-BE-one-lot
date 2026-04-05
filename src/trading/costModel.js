// costModel.js
//
// Fast, conservative transaction-cost estimator used for:
//  - cost/edge gating (avoid trades where expected move cannot beat fees)
//  - "true breakeven" logic (avoid BE exits that are fee-negative)
//  - post-trade feeMultiple analytics
//
// Patch-6 upgrade:
//  - Segment-aware parameter overrides (EQ intraday vs delivery vs FUT vs OPT)
//  - Optional DB-backed calibration multiplier (auto-adjusted by contract-note reconciler)

function n(x, d = 0) {
  if (x === null || x === undefined || x === "") return d;
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function up(s) {
  return String(s || "")
    .trim()
    .toUpperCase();
}

function isOptSymbol(ts) {
  const s = up(ts);
  return s.endsWith("CE") || s.endsWith("PE");
}

// Segment keys used internally (stable API)
// EQ_INTRADAY | EQ_DELIVERY | FUT | OPT
function segmentKeyFromContext({ instrument, segmentKey, product, env }) {
  const sk = up(segmentKey);
  if (sk) return sk;

  const seg = up(instrument?.segment || instrument?.exchange || "");
  const it = up(instrument?.instrument_type || "");
  const ts = up(instrument?.tradingsymbol || instrument?.symbol || "");

  if (seg.includes("OPT") || it === "CE" || it === "PE" || isOptSymbol(ts))
    return "OPT";
  if (seg.includes("FUT") || it === "FUT") return "FUT";

  const p = up(product || env?.DEFAULT_PRODUCT || "MIS");
  if (p === "CNC") return "EQ_DELIVERY";
  return "EQ_INTRADAY";
}

function envSegKey(base, seg) {
  return `${base}_${up(seg)}`;
}

function readSegNumber(env, baseKey, segKey, fallback) {
  const a = envSegKey(baseKey, segKey);
  if (env && Object.prototype.hasOwnProperty.call(env, a))
    return n(env[a], fallback);
  return n(env?.[baseKey], fallback);
}

function readSegBool(env, baseKey, segKey, fallback) {
  const a = envSegKey(baseKey, segKey);
  if (env && Object.prototype.hasOwnProperty.call(env, a)) {
    return String(env[a]) === "true";
  }
  if (env && Object.prototype.hasOwnProperty.call(env, baseKey)) {
    return String(env[baseKey]) === "true";
  }
  return !!fallback;
}

function estimateBrokeragePerOrderInr(orderValueInr, env, segKey) {
  const sk = up(segKey);

  // Derivatives (FUT/OPT): most Indian brokers (incl. Zerodha) charge a flat fee per executed order.
  // Default is ₹20/order for F&O. Override with BROKERAGE_FNO_PER_ORDER_INR (or *_OPT/*_FUT).
  if (sk === "FUT" || sk === "OPT") {
    const flat = readSegNumber(env, "BROKERAGE_FNO_PER_ORDER_INR", sk, 20);
    // Flat fee is not a function of order value. Keep a sane upper clamp to avoid config mistakes.
    return clamp(flat, 0, 100000);
  }

  // Equity delivery: typically ₹0 brokerage at discount brokers; override if your plan differs.
  if (sk === "EQ_DELIVERY") {
    const flat = readSegNumber(
      env,
      "BROKERAGE_EQ_DELIVERY_PER_ORDER_INR",
      sk,
      0,
    );
    return clamp(flat, 0, 100000);
  }

  // Equity intraday default model: min(cap, pct of order value)
  // (Zerodha: min(₹20, 0.03% of order value) on executed orders)
  const pct = readSegNumber(env, "BROKERAGE_PCT", sk, 0.03); // percent
  const cap = readSegNumber(env, "BROKERAGE_MAX_PER_ORDER", sk, 20);
  const raw = orderValueInr * (pct / 100);
  return clamp(raw, 0, cap);
}

function getCalibrationMultiplier(segKey, env) {
  const enabled = String(env?.COST_CALIBRATION_ENABLED || "false") === "true";
  if (!enabled) return 1;
  try {
    // Lazy require to avoid hard dependency loops.
    // eslint-disable-next-line global-require
    const { costCalibrator } = require("./costCalibrator");
    const m = costCalibrator?.getMultiplier?.(segKey);
    return Number.isFinite(Number(m)) && Number(m) > 0 ? Number(m) : 1;
  } catch {
    return 1;
  }
}

/**
 * Estimate all-in round-trip cost in INR.
 *
 * Inputs:
 * - entryPrice: assumed average fill price
 * - qty: quantity
 * - spreadBps: optional spread estimate (bps) to include
 * - env: validated env config
 * - instrument / segmentKey / product: to derive segment-aware parameters
 *
 * Returns:
 *  { estCostInr, meta }
 */
function estimateRoundTripCostInr({
  entryPrice,
  qty,
  spreadBps,
  env,
  instrument,
  segmentKey,
  product,
  // If true, ignore DB calibration multiplier
  disableCalibration = false,
} = {}) {
  const price = n(entryPrice);
  const q = n(qty);

  const segKey = segmentKeyFromContext({
    instrument,
    segmentKey,
    product,
    env,
  });

  const posValue = price * q;
  const turnover = 2 * posValue; // buy + sell

  // Segment-aware knobs (fallback to legacy defaults)
  const variableBps = readSegNumber(env, "COST_VARIABLE_BPS", segKey, 6);
  const slippageBps = readSegNumber(env, "COST_SLIPPAGE_BPS", segKey, 6);
  const includeSpread = readSegBool(
    env,
    "INCLUDE_SPREAD_IN_COST",
    segKey,
    true,
  );
  const spread = includeSpread ? n(spreadBps, 0) : 0;

  // Total bps applied on turnover
  const bpsTotal = Math.max(0, variableBps + slippageBps + spread);
  const bpsCost = (turnover * bpsTotal) / 10000;

  const perOrderBrokerage = estimateBrokeragePerOrderInr(posValue, env, segKey);
  const execOrders = readSegNumber(env, "EXPECTED_EXECUTED_ORDERS", segKey, 2);
  const brokerage = execOrders * perOrderBrokerage;

  const baseEstCostInr = bpsCost + brokerage;

  const calMult = disableCalibration
    ? 1
    : getCalibrationMultiplier(segKey, env);
  const estCostInr = baseEstCostInr * calMult;

  return {
    estCostInr,
    meta: {
      segmentKey: segKey,
      calibrationMultiplier: calMult,
      baseEstCostInr,
      posValue,
      turnover,
      bpsTotal,
      variableBps,
      slippageBps,
      spreadBps: spread,
      includeSpread,
      brokerage,
      perOrderBrokerage,
      execOrders,
    },
  };
}

function pnlInrToR(pnlInr, riskInr) {
  const pnl = n(pnlInr, NaN);
  const risk = n(riskInr, NaN);
  if (!(Number.isFinite(pnl) && Number.isFinite(risk) && risk > 0)) return null;
  return pnl / risk;
}

function rToInr(rMultiple, riskInr) {
  const r = n(rMultiple, NaN);
  const risk = n(riskInr, NaN);
  if (!(Number.isFinite(r) && Number.isFinite(risk) && risk > 0)) return null;
  return r * risk;
}

function priceFromNetPnl({
  entryPrice,
  qty,
  side,
  pnlInr,
  tick,
  roundMode,
} = {}) {
  const entry = n(entryPrice, NaN);
  const q = n(qty, NaN);
  const pnl = n(pnlInr, NaN);
  if (!(entry > 0) || !(q > 0) || !Number.isFinite(pnl)) return null;

  const pts = pnl / q;
  const raw =
    up(side) === "SELL"
      ? entry - pts
      : entry + pts;

  const px = Number(raw);
  if (!Number.isFinite(px) || px <= 0) return null;

  const tk = n(tick, 0);
  if (!(tk > 0)) return px;

  const steps = px / tk;
  if (!Number.isFinite(steps)) return null;

  if (roundMode === "up") return Math.ceil(steps) * tk;
  if (roundMode === "down") return Math.floor(steps) * tk;
  return Math.round(steps) * tk;
}

function retainedRToPrice({
  entryPrice,
  qty,
  side,
  retainedR,
  riskInr,
  tick,
  roundMode,
} = {}) {
  const pnlInr = rToInr(retainedR, riskInr);
  if (!Number.isFinite(pnlInr)) return null;
  return priceFromNetPnl({
    entryPrice,
    qty,
    side,
    pnlInr,
    tick,
    roundMode,
  });
}

function estimateTrueBreakEven({
  entryPrice,
  qty,
  side,
  tick,
  spreadBps,
  env,
  instrument,
  segmentKey,
  product,
  costMultiplier = 1,
  keepProfitInr = 0,
  extraBufferPts = 0,
} = {}) {
  const entry = n(entryPrice, NaN);
  const q = n(qty, NaN);
  const mult = Math.max(0, n(costMultiplier, 1));
  const keepInr = Math.max(0, n(keepProfitInr, 0));
  const bufferPts = Math.max(0, n(extraBufferPts, 0));

  if (!(entry > 0) || !(q > 0)) {
    return {
      price: Number.isFinite(entry) ? entry : null,
      estCostInr: 0,
      floorInr: keepInr,
      floorPts: 0,
      meta: { note: "invalid_inputs" },
    };
  }

  const { estCostInr, meta } = estimateRoundTripCostInr({
    entryPrice: entry,
    qty: q,
    spreadBps,
    env,
    instrument,
    segmentKey,
    product,
  });

  const floorInr = Math.max(0, n(estCostInr, 0) * mult + keepInr + bufferPts * q);
  const floorPts = q > 0 ? floorInr / q : 0;
  const price = priceFromNetPnl({
    entryPrice: entry,
    qty: q,
    side,
    pnlInr: floorInr,
    tick,
    roundMode: up(side) === "SELL" ? "down" : "up",
  });

  return {
    price,
    estCostInr: n(estCostInr, 0),
    floorInr,
    floorPts,
    meta: {
      ...(meta || {}),
      costMultiplier: mult,
      keepProfitInr: keepInr,
      extraBufferPts: bufferPts,
    },
  };
}

function estimateCostGreenFloor({
  entryPrice,
  qty,
  side,
  tick,
  spreadBps,
  env,
  instrument,
  segmentKey,
  product,
  costMultiplier = 1,
  minNetProfitInr = 0,
  extraBufferPts = 0,
} = {}) {
  const out = estimateTrueBreakEven({
    entryPrice,
    qty,
    side,
    tick,
    spreadBps,
    env,
    instrument,
    segmentKey,
    product,
    costMultiplier,
    keepProfitInr: minNetProfitInr,
    extraBufferPts,
  });

  return {
    price: out.price,
    estCostInr: out.estCostInr,
    floorInr: out.floorInr,
    floorPts: out.floorPts,
    meta: out.meta,
  };
}

function costGate({
  entryPrice,
  stopLoss,
  rrTarget,
  expectedMovePerShare,
  qty,
  spreadBps,
  env,
  instrument,
  segmentKey,
  product,
} = {}) {
  const price = n(entryPrice);
  const sl = n(stopLoss);
  const q = n(qty);
  const rr = n(rrTarget, 1);

  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(sl) || q < 1) {
    return { ok: true, note: "cost_gate_skipped_bad_inputs" };
  }

  // Planned risk (SL) in ₹
  const riskPerShare = Math.abs(price - sl);
  const riskInr = riskPerShare * q;
  const { estCostInr, meta: costMeta } = estimateRoundTripCostInr({
    entryPrice: price,
    qty: q,
    spreadBps,
    env,
    instrument,
    segmentKey,
    product,
  });

  // Planned profit for RR target (used in multiple gates + meta)
  const targetDistPerShare = rr * riskPerShare;
  const plannedProfitPerShare = targetDistPerShare;
  const plannedProfitInr = plannedProfitPerShare * q;
  const feeMultiplePlanned =
    Number.isFinite(estCostInr) && estCostInr > 0
      ? plannedProfitInr / estCostInr
      : NaN;

  // Optional SL ₹ gate (softened by cost-floor)
  const minSlInr = n(env.MIN_SL_INR, 0);
  const minSlCostMult = n(env.MIN_SL_INR_COST_MULT, 1.5);
  if (minSlInr > 0 && Number.isFinite(riskInr) && riskInr < minSlInr) {
    const costFloor =
      Number.isFinite(estCostInr) && estCostInr > 0 && minSlCostMult > 0
        ? minSlCostMult * estCostInr
        : 0;
    if (costFloor > 0 ? riskInr < costFloor : true) {
      return {
        ok: false,
        reason: `SL_TOO_SMALL_INR (₹${riskInr.toFixed(0)} < ₹${minSlInr}; need ≥ ₹${
          costFloor > 0 ? costFloor.toFixed(0) : minSlInr
        } by cost floor)`,
        meta: {
          riskPerShare,
          riskInr,
          plannedProfitPerShare,
          plannedProfitInr,
          feeMultiplePlanned,
          minSlInr,
          minSlCostMult,
          estCostInr,
          ...(costMeta || {}),
        },
      };
    }
  }

  // Expected move (in ₹) available right now (ATR-based)
  const expMovePs = n(expectedMovePerShare, NaN);
  const expMoveInr = Number.isFinite(expMovePs) ? expMovePs * q : NaN;

  // 1) Feasibility gate: to hit RR target, ATR-expected move should support it
  if (Number.isFinite(expMovePs) && expMovePs > 0) {
    if (expMovePs < targetDistPerShare) {
      return {
        ok: false,
        reason: `RR_NOT_FEASIBLE (need ${targetDistPerShare.toFixed(
          2,
        )}pts, exp ${expMovePs.toFixed(2)}pts)`,
        meta: { riskPerShare, rrTarget: rr, targetDistPerShare, expMovePs },
      };
    }
  }

  // 2) Edge gate: expected move should be >= K * all-in costs
  if (String(env.ENABLE_COST_GATE) === "true") {
    const k = n(env.COST_GATE_MULT, 3);
    if (Number.isFinite(expMoveInr) && expMoveInr > 0) {
      if (expMoveInr < k * estCostInr) {
        return {
          ok: false,
          reason: `EDGE_TOO_SMALL (expMove ₹${expMoveInr.toFixed(
            0,
          )} < ${k}x cost ₹${estCostInr.toFixed(0)})`,
          meta: {
            expMovePs,
            expMoveInr,
            k,
            estCostInr,
            plannedProfitPerShare,
            plannedProfitInr,
            feeMultiplePlanned,
            ...(costMeta || {}),
          },
        };
      }
    } else {
      // If we couldn't compute expected move, don't block by default.
      return { ok: true, note: "edge_gate_skipped_no_expected_move" };
    }
  }

  // 3) Planned fee-multiple gate (optional): based on planned RR target, not ATR expected move
  const fmMin = n(env.FEE_MULTIPLE_PLANNED_MIN, 0);
  if (fmMin > 0 && Number.isFinite(feeMultiplePlanned)) {
    if (feeMultiplePlanned < fmMin) {
      return {
        ok: false,
        reason: `FEE_MULTIPLE_TOO_LOW (plan ${feeMultiplePlanned.toFixed(
          2,
        )}x < ${fmMin}x)`,
        meta: {
          plannedProfitPerShare,
          plannedProfitInr,
          feeMultiplePlanned,
          fmMin,
          riskPerShare,
          riskInr,
          estCostInr,
          ...(costMeta || {}),
        },
      };
    }
  }

  return {
    ok: true,
    meta: {
      riskPerShare,
      riskInr,
      expectedMovePerShare: expMovePs,
      expectedMoveInr: expMoveInr,
      estCostInr,
      ...(costMeta || {}),
    },
  };
}

function estimateMinGreen({
  entryPrice,
  qty,
  spreadBps,
  env,
  instrument,
  segmentKey,
  product,
} = {}) {
  const price = n(entryPrice);
  const q = n(qty);
  const segKey = segmentKeyFromContext({
    instrument,
    segmentKey,
    product,
    env,
  });

  if (!(price > 0) || !(q > 0)) {
    return {
      estChargesInr: 0,
      slippageBufferInr: 0,
      minGreenInr: 0,
      minGreenPts: 0,
      meta: { segmentKey: segKey, note: "invalid_inputs" },
    };
  }

  const bufferPts =
    segKey === "OPT" ? n(env?.MIN_GREEN_SLIPPAGE_PTS_OPT, 2) : 0;
  const floor = estimateCostGreenFloor({
    entryPrice: price,
    qty: q,
    side: "BUY",
    tick: instrument?.tick_size,
    spreadBps,
    env,
    instrument,
    segmentKey,
    product,
    costMultiplier: 1,
    extraBufferPts: bufferPts,
  });
  const slippageBufferInr = bufferPts * q;
  const minGreenInr = n(floor.floorInr, 0);
  const minGreenPts = n(floor.floorPts, 0);

  return {
    estChargesInr: n(floor.estCostInr, 0),
    slippageBufferInr,
    minGreenInr,
    minGreenPts,
    meta: {
      ...(floor.meta || {}),
      segmentKey: segKey,
      bufferPts,
    },
  };
}

module.exports = {
  estimateRoundTripCostInr,
  costGate,
  segmentKeyFromContext,
  estimateMinGreen,
  estimateTrueBreakEven,
  estimateCostGreenFloor,
  pnlInrToR,
  rToInr,
  retainedRToPrice,
};
