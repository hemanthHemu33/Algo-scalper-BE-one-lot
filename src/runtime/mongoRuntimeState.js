const state = {
  connected: false,
  degraded: false,
  lastConnectAt: null,
  lastHealthyAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastErrorCode: null,
  lastDegradedReason: null,
  poolClearedCount: 0,
  checkoutFailedCount: 0,
  recoveryCount: 0,
};

function toIso(at) {
  const value = at ? new Date(at) : new Date();
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

function getMongoRuntimeState() {
  return { ...state };
}

function markMongoHealthy({ at, connect = false } = {}) {
  const nowIso = toIso(at);
  const wasDegraded = state.degraded === true;

  state.connected = true;
  state.degraded = false;
  if (connect || !state.lastConnectAt) state.lastConnectAt = nowIso;
  state.lastHealthyAt = nowIso;
  state.lastDegradedReason = null;

  if (wasDegraded) {
    state.recoveryCount += 1;
  }

  return {
    recovered: wasDegraded,
    connected: state.connected,
    degraded: state.degraded,
  };
}

function markMongoDegraded({ at, error, reason, connected = false } = {}) {
  const nowIso = toIso(at);
  const message = String(error?.message || error || "").trim() || null;
  const code =
    error?.code != null
      ? String(error.code)
      : error?.codeName != null
        ? String(error.codeName)
        : null;
  const wasDegraded = state.degraded === true;

  state.connected = Boolean(connected);
  state.degraded = true;
  state.lastErrorAt = nowIso;
  state.lastErrorMessage = message;
  state.lastErrorCode = code;
  state.lastDegradedReason = reason ? String(reason) : null;

  return {
    becameDegraded: !wasDegraded,
    connected: state.connected,
    degraded: state.degraded,
  };
}

function noteMongoPoolCleared() {
  state.poolClearedCount += 1;
  return state.poolClearedCount;
}

function noteMongoCheckoutFailure() {
  state.checkoutFailedCount += 1;
  return state.checkoutFailedCount;
}

module.exports = {
  getMongoRuntimeState,
  markMongoHealthy,
  markMongoDegraded,
  noteMongoPoolCleared,
  noteMongoCheckoutFailure,
};
