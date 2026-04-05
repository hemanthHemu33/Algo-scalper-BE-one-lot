const { normalizeStopRiskSemantics } = require("./stopRiskSemantics");
const { normalizeTradeLifecycleState } = require("./tradeLifecycleState");
const { normalizeWinnerProtectionState } = require("./winnerProtectionState");

function normalizeActiveTrade(activeTrade) {
  if (!activeTrade) return null;
  const instrument = activeTrade.instrument || {};
  const instrument_token =
    activeTrade.instrument_token ??
    activeTrade.instrumentToken ??
    instrument.instrument_token ??
    null;
  const tradingsymbol =
    instrument.tradingsymbol ??
    activeTrade.tradingsymbol ??
    activeTrade.symbol ??
    null;
  const timeStopAt =
    activeTrade.timeStopAt ??
    activeTrade.timeStopAtMs ??
    activeTrade.timeStopAtTs ??
    activeTrade.timeStopAtIso ??
    activeTrade.timeStopMs ??
    null;
  const stopRisk = normalizeStopRiskSemantics(activeTrade);
  const lifecycle = normalizeTradeLifecycleState(activeTrade);

  return {
    ...activeTrade,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
    },
    side: activeTrade.side ?? activeTrade.transaction_type ?? null,
    version: activeTrade.version ?? activeTrade.trade_version ?? 0,
    entryPrice: activeTrade.entryPrice ?? activeTrade.entry_price ?? null,
    ...stopRisk,
    targetPrice: activeTrade.targetPrice ?? activeTrade.target_price ?? null,
    minGreenInr: activeTrade.minGreenInr ?? activeTrade.min_green_inr ?? null,
    minGreenPts: activeTrade.minGreenPts ?? activeTrade.min_green_pts ?? null,
    beLocked: activeTrade.beLocked ?? activeTrade.be_locked ?? null,
    trueBePrice: activeTrade.trueBePrice ?? activeTrade.true_be_price ?? null,
    costGreenFloorInr:
      activeTrade.costGreenFloorInr ?? activeTrade.cost_green_floor_inr ?? null,
    costGreenFloorPrice:
      activeTrade.costGreenFloorPrice ?? activeTrade.cost_green_floor_price ?? null,
    greenLockActive:
      activeTrade.greenLockActive ?? activeTrade.green_lock_active ?? null,
    greenLockFloorPrice:
      activeTrade.greenLockFloorPrice ?? activeTrade.green_lock_floor_price ?? null,
    beAppliedAt: activeTrade.beAppliedAt ?? activeTrade.be_applied_at ?? null,
    beAppliedStopLoss:
      activeTrade.beAppliedStopLoss ?? activeTrade.be_applied_stop_loss ?? null,
    beApplyFails: activeTrade.beApplyFails ?? activeTrade.be_apply_fails ?? null,
    executionRiskPts:
      activeTrade.executionRiskPts ?? activeTrade.execution_risk_pts ?? null,
    executionRiskQty:
      activeTrade.executionRiskQty ?? activeTrade.execution_risk_qty ?? null,
    executionRiskInr:
      activeTrade.executionRiskInr ?? activeTrade.execution_risk_inr ?? null,
    peakLtp: activeTrade.peakLtp ?? activeTrade.peak_ltp ?? null,
    peakPnlInr: activeTrade.peakPnlInr ?? activeTrade.peak_pnl_inr ?? null,
    peakPnlR: activeTrade.peakPnlR ?? activeTrade.peak_pnl_r ?? null,
    peakExecutablePnlInr:
      activeTrade.peakExecutablePnlInr ?? activeTrade.peak_executable_pnl_inr ?? null,
    ...normalizeWinnerProtectionState(activeTrade),
    shadowExitActive:
      activeTrade.shadowExitActive ?? activeTrade.shadow_exit_active ?? null,
    protectionUpgradePending:
      activeTrade.protectionUpgradePending ??
      activeTrade.protection_upgrade_pending ??
      null,
    protectionUpgradeSoftFailed:
      activeTrade.protectionUpgradeSoftFailed ??
      activeTrade.protection_upgrade_soft_failed ??
      null,
    protectionUpgradeFallbackMode:
      activeTrade.protectionUpgradeFallbackMode ??
      activeTrade.protection_upgrade_fallback_mode ??
      null,
    protectionUpgradeUnconfirmedSince:
      activeTrade.protectionUpgradeUnconfirmedSince ??
      activeTrade.protection_upgrade_unconfirmed_since ??
      null,
    shadowProtectionActiveReason:
      activeTrade.shadowProtectionActiveReason ??
      activeTrade.shadow_protection_active_reason ??
      null,
    runnerRebasedAt:
      activeTrade.runnerRebasedAt ?? activeTrade.runner_rebased_at ?? null,
    runnerRebaseSource:
      activeTrade.runnerRebaseSource ?? activeTrade.runner_rebase_source ?? null,
    ...lifecycle,
    lastProtectedR:
      activeTrade.lastProtectedR ?? activeTrade.last_protected_r ?? null,
    lastProtectedInr:
      activeTrade.lastProtectedInr ?? activeTrade.last_protected_inr ?? null,
    lastExitPlanReason:
      activeTrade.lastExitPlanReason ?? activeTrade.last_exit_plan_reason ?? null,
    trailSl: activeTrade.trailSl ?? activeTrade.trail_sl ?? null,
    entryUrgencyKey:
      activeTrade.entryUrgencyKey ?? activeTrade.entry_urgency_key ?? null,
    entryRepriceCount:
      activeTrade.entryRepriceCount ?? activeTrade.entry_reprice_count ?? null,
    entryPendingLastReason:
      activeTrade.entryPendingLastReason ?? activeTrade.entry_pending_last_reason ?? null,
    entryPendingLastCheckAt:
      activeTrade.entryPendingLastCheckAt ?? activeTrade.entry_pending_last_check_at ?? null,
    timeStopAt,
    exitReason: activeTrade.exitReason ?? activeTrade.exit_reason ?? null,
  };
}

function normalizeTradeRow(row) {
  if (!row) return row;
  const instrument = row.instrument || {};
  const instrument_token =
    row.instrument_token ?? row.instrumentToken ?? instrument.instrument_token ?? null;
  const tradingsymbol =
    instrument.tradingsymbol ?? row.tradingsymbol ?? row.symbol ?? null;
  const exchange = instrument.exchange ?? row.exchange ?? null;
  const segment = instrument.segment ?? row.segment ?? null;
  const regimeValue =
    row.regime ?? row.marketRegime ?? row.regimeLabel ?? row.regime_state ?? null;
  const premiumValue =
    row.premium ?? row.entryPremium ?? row.entry_premium ?? null;
  const entrySlippageValue =
    row.entrySlippage ?? row.slippageEntry ?? row.slippage_entry ?? null;
  const exitSlippageValue =
    row.exitSlippage ?? row.slippageExit ?? row.slippage_exit ?? null;
  const totalSlippageValue =
    row.slippage ??
    row.totalSlippage ??
    row.slippageTotal ??
    null;
  const entrySpreadValue =
    row.entrySpread ?? row.spreadAtEntry ?? row.entry_spread ?? null;
  const maeValue =
    row.mae ?? row.MAE ?? row.maxAdverseExcursion ?? row.max_adverse_excursion ?? null;
  const mfeValue =
    row.mfe ?? row.MFE ?? row.maxFavorableExcursion ?? row.max_favorable_excursion ?? null;
  const timeStopAt =
    row.timeStopAt ??
    row.time_stop_at ??
    row.timeStopAtMs ??
    row.timeStopAtTs ??
    row.timeStopAtIso ??
    row.timeStopMs ??
    null;
  const decisionAt =
    row.decisionAt ?? row.decision_at ?? row.signalAt ?? row.signal_at ?? null;
  const entryAt = row.entryAt ?? row.entry_at ?? row.entryFilledAt ?? null;
  const exitAt = row.exitAt ?? row.exit_at ?? null;
  const marketContextAtEntry =
    row.marketContextAtEntry ?? row.market_context_at_entry ?? null;
  const costPayload = row.costPayload ?? row.cost_payload ?? null;
  const entryCostSlippage =
    row.entrySlippage ?? costPayload?.entrySlippage ?? null;
  const exitCostSlippage = row.exitSlippage ?? costPayload?.exitSlippage ?? null;
  const brokerageCost = row.brokerage ?? costPayload?.brokerage ?? null;
  const taxesCost = row.taxes ?? costPayload?.taxes ?? null;
  const feesTotalCost = row.feesTotal ?? costPayload?.feesTotal ?? null;
  const stopRisk = normalizeStopRiskSemantics(row);
  const lifecycle = normalizeTradeLifecycleState(row);

  return {
    ...row,
    tradeId: row.tradeId ?? row.trade_id ?? row._id ?? null,
    strategyId: row.strategyId ?? row.strategy_id ?? null,
    instrument_token,
    instrument: {
      ...instrument,
      tradingsymbol,
      exchange,
      segment,
    },
    side: row.side ?? row.transaction_type ?? null,
    qty: row.qty ?? row.quantity ?? null,
    version: row.version ?? row.trade_version ?? 0,
    entryPrice: row.entryPrice ?? row.entry_price ?? null,
    exitPrice: row.exitPrice ?? row.exit_price ?? null,
    ...stopRisk,
    targetPrice: row.targetPrice ?? row.target_price ?? null,
    tp1Price: row.tp1Price ?? row.tp1_price ?? null,
    minGreenInr: row.minGreenInr ?? row.min_green_inr ?? null,
    minGreenPts: row.minGreenPts ?? row.min_green_pts ?? null,
    beLocked: row.beLocked ?? row.be_locked ?? null,
    trueBePrice: row.trueBePrice ?? row.true_be_price ?? null,
    costGreenFloorInr: row.costGreenFloorInr ?? row.cost_green_floor_inr ?? null,
    costGreenFloorPrice:
      row.costGreenFloorPrice ?? row.cost_green_floor_price ?? null,
    greenLockActive: row.greenLockActive ?? row.green_lock_active ?? null,
    greenLockFloorPrice:
      row.greenLockFloorPrice ?? row.green_lock_floor_price ?? null,
    beAppliedAt: row.beAppliedAt ?? row.be_applied_at ?? null,
    beAppliedStopLoss: row.beAppliedStopLoss ?? row.be_applied_stop_loss ?? null,
    beApplyFails: row.beApplyFails ?? row.be_apply_fails ?? null,
    executionRiskPts:
      row.executionRiskPts ?? row.execution_risk_pts ?? null,
    executionRiskQty:
      row.executionRiskQty ?? row.execution_risk_qty ?? null,
    executionRiskInr:
      row.executionRiskInr ?? row.execution_risk_inr ?? null,
    peakLtp: row.peakLtp ?? row.peak_ltp ?? null,
    peakPnlInr: row.peakPnlInr ?? row.peak_pnl_inr ?? null,
    peakPnlR: row.peakPnlR ?? row.peak_pnl_r ?? null,
    peakExecutablePnlInr:
      row.peakExecutablePnlInr ?? row.peak_executable_pnl_inr ?? null,
    ...normalizeWinnerProtectionState(row),
    shadowExitActive: row.shadowExitActive ?? row.shadow_exit_active ?? null,
    protectionUpgradePending:
      row.protectionUpgradePending ??
      row.protection_upgrade_pending ??
      null,
    protectionUpgradeSoftFailed:
      row.protectionUpgradeSoftFailed ??
      row.protection_upgrade_soft_failed ??
      null,
    protectionUpgradeFallbackMode:
      row.protectionUpgradeFallbackMode ??
      row.protection_upgrade_fallback_mode ??
      null,
    protectionUpgradeUnconfirmedSince:
      row.protectionUpgradeUnconfirmedSince ??
      row.protection_upgrade_unconfirmed_since ??
      null,
    shadowProtectionActiveReason:
      row.shadowProtectionActiveReason ??
      row.shadow_protection_active_reason ??
      null,
    runnerRebasedAt:
      row.runnerRebasedAt ?? row.runner_rebased_at ?? null,
    runnerRebaseSource:
      row.runnerRebaseSource ?? row.runner_rebase_source ?? null,
    ...lifecycle,
    lastProtectedR: row.lastProtectedR ?? row.last_protected_r ?? null,
    lastProtectedInr: row.lastProtectedInr ?? row.last_protected_inr ?? null,
    lastExitPlanReason:
      row.lastExitPlanReason ?? row.last_exit_plan_reason ?? null,
    trailSl: row.trailSl ?? row.trail_sl ?? null,
    entryUrgencyKey: row.entryUrgencyKey ?? row.entry_urgency_key ?? null,
    entryRepriceCount: row.entryRepriceCount ?? row.entry_reprice_count ?? null,
    entryPendingLastReason:
      row.entryPendingLastReason ?? row.entry_pending_last_reason ?? null,
    entryPendingLastCheckAt:
      row.entryPendingLastCheckAt ?? row.entry_pending_last_check_at ?? null,
    timeStopAt,
    status: row.status ?? null,
    closeReason: row.closeReason ?? row.close_reason ?? null,
    exitReason: row.exitReason ?? row.exit_reason ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
    decisionAt,
    entryAt,
    exitAt,
    marketContextAtEntry,
    market_context_at_entry: marketContextAtEntry,
    costPayload,
    cost_payload: costPayload,
    regime: row.regime ?? regimeValue,
    marketRegime: row.marketRegime ?? regimeValue,
    regimeLabel: row.regimeLabel ?? regimeValue,
    regime_state: row.regime_state ?? regimeValue,
    premium: row.premium ?? premiumValue,
    entryPremium: row.entryPremium ?? premiumValue,
    entry_premium: row.entry_premium ?? premiumValue,
    entrySlippage: row.entrySlippage ?? entrySlippageValue,
    slippageEntry: row.slippageEntry ?? entrySlippageValue,
    slippage_entry: row.slippage_entry ?? entrySlippageValue,
    exitSlippage: row.exitSlippage ?? exitSlippageValue,
    slippageExit: row.slippageExit ?? exitSlippageValue,
    slippage_exit: row.slippage_exit ?? exitSlippageValue,
    brokerage: brokerageCost,
    taxes: taxesCost,
    feesTotal: feesTotalCost,
    slippage: row.slippage ?? totalSlippageValue,
    totalSlippage: row.totalSlippage ?? totalSlippageValue,
    slippageTotal: row.slippageTotal ?? totalSlippageValue,
    entrySpread: row.entrySpread ?? entrySpreadValue,
    spreadAtEntry: row.spreadAtEntry ?? entrySpreadValue,
    entry_spread: row.entry_spread ?? entrySpreadValue,
    spread: row.spread ?? entrySpreadValue,
    mae: row.mae ?? maeValue,
    MAE: row.MAE ?? maeValue,
    maxAdverseExcursion: row.maxAdverseExcursion ?? maeValue,
    max_adverse_excursion: row.max_adverse_excursion ?? maeValue,
    mfe: row.mfe ?? mfeValue,
    MFE: row.MFE ?? mfeValue,
    maxFavorableExcursion: row.maxFavorableExcursion ?? mfeValue,
    max_favorable_excursion: row.max_favorable_excursion ?? mfeValue,
  };
}

module.exports = { normalizeActiveTrade, normalizeTradeRow };
