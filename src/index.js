const { env } = require("./config");
const { logger } = require("./logger");
const {
  alert,
  startAlertService,
  setNotificationHeartbeatProvider,
} = require("./alerts/alertService");
const { halt } = require("./runtime/halt");
const { upsertDailyRisk } = require("./trading/tradeStore");
const { DateTime } = require("luxon");
const dns = require("node:dns/promises");
const { connectMongo } = require("./db");
const { ensureRetentionIndexes } = require("./market/retention");
const { buildApp } = require("./app");
const { watchLatestToken } = require("./tokenWatcher");
const { getPublicIp, parseExpectedIps } = require("./kite/networkIdentity");
const {
  startSessionControl,
  stopSessionControl,
  trackSession,
  clearTrackedSession,
} = require("./kite/sessionControl");
const {
  setSession,
  stopSession: stopKiteSession,
  getTickerStatus,
  getPipeline,
  getKiteClient,
} = require("./kite/tickerManager");
const {
  refreshLivePreflight,
  updateLivePreflightContext,
} = require("./runtime/livePreflight");
const { telemetry } = require("./telemetry/signalTelemetry");
const { tradeTelemetry } = require("./telemetry/tradeTelemetry");
const { optimizer } = require("./optimizer/adaptiveOptimizer");
const http = require("http");
const { attachSocketServer } = require("./socket/socketServer");
const { reportFault } = require("./runtime/errorBus");
const { setTradingEnabled } = require("./runtime/tradingEnabled");
const { createEngineLifecycle } = require("./runtime/engineLifecycle");
const {
  assertEnabledStrategyAdmissionProfiles,
} = require("./strategy/registry");

function applyWindowsSrvDnsWorkaround() {
  // Workaround for Node.js Windows SRV DNS regressions that can manifest as:
  //   querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net
  // Only apply when using mongodb+srv URIs.
  try {
    if (process.platform !== "win32") return;
    const uri = String(env.MONGO_URI || "");
    if (!uri.startsWith("mongodb+srv://")) return;

    const enabled =
      String(process.env.DNS_SRV_WORKAROUND || "true") !== "false";
    if (!enabled) return;

    const servers = String(process.env.DNS_SERVERS || "1.1.1.1,8.8.8.8")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // dns.setServers() is synchronous (even under dns/promises)
    dns.setServers(servers);
    logger.warn(
      { servers },
      "[dns] SRV workaround enabled (custom DNS servers set)",
    );
  } catch (e) {
    logger.warn(
      { err: { message: e?.message, name: e?.name } },
      "[dns] SRV workaround failed to apply (continuing)",
    );
  }
}

function describeErr(e) {
  if (!e) return { name: "UnknownError", message: "(no error)", stack: "" };
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  // non-Error throws (string/object/etc.)
  return {
    name: typeof e,
    message: typeof e === "string" ? e : JSON.stringify(e),
    stack: "",
  };
}

function detectIpFamily(ip) {
  const value = String(ip || "").trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return "IPv4";
  if (value.includes(":")) return "IPv6";
  return "unknown";
}

const IPV4_PUBLIC_IP_PROVIDERS = ["https://api.ipify.org"];
const IPV6_PUBLIC_IP_PROVIDERS = ["https://api6.ipify.org"];

async function resolvePublicIpForFamily(family) {
  const providers =
    family === "IPv6" ? IPV6_PUBLIC_IP_PROVIDERS : IPV4_PUBLIC_IP_PROVIDERS;

  try {
    const result = await getPublicIp({
      providers,
      retries: 1,
      timeoutMs: 2500,
    });
    const ip = result?.ip || null;
    const detectedFamily = detectIpFamily(ip);
    if (result?.ok && ip && detectedFamily === family) {
      return {
        ok: true,
        ip,
        family,
        provider: result.provider || null,
        checkedAt: result.checkedAt || new Date().toISOString(),
        attempts: result.attempts || [],
      };
    }
    return {
      ok: false,
      ip: null,
      family,
      provider: result?.provider || null,
      checkedAt: result?.checkedAt || new Date().toISOString(),
      attempts: result?.attempts || [],
      error:
        result?.error ||
        (ip ? `UNEXPECTED_${detectedFamily || "UNKNOWN"}_RESPONSE` : "IP_LOOKUP_FAILED"),
    };
  } catch (err) {
    return {
      ok: false,
      ip: null,
      family,
      provider: null,
      checkedAt: new Date().toISOString(),
      attempts: [],
      error: err?.message || String(err),
    };
  }
}

function todayKey() {
  return DateTime.now()
    .setZone(env.CANDLE_TZ || "Asia/Kolkata")
    .toFormat("yyyy-LL-dd");
}

async function logStartupEgressIpObservability() {
  const expectedEgressIps = parseExpectedIps(env.EXPECTED_EGRESS_IPS || "");
  const expectedConfigured = expectedEgressIps.length > 0;

  try {
    const [ipv4Info, ipv6Info] = await Promise.all([
      resolvePublicIpForFamily("IPv4"),
      resolvePublicIpForFamily("IPv6"),
    ]);
    const publicIpv4 = ipv4Info?.ok ? ipv4Info.ip : null;
    const publicIpv6 = ipv6Info?.ok ? ipv6Info.ip : null;
    const publicIp = publicIpv4 || publicIpv6 || null;
    const provider =
      ipv4Info?.ok ? ipv4Info.provider : ipv6Info?.ok ? ipv6Info.provider : null;
    const ipFamily = detectIpFamily(publicIp);
    const checkedAt =
      ipv6Info?.checkedAt || ipv4Info?.checkedAt || new Date().toISOString();
    const resolvedPublicIps = [publicIpv4, publicIpv6].filter(Boolean);

    if (!publicIp) {
      logger.warn(
        {
          err: [ipv4Info?.error, ipv6Info?.error].filter(Boolean).join("; "),
          checkedAt,
          ipv4Provider: ipv4Info?.provider || null,
          ipv6Provider: ipv6Info?.provider || null,
        },
        "[network] unable to resolve public egress IP",
      );
      console.log("KITE_WHITELIST_IP=UNKNOWN");
      console.log("KITE_WHITELIST_IP_FAMILY=unknown");
      console.log("KITE_WHITELIST_IPV4=UNKNOWN");
      console.log("KITE_WHITELIST_IPV6=UNKNOWN");
      if (expectedConfigured) {
        console.log(`KITE_EXPECTED_EGRESS_IPS=${expectedEgressIps.join(",")}`);
        console.log("KITE_WHITELIST_STATUS=MISMATCH");
        console.warn(
          `KITE_WHITELIST_MISMATCH actual_v4=UNKNOWN actual_v6=UNKNOWN expected=${expectedEgressIps.join(",")}`,
        );
      } else {
        console.log("KITE_WHITELIST_STATUS=NOT_CONFIGURED");
      }
      return;
    }

    let matchStatus = "not_configured";
    let isMatch = false;
    let matchedPublicIp = null;

    if (expectedConfigured) {
      matchedPublicIp =
        resolvedPublicIps.find((ip) => expectedEgressIps.includes(ip)) || null;
      isMatch = Boolean(matchedPublicIp);
      matchStatus = isMatch ? "match" : "mismatch";
    }

    logger.info(
      {
        publicIp,
        publicIpv4,
        publicIpv6,
        ipFamily,
        provider,
        ipv4Provider: ipv4Info?.provider || null,
        ipv6Provider: ipv6Info?.provider || null,
        checkedAt,
        expectedEgressIps,
        expectedConfigured,
        matchStatus,
      },
      "[network] public egress IP for Kite whitelist",
    );

    console.log(`KITE_WHITELIST_IP=${publicIp}`);
    console.log(`KITE_WHITELIST_IP_FAMILY=${ipFamily}`);
    console.log(`KITE_WHITELIST_IPV4=${publicIpv4 || "UNKNOWN"}`);
    console.log(`KITE_WHITELIST_IPV6=${publicIpv6 || "UNKNOWN"}`);
    if (expectedConfigured) {
      console.log(`KITE_EXPECTED_EGRESS_IPS=${expectedEgressIps.join(",")}`);
      console.log(`KITE_WHITELIST_STATUS=${isMatch ? "MATCH" : "MISMATCH"}`);
    } else {
      console.log("KITE_WHITELIST_STATUS=NOT_CONFIGURED");
      logger.info(
        {
          publicIp,
          publicIpv4,
          publicIpv6,
          ipFamily,
          provider,
          ipv4Provider: ipv4Info?.provider || null,
          ipv6Provider: ipv6Info?.provider || null,
          checkedAt,
        },
        "[network] public egress IP comparison skipped (no expected IPs configured)",
      );
    }

    if (expectedConfigured && !isMatch) {
      logger.warn(
        {
          resolvedPublicIp: publicIp,
          resolvedPublicIpv4: publicIpv4,
          resolvedPublicIpv6: publicIpv6,
          resolvedIpFamily: ipFamily,
          expectedEgressIps,
          checkedAt,
        },
        "[network] public egress IP does not match configured expected IPs",
      );
      console.warn(
        `KITE_WHITELIST_MISMATCH actual_v4=${publicIpv4 || "UNKNOWN"} actual_v6=${publicIpv6 || "UNKNOWN"} expected=${expectedEgressIps.join(",")}`,
      );
    } else if (expectedConfigured) {
      logger.info(
        {
          resolvedPublicIp: matchedPublicIp || publicIp,
          resolvedPublicIpv4: publicIpv4,
          resolvedPublicIpv6: publicIpv6,
          resolvedIpFamily: matchedPublicIp
            ? detectIpFamily(matchedPublicIp)
            : ipFamily,
          expectedEgressIps,
          checkedAt,
        },
        "[network] public egress IP matches configured expected IPs",
      );
    }
  } catch (err) {
    logger.warn(
      { err: err?.message || String(err) },
      "[network] unable to resolve public egress IP",
    );
    console.log("KITE_WHITELIST_IP=UNKNOWN");
    console.log("KITE_WHITELIST_IP_FAMILY=unknown");
    console.log("KITE_WHITELIST_IPV4=UNKNOWN");
    console.log("KITE_WHITELIST_IPV6=UNKNOWN");
    if (expectedConfigured) {
      console.log(`KITE_EXPECTED_EGRESS_IPS=${expectedEgressIps.join(",")}`);
      console.log("KITE_WHITELIST_STATUS=MISMATCH");
      console.warn(
        `KITE_WHITELIST_MISMATCH actual_v4=UNKNOWN actual_v6=UNKNOWN expected=${expectedEgressIps.join(",")}`,
      );
    } else {
      console.log("KITE_WHITELIST_STATUS=NOT_CONFIGURED");
    }
  }
}

async function evaluateLiveStartupPreflight({
  source,
  tokenDoc,
  tickerStatus = null,
  pipelineReady = false,
} = {}) {
  updateLivePreflightContext({
    tokenDoc: tokenDoc || null,
    tickerStatus,
    pipelineReady,
  });
  return refreshLivePreflight({
    source: source || "startup",
    requireRuntimeReady: false,
    forceNetworkRefresh: true,
  });
}

async function persistKill(reason, meta) {
  try {
    await upsertDailyRisk(todayKey(), {
      kill: true,
      reason: String(reason || "RUNTIME_FATAL"),
      meta: meta || null,
      updatedAt: new Date(),
    });
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
}

function exitAfterCrash(delayMs = 750) {
  setTimeout(() => process.exit(1), delayMs).unref();
}

async function main() {
  assertEnabledStrategyAdmissionProfiles();
  // Apply SRV DNS workaround early (before Mongo connects)
  applyWindowsSrvDnsWorkaround();
  await connectMongo();
  await logStartupEgressIpObservability();
  await startAlertService();
  // PATCH-9: Ensure candle retention TTL indexes (prevents MongoDB growth)
  try {
    if (String(env.RETENTION_ENSURE_ON_START || "true") === "true") {
      await ensureRetentionIndexes({
        log: String(env.CANDLE_TTL_LOG || "true") === "true",
      });
    }
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

  telemetry.start();
  tradeTelemetry.start();
  // Adaptive optimizer (auto-block weak strategy×symbol×bucket + dynamic RR)
  try {
    await optimizer.start();
  } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }

  const lifecycleEnabled =
    String(env.ENGINE_LIFECYCLE_ENABLED || "false") === "true";
  const engineLifecycle = lifecycleEnabled
    ? createEngineLifecycle({
        startSession: async (accessToken, reason) => {
          await setSession(accessToken);
          return { ok: true, reason };
        },
        stopSession: async (reason) => stopKiteSession(reason),
        setTradingEnabled: async (enabled, reason) => ({
          ...setTradingEnabled(enabled),
          reason,
        }),
        getSessionStatus: async () => {
          const ticker = getTickerStatus();
          let pipelineReady = false;
          try {
            pipelineReady = !!getPipeline();
          } catch {
            pipelineReady = false;
          }
          return {
            tickerConnected: !!ticker?.connected,
            pipelineReady,
          };
        },
        getOpenPositionsSummary: async () => {
          const kite = getKiteClient();
          if (!kite || typeof kite.getPositions !== "function") {
            return {
              openCount: -1,
              source: "ticker_manager",
              error: "kite_unavailable",
            };
          }

          try {
            const positions = await kite.getPositions();
            const net = Array.isArray(positions?.net || positions?.day)
              ? positions?.net || positions?.day
              : [];
            const openCount = net.filter((p) => {
              const qty = Number(p?.quantity ?? p?.net_quantity ?? 0);
              return Number.isFinite(qty) && qty !== 0;
            }).length;
            return { openCount, source: "kite" };
          } catch (err) {
            return {
              openCount: -1,
              source: "kite",
              error: err?.message || String(err),
            };
          }
        },
      })
    : null;

  startSessionControl({
    onSessionInvalidated: async ({ reason, doc }) => {
      clearTrackedSession(reason);
      try {
        await stopKiteSession(reason);
      } catch (err) {
        logger.warn(
          { reason, err: err?.message || String(err) },
          "[kite-session] stopSession failed after invalidation",
        );
      }
      logger.warn(
        {
          reason,
          updatedAt: doc?.updatedAt || doc?.createdAt || null,
        },
        "[kite-session] live trading disabled after session invalidation",
      );
    },
  });

  await watchLatestToken({
    onToken: async (accessToken, doc, reason) => {
      const updatedAt = doc?.updatedAt || doc?.createdAt || null;

      // If token is missing/invalid, do not crash; keep server alive and keep polling.
      if (!accessToken) {
        logger.error(
          { reason, updatedAt },
          "[tokenWatcher] kite access token missing (engine will stay up and keep polling)",
        );
        alert("error", "🔐 Kite access token missing — please login to Kite", {
          reason,
          hint: "Login via your token generator/scanner app or insert/update a doc with access_token in TOKENS_COLLECTION",
        }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
        await halt("KITE_TOKEN_MISSING", { reason, updatedAt });
        return;
      }

      logger.info({ reason, updatedAt }, "[token] loaded/updated");
      alert("info", "🔑 Kite token loaded/updated", {
        reason,
        updatedAt,
      }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });

      trackSession({ accessToken, doc, source: reason });
      const startupPreflight = await evaluateLiveStartupPreflight({
        source: `token_${reason}`,
        tokenDoc: doc,
        tickerStatus: getTickerStatus?.() || null,
        pipelineReady: false,
      });
      if (startupPreflight?.requestedByEnv && startupPreflight?.ok === false) {
        try {
          await stopKiteSession("LIVE_PREFLIGHT_FAILED");
        } catch (err) {
          logger.warn(
            {
              reason,
              updatedAt,
              err: err?.message || String(err),
            },
            "[kite] stopSession failed after live preflight block",
          );
        }
        logger.error(
          {
            reason,
            updatedAt,
            blockingReasons: startupPreflight.blockingReasons,
            details: startupPreflight.details,
          },
          "[kite] live preflight blocked session startup",
        );
        return;
      }

      try {
        if (engineLifecycle) {
          await engineLifecycle.setToken(accessToken);
        } else {
          await setSession(accessToken);
        }
        await evaluateLiveStartupPreflight({
          source: `session_${reason}`,
          tokenDoc: doc,
          tickerStatus: getTickerStatus?.() || null,
          pipelineReady: true,
        });
      } catch (e) {
        const err = describeErr(e);
        logger.error(
          { reason, updatedAt, err },
          "[kite] setSession failed (trading halted; waiting for token refresh)",
        );
        alert("error", "⚠️ Kite session init failed (trading halted)", {
          reason,
          ...err,
          hint: "Re-login to Kite to refresh the access_token",
        }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
        await halt("KITE_SESSION_INIT_FAILED", { reason, ...err });
        // Do NOT throw — avoid killing the process; tokenWatcher will keep polling.
      }
    },
  });

  const app = buildApp();
  setNotificationHeartbeatProvider(async () => {
    const pipeline = getPipeline?.() || null;
    let tradeStatus = {};
    try {
      tradeStatus = pipeline?.status ? await pipeline.status() : {};
    } catch {
      tradeStatus = {};
    }
    return {
      ...tradeStatus,
      engineLifecycle: engineLifecycle?.status?.() || null,
      engineMode: engineLifecycle?.status?.().mode || null,
      ticker: getTickerStatus?.() || null,
      tickerConnected: Boolean(getTickerStatus?.()?.connected),
    };
  });
  const httpServer = http.createServer(app);
  const io = attachSocketServer(httpServer);
  const server = httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "server started");
    alert("info", "🚀 Scalper engine started", {
      port: env.PORT,
      env: env.NODE_ENV || "dev",
    }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  });

  const shutdown = async (signal) => {
    logger.warn({ signal }, "shutdown");
    alert("warn", `🧯 Shutdown signal: ${signal}`, { signal }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
    try {
      try {
        engineLifecycle?.stop?.();
      } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
      try {
        stopSessionControl();
      } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
      try {
        if (io) io.close();
      } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
      server.close(() => logger.warn("server closed"));
    } catch (err) { reportFault({ code: "INDEX_CATCH", err, message: "[src/index.js] caught and continued" }); }
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", async (reason) => {
  const msg = reason?.message || String(reason);
  logger.error({ reason: msg }, "unhandledRejection");
  alert("error", "💥 unhandledRejection (trading halted)", {
    message: msg,
  }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  await halt("UNHANDLED_REJECTION", { message: msg });
  await persistKill("UNHANDLED_REJECTION", { message: msg });
  exitAfterCrash();
});

process.on("uncaughtException", async (err) => {
  const msg = err?.message || String(err);
  logger.error({ err: msg, stack: err?.stack }, "uncaughtException");
  alert("error", "💥 uncaughtException (trading halted)", {
    message: msg,
  }).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  await halt("UNCAUGHT_EXCEPTION", { message: msg, stack: err?.stack });
  await persistKill("UNCAUGHT_EXCEPTION", { message: msg });
  exitAfterCrash();
});

main().catch((e) => {
  const err = describeErr(e);
  // Use a structured object that preserves error details (pino won't serialize Error well under key "e").
  logger.error({ err }, "fatal");
  alert("error", "💥 Scalper engine crashed (fatal)", err).catch((err) => { reportFault({ code: "INDEX_ASYNC", err, message: "[src/index.js] async task failed" }); });
  process.exit(1);
});
