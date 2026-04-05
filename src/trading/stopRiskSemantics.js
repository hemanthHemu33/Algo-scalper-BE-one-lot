function toFinite(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const IMMUTABLE_STRATEGY_STOP_KEYS = Object.freeze([
  "strategyStopLoss",
  "strategy_stop_loss",
  "initialStrategyStopLoss",
  "initial_strategy_stop_loss",
  "initialStopLoss",
  "initial_stop_loss",
]);

function firstFinite(source = {}, keys = []) {
  for (const key of keys) {
    const value = toFinite(source?.[key], null);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function resolveStrategyStopLoss(trade = {}) {
  return firstFinite(trade, IMMUTABLE_STRATEGY_STOP_KEYS);
}

function resolveSizingStopLoss(trade = {}) {
  return toFinite(
    trade.sizingStopLoss ??
      trade.sizing_stop_loss ??
      resolveStrategyStopLoss(trade),
    null,
  );
}

function resolveBrokerStopLoss(trade = {}) {
  return toFinite(
    trade.brokerStopLoss ??
      trade.broker_stop_loss ??
      trade.stopLoss ??
      trade.stop_loss ??
      resolveSizingStopLoss(trade),
    null,
  );
}

function buildStrategyStopLossBackfillPatch(
  trade = {},
  { allowRecoveryBrokerFallback = false } = {},
) {
  const patch = {};
  const explicitStrategyStopLoss = firstFinite(trade, [
    "strategyStopLoss",
    "strategy_stop_loss",
    "initialStrategyStopLoss",
    "initial_strategy_stop_loss",
  ]);
  const strategyStopLoss = resolveStrategyStopLoss(trade);
  const initialStopLoss = toFinite(
    trade.initialStopLoss ?? trade.initial_stop_loss,
    null,
  );
  const riskStopPrice = toFinite(
    trade.riskStopPrice ?? trade.risk_stop_price,
    null,
  );

  let recoveredStrategyStopLoss = strategyStopLoss;
  let recoverySource = null;
  let recoveryFallbackUsed = false;

  if (!Number.isFinite(explicitStrategyStopLoss)) {
    if (Number.isFinite(initialStopLoss)) {
      recoveredStrategyStopLoss = initialStopLoss;
      recoverySource = "INITIAL_STOP_LOSS";
    } else if (Number.isFinite(riskStopPrice)) {
      recoveredStrategyStopLoss = riskStopPrice;
      recoverySource = "RISK_STOP_PRICE";
    } else if (allowRecoveryBrokerFallback) {
      const mutableBrokerStop = toFinite(
        trade.brokerStopLoss ??
          trade.broker_stop_loss ??
          trade.stopLoss ??
          trade.stop_loss,
        null,
      );
      if (Number.isFinite(mutableBrokerStop)) {
        recoveredStrategyStopLoss = mutableBrokerStop;
        recoverySource = "RECOVERY_MUTABLE_BROKER_STOP";
        recoveryFallbackUsed = true;
      }
    }
  }

  if (
    !Number.isFinite(explicitStrategyStopLoss) &&
    Number.isFinite(recoveredStrategyStopLoss)
  ) {
    patch.strategyStopLoss = recoveredStrategyStopLoss;
  }
  if (
    !Number.isFinite(initialStopLoss) &&
    Number.isFinite(recoveredStrategyStopLoss)
  ) {
    patch.initialStopLoss = recoveredStrategyStopLoss;
  }

  const sizingStopLoss = resolveSizingStopLoss({
    ...trade,
    ...patch,
  });
  if (
    !Number.isFinite(toFinite(trade.sizingStopLoss ?? trade.sizing_stop_loss, null)) &&
    Number.isFinite(sizingStopLoss)
  ) {
    patch.sizingStopLoss = sizingStopLoss;
  }

  const brokerStopLoss = resolveBrokerStopLoss({
    ...trade,
    ...patch,
  });
  if (
    !Number.isFinite(
      toFinite(
        trade.brokerStopLoss ??
          trade.broker_stop_loss ??
          trade.stopLoss ??
          trade.stop_loss,
        null,
      ),
    ) &&
    Number.isFinite(brokerStopLoss)
  ) {
    patch.brokerStopLoss = brokerStopLoss;
  }
  if (
    !Number.isFinite(toFinite(trade.slTrigger ?? trade.sl_trigger, null)) &&
    Number.isFinite(brokerStopLoss)
  ) {
    patch.slTrigger = brokerStopLoss;
  }

  if (recoverySource) {
    patch.strategyStopLossRecoverySource = recoverySource;
    patch.strategyStopLossRecoveryFallbackUsed = recoveryFallbackUsed;
  }

  return patch;
}

function computeActualRiskFromStrategyStop({
  entryPrice,
  strategyStopLoss,
  qty,
  side,
}) {
  const entry = toFinite(entryPrice, NaN);
  const stop = toFinite(strategyStopLoss, NaN);
  const quantity = Math.max(0, toFinite(qty, 0));
  const normalizedSide = String(side || "BUY").toUpperCase();

  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0 && quantity > 0)) {
    return {
      ok: false,
      side: normalizedSide,
      riskPts: null,
      riskInr: null,
      entryPrice: entryPrice ?? null,
      strategyStopLoss: strategyStopLoss ?? null,
      qty: qty ?? null,
    };
  }

  const riskPts = Math.abs(entry - stop);
  return {
    ok: true,
    side: normalizedSide,
    riskPts,
    riskInr: riskPts * quantity,
    entryPrice: entry,
    strategyStopLoss: stop,
    qty: quantity,
  };
}

function classifyPostFillRiskBreach({
  trueRiskInr,
  capInr,
  softBreachPct,
  hardBreachPct,
}) {
  const risk = Math.max(0, toFinite(trueRiskInr, 0));
  const cap = Math.max(0, toFinite(capInr, 0));
  const softPct = Math.max(0, toFinite(softBreachPct, 5));
  const hardPct = Math.max(softPct, toFinite(hardBreachPct, 12));

  if (!(cap > 0) || !Number.isFinite(risk)) {
    return {
      state: "NONE",
      capInr: cap,
      trueRiskInr: risk,
      softLimitInr: cap,
      hardLimitInr: cap,
      breachInr: 0,
      breachPct: 0,
    };
  }

  const breachInr = Math.max(0, risk - cap);
  const breachPct = cap > 0 ? (breachInr / cap) * 100 : 0;
  const softLimitInr = cap * (1 + softPct / 100);
  const hardLimitInr = cap * (1 + hardPct / 100);

  let state = "NONE";
  if (risk > hardLimitInr) state = "HARD";
  else if (risk > cap) state = "SOFT";

  return {
    state,
    capInr: cap,
    trueRiskInr: risk,
    softLimitInr,
    hardLimitInr,
    breachInr,
    breachPct,
  };
}

function normalizeStopRiskSemantics(trade = {}) {
  const backfillPatch = buildStrategyStopLossBackfillPatch(trade);
  const mergedTrade = {
    ...trade,
    ...backfillPatch,
  };
  const strategyStopLoss = resolveStrategyStopLoss(mergedTrade);
  const sizingStopLoss = resolveSizingStopLoss({
    ...mergedTrade,
    strategyStopLoss,
  });
  const brokerStopLoss = resolveBrokerStopLoss({
    ...mergedTrade,
    strategyStopLoss,
    sizingStopLoss,
  });

  return {
    ...backfillPatch,
    strategyStopLoss,
    sizingStopLoss,
    brokerStopLoss,
    stopLoss: brokerStopLoss ?? trade.stopLoss ?? trade.stop_loss ?? null,
    initialStopLoss:
      strategyStopLoss ??
      trade.initialStopLoss ??
      trade.initial_stop_loss ??
      brokerStopLoss ??
      null,
    slTrigger:
      toFinite(
        trade.slTrigger ?? trade.sl_trigger ?? brokerStopLoss ?? strategyStopLoss,
        null,
      ) ?? null,
    initialStrategyRiskPts:
      trade.initialStrategyRiskPts ?? trade.initial_strategy_risk_pts ?? null,
    initialStrategyRiskInr:
      trade.initialStrategyRiskInr ?? trade.initial_strategy_risk_inr ?? null,
    oneLotPlannedRiskInr:
      trade.oneLotPlannedRiskInr ?? trade.one_lot_planned_risk_inr ?? null,
    riskBudgetInr: trade.riskBudgetInr ?? trade.risk_budget_inr ?? trade.riskInr ?? null,
    riskFitMode: trade.riskFitMode ?? trade.risk_fit_mode ?? "FIT",
    riskBreachState: trade.riskBreachState ?? trade.risk_breach_state ?? "NONE",
    slCompressionPct:
      trade.slCompressionPct ?? trade.sl_compression_pct ?? null,
    postFillTrueRiskInr:
      trade.postFillTrueRiskInr ?? trade.post_fill_true_risk_inr ?? null,
    postFillRiskCapInr:
      trade.postFillRiskCapInr ?? trade.post_fill_risk_cap_inr ?? null,
    postFillRiskAction:
      trade.postFillRiskAction ?? trade.post_fill_risk_action ?? "NONE",
  };
}

module.exports = {
  resolveStrategyStopLoss,
  resolveSizingStopLoss,
  resolveBrokerStopLoss,
  buildStrategyStopLossBackfillPatch,
  computeActualRiskFromStrategyStop,
  classifyPostFillRiskBreach,
  normalizeStopRiskSemantics,
};
