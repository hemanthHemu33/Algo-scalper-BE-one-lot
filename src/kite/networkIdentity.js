const https = require("node:https");
const os = require("node:os");
const { env } = require("../config");

const DEFAULT_IP_PROVIDERS = [
  "https://api.ipify.org",
  "https://icanhazip.com",
  "https://ifconfig.me/ip",
];

function getHostIdentity() {
  const appEnv = String(env.APP_ENV || env.NODE_ENV || "local").trim();
  const host = String(os.hostname() || "unknown-host").trim();
  return `${appEnv}:${host}`;
}

function parseExpectedIps(raw = env.EXPECTED_EGRESS_IPS) {
  return Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function requestText(url, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "user-agent": "algo-scalper-kite-network-identity/1.0",
        },
      },
      (res) => {
        if (!res || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP_${res?.statusCode || "UNKNOWN"}`));
          res?.resume?.();
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("IP_LOOKUP_TIMEOUT"));
    });
    req.on("error", reject);
  });
}

async function getPublicIp({
  providers = DEFAULT_IP_PROVIDERS,
  timeoutMs = 2500,
  retries = 2,
  fetchText = requestText,
} = {}) {
  const attempts = [];
  const providerList = Array.isArray(providers) ? providers : DEFAULT_IP_PROVIDERS;
  const retryCount = Math.max(1, Number(retries ?? 2));

  for (let round = 0; round < retryCount; round += 1) {
    for (const provider of providerList) {
      try {
        const raw = await fetchText(provider, { timeoutMs });
        const ip = String(raw || "").trim();
        if (!ip) {
          attempts.push({ provider, ok: false, error: "EMPTY_IP_RESPONSE" });
          continue;
        }
        return {
          ok: true,
          ip,
          provider,
          attempts,
          checkedAt: new Date().toISOString(),
        };
      } catch (err) {
        attempts.push({
          provider,
          ok: false,
          error: err?.message || String(err),
        });
      }
    }
  }

  return {
    ok: false,
    ip: null,
    provider: null,
    attempts,
    error: attempts[attempts.length - 1]?.error || "IP_LOOKUP_FAILED",
    checkedAt: new Date().toISOString(),
  };
}

async function verifyEgressIp({
  expectedIps = parseExpectedIps(),
  enforce = env.KITE_ENFORCE_STATIC_IP,
  allowWithoutStaticIp = env.KITE_ALLOW_LIVE_WITHOUT_STATIC_IP,
  getPublicIpResult,
  getPublicIpFn = getPublicIp,
} = {}) {
  const expected = Array.isArray(expectedIps)
    ? expectedIps.filter(Boolean)
    : parseExpectedIps(expectedIps);

  if (!expected.length) {
    return {
      ok: !enforce || allowWithoutStaticIp,
      publicIp: null,
      expectedIps: expected,
      reason: "NO_EXPECTED_EGRESS_IPS_CONFIGURED",
      checkedAt: new Date().toISOString(),
    };
  }

  const result = getPublicIpResult || (await getPublicIpFn());
  if (!result?.ok || !result?.ip) {
    return {
      ok: false,
      publicIp: result?.ip || null,
      expectedIps: expected,
      provider: result?.provider || null,
      reason: result?.error || "PUBLIC_IP_LOOKUP_FAILED",
      checkedAt: result?.checkedAt || new Date().toISOString(),
      attempts: result?.attempts || [],
    };
  }

  const publicIp = String(result.ip).trim();
  const matched = expected.includes(publicIp);

  return {
    ok: matched,
    publicIp,
    expectedIps: expected,
    provider: result.provider || null,
    matched,
    reason: matched ? "STATIC_IP_MATCH" : "STATIC_IP_MISMATCH",
    checkedAt: result.checkedAt || new Date().toISOString(),
    attempts: result.attempts || [],
  };
}

module.exports = {
  DEFAULT_IP_PROVIDERS,
  getHostIdentity,
  getPublicIp,
  parseExpectedIps,
  verifyEgressIp,
};
