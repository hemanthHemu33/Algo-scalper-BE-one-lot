const { logger } = require("../logger");

const STATE_HEALTHY = "HEALTHY";
const STATE_DEGRADED = "DEGRADED";
const STATE_SEVERELY_DEGRADED = "SEVERELY_DEGRADED";
const STATE_RECOVERING = "RECOVERING";

const SEVERITY_HEALTHY = STATE_HEALTHY;
const SEVERITY_DEGRADED = STATE_DEGRADED;
const SEVERITY_SEVERELY_DEGRADED = STATE_SEVERELY_DEGRADED;

const PRIORITY_CRITICAL = "critical";
const PRIORITY_IMPORTANT = "important";
const PRIORITY_NON_CRITICAL = "non_critical";

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function nowMsFrom(at) {
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (at instanceof Date) {
    const parsed = at.getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function toIsoFromMs(ms) {
  const value = new Date(ms);
  return Number.isNaN(value.getTime())
    ? new Date().toISOString()
    : value.toISOString();
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneSubsystems(source = {}) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    out[key] = cloneJson(value || {});
  }
  return out;
}

function clonePoolMetrics(source = {}) {
  return {
    poolsByAddress: cloneSubsystems(source?.poolsByAddress || {}),
    global: cloneJson(source?.global || {}),
  };
}

function normalizePriority(priority = PRIORITY_NON_CRITICAL) {
  const normalized = String(priority || PRIORITY_NON_CRITICAL)
    .trim()
    .toLowerCase();
  if (normalized === PRIORITY_CRITICAL) return PRIORITY_CRITICAL;
  if (normalized === PRIORITY_IMPORTANT) return PRIORITY_IMPORTANT;
  return PRIORITY_NON_CRITICAL;
}

function severityFromState(nextState = STATE_HEALTHY) {
  if (nextState === STATE_RECOVERING) return SEVERITY_DEGRADED;
  return nextState || SEVERITY_HEALTHY;
}

function cfg() {
  return {
    failureWindowMs: Math.max(
      5_000,
      toNumber(process.env.MONGO_DEGRADE_BURST_WINDOW_MS, 60_000),
    ),
    severeFailureStreak: Math.max(
      3,
      toNumber(process.env.MONGO_SEVERE_FAILURE_STREAK, 3),
    ),
    severeBurstCount: Math.max(
      3,
      toNumber(process.env.MONGO_SEVERE_BURST_COUNT, 3),
    ),
    severeStaleStatusMs: Math.max(
      5_000,
      toNumber(process.env.MONGO_SEVERE_STALE_STATUS_MS, 30_000),
    ),
    recoveryStreakRequired: Math.max(
      1,
      toNumber(process.env.MONGO_RECOVERY_STREAK_REQUIRED, 3),
    ),
    recoveryNoFailureWindowMs: Math.max(
      1_000,
      toNumber(
        process.env.MONGO_RECOVERY_NO_FAILURE_WINDOW_MS,
        process.env.MONGO_RECOVERY_COOLDOWN_MS,
      ) || 30_000,
    ),
    backlogWarnThreshold: Math.max(
      1,
      toNumber(process.env.MONGO_BACKLOG_WARN_THRESHOLD, 500),
    ),
    backlogSevereThreshold: Math.max(
      1,
      toNumber(process.env.MONGO_BACKLOG_SEVERE_THRESHOLD, 2_000),
    ),
    backoffMinMs: Math.max(
      100,
      toNumber(process.env.MONGO_BACKOFF_MIN_MS, 750),
    ),
    backoffMaxMs: Math.max(
      500,
      toNumber(process.env.MONGO_BACKOFF_MAX_MS, 15_000),
    ),
    backoffJitterPct: Math.max(
      0,
      Math.min(1, toNumber(process.env.MONGO_BACKOFF_JITTER_PCT, 0.2)),
    ),
    criticalMinMs: Math.max(
      100,
      toNumber(process.env.MONGO_CRITICAL_BACKOFF_MIN_MS, 750),
    ),
    criticalMaxMs: Math.max(
      500,
      toNumber(process.env.MONGO_CRITICAL_BACKOFF_MAX_MS, 15_000),
    ),
    importantHealthyConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_IMPORTANT_HEALTHY_CONCURRENCY, 2),
    ),
    importantDegradedConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_IMPORTANT_DEGRADED_CONCURRENCY, 1),
    ),
    nonCriticalHealthyConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_NON_CRITICAL_HEALTHY_CONCURRENCY, 2),
    ),
    criticalHealthyConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_CRITICAL_HEALTHY_CONCURRENCY, 4),
    ),
    criticalDegradedConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_CRITICAL_DEGRADED_CONCURRENCY, 2),
    ),
    criticalSevereConcurrency: Math.max(
      1,
      toNumber(process.env.MONGO_CRITICAL_SEVERE_CONCURRENCY, 1),
    ),
  };
}

function hasCheckoutTimeoutSignature(error = null, reason = null) {
  const text = [
    String(error?.name || ""),
    String(error?.code || ""),
    String(error?.message || ""),
    String(reason || ""),
  ]
    .join(" | ")
    .toLowerCase();
  return (
    text.includes("connection checkout") ||
    text.includes("checking out a connection from connection pool") ||
    text.includes("waitqueuetimeout") ||
    (text.includes("wait queue") && text.includes("timeout")) ||
    (text.includes("timeout") && text.includes("connection pool"))
  );
}

function normalizeSubsystem(subsystem = "unknown") {
  return String(subsystem || "unknown").trim().toLowerCase() || "unknown";
}

function subsystemExternalName(key = "unknown") {
  switch (String(key || "").trim().toLowerCase()) {
    case "candle_writer":
      return "candleWriter";
    case "notifications_outbox":
      return "notifications";
    case "signal_telemetry":
      return "signalTelemetry";
    case "trade_telemetry":
      return "tradeTelemetry";
    case "socket_status":
      return "socketStatus";
    case "token_watcher":
      return "tokenWatcher";
    default:
      return key;
  }
}

function defaultPoolSlot(address = "unknown") {
  return {
    address,
    maxPoolSize: null,
    minPoolSize: null,
    maxConnecting: null,
    waitQueueTimeoutMS: null,
    created: 0,
    ready: 0,
    checkedOut: 0,
    checkedIn: 0,
    checkOutStarted: 0,
    pendingCheckouts: 0,
    checkOutFailed: 0,
    checkoutTimeouts: 0,
    poolCleared: 0,
    connectionCreated: 0,
    connectionReady: 0,
    connectionClosed: 0,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
}

function defaultSubsystemSlot(subsystem = "unknown") {
  return {
    subsystem,
    priority: PRIORITY_NON_CRITICAL,
    allowDuringSevere: false,
    allowDuringSevereReason: null,
    deferCount: 0,
    resumeCount: 0,
    consecutiveDefers: 0,
    backoffMs: 0,
    nextAllowedAt: null,
    backlog: 0,
    backlogEstimate: 0,
    oldestQueuedAt: null,
    dropped: 0,
    compacted: 0,
    flushDeferredCount: 0,
    inflightCount: 0,
    lastDeferredAt: null,
    lastDeferredReason: null,
    lastResumedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastAllowedAt: null,
    lastBlockedAt: null,
    lastBlockedReason: null,
    lastWarningAt: null,
    health: {},
  };
}

function defaultState() {
  return {
    connected: false,
    degraded: false,
    state: STATE_HEALTHY,
    severity: SEVERITY_HEALTHY,
    status: STATE_HEALTHY,
    enteredAt: null,
    degradedSince: null,
    recoveringSince: null,
    lastConnectAt: null,
    lastHealthyAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastRecoveryAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    lastErrorCode: null,
    lastDegradedReason: null,
    lastTransitionAt: null,
    lastTransitionReason: null,
    poolClearedCount: 0,
    checkoutFailedCount: 0,
    checkoutTimeoutCount: 0,
    recoveryCount: 0,
    failureStreak: 0,
    recoveryStreak: 0,
    failureWindowStartAt: null,
    burstCount: 0,
    subsystemDeferCount: 0,
    subsystemResumeCount: 0,
    subsystems: {},
    poolMetrics: {
      poolsByAddress: {},
      global: {
        checkedOutTotal: 0,
        checkOutStartedTotal: 0,
        pendingCheckouts: 0,
        checkoutFailureStreak: 0,
        checkoutFailureCount: 0,
        checkoutTimeoutCount: 0,
        lastCheckoutFailureAt: null,
        lastCheckoutSuccessAt: null,
        severity: SEVERITY_HEALTHY,
      },
    },
    inflightByPriority: {
      [PRIORITY_CRITICAL]: 0,
      [PRIORITY_IMPORTANT]: 0,
      [PRIORITY_NON_CRITICAL]: 0,
    },
    activePermits: {},
    permitSeq: 0,
    staleStatusBySubsystem: {},
  };
}

const state = defaultState();

function syncDerivedState() {
  state.degraded = state.state !== STATE_HEALTHY;
  state.severity = severityFromState(state.state);
  state.status = state.state;
  state.enteredAt = state.degradedSince;
  const global = state.poolMetrics.global;
  const severeFailures =
    Number(global.checkoutFailureStreak || 0) >= cfg().severeFailureStreak;
  if (severeFailures) {
    global.severity = SEVERITY_SEVERELY_DEGRADED;
  } else if (
    Number(global.checkedOutTotal || 0) > 0 ||
    Number(global.pendingCheckouts || 0) > 0 ||
    Number(global.checkoutFailureStreak || 0) > 0
  ) {
    global.severity = SEVERITY_DEGRADED;
  } else {
    global.severity = SEVERITY_HEALTHY;
  }
}

function logStateTransition(fromState, toState, reason, atIso) {
  if (!fromState || !toState || fromState === toState) return;
  const payload = {
    from: fromState,
    to: toState,
    reason: reason || null,
    at: atIso || new Date().toISOString(),
  };
  if (toState === STATE_HEALTHY) {
    logger.info(payload, "[db] mongo degradation state changed");
    return;
  }
  logger.warn(payload, "[db] mongo degradation state changed");
}

function transitionState(nextState, { at, reason } = {}) {
  const prev = state.state;
  if (!nextState || prev === nextState) return { changed: false, previous: prev };
  const nowMs = nowMsFrom(at);
  const nowIso = toIsoFromMs(nowMs);

  if (nextState === STATE_HEALTHY) {
    state.state = STATE_HEALTHY;
    state.degradedSince = null;
    state.recoveringSince = null;
    state.lastRecoveryAt = nowIso;
  } else if (nextState === STATE_RECOVERING) {
    state.state = STATE_RECOVERING;
    if (!state.degradedSince) state.degradedSince = nowIso;
    state.recoveringSince = nowIso;
  } else if (nextState === STATE_SEVERELY_DEGRADED) {
    state.state = STATE_SEVERELY_DEGRADED;
    if (!state.degradedSince) state.degradedSince = nowIso;
    state.recoveringSince = null;
  } else {
    state.state = STATE_DEGRADED;
    if (!state.degradedSince) state.degradedSince = nowIso;
    state.recoveringSince = null;
  }

  state.lastTransitionAt = nowIso;
  state.lastTransitionReason = reason || null;
  syncDerivedState();
  logStateTransition(prev, state.state, reason, nowIso);
  return { changed: true, previous: prev, current: state.state };
}

function getFailureEvents(nowMs = Date.now()) {
  const windowMs = cfg().failureWindowMs;
  const cutoff = nowMs - windowMs;
  const raw = String(state.failureWindowStartAt || "").trim();
  const startMs = raw ? Date.parse(raw) : 0;
  if (!Number.isFinite(startMs) || startMs < cutoff) {
    state.failureWindowStartAt = null;
    state.burstCount = 0;
    return { startMs: 0, withinWindow: false };
  }
  return { startMs, withinWindow: true };
}

function recordFailureBurst(nowMs = Date.now()) {
  const nowIso = toIsoFromMs(nowMs);
  const burst = getFailureEvents(nowMs);
  if (!burst.withinWindow) {
    state.failureWindowStartAt = nowIso;
    state.burstCount = 1;
    return;
  }
  state.burstCount += 1;
}

function totalBacklogFromSubsystems() {
  return Object.values(state.subsystems).reduce((acc, item) => {
    return acc + Math.max(0, Number(item?.backlog || 0));
  }, 0);
}

function maxStaleStatusMs() {
  return Object.values(state.staleStatusBySubsystem || {}).reduce((acc, value) => {
    return Math.max(acc, Math.max(0, Number(value || 0)));
  }, 0);
}

function hasSevereBacklog() {
  const config = cfg();
  for (const item of Object.values(state.subsystems || {})) {
    const backlog = Math.max(0, Number(item?.backlog || 0));
    const backlogEstimate = Math.max(0, Number(item?.backlogEstimate || 0));
    const health = item?.health || {};
    const criticalThreshold = Math.max(
      1,
      Number(
        health?.criticalBacklog ??
          health?.maxBacklog ??
          config.backlogSevereThreshold,
      ) || config.backlogSevereThreshold,
    );
    if (backlog >= criticalThreshold || backlogEstimate >= criticalThreshold) {
      return true;
    }
  }
  return totalBacklogFromSubsystems() >= config.backlogSevereThreshold;
}

function hasWarnBacklog() {
  const config = cfg();
  for (const item of Object.values(state.subsystems || {})) {
    const backlog = Math.max(0, Number(item?.backlog || 0));
    const backlogEstimate = Math.max(0, Number(item?.backlogEstimate || 0));
    const health = item?.health || {};
    const warnThreshold = Math.max(
      1,
      Number(health?.warnBacklog ?? config.backlogWarnThreshold) ||
        config.backlogWarnThreshold,
    );
    if (backlog >= warnThreshold || backlogEstimate >= warnThreshold) {
      return true;
    }
  }
  return totalBacklogFromSubsystems() >= cfg().backlogWarnThreshold;
}

function refreshDerivedSeverity({ at, reason } = {}) {
  const nowMs = nowMsFrom(at);
  const severeByFailure =
    Number(state.failureStreak || 0) >= cfg().severeFailureStreak ||
    Number(state.burstCount || 0) >= cfg().severeBurstCount;
  const severeByStale = maxStaleStatusMs() >= cfg().severeStaleStatusMs;
  const severeByBacklog = hasSevereBacklog();

  if (
    (state.state === STATE_DEGRADED || state.state === STATE_RECOVERING) &&
    (severeByFailure || severeByStale || severeByBacklog)
  ) {
    transitionState(STATE_SEVERELY_DEGRADED, {
      at: nowMs,
      reason: reason || "SEVERE_THRESHOLD_REACHED",
    });
  }
}

function ensureSubsystem(subsystem = "unknown") {
  const key = normalizeSubsystem(subsystem);
  if (!state.subsystems[key]) {
    state.subsystems[key] = defaultSubsystemSlot(key);
  }
  return { key, slot: state.subsystems[key] };
}

function ensurePool(address = "unknown") {
  const key = String(address || "unknown").trim() || "unknown";
  if (!state.poolMetrics.poolsByAddress[key]) {
    state.poolMetrics.poolsByAddress[key] = defaultPoolSlot(key);
  }
  return state.poolMetrics.poolsByAddress[key];
}

function poolAddressFromEvent(event = {}) {
  return String(event?.address || event?.connectionId || "unknown").trim() || "unknown";
}

function sanitizeReason(reason = null, error = null) {
  if (reason) return String(reason);
  if (hasCheckoutTimeoutSignature(error, reason)) return "CHECKOUT_TIMEOUT";
  if (String(error?.message || "").trim()) return "DB_OPERATION_FAILED";
  return "DB_DEGRADED";
}

function defaultSubsystemPolicy(subsystem = "unknown", priority = null) {
  const key = normalizeSubsystem(subsystem);
  const config = cfg();
  const requestedPriority = normalizePriority(priority || PRIORITY_NON_CRITICAL);
  const policy = {
    subsystem: key,
    priority: requestedPriority,
    minBackoffMs:
      requestedPriority === PRIORITY_CRITICAL
        ? config.criticalMinMs
        : config.backoffMinMs,
    maxBackoffMs:
      requestedPriority === PRIORITY_CRITICAL
        ? config.criticalMaxMs
        : config.backoffMaxMs,
    jitterPct: config.backoffJitterPct,
    allowDuringSevere: false,
    allowDuringSevereReason: null,
    warnBacklog: config.backlogWarnThreshold,
    criticalBacklog: config.backlogSevereThreshold,
  };

  switch (key) {
    case "reconcile":
      policy.priority = PRIORITY_CRITICAL;
      policy.allowDuringSevere = true;
      policy.allowDuringSevereReason = "reconcile_correctness";
      policy.minBackoffMs = Math.max(
        250,
        toNumber(process.env.MONGO_RECONCILE_DEFER_MS, config.criticalMinMs),
      );
      policy.maxBackoffMs = Math.max(
        policy.minBackoffMs,
        toNumber(
          process.env.MONGO_RECONCILE_MAX_DEFER_MS,
          config.criticalMaxMs,
        ),
      );
      break;
    case "candle_writer":
      policy.priority = PRIORITY_IMPORTANT;
      policy.warnBacklog = Math.max(
        1,
        toNumber(process.env.CANDLE_WRITER_WARN_BACKLOG, 500),
      );
      policy.criticalBacklog = Math.max(
        policy.warnBacklog,
        toNumber(process.env.CANDLE_WRITER_CRITICAL_BACKLOG, 2_000),
      );
      break;
    case "token_watcher":
      policy.priority = requestedPriority;
      policy.minBackoffMs = Math.max(
        policy.minBackoffMs,
        toNumber(process.env.MONGO_CHANGE_STREAM_BACKOFF_MIN_MS, 1_000),
      );
      policy.maxBackoffMs = Math.max(
        policy.minBackoffMs,
        toNumber(process.env.MONGO_CHANGE_STREAM_BACKOFF_MAX_MS, 60_000),
      );
      break;
    case "socket_status":
      policy.priority = PRIORITY_NON_CRITICAL;
      break;
    case "notifications_outbox":
      policy.priority = PRIORITY_NON_CRITICAL;
      break;
    case "signal_telemetry":
    case "trade_telemetry":
      policy.priority = PRIORITY_NON_CRITICAL;
      policy.warnBacklog = Math.max(
        1,
        toNumber(process.env.TELEMETRY_WARN_QUEUE, 2_000),
      );
      policy.criticalBacklog = Math.max(
        policy.warnBacklog,
        toNumber(process.env.TELEMETRY_MAX_QUEUE, 10_000),
      );
      break;
    default:
      break;
  }

  return policy;
}

function applyJitter(ms, jitterPct) {
  const safe = Math.max(0, Number(ms) || 0);
  if (!safe || !jitterPct) return safe;
  const delta = safe * jitterPct;
  const jitter = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(safe + jitter));
}

function recommendMongoBackoff({
  subsystem = "unknown",
  priority = null,
  bump = false,
} = {}) {
  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { slot } = ensureSubsystem(policy.subsystem);
  const base = slot.backoffMs > 0 ? slot.backoffMs : policy.minBackoffMs;
  const rawBackoffMs = bump
    ? Math.min(base * 2, policy.maxBackoffMs)
    : Math.min(Math.max(base, policy.minBackoffMs), policy.maxBackoffMs);
  return {
    subsystem: policy.subsystem,
    priority: policy.priority,
    severity: state.severity,
    status: state.state,
    shouldDefer: state.state !== STATE_HEALTHY,
    backoffMs: applyJitter(rawBackoffMs, policy.jitterPct) || rawBackoffMs,
    rawBackoffMs,
  };
}

function priorityLimitForState(priority, policy, currentState = state.state) {
  const config = cfg();
  switch (currentState) {
    case STATE_HEALTHY:
      if (priority === PRIORITY_CRITICAL) return config.criticalHealthyConcurrency;
      if (priority === PRIORITY_IMPORTANT) {
        return config.importantHealthyConcurrency;
      }
      return config.nonCriticalHealthyConcurrency;
    case STATE_DEGRADED:
      if (priority === PRIORITY_CRITICAL) return config.criticalDegradedConcurrency;
      if (priority === PRIORITY_IMPORTANT) {
        return config.importantDegradedConcurrency;
      }
      return 0;
    case STATE_SEVERELY_DEGRADED:
      if (priority === PRIORITY_CRITICAL && policy.allowDuringSevere) {
        return config.criticalSevereConcurrency;
      }
      return 0;
    case STATE_RECOVERING:
      if (priority === PRIORITY_CRITICAL) return config.criticalDegradedConcurrency;
      if (priority === PRIORITY_IMPORTANT) {
        return config.importantDegradedConcurrency;
      }
      return 0;
    default:
      return 0;
  }
}

function shouldAllowDbWork({
  subsystem,
  priority = PRIORITY_NON_CRITICAL,
  backlog = null,
  backlogEstimate = null,
  phase = "work",
  allowDuringSevere = null,
  allowDuringSevereReason = null,
} = {}) {
  if (!subsystem) {
    return {
      allow: true,
      deferred: false,
      reason: "subsystem_missing",
      severity: state.severity,
      status: state.state,
      priority: normalizePriority(priority),
      phase,
    };
  }

  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { key, slot } = ensureSubsystem(policy.subsystem);
  const effectivePriority = policy.priority;
  const severeAllowed =
    allowDuringSevere == null ? policy.allowDuringSevere : !!allowDuringSevere;
  const severeReason =
    allowDuringSevereReason || policy.allowDuringSevereReason || null;

  slot.priority = effectivePriority;
  slot.allowDuringSevere = severeAllowed;
  slot.allowDuringSevereReason = severeReason;
  if (backlog != null) slot.backlog = Math.max(0, Number(backlog) || 0);
  if (backlogEstimate != null) {
    slot.backlogEstimate = Math.max(0, Number(backlogEstimate) || 0);
  }

  const nowMs = Date.now();
  const nextAllowedMs = slot.nextAllowedAt
    ? new Date(slot.nextAllowedAt).getTime()
    : 0;
  if (Number.isFinite(nextAllowedMs) && nextAllowedMs > nowMs && state.state !== STATE_HEALTHY) {
    const backoffMs = Math.max(0, nextAllowedMs - nowMs);
    return {
      allow: false,
      deferred: true,
      reason: "backoff_active",
      subsystem: key,
      priority: effectivePriority,
      phase,
      severity: state.severity,
      status: state.state,
      backoffMs,
      rawBackoffMs: backoffMs,
      criticalWarning:
        effectivePriority === PRIORITY_CRITICAL && state.state === STATE_SEVERELY_DEGRADED,
      recommendedAction:
        effectivePriority === PRIORITY_CRITICAL && !severeAllowed
          ? "retry_critical_with_backoff"
          : "defer_until_backoff_elapsed",
    };
  }

  const limit = priorityLimitForState(effectivePriority, policy, state.state);
  const currentInFlight = Math.max(
    0,
    Number(state.inflightByPriority[effectivePriority] || 0),
  );
  if (limit <= 0) {
    const reason =
      state.state === STATE_SEVERELY_DEGRADED && effectivePriority === PRIORITY_CRITICAL
        ? "critical_blocked_by_severe_state"
        : `blocked_${String(state.state || STATE_HEALTHY).toLowerCase()}`;
    const recommended = recommendMongoBackoff({
      subsystem: key,
      priority: effectivePriority,
      bump: false,
    });
    return {
      allow: false,
      deferred: true,
      reason,
      subsystem: key,
      priority: effectivePriority,
      phase,
      severity: state.severity,
      status: state.state,
      backoffMs: recommended.backoffMs,
      rawBackoffMs: recommended.rawBackoffMs,
      criticalWarning:
        effectivePriority === PRIORITY_CRITICAL && !severeAllowed,
      recommendedAction:
        effectivePriority === PRIORITY_CRITICAL && !severeAllowed
          ? "allow_only_trade_safety_db_work"
          : "defer_non_critical_db_work",
    };
  }

  if (currentInFlight >= limit) {
    const recommended = recommendMongoBackoff({
      subsystem: key,
      priority: effectivePriority,
      bump: true,
    });
    return {
      allow: false,
      deferred: true,
      reason: "priority_concurrency_limited",
      subsystem: key,
      priority: effectivePriority,
      phase,
      severity: state.severity,
      status: state.state,
      backoffMs: recommended.backoffMs,
      rawBackoffMs: recommended.rawBackoffMs,
      criticalWarning: effectivePriority === PRIORITY_CRITICAL,
      recommendedAction: "wait_for_priority_slot",
    };
  }

  return {
    allow: true,
    deferred: false,
    reason: "allowed",
    subsystem: key,
    priority: effectivePriority,
    phase,
    severity: state.severity,
    status: state.state,
    limit,
    inFlight: currentInFlight,
    recommendedAction:
      state.state === STATE_HEALTHY
        ? "normal_operation"
        : state.state === STATE_RECOVERING
          ? "continue_recovery_and_flush_important_backlogs"
          : "prioritize_critical_db_work",
  };
}

function acquireMongoWorkPermit(options = {}) {
  const decision = shouldAllowDbWork(options);
  if (!decision.allow) return { ...decision, ok: false };

  const policy = defaultSubsystemPolicy(
    decision.subsystem,
    decision.priority,
  );
  const { slot } = ensureSubsystem(decision.subsystem);
  const priority = normalizePriority(decision.priority);

  state.permitSeq += 1;
  const permitId = `${decision.subsystem}:${priority}:${state.permitSeq}`;
  state.inflightByPriority[priority] = Math.max(
    0,
    Number(state.inflightByPriority[priority] || 0),
  ) + 1;
  slot.inflightCount = Math.max(0, Number(slot.inflightCount || 0)) + 1;
  slot.lastAllowedAt = new Date().toISOString();
  state.activePermits[permitId] = {
    subsystem: decision.subsystem,
    priority,
    issuedAt: slot.lastAllowedAt,
  };

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    delete state.activePermits[permitId];
    state.inflightByPriority[priority] = Math.max(
      0,
      Number(state.inflightByPriority[priority] || 0) - 1,
    );
    slot.inflightCount = Math.max(0, Number(slot.inflightCount || 0) - 1);
    if (slot.backoffMs > 0 && state.state === STATE_HEALTHY) {
      slot.backoffMs = 0;
      slot.nextAllowedAt = null;
    }
  };

  return {
    ...decision,
    ok: true,
    deferred: false,
    permitId,
    release,
    policy,
  };
}

function noteMongoSubsystemDeferred({
  subsystem = "unknown",
  priority = PRIORITY_NON_CRITICAL,
  reason = "mongo_degraded",
  backlog = null,
  backlogEstimate = null,
  dropped = null,
  compacted = null,
  flushDeferredCount = null,
  oldestQueuedAt = null,
  backoffMs = null,
} = {}) {
  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { key, slot } = ensureSubsystem(policy.subsystem);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const recommended = recommendMongoBackoff({
    subsystem: key,
    priority: policy.priority,
    bump: true,
  });
  const rawBackoffMs = Math.max(
    0,
    Number(backoffMs ?? recommended.rawBackoffMs ?? recommended.backoffMs ?? 0) || 0,
  );

  slot.priority = policy.priority;
  slot.deferCount += 1;
  slot.consecutiveDefers += 1;
  slot.lastDeferredAt = nowIso;
  slot.lastDeferredReason = String(reason || "mongo_degraded");
  slot.lastBlockedAt = nowIso;
  slot.lastBlockedReason = slot.lastDeferredReason;
  slot.backoffMs = Math.max(policy.minBackoffMs, Math.min(policy.maxBackoffMs, rawBackoffMs));
  slot.nextAllowedAt = new Date(nowMs + slot.backoffMs).toISOString();
  if (backlog != null) slot.backlog = Math.max(0, Number(backlog) || 0);
  if (backlogEstimate != null) {
    slot.backlogEstimate = Math.max(0, Number(backlogEstimate) || 0);
  }
  if (dropped != null) slot.dropped = Math.max(0, Number(dropped) || 0);
  if (compacted != null) {
    slot.compacted = Math.max(0, Number(compacted) || 0);
  }
  if (flushDeferredCount != null) {
    slot.flushDeferredCount = Math.max(
      0,
      Number(flushDeferredCount) || 0,
    );
  } else {
    slot.flushDeferredCount = Math.max(
      0,
      Number(slot.flushDeferredCount || 0),
    ) + 1;
  }
  if (oldestQueuedAt) {
    slot.oldestQueuedAt = String(oldestQueuedAt);
  }
  state.subsystemDeferCount += 1;
  refreshDerivedSeverity({
    reason: "SUBSYSTEM_BACKLOG_OR_STALE_THRESHOLD",
  });

  return {
    subsystem: key,
    backoffMs: applyJitter(slot.backoffMs, policy.jitterPct) || slot.backoffMs,
    rawBackoffMs: slot.backoffMs,
    consecutiveDefers: slot.consecutiveDefers,
    deferCount: slot.deferCount,
    severity: state.severity,
    status: state.state,
  };
}

function noteMongoSubsystemResumed({
  subsystem = "unknown",
  priority = PRIORITY_NON_CRITICAL,
  backlog = null,
  backlogEstimate = null,
} = {}) {
  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { key, slot } = ensureSubsystem(policy.subsystem);
  const nowIso = new Date().toISOString();
  const hadDeferred = Number(slot.consecutiveDefers || 0) > 0;

  if (hadDeferred) {
    slot.resumeCount += 1;
    state.subsystemResumeCount += 1;
  }
  slot.consecutiveDefers = 0;
  slot.lastResumedAt = nowIso;
  slot.lastSuccessAt = nowIso;
  slot.backoffMs = 0;
  slot.nextAllowedAt = null;
  if (backlog != null) slot.backlog = Math.max(0, Number(backlog) || 0);
  if (backlogEstimate != null) {
    slot.backlogEstimate = Math.max(0, Number(backlogEstimate) || 0);
  }

  return {
    subsystem: key,
    resumed: hadDeferred,
    resumeCount: slot.resumeCount,
    backoffMs: slot.backoffMs,
    severity: state.severity,
    status: state.state,
  };
}

function noteMongoSubsystemBacklog({
  subsystem = "unknown",
  priority = PRIORITY_NON_CRITICAL,
  backlog = null,
  backlogEstimate = null,
  dropped = null,
  compacted = null,
  oldestQueuedAt = null,
  health = null,
} = {}) {
  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { key, slot } = ensureSubsystem(policy.subsystem);
  slot.priority = policy.priority;
  if (backlog != null) slot.backlog = Math.max(0, Number(backlog) || 0);
  if (backlogEstimate != null) {
    slot.backlogEstimate = Math.max(0, Number(backlogEstimate) || 0);
  }
  if (dropped != null) slot.dropped = Math.max(0, Number(dropped) || 0);
  if (compacted != null) {
    slot.compacted = Math.max(0, Number(compacted) || 0);
  }
  if (oldestQueuedAt) slot.oldestQueuedAt = String(oldestQueuedAt);
  if (health && typeof health === "object") {
    slot.health = {
      ...(slot.health || {}),
      ...cloneJson(health),
      warnBacklog: Math.max(
        1,
        Number(health?.warnBacklog ?? policy.warnBacklog) || policy.warnBacklog,
      ),
      criticalBacklog: Math.max(
        1,
        Number(health?.criticalBacklog ?? policy.criticalBacklog) ||
          policy.criticalBacklog,
      ),
    };
  }
  refreshDerivedSeverity({
    reason: "SUBSYSTEM_BACKLOG_OR_STALE_THRESHOLD",
  });
  return {
    subsystem: key,
    backlog: slot.backlog,
    backlogEstimate: slot.backlogEstimate,
    dropped: slot.dropped,
    compacted: slot.compacted,
  };
}

function updateMongoSubsystemHealth({
  subsystem = "unknown",
  priority = PRIORITY_NON_CRITICAL,
  health = {},
} = {}) {
  const policy = defaultSubsystemPolicy(subsystem, priority);
  const { key, slot } = ensureSubsystem(policy.subsystem);
  slot.priority = policy.priority;
  slot.health = {
    ...(slot.health || {}),
    ...cloneJson(health || {}),
  };
  if (health?.backlog != null) {
    slot.backlog = Math.max(0, Number(health.backlog) || 0);
  }
  if (health?.backlogEstimate != null && health.backlogEstimate !== "unknown") {
    slot.backlogEstimate = Math.max(0, Number(health.backlogEstimate) || 0);
  }
  if (health?.oldestQueuedAt) {
    slot.oldestQueuedAt = String(health.oldestQueuedAt);
  }
  if (health?.droppedCount != null) {
    slot.dropped = Math.max(0, Number(health.droppedCount) || 0);
  }
  if (health?.compactedCount != null) {
    slot.compacted = Math.max(0, Number(health.compactedCount) || 0);
  }
  refreshDerivedSeverity({
    reason: "SUBSYSTEM_BACKLOG_OR_STALE_THRESHOLD",
  });
  return { subsystem: key, health: cloneJson(slot.health) };
}

function noteMongoStatusStaleness({
  subsystem = "socket_status",
  staleMs = 0,
} = {}) {
  const key = normalizeSubsystem(subsystem);
  const safe = Math.max(0, Number(staleMs) || 0);
  state.staleStatusBySubsystem[key] = safe;
  refreshDerivedSeverity({
    reason: "STALE_STATUS_THRESHOLD",
  });
  return safe;
}

function noteMongoPoolCreated(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  slot.created += 1;
  slot.maxPoolSize =
    Number(event?.options?.maxPoolSize ?? slot.maxPoolSize ?? NaN) || slot.maxPoolSize;
  slot.minPoolSize =
    Number(event?.options?.minPoolSize ?? slot.minPoolSize ?? NaN) || slot.minPoolSize;
  slot.maxConnecting =
    Number(event?.options?.maxConnecting ?? slot.maxConnecting ?? NaN) || slot.maxConnecting;
  slot.waitQueueTimeoutMS =
    Number(event?.options?.waitQueueTimeoutMS ?? slot.waitQueueTimeoutMS ?? NaN) ||
    slot.waitQueueTimeoutMS;
  syncDerivedState();
  return slot;
}

function noteMongoPoolClosed(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  global.checkedOutTotal = Math.max(
    0,
    Number(global.checkedOutTotal || 0) - Number(slot.checkedOut || 0),
  );
  global.pendingCheckouts = Math.max(
    0,
    Number(global.pendingCheckouts || 0) - Number(slot.pendingCheckouts || 0),
  );
  slot.checkedOut = 0;
  slot.pendingCheckouts = 0;
  syncDerivedState();
  return slot;
}

function noteMongoPoolCleared({ at, address, event } = {}) {
  const pool = ensurePool(address || poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  pool.poolCleared += 1;
  pool.lastFailureAt = at ? toIsoFromMs(nowMsFrom(at)) : new Date().toISOString();
  global.checkedOutTotal = Math.max(
    0,
    Number(global.checkedOutTotal || 0) - Number(pool.checkedOut || 0),
  );
  global.pendingCheckouts = Math.max(
    0,
    Number(global.pendingCheckouts || 0) - Number(pool.pendingCheckouts || 0),
  );
  pool.checkedOut = 0;
  pool.pendingCheckouts = 0;
  state.poolClearedCount += 1;
  syncDerivedState();
  return state.poolClearedCount;
}

function noteMongoConnectionCreated(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  slot.connectionCreated += 1;
  return slot;
}

function noteMongoConnectionReady(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  slot.ready += 1;
  slot.connectionReady += 1;
  slot.lastSuccessAt = new Date().toISOString();
  return slot;
}

function noteMongoConnectionClosed(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  slot.connectionClosed += 1;
  slot.lastFailureAt = new Date().toISOString();
  return slot;
}

function totalConfiguredPoolSize() {
  return Object.values(state.poolMetrics.poolsByAddress || {}).reduce((acc, slot) => {
    return acc + Math.max(0, Number(slot?.maxPoolSize || 0));
  }, 0);
}

function noteMongoCheckoutStarted(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  slot.checkOutStarted += 1;
  slot.pendingCheckouts = Math.max(0, Number(slot.pendingCheckouts || 0)) + 1;
  global.checkOutStartedTotal = Math.max(
    0,
    Number(global.checkOutStartedTotal || 0),
  ) + 1;
  global.pendingCheckouts = Math.max(0, Number(global.pendingCheckouts || 0)) + 1;
  syncDerivedState();

  const maxPoolSize = Math.max(0, Number(slot.maxPoolSize || 0));
  const checkedOut = Math.max(0, Number(slot.checkedOut || 0));
  const totalPool = Math.max(0, totalConfiguredPoolSize());
  const pressureHigh =
    (maxPoolSize > 0 && checkedOut >= Math.max(1, Math.floor(maxPoolSize * 0.8))) ||
    (totalPool > 0 &&
      Number(global.checkedOutTotal || 0) >= Math.max(1, Math.floor(totalPool * 0.8))) ||
    Number(global.pendingCheckouts || 0) >= Math.max(2, Number(slot.maxConnecting || 2));

  return {
    pressureHigh,
    checkedOutTotal: Number(global.checkedOutTotal || 0),
    pendingCheckouts: Number(global.pendingCheckouts || 0),
  };
}

function noteMongoCheckoutSuccess(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  const nowIso = new Date().toISOString();
  slot.pendingCheckouts = Math.max(0, Number(slot.pendingCheckouts || 0) - 1);
  slot.checkedOut = Math.max(0, Number(slot.checkedOut || 0)) + 1;
  slot.lastSuccessAt = nowIso;
  global.pendingCheckouts = Math.max(0, Number(global.pendingCheckouts || 0) - 1);
  global.checkedOutTotal = Math.max(0, Number(global.checkedOutTotal || 0)) + 1;
  const recovered = Number(global.checkoutFailureStreak || 0) > 0;
  global.checkoutFailureStreak = 0;
  global.lastCheckoutSuccessAt = nowIso;
  syncDerivedState();
  return {
    recovered,
    checkedOutTotal: Number(global.checkedOutTotal || 0),
    lastCheckoutSuccessAt: nowIso,
  };
}

function noteMongoCheckoutCheckedIn(event = {}) {
  const slot = ensurePool(poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  slot.checkedIn += 1;
  slot.checkedOut = Math.max(0, Number(slot.checkedOut || 0) - 1);
  global.checkedOutTotal = Math.max(0, Number(global.checkedOutTotal || 0) - 1);
  syncDerivedState();
  return {
    checkedOutTotal: Number(global.checkedOutTotal || 0),
  };
}

function noteMongoCheckoutFailed({
  address = null,
  event = null,
  error = null,
  at = null,
  reason = null,
} = {}) {
  const slot = ensurePool(address || poolAddressFromEvent(event));
  const global = state.poolMetrics.global;
  const nowIso = toIsoFromMs(nowMsFrom(at));
  const checkoutTimeout = hasCheckoutTimeoutSignature(error, reason);
  slot.pendingCheckouts = Math.max(0, Number(slot.pendingCheckouts || 0) - 1);
  slot.checkOutFailed += 1;
  if (checkoutTimeout) {
    slot.checkoutTimeouts += 1;
  }
  slot.lastFailureAt = nowIso;

  global.pendingCheckouts = Math.max(0, Number(global.pendingCheckouts || 0) - 1);
  global.checkoutFailureStreak = Math.max(
    0,
    Number(global.checkoutFailureStreak || 0),
  ) + 1;
  global.checkoutFailureCount = Math.max(
    0,
    Number(global.checkoutFailureCount || 0),
  ) + 1;
  if (checkoutTimeout) {
    global.checkoutTimeoutCount = Math.max(
      0,
      Number(global.checkoutTimeoutCount || 0),
    ) + 1;
  }
  global.lastCheckoutFailureAt = nowIso;

  state.checkoutFailedCount = Math.max(
    0,
    Number(state.checkoutFailedCount || 0),
  ) + 1;
  if (checkoutTimeout) {
    state.checkoutTimeoutCount = Math.max(
      0,
      Number(state.checkoutTimeoutCount || 0),
    ) + 1;
  }
  syncDerivedState();
  return {
    checkoutFailureCount: Number(global.checkoutFailureCount || 0),
    checkoutTimeoutCount: Number(global.checkoutTimeoutCount || 0),
    checkoutFailureStreak: Number(global.checkoutFailureStreak || 0),
    checkoutTimeout,
    lastCheckoutFailureAt: nowIso,
  };
}

function noteMongoCheckoutFailure({ error, at, address, reason } = {}) {
  return noteMongoCheckoutFailed({
    error,
    at,
    address,
    reason,
  }).checkoutFailureCount;
}

function markMongoHealthy({ at, connect = false, reason = "DB_SUCCESS" } = {}) {
  const nowMs = nowMsFrom(at);
  const nowIso = toIsoFromMs(nowMs);
  const previousState = state.state;
  const hadFailures = previousState !== STATE_HEALTHY;

  state.connected = true;
  if (connect || !state.lastConnectAt) state.lastConnectAt = nowIso;
  state.lastHealthyAt = nowIso;
  state.lastSuccessAt = nowIso;

  if (!hadFailures) {
    return {
      recovered: false,
      enteredRecovering: false,
      severity: state.severity,
      status: state.state,
      state: state.state,
      recoveryStreak: state.recoveryStreak,
    };
  }

  if (previousState !== STATE_RECOVERING) {
    state.recoveryStreak = 1;
    transitionState(STATE_RECOVERING, {
      at: nowMs,
      reason: sanitizeReason(reason),
    });
  } else {
    state.recoveryStreak += 1;
  }

  const lastFailureMs = state.lastFailureAt
    ? new Date(state.lastFailureAt).getTime()
    : 0;
  const noFailureLongEnough =
    !Number.isFinite(lastFailureMs) ||
    lastFailureMs <= 0 ||
    nowMs - lastFailureMs >= cfg().recoveryNoFailureWindowMs;
  const backlogSafe = !hasWarnBacklog();
  const streakReady = state.recoveryStreak >= cfg().recoveryStreakRequired;

  if (streakReady && noFailureLongEnough && backlogSafe) {
    transitionState(STATE_HEALTHY, {
      at: nowMs,
      reason: "RECOVERY_STABLE",
    });
    state.recoveryCount += 1;
    state.failureStreak = 0;
    state.recoveryStreak = 0;
    state.burstCount = 0;
    state.failureWindowStartAt = null;
    state.lastDegradedReason = null;
    state.lastRecoveryAt = nowIso;
    state.staleStatusBySubsystem = {};
    return {
      recovered: true,
      enteredRecovering: previousState !== STATE_RECOVERING,
      severity: state.severity,
      status: state.state,
      state: state.state,
      recoveryStreak: 0,
    };
  }

  syncDerivedState();
  return {
    recovered: false,
    enteredRecovering: previousState !== STATE_RECOVERING,
    severity: state.severity,
    status: state.state,
    state: state.state,
    recoveryStreak: state.recoveryStreak,
  };
}

function markMongoDegraded({ at, error, reason, connected } = {}) {
  const nowMs = nowMsFrom(at);
  const nowIso = toIsoFromMs(nowMs);
  const previousState = state.state;
  const normalizedReason = sanitizeReason(reason, error);

  if (typeof connected === "boolean") {
    state.connected = connected;
  }
  state.lastErrorAt = nowIso;
  state.lastFailureAt = nowIso;
  state.lastErrorMessage = String(error?.message || error || "").trim() || null;
  state.lastErrorCode =
    error?.code != null
      ? String(error.code)
      : error?.codeName != null
        ? String(error.codeName)
        : null;
  state.lastDegradedReason = normalizedReason;
  state.failureStreak = Math.max(0, Number(state.failureStreak || 0)) + 1;
  state.recoveryStreak = 0;
  recordFailureBurst(nowMs);

  if (previousState === STATE_HEALTHY) {
    transitionState(STATE_DEGRADED, {
      at: nowMs,
      reason: normalizedReason,
    });
  } else if (previousState === STATE_RECOVERING) {
    transitionState(STATE_DEGRADED, {
      at: nowMs,
      reason: normalizedReason,
    });
  }

  refreshDerivedSeverity({ at: nowMs, reason: normalizedReason });
  syncDerivedState();

  return {
    becameDegraded: previousState === STATE_HEALTHY,
    becameSevere:
      previousState !== STATE_SEVERELY_DEGRADED &&
      state.state === STATE_SEVERELY_DEGRADED,
    severityChanged: previousState !== state.state,
    connected: state.connected,
    degraded: state.degraded,
    severity: state.severity,
    status: state.state,
    state: state.state,
    failureStreak: state.failureStreak,
    burstCount: state.burstCount,
    checkoutTimeout: hasCheckoutTimeoutSignature(error, reason),
  };
}

function noteMongoWorkSuccess({
  subsystem,
  priority = PRIORITY_NON_CRITICAL,
  backlog = null,
  backlogEstimate = null,
  release = null,
} = {}) {
  try {
    if (typeof release === "function") release();
  } catch {}
  if (subsystem) {
    noteMongoSubsystemResumed({
      subsystem,
      priority,
      backlog,
      backlogEstimate,
    });
  }
  const healthy = markMongoHealthy();
  return {
    recovered: healthy?.recovered === true,
    enteredRecovering: healthy?.enteredRecovering === true,
    severity: state.severity,
    status: state.state,
    state: state.state,
  };
}

function backlogSummarySnapshot() {
  const result = {};
  for (const [subsystem, slot] of Object.entries(state.subsystems || {})) {
    result[subsystemExternalName(subsystem)] = {
      priority: slot.priority,
      backlog: Math.max(0, Number(slot.backlog || 0)),
      backlogEstimate:
        slot.health?.backlogEstimate === "unknown"
          ? "unknown"
          : Math.max(
              0,
              Number(slot.backlogEstimate || slot.backlog || 0),
            ),
      dropped: Math.max(0, Number(slot.dropped || 0)),
      compacted: Math.max(0, Number(slot.compacted || 0)),
      flushDeferredCount: Math.max(0, Number(slot.flushDeferredCount || 0)),
      lastDeferredAt: slot.lastDeferredAt || null,
      lastSuccessAt: slot.lastSuccessAt || null,
      lastFailureAt: slot.lastFailureAt || null,
      health: cloneJson(slot.health || {}),
    };
  }
  return result;
}

function recommendedAction() {
  switch (state.state) {
    case STATE_HEALTHY:
      return "NORMAL_OPERATION";
    case STATE_DEGRADED:
      return "DEFER_NON_CRITICAL_DB_WORK";
    case STATE_SEVERELY_DEGRADED:
      return "ALLOW_ONLY_CRITICAL_DB_WORK";
    case STATE_RECOVERING:
      return "WAIT_FOR_STABLE_RECOVERY";
    default:
      return "NORMAL_OPERATION";
  }
}

function getMongoHealthSnapshot() {
  const nowMs = Date.now();
  const degradedSinceMs = state.degradedSince
    ? new Date(state.degradedSince).getTime()
    : 0;
  const degradedDurationMs =
    state.degraded && Number.isFinite(degradedSinceMs) && degradedSinceMs > 0
      ? Math.max(0, nowMs - degradedSinceMs)
      : 0;

  return {
    connected: state.connected,
    degraded: state.degraded,
    state: state.state,
    severity: state.severity,
    status: state.state,
    enteredAt: state.enteredAt,
    degradedSince: state.degradedSince,
    recoveringSince: state.recoveringSince,
    degradedDurationMs,
    failureStreak: Math.max(0, Number(state.failureStreak || 0)),
    recoveryStreak: Math.max(0, Number(state.recoveryStreak || 0)),
    lastFailureAt: state.lastFailureAt,
    lastSuccessAt: state.lastSuccessAt,
    lastHealthyAt: state.lastHealthyAt,
    lastRecoveryAt: state.lastRecoveryAt,
    lastErrorAt: state.lastErrorAt,
    lastErrorMessage: state.lastErrorMessage,
    lastErrorCode: state.lastErrorCode,
    lastDegradedReason: state.lastDegradedReason,
    poolClearedCount: Math.max(0, Number(state.poolClearedCount || 0)),
    checkoutFailedCount: Math.max(0, Number(state.checkoutFailedCount || 0)),
    checkoutTimeoutCount: Math.max(0, Number(state.checkoutTimeoutCount || 0)),
    subsystemDeferCount: Math.max(0, Number(state.subsystemDeferCount || 0)),
    subsystemResumeCount: Math.max(0, Number(state.subsystemResumeCount || 0)),
    totalBacklog: totalBacklogFromSubsystems(),
    poolMetrics: clonePoolMetrics(state.poolMetrics),
    pool: cloneJson(state.poolMetrics.global),
    backlogSummary: backlogSummarySnapshot(),
    subsystems: cloneSubsystems(state.subsystems),
    recommendedAction: recommendedAction(),
  };
}

function getMongoRuntimeState() {
  return getMongoHealthSnapshot();
}

function resetMongoRuntimeStateForTests() {
  const fresh = defaultState();
  for (const key of Object.keys(state)) {
    delete state[key];
  }
  Object.assign(state, fresh);
  syncDerivedState();
}

module.exports = {
  STATE_HEALTHY,
  STATE_DEGRADED,
  STATE_SEVERELY_DEGRADED,
  STATE_RECOVERING,
  SEVERITY_HEALTHY,
  SEVERITY_DEGRADED,
  SEVERITY_SEVERELY_DEGRADED,
  PRIORITY_CRITICAL,
  PRIORITY_IMPORTANT,
  PRIORITY_NON_CRITICAL,
  getMongoRuntimeState,
  getMongoHealthSnapshot,
  markMongoHealthy,
  markMongoDegraded,
  noteMongoPoolCreated,
  noteMongoPoolClosed,
  noteMongoPoolCleared,
  noteMongoConnectionCreated,
  noteMongoConnectionReady,
  noteMongoConnectionClosed,
  noteMongoCheckoutStarted,
  noteMongoCheckoutSuccess,
  noteMongoCheckoutCheckedIn,
  noteMongoCheckoutFailed,
  noteMongoCheckoutFailure,
  noteMongoStatusStaleness,
  recommendMongoBackoff,
  noteMongoSubsystemDeferred,
  noteMongoSubsystemResumed,
  noteMongoSubsystemBacklog,
  updateMongoSubsystemHealth,
  defaultSubsystemPolicy,
  shouldAllowDbWork,
  acquireMongoWorkPermit,
  noteMongoWorkSuccess,
  resetMongoRuntimeStateForTests,
};
