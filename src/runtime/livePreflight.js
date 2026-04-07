const { env } = require("../config");
const { getDb } = require("../db");
const { getMarketStatusNow } = require("../market/marketCalendar");
const {
  parseExpectedIps,
  verifyEgressIp,
  getHostIdentity,
} = require("../kite/networkIdentity");
const {
  getSessionControlStatus,
  isTokenFromPreviousTradingDay,
} = require("../kite/sessionControl");

const NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;

const state = {
  context: {
    tokenDoc: null,
    tickerStatus: null,
    pipelineReady: null,
    rateLimiterSnapshot: null,
    brokerRateLimiterSnapshot: null,
    quoteDependenciesHealthy: null,
    requiredEnvPresence: null,
  },
  lastNetworkCheck: null,
  lastResult: {
    ok: false,
    blockingReasons: [],
    warnings: [],
    details: {},
    checkedAt: null,
    source: "init",
  },
};

function requestedByEnv() {
  return String(env.TRADING_ENABLED || "false").trim().toLowerCase() === "true";
}

function isStrictLiveMode() {
  const appEnv = String(env.APP_ENV || env.NODE_ENV || "local").trim().toLowerCase();
  const hosted = appEnv === "render-prod" || appEnv === "prod" || env.NODE_ENV === "production";
  return requestedByEnv() && hosted;
}

function updateLivePreflightContext(patch = {}) {
  if (!patch || typeof patch !== "object") return state.context;
  state.context = { ...state.context, ...patch };
  return state.context;
}

function buildRequiredEnvReport() {
  const checks = {
    MONGO_URI: Boolean(env.MONGO_URI),
    MONGO_DB: Boolean(env.MONGO_DB),
    KITE_API_KEY: Boolean(env.KITE_API_KEY),
    TOKENS_COLLECTION: Boolean(env.TOKENS_COLLECTION),
  };

  if (env.KITE_ENFORCE_STATIC_IP === true) {
    checks.EXPECTED_EGRESS_IPS = parseExpectedIps().length > 0;
  }

  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([key]) => key);

  return { checks, missing };
}

function coerceSnapshot(snapshot) {
  return snapshot && typeof snapshot === "object" ? snapshot : null;
}

async function resolveNetworkCheck({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    state.lastNetworkCheck &&
    now - Number(new Date(state.lastNetworkCheck.checkedAt || 0).getTime()) <
      NETWORK_CACHE_TTL_MS
  ) {
    return state.lastNetworkCheck;
  }

  const result = await verifyEgressIp({
    expectedIps: parseExpectedIps(),
  });
  state.lastNetworkCheck = result;
  return result;
}

async function refreshLivePreflight({
  source = "manual",
  contextPatch = {},
  requireRuntimeReady = false,
  forceNetworkRefresh = false,
} = {}) {
  updateLivePreflightContext(contextPatch);

  const blockingReasons = [];
  const warnings = [];
  const strictLive = isStrictLiveMode();
  const requested = requestedByEnv();
  const sessionStatus = getSessionControlStatus();
  const tokenDoc = state.context.tokenDoc || null;
  const network = await resolveNetworkCheck({ force: forceNetworkRefresh });
  const market = getMarketStatusNow();
  const envReport =
    state.context.requiredEnvPresence || buildRequiredEnvReport();

  let dbConnected = false;
  try {
    dbConnected = !!getDb();
  } catch {
    dbConnected = false;
  }

  if (!dbConnected) {
    blockingReasons.push("DB_NOT_CONNECTED");
  }

  if (envReport.missing.length) {
    blockingReasons.push(...envReport.missing.map((key) => `MISSING_ENV_${key}`));
  }

  const allowedUser = String(env.KITE_ALLOWED_USER_ID || "").trim();
  const tokenUser = String(tokenDoc?.user_id || tokenDoc?.userId || "").trim();
  if (allowedUser && tokenUser && tokenUser !== allowedUser) {
    blockingReasons.push("KITE_ALLOWED_USER_ID_MISMATCH");
  }

  if (strictLive && env.KITE_ENFORCE_STATIC_IP === true) {
    if (!network.ok) {
      if (network.reason === "NO_EXPECTED_EGRESS_IPS_CONFIGURED") {
        if (env.KITE_ALLOW_LIVE_WITHOUT_STATIC_IP === true) {
          warnings.push(network.reason);
        } else {
          blockingReasons.push(network.reason);
        }
      } else {
        blockingReasons.push(network.reason || "STATIC_IP_CHECK_FAILED");
      }
    }
  } else if (!network.ok && network.reason) {
    warnings.push(network.reason);
  }

  if (strictLive) {
    if (!sessionStatus.active) {
      blockingReasons.push("KITE_SESSION_INACTIVE");
    }
    if (
      env.KITE_BLOCK_PREV_DAY_TOKEN === true &&
      tokenDoc &&
      isTokenFromPreviousTradingDay(tokenDoc)
    ) {
      blockingReasons.push("PREVIOUS_TRADING_DAY_TOKEN");
    }
  } else if (
    tokenDoc &&
    env.KITE_BLOCK_PREV_DAY_TOKEN === true &&
    isTokenFromPreviousTradingDay(tokenDoc)
  ) {
    warnings.push("PREVIOUS_TRADING_DAY_TOKEN");
  }

  const tickerStatus = state.context.tickerStatus || null;
  if (requireRuntimeReady && strictLive) {
    if (!tickerStatus?.hasSession && !sessionStatus.active) {
      blockingReasons.push("KITE_CLIENT_NOT_READY");
    }
    if (tickerStatus && tickerStatus.connected === false) {
      blockingReasons.push("TICKER_NOT_CONNECTED");
    }
    if (state.context.quoteDependenciesHealthy === false) {
      blockingReasons.push("QUOTE_DEPENDENCIES_UNHEALTHY");
    }
  } else {
    if (tickerStatus && tickerStatus.connected === false) {
      warnings.push("TICKER_NOT_CONNECTED");
    }
    if (state.context.quoteDependenciesHealthy === false) {
      warnings.push("QUOTE_DEPENDENCIES_UNHEALTHY");
    }
  }

  const rateLimiterSnapshot = coerceSnapshot(state.context.rateLimiterSnapshot);
  const brokerRateLimiterSnapshot = coerceSnapshot(
    state.context.brokerRateLimiterSnapshot,
  );
  const rateLimiterConfigured =
    Number(env.MAX_ORDERS_PER_SEC ?? 0) > 0 &&
    Number(env.MAX_ORDERS_PER_MIN ?? 0) > 0 &&
    Number(env.MAX_ORDERS_PER_DAY ?? 0) > 0;
  if (!rateLimiterSnapshot?.limits && (requireRuntimeReady || state.context.pipelineReady)) {
    blockingReasons.push("ORDER_RATE_LIMITER_NOT_INITIALIZED");
  } else if (!rateLimiterSnapshot?.limits && !rateLimiterConfigured) {
    blockingReasons.push("ORDER_RATE_LIMITER_CONFIG_INVALID");
  }

  if (!market?.ok) {
    warnings.push("MARKET_CALENDAR_UNAVAILABLE");
  }

  const uniqueBlockingReasons = Array.from(new Set(blockingReasons));
  const uniqueWarnings = Array.from(
    new Set(uniqueBlockingReasons.includes("TICKER_NOT_CONNECTED")
      ? warnings.filter((item) => item !== "TICKER_NOT_CONNECTED")
      : warnings),
  );

  const gatePassed = strictLive ? uniqueBlockingReasons.length === 0 : true;
  const result = {
    ok: gatePassed,
    requestedByEnv: requested,
    strictLiveMode: strictLive,
    effectiveLiveEnabled: requested && gatePassed,
    blockingReasons: uniqueBlockingReasons,
    warnings: uniqueWarnings,
    checkedAt: new Date().toISOString(),
    source,
    details: {
      dbConnected,
      hostIdentity: getHostIdentity(),
      environment: String(env.APP_ENV || env.NODE_ENV || "local"),
      requiredEnv: envReport,
      publicIp: network.publicIp || null,
      staticIpCheck: {
        passed: !!network.ok,
        reason: network.reason || null,
        expectedIps: network.expectedIps || parseExpectedIps(),
        checkedAt: network.checkedAt || null,
        provider: network.provider || null,
      },
      session: {
        ...sessionStatus,
        userId: tokenUser || null,
        allowedUserId: allowedUser || null,
      },
      market,
      ticker: tickerStatus,
      pipelineReady: state.context.pipelineReady,
      rateLimiter: rateLimiterSnapshot,
      brokerRateLimiter: brokerRateLimiterSnapshot,
      quoteDependenciesHealthy:
        state.context.quoteDependenciesHealthy !== false,
    },
  };

  state.lastResult = result;
  return result;
}

function getLivePreflightStatus() {
  return state.lastResult;
}

function getEffectiveLiveEnabled() {
  return Boolean(state.lastResult?.effectiveLiveEnabled);
}

module.exports = {
  getEffectiveLiveEnabled,
  getLivePreflightStatus,
  isStrictLiveMode,
  refreshLivePreflight,
  requestedByEnv,
  updateLivePreflightContext,
};
