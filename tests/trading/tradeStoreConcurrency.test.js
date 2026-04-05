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
          const doc = trades.get(tradeId);
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
  await testMissingTradeIsExplicit();
  testStateMachineRejectsEmptyAndUnknownFromStates();
  console.log("tradeStoreConcurrency.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
