const { env } = require("../config");
const { logger } = require("../logger");
const {
  buildLegacyIncidentEnvelope,
  shouldSuppressLegacyTradeAlert,
} = require("./notificationPolicy");
const {
  startNotificationDispatcher,
  stopNotificationDispatcher,
  setHeartbeatProvider,
  getNotificationDispatcherStatus,
  dispatchNotification: dispatchNotificationInternal,
  dispatchTradeUpdate: dispatchTradeUpdateInternal,
} = require("./notificationDispatcher");

const LEVELS = { info: 10, warn: 20, error: 30 };

function minLevel() {
  const level = String(env.TELEGRAM_MIN_LEVEL || "info").toLowerCase();
  return LEVELS[level] ?? LEVELS.info;
}

function notificationsEnabled() {
  const overrideRaw = env.TELEGRAM_NOTIFICATIONS_ENABLED;
  const override =
    overrideRaw == null ? null : String(overrideRaw).trim();
  const enabledFlag =
    override && override.length > 0
      ? override
      : env.TELEGRAM_ENABLED ?? "false";
  return String(enabledFlag).trim().toLowerCase() === "true";
}

async function startAlertService() {
  if (!notificationsEnabled()) return { ok: true, skipped: true };
  return startNotificationDispatcher();
}

function stopAlertService() {
  stopNotificationDispatcher();
}

function setNotificationHeartbeatProvider(provider) {
  setHeartbeatProvider(provider);
}

function isDbNotReadyError(error) {
  return String(error?.message || "").includes("Mongo not connected yet");
}

async function dispatchNotification(envelope) {
  if (!notificationsEnabled()) {
    return { ok: true, skipped: true, reason: "telegram_disabled" };
  }
  try {
    await startAlertService();
    return await dispatchNotificationInternal(envelope);
  } catch (error) {
    if (isDbNotReadyError(error)) {
      return { ok: false, skipped: true, reason: "db_not_ready" };
    }
    throw error;
  }
}

async function dispatchTradeUpdate(args) {
  if (!notificationsEnabled()) {
    return { ok: true, skipped: true, reason: "telegram_disabled" };
  }
  try {
    await startAlertService();
    return await dispatchTradeUpdateInternal(args);
  } catch (error) {
    if (isDbNotReadyError(error)) {
      return { ok: false, skipped: true, reason: "db_not_ready" };
    }
    throw error;
  }
}

async function alert(level, message, meta = null) {
  const normalizedLevel = String(level || "info").toLowerCase();
  const score = LEVELS[normalizedLevel] ?? LEVELS.info;
  if (score < minLevel()) {
    return { ok: true, skipped: true, reason: "below_min_level" };
  }

  logger.info({ level: normalizedLevel }, `[alert] ${message}`);

  if (!notificationsEnabled()) {
    return { ok: true, skipped: true, reason: "telegram_disabled" };
  }

  if (shouldSuppressLegacyTradeAlert(message, meta || {})) {
    return {
      ok: true,
      skipped: true,
      reason: "trade_notification_handled_centrally",
    };
  }

  return dispatchNotification(
    buildLegacyIncidentEnvelope(normalizedLevel, message, meta || {}),
  );
}

module.exports = {
  alert,
  startAlertService,
  stopAlertService,
  setNotificationHeartbeatProvider,
  dispatchNotification,
  dispatchTradeUpdate,
  getNotificationDispatcherStatus,
};
