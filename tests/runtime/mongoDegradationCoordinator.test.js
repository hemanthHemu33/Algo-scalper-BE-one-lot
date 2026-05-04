const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const coordinatorPath = path.join(ROOT, "src", "runtime", "mongoRuntimeState.js");
const gatePath = path.join(ROOT, "src", "runtime", "mongoWorkGate.js");

function loadCoordinator({
  MONGO_BACKOFF_JITTER_PCT = "0",
  MONGO_RECOVERY_STREAK_REQUIRED = "3",
  MONGO_RECOVERY_NO_FAILURE_WINDOW_MS = "30000",
  MONGO_SEVERE_FAILURE_STREAK = "3",
  MONGO_SEVERE_BURST_COUNT = "3",
  MONGO_DEGRADE_BURST_WINDOW_MS = "60000",
} = {}) {
  const overrides = {
    MONGO_BACKOFF_JITTER_PCT,
    MONGO_RECOVERY_STREAK_REQUIRED,
    MONGO_RECOVERY_NO_FAILURE_WINDOW_MS,
    MONGO_SEVERE_FAILURE_STREAK,
    MONGO_SEVERE_BURST_COUNT,
    MONGO_DEGRADE_BURST_WINDOW_MS,
  };
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }

  delete require.cache[require.resolve(gatePath)];
  delete require.cache[require.resolve(coordinatorPath)];

  const coordinator = require(coordinatorPath);
  const gate = require(gatePath);
  coordinator.resetMongoRuntimeStateForTests();

  return {
    coordinator,
    gate,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[require.resolve(gatePath)];
      delete require.cache[require.resolve(coordinatorPath)];
    },
  };
}

function checkoutTimeoutError() {
  return new Error("Timed out while checking out a connection from connection pool");
}

function testHealthyToDegradedToSevereToRecoveringToHealthy() {
  const h = loadCoordinator();
  try {
    const t0 = Date.parse("2026-04-22T09:00:00.000Z");
    const firstFailure = h.coordinator.markMongoDegraded({
      at: t0,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    assert.equal(firstFailure.state, "DEGRADED");
    assert.equal(firstFailure.becameDegraded, true);
    assert.equal(h.coordinator.getMongoHealthSnapshot().state, "DEGRADED");

    h.coordinator.markMongoDegraded({
      at: t0 + 1000,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    const severe = h.coordinator.markMongoDegraded({
      at: t0 + 2000,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    assert.equal(severe.state, "SEVERELY_DEGRADED");
    assert.equal(severe.becameSevere, true);

    const recovering = h.coordinator.markMongoHealthy({
      at: t0 + 31_000,
      reason: "db_ping_ok",
    });
    assert.equal(recovering.enteredRecovering, true);
    assert.equal(h.coordinator.getMongoHealthSnapshot().state, "RECOVERING");

    h.coordinator.markMongoHealthy({
      at: t0 + 32_000,
      reason: "db_ping_ok",
    });
    const healthy = h.coordinator.markMongoHealthy({
      at: t0 + 33_000,
      reason: "db_ping_ok",
    });
    assert.equal(healthy.recovered, true);
    assert.equal(h.coordinator.getMongoHealthSnapshot().state, "HEALTHY");
  } finally {
    h.restore();
  }
}

function testNonCriticalBlockedImportantLimitedAndCriticalBehaviorMatchesState() {
  const h = loadCoordinator();
  try {
    const t0 = Date.parse("2026-04-22T09:10:00.000Z");
    h.coordinator.markMongoDegraded({
      at: t0,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });

    const nonCriticalGate = h.gate.evaluateMongoWorkGate({
      subsystem: "signal_telemetry",
      priority: "non_critical",
      phase: "flush",
    });
    assert.equal(nonCriticalGate.deferred, true);

    const importantPermit = h.gate.evaluateMongoWorkGate({
      subsystem: "candle_writer",
      priority: "important",
      phase: "flush",
      backlog: 10,
    });
    assert.equal(importantPermit.deferred, false);
    assert.equal(typeof importantPermit.release, "function");

    const importantBlocked = h.gate.evaluateMongoWorkGate({
      subsystem: "candle_writer",
      priority: "important",
      phase: "flush",
      backlog: 11,
    });
    assert.equal(importantBlocked.deferred, true);
    importantPermit.release();

    const criticalAllowed = h.gate.evaluateMongoWorkGate({
      subsystem: "trade_safety_write",
      priority: "critical",
      phase: "persist",
    });
    assert.equal(criticalAllowed.deferred, false);
    criticalAllowed.release?.();

    h.coordinator.markMongoDegraded({
      at: t0 + 1000,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    h.coordinator.markMongoDegraded({
      at: t0 + 2000,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });

    const criticalBlockedInSevere = h.gate.evaluateMongoWorkGate({
      subsystem: "trade_safety_write",
      priority: "critical",
      phase: "persist",
    });
    assert.equal(criticalBlockedInSevere.deferred, true);
    assert.equal(criticalBlockedInSevere.criticalWarning, true);

    const reconcileAllowedInSevere = h.gate.evaluateMongoWorkGate({
      subsystem: "reconcile",
      priority: "critical",
      phase: "reconcile",
    });
    assert.equal(reconcileAllowedInSevere.deferred, false);
    reconcileAllowedInSevere.release?.();
  } finally {
    h.restore();
  }
}

function testRecoveryFallsBackToDegradedOnFailure() {
  const h = loadCoordinator();
  try {
    const t0 = Date.parse("2026-04-22T09:20:00.000Z");
    h.coordinator.markMongoDegraded({
      at: t0,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    h.coordinator.markMongoHealthy({
      at: t0 + 31_000,
      reason: "db_ping_ok",
    });
    assert.equal(h.coordinator.getMongoHealthSnapshot().state, "RECOVERING");

    h.coordinator.markMongoDegraded({
      at: t0 + 32_000,
      error: checkoutTimeoutError(),
      reason: "connection_checkout_failed",
    });
    assert.equal(h.coordinator.getMongoHealthSnapshot().state, "DEGRADED");
  } finally {
    h.restore();
  }
}

function main() {
  testHealthyToDegradedToSevereToRecoveringToHealthy();
  testNonCriticalBlockedImportantLimitedAndCriticalBehaviorMatchesState();
  testRecoveryFallsBackToDegradedOnFailure();
  console.log("mongoDegradationCoordinator.test.js passed");
}

main();
