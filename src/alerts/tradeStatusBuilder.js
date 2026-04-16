const crypto = require("crypto");
const { resolveExitLifecycle } = require("../trading/tradeLifecycleState");

const TERMINAL_STATUSES = new Set([
  "EXITED_TARGET",
  "EXITED_SL",
  "EXIT_FILLED",
  "ENTRY_FAILED",
  "ENTRY_CANCELLED",
  "GUARD_FAILED",
  "CLOSED",
]);

function toFiniteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeText(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function normalizeUpper(value) {
  const raw = normalizeText(value);
  return raw ? raw.toUpperCase() : null;
}

function formatIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function hashObject(value) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(value || {}))
    .digest("hex");
}

function computeOpenPnlInr(trade, ltp) {
  const entryPrice = toFiniteOrNull(
    trade?.entryPrice ??
      trade?.actualEntry ??
      trade?.expectedEntryPrice ??
      trade?.quoteAtEntry?.ltp,
  );
  const qty = toFiniteOrNull(trade?.qty);
  const livePrice = toFiniteOrNull(ltp);
  const side = normalizeUpper(trade?.side);
  if (
    entryPrice == null ||
    qty == null ||
    livePrice == null ||
    !["BUY", "SELL"].includes(side)
  ) {
    return null;
  }
  return side === "BUY"
    ? (livePrice - entryPrice) * qty
    : (entryPrice - livePrice) * qty;
}

function computeExitedQty(trade) {
  const initialQty = toFiniteOrNull(trade?.initialQty);
  const qty = toFiniteOrNull(trade?.qty);
  const tp1FilledQty = toFiniteOrNull(trade?.tp1FilledQty);

  if (initialQty != null && qty != null && initialQty >= qty) {
    const exitedQty = initialQty - qty;
    if (exitedQty > 0) return exitedQty;
  }
  return tp1FilledQty;
}

function buildAlcStateLabel(trade) {
  const submittedState = normalizeUpper(
    trade?.loserCompressionSubmittedState ??
      trade?.loserCompressionTargetState,
  );
  const appliedState = normalizeUpper(trade?.loserCompressionAppliedState);
  const pendingAction = normalizeUpper(trade?.loserCompressionPendingAction);
  if (
    Boolean(trade?.protectionUpgradePending) ||
    pendingAction === "STOP_MODIFY"
  ) {
    return `ALC pending${submittedState ? ` ${submittedState}` : ""}`;
  }
  if (appliedState && appliedState !== "NONE") {
    return `ALC applied ${appliedState}`;
  }
  return null;
}

function buildBeStateLabel(trade) {
  if (trade?.beAppliedAt || trade?.beAppliedStopLoss != null) {
    return "BE active";
  }
  if (Boolean(trade?.beLocked)) return "BE armed";
  return null;
}

function buildTrailStateLabel(trade) {
  const stopSource = normalizeUpper(trade?.protectedStopSource);
  if (
    Boolean(trade?.trailActive) ||
    stopSource === "TRAIL" ||
    stopSource === "PROFIT_LOCK"
  ) {
    return "Trail active";
  }
  return null;
}

function buildTargetStateLabel(snapshot) {
  if (snapshot?.targetOrderId) return "Target live";
  if (snapshot?.targetVirtual) return "Target virtual";
  return null;
}

function buildProtectionStage(trade) {
  const parts = [];
  const alcLabel = buildAlcStateLabel(trade);
  const beLabel = buildBeStateLabel(trade);
  const trailLabel = buildTrailStateLabel(trade);

  if (alcLabel) parts.push(alcLabel);
  if (Boolean(trade?.shadowExitActive)) parts.push("Shadow exit");
  if (Boolean(trade?.greenLockActive)) parts.push("Green lock");
  if (beLabel) parts.push(beLabel);
  if (trailLabel) parts.push(trailLabel);
  if (!parts.length && trade?.slOrderId) parts.push("Protection live");

  return parts.join(" | ") || null;
}

function buildCloseFamily(terminalEvent) {
  switch (terminalEvent) {
    case "EXITED_TARGET":
      return "TARGET";
    case "EXITED_SL":
      return "STOP";
    case "PANIC_EXIT_FILLED":
      return "PANIC";
    case "TIME_STOP_EXIT":
      return "TIME_STOP";
    case "FORCE_FLATTEN_EXIT":
      return "FORCE_FLATTEN";
    case "RESTART_FLATTEN_EXIT":
      return "RESTART_FLATTEN";
    case "MANUAL_EXIT":
      return "MANUAL";
    case "GUARD_FAIL_EXIT":
      return "GUARD_FAIL";
    case "PROTECTION_FAILURE_EXIT":
      return "PROTECTION_FAILURE";
    case "ENTRY_FAILED":
    case "ENTRY_CANCELLED":
      return "ENTRY";
    default:
      return "GENERIC";
  }
}

function resolveTerminalSeverity(terminalEvent) {
  switch (terminalEvent) {
    case "EXITED_TARGET":
      return "info";
    case "ENTRY_CANCELLED":
    case "EXITED_SL":
    case "TIME_STOP_EXIT":
    case "FORCE_FLATTEN_EXIT":
    case "EXIT_FILLED_GENERIC":
      return "warn";
    case "PANIC_EXIT_FILLED":
    case "GUARD_FAIL_EXIT":
    case "PROTECTION_FAILURE_EXIT":
    case "ENTRY_FAILED":
    case "RESTART_FLATTEN_EXIT":
      return "error";
    default:
      return "warn";
  }
}

function classifyTerminalOutcome(status, exitLifecycle, closeReason) {
  const normalizedCloseReason = normalizeUpper(closeReason) || "";
  const exitReasonCode = normalizeUpper(exitLifecycle?.exitReasonCode) || "";
  const exitAuthority = normalizeUpper(exitLifecycle?.exitAuthority) || "";

  let terminalEvent = null;
  if (status === "ENTRY_FAILED") {
    terminalEvent = "ENTRY_FAILED";
  } else if (status === "ENTRY_CANCELLED") {
    terminalEvent = "ENTRY_CANCELLED";
  } else if (
    normalizedCloseReason.includes("HARD_FLAT_ON_RESTART") ||
    normalizedCloseReason.includes("RESTART")
  ) {
    terminalEvent = "RESTART_FLATTEN_EXIT";
  } else if (normalizedCloseReason.includes("FORCE_FLATTEN")) {
    terminalEvent = "FORCE_FLATTEN_EXIT";
  } else if (
    normalizedCloseReason.includes("MANUAL_EXIT") ||
    normalizedCloseReason.includes("BROKER_POSITION_FLAT_MANUAL_EXIT")
  ) {
    terminalEvent = "MANUAL_EXIT";
  } else if (
    normalizedCloseReason.includes("SL_PLACE_FAILED") ||
    normalizedCloseReason.includes("TARGET_PLACE_FAILED") ||
    normalizedCloseReason.includes("RUNNER_TARGET_PLACE_FAILED") ||
    normalizedCloseReason.includes("PROTECTION_FAILURE")
  ) {
    terminalEvent = "PROTECTION_FAILURE_EXIT";
  } else if (
    exitAuthority === "TIME_STOP_ENGINE" ||
    exitReasonCode.startsWith("TIME_STOP")
  ) {
    terminalEvent = "TIME_STOP_EXIT";
  } else if (
    exitAuthority === "PANIC_EXIT_ENGINE" ||
    exitReasonCode.includes("PANIC_EXIT") ||
    normalizedCloseReason.includes("PANIC_EXIT")
  ) {
    terminalEvent = "PANIC_EXIT_FILLED";
  } else if (status === "GUARD_FAILED") {
    terminalEvent = "GUARD_FAIL_EXIT";
  } else if (
    status === "EXITED_TARGET" ||
    exitReasonCode === "TARGET_HIT"
  ) {
    terminalEvent = "EXITED_TARGET";
  } else if (
    status === "EXITED_SL" ||
    exitAuthority === "STOP_ORDER"
  ) {
    terminalEvent = "EXITED_SL";
  } else if (
    status === "EXIT_FILLED" ||
    status === "CLOSED" ||
    exitReasonCode ||
    exitAuthority
  ) {
    terminalEvent = "EXIT_FILLED_GENERIC";
  }

  if (!terminalEvent) return null;
  return {
    terminalEvent,
    closeFamily: buildCloseFamily(terminalEvent),
    terminalSeverity: resolveTerminalSeverity(terminalEvent),
  };
}

function buildTradeStatusSnapshot({ trade, runtime = {} }) {
  if (!trade || typeof trade !== "object") return null;

  const status = normalizeUpper(trade.status) || "UNKNOWN";
  const instrument = trade.instrument || {};
  const qty = toFiniteOrNull(trade.qty);
  const initialQty = toFiniteOrNull(trade.initialQty ?? trade.qty);
  const ltp = toFiniteOrNull(runtime.ltp ?? runtime.lastPrice);
  const displayUpdatedAt = formatIso(
    runtime.displayUpdatedAt ??
      runtime.refreshAt ??
      runtime.ltpTs ??
      trade.updatedAt,
  );
  const closeReason = normalizeText(trade.closeReason);
  const exitLifecycle = resolveExitLifecycle(
    trade?.exitReasonCode ?? trade?.exitReason ?? closeReason,
    {
      exitFamily: normalizeUpper(trade?.exitFamily),
      exitAuthority: normalizeUpper(trade?.exitAuthority),
    },
  );
  const terminal =
    TERMINAL_STATUSES.has(status) ||
    Boolean(trade.closedAt) ||
    Boolean(trade.exitAt);
  const terminalOutcome = terminal
    ? classifyTerminalOutcome(status, exitLifecycle, closeReason)
    : null;

  const snapshot = {
    tradeId: normalizeText(trade.tradeId),
    version: Number(trade.version ?? 0) || 0,
    status,
    symbol:
      normalizeText(instrument.tradingsymbol) ||
      normalizeText(trade.tradingsymbol) ||
      normalizeText(trade.symbol),
    side: normalizeUpper(trade.side),
    qty,
    initialQty,
    exitedQty: computeExitedQty(trade),
    strategyId: normalizeText(trade.strategyId),
    entryOrderId: normalizeText(trade.entryOrderId),
    entryPrice: toFiniteOrNull(trade.entryPrice ?? trade.actualEntry),
    expectedEntryPrice: toFiniteOrNull(trade.expectedEntryPrice),
    ltp,
    stopLoss: toFiniteOrNull(
      trade.stopLoss ?? trade.brokerStopLoss ?? trade.slTrigger,
    ),
    targetPrice: toFiniteOrNull(trade.targetPrice),
    targetOrderId: normalizeText(trade.targetOrderId),
    targetVirtual: Boolean(trade.targetVirtual),
    targetStateLabel: null,
    tp1OrderId: normalizeText(trade.tp1OrderId),
    tp1Done: Boolean(trade.tp1Done),
    tp1Price: toFiniteOrNull(trade.tp1Price),
    slOrderId: normalizeText(trade.slOrderId),
    slState: normalizeUpper(trade.slState),
    targetOrderStatus: normalizeUpper(trade.targetOrderStatus),
    slOrderStatus: normalizeUpper(trade.slOrderStatus),
    protectionStage: buildProtectionStage(trade),
    alcStateLabel: buildAlcStateLabel(trade),
    beStateLabel: buildBeStateLabel(trade),
    trailStateLabel: buildTrailStateLabel(trade),
    beLocked: Boolean(trade.beLocked),
    beAppliedAt: formatIso(trade.beAppliedAt),
    beAppliedStopLoss: toFiniteOrNull(trade.beAppliedStopLoss),
    greenLockActive: Boolean(trade.greenLockActive),
    trailActive: Boolean(trade.trailActive),
    protectedStopSource: normalizeUpper(trade.protectedStopSource),
    protectionUpgradePending: Boolean(trade.protectionUpgradePending),
    loserCompressionSubmittedState: normalizeUpper(
      trade.loserCompressionSubmittedState,
    ),
    loserCompressionAppliedState: normalizeUpper(
      trade.loserCompressionAppliedState,
    ),
    panicExitState: normalizeUpper(trade.panicExitState),
    panicExitPending: Boolean(trade.panicExitPending),
    exitPrice: toFiniteOrNull(trade.exitPrice),
    exitFamily: normalizeUpper(exitLifecycle.exitFamily),
    exitReasonCode: normalizeUpper(exitLifecycle.exitReasonCode),
    exitReason:
      normalizeText(trade.exitReason) ||
      normalizeText(trade.exitReasonCode) ||
      closeReason,
    exitAuthority: normalizeUpper(exitLifecycle.exitAuthority),
    closeReason,
    pnlOpenInr: computeOpenPnlInr(trade, ltp),
    pnlGrossInr: toFiniteOrNull(trade.pnlGrossInr),
    pnlNetAfterEstCostsInr: toFiniteOrNull(trade.pnlNetAfterEstCostsInr),
    updatedAt: formatIso(trade.updatedAt),
    createdAt: formatIso(trade.createdAt),
    displayUpdatedAt,
    terminal,
    terminalEvent: terminalOutcome?.terminalEvent || null,
    closeFamily: terminalOutcome?.closeFamily || null,
    terminalSeverity: terminalOutcome?.terminalSeverity || null,
  };

  snapshot.targetStateLabel = buildTargetStateLabel(snapshot);
  snapshot.materialState = buildTradeMaterialState(snapshot);
  snapshot.displayState = buildTradeDisplayState(snapshot);
  snapshot.stateHash = hashTradeMaterialState(snapshot.materialState);
  snapshot.displayHash = hashTradeDisplayState(snapshot.displayState);
  snapshot.liveMetrics = buildTradeLiveMetrics(snapshot);
  return snapshot;
}

function buildTradeMaterialState(snapshot) {
  if (!snapshot) return null;
  return {
    tradeId: snapshot.tradeId,
    status: snapshot.status,
    qty: snapshot.qty,
    initialQty: snapshot.initialQty,
    exitedQty: snapshot.exitedQty,
    entryOrderId: snapshot.entryOrderId,
    entryPrice: snapshot.entryPrice,
    stopLoss: snapshot.stopLoss,
    targetPrice: snapshot.targetPrice,
    targetOrderId: snapshot.targetOrderId,
    targetVirtual: snapshot.targetVirtual,
    slOrderId: snapshot.slOrderId,
    slState: snapshot.slState,
    targetOrderStatus: snapshot.targetOrderStatus,
    slOrderStatus: snapshot.slOrderStatus,
    protectionStage: snapshot.protectionStage,
    alcStateLabel: snapshot.alcStateLabel,
    beStateLabel: snapshot.beStateLabel,
    trailStateLabel: snapshot.trailStateLabel,
    beLocked: snapshot.beLocked,
    beAppliedAt: snapshot.beAppliedAt,
    beAppliedStopLoss: snapshot.beAppliedStopLoss,
    greenLockActive: snapshot.greenLockActive,
    trailActive: snapshot.trailActive,
    protectedStopSource: snapshot.protectedStopSource,
    protectionUpgradePending: snapshot.protectionUpgradePending,
    loserCompressionSubmittedState: snapshot.loserCompressionSubmittedState,
    loserCompressionAppliedState: snapshot.loserCompressionAppliedState,
    panicExitState: snapshot.panicExitState,
    panicExitPending: snapshot.panicExitPending,
    exitPrice: snapshot.exitPrice,
    exitFamily: snapshot.exitFamily,
    exitReasonCode: snapshot.exitReasonCode,
    exitReason: snapshot.exitReason,
    exitAuthority: snapshot.exitAuthority,
    closeReason: snapshot.closeReason,
    closeFamily: snapshot.closeFamily,
    terminalEvent: snapshot.terminalEvent,
    pnlGrossInr: snapshot.pnlGrossInr,
    pnlNetAfterEstCostsInr: snapshot.pnlNetAfterEstCostsInr,
    terminal: snapshot.terminal,
  };
}

function buildTradeDisplayState(snapshot) {
  if (!snapshot) return null;
  return {
    tradeId: snapshot.tradeId,
    header: {
      symbol: snapshot.symbol,
      side: snapshot.side,
      qty: snapshot.qty,
      status: snapshot.status,
    },
    entryPrice: snapshot.entryPrice,
    expectedEntryPrice: snapshot.expectedEntryPrice,
    ltp: snapshot.ltp,
    stopLoss: snapshot.stopLoss,
    targetPrice: snapshot.targetPrice,
    targetStateLabel: snapshot.targetStateLabel,
    protectionStage: snapshot.protectionStage,
    alcStateLabel: snapshot.alcStateLabel,
    beStateLabel: snapshot.beStateLabel,
    trailStateLabel: snapshot.trailStateLabel,
    exitedQty: snapshot.exitedQty,
    panicExitPending: snapshot.panicExitPending,
    exitPrice: snapshot.exitPrice,
    closeFamily: snapshot.closeFamily,
    exitFamily: snapshot.exitFamily,
    exitReasonCode: snapshot.exitReasonCode,
    exitReason: snapshot.exitReason,
    exitAuthority: snapshot.exitAuthority,
    terminalEvent: snapshot.terminalEvent,
    pnlOpenInr: snapshot.pnlOpenInr,
    pnlGrossInr: snapshot.pnlGrossInr,
    pnlNetAfterEstCostsInr: snapshot.pnlNetAfterEstCostsInr,
    displayUpdatedAt: snapshot.displayUpdatedAt,
    terminal: snapshot.terminal,
  };
}

function buildTradeLiveMetrics(snapshot) {
  if (!snapshot) return null;
  return {
    ltp: snapshot.ltp,
    pnlOpenInr: snapshot.pnlOpenInr,
    stopLoss: snapshot.stopLoss,
    targetPrice: snapshot.targetPrice,
    protectionStage: snapshot.protectionStage,
    displayUpdatedAt: snapshot.displayUpdatedAt,
  };
}

function hashTradeMaterialState(materialState) {
  return hashObject(materialState);
}

function hashTradeDisplayState(displayState) {
  return hashObject(displayState);
}

module.exports = {
  TERMINAL_STATUSES,
  buildTradeStatusSnapshot,
  buildTradeMaterialState,
  buildTradeDisplayState,
  buildTradeLiveMetrics,
  buildProtectionStage,
  hashTradeMaterialState,
  hashTradeDisplayState,
};
