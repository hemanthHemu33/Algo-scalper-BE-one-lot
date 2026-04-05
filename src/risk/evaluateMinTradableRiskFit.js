function toFinite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function floorToLot(qty, lotSize) {
  const lot = Math.max(1, toFinite(lotSize, 1));
  if (!(qty > 0)) return 0;
  return Math.floor(qty / lot) * lot;
}

function evaluateMinTradableRiskFit({
  entryPrice,
  strategyStopLoss,
  side,
  lotSize,
  riskBudgetInr,
  expectedSlippagePts,
  feePerLotInr,
  tickSize,
}) {
  const entry = toFinite(entryPrice, NaN);
  const stop = toFinite(strategyStopLoss, NaN);
  const rawLot = toFinite(lotSize, NaN);
  const rawRiskBudget = toFinite(riskBudgetInr, NaN);
  const rawTick = toFinite(tickSize, NaN);
  const lot = Math.max(1, rawLot);
  const riskBudget = Math.max(0, rawRiskBudget);
  const slipPts = Math.max(0, toFinite(expectedSlippagePts, 0));
  const fees = Math.max(0, toFinite(feePerLotInr, 0));
  const tick = Math.max(0.01, rawTick);
  const strategyRiskPtsRaw =
    Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : NaN;
  const strategyRiskPts =
    Number.isFinite(strategyRiskPtsRaw) && strategyRiskPtsRaw > 0
      ? Math.max(tick, strategyRiskPtsRaw)
      : NaN;

  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0)) {
    return {
      ok: false,
      reason: "BAD_INPUT",
      strategyRiskPts: null,
      oneLotAllInRiskInr: null,
      maxLotsByRisk: 0,
      maxQtyByRisk: 0,
      fitsMinTradable: false,
      breachInr: null,
      breachPct: null,
      recommendedAction: "REJECT",
      meta: { entryPrice, strategyStopLoss, side, lotSize, riskBudgetInr },
    };
  }
  if (!(Number.isFinite(rawLot) && rawLot > 0)) {
    return {
      ok: false,
      reason: "BAD_LOT_SIZE",
      strategyRiskPts: null,
      oneLotAllInRiskInr: null,
      maxLotsByRisk: 0,
      maxQtyByRisk: 0,
      fitsMinTradable: false,
      breachInr: null,
      breachPct: null,
      recommendedAction: "REJECT",
      meta: { entryPrice, strategyStopLoss, side, lotSize, riskBudgetInr },
    };
  }
  if (!(Number.isFinite(rawTick) && rawTick > 0)) {
    return {
      ok: false,
      reason: "BAD_TICK_SIZE",
      strategyRiskPts: null,
      oneLotAllInRiskInr: null,
      maxLotsByRisk: 0,
      maxQtyByRisk: 0,
      fitsMinTradable: false,
      breachInr: null,
      breachPct: null,
      recommendedAction: "REJECT",
      meta: { entryPrice, strategyStopLoss, side, lotSize, riskBudgetInr, tickSize },
    };
  }
  if (!(Number.isFinite(rawRiskBudget) && rawRiskBudget > 0)) {
    return {
      ok: false,
      reason: "NON_POSITIVE_RISK_BUDGET",
      strategyRiskPts: null,
      oneLotAllInRiskInr: null,
      maxLotsByRisk: 0,
      maxQtyByRisk: 0,
      fitsMinTradable: false,
      breachInr: null,
      breachPct: null,
      recommendedAction: "REJECT",
      meta: { entryPrice, strategyStopLoss, side, lotSize, riskBudgetInr },
    };
  }
  if (!(Number.isFinite(strategyRiskPts) && strategyRiskPts > 0)) {
    return {
      ok: false,
      reason: "NON_POSITIVE_RISK_DISTANCE",
      strategyRiskPts: null,
      oneLotAllInRiskInr: null,
      maxLotsByRisk: 0,
      maxQtyByRisk: 0,
      fitsMinTradable: false,
      breachInr: null,
      breachPct: null,
      recommendedAction: "REJECT",
      meta: { entryPrice, strategyStopLoss, side, lotSize, riskBudgetInr, tickSize },
    };
  }

  const oneLotAllInRiskInr = (strategyRiskPts + slipPts) * lot + fees;
  const maxLotsByRisk =
    oneLotAllInRiskInr > 0 ? Math.floor(riskBudget / oneLotAllInRiskInr) : 0;
  const maxQtyByRisk = floorToLot(maxLotsByRisk * lot, lot);
  const fitsMinTradable = maxLotsByRisk >= 1;
  const breachInr = fitsMinTradable
    ? 0
    : Math.max(0, oneLotAllInRiskInr - riskBudget);
  const breachPct =
    riskBudget > 0 && Number.isFinite(breachInr)
      ? (breachInr / riskBudget) * 100
      : null;

  return {
    ok: true,
    reason: null,
    side: String(side || "BUY").toUpperCase(),
    strategyRiskPts,
    oneLotAllInRiskInr,
    maxLotsByRisk,
    maxQtyByRisk,
    fitsMinTradable,
    breachInr,
    breachPct,
    recommendedAction: fitsMinTradable ? "ALLOW" : "REJECT",
    meta: {
      lotSize: lot,
      riskBudgetInr: riskBudget,
      expectedSlippagePts: slipPts,
      feePerLotInr: fees,
      tickSize: tick,
    },
  };
}

module.exports = {
  evaluateMinTradableRiskFit,
};
