const { logger } = require("../logger");
const { reportWindowedFault } = require("./errorBus");
const { isTransientMongoError } = require("./isTransientMongoError");
const {
  acquireMongoWorkPermit,
  getMongoRuntimeState,
  markMongoDegraded,
  noteMongoSubsystemBacklog,
  noteMongoSubsystemDeferred,
  noteMongoWorkSuccess: noteRuntimeMongoWorkSuccess,
} = require("./mongoRuntimeState");

function deferredMessage(subsystem = "mongo", phase = "work") {
  return `[${subsystem}] ${phase} deferred due to mongo degradation`;
}

function blockedCriticalMessage(subsystem = "mongo", phase = "work") {
  return `[${subsystem}] critical ${phase} blocked by mongo coordinator`;
}

function evaluateMongoWorkGate({
  subsystem,
  priority = "non_critical",
  backlog = null,
  backlogEstimate = null,
  dropped = null,
  compacted = null,
  oldestQueuedAt = null,
  phase = "work",
  windowKey = null,
  code = null,
  message = null,
  allowDuringSevere = null,
  allowDuringSevereReason = null,
} = {}) {
  if (!subsystem) {
    return { ok: true, deferred: false, reason: "subsystem_missing" };
  }

  noteMongoSubsystemBacklog({
    subsystem,
    priority,
    backlog,
    backlogEstimate,
    dropped,
    compacted,
    oldestQueuedAt,
  });

  const permit = acquireMongoWorkPermit({
    subsystem,
    priority,
    backlog,
    backlogEstimate,
    phase,
    allowDuringSevere,
    allowDuringSevereReason,
  });
  if (permit?.ok) {
    return {
      ok: true,
      deferred: false,
      release: permit.release,
      permitId: permit.permitId,
      severity: permit.severity,
      status: permit.status,
      reason: permit.reason,
    };
  }

  const deferState = noteMongoSubsystemDeferred({
    subsystem,
    priority,
    reason: permit?.reason || "mongo_degraded",
    backlog,
    backlogEstimate,
    dropped,
    compacted,
    oldestQueuedAt,
    backoffMs: permit?.rawBackoffMs ?? permit?.backoffMs ?? null,
  });
  const backoffMs = Number(
    deferState?.backoffMs || permit?.backoffMs || permit?.rawBackoffMs || 0,
  );

  reportWindowedFault({
    windowKey: windowKey || `mongo_gate_${subsystem}_${permit?.reason || "deferred"}`,
    windowMs: 30_000,
    code:
      code ||
      (permit?.criticalWarning
        ? "MONGO_CRITICAL_WORK_BLOCKED"
        : "MONGO_WORK_DEFERRED"),
    message:
      message ||
      (permit?.criticalWarning
        ? blockedCriticalMessage(subsystem, phase)
        : deferredMessage(subsystem, phase)),
    meta: {
      subsystem,
      priority,
      phase,
      backoffMs,
      severity: permit?.severity || null,
      status: permit?.status || null,
      reason: permit?.reason || null,
      backlog: backlog == null ? null : Number(backlog) || 0,
      backlogEstimate:
        backlogEstimate == null ? null : Number(backlogEstimate) || 0,
    },
  });

  return {
    ok: false,
    deferred: true,
    backoffMs,
    severity: permit?.severity || null,
    status: permit?.status || null,
    reason: permit?.reason || "mongo_degraded",
    criticalWarning: permit?.criticalWarning === true,
  };
}

function deferMongoWorkForError({
  subsystem,
  error,
  priority = "non_critical",
  reason = "mongo_error",
  backlog = null,
  backlogEstimate = null,
  dropped = null,
  compacted = null,
  oldestQueuedAt = null,
  phase = "work",
  windowKey = null,
  code = null,
  message = null,
  release = null,
} = {}) {
  if (!isTransientMongoError(error)) {
    if (typeof release === "function") release();
    return null;
  }

  if (typeof release === "function") release();

  const degraded = markMongoDegraded({
    error,
    reason,
  });
  const deferred = noteMongoSubsystemDeferred({
    subsystem,
    priority,
    reason,
    backlog,
    backlogEstimate,
    dropped,
    compacted,
    oldestQueuedAt,
  });
  const backoffMs = Number(deferred?.backoffMs || 0);

  reportWindowedFault({
    windowKey: windowKey || `mongo_${subsystem}_deferred`,
    windowMs: 30_000,
    code: code || "MONGO_WORK_DEFERRED",
    err: error,
    message: message || deferredMessage(subsystem, phase),
    meta: {
      subsystem,
      priority,
      phase,
      backoffMs,
      severity: degraded?.severity || null,
      status: degraded?.status || null,
      failureStreak: Number(degraded?.failureStreak || 0),
      burstCount: Number(degraded?.burstCount || 0),
      backlog: backlog == null ? null : Number(backlog) || 0,
      backlogEstimate:
        backlogEstimate == null ? null : Number(backlogEstimate) || 0,
    },
  });

  return {
    ok: false,
    deferred: true,
    backoffMs,
    severity: degraded?.severity || null,
    status: degraded?.status || null,
    reason: "mongo_degraded",
  };
}

function noteMongoWorkSuccess({
  subsystem,
  priority = "non_critical",
  backlog = null,
  backlogEstimate = null,
  release = null,
} = {}) {
  return noteRuntimeMongoWorkSuccess({
    subsystem,
    priority,
    backlog,
    backlogEstimate,
    release,
  });
}

function logRecoveryIfAny({
  subsystem,
  priority = "non_critical",
  phase = "work",
  level = "info",
  release = null,
  backlog = null,
  backlogEstimate = null,
  meta = {},
} = {}) {
  const healthy = noteMongoWorkSuccess({
    subsystem,
    priority,
    backlog,
    backlogEstimate,
    release,
  });
  if (!healthy?.enteredRecovering && !healthy?.recovered) return healthy;

  const payload = {
    subsystem,
    phase,
    mongoState: healthy?.state || getMongoRuntimeState()?.state || null,
    ...(meta || {}),
  };
  if (level === "warn") {
    logger.warn(payload, `[${subsystem}] mongo recovered; ${phase} resumed`);
  } else {
    logger.info(payload, `[${subsystem}] mongo recovered; ${phase} resumed`);
  }
  return healthy;
}

module.exports = {
  evaluateMongoWorkGate,
  deferMongoWorkForError,
  noteMongoWorkSuccess,
  logRecoveryIfAny,
};
