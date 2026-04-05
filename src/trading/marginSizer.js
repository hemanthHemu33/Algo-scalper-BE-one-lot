const { env } = require("../config");
const { logger } = require("../logger");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function pickNum(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function getAvailableEquityMargin(margins) {
  const eq =
    margins?.equity || margins?.data?.equity || margins?.equity_margins;
  const available = eq?.available || margins?.available || {};

  return pickNum(
    available.live_balance,
    available.cash,
    available.opening_balance,
    available.adhoc_margin,
    eq?.net,
    eq?.net_balance,
    eq?.net_cash,
    eq?.net_available,
    margins?.net,
  );
}

function capQtyByConfig({ qty, entryPriceGuess }) {
  let out = Math.max(0, Math.floor(qty || 0));

  const maxQty = num(env.MAX_QTY);
  if (Number.isFinite(maxQty) && maxQty > 0) {
    out = Math.min(out, Math.floor(maxQty));
  }

  const maxPosVal = num(env.MAX_POSITION_VALUE_INR);
  const px = num(entryPriceGuess);
  if (
    Number.isFinite(maxPosVal) &&
    maxPosVal > 0 &&
    Number.isFinite(px) &&
    px > 0
  ) {
    out = Math.min(out, Math.floor(maxPosVal / px));
  }

  const hardCap = num(env.MAX_QTY_HARDCAP);
  if (Number.isFinite(hardCap) && hardCap > 0) {
    out = Math.min(out, Math.floor(hardCap));
  }

  return Math.max(0, out);
}

async function calcMarginsForOrder({
  kite,
  params,
  qty,
  entryPriceGuess,
  allowEstimateFallback = true,
}) {
  const q = Math.max(0, Math.floor(qty || 0));
  if (!q) {
    return {
      required: 0,
      total: 0,
      chargesTotal: 0,
      raw: null,
      source: "NONE",
      errorCode: null,
      error: null,
    };
  }

  if (kite && typeof kite.orderMargins === "function") {
    try {
      const order_type = params.order_type || params.orderType || "MARKET";
      const pxGuess = num(entryPriceGuess);
      const price =
        order_type === "MARKET"
          ? Number.isFinite(pxGuess) && pxGuess > 0
            ? pxGuess
            : 0
          : pickNum(params.price, params.price !== 0 ? params.price : 0, 0);

      const trigger_price = pickNum(
        params.trigger_price,
        params.triggerPrice,
        params.trigger,
        0,
      );

      const req = {
        exchange: params.exchange,
        tradingsymbol: params.tradingsymbol,
        transaction_type: params.transaction_type,
        quantity: q,
        product: params.product || env.DEFAULT_PRODUCT || "MIS",
        order_type,
        price,
        trigger_price,
        variety: params.variety || env.DEFAULT_ORDER_VARIETY || "regular",
      };

      const resp = await kite.orderMargins([req]);
      const row = Array.isArray(resp)
        ? resp[0]
        : Array.isArray(resp?.data)
          ? resp.data[0]
          : resp?.data || resp;

      if (!row) {
        return {
          required: NaN,
          total: NaN,
          chargesTotal: NaN,
          raw: resp,
          source: "UNAVAILABLE",
          errorCode: "ORDER_MARGINS_EMPTY",
          error: "orderMargins returned no rows",
        };
      }

      const total = pickNum(
        row.total,
        row.total_margin,
        row.totalMargin,
        row.total_required,
        row.totalRequired,
        row.margin?.total,
        row.margin?.total_margin,
      );

      const chargesTotal = pickNum(
        row.charges?.total,
        row.charges_total,
        row.total_charges,
        row.charges?.total_charges,
      );

      const required =
        total + (Number.isFinite(chargesTotal) ? chargesTotal : 0);

      return {
        required,
        total,
        chargesTotal,
        raw: row,
        source: "BROKER",
        errorCode: null,
        error: null,
      };
    } catch (e) {
      logger.warn(
        { e: e?.message || e },
        "[margin] orderMargins failed; falling back to estimate",
      );
      if (!allowEstimateFallback) {
        return {
          required: NaN,
          total: NaN,
          chargesTotal: NaN,
          raw: null,
          source: "UNAVAILABLE",
          errorCode: "ORDER_MARGINS_FAILED",
          error: e?.message || String(e),
        };
      }
    }
  }

  const px = num(entryPriceGuess);
  const product = String(
    params.product || env.DEFAULT_PRODUCT || "MIS",
  ).toUpperCase();
  const value = Number.isFinite(px) && px > 0 ? px * q : NaN;
  if (!Number.isFinite(value)) {
    return {
      required: NaN,
      total: NaN,
      chargesTotal: 0,
      raw: null,
      source: "UNAVAILABLE",
      errorCode: "BAD_ENTRY_PRICE",
      error: "invalid entry price for estimate",
    };
  }

  const side = String(params.transaction_type || "BUY").toUpperCase();
  let mult = 1.0;
  if (product === "MIS") {
    mult = side === "SELL" ? 0.35 : 0.25;
  }
  const total = value * mult;
  return {
    required: total,
    total,
    chargesTotal: 0,
    raw: null,
    source: "ESTIMATE",
    errorCode: null,
    error: null,
  };
}

async function findMaxQtyUnderMargin({
  kite,
  entryParams,
  entryPriceGuess,
  maxQty,
  effAvailable,
  allowEstimateFallback,
}) {
  let lo = 1;
  let hi = Math.max(1, Math.floor(maxQty));
  let best = 0;
  let usedEstimate = false;

  const range = Math.max(1, hi - lo + 1);
  const iters = Math.min(20, Math.ceil(Math.log2(range)) + 2);

  for (let i = 0; i < iters && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const m = await calcMarginsForOrder({
      kite,
      params: entryParams,
      qty: mid,
      entryPriceGuess,
      allowEstimateFallback,
    });

    if (!Number.isFinite(m.required) || m.required <= 0) {
      hi = mid - 1;
      continue;
    }

    if (m.required <= effAvailable) {
      best = mid;
      usedEstimate = usedEstimate || m.source === "ESTIMATE";
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { qty: best, usedEstimate };
}

async function marginAwareSizing({
  kite,
  entryParams,
  entryPriceGuess,
  qtyByRisk,
}) {
  const wanted = Math.max(0, Math.floor(qtyByRisk || 0));
  if (wanted < 1) {
    return {
      ok: true,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "NON_POSITIVE_QTY_BY_RISK",
      meta: { qtyByRisk: wanted },
    };
  }

  const entryPrice = num(entryPriceGuess);
  if (!(Number.isFinite(entryPrice) && entryPrice > 0)) {
    logger.warn(
      { qtyByRisk: wanted, entryPriceGuess },
      "[margin] sizing rejected (invalid entry price guess)",
    );
    return {
      ok: false,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "BAD_ENTRY_PRICE",
      meta: { qtyByRisk: wanted, entryPriceGuess },
    };
  }

  const qtyCap = capQtyByConfig({ qty: wanted, entryPriceGuess: entryPrice });
  if (qtyCap < wanted) {
    logger.info(
      { qtyByRisk: wanted, qtyCap, entryPriceGuess: entryPrice },
      "[margin] qty capped by config",
    );
  }
  if (qtyCap < 1) {
    return {
      ok: true,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "QTY_CAPPED_TO_ZERO",
      meta: { qtyByRisk: wanted, entryPriceGuess: entryPrice, qtyCap },
    };
  }

  if (String(env.USE_MARGIN_SIZING) !== "true") {
    return {
      ok: true,
      qty: qtyCap,
      blocked: false,
      degraded: false,
      reason: "MARGIN_SIZING_DISABLED",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        marginSizingEnabled: false,
      },
    };
  }

  const allowEstimatedOrderMargin =
    String(env.MARGIN_ALLOW_ESTIMATED_ORDER_MARGIN || "false") === "true";

  let margins;
  try {
    margins = await kite.getMargins();
  } catch (e) {
    logger.warn(
      { e: e?.message || e },
      "[margin] getMargins failed; blocking trade",
    );
    return {
      ok: false,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "MARGIN_FUNDS_UNAVAILABLE",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        error: e?.message || String(e),
      },
    };
  }

  const available = getAvailableEquityMargin(margins);
  if (!Number.isFinite(available) || available <= 0) {
    logger.warn(
      { available },
      "[margin] could not parse available equity margin; blocking trade",
    );
    return {
      ok: false,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "MARGIN_FUNDS_PARSE_FAILED",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
      },
    };
  }

  const bufferPct = clampInt(env.MARGIN_BUFFER_PCT ?? 5, 0, 50);
  const usePct = clampInt(env.MARGIN_USE_PCT ?? 100, 0, 100);
  const effAvailable = available * (1 - bufferPct / 100) * (usePct / 100);

  if (!Number.isFinite(effAvailable) || effAvailable <= 0) {
    return {
      ok: true,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: "MARGIN_EFFECTIVE_AVAILABLE_ZERO",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
        effAvailable,
      },
    };
  }

  const mCap = await calcMarginsForOrder({
    kite,
    params: entryParams,
    qty: qtyCap,
    entryPriceGuess,
    allowEstimateFallback: allowEstimatedOrderMargin,
  });

  if (!Number.isFinite(mCap.required) || mCap.required <= 0) {
    return {
      ok: false,
      qty: 0,
      blocked: true,
      degraded: false,
      reason: mCap.errorCode || "ORDER_MARGIN_UNAVAILABLE",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
        effAvailable,
        marginSource: mCap.source || null,
        error: mCap.error || null,
      },
    };
  }

  if (mCap.required <= effAvailable) {
    return {
      ok: true,
      qty: qtyCap,
      blocked: false,
      degraded: mCap.source === "ESTIMATE",
      reason: mCap.source === "ESTIMATE" ? "ORDER_MARGIN_ESTIMATED" : null,
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
        effAvailable,
        requiredCap: mCap.required,
        marginSource: mCap.source,
      },
    };
  }

  let scaled = Math.floor((qtyCap * effAvailable) / mCap.required);
  scaled = Math.floor(scaled * 0.95);
  scaled = Math.max(0, Math.min(qtyCap - 1, scaled));

  if (scaled < 1) {
    logger.info(
      { qtyCap, required: mCap.required, effAvailable },
      "[margin] insufficient funds even for 1 qty",
    );
    return {
      ok: true,
      qty: 0,
      blocked: true,
      degraded: mCap.source === "ESTIMATE",
      reason: "INSUFFICIENT_MARGIN_MIN_QTY",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
        effAvailable,
        requiredCap: mCap.required,
        marginSource: mCap.source,
      },
    };
  }

  const mScaled = await calcMarginsForOrder({
    kite,
    params: entryParams,
    qty: scaled,
    entryPriceGuess,
    allowEstimateFallback: allowEstimatedOrderMargin,
  });

  if (Number.isFinite(mScaled.required) && mScaled.required <= effAvailable) {
    const best = await findMaxQtyUnderMargin({
      kite,
      entryParams,
      entryPriceGuess,
      maxQty: qtyCap,
      effAvailable,
      allowEstimateFallback: allowEstimatedOrderMargin,
    });

    logger.info(
      {
        qtyByRisk: wanted,
        qtyCap,
        finalQty: best.qty,
        available,
        effAvailable,
        requiredCap: mCap.required,
      },
      "[margin] resized qty based on available funds",
    );

    return {
      ok: true,
      qty: best.qty,
      blocked: best.qty < 1,
      degraded:
        mCap.source === "ESTIMATE" ||
        mScaled.source === "ESTIMATE" ||
        best.usedEstimate === true,
      reason: best.qty < 1 ? "INSUFFICIENT_MARGIN_MIN_QTY" : "MARGIN_RESIZED",
      meta: {
        qtyByRisk: wanted,
        entryPriceGuess: entryPrice,
        qtyCap,
        available,
        effAvailable,
        requiredCap: mCap.required,
        requiredScaled: mScaled.required,
        marginSource: best.usedEstimate ? "ESTIMATE" : mScaled.source,
      },
    };
  }

  const best = await findMaxQtyUnderMargin({
    kite,
    entryParams,
    entryPriceGuess,
    maxQty: scaled,
    effAvailable,
    allowEstimateFallback: allowEstimatedOrderMargin,
  });

  logger.info(
    {
      qtyByRisk: wanted,
      qtyCap,
      scaled,
      finalQty: best.qty,
      available,
      effAvailable,
      requiredCap: mCap.required,
    },
    "[margin] resized qty based on available funds",
  );

  return {
    ok: true,
    qty: best.qty,
    blocked: best.qty < 1,
    degraded:
      mCap.source === "ESTIMATE" ||
      mScaled.source === "ESTIMATE" ||
      best.usedEstimate === true,
    reason: best.qty < 1 ? "INSUFFICIENT_MARGIN_MIN_QTY" : "MARGIN_RESIZED",
    meta: {
      qtyByRisk: wanted,
      entryPriceGuess: entryPrice,
      qtyCap,
      available,
      effAvailable,
      requiredCap: mCap.required,
      requiredScaled: mScaled.required,
      marginSource: best.usedEstimate ? "ESTIMATE" : mScaled.source,
    },
  };
}

async function marginAwareQty(args) {
  const result = await marginAwareSizing(args);
  return Math.max(0, Number(result?.qty ?? 0));
}

module.exports = {
  marginAwareQty,
  marginAwareSizing,
  getAvailableEquityMargin,
  calcMarginsForOrder,
  capQtyByConfig,
};
