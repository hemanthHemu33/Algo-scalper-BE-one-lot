const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");

const { env } = require("../../src/config");
const {
  createKiteConnect,
  kiteHttpTimeoutMs,
} = require("../../src/kite/kiteClients");

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = env[key];
    env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      env[key] = value;
    }
  }
}

async function testCreateKiteConnectAppliesConfiguredTimeoutAndKeepAlive() {
  await withEnv({ KITE_HTTP_TIMEOUT_MS: 16000 }, async () => {
    const kc = createKiteConnect({
      apiKey: "test_api_key",
      accessToken: "test_access_token",
    });

    assert.equal(kiteHttpTimeoutMs(), 16000);
    assert.equal(kc.timeout, 16000);
    assert.equal(kc.requestInstance.defaults.timeout, 16000);
    assert.ok(kc.requestInstance.defaults.httpAgent instanceof http.Agent);
    assert.ok(kc.requestInstance.defaults.httpsAgent instanceof https.Agent);
    assert.equal(kc.requestInstance.defaults.httpAgent.options.keepAlive, true);
    assert.equal(kc.requestInstance.defaults.httpsAgent.options.keepAlive, true);
    assert.equal(kc.access_token, "test_access_token");
  });
}

async function main() {
  await testCreateKiteConnectAppliesConfiguredTimeoutAndKeepAlive();
  console.log("kiteClients.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
