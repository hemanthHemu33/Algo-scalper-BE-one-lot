const { env } = require("../config");
const { logger } = require("../logger");
const { alert } = require("../alerts/alertService");
const { reportFault } = require("./errorBus");

function classifyLifecycleEvent(event) {
  const key = String(event || "").trim().toUpperCase();
  if (
    [
      "LIVE_START_FAILED",
      "FLAT_CHECK_ERROR_HOLDING",
      "COOLDOWN_STOP_FAILED",
    ].includes(key)
  ) {
    return { level: "warn", message: `[lifecycle] ${key}` };
  }

  return { level: "info", message: `[lifecycle] ${key}` };
}

async function notifyLifecycle(event, payload = {}) {
  if (String(env.ENGINE_LIFECYCLE_NOTIFY_ENABLED || "true") !== "true") {
    return { ok: true, skipped: true };
  }

  const meta = classifyLifecycleEvent(event);
  logger[meta.level]?.({ event, payload }, meta.message);

  try {
    await alert(meta.level, meta.message, { event, ...payload });
    return { ok: true, skipped: false };
  } catch (err) {
    reportFault({
      code: "RUNTIME_LIFECYCLE_NOTIFY_ASYNC",
      err,
      message: "[src/runtime/lifecycleNotify.js] async task failed",
    });
    return { ok: false, skipped: false, error: err?.message || String(err) };
  }
}

module.exports = { notifyLifecycle };
