const http = require("node:http");
const https = require("node:https");
const KiteConnect = require("kiteconnect").KiteConnect;
const KiteTicker = require("kiteconnect").KiteTicker;
const { env } = require("../config");
const { logger } = require("../logger");
const { halt } = require("../runtime/halt");
const { reportFault } = require("../runtime/errorBus");

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

let sharedHttpAgent = null;
let sharedHttpsAgent = null;

function kiteHttpTimeoutMs() {
  const ms = Number(env.KITE_HTTP_TIMEOUT_MS);
  return Number.isFinite(ms) && ms >= 1000 ? Math.floor(ms) : 15000;
}

function getSharedAgents() {
  if (!sharedHttpAgent) {
    sharedHttpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 16,
    });
  }
  if (!sharedHttpsAgent) {
    sharedHttpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 16,
    });
  }
  return {
    httpAgent: sharedHttpAgent,
    httpsAgent: sharedHttpsAgent,
  };
}

function applyTransportTuning(kc) {
  const timeout = kiteHttpTimeoutMs();
  kc.timeout = timeout;

  if (!kc?.requestInstance?.defaults) return kc;

  kc.requestInstance.defaults.timeout = timeout;
  Object.assign(kc.requestInstance.defaults, getSharedAgents());
  return kc;
}

function isAuthError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("Incorrect `api_key` or `access_token`") ||
    msg.includes("TokenException") ||
    msg.includes("SessionExpired") ||
    (msg.includes("invalid token")) ||
    (msg.includes("access_token") && msg.includes("expired"))
  );
}

function isRetryableKiteError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("ECONNABORTED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EAI_AGAIN") ||
    msg.includes("socket hang up") ||
    msg.includes("No response from server") ||
    msg.includes("Gateway Timeout") ||
    msg.includes("Too many requests") ||
    msg.includes("429") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

async function withRetry(fn, { name, attempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isAuthError(e)) {
        await halt("KITE_AUTH_ERROR", { name, message: e.message });
        throw e;
      }
      if (!isRetryableKiteError(e)) {
        throw e;
      }
      if (i === attempts - 1) break;
      const jitter = Math.floor(Math.random() * 100);
      const wait = baseDelayMs * Math.pow(2, i) + jitter;
      logger.warn(
        {
          name,
          attempt: i + 1,
          wait,
          timeoutMs: kiteHttpTimeoutMs(),
          e: e.message,
        },
        "[kite] call failed; retrying",
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

function singleFlight(kc, methodName, impl) {
  const inFlight = new Map();
  kc[methodName] = (...args) => {
    const key = JSON.stringify(args || []);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = Promise.resolve()
      .then(() => impl(...args))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  };
}

function wrapKiteConnect(kc) {
  // Wrap high-value methods
  const methods = [
    // NOTE: placeOrder is intentionally NOT retried here (duplicate-order risk).
    // Use TradeManager._safePlaceOrder for controlled retries / de-dup.
    "placeOrder",
    "cancelOrder",
    "modifyOrder",
    "getOrders",
    "getOrderHistory",
    "getPositions",
    "getMargins",
    "getHoldings",
    "getInstruments",
    "getLTP",
    "getQuote",
  ];

  for (const m of methods) {
    if (typeof kc[m] !== "function") continue;
    const orig = kc[m].bind(kc);

    // placeOrder: single attempt only (no retry)
    if (m === "placeOrder") {
      kc[m] = (...args) => withRetry(() => orig(...args), { name: m, attempts: 1 });
      continue;
    }

    const call = (...args) => withRetry(() => orig(...args), { name: m });
    if (m === "getOrders" || m === "getPositions" || m === "getMargins") {
      singleFlight(kc, m, call);
      continue;
    }
    kc[m] = call;
  }

  return kc;
}

function createKiteConnect({ apiKey, accessToken }) {
  const kc = new KiteConnect({
    api_key: apiKey,
    timeout: kiteHttpTimeoutMs(),
  });
  kc.setAccessToken(accessToken);
  applyTransportTuning(kc);
  return wrapKiteConnect(kc);
}

function createTicker({ apiKey, accessToken }) {
  const t = new KiteTicker({ api_key: apiKey, access_token: accessToken });
  try {
    // enable auto-reconnect (delay=5s, retries=50)
    t.autoReconnect(true, 5, 50);
  } catch (err) { reportFault({ code: "KITE_KITECLIENTS_CATCH", err, message: "[src/kite/kiteClients.js] caught and continued" }); }
  return t;
}

module.exports = {
  createKiteConnect,
  createTicker,
  kiteHttpTimeoutMs,
};
