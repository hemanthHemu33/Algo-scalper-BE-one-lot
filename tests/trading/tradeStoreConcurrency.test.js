const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function matchFilter(doc, filter = {}) {
  if (!doc) return false;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or") {
      if (!Array.isArray(value) || !value.some((entry) => matchFilter(doc, entry))) {
        return false;
      }
      continue;
    }
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "$exists")) {
      const exists = Object.prototype.hasOwnProperty.call(doc, key);
      if (exists !== Boolean(value.$exists)) return false;
      continue;
    }
    if (doc[key] !== value) return false;
  }
  return true;
}

function makeFakeDb() {
  const trades = new Map();

  return {
    collection(name) {
      if (name !== "trades") {
        return {
          createIndex: async () => {},
        };
      }

      return {
        createIndex: async () => {},
        insertOne: async (doc) => {
          trades.set(String(doc.tradeId), clone(doc));
          return { acknowledged: true };
        },
        findOne: async (filter) => {
          const doc = trades.get(String(filter?.tradeId || ""));
          return matchFilter(doc, filter) ? clone(doc) : null;
        },
        findOneAndUpdate: async (filter, update) => {
          const tradeId = String(filter?.tradeId || "");
          let doc = trades.get(tradeId);
          if (doc?.__conflictToTerminalOnNextUpdate) {
            const promoted = {
              ...clone(doc),
              status: String(doc.__terminalConflictStatus || "CLOSED"),
              closedAt: doc.closedAt || "2026-03-18T09:20:00.000Z",
              version: Number(doc.version ?? 0) + 1,
            };
            delete promoted.__conflictToTerminalOnNextUpdate;
            delete promoted.__terminalConflictStatus;
            trades.set(tradeId, promoted);
            doc = promoted;
          }
          if (!matchFilter(doc, filter)) {
            return { value: null };
          }
          const next = {
            ...clone(doc),
            ...(clone(update?.$set || {})),
          };
          for (const [key, delta] of Object.entries(update?.$inc || {})) {
            next[key] = Number(next[key] ?? 0) + Number(delta ?? 0);
          }
          trades.set(tradeId, next);
          return { value: clone(next) };
        },
        find(query = {}) {
          const rows = Array.from(trades.values()).filter((doc) => matchFilter(doc, query));
          return {
            toArray: async () => clone(rows),
          };
        },
      };
    },
  };
}

function loadTradeStoreHarness() {
  const dbPath = path.join(ROOT, "src", "db.js");
  const tradeStorePath = path.join(ROOT, "src", "trading", "tradeStore.js");

  delete require.cache[require.resolve(tradeStorePath)];

  const dbModule = require(dbPath);
  const previousGetDb = dbModule.getDb;
  const fakeDb = makeFakeDb();
  dbModule.getDb = () => fakeDb;

  const tradeStore = require(tradeStorePath);

  return {
    tradeStore,
    restore() {
      delete require.cache[require.resolve(tradeStorePath)];
      dbModule.getDb = previousGetDb;
    },
  };
}

async function testStaleWriteConflictRejectsOlderVersion() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-1",
      status: "ENTRY_OPEN",
      strategyStopLoss: 90,
      stopLoss: 90,
    });

    const initial = await getTrade("T-1");
    assert.equal(initial.version, 1);

    const applied = await updateTrade(
      "T-1",
      { status: "ENTRY_FILLED" },
      { expectedVersion: initial.version, currentTrade: initial },
    );
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.version, 2);

    const stale = await updateTrade(
      "T-1",
      { closeReason: "STALE_WRITE" },
      { expectedVersion: initial.version, currentTrade: initial },
    );
    assert.equal(stale.status, "CONFLICT");
    assert.equal(stale.expectedVersion, 1);
    assert.equal(stale.actualVersion, 2);
  } finally {
    harness.restore();
  }
}

async function testInvalidTransitionFailsClosed() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-2",
      status: "BROKEN_STATE",
      strategyStopLoss: 90,
      stopLoss: 90,
    });

    const current = await getTrade("T-2");
    const result = await updateTrade(
      "T-2",
      { status: "LIVE" },
      { expectedVersion: current.version, currentTrade: current },
    );

    assert.equal(result.status, "APPLIED");
    assert.equal(Boolean(result.validation?.ok), false);
    assert.equal(result.validation?.reason, "UNKNOWN_FROM");
    assert.equal(result.trade.status, "BROKEN_STATE");
    assert.equal(result.trade.statusTransitionError.reason, "UNKNOWN_FROM");
  } finally {
    harness.restore();
  }
}

function buildStaleEntryFinalizePatch() {
  return {
    status: "ENTRY_FILLED",
    entryPrice: 101.25,
    actualEntry: 101.25,
    qty: 10,
    entryFilledAt: "2026-03-18T09:16:00.000Z",
    entryAt: "2026-03-18T09:16:00.000Z",
    entryFinalized: true,
    entrySlippageBps: 4,
    lastEvent: "ENTRY_FILLED",
    lastEventMeta: { role: "ENTRY", source: "TEST" },
  };
}

async function testClosedTradeRejectsStaleEntryMutationAsNoop() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-CLOSED-NOOP",
      status: "CLOSED",
      strategyStopLoss: 90,
      stopLoss: 90,
      closedAt: "2026-03-18T09:20:00.000Z",
    });

    const before = await getTrade("T-CLOSED-NOOP");
    const result = await updateTrade(
      "T-CLOSED-NOOP",
      buildStaleEntryFinalizePatch(),
      { expectedVersion: before.version, currentTrade: before },
    );

    const after = await getTrade("T-CLOSED-NOOP");
    assert.equal(result.status, "NOOP_TERMINAL_STALE");
    assert.equal(after.status, "CLOSED");
    assert.equal(after.entryFinalized, undefined);
    assert.equal(after.entryPrice, undefined);
    assert.equal(after.version, before.version);
  } finally {
    harness.restore();
  }
}

async function testTerminalVersionConflictDowngradesStaleEntryPatch() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-CONFLICT-NOOP",
      status: "ENTRY_OPEN",
      strategyStopLoss: 90,
      stopLoss: 90,
      __conflictToTerminalOnNextUpdate: true,
      __terminalConflictStatus: "CLOSED",
    });

    const initial = await getTrade("T-CONFLICT-NOOP");

    const stale = await updateTrade(
      "T-CONFLICT-NOOP",
      buildStaleEntryFinalizePatch(),
      { expectedVersion: initial.version, currentTrade: initial },
    );

    const after = await getTrade("T-CONFLICT-NOOP");
    assert.equal(stale.status, "NOOP_TERMINAL_STALE");
    assert.equal(stale.dropReason, "TERMINAL_STALE_VERSION_CONFLICT");
    assert.equal(after.status, "CLOSED");
    assert.equal(after.entryFinalized, undefined);
    assert.equal(after.version, initial.version + 1);
  } finally {
    harness.restore();
  }
}

async function testLiveTradeStillAcceptsEntryMutation() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-LIVE-ENTRY",
      status: "ENTRY_OPEN",
      strategyStopLoss: 90,
      stopLoss: 90,
    });

    const before = await getTrade("T-LIVE-ENTRY");
    const applied = await updateTrade(
      "T-LIVE-ENTRY",
      buildStaleEntryFinalizePatch(),
      { expectedVersion: before.version, currentTrade: before },
    );

    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.trade.status, "ENTRY_FILLED");
    assert.equal(applied.trade.entryFinalized, true);
    assert.equal(Number(applied.trade.entryPrice), 101.25);
  } finally {
    harness.restore();
  }
}

async function testDuplicateTerminalStaleUpdatesRemainIdempotent() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;

    await insertTrade({
      tradeId: "T-DUP-TERMINAL",
      status: "CLOSED",
      strategyStopLoss: 90,
      stopLoss: 90,
      closedAt: "2026-03-18T09:20:00.000Z",
    });

    const before = await getTrade("T-DUP-TERMINAL");
    const patch = buildStaleEntryFinalizePatch();

    const first = await updateTrade("T-DUP-TERMINAL", patch, {
      expectedVersion: before.version,
      currentTrade: before,
    });
    const second = await updateTrade("T-DUP-TERMINAL", patch, {
      expectedVersion: before.version,
      currentTrade: before,
    });

    const after = await getTrade("T-DUP-TERMINAL");
    assert.equal(first.status, "NOOP_TERMINAL_STALE");
    assert.equal(second.status, "NOOP_TERMINAL_STALE");
    assert.equal(after.status, "CLOSED");
    assert.equal(after.version, before.version);
    assert.equal(after.entryFinalized, undefined);
  } finally {
    harness.restore();
  }
}

async function testTerminalStatusesRejectEntryFinalizationWrites() {
  const harness = loadTradeStoreHarness();

  try {
    const { insertTrade, getTrade, updateTrade } = harness.tradeStore;
    const statuses = ["ENTRY_CANCELLED", "CLOSED", "EXITED_TARGET"];

    for (const status of statuses) {
      const tradeId = `T-TERM-${status}`;
      await insertTrade({
        tradeId,
        status,
        strategyStopLoss: 90,
        stopLoss: 90,
        closedAt: "2026-03-18T09:20:00.000Z",
      });
      const before = await getTrade(tradeId);
      const result = await updateTrade(tradeId, buildStaleEntryFinalizePatch(), {
        expectedVersion: before.version,
        currentTrade: before,
      });
      const after = await getTrade(tradeId);
      assert.equal(result.status, "NOOP_TERMINAL_STALE", tradeId);
      assert.equal(after.status, status, tradeId);
      assert.equal(after.entryFinalized, undefined, tradeId);
    }
  } finally {
    harness.restore();
  }
}

async function testMissingTradeIsExplicit() {
  const harness = loadTradeStoreHarness();

  try {
    const { updateTrade } = harness.tradeStore;
    const result = await updateTrade("MISSING", { status: "LIVE" }, { expectedVersion: 0 });
    assert.equal(result.status, "MISSING");
    assert.equal(result.trade, null);
  } finally {
    harness.restore();
  }
}

function testStateMachineRejectsEmptyAndUnknownFromStates() {
  const { canTransition } = require("../../src/trading/tradeStateMachine");
  assert.deepEqual(canTransition("", "LIVE"), {
    ok: false,
    reason: "FROM_EMPTY",
  });
  assert.deepEqual(canTransition("NOT_A_REAL_STATE", "LIVE"), {
    ok: false,
    reason: "UNKNOWN_FROM",
  });
}

async function main() {
  await testStaleWriteConflictRejectsOlderVersion();
  await testInvalidTransitionFailsClosed();
  await testClosedTradeRejectsStaleEntryMutationAsNoop();
  await testTerminalVersionConflictDowngradesStaleEntryPatch();
  await testLiveTradeStillAcceptsEntryMutation();
  await testDuplicateTerminalStaleUpdatesRemainIdempotent();
  await testTerminalStatusesRejectEntryFinalizationWrites();
  await testMissingTradeIsExplicit();
  testStateMachineRejectsEmptyAndUnknownFromStates();
  console.log("tradeStoreConcurrency.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
