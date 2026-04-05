#!/usr/bin/env node
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
}

async function withLifecycleEnv(overrides, run) {
  const { env } = require('../src/config');
  const snapshot = {};
  for (const [k, v] of Object.entries(overrides)) {
    snapshot[k] = env[k];
    env[k] = v;
  }

  const events = [];
  const lifecycleNotify = require('../src/runtime/lifecycleNotify');
  const originalNotify = lifecycleNotify.notifyLifecycle;
  lifecycleNotify.notifyLifecycle = async (event, payload = {}) => {
    events.push({ event: String(event), payload });
    return { ok: true, skipped: false };
  };

  resetRequire('../src/runtime/engineLifecycle');
  const { createEngineLifecycle } = require('../src/runtime/engineLifecycle');

  try {
    return await run({ createEngineLifecycle, events });
  } finally {
    lifecycleNotify.notifyLifecycle = originalNotify;
    for (const [k, v] of Object.entries(snapshot)) env[k] = v;
    resetRequire('../src/runtime/engineLifecycle');
  }
}

async function testTokenRefreshLiveRestart() {
  const calls = [];
  await withLifecycleEnv(
    {
      ENGINE_LIFECYCLE_ENABLED: 'true',
      ENGINE_WARMUP_HHMM: '09:10',
      ENGINE_LIVE_HHMM: '09:15',
      ENGINE_CLOSE_HHMM: '15:30',
      ENGINE_TEST_NOW_ISO: '2026-01-05T10:00:00+05:30',
    },
    async ({ createEngineLifecycle, events }) => {
      let startCount = 0;
      const lifecycle = createEngineLifecycle({
        startSession: async (_token, reason) => {
          calls.push(['startSession', reason]);
          startCount += 1;
          return { ok: true, startCount };
        },
        stopSession: async (reason) => calls.push(['stopSession', reason]),
        setTradingEnabled: async (enabled, reason) => calls.push(['setTradingEnabled', enabled, reason]),
        getSessionStatus: async () => ({ tickerConnected: true, pipelineReady: true }),
      });

      await lifecycle.setToken('token-A');
      await lifecycle.setToken('token-B');
      await sleep(50);

      const mode = lifecycle.status().mode;
      lifecycle.stop();

      assert.equal(mode, 'LIVE', 'token refresh should converge back to LIVE');
      assert.ok(calls.some((c) => c[0] === 'setTradingEnabled' && c[1] === false && c[2] === 'token_refresh'));
      assert.ok(calls.some((c) => c[0] === 'stopSession' && c[1] === 'token_refresh'));
      assert.ok(calls.some((c) => c[0] === 'setTradingEnabled' && c[1] === true && c[2] === 'live'));
      assert.ok(events.some((e) => e.event === 'TOKEN_REFRESHED'));
      assert.ok(events.some((e) => e.event === 'LIVE_START' && e.payload?.reason === 'token_refresh'));
    },
  );
}

async function testLiveStartFailureFallsBackToIdle() {
  await withLifecycleEnv(
    {
      ENGINE_LIFECYCLE_ENABLED: 'true',
      ENGINE_WARMUP_HHMM: '09:10',
      ENGINE_LIVE_HHMM: '09:15',
      ENGINE_CLOSE_HHMM: '15:30',
      ENGINE_TEST_NOW_ISO: '2026-01-05T10:00:00+05:30',
    },
    async ({ createEngineLifecycle, events }) => {
      const lifecycle = createEngineLifecycle({
        startSession: async () => ({ ok: false }),
        stopSession: async () => {},
        setTradingEnabled: async () => {},
        getSessionStatus: async () => ({ tickerConnected: false, pipelineReady: false }),
      });

      await lifecycle.setToken('bad-token');
      await sleep(20);
      const mode = lifecycle.status().mode;
      lifecycle.stop();

      assert.equal(mode, 'IDLE', 'LIVE start failure must fallback to IDLE');
      assert.ok(events.some((e) => e.event === 'LIVE_START_FAILED'));
      assert.ok(events.some((e) => e.event === 'IDLE_ENTER' && e.payload?.reason === 'live_start_failed'));
    },
  );
}

async function testRestartInCloseWindowEntersCooldownAndPolls() {
  const calls = [];
  let polls = 0;

  await withLifecycleEnv(
    {
      ENGINE_LIFECYCLE_ENABLED: 'true',
      ENGINE_WARMUP_HHMM: '09:10',
      ENGINE_LIVE_HHMM: '09:15',
      ENGINE_CLOSE_HHMM: '09:16',
      ENGINE_IDLE_AFTER_MIN: 5,
      ENGINE_COOLDOWN_POLL_SEC: 1,
      ENGINE_REQUIRE_FLAT_BEFORE_IDLE: 'true',
      ENGINE_TEST_NOW_ISO: '2026-01-05T09:17:00+05:30',
    },
    async ({ createEngineLifecycle, events }) => {
      const lifecycle = createEngineLifecycle({
        startSession: async (_token, reason) => {
          calls.push(['startSession', reason]);
          return { ok: true };
        },
        stopSession: async (reason) => calls.push(['stopSession', reason]),
        setTradingEnabled: async (enabled, reason) => calls.push(['setTradingEnabled', enabled, reason]),
        getSessionStatus: async () => ({ tickerConnected: true, pipelineReady: true }),
        getOpenPositionsSummary: async () => {
          polls += 1;
          return { openCount: 2 };
        },
      });

      await lifecycle.setToken('token-close-window');
      await sleep(1150);
      const mode = lifecycle.status().mode;
      lifecycle.stop();

      assert.equal(mode, 'COOLDOWN', 'close-window restart should remain in COOLDOWN while positions open');
      assert.ok(calls.some((c) => c[0] === 'setTradingEnabled' && c[1] === false && c[2] === 'close'));
      assert.ok(!calls.some((c) => c[0] === 'stopSession' && c[1] === 'cooldown_to_idle'));
      assert.ok(polls >= 2, `expected flat-check polling loop to run at least twice, got ${polls}`);
      assert.ok(events.some((e) => e.event === 'CLOSE_START'));
    },
  );
}

async function testOpenCountMinusOneHoldsSession() {
  const calls = [];

  await withLifecycleEnv(
    {
      ENGINE_LIFECYCLE_ENABLED: 'true',
      ENGINE_WARMUP_HHMM: '09:10',
      ENGINE_LIVE_HHMM: '09:15',
      ENGINE_CLOSE_HHMM: '09:16',
      ENGINE_REQUIRE_FLAT_BEFORE_IDLE: 'true',
      ENGINE_TEST_NOW_ISO: '2026-01-05T09:17:00+05:30',
    },
    async ({ createEngineLifecycle, events }) => {
      const lifecycle = createEngineLifecycle({
        startSession: async () => ({ ok: true }),
        stopSession: async (reason) => calls.push(['stopSession', reason]),
        setTradingEnabled: async () => {},
        getSessionStatus: async () => ({ tickerConnected: true, pipelineReady: true }),
        getOpenPositionsSummary: async () => ({ openCount: -1, error: 'kite positions error', source: 'kite' }),
      });

      await lifecycle.setToken('token-open-minus-one');
      await sleep(50);
      const mode = lifecycle.status().mode;
      lifecycle.stop();

      assert.equal(mode, 'COOLDOWN', 'openCount=-1 must keep lifecycle in COOLDOWN');
      assert.ok(!calls.some((c) => c[0] === 'stopSession' && c[1] === 'cooldown_to_idle'));
      assert.ok(events.some((e) => e.event === 'FLAT_CHECK_ERROR_HOLDING'));
    },
  );
}

function testMarketGateAuthorityStaticGuard() {
  const source = fs.readFileSync(path.join(repoRoot, 'src/kite/tickerManager.js'), 'utf8');
  const openHandler = source.match(/marketGate\.on\("open",\s*\(\) => \{([\s\S]*?)\n\s*\}\);/);
  assert.ok(openHandler, 'could not locate marketGate open handler');
  const body = openHandler[1];

  const guardIdx = body.indexOf('if (_isLifecycleEnabled())');
  const setIdx = body.indexOf('setTradingEnabled(null)');
  assert.ok(guardIdx >= 0, 'lifecycle guard missing in market open handler');
  assert.ok(setIdx >= 0, 'setTradingEnabled(null) missing in market open handler');
  assert.ok(guardIdx < setIdx, 'lifecycle guard must execute before open-trading toggle');
  assert.ok(body.includes('return;'), 'lifecycle guard should short-circuit market open flow');
}

(async () => {
  const tests = [
    ['Token refresh LIVE restart path', testTokenRefreshLiveRestart],
    ['StartSession failure fallback to IDLE', testLiveStartFailureFallsBackToIdle],
    ['Close-window restart COOLDOWN polling', testRestartInCloseWindowEntersCooldownAndPolls],
    ['Positions API openCount=-1 hold', testOpenCountMinusOneHoldsSession],
    ['MarketGate authority guard during lifecycle', async () => testMarketGateAuthorityStaticGuard()],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (err) {
      console.error(`❌ ${name}`);
      console.error(err?.stack || err?.message || err);
      process.exitCode = 1;
      break;
    }
  }

  if (!process.exitCode) {
    console.log(`\nAll pending lifecycle validations passed (${passed}/${tests.length}).`);
  }
})();
