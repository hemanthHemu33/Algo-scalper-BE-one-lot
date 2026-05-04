const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

function loadOptionsRouterHarness({
  instrumentRows = [],
  chainRows = [],
  envOverrides = {},
} = {}) {
  const optionsRouterPath = path.join(ROOT, "src", "fno", "optionsRouter.js");
  const instrumentRepoPath = path.join(
    ROOT,
    "src",
    "instruments",
    "instrumentRepo.js",
  );
  const optionChainCachePath = path.join(
    ROOT,
    "src",
    "fno",
    "optionChainCache.js",
  );
  const quoteGuardPath = path.join(ROOT, "src", "kite", "quoteGuard.js");
  const configPath = path.join(ROOT, "src", "config.js");

  delete require.cache[require.resolve(optionsRouterPath)];

  const instrumentRepo = require(instrumentRepoPath);
  const optionChainCache = require(optionChainCachePath);
  const quoteGuard = require(quoteGuardPath);
  const { env } = require(configPath);

  const restorers = [];

  function patchObject(target, overrides) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides || {})) {
      previous[key] = target[key];
      target[key] = value;
    }
    restorers.push(() => {
      for (const [key, value] of Object.entries(previous)) {
        target[key] = value;
      }
    });
  }

  function patchEnv(overrides) {
    const previous = {};
    for (const [key, value] of Object.entries(overrides || {})) {
      previous[key] = env[key];
      env[key] = value;
    }
    restorers.push(() => {
      for (const [key, value] of Object.entries(previous)) {
        env[key] = value;
      }
    });
  }

  patchObject(instrumentRepo, {
    getInstrumentsDump: async () => instrumentRows,
  });
  patchObject(optionChainCache, {
    getOptionChainSnapshot: async () => ({
      ok: true,
      fromCache: false,
      snapshot: {
        count: chainRows.length,
        rows: chainRows.slice(),
      },
    }),
    setLastOptionPick() {},
  });
  patchObject(quoteGuard, {
    isQuoteGuardBreakerOpen: () => false,
    getQuoteGuardStats: () => null,
  });
  patchEnv({
    FNO_EXCHANGES: "NFO",
    OPT_BLOCK_ON_QUOTE_GUARD_OPEN: false,
    OPT_STRICT_ATM_ONLY: true,
    OPT_PICK_REQUIRE_OK: false,
    OPT_LIQ_GATE_ENABLED: false,
    OPT_PREMIUM_BAND_ENFORCE_NIFTY: true,
    OPT_MIN_PREMIUM_NIFTY: 80,
    OPT_MAX_PREMIUM_NIFTY: 350,
    ONE_DTE_HARDENING_ENABLED: true,
    ...envOverrides,
  });

  const optionsRouter = require(optionsRouterPath);
  return {
    ...optionsRouter,
    restore() {
      delete require.cache[require.resolve(optionsRouterPath)];
      while (restorers.length) {
        const restore = restorers.pop();
        restore();
      }
    },
  };
}

function makeOptionRow({
  strike,
  token,
  tradingsymbol,
  expiry = "2026-04-22",
}) {
  return {
    name: "NIFTY",
    instrument_type: "CE",
    exchange: "NFO",
    tradingsymbol,
    instrument_token: token,
    strike,
    expiry,
    segment: "NFO-OPT",
    lot_size: 50,
    tick_size: 0.05,
  };
}

function makeChainRow({
  strike,
  token,
  tradingsymbol,
}) {
  return {
    instrument_token: token,
    exchange: "NFO",
    tradingsymbol,
    segment: "NFO-OPT",
    lot_size: 50,
    tick_size: 0.05,
    strike,
    ltp: 124.5,
    spread_bps: 18,
    spread_bps_change: 0,
    depth_qty_top: 320,
    book_flicker: 0,
    health_score: 82,
    volume: 12000,
    oi: 98000,
    oi_change: 0,
    delta: 0.5,
    gamma: 0.002,
    iv_pts: 18.5,
    iv_change_pts: 0,
    theta_per_day: -5,
  };
}

async function testProductAdaptationInitOrderRegression() {
  const strike = 25000;
  const token = 700001;
  const tradingsymbol = "NIFTY26APR25000CE";
  const instrumentRows = [makeOptionRow({ strike, token, tradingsymbol })];
  const chainRows = [makeChainRow({ strike, token, tradingsymbol })];

  const harness = loadOptionsRouterHarness({
    instrumentRows,
    chainRows,
  });

  const universe = {
    universe: {
      contracts: {
        NIFTY: {
          instrument_token: 26000,
          tradingsymbol: "NIFTY 50",
          name: "NIFTY",
          strike_ref_token: 26000,
          lot_size: 50,
        },
      },
    },
  };

  try {
    const args = {
      kite: {},
      universe,
      underlyingToken: 26000,
      underlyingTradingsymbol: "NIFTY 50",
      side: "BUY",
      underlyingLtp: 25012,
      signalContext: {
        marketState: "TREND_COMPRESSED",
        dangerStackScore: 24,
      },
      nowMs: Date.parse("2026-04-21T09:20:00+05:30"),
    };

    const first = await harness.pickOptionContractForSignal(args);
    const second = await harness.pickOptionContractForSignal(args);

    assert.ok(first, "first route attempt should return a deterministic object");
    assert.ok(second, "second route attempt should return a deterministic object");

    if (first.ok === false || second.ok === false) {
      assert.equal(
        first.ok,
        false,
        "if the first attempt rejects, it should be a clean rejection object",
      );
      assert.equal(
        second.ok,
        false,
        "if the second attempt rejects, it should be a clean rejection object",
      );
      assert.equal(
        String(first.reason || ""),
        String(second.reason || ""),
        "clean rejection should be deterministic across equivalent inputs",
      );
      assert.notEqual(
        String(first.message || "").includes("productAdaptation"),
        true,
        "rejection should not come from a TDZ/initialization crash",
      );
      return;
    }

    assert.ok(
      Number.isFinite(Number(first.instrument_token)) &&
        Number(first.instrument_token) > 0,
      "successful routing should return a selected contract token",
    );
    assert.equal(
      Number(first.instrument_token),
      Number(second.instrument_token),
      "successful routing should remain deterministic across equivalent inputs",
    );
  } finally {
    harness.restore();
  }
}

async function main() {
  await testProductAdaptationInitOrderRegression();
  console.log("optionsRouterRuntimeRegression.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

