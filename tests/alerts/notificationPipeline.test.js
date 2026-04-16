const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function compareValue(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const right = b instanceof Date ? b.getTime() : new Date(b).getTime();
    return left - right;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function matchesQuery(doc, query = {}) {
  if (!query || typeof query !== "object") return true;
  for (const [key, expected] of Object.entries(query)) {
    if (key === "$or") {
      if (!Array.isArray(expected) || !expected.some((part) => matchesQuery(doc, part))) {
        return false;
      }
      continue;
    }

    const actual = doc[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      if (Object.prototype.hasOwnProperty.call(expected, "$in")) {
        if (!expected.$in.some((value) => compareValue(actual, value) === 0)) {
          return false;
        }
      }
      if (Object.prototype.hasOwnProperty.call(expected, "$lte")) {
        if (compareValue(actual, expected.$lte) > 0) return false;
      }
      if (Object.prototype.hasOwnProperty.call(expected, "$gte")) {
        if (compareValue(actual, expected.$gte) < 0) return false;
      }
      continue;
    }

    if (compareValue(actual, expected) !== 0) return false;
  }
  return true;
}

function applyUpdate(doc, update, isInsert) {
  if (update?.$setOnInsert && isInsert) {
    Object.assign(doc, clone(update.$setOnInsert));
  }
  if (update?.$set) {
    Object.assign(doc, clone(update.$set));
  }
  if (update?.$inc) {
    for (const [key, value] of Object.entries(update.$inc)) {
      doc[key] = Number(doc[key] ?? 0) + Number(value ?? 0);
    }
  }
  return doc;
}

class FakeCursor {
  constructor(docs) {
    this.docs = docs.slice();
  }

  sort(sortSpec = {}) {
    const keys = Object.entries(sortSpec);
    this.docs.sort((a, b) => {
      for (const [key, dir] of keys) {
        const cmp = compareValue(a[key], b[key]);
        if (cmp !== 0) return Number(dir) >= 0 ? cmp : -cmp;
      }
      return 0;
    });
    return this;
  }

  limit(n) {
    this.docs = this.docs.slice(0, Math.max(0, Number(n) || 0));
    return this;
  }

  async toArray() {
    return this.docs.map((doc) => clone(doc));
  }
}

class FakeCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.nextId = 1;
  }

  async createIndex() {
    return `${this.name}_idx`;
  }

  find(query = {}) {
    return new FakeCursor(this.docs.filter((doc) => matchesQuery(doc, query)));
  }

  async findOne(query = {}) {
    const found = this.docs.find((doc) => matchesQuery(doc, query));
    return found ? clone(found) : null;
  }

  async insertOne(doc) {
    const next = clone(doc);
    if (next._id == null) next._id = `${this.name}-${this.nextId++}`;
    this.docs.push(next);
    return { insertedId: next._id };
  }

  async updateOne(query, update, options = {}) {
    let index = this.docs.findIndex((doc) => matchesQuery(doc, query));
    let inserted = false;
    if (index < 0 && options.upsert) {
      const seed = {};
      for (const [key, value] of Object.entries(query || {})) {
        if (!key.startsWith("$") && (typeof value !== "object" || value instanceof Date)) {
          seed[key] = value;
        }
      }
      if (seed._id == null) seed._id = `${this.name}-${this.nextId++}`;
      this.docs.push(seed);
      index = this.docs.length - 1;
      inserted = true;
    }
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 };
    applyUpdate(this.docs[index], update, inserted);
    return {
      matchedCount: 1,
      modifiedCount: 1,
      upsertedId: inserted ? this.docs[index]._id : null,
    };
  }

  async findOneAndUpdate(query, update, options = {}) {
    let index = this.docs.findIndex((doc) => matchesQuery(doc, query));
    let inserted = false;
    if (index < 0 && options.upsert) {
      const seed = {};
      for (const [key, value] of Object.entries(query || {})) {
        if (!key.startsWith("$") && (typeof value !== "object" || value instanceof Date)) {
          seed[key] = value;
        }
      }
      if (seed._id == null) seed._id = `${this.name}-${this.nextId++}`;
      this.docs.push(seed);
      index = this.docs.length - 1;
      inserted = true;
    }
    if (index < 0) return { value: null };
    applyUpdate(this.docs[index], update, inserted);
    return { value: clone(this.docs[index]) };
  }

  async updateMany(query, update) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (!matchesQuery(doc, query)) continue;
      applyUpdate(doc, update, false);
      modifiedCount += 1;
    }
    return { modifiedCount };
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection(name));
    }
    return this.collections.get(name);
  }
}

function loadHarness({
  envOverrides = {},
  fakeDb = new FakeDb(),
  sendImpl = null,
  editImpl = null,
} = {}) {
  const paths = {
    config: path.join(ROOT, "src", "config.js"),
    db: path.join(ROOT, "src", "db.js"),
    telegram: path.join(ROOT, "src", "alerts", "telegram.js"),
    policy: path.join(ROOT, "src", "alerts", "notificationPolicy.js"),
    builder: path.join(ROOT, "src", "alerts", "tradeStatusBuilder.js"),
    formatter: path.join(ROOT, "src", "alerts", "telegramFormatter.js"),
    ledger: path.join(ROOT, "src", "alerts", "notificationLedger.js"),
    outbox: path.join(ROOT, "src", "alerts", "notificationOutbox.js"),
    dispatcher: path.join(ROOT, "src", "alerts", "notificationDispatcher.js"),
    alertService: path.join(ROOT, "src", "alerts", "alertService.js"),
  };

  for (const mod of Object.values(paths)) {
    delete require.cache[require.resolve(mod)];
  }

  const { env } = require(paths.config);
  const originalEnv = {};
  const defaults = {
    TELEGRAM_ENABLED: "true",
    TELEGRAM_NOTIFICATIONS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
    TELEGRAM_TRADE_CARD_ENABLED: "true",
    TELEGRAM_TRADE_CARD_MIN_REFRESH_SEC: 5,
    TELEGRAM_TRADE_CARD_PNL_DELTA_INR: 50,
    TELEGRAM_TRADE_CARD_LTP_DELTA: 0.5,
    TELEGRAM_TRADE_CARD_FORCE_REFRESH_SEC: 30,
    TELEGRAM_INCIDENTS_ENABLED: "true",
    TELEGRAM_HEARTBEAT_ENABLED: "false",
    TELEGRAM_OUTBOX_RETRY_BASE_MS: 250,
    TELEGRAM_OUTBOX_MAX_RETRIES: 4,
    TELEGRAM_OUTBOX_POLL_MS: 100000,
    TELEGRAM_RATE_LIMIT_MS: 0,
    TELEGRAM_DEDUPE_TTL_SEC: 3600,
  };
  for (const [key, value] of Object.entries({ ...defaults, ...envOverrides })) {
    originalEnv[key] = env[key];
    env[key] = value;
  }

  const dbModule = require(paths.db);
  const originalGetDb = dbModule.getDb;
  dbModule.getDb = () => fakeDb;

  const calls = {
    send: [],
    edit: [],
  };
  let nextMessageId = 100;

  const telegramModule = require(paths.telegram);
  const originalSend = telegramModule.sendMessage;
  const originalEdit = telegramModule.editMessageText;
  const originalIsEnabled = telegramModule.isEnabled;

  telegramModule.sendMessage = async (text, options = {}) => {
    calls.send.push({ text, options });
    if (typeof sendImpl === "function") {
      return sendImpl(text, options, calls.send.length);
    }
    return {
      ok: true,
      messageId: nextMessageId++,
      raw: { ok: true },
    };
  };
  telegramModule.editMessageText = async (messageId, text, options = {}) => {
    calls.edit.push({ messageId, text, options });
    if (typeof editImpl === "function") {
      return editImpl(messageId, text, options, calls.edit.length);
    }
    return {
      ok: true,
      messageId,
      raw: { ok: true },
    };
  };
  telegramModule.isEnabled = () => true;

  const dispatcher = require(paths.dispatcher);
  const alertService = require(paths.alertService);

  async function drain(iterations = 3, pauseMs = 0) {
    for (let i = 0; i < iterations; i += 1) {
      await sleep(pauseMs);
      await dispatcher.processOutboxOnce();
      await sleep(0);
    }
  }

  return {
    env,
    fakeDb,
    calls,
    dispatcher,
    alertService,
    async drain(iterations = 3, pauseMs = 0) {
      await drain(iterations, pauseMs);
    },
    restore() {
      dispatcher.stopNotificationDispatcher();
      dbModule.getDb = originalGetDb;
      telegramModule.sendMessage = originalSend;
      telegramModule.editMessageText = originalEdit;
      telegramModule.isEnabled = originalIsEnabled;
      for (const [key, value] of Object.entries(originalEnv)) {
        env[key] = value;
      }
      for (const mod of Object.values(paths)) {
        delete require.cache[require.resolve(mod)];
      }
    },
  };
}

function buildTrade(overrides = {}) {
  return {
    tradeId: "T-BASE",
    status: "ENTRY_OPEN",
    strategyId: "S1",
    side: "BUY",
    qty: 50,
    initialQty: 50,
    instrument_token: 101,
    instrument: { tradingsymbol: "NIFTY24APR22000CE" },
    updatedAt: makeDate("2026-04-11T09:16:00.000Z"),
    createdAt: makeDate("2026-04-11T09:15:00.000Z"),
    ...overrides,
  };
}

function getTradeCardLedger(harness, tradeId) {
  return harness.fakeDb
    .collection("notification_ledger")
    .docs.find(
      (doc) => doc.kind === "trade_card" && String(doc.tradeId) === String(tradeId),
    );
}

function ageTradeCardLedger(harness, tradeId, msAgo) {
  const entry = getTradeCardLedger(harness, tradeId);
  if (!entry) return null;
  const past = new Date(Date.now() - Math.max(0, Number(msAgo) || 0));
  entry.liveRefresh = {
    ...(entry.liveRefresh || {}),
    lastDisplaySentAt: past,
  };
  entry.sentAt = past;
  entry.updatedAt = past;
  return entry;
}

async function testEntryPlacementRejectedImmediately() {
  const harness = loadHarness();
  try {
    await harness.alertService.alert("info", "🟢 ENTRY placing", { tradeId: "T-1" });
    await harness.drain();
    assert.equal(harness.calls.send.length, 0);

    await harness.alertService.alert("error", "❌ ENTRY rejected/failed", {
      tradeId: "T-1",
      message: "RMS reject",
    });
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: buildTrade({
        tradeId: "T-1",
        status: "ENTRY_FAILED",
        entryOrderId: null,
        entryPrice: null,
        closeReason: "ENTRY_PLACE_FAILED | RMS reject",
      }),
    });
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);
    const ledgerDocs = harness.fakeDb.collection("notification_ledger").docs;
    assert.equal(ledgerDocs.some((doc) => doc.kind === "trade_card"), false);
  } finally {
    harness.restore();
  }
}

async function testEntryAcceptedThenFilledWithoutDuplicateFillSpam() {
  const harness = loadHarness();
  try {
    const submitted = buildTrade({
      tradeId: "T-ENTRY",
      entryOrderId: "ENTRY-1",
      status: "ENTRY_OPEN",
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: submitted,
      runtime: { ltp: 100.5 },
    });
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 0);

    const filled = buildTrade({
      tradeId: "T-ENTRY",
      entryOrderId: "ENTRY-1",
      status: "ENTRY_FILLED",
      entryPrice: 100.25,
      updatedAt: makeDate("2026-04-11T09:16:30.000Z"),
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: submitted,
      trade: filled,
      runtime: { ltp: 101.1 },
    });
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: filled,
      trade: clone(filled),
      runtime: { ltp: 101.1 },
    });
    await harness.drain();
    assert.equal(harness.calls.edit.length, 1);
  } finally {
    harness.restore();
  }
}

async function testPartialFillThenFullFillUpdatesSameCard() {
  const harness = loadHarness();
  try {
    const submitted = buildTrade({
      tradeId: "T-PARTIAL",
      entryOrderId: "ENTRY-2",
      status: "ENTRY_OPEN",
    });
    const partial = buildTrade({
      tradeId: "T-PARTIAL",
      entryOrderId: "ENTRY-2",
      status: "ENTRY_OPEN",
      initialQty: 50,
      qty: 25,
      entryPrice: 99.75,
      updatedAt: makeDate("2026-04-11T09:16:15.000Z"),
    });
    const filled = buildTrade({
      tradeId: "T-PARTIAL",
      entryOrderId: "ENTRY-2",
      status: "ENTRY_FILLED",
      initialQty: 50,
      qty: 50,
      entryPrice: 100,
      updatedAt: makeDate("2026-04-11T09:16:45.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: submitted });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: submitted, trade: partial });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: partial, trade: filled });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 2);
    assert.ok(harness.calls.edit[0].text.includes("x25"));
    assert.ok(harness.calls.edit[1].text.includes("x50"));
    assert.ok(harness.calls.edit[1].text.includes("ENTRY_FILLED"));
  } finally {
    harness.restore();
  }
}

async function testProtectionOnlyAppearsAfterConfirmedPlacement() {
  const harness = loadHarness();
  try {
    await harness.alertService.alert("info", "🛡️ SL placing", { tradeId: "T-PROT" });
    await harness.alertService.alert("info", "🎯 TARGET placing", { tradeId: "T-PROT" });
    await harness.drain();
    assert.equal(harness.calls.send.length, 0);

    const filled = buildTrade({
      tradeId: "T-PROT",
      status: "ENTRY_FILLED",
      entryOrderId: "ENTRY-3",
      entryPrice: 100,
    });
    const slLive = buildTrade({
      tradeId: "T-PROT",
      status: "SL_PLACED",
      entryOrderId: "ENTRY-3",
      entryPrice: 100,
      slOrderId: "SL-1",
      stopLoss: 95,
    });
    const targetLive = buildTrade({
      tradeId: "T-PROT",
      status: "LIVE",
      entryOrderId: "ENTRY-3",
      entryPrice: 100,
      slOrderId: "SL-1",
      stopLoss: 95,
      targetOrderId: "TARGET-1",
      targetPrice: 108,
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: filled });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: filled, trade: slLive });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: slLive, trade: targetLive });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 2);
    assert.ok(harness.calls.edit[0].text.includes("Protection"));
    assert.ok(harness.calls.edit[1].text.includes("108.00"));
  } finally {
    harness.restore();
  }
}

async function testBeAndTrailOnlyNotifyOnMaterialStopChanges() {
  const harness = loadHarness();
  try {
    const base = buildTrade({
      tradeId: "T-BE",
      status: "LIVE",
      entryOrderId: "ENTRY-4",
      entryPrice: 100,
      slOrderId: "SL-2",
      stopLoss: 95,
    });
    const beArmed = buildTrade({
      ...base,
      beLocked: true,
      beLockedAtPrice: 100,
      updatedAt: makeDate("2026-04-11T09:17:00.000Z"),
    });
    const sameBe = buildTrade({
      ...beArmed,
      updatedAt: makeDate("2026-04-11T09:17:05.000Z"),
    });
    const trailed = buildTrade({
      ...beArmed,
      trailActive: true,
      protectedStopSource: "TRAIL",
      stopLoss: 101.5,
      updatedAt: makeDate("2026-04-11T09:17:30.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: base });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: base, trade: beArmed });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: beArmed, trade: sameBe });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: sameBe, trade: trailed });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: trailed, trade: clone(trailed) });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 2);
    assert.ok(harness.calls.edit[0].text.includes("BE armed"));
    assert.ok(harness.calls.edit[1].text.includes("Trail active"));
  } finally {
    harness.restore();
  }
}

async function testAlcPendingAndConfirmedAreDistinct() {
  const harness = loadHarness();
  try {
    const live = buildTrade({
      tradeId: "T-ALC",
      status: "LIVE",
      entryOrderId: "ENTRY-5",
      entryPrice: 100,
      slOrderId: "SL-3",
      stopLoss: 96,
    });
    const pending = buildTrade({
      ...live,
      protectionUpgradePending: true,
      loserCompressionSubmittedState: "ALC_L1",
      updatedAt: makeDate("2026-04-11T09:18:00.000Z"),
    });
    const confirmed = buildTrade({
      ...live,
      protectionUpgradePending: false,
      loserCompressionAppliedState: "ALC_L1",
      protectedStopSource: "ALC_L1",
      stopLoss: 98,
      updatedAt: makeDate("2026-04-11T09:18:20.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: live });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: live, trade: pending });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: pending, trade: confirmed });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 2);
    assert.ok(harness.calls.edit[0].text.includes("ALC"));
    assert.notEqual(harness.calls.edit[0].text, harness.calls.edit[1].text);
  } finally {
    harness.restore();
  }
}

async function testTerminalSummaryReusesCardWithoutLegacySpam() {
  const harness = loadHarness();
  try {
    const live = buildTrade({
      tradeId: "T-TERM",
      status: "LIVE",
      entryOrderId: "ENTRY-6",
      entryPrice: 100,
      slOrderId: "SL-4",
      stopLoss: 95,
      targetOrderId: "TARGET-2",
      targetPrice: 108,
    });
    const targetHit = buildTrade({
      ...live,
      status: "EXITED_TARGET",
      exitPrice: 108,
      exitReason: "TARGET_HIT",
      exitAuthority: "TARGET_ORDER",
      pnlGrossInr: 400,
      pnlNetAfterEstCostsInr: 360,
      updatedAt: makeDate("2026-04-11T09:20:00.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: live });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: live, trade: targetHit });
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);
    assert.ok(harness.calls.edit[0].text.includes("TRADE CLOSED"));

    await harness.alertService.alert("info", "🏁 TARGET HIT", { tradeId: "T-TERM", exitPrice: 108 });
    await harness.alertService.alert("info", "📌 Trade closed", { tradeId: "T-TERM", pnlInr: 400 });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: targetHit,
      trade: buildTrade({
        ...targetHit,
        closedAt: makeDate("2026-04-11T09:20:10.000Z"),
      }),
    });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);
  } finally {
    harness.restore();
  }
}

async function testRestartSafetySuppressesReplay() {
  const harness = loadHarness();
  try {
    const live = buildTrade({
      tradeId: "T-RESTART",
      status: "LIVE",
      entryOrderId: "ENTRY-7",
      entryPrice: 100,
      slOrderId: "SL-5",
      stopLoss: 96,
    });
    const terminal = buildTrade({
      ...live,
      status: "EXITED_SL",
      exitPrice: 96,
      exitReason: "STOP_HIT",
      exitAuthority: "STOP_ORDER",
      pnlGrossInr: -200,
      pnlNetAfterEstCostsInr: -230,
      updatedAt: makeDate("2026-04-11T09:21:00.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({ previousTrade: null, trade: live });
    await harness.drain();
    await harness.alertService.dispatchTradeUpdate({ previousTrade: live, trade: terminal });
    await harness.drain();

    harness.dispatcher.stopNotificationDispatcher();
    await harness.dispatcher.startNotificationDispatcher();

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: terminal,
      trade: clone(terminal),
    });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);
  } finally {
    harness.restore();
  }
}

async function testTelegramFailureRetriesFromOutbox() {
  let sendAttempts = 0;
  const harness = loadHarness({
    sendImpl: async (text, options, count) => {
      sendAttempts = count;
      if (count === 1) {
        const error = new Error("temporary_network_failure");
        error.retryAfterMs = 250;
        throw error;
      }
      return {
        ok: true,
        messageId: 777,
        raw: { ok: true, text, options },
      };
    },
  });

  try {
    await harness.alertService.dispatchNotification({
      kind: "incident",
      severity: "error",
      entityType: "engine",
      entityId: "primary",
      dedupeKey: "engine:test:retry",
      event: "TEST_RETRY",
      payload: { message: "retry me", meta: { reason: "network" } },
    });

    await harness.drain(1);
    const firstJob = harness.fakeDb.collection("notification_outbox").docs[0];
    assert.equal(firstJob.status, "retry");

    await sleep(300);
    await harness.drain(2);

    const finalJob = harness.fakeDb.collection("notification_outbox").docs[0];
    assert.equal(finalJob.status, "sent");
    assert.equal(sendAttempts, 2);
  } finally {
    harness.restore();
  }
}

async function testHeartbeatSkipsWhenClosedAndSendsWhenLive() {
  const harness = loadHarness({
    envOverrides: {
      TELEGRAM_HEARTBEAT_ENABLED: "true",
    },
  });
  try {
    harness.alertService.setNotificationHeartbeatProvider(async () => ({
      engineMode: "IDLE",
      tradingEnabled: false,
      activeTradeId: null,
      activeTrade: null,
      dailyRiskState: "RUNNING",
      tickerConnected: false,
      kiteLayer: { kiteSessionActive: false },
      killSwitch: false,
      faults: [],
    }));

    await harness.dispatcher.startNotificationDispatcher();
    const skipped = await harness.dispatcher.emitHeartbeat();
    assert.equal(skipped.skipped, true);

    harness.alertService.setNotificationHeartbeatProvider(async () => ({
      engineMode: "LIVE",
      tradingEnabled: true,
      activeTradeId: "T-HB",
      activeTrade: buildTrade({
        tradeId: "T-HB",
        status: "LIVE",
        entryOrderId: "ENTRY-HB",
      }),
      dailyRiskState: "RUNNING",
      tickerConnected: true,
      kiteLayer: { kiteSessionActive: true },
      killSwitch: false,
      faults: { a: 1, b: 2 },
    }));

    await harness.dispatcher.emitHeartbeat();
    await harness.drain();
    assert.equal(harness.calls.send.length, 1);
    assert.ok(harness.calls.send[0].text.includes("ENGINE HEARTBEAT"));
  } finally {
    harness.restore();
  }
}

async function testCollapsedTransitionsStillPreserveMilestones() {
  const harness = loadHarness();
  try {
    const submitted = buildTrade({
      tradeId: "T-COLLAPSE",
      status: "ENTRY_OPEN",
      entryOrderId: "ENTRY-COLLAPSE",
      updatedAt: makeDate("2026-04-11T09:16:00.000Z"),
    });
    const filled = buildTrade({
      tradeId: "T-COLLAPSE",
      status: "ENTRY_FILLED",
      entryOrderId: "ENTRY-COLLAPSE",
      entryPrice: 100,
      updatedAt: makeDate("2026-04-11T09:16:03.000Z"),
    });
    const protectedTrade = buildTrade({
      tradeId: "T-COLLAPSE",
      status: "LIVE",
      entryOrderId: "ENTRY-COLLAPSE",
      entryPrice: 100,
      slOrderId: "SL-COLLAPSE",
      stopLoss: 95,
      updatedAt: makeDate("2026-04-11T09:16:05.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: submitted,
      runtime: { ltp: 100.1 },
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: submitted,
      trade: filled,
      runtime: { ltp: 100.4 },
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: filled,
      trade: protectedTrade,
      runtime: { ltp: 100.8 },
    });
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 0);
    assert.ok(harness.calls.send[0].text.includes("Entry submitted"));
    assert.ok(harness.calls.send[0].text.includes("Entry filled"));
    assert.ok(harness.calls.send[0].text.includes("SL live"));
  } finally {
    harness.restore();
  }
}

async function testLiveTradeRefreshUpdatesOpenCard() {
  const harness = loadHarness();
  try {
    const live = buildTrade({
      tradeId: "T-LIVE-REFRESH",
      status: "LIVE",
      entryOrderId: "ENTRY-LIVE",
      entryPrice: 100,
      slOrderId: "SL-LIVE",
      stopLoss: 95,
      updatedAt: makeDate("2026-04-11T09:20:00.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: live,
      runtime: { ltp: 100, displayUpdatedAt: "2026-04-11T09:20:00.000Z" },
    });
    await harness.drain();
    ageTradeCardLedger(harness, "T-LIVE-REFRESH", 10_000);

    harness.alertService.setNotificationHeartbeatProvider(async () => ({
      activeTradeId: "T-LIVE-REFRESH",
      activeTrade: clone(live),
      activeTradeRuntime: {
        ltp: 101.8,
        displayUpdatedAt: "2026-04-11T09:20:10.000Z",
      },
      killSwitch: false,
    }));

    await harness.dispatcher.emitLiveTradeRefresh();
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);
    assert.ok(harness.calls.edit[0].text.includes("LTP 101.80"));
    assert.ok(harness.calls.edit[0].text.includes("Open +90.00"));
  } finally {
    harness.restore();
  }
}

async function testEditFailureFallsBackToFreshSend() {
  const harness = loadHarness({
    editImpl: async (messageId, text, options, count) => {
      if (count === 1) {
        const error = new Error("Bad Request: message to edit not found");
        error.status = 400;
        throw error;
      }
      return {
        ok: true,
        messageId,
        raw: { ok: true, text, options },
      };
    },
  });
  try {
    const filled = buildTrade({
      tradeId: "T-EDIT-FALLBACK",
      status: "ENTRY_FILLED",
      entryOrderId: "ENTRY-EDIT",
      entryPrice: 100,
      updatedAt: makeDate("2026-04-11T09:25:00.000Z"),
    });
    const slLive = buildTrade({
      tradeId: "T-EDIT-FALLBACK",
      status: "SL_PLACED",
      entryOrderId: "ENTRY-EDIT",
      entryPrice: 100,
      slOrderId: "SL-EDIT",
      stopLoss: 95,
      updatedAt: makeDate("2026-04-11T09:25:30.000Z"),
    });
    const targetLive = buildTrade({
      tradeId: "T-EDIT-FALLBACK",
      status: "LIVE",
      entryOrderId: "ENTRY-EDIT",
      entryPrice: 100,
      slOrderId: "SL-EDIT",
      stopLoss: 95,
      targetOrderId: "TARGET-EDIT",
      targetPrice: 108,
      updatedAt: makeDate("2026-04-11T09:26:00.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: filled,
      runtime: { ltp: 100.2 },
    });
    await harness.drain();

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: filled,
      trade: slLive,
      runtime: { ltp: 100.4 },
    });
    await harness.drain();

    assert.equal(harness.calls.send.length, 2);
    assert.equal(harness.calls.edit.length, 1);

    const ledger = getTradeCardLedger(harness, "T-EDIT-FALLBACK");
    assert.equal(ledger.telegram.messageId, 101);
    assert.equal(ledger.lastEditInvalidationReason, "telegram_edit_invalidated");

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: slLive,
      trade: targetLive,
      runtime: { ltp: 101.1 },
    });
    await harness.drain();

    assert.equal(harness.calls.edit.length, 2);
    assert.equal(harness.calls.edit[1].messageId, 101);
  } finally {
    harness.restore();
  }
}

async function testRestartRecoveryResumesLiveRefresh() {
  const harness = loadHarness();
  try {
    const live = buildTrade({
      tradeId: "T-RESTART-LIVE",
      status: "LIVE",
      entryOrderId: "ENTRY-RL",
      entryPrice: 100,
      slOrderId: "SL-RL",
      stopLoss: 96,
      updatedAt: makeDate("2026-04-11T09:30:00.000Z"),
    });

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: live,
      runtime: { ltp: 100.5, displayUpdatedAt: "2026-04-11T09:30:00.000Z" },
    });
    await harness.drain();

    harness.dispatcher.stopNotificationDispatcher();
    await harness.dispatcher.startNotificationDispatcher();
    ageTradeCardLedger(harness, "T-RESTART-LIVE", 10_000);

    harness.alertService.setNotificationHeartbeatProvider(async () => ({
      activeTradeId: "T-RESTART-LIVE",
      activeTrade: clone(live),
      activeTradeRuntime: {
        ltp: 102.2,
        displayUpdatedAt: "2026-04-11T09:30:15.000Z",
      },
      killSwitch: false,
    }));

    await harness.dispatcher.emitLiveTradeRefresh();
    await harness.drain();

    assert.equal(harness.calls.send.length, 1);
    assert.equal(harness.calls.edit.length, 1);
    assert.ok(harness.calls.edit[0].text.includes("LTP 102.20"));
  } finally {
    harness.restore();
  }
}

async function testHeartbeatEmitsAcrossIntervalsEvenWhenUnchanged() {
  const harness = loadHarness({
    envOverrides: {
      TELEGRAM_HEARTBEAT_ENABLED: "true",
      TELEGRAM_HEARTBEAT_SEC: 1,
    },
  });
  try {
    harness.alertService.setNotificationHeartbeatProvider(async () => ({
      engineMode: "LIVE",
      tradingEnabled: true,
      activeTradeId: "T-HB-2",
      activeTrade: buildTrade({
        tradeId: "T-HB-2",
        status: "LIVE",
        entryOrderId: "ENTRY-HB-2",
      }),
      activeTradeRuntime: { ltp: 100.5 },
      dailyRiskState: "RUNNING",
      tickerConnected: true,
      kiteLayer: { kiteSessionActive: true },
      killSwitch: false,
      faults: [],
    }));

    await harness.dispatcher.startNotificationDispatcher();
    const RealDate = Date;
    let fakeNow = new RealDate("2026-04-11T09:40:00.000Z").getTime();
    class FakeDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fakeNow]));
      }
      static now() {
        return fakeNow;
      }
      static parse(value) {
        return RealDate.parse(value);
      }
      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    }
    global.Date = FakeDate;
    try {
      await harness.dispatcher.emitHeartbeat();
      await harness.drain();
      assert.equal(harness.calls.send.length, 1);

      await harness.dispatcher.emitHeartbeat();
      await harness.drain();
      assert.equal(harness.calls.send.length, 1);

      fakeNow += 1100;
      await harness.dispatcher.emitHeartbeat();
      await harness.drain();
      assert.equal(harness.calls.send.length, 2);
    } finally {
      global.Date = RealDate;
    }
  } finally {
    harness.restore();
  }
}

async function testTerminalClassificationDistinguishesOutcomes() {
  const harness = loadHarness();
  try {
    const baseLive = buildTrade({
      tradeId: "T-TERM-CLASS-1",
      status: "LIVE",
      entryOrderId: "ENTRY-TC1",
      entryPrice: 100,
      slOrderId: "SL-TC1",
      stopLoss: 95,
      targetOrderId: "TARGET-TC1",
      targetPrice: 108,
    });

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: baseLive,
      runtime: { ltp: 101 },
    });
    await harness.drain();

    await harness.alertService.dispatchTradeUpdate({
      previousTrade: baseLive,
      trade: buildTrade({
        ...baseLive,
        status: "EXITED_TARGET",
        exitPrice: 108,
        exitReason: "TARGET_HIT",
        exitAuthority: "TARGET_ORDER",
        pnlGrossInr: 400,
        pnlNetAfterEstCostsInr: 360,
        updatedAt: makeDate("2026-04-11T09:35:00.000Z"),
      }),
    });

    const panicLive = buildTrade({
      tradeId: "T-TERM-CLASS-2",
      status: "LIVE",
      entryOrderId: "ENTRY-TC2",
      entryPrice: 100,
      slOrderId: "SL-TC2",
      stopLoss: 95,
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: panicLive,
      runtime: { ltp: 99.5 },
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: panicLive,
      trade: buildTrade({
        ...panicLive,
        status: "GUARD_FAILED",
        exitPrice: 94,
        exitReason: "PANIC_EXIT",
        exitAuthority: "PANIC_EXIT_ENGINE",
        closeReason: "PANIC_EXIT",
        pnlGrossInr: -300,
        pnlNetAfterEstCostsInr: -340,
        updatedAt: makeDate("2026-04-11T09:36:00.000Z"),
      }),
    });

    const timeStopLive = buildTrade({
      tradeId: "T-TERM-CLASS-3",
      status: "LIVE",
      entryOrderId: "ENTRY-TC3",
      entryPrice: 100,
      slOrderId: "SL-TC3",
      stopLoss: 95,
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: null,
      trade: timeStopLive,
      runtime: { ltp: 100.2 },
    });
    await harness.alertService.dispatchTradeUpdate({
      previousTrade: timeStopLive,
      trade: buildTrade({
        ...timeStopLive,
        status: "CLOSED",
        exitPrice: 100.8,
        exitReason: "TIME_STOP",
        exitAuthority: "TIME_STOP_ENGINE",
        closeReason: "TIME_STOP",
        pnlGrossInr: 40,
        pnlNetAfterEstCostsInr: 10,
        updatedAt: makeDate("2026-04-11T09:37:00.000Z"),
      }),
    });

    await harness.drain(6);

    const renderedTexts = [
      ...harness.calls.send.map((call) => call.text),
      ...harness.calls.edit.map((call) => call.text),
    ];
    assert.ok(renderedTexts.some((text) => text.includes("EXITED_TARGET")));
    assert.ok(renderedTexts.some((text) => text.includes("PANIC_EXIT_FILLED")));
    assert.ok(renderedTexts.some((text) => text.includes("TIME_STOP_EXIT")));
  } finally {
    harness.restore();
  }
}

async function main() {
  await testEntryPlacementRejectedImmediately();
  await testEntryAcceptedThenFilledWithoutDuplicateFillSpam();
  await testPartialFillThenFullFillUpdatesSameCard();
  await testProtectionOnlyAppearsAfterConfirmedPlacement();
  await testBeAndTrailOnlyNotifyOnMaterialStopChanges();
  await testAlcPendingAndConfirmedAreDistinct();
  await testTerminalSummaryReusesCardWithoutLegacySpam();
  await testRestartSafetySuppressesReplay();
  await testTelegramFailureRetriesFromOutbox();
  await testHeartbeatSkipsWhenClosedAndSendsWhenLive();
  await testCollapsedTransitionsStillPreserveMilestones();
  await testLiveTradeRefreshUpdatesOpenCard();
  await testEditFailureFallsBackToFreshSend();
  await testRestartRecoveryResumesLiveRefresh();
  await testHeartbeatEmitsAcrossIntervalsEvenWhenUnchanged();
  await testTerminalClassificationDistinguishesOutcomes();
  console.log("notificationPipeline.test.js passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
