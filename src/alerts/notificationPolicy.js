const crypto = require("crypto");
const { env } = require("../config");
const { buildTradeStatusSnapshot } = require("./tradeStatusBuilder");

const TRADE_NOISE_PATTERNS = [
  /entry placing/i,
  /entry filled/i,
  /entry partial fill/i,
  /target placing/i,
  /tp1 placing/i,
  /runner target placing/i,
  /sl placing/i,
  /sl placed/i,
  /target hit/i,
  /sl hit/i,
  /trade closed/i,
  /^be armed$/i,
  /sl moved to be/i,
  /sl moved to profit lock/i,
  /sl moved to winner retention/i,
  /^sl updated$/i,
  /^sl trailed$/i,
  /adaptive loser compression/i,
  /target adjusted/i,
  /opt_target_mode=virtual/i,
];

const TRACKED_TRADE_MILESTONES = new Set([
  "ENTRY_SUBMITTED",
  "ENTRY_PARTIAL_FILL",
  "ENTRY_FILLED",
  "PROTECTION_LIVE",
  "SL_LIVE",
  "TARGET_LIVE",
  "BE_ACTIVE",
  "PARTIAL_EXIT_FILLED",
  "EXITED_TARGET",
  "EXITED_SL",
  "EXIT_FILLED_GENERIC",
  "PANIC_EXIT_FILLED",
  "TIME_STOP_EXIT",
  "FORCE_FLATTEN_EXIT",
  "RESTART_FLATTEN_EXIT",
  "PROTECTION_FAILURE_EXIT",
  "GUARD_FAIL_EXIT",
  "MANUAL_EXIT",
  "ENTRY_FAILED",
  "ENTRY_CANCELLED",
]);

function hashObject(value) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(value || {}))
    .digest("hex");
}

function normalizeUpper(value) {
  const raw = String(value || "").trim();
  return raw ? raw.toUpperCase() : null;
}

function normalizeLower(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw || null;
}

function toFiniteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function debugNotificationsEnabled() {
  return String(env.TELEGRAM_NOTIFICATION_DEBUG || "false") === "true";
}

function tradeCardsEnabled() {
  return String(env.TELEGRAM_TRADE_CARD_ENABLED || "true") !== "false";
}

function incidentsEnabled() {
  return String(env.TELEGRAM_INCIDENTS_ENABLED || "true") !== "false";
}

function normalizeNotificationOrigin(meta = {}) {
  const origin = normalizeLower(meta?.notificationOrigin);
  if (
    ["trade_lifecycle", "trade_incident", "risk", "broker", "engine"].includes(
      origin,
    )
  ) {
    return origin;
  }
  return null;
}

function normalizeNotificationIntent(meta = {}) {
  const intent = normalizeLower(meta?.notificationIntent);
  if (
    ["suppress_if_trade_card", "incident_only", "always_send"].includes(intent)
  ) {
    return intent;
  }
  return null;
}

function shouldSuppressLegacyTradeAlert(message, meta = {}) {
  if (debugNotificationsEnabled()) return false;
  if (!meta || typeof meta !== "object") return false;

  const intent = normalizeNotificationIntent(meta);
  const origin = normalizeNotificationOrigin(meta);
  const hasTradeContext = Boolean(meta.tradeId);

  if (intent === "always_send") return false;
  if (intent === "incident_only") return false;
  if (intent === "suppress_if_trade_card" && hasTradeContext) return true;
  if (origin === "trade_lifecycle" && hasTradeContext) return true;
  if (origin === "trade_incident") return false;
  if (!hasTradeContext) return false;

  const text = String(message || "");
  return TRADE_NOISE_PATTERNS.some((pattern) => pattern.test(text));
}

function inferLegacyEntityType(message, meta = {}) {
  const origin = normalizeNotificationOrigin(meta);
  if (origin === "trade_lifecycle" || origin === "trade_incident") {
    return "trade";
  }
  if (origin === "risk") return "risk";
  if (origin === "broker") return "broker";
  if (origin === "engine") return "engine";

  const text = String(message || "").toUpperCase();
  if (meta?.tradeId) return "trade";
  if (text.includes("KILL") || text.includes("DAILY")) return "risk";
  if (text.includes("KITE") || text.includes("BROKER") || text.includes("TICKER")) {
    return "broker";
  }
  return "engine";
}

function buildLegacyIncidentDedupeKey(message, meta = {}, event = null) {
  const cleanEvent =
    normalizeUpper(meta?.notificationCategory) ||
    normalizeUpper(event) ||
    normalizeUpper(meta?.event) ||
    String(message || "")
      .toUpperCase()
      .replace(/<[^>]+>/g, " ")
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) ||
    "ALERT";

  const entityType = inferLegacyEntityType(message, meta);
  const entityId =
    meta?.tradeId ||
    meta?.orderId ||
    meta?.order_id ||
    meta?.reason ||
    meta?.status ||
    "global";

  return `${entityType}:${String(entityId)}:${cleanEvent}`;
}

function compareStopImprovement(prev, next) {
  const side = normalizeUpper(next?.side);
  const prevStop = toFiniteOrNull(prev?.stopLoss);
  const nextStop = toFiniteOrNull(next?.stopLoss);
  if (prevStop == null || nextStop == null || !["BUY", "SELL"].includes(side)) {
    return false;
  }
  return side === "BUY" ? nextStop > prevStop : nextStop < prevStop;
}

function hasPartialExitFill(prev, next) {
  const prevExited = toFiniteOrNull(prev?.exitedQty) || 0;
  const nextExited = toFiniteOrNull(next?.exitedQty) || 0;
  return nextExited > prevExited && !next?.terminal;
}

function detectTradeMilestones(previousSnapshot, nextSnapshot) {
  const prev = previousSnapshot || null;
  const next = nextSnapshot || null;
  if (!next) return [];

  const milestones = [];

  if (!prev?.entryOrderId && next.entryOrderId && !next.terminal) {
    milestones.push("ENTRY_SUBMITTED");
  }

  const isPartialEntry =
    next.status === "ENTRY_OPEN" &&
    next.entryPrice != null &&
    next.initialQty != null &&
    next.qty != null &&
    next.qty < next.initialQty;
  if (isPartialEntry && (prev?.qty !== next.qty || prev?.entryPrice !== next.entryPrice)) {
    milestones.push("ENTRY_PARTIAL_FILL");
  }

  if (
    next.status === "ENTRY_FILLED" &&
    (!prev || prev.status !== next.status || prev.entryPrice !== next.entryPrice)
  ) {
    milestones.push("ENTRY_FILLED");
  }

  if (!prev?.slOrderId && next.slOrderId && !next.terminal) {
    milestones.push(
      next.targetOrderId || next.targetVirtual ? "PROTECTION_LIVE" : "SL_LIVE",
    );
  }

  if (
    ((!prev?.targetOrderId && next.targetOrderId) ||
      (!prev?.targetVirtual && next.targetVirtual)) &&
    !next.terminal
  ) {
    milestones.push("TARGET_LIVE");
  }

  if (
    (!prev?.beAppliedAt && next.beAppliedAt) ||
    (prev?.beAppliedStopLoss == null && next.beAppliedStopLoss != null)
  ) {
    milestones.push("BE_ACTIVE");
  }

  if (hasPartialExitFill(prev, next)) {
    milestones.push("PARTIAL_EXIT_FILLED");
  }

  if (next.terminal && next.terminalEvent) {
    milestones.push(next.terminalEvent);
  }

  return Array.from(new Set(milestones)).filter((event) =>
    TRACKED_TRADE_MILESTONES.has(event),
  );
}

function determineTradeEvent(previousSnapshot, nextSnapshot) {
  const prev = previousSnapshot || null;
  const next = nextSnapshot || null;
  if (!next) return null;

  if (next.terminal && next.terminalEvent) {
    return next.terminalEvent;
  }

  if (!prev?.entryOrderId && next.entryOrderId && !next.terminal) {
    return "ENTRY_SUBMITTED";
  }

  const isPartialEntry =
    next.status === "ENTRY_OPEN" &&
    next.entryPrice != null &&
    next.initialQty != null &&
    next.qty != null &&
    next.qty < next.initialQty;
  if (isPartialEntry && (prev?.qty !== next.qty || prev?.entryPrice !== next.entryPrice)) {
    return "ENTRY_PARTIAL_FILL";
  }

  if (
    next.status === "ENTRY_FILLED" &&
    (!prev || prev.status !== next.status || prev.entryPrice !== next.entryPrice)
  ) {
    return "ENTRY_FILLED";
  }

  if (!prev?.slOrderId && next.slOrderId && !next.terminal) {
    return next.targetOrderId || next.targetVirtual
      ? "PROTECTION_LIVE"
      : "SL_LIVE";
  }

  if (
    ((!prev?.targetOrderId && next.targetOrderId) ||
      (!prev?.targetVirtual && next.targetVirtual)) &&
    !next.terminal
  ) {
    return "TARGET_LIVE";
  }

  if (!prev?.beLocked && next.beLocked) {
    return next.beAppliedAt ? "BE_ACTIVE" : "BE_ARMED";
  }

  if (!prev?.beAppliedAt && next.beAppliedAt) {
    return "BE_ACTIVE";
  }

  if (compareStopImprovement(prev, next)) {
    return next.trailActive || next.protectedStopSource === "TRAIL"
      ? "TRAIL_ACTIVE"
      : "STOP_IMPROVED";
  }

  if (hasPartialExitFill(prev, next)) {
    return "PARTIAL_EXIT_FILLED";
  }

  if (next.panicExitPending && !prev?.panicExitPending) {
    return "PANIC_EXIT_PENDING";
  }

  return "STATE_SYNC";
}

function shouldCreateTradeCard(previousSnapshot, nextSnapshot) {
  if (!tradeCardsEnabled()) return false;
  if (!nextSnapshot?.tradeId) return false;
  if (nextSnapshot.terminal) {
    const rejectedBeforeAck =
      ["ENTRY_FAILED", "ENTRY_CANCELLED"].includes(nextSnapshot.status) &&
      !nextSnapshot.entryOrderId &&
      nextSnapshot.entryPrice == null;
    if (rejectedBeforeAck) return false;
    return true;
  }
  return Boolean(
    nextSnapshot.entryOrderId ||
      nextSnapshot.entryPrice != null ||
      nextSnapshot.slOrderId ||
      nextSnapshot.targetOrderId ||
      nextSnapshot.targetVirtual ||
      nextSnapshot.panicExitPending,
  );
}

function resolveTradeSeverity(snapshot, event) {
  if (!snapshot) return "info";
  if (snapshot.terminal && snapshot.terminalSeverity) {
    return snapshot.terminalSeverity;
  }
  if (
    ["ENTRY_FAILED", "GUARD_FAILED"].includes(snapshot.status) ||
    String(event || "").startsWith("PANIC_EXIT")
  ) {
    return "error";
  }
  if (
    ["ENTRY_CANCELLED", "EXITED_SL"].includes(snapshot.status) ||
    ["STOP_IMPROVED", "PARTIAL_EXIT_FILLED", "BE_ACTIVE", "TRAIL_ACTIVE"].includes(
      event,
    )
  ) {
    return snapshot.status === "EXITED_SL" ? "warn" : "info";
  }
  return "info";
}

function summarizeRuntime(runtime = {}) {
  return {
    ltp: toFiniteOrNull(runtime.ltp ?? runtime.lastPrice),
    ltpTs: runtime.ltpTs || null,
    displayUpdatedAt: runtime.displayUpdatedAt || runtime.refreshAt || null,
    dailyRiskState: runtime.dailyRiskState || null,
    killSwitch:
      typeof runtime.killSwitch === "boolean" ? runtime.killSwitch : null,
    activeTradeId: runtime.activeTradeId || null,
  };
}

function buildTradeNotificationPlan({
  previousTrade = null,
  trade = null,
  runtime = {},
  source = "trade_store",
  allowDisplayOnly = false,
  forceDisplayRefresh = false,
}) {
  const nextSnapshot = buildTradeStatusSnapshot({ trade, runtime });
  if (!nextSnapshot) return [];

  const previousSnapshot = buildTradeStatusSnapshot({
    trade: previousTrade,
    runtime,
  });
  if (!shouldCreateTradeCard(previousSnapshot, nextSnapshot)) return [];

  const sameState =
    previousSnapshot &&
    String(previousSnapshot.stateHash || "") === String(nextSnapshot.stateHash || "");
  if (sameState && !nextSnapshot.terminal && !allowDisplayOnly && !forceDisplayRefresh) {
    return [];
  }

  const event =
    sameState && (allowDisplayOnly || forceDisplayRefresh)
      ? "DISPLAY_REFRESH"
      : determineTradeEvent(previousSnapshot, nextSnapshot);
  const kind = nextSnapshot.terminal ? "trade_terminal" : "trade_status";
  const milestones = detectTradeMilestones(previousSnapshot, nextSnapshot);
  const dedupeKey = nextSnapshot.terminal
    ? `trade:${nextSnapshot.tradeId}:terminal:${nextSnapshot.terminalEvent || nextSnapshot.status}:${nextSnapshot.exitReasonCode || "NA"}:${nextSnapshot.exitPrice ?? "NA"}`
    : `trade:${nextSnapshot.tradeId}:card`;

  return [
    {
      kind,
      severity: resolveTradeSeverity(nextSnapshot, event),
      entityType: "trade",
      entityId: nextSnapshot.tradeId,
      tradeId: nextSnapshot.tradeId,
      dedupeKey,
      stateHash: nextSnapshot.stateHash,
      displayHash: nextSnapshot.displayHash,
      status: nextSnapshot.status,
      event,
      source,
      displayOnly: Boolean(sameState && !nextSnapshot.terminal),
      forceDisplayRefresh: Boolean(forceDisplayRefresh),
      milestones,
      payload: {
        current: nextSnapshot,
        previous:
          previousSnapshot == null
            ? null
            : {
                status: previousSnapshot.status,
                qty: previousSnapshot.qty,
                stopLoss: previousSnapshot.stopLoss,
                targetPrice: previousSnapshot.targetPrice,
                protectionStage: previousSnapshot.protectionStage,
                exitReasonCode: previousSnapshot.exitReasonCode,
                exitAuthority: previousSnapshot.exitAuthority,
              },
        runtime: summarizeRuntime(runtime),
      },
      createdAt: new Date().toISOString(),
    },
  ];
}

function buildLegacyIncidentEnvelope(level, message, meta = {}) {
  const event =
    normalizeUpper(meta?.notificationCategory) ||
    normalizeUpper(meta?.event) ||
    String(message || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase()
      .slice(0, 120) ||
    "ALERT";
  const payload = {
    message: String(message || ""),
    meta: meta || null,
  };
  return {
    kind: "incident",
    severity: String(level || "info").toLowerCase(),
    entityType: inferLegacyEntityType(message, meta),
    entityId:
      meta?.tradeId ||
      meta?.orderId ||
      meta?.order_id ||
      meta?.reason ||
      meta?.status ||
      "global",
    tradeId: meta?.tradeId || null,
    dedupeKey: buildLegacyIncidentDedupeKey(message, meta, event),
    stateHash: hashObject(payload),
    status: meta?.status || null,
    event,
    source: normalizeNotificationOrigin(meta) || "legacy_alert",
    payload,
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  TRACKED_TRADE_MILESTONES,
  incidentsEnabled,
  tradeCardsEnabled,
  shouldSuppressLegacyTradeAlert,
  buildLegacyIncidentDedupeKey,
  buildLegacyIncidentEnvelope,
  buildTradeNotificationPlan,
  determineTradeEvent,
  detectTradeMilestones,
};
