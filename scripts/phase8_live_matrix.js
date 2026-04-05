#!/usr/bin/env node
/*
 * Phase 8 live scenario matrix runner (A-E)
 *
 * Purpose:
 * - Execute a deterministic, repeatable live-stack validation against a running engine
 * - Verify Mongo-backed API surface + Kite session/ticker critical paths end-to-end
 *
 * Usage:
 *   ADMIN_API_KEY=... node scripts/phase8_live_matrix.js
 *   MATRIX_BASE_URL=http://localhost:4001 ADMIN_API_KEY=... npm run test:phase8:live
 */

const http = require('http');
const https = require('https');

const baseUrl = String(process.env.MATRIX_BASE_URL || 'http://127.0.0.1:4001').replace(/\/$/, '');
const apiKey = process.env.ADMIN_API_KEY || '';
const timeoutMs = Number(process.env.MATRIX_TIMEOUT_MS || 10_000);

function parseBase(url) {
  const u = new URL(url);
  return {
    protocol: u.protocol,
    host: u.hostname,
    port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    basePath: u.pathname === '/' ? '' : u.pathname,
  };
}

const target = parseBase(baseUrl);
const transport = target.protocol === 'https:' ? https : http;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      accept: 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    };

    const request = transport.request(
      {
        method,
        host: target.host,
        port: target.port,
        path: `${target.basePath}${path}`,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { parseError: true, raw };
          }
          resolve({ status: res.statusCode || 0, body: json, raw });
        });
      }
    );

    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);

    if (payload) request.write(payload);
    request.end();
  });
}

function expect(cond, msg, meta = null) {
  if (!cond) {
    const err = new Error(msg);
    err.meta = meta;
    throw err;
  }
}

async function scenarioA() {
  const health = await req('GET', '/health');
  expect(health.status === 200 && health.body?.ok === true, 'health endpoint failed', health);

  const ready = await req('GET', '/ready');
  expect([200, 503].includes(ready.status), 'ready endpoint unreachable', ready);

  const status = await req('GET', '/admin/status');
  expect(status.status === 200 && status.body?.ok === true, 'admin/status failed', status);
  expect(status.body?.ticker != null, 'admin/status missing ticker block', status.body);

  return {
    health: health.body,
    ready: { status: ready.status, ok: ready.body?.ok ?? false },
    tokenPresent: !!status.body?.tokenPresent,
    tickerConnected: !!status.body?.tickerConnected,
  };
}

async function scenarioB() {
  const before = await req('GET', '/admin/trading');
  expect(before.status === 200 && before.body?.ok === true, 'admin/trading read failed', before);

  const current = !!before.body?.tradingEnabled;
  const toggled = !current;

  const setToggled = await req('POST', '/admin/trading', { enabled: toggled });
  expect(setToggled.status === 200 && setToggled.body?.ok === true, 'failed to toggle trading', setToggled);

  await sleep(200);
  const verifyToggled = await req('GET', '/admin/trading');
  expect(verifyToggled.body?.tradingEnabled === toggled, 'trading toggle did not persist', verifyToggled);

  const restore = await req('POST', '/admin/trading', { enabled: current });
  expect(restore.status === 200 && restore.body?.ok === true, 'failed to restore trading state', restore);

  return { initial: current, toggled, restored: current };
}

async function scenarioC() {
  const critical = await req('GET', '/admin/health/critical');
  expect([200, 503].includes(critical.status), 'critical health endpoint unreachable', critical);
  expect(Array.isArray(critical.body?.checks), 'critical health checks missing', critical.body);

  const failedChecks = critical.body.checks.filter((c) => c && c.ok === false).map((c) => c.code);
  return { status: critical.status, ok: !!critical.body?.ok, failedChecks };
}

async function scenarioD() {
  const marketHealth = await req('GET', '/admin/market/health');
  expect(marketHealth.status === 200 && marketHealth.body?.ok === true, 'market health endpoint failed', marketHealth);

  const account = await req('GET', '/admin/account/equity');
  expect([200, 503].includes(account.status), 'account equity endpoint unreachable', account);

  return {
    marketOk: !!marketHealth.body?.ok,
    equityStatus: account.status,
    equityOk: !!account.body?.ok,
  };
}

async function scenarioE() {
  const kill = await req('POST', '/admin/kill', {});
  expect(kill.status === 200 && kill.body?.ok === true, 'kill switch endpoint failed', kill);

  const readyAfterKill = await req('GET', '/ready');
  expect(readyAfterKill.status === 503, 'ready should be 503 when halted', readyAfterKill);

  const reset = await req('POST', '/admin/halt/reset', {});
  expect(reset.status === 200 && reset.body?.ok === true, 'halt reset failed', reset);

  await sleep(300);
  const statusAfterReset = await req('GET', '/admin/status');
  expect(statusAfterReset.status === 200 && statusAfterReset.body?.ok === true, 'status failed after reset', statusAfterReset);

  return {
    killApplied: true,
    readyAfterKill: readyAfterKill.status,
    haltedAfterReset: !!statusAfterReset.body?.halted,
    needsLoginAfterReset: !!statusAfterReset.body?.needsLogin,
  };
}

const scenarios = [
  ['A', 'stack reachability + core status', scenarioA],
  ['B', 'trading control toggle + restore', scenarioB],
  ['C', 'critical health gate matrix', scenarioC],
  ['D', 'market/account observability', scenarioD],
  ['E', 'halt lifecycle (kill -> reset)', scenarioE],
];

(async () => {
  const results = [];
  let passed = 0;

  console.log(`Phase 8 live matrix target: ${baseUrl}`);
  for (const [code, name, fn] of scenarios) {
    try {
      const detail = await fn();
      passed += 1;
      results.push({ code, name, ok: true, detail });
      console.log(`✅ [${code}] ${name}`);
    } catch (err) {
      results.push({
        code,
        name,
        ok: false,
        error: err?.message || String(err),
        meta: err?.meta || null,
      });
      console.log(`❌ [${code}] ${name}`);
      console.log(`   ↳ ${err?.message || err}`);
    }
  }

  const summary = {
    ok: passed === scenarios.length,
    passed,
    total: scenarios.length,
    target: baseUrl,
    ts: new Date().toISOString(),
    results,
  };

  console.log('\n' + JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 2);
})();
