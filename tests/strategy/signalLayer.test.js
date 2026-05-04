const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

const PATHS = {
  config: path.join(ROOT, "src", "config.js"),
  fnoUniverse: path.join(ROOT, "src", "fno", "fnoUniverse.js"),
  instrumentRepo: path.join(ROOT, "src", "instruments", "instrumentRepo.js"),
  pipeline: path.join(ROOT, "src", "pipeline.js"),
  candleBuilder: path.join(ROOT, "src", "market", "candleBuilder.js"),
  candleCache: path.join(ROOT, "src", "market", "candleCache.js"),
  candleWriteBuffer: path.join(ROOT, "src", "market", "candleWriteBuffer.js"),
  candleStore: path.join(ROOT, "src", "market", "candleStore.js"),
  backfill: path.join(ROOT, "src", "market", "backfill.js"),
  riskEngine: path.join(ROOT, "src", "risk", "riskEngine.js"),
  tradeManager: path.join(ROOT, "src", "trading", "tradeManager.js"),
  logger: path.join(ROOT, "src", "logger.js"),
  alertService: path.join(ROOT, "src", "alerts", "alertService.js"),
  strategyEngine: path.join(ROOT, "src", "strategy", "strategyEngine.js"),
  replayEngine: path.join(ROOT, "src", "strategy", "replayEngine.js"),
  signalLifecycle: path.join(ROOT, "src", "strategy", "signalLifecycle.js"),
  selector: path.join(ROOT, "src", "strategy", "selector.js"),
  registry: path.join(ROOT, "src", "strategy", "registry.js"),
  strategyUtils: path.join(ROOT, "src", "strategy", "utils.js"),
  minCandles: path.join(ROOT, "src", "strategy", "minCandles.js"),
  signalControls: path.join(ROOT, "src", "strategy", "signalControls.js"),
  scoreCalibration: path.join(ROOT, "src", "strategy", "scoreCalibration.js"),
  emaCrossStrategy: path.join(ROOT, "src", "strategy", "emaCrossStrategy.js"),
  emaPullbackStrategy: path.join(
    ROOT,
    "src",
    "strategy",
    "emaPullbackStrategy.js",
  ),
  fakeoutStrategy: path.join(ROOT, "src", "strategy", "fakeoutStrategy.js"),
  orbStrategy: path.join(ROOT, "src", "strategy", "orbStrategy.js"),
  breakoutStrategy: path.join(ROOT, "src", "strategy", "breakoutStrategy.js"),
  wickReversalStrategy: path.join(
    ROOT,
    "src",
    "strategy",
    "wickReversalStrategy.js",
  ),
  vwapReclaimStrategy: path.join(
    ROOT,
    "src",
    "strategy",
    "vwapReclaimStrategy.js",
  ),
  rsiFadeStrategy: path.join(ROOT, "src", "strategy", "rsiFadeStrategy.js"),
  bollingerSqueezeStrategy: path.join(
    ROOT,
    "src",
    "strategy",
    "bollingerSqueezeStrategy.js",
  ),
  volumeSpikeStrategy: path.join(
    ROOT,
    "src",
    "strategy",
    "volumeSpikeStrategy.js",
  ),
  signalCapture: path.join(ROOT, "src", "backtest", "signalCapture.js"),
  buildSignalCalibrationScript: path.join(
    ROOT,
    "scripts",
    "build_signal_score_calibration.js",
  ),
};

function clearModules(paths) {
  for (const modulePath of paths) {
    delete require.cache[require.resolve(modulePath)];
  }
}

function withPatchedEnv(overrides, fn) {
  const { env } = require(PATHS.config);
  const previous = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    previous[key] = env[key];
    env[key] = value;
  }

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      env[key] = value;
    }
  };

  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

function patchObject(target, overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = target[key];
    target[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      target[key] = value;
    }
  };
}

function makeCandle(tsMs, open, high, low, close, volume = 100) {
  return {
    ts: new Date(tsMs).toISOString(),
    open,
    high,
    low,
    close,
    volume,
  };
}

function makeCandlesFromCloses(
  closes,
  { startIso = "2026-01-01T09:15:00+05:30", intervalMin = 1, lows, highs, opens, volumes } = {},
) {
  const startMs = Date.parse(startIso);
  return closes.map((close, index) => {
    const prevClose = index > 0 ? closes[index - 1] : close - 0.5;
    const open = opens?.[index] ?? prevClose;
    const high = highs?.[index] ?? Math.max(open, close) + 0.6;
    const low = lows?.[index] ?? Math.min(open, close) - 0.6;
    const volume = volumes?.[index] ?? 100;
    return makeCandle(
      startMs + index * intervalMin * 60_000,
      open,
      high,
      low,
      close,
      volume,
    );
  });
}

function loadPipelineHarness({
  envOverrides = {},
  ensureInstrumentImpl,
  candleBuilderClass,
  candleCacheClass,
  candleWriteBufferClass,
  riskEngineClass,
  tradeManagerClass,
} = {}) {
  clearModules([PATHS.pipeline]);

  const candleBuilderModule = require(PATHS.candleBuilder);
  const candleCacheModule = require(PATHS.candleCache);
  const candleWriteBufferModule = require(PATHS.candleWriteBuffer);
  const candleStoreModule = require(PATHS.candleStore);
  const backfillModule = require(PATHS.backfill);
  const riskEngineModule = require(PATHS.riskEngine);
  const tradeManagerModule = require(PATHS.tradeManager);
  const instrumentRepoModule = require(PATHS.instrumentRepo);
  const alertServiceModule = require(PATHS.alertService);
  const { env } = require(PATHS.config);

  class StubCandleBuilder {
    addIndexTokens() {}

    onTicks() {
      return [];
    }

    finalizeDue() {
      return [];
    }

    getCurrentCandle() {
      return null;
    }
  }

  class StubCandleCache {
    addCandles() {}

    addCandle() {}

    getCandles() {
      return [];
    }
  }

  class StubCandleWriteBuffer {
    start() {}

    async stop() {}

    enqueue() {}
  }

  class StubRiskEngine {}

  class StubTradeManager {
    setRuntimeAddTokens() {}

    async init() {}

    onTick() {}

    async onSignal() {}

    async onOrderUpdate() {}

    async reconcile() {
      return { ok: true };
    }

    async positionFirstReconcile() {
      return { ok: true };
    }

    async setKillSwitch() {}

    async status() {
      return { ok: true };
    }

    async stop() {}
  }

  const restorers = [
    patchObject(candleBuilderModule, {
      CandleBuilder: candleBuilderClass || StubCandleBuilder,
    }),
    patchObject(candleCacheModule, {
      CandleCache: candleCacheClass || StubCandleCache,
    }),
    patchObject(candleWriteBufferModule, {
      CandleWriteBuffer: candleWriteBufferClass || StubCandleWriteBuffer,
    }),
    patchObject(candleStoreModule, {
      ensureIndexes: async () => {},
    }),
    patchObject(backfillModule, {
      backfillCandles: async () => [],
    }),
    patchObject(riskEngineModule, {
      RiskEngine: riskEngineClass || StubRiskEngine,
    }),
    patchObject(tradeManagerModule, {
      TradeManager: tradeManagerClass || StubTradeManager,
    }),
    patchObject(instrumentRepoModule, {
      ensureInstrument:
        ensureInstrumentImpl ||
        (async () => ({ segment: "NFO-FUT", instrument_type: "FUTIDX" })),
    }),
    patchObject(alertServiceModule, {
      alert: async () => ({ ok: true }),
    }),
  ];

  const envRestore = patchObject(env, {
    CANDLE_INTERVALS: "1",
    CANDLE_TIMER_FINALIZER_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    ...envOverrides,
  });
  restorers.push(envRestore);

  const { buildPipeline } = require(PATHS.pipeline);
  return {
    buildPipeline,
    restore() {
      clearModules([PATHS.pipeline]);
      while (restorers.length) {
        const restore = restorers.pop();
        restore();
      }
    },
  };
}

async function testSignalTokenScope() {
  clearModules([PATHS.fnoUniverse]);

  const { env } = require(PATHS.config);
  const instrumentRepoModule = require(PATHS.instrumentRepo);

  const envRestore = patchObject(env, {
    FNO_ENABLED: "true",
    FNO_MODE: "OPT",
    FNO_UNDERLYINGS: "NIFTY",
    FNO_EXCHANGES: "NFO",
    FNO_SINGLE_UNDERLYING_ENABLED: false,
    OPT_UNDERLYING_SOURCE: "FUT",
    OPT_STRIKE_REF_SOURCE: "SPOT",
    FNO_LOG_UNIVERSE: "false",
  });
  const repoRestore = patchObject(instrumentRepoModule, {
    getInstrumentsDump: async (_kite, exchange) => {
      if (exchange === "NFO") {
        return [
          {
            instrument_token: 111,
            exchange: "NFO",
            tradingsymbol: "NIFTY26MARFUT",
            segment: "NFO-FUT",
            instrument_type: "FUTIDX",
            name: "NIFTY",
            expiry: "2026-03-26",
            lot_size: 75,
            tick_size: 0.05,
          },
        ];
      }

      if (exchange === "NSE") {
        return [
          {
            instrument_token: 222,
            exchange: "NSE",
            tradingsymbol: "NIFTY 50",
            segment: "INDICES",
            instrument_type: "INDEX",
            name: "NIFTY 50",
            tick_size: 0.05,
          },
        ];
      }

      return [];
    },
  });

  try {
    const { buildFnoUniverse } = require(PATHS.fnoUniverse);
    const uni = await buildFnoUniverse({
      kite: {},
      nowMs: Date.parse("2026-03-25T09:30:00+05:30"),
    });

    assert.deepEqual(uni.universe.tokens, [111, 222]);
    assert.deepEqual(uni.universe.signalTokens, [111]);

    const harness = loadPipelineHarness({
      ensureInstrumentImpl: async (_kite, token) =>
        Number(token) === 222
          ? { segment: "INDICES", instrument_type: "INDEX" }
          : { segment: "NFO-FUT", instrument_type: "FUTIDX" },
    });

    let pipeline;
    try {
      pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
      await pipeline.initForTokens(uni.universe.tokens, {
        signalTokens: uni.universe.signalTokens,
      });

      assert.deepEqual(pipeline.subscriptions(), {
        ok: true,
        tokens: [111, 222],
        signalTokens: [111],
        count: 2,
      });
    } finally {
      await pipeline?.stop?.();
      harness.restore();
    }
  } finally {
    repoRestore();
    envRestore();
    clearModules([PATHS.fnoUniverse]);
  }
}

async function testSelectorUsesCandleTimestamp() {
  clearModules([PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const selectorModule = require(PATHS.selector);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    MIN_CANDLES_FOR_SIGNAL: 5,
    STRATEGY_SELECTOR_ENABLED: "true",
    TELEMETRY_ENABLED: "false",
    MIN_SIGNAL_CONFIDENCE: 60,
    EMA_FAST: 2,
    EMA_SLOW: 3,
  });

  let capturedNow = null;
  const selectorRestore = patchObject(selectorModule, {
    pickStrategies: ({ now }) => {
      capturedNow = now;
      return { regime: "OPEN", meta: { source: "test" }, strategyIds: ["ema_cross"] };
    },
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross"],
    runStrategy: () => ({
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 71,
      reason: "selector timestamp",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 80,
        anchorQuality: 77,
        structureQuality: 79,
        volumeQuality: 67,
        freshness: 84,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const { evaluateOnCandleClose } = require(PATHS.strategyEngine);
    const candles = makeCandlesFromCloses([100, 101, 102, 103, 104, 105], {
      startIso: "2026-01-01T09:15:00+05:30",
    });
    const last = candles[candles.length - 1];
    const signal = await evaluateOnCandleClose({
      instrument_token: 123,
      intervalMin: 1,
      candles,
    });

    assert.ok(signal);
    assert.equal(signal.regime, "OPEN");
    assert.equal(
      capturedNow.getTime(),
      new Date(last.ts).getTime(),
      "selector should receive the evaluated candle timestamp",
    );
  } finally {
    storeRestore();
    registryRestore();
    selectorRestore();
    envRestore();
    clearModules([PATHS.strategyEngine]);
  }
}

function testRegistryWiring() {
  clearModules([PATHS.registry]);

  const { env } = require(PATHS.config);
  assert.equal(
    Object.prototype.hasOwnProperty.call(env, "FAKEOUT_VOL_LOOKBACK"),
    true,
  );

  const emaPullbackModule = require(PATHS.emaPullbackStrategy);
  const rsiFadeModule = require(PATHS.rsiFadeStrategy);
  const bbModule = require(PATHS.bollingerSqueezeStrategy);
  const volumeSpikeModule = require(PATHS.volumeSpikeStrategy);
  const fakeoutModule = require(PATHS.fakeoutStrategy);

  const captured = {};
  const envRestore = patchObject(env, {
    EMA_FAST: 8,
    EMA_SLOW: 21,
    PULLBACK_BARS: 7,
    PULLBACK_VOL_LOOKBACK: 33,
    PULLBACK_VOL_MULT: 1.7,
    RSI_PERIOD: 11,
    RSI_OVERBOUGHT: 77,
    RSI_OVERSOLD: 23,
    BB_PERIOD: 18,
    BB_STDDEV: 2.5,
    SQUEEZE_PCT: 0.01,
    SQUEEZE_VOL_MULT: 1.4,
    VOL_SPIKE_LOOKBACK: 13,
    VOL_SPIKE_MULT: 2.8,
    MOM_BODY_FRAC: 0.8,
    FAKEOUT_LOOKBACK: 12,
    FAKEOUT_VOL_LOOKBACK: 14,
    FAKEOUT_VOL_MULT: 1.3,
    FAKEOUT_WICK_FRAC: 0.55,
    FAKEOUT_MIN_RANGE_FRAC: 0.009,
  });
  const restorers = [
    patchObject(emaPullbackModule, {
      emaPullbackStrategy: (args) => {
        captured.ema_pullback = args;
        return null;
      },
    }),
    patchObject(rsiFadeModule, {
      rsiFadeStrategy: (args) => {
        captured.rsi_fade = args;
        return null;
      },
    }),
    patchObject(bbModule, {
      bollingerSqueezeStrategy: (args) => {
        captured.bb_squeeze = args;
        return null;
      },
    }),
    patchObject(volumeSpikeModule, {
      volumeSpikeStrategy: (args) => {
        captured.volume_spike = args;
        return null;
      },
    }),
    patchObject(fakeoutModule, {
      fakeoutStrategy: (args) => {
        captured.fakeout = args;
        return null;
      },
    }),
  ];

  try {
    const { runStrategy } = require(PATHS.registry);
    const candles = [makeCandle(Date.parse("2026-01-01T09:15:00+05:30"), 1, 1, 1, 1)];

    runStrategy("ema_pullback", candles);
    runStrategy("rsi_fade", candles);
    runStrategy("bb_squeeze", candles);
    runStrategy("volume_spike", candles);
    runStrategy("fakeout", candles);

    assert.equal(captured.ema_pullback.pullbackBars, 7);
    assert.equal(captured.ema_pullback.volLookback, 33);
    assert.equal(captured.ema_pullback.volMult, 1.7);

    assert.equal(captured.rsi_fade.period, 11);
    assert.equal(captured.rsi_fade.ob, 77);
    assert.equal(captured.rsi_fade.os, 23);
    assert.equal("overbought" in captured.rsi_fade, false);
    assert.equal("oversold" in captured.rsi_fade, false);

    assert.equal(captured.bb_squeeze.period, 18);
    assert.equal(captured.bb_squeeze.std, 2.5);
    assert.equal("stdDev" in captured.bb_squeeze, false);

    assert.equal(captured.volume_spike.volLookback, 13);
    assert.equal(captured.volume_spike.volMult, 2.8);
    assert.equal(captured.volume_spike.bodyFrac, 0.8);
    assert.equal("lookback" in captured.volume_spike, false);
    assert.equal("mult" in captured.volume_spike, false);

    assert.equal(captured.fakeout.lookback, 12);
    assert.equal(captured.fakeout.volLookback, 14);
    assert.equal(captured.fakeout.volMult, 1.3);
    assert.equal(captured.fakeout.wickFrac, 0.55);
    assert.equal(captured.fakeout.minRangeFrac, 0.009);
  } finally {
    while (restorers.length) {
      const restore = restorers.pop();
      restore();
    }
    envRestore();
    clearModules([PATHS.registry]);
  }
}

function testEmaPullbackStrategy() {
  const { emaPullbackStrategy } = require(PATHS.emaPullbackStrategy);

  const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 105, 108, 109, 110];
  const lows = closes.map((close, index) =>
    index === closes.length - 1
      ? 106
      : Math.min(close, closes[Math.max(0, index - 1)]) - 0.6,
  );
  const volumes = closes.map((_, index) =>
    index === closes.length - 1 ? 220 : 100,
  );
  const candles = makeCandlesFromCloses(closes, { lows, volumes });

  const pullbackSignal = emaPullbackStrategy({
    candles,
    fast: 3,
    slow: 5,
    pullbackBars: 5,
    volLookback: 3,
    volMult: 1.1,
  });
  assert.equal(pullbackSignal?.side, "BUY");

  const shortWindowSignal = emaPullbackStrategy({
    candles,
    fast: 3,
    slow: 5,
    pullbackBars: 2,
    volLookback: 3,
    volMult: 1.1,
  });
  assert.equal(shortWindowSignal, null);

  const noPullbackCandles = makeCandlesFromCloses(
    [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 114],
    { volumes },
  );
  const noPullbackSignal = emaPullbackStrategy({
    candles: noPullbackCandles,
    fast: 3,
    slow: 5,
    pullbackBars: 5,
    volLookback: 3,
    volMult: 1.1,
  });
  assert.equal(noPullbackSignal, null);
}

function testFakeoutStrategy() {
  const { fakeoutStrategy } = require(PATHS.fakeoutStrategy);

  const base = Array.from({ length: 24 }, (_, index) =>
    makeCandle(
      Date.parse("2026-01-01T09:15:00+05:30") + index * 60_000,
      99,
      100,
      98,
      99.5,
      100,
    ),
  );
  const prev = makeCandle(
    Date.parse("2026-01-01T09:39:00+05:30"),
    100,
    101.5,
    99.8,
    101.2,
    100,
  );

  const wickCur = makeCandle(
    Date.parse("2026-01-01T09:40:00+05:30"),
    100.8,
    103,
    99.6,
    99.8,
    180,
  );
  const wickPass = fakeoutStrategy({
    candles: [...base, prev, wickCur],
    lookback: 20,
    volLookback: 20,
    volMult: 1,
    wickFrac: 0.6,
    minRangeFrac: 0.004,
  });
  const wickFail = fakeoutStrategy({
    candles: [...base, prev, wickCur],
    lookback: 20,
    volLookback: 20,
    volMult: 1,
    wickFrac: 0.7,
    minRangeFrac: 0.004,
  });
  assert.equal(wickPass?.side, "SELL");
  assert.equal(wickFail, null);

  const smallRangeCur = makeCandle(
    Date.parse("2026-01-01T09:40:00+05:30"),
    100.05,
    100.35,
    99.95,
    99.98,
    180,
  );
  const rangePass = fakeoutStrategy({
    candles: [...base, prev, smallRangeCur],
    lookback: 20,
    volLookback: 20,
    volMult: 1,
    wickFrac: 0.6,
    minRangeFrac: 0.003,
  });
  const rangeFail = fakeoutStrategy({
    candles: [...base, prev, smallRangeCur],
    lookback: 20,
    volLookback: 20,
    volMult: 1,
    wickFrac: 0.6,
    minRangeFrac: 0.005,
  });
  assert.equal(rangePass?.side, "SELL");
  assert.equal(rangeFail, null);
}

function testOrbStrategy() {
  const { env } = require(PATHS.config);
  const { orbStrategy } = require(PATHS.orbStrategy);

  const prevMarketOpen = env.MARKET_OPEN;
  try {
    env.MARKET_OPEN = "10:00";
    const customOpenCandles = makeCandlesFromCloses([100, 101, 102, 104], {
      startIso: "2026-01-01T10:00:00+05:30",
      intervalMin: 5,
      volumes: [100, 100, 100, 200],
    });
    const customOpenSignal = orbStrategy({
      candles: customOpenCandles,
      intervalMin: 5,
      orbMinutes: 15,
      volLookback: 4,
      volMult: 1.1,
    });
    assert.equal(customOpenCandles.length, 4);
    assert.equal(customOpenSignal?.side, "BUY");

    env.MARKET_OPEN = "";
    const defaultOpenCandles = makeCandlesFromCloses([100, 101, 102, 104], {
      startIso: "2026-01-01T09:15:00+05:30",
      intervalMin: 5,
      volumes: [100, 100, 100, 200],
    });
    const defaultOpenSignal = orbStrategy({
      candles: defaultOpenCandles,
      intervalMin: 5,
      orbMinutes: 15,
      volLookback: 4,
      volMult: 1.1,
    });
    assert.equal(defaultOpenSignal?.side, "BUY");
    assert.equal(defaultOpenSignal?.meta?.orbAgeBars, 0);
    assert.equal(defaultOpenSignal?.meta?.orbExpired, false);
  } finally {
    env.MARKET_OPEN = prevMarketOpen;
  }
}

function testOrbExpiryWindow() {
  const { env } = require(PATHS.config);
  const { orbStrategy } = require(PATHS.orbStrategy);

  const restore = patchObject(env, {
    MARKET_OPEN: "09:15",
    ORB_TRIGGER_WINDOW_MIN: 10,
  });

  try {
    const freshCandles = makeCandlesFromCloses([100, 101, 102, 104], {
      startIso: "2026-01-02T09:15:00+05:30",
      intervalMin: 5,
      volumes: [100, 100, 100, 220],
    });
    const fresh = orbStrategy({
      candles: freshCandles,
      intervalMin: 5,
      orbMinutes: 15,
      volLookback: 4,
      volMult: 1.1,
    });
    assert.equal(fresh?.side, "BUY");
    assert.equal(fresh?.meta?.orbAgeMin, 0);

    const lateCandles = makeCandlesFromCloses(
      [100, 101, 102, 102.1, 102.2, 102.15, 104],
      {
        startIso: "2026-01-02T09:15:00+05:30",
        intervalMin: 5,
        volumes: [100, 100, 100, 100, 100, 100, 220],
      },
    );
    const late = orbStrategy({
      candles: lateCandles,
      intervalMin: 5,
      orbMinutes: 15,
      volLookback: 4,
      volMult: 1.1,
    });
    assert.equal(
      late,
      null,
      "ORB should not emit a first trigger after its validity window expires",
    );
  } finally {
    restore();
  }
}

function testVwapReclaimStrategy() {
  const { vwapReclaimStrategy } = require(PATHS.vwapReclaimStrategy);

  const buyPriorSession = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 180, 181, 179, 180, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 180, 181, 179, 180, 5000),
    makeCandle(Date.parse("2026-01-01T15:12:00+05:30"), 180, 181, 179, 180, 5000),
  ];
  const buyCurrentSession = makeCandlesFromCloses(
    [100, 99, 98, 97, 100.5],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 100, 100, 100, 220],
    },
  );
  const buySignal = vwapReclaimStrategy({
    candles: [...buyPriorSession, ...buyCurrentSession],
    lookback: 120,
    volLookback: 3,
    volMult: 1.0,
    fast: 1,
    slow: 2,
  });
  assert.equal(
    buySignal?.side,
    "BUY",
    "prior-session candles should not contaminate current-session VWAP BUY reclaim",
  );

  const sellPriorSession = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 20, 21, 19, 20, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 20, 21, 19, 20, 5000),
    makeCandle(Date.parse("2026-01-01T15:12:00+05:30"), 20, 21, 19, 20, 5000),
  ];
  const sellCurrentSession = makeCandlesFromCloses(
    [100, 101, 102, 103, 99.5],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 100, 100, 100, 220],
    },
  );
  const sellSignal = vwapReclaimStrategy({
    candles: [...sellPriorSession, ...sellCurrentSession],
    lookback: 120,
    volLookback: 3,
    volMult: 1.0,
    fast: 1,
    slow: 2,
  });
  assert.equal(
    sellSignal?.side,
    "SELL",
    "prior-session candles should not contaminate current-session VWAP SELL reject",
  );

  const zeroVolumeCandles = makeCandlesFromCloses(
    [100, 99, 98, 97, 100.5],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [0, 0, 0, 0, 0],
    },
  );
  let zeroVolumeResult = null;
  assert.doesNotThrow(() => {
    zeroVolumeResult = vwapReclaimStrategy({
      candles: zeroVolumeCandles,
      lookback: 120,
      volLookback: 3,
      volMult: 1.0,
      fast: 1,
      slow: 2,
    });
  });
  assert.equal(
    zeroVolumeResult,
    null,
    "missing or zero session volume should fail safely with no signal",
  );
}

function testVolumeBaselineHelpers() {
  const { avgVolumePriorBars, volumeConfirmation } = require(PATHS.strategyUtils);

  const sameSession = makeCandlesFromCloses(
    [100, 101, 102, 103],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 100, 100, 400],
    },
  );
  const baseline = avgVolumePriorBars(sameSession, 3, {
    sessionOnly: true,
  });
  assert.equal(
    baseline.average,
    100,
    "current candle volume must be excluded from its own baseline",
  );

  const priorSession = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 120, 121, 119, 120, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 120, 121, 119, 120, 5000),
  ];
  const earlySession = makeCandlesFromCloses(
    [100, 101],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 120],
    },
  );
  const sessionOnly = avgVolumePriorBars(
    [...priorSession, ...earlySession],
    5,
    { sessionOnly: true },
  );
  assert.equal(
    sessionOnly.average,
    100,
    "session-only volume baselines should not silently use prior-session bars",
  );

  const zeroVolume = makeCandlesFromCloses(
    [100, 101, 102],
    {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [0, 0, 0],
    },
  );
  const volume = volumeConfirmation(zeroVolume, {
    lookback: 3,
    mult: 1.2,
    sessionOnly: true,
    required: true,
  });
  assert.equal(volume.available, false);
  assert.equal(volume.ok, false);
}

function testSessionAwareStructureStrategies() {
  const { breakoutStrategy } = require(PATHS.breakoutStrategy);
  const { fakeoutStrategy } = require(PATHS.fakeoutStrategy);
  const { wickReversalStrategy } = require(PATHS.wickReversalStrategy);

  const priorSession = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 120, 121, 119, 120, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 120, 121, 119, 120, 5000),
    makeCandle(Date.parse("2026-01-01T15:12:00+05:30"), 120, 121, 119, 120, 5000),
  ];

  const breakoutCurrent = [
    makeCandle(Date.parse("2026-01-02T09:15:00+05:30"), 99.5, 100.0, 99.2, 99.8, 100),
    makeCandle(Date.parse("2026-01-02T09:16:00+05:30"), 99.8, 100.2, 99.6, 100.0, 100),
    makeCandle(Date.parse("2026-01-02T09:17:00+05:30"), 100.0, 100.4, 99.9, 100.2, 100),
    makeCandle(Date.parse("2026-01-02T09:18:00+05:30"), 100.2, 100.6, 100.1, 100.4, 100),
    makeCandle(Date.parse("2026-01-02T09:19:00+05:30"), 100.4, 101.2, 100.3, 101.0, 220),
  ];
  const breakoutSignal = breakoutStrategy({
    candles: [...priorSession, ...breakoutCurrent],
    lookback: 20,
    volLookback: 3,
    volMult: 1.2,
  });
  assert.equal(
    breakoutSignal?.side,
    "BUY",
    "breakout structure should use the current session, not prior-session highs",
  );

  const fakeoutCurrent = [
    makeCandle(Date.parse("2026-01-02T09:15:00+05:30"), 99.2, 99.7, 98.9, 99.5, 100),
    makeCandle(Date.parse("2026-01-02T09:16:00+05:30"), 99.5, 99.9, 99.3, 99.7, 100),
    makeCandle(Date.parse("2026-01-02T09:17:00+05:30"), 99.7, 100.1, 99.5, 99.8, 100),
    makeCandle(Date.parse("2026-01-02T09:18:00+05:30"), 99.8, 101.4, 99.7, 101.2, 100),
    makeCandle(Date.parse("2026-01-02T09:19:00+05:30"), 100.8, 103.0, 99.6, 99.8, 180),
  ];
  const fakeoutSignal = fakeoutStrategy({
    candles: [...priorSession, ...fakeoutCurrent],
    lookback: 20,
    volLookback: 3,
    volMult: 1.0,
    wickFrac: 0.6,
    minRangeFrac: 0.004,
  });
  assert.equal(
    fakeoutSignal?.side,
    "SELL",
    "fakeout context should stay session-local instead of inheriting prior-session range",
  );

  const wickCurrent = [
    makeCandle(Date.parse("2026-01-02T09:15:00+05:30"), 100.0, 100.4, 99.8, 100.2, 100),
    makeCandle(Date.parse("2026-01-02T09:16:00+05:30"), 100.2, 100.7, 100.0, 100.5, 100),
    makeCandle(Date.parse("2026-01-02T09:17:00+05:30"), 100.5, 101.0, 100.3, 100.8, 100),
    makeCandle(Date.parse("2026-01-02T09:18:00+05:30"), 100.8, 101.3, 100.6, 101.0, 100),
    makeCandle(Date.parse("2026-01-02T09:19:00+05:30"), 101.0, 102.2, 100.5, 100.7, 150),
  ];
  const wickSignal = wickReversalStrategy({
    candles: [...priorSession, ...wickCurrent],
    lookback: 20,
    minWickFrac: 0.6,
  });
  assert.equal(
    wickSignal?.side,
    "SELL",
    "wick reversal trend context should be based on the current session structure",
  );
}

async function testPipelinePreservesEarlyCachedCandles() {
  clearModules([PATHS.pipeline]);

  const strategyEngineModule = require(PATHS.strategyEngine);
  let seenCandles = null;
  const strategyRestore = patchObject(strategyEngineModule, {
    evaluateOnCandleClose: async ({ candles }) => {
      seenCandles = candles;
      return null;
    },
    evaluateOnCandleTick: async () => null,
    resetSignalLayerState: () => {},
  });

  const earlyCandles = makeCandlesFromCloses([100, 101, 102, 104], {
    startIso: "2026-01-01T09:15:00+05:30",
    intervalMin: 5,
    volumes: [100, 100, 100, 180],
  }).map((candle) => ({
    ...candle,
    ts: new Date(candle.ts),
    instrument_token: 321,
    interval_min: 5,
    source: "live",
  }));

  class EarlySessionCandleBuilder {
    addIndexTokens() {}

    onTicks() {
      return [earlyCandles[earlyCandles.length - 1]];
    }

    finalizeDue() {
      return [];
    }

    getCurrentCandle() {
      return null;
    }
  }

  class EarlySessionCandleCache {
    addCandles() {}

    addCandle() {}

    getCandles() {
      return earlyCandles;
    }
  }

  const harness = loadPipelineHarness({
    envOverrides: {
      CANDLE_INTERVALS: "5",
      SIGNAL_INTERVALS: "5",
      MIN_CANDLES_FOR_SIGNAL: 50,
      TELEMETRY_ENABLED: "false",
      ALLOW_SYNTHETIC_SIGNALS: "true",
    },
    candleBuilderClass: EarlySessionCandleBuilder,
    candleCacheClass: EarlySessionCandleCache,
  });

  let pipeline;
  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    await pipeline.initForTokens([321], { signalTokens: [321] });
    await pipeline.onTicks([{ instrument_token: 321, last_price: 104 }]);

    assert.equal(
      seenCandles?.length,
      4,
      "pipeline should pass real early-session cached candles into the signal engine",
    );
  } finally {
    await pipeline?.stop?.();
    harness.restore();
    strategyRestore();
    clearModules([PATHS.pipeline]);
  }
}

function testProfessionalStrategyMinimums() {
  clearModules([PATHS.minCandles]);

  const { env } = require(PATHS.config);
  const { resolveStrategyMinCandles } = require(PATHS.minCandles);
  const restore = patchObject(env, {
    EMA_FAST: 9,
    EMA_SLOW: 21,
    PULLBACK_BARS: 5,
    PULLBACK_VOL_LOOKBACK: 20,
    BREAKOUT_LOOKBACK: 20,
    BB_PERIOD: 20,
    VOL_SPIKE_LOOKBACK: 20,
    FAKEOUT_LOOKBACK: 20,
    FAKEOUT_VOL_LOOKBACK: 20,
    RSI_PERIOD: 14,
    WICK_LOOKBACK: 20,
    ORB_MINUTES: 15,
  });

  try {
    assert.equal(resolveStrategyMinCandles("orb", 5, env), 4);
    assert.ok(resolveStrategyMinCandles("breakout", 1, env) >= 21);
    assert.ok(resolveStrategyMinCandles("volume_spike", 1, env) >= 9);
    assert.ok(resolveStrategyMinCandles("fakeout", 1, env) >= 21);
    assert.ok(resolveStrategyMinCandles("wick_reversal", 1, env) >= 21);
    assert.ok(resolveStrategyMinCandles("ema_pullback", 1, env) >= 23);
    assert.ok(resolveStrategyMinCandles("vwap_reclaim", 1, env) >= 22);
    assert.ok(resolveStrategyMinCandles("bb_squeeze", 1, env) >= 22);
    assert.ok(resolveStrategyMinCandles("rsi_fade", 1, env) >= 16);
  } finally {
    restore();
    clearModules([PATHS.minCandles]);
  }
}

async function testStrategyMinimumsAndEarlyOrbEvaluation() {
  clearModules([PATHS.minCandles, PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const selectorModule = require(PATHS.selector);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const { resolveStrategyMinCandles } = require(PATHS.minCandles);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "5",
    STRATEGIES: "orb,ema_cross",
    MIN_CANDLES_FOR_SIGNAL: 50,
    STRATEGY_SELECTOR_ENABLED: "false",
    SELECTOR_OPEN_WINDOW_MIN: 20,
    ORB_MINUTES: 15,
    TELEMETRY_ENABLED: "false",
  });

  const candles = makeCandlesFromCloses([100, 101, 102, 104], {
    startIso: "2026-01-01T09:15:00+05:30",
    intervalMin: 5,
    volumes: [100, 100, 100, 180],
  });

  const regime = selectorModule.detectRegime({
    candles,
    env,
    now: new Date(candles[candles.length - 1].ts),
  });
  assert.equal(
    regime.regime,
    "OPEN",
    "selector should still recognize OPEN with early-session history",
  );
  assert.equal(resolveStrategyMinCandles("orb", 5, env), 4);
  assert.ok(resolveStrategyMinCandles("ema_cross", 5, env) > candles.length);

  const calls = [];
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["orb", "ema_cross"],
    runStrategy: (id) => {
      calls.push(id);
      if (id !== "orb") return null;
      return {
        strategyId: "orb",
        side: "BUY",
        confidence: 74,
        reason: "early orb",
        meta: { triggerLevel: 103, orbMinutes: 15 },
      };
    },
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const signal = await evaluateOnCandleClose({
      instrument_token: 321,
      intervalMin: 5,
      candles,
    });

    assert.equal(signal?.strategyId, "orb");
    assert.deepEqual(
      calls,
      ["orb"],
      "only strategies with enough history should run on the interval",
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.minCandles, PATHS.strategyEngine]);
  }
}

async function testConfidenceNormalizationAndRawConfidence() {
  clearModules([PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const { decorateSignalCandidate } = require(PATHS.signalControls);

  const emaCandidate = {
    strategyId: "ema_cross",
    strategyStyle: "TREND",
    strategyFamily: "TREND",
    side: "BUY",
    confidence: 84,
    actionable: true,
    reason: "raw higher",
    meta: {
      patternQuality: 60,
      anchorQuality: 55,
      volumeQuality: 55,
      freshness: 60,
    },
  };
  const rsiCandidate = {
    strategyId: "rsi_fade",
    strategyStyle: "RANGE",
    strategyFamily: "MEAN_REVERSION",
    side: "BUY",
    confidence: 80,
    actionable: true,
    reason: "composite higher",
    meta: {
      patternQuality: 94,
      anchorQuality: 88,
      volumeQuality: 55,
      freshness: 92,
    },
  };

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_cross,rsi_fade",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross", "rsi_fade"],
    runStrategy: (id) => {
      if (id === "ema_cross") return { ...emaCandidate };
      if (id === "rsi_fade") return { ...rsiCandidate };
      return null;
    },
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const { evaluateOnCandleClose } = require(PATHS.strategyEngine);
    const candles = makeCandlesFromCloses(
      Array.from({ length: 30 }, (_, index) => 100 + index * 0.2),
    );
    const context = {
      instrument_token: 555,
      intervalMin: 1,
      candles,
      last: candles[candles.length - 1],
      stage: "close",
    };
    const signal = await evaluateOnCandleClose({
      instrument_token: 555,
      intervalMin: 1,
      candles,
    });
    const emaDecorated = decorateSignalCandidate(emaCandidate, context);
    const rsiDecorated = decorateSignalCandidate(rsiCandidate, context);

    assert.equal(
      signal?.strategyId,
      "rsi_fade",
      "best-signal selection should use the composite final score, not raw confidence alone",
    );
    assert.equal(signal.confidence, 80);
    assert.equal(signal.rawConfidence, 80);
    assert.equal(signal.normalizedConfidence, rsiDecorated.normalizedConfidence);
    assert.equal(signal.finalSignalScore, rsiDecorated.finalSignalScore);
    assert.ok(
      rsiDecorated.finalSignalScore > emaDecorated.finalSignalScore,
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine]);
  }
}

async function testProvisionalVsConfirmedSignals() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "orb",
    ORB_MINUTES: 3,
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["orb"],
    runStrategy: () => ({
      strategyId: "orb",
      side: "BUY",
      confidence: 76,
      reason: "preview then confirm",
      strategyStyle: "OPEN",
      meta: {
        triggerLevel: 100,
        orbHigh: 100,
        orbLow: 98,
        orbCompletedAt: "2026-01-02T09:18:00+05:30",
        orbMinutes: 3,
        triggerType: "OPENING_RANGE_BREAKOUT",
        anchorType: "OPENING_RANGE",
        patternQuality: 82,
        anchorQuality: 80,
        volumeQuality: 70,
        freshness: 88,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleTick,
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const candles = makeCandlesFromCloses([98, 99, 100, 101], {
      startIso: "2026-01-02T09:15:00+05:30",
    });
    const preview = await evaluateOnCandleTick({
      instrument_token: 901,
      intervalMin: 1,
      candles: candles.slice(0, -1),
      liveCandle: { ...candles[candles.length - 1], source: "live" },
    });
    const confirmed = await evaluateOnCandleClose({
      instrument_token: 901,
      intervalMin: 1,
      candles,
    });

    assert.equal(preview?.signalStage, "tick_preview");
    assert.equal(preview?.isProvisional, true);
    assert.equal(preview?.candleClosed, false);
    assert.equal(confirmed?.signalStage, "bar_close_confirmed");
    assert.equal(confirmed?.isProvisional, false);
    assert.equal(confirmed?.candleClosed, true);
    assert.equal(
      confirmed?.meta?.setupId,
      preview?.meta?.setupId,
      "preview and confirmed close should stay on the same setup lineage",
    );
    assert.equal(confirmed?.meta?.setupLineage, "preview_to_confirmed");
    assert.ok(
      confirmed.finalSignalScore > preview.finalSignalScore,
      "confirmed close signals should outrank provisional tick previews",
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls]);
  }
}

async function testDuplicateFireControl() {
  clearModules([PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "orb",
    ORB_MINUTES: 3,
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["orb"],
    runStrategy: () => ({
      strategyId: "orb",
      side: "BUY",
      confidence: 76,
      reason: "repeatable orb",
      meta: {
        triggerLevel: 100,
        orbHigh: 100,
        orbLow: 98,
        orbMinutes: 3,
        triggerType: "OPENING_RANGE_BREAKOUT",
        anchorType: "OPENING_RANGE",
        patternQuality: 84,
        anchorQuality: 82,
        structureQuality: 80,
        volumeQuality: 72,
        freshness: 88,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const firstCandles = makeCandlesFromCloses([98, 99, 100, 101]);
    const secondCandles = makeCandlesFromCloses([98, 99, 100, 101, 102]);
    const resetCandles = makeCandlesFromCloses([98, 99, 100, 101, 102, 99, 101]);

    const first = await evaluateOnCandleClose({
      instrument_token: 777,
      intervalMin: 1,
      candles: firstCandles,
    });
    const second = await evaluateOnCandleClose({
      instrument_token: 777,
      intervalMin: 1,
      candles: secondCandles,
    });
    const afterReset = await evaluateOnCandleClose({
      instrument_token: 777,
      intervalMin: 1,
      candles: resetCandles,
    });

    assert.equal(first?.strategyId, "orb");
    assert.equal(
      second,
      null,
      "adjacent duplicate detections should be suppressed until the setup resets",
    );
    assert.equal(
      afterReset?.strategyId,
      "orb",
      "a later reset through the trigger level should allow a fresh signal",
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine]);
  }
}

async function testLifecycleMemoryForAllCandidates() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  let round = 1;

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "breakout,rsi_fade",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["breakout", "rsi_fade"],
    runStrategy: (id) => {
      if (id === "breakout" && round === 1) {
        return {
          strategyId: "breakout",
          strategyStyle: "TREND",
          side: "BUY",
          confidence: 84,
          reason: "winning breakout",
          meta: {
            triggerLevel: 101,
            rangeHigh: 101,
            rangeLow: 99,
            lookbackUsed: 8,
            triggerType: "SESSION_BREAKOUT",
            anchorType: "SESSION_RANGE",
            patternQuality: 94,
            anchorQuality: 88,
            structureQuality: 90,
            volumeQuality: 80,
            freshness: 90,
          },
        };
      }
      if (id === "rsi_fade") {
        return {
          strategyId: "rsi_fade",
          strategyStyle: "RANGE",
          side: "SELL",
          confidence: 76,
          reason: "persistent fade",
          meta: {
            period: 14,
            neutralLevel: 50,
            extremeBucket: "STRONG",
            triggerType: "RSI_FADE",
            anchorType: "SESSION_VWAP",
            anchorValue: 100,
            patternQuality: 78,
            anchorQuality: 76,
            structureQuality: 74,
            volumeQuality: 55,
            freshness: 84,
          },
        };
      }
      return null;
    },
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const firstCandles = makeCandlesFromCloses(
      Array.from({ length: 30 }, (_, index) => 100 + index * 0.1),
      { startIso: "2026-01-02T10:00:00+05:30" },
    );
    const secondCandles = makeCandlesFromCloses(
      Array.from({ length: 31 }, (_, index) => 100 + index * 0.1),
      { startIso: "2026-01-02T10:00:00+05:30" },
    );

    const first = await evaluateOnCandleClose({
      instrument_token: 7777,
      intervalMin: 1,
      candles: firstCandles,
    });
    round = 2;
    const second = await evaluateOnCandleClose({
      instrument_token: 7777,
      intervalMin: 1,
      candles: secondCandles,
    });

    assert.equal(first?.strategyId, "breakout");
    assert.equal(second?.strategyId, "rsi_fade");
    assert.ok(
      Number(second?.setupObservationCount ?? 0) > 1,
      "non-winning candidates should keep lifecycle memory and observation count",
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls]);
  }
}

async function testRsiFadeLifecycleReset() {
  clearModules([PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "rsi_fade",
    RSI_PERIOD: 3,
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["rsi_fade"],
    runStrategy: () => ({
      strategyId: "rsi_fade",
      side: "SELL",
      confidence: 78,
      reason: "repeatable rsi fade",
      meta: {
        period: 3,
        neutralLevel: 50,
        triggerType: "RSI_FADE",
        anchorType: "SESSION_VWAP",
        patternQuality: 81,
        anchorQuality: 79,
        structureQuality: 76,
        volumeQuality: 62,
        freshness: 85,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const firstCandles = makeCandlesFromCloses([100, 101, 102, 103, 104]);
    const secondCandles = makeCandlesFromCloses([100, 101, 102, 103, 104, 105]);
    const resetCandles = makeCandlesFromCloses(
      [100, 101, 102, 103, 104, 105, 100, 99, 100, 104],
    );

    const first = await evaluateOnCandleClose({
      instrument_token: 888,
      intervalMin: 1,
      candles: firstCandles,
    });
    const second = await evaluateOnCandleClose({
      instrument_token: 888,
      intervalMin: 1,
      candles: secondCandles,
    });
    const afterReset = await evaluateOnCandleClose({
      instrument_token: 888,
      intervalMin: 1,
      candles: resetCandles,
    });

    assert.equal(first?.strategyId, "rsi_fade");
    assert.equal(
      second,
      null,
      "RSI fade should stay suppressed until RSI re-arms through neutral",
    );
    assert.equal(
      afterReset?.strategyId,
      "rsi_fade",
      "RSI fade should re-arm after a real neutral reset",
    );
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine]);
  }
}

function testFingerprintQuality() {
  clearModules([PATHS.signalControls]);
  const { __debug } = require(PATHS.signalControls);

  const context = {
    candles: makeCandlesFromCloses([99, 100, 101], {
      startIso: "2026-01-02T09:15:00+05:30",
    }),
    last: { ts: "2026-01-02T09:17:00+05:30" },
  };

  const orbA = {
    strategyId: "orb",
    side: "BUY",
    meta: {
      sessionDate: "2026-01-02",
      triggerType: "OPENING_RANGE_BREAKOUT",
      orbHigh: 101,
      orbLow: 99,
      orbCompletedAt: "2026-01-02T09:30:00+05:30",
    },
  };
  const orbB = {
    ...orbA,
    meta: {
      ...orbA.meta,
      orbHigh: 102,
    },
  };
  const breakoutA = {
    strategyId: "breakout",
    side: "BUY",
    meta: {
      sessionDate: "2026-01-02",
      triggerType: "SESSION_BREAKOUT",
      rangeHigh: 101,
      rangeLow: 99,
      lookbackUsed: 10,
    },
  };
  const breakoutB = {
    ...breakoutA,
    meta: {
      ...breakoutA.meta,
      rangeHigh: 102,
    },
  };

  assert.equal(
    __debug.buildFingerprint(orbA, context),
    __debug.buildFingerprint({ ...orbA }, context),
  );
  assert.notEqual(
    __debug.buildFingerprint(orbA, context),
    __debug.buildFingerprint(orbB, context),
    "ORB fingerprints should distinguish materially different opening ranges",
  );
  assert.notEqual(
    __debug.buildFingerprint(breakoutA, context),
    __debug.buildFingerprint(breakoutB, context),
    "breakout fingerprints should distinguish different structure ranges",
  );
}

function testMtfAgreementScoring() {
  clearModules([PATHS.signalControls]);

  const {
    decorateSignalCandidate,
    rememberFiredSignal,
    resetSignalLayerState,
  } = require(PATHS.signalControls);

  resetSignalLayerState();
  const candles = makeCandlesFromCloses(
    Array.from({ length: 30 }, (_, index) => 100 + index * 0.2),
    { startIso: "2026-01-02T10:00:00+05:30" },
  );
  const last = candles[candles.length - 1];

  const higher = decorateSignalCandidate(
    {
      strategyId: "breakout",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 84,
      reason: "3m aligned",
      meta: {
        triggerType: "SESSION_BREAKOUT",
        anchorType: "SESSION_RANGE",
        patternQuality: 92,
        anchorQuality: 86,
        structureQuality: 88,
        volumeQuality: 78,
        freshness: 90,
      },
    },
    {
      instrument_token: 444,
      intervalMin: 3,
      candles,
      last,
      stage: "close",
    },
  );
  rememberFiredSignal(higher, {
    instrument_token: 444,
    intervalMin: 3,
    candles,
    last,
    stage: "close",
  });

  const aligned = decorateSignalCandidate(
    {
      strategyId: "ema_pullback",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 80,
      reason: "1m aligned",
      meta: {
        triggerType: "EMA_RECLAIM",
        anchorType: "EMA_FAST",
        patternQuality: 84,
        anchorQuality: 80,
        structureQuality: 82,
        volumeQuality: 68,
        freshness: 86,
      },
    },
    {
      instrument_token: 444,
      intervalMin: 1,
      candles,
      last,
      stage: "close",
    },
  );
  const conflict = decorateSignalCandidate(
    {
      strategyId: "rsi_fade",
      strategyStyle: "RANGE",
      side: "SELL",
      confidence: 80,
      reason: "1m conflict",
      meta: {
        triggerType: "RSI_FADE",
        anchorType: "SESSION_VWAP",
        patternQuality: 84,
        anchorQuality: 80,
        structureQuality: 82,
        volumeQuality: 55,
        freshness: 86,
      },
    },
    {
      instrument_token: 444,
      intervalMin: 1,
      candles,
      last,
      stage: "close",
    },
  );

  assert.ok(aligned.mtfAgreementScore > conflict.mtfAgreementScore);
  assert.ok(aligned.finalSignalScore > conflict.finalSignalScore);
  assert.equal(aligned.mtfBias, "ALIGNED");
  assert.equal(conflict.mtfBias, "CONFLICT");
}

function testSelectorCompressedTrendAndSessionVwap() {
  const { env } = require(PATHS.config);
  const { detectRegime, pickStrategies } = require(PATHS.selector);

  const envRestore = patchObject(env, {
    CANDLE_TZ: "Asia/Kolkata",
    MARKET_OPEN: "09:15",
    SELECTOR_OPEN_WINDOW_MIN: 20,
    SELECTOR_FAST_EMA: 9,
    SELECTOR_SLOW_EMA: 21,
    SELECTOR_RANGE_LOOKBACK: 30,
    SELECTOR_ATR_PERIOD: 14,
    SELECTOR_TREND_DIFF_ATR: 3,
    SELECTOR_RANGE_PCT_MAX: 0.006,
    SELECTOR_RANGE_DIFF_ATR_MAX: 0.25,
    STRATEGIES: "ema_cross",
    STRATEGIES_TREND: "breakout",
    STRATEGIES_RANGE: "rsi_fade",
    STRATEGIES_TREND_COMPRESSED: "ema_pullback",
    STRATEGIES_BREAKOUT_WATCH: "breakout",
  });

  try {
    const priorSession = [
      makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 110, 110.2, 109.8, 110, 5000),
      makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 110, 110.2, 109.8, 110, 5000),
      makeCandle(Date.parse("2026-01-01T15:12:00+05:30"), 110, 110.2, 109.8, 110, 5000),
    ];
    const startMs = Date.parse("2026-01-02T11:00:00+05:30");
    const closes = Array.from({ length: 30 }, (_, index) => 100 + index * 0.05);
    const currentSession = closes.map((close, index) => {
      const prevClose = index > 0 ? closes[index - 1] : close - 0.02;
      return makeCandle(
        startMs + index * 60_000,
        prevClose,
        Math.max(prevClose, close) + 0.03,
        Math.min(prevClose, close) - 0.03,
        close,
        100,
      );
    });
    const candles = [...priorSession, ...currentSession];
    const now = new Date(candles[candles.length - 1].ts);

    const regime = detectRegime({ candles, env, now });
    const picked = pickStrategies({ candles, env, now });

    assert.equal(
      regime.regime,
      "TREND_COMPRESSED",
      "compressed bullish grind should not be forced into RANGE",
    );
    assert.equal(regime.primaryRegime, "TREND_COMPRESSED");
    assert.ok(
      Number(regime.regimeWeights.TREND_COMPRESSED ?? 0) >
        Number(regime.regimeWeights.RANGE ?? 0),
    );
    assert.ok(
      Number(regime.regimeWeights.BREAKOUT_WATCH ?? 0) > 0.15,
      "compressed grind should retain meaningful breakout-watch participation",
    );
    assert.equal(picked.regime, "TREND_COMPRESSED");
    assert.ok(
      picked.strategyIds.includes("ema_pullback"),
      "primary TREND_COMPRESSED strategies should participate",
    );
    assert.ok(
      picked.strategyIds.includes("breakout"),
      "secondary breakout-watch participation should still route its strategies",
    );
    assert.ok(
      Number(picked.strategyWeights.ema_pullback ?? 0) >
        Number(picked.strategyWeights.breakout ?? 0),
      "primary regime strategies should carry more weight than the secondary bucket",
    );
  } finally {
    envRestore();
  }
}

function testSelectorSessionPhaseBuckets() {
  const { env } = require(PATHS.config);
  const { pickStrategies } = require(PATHS.selector);

  const envRestore = patchObject(env, {
    CANDLE_TZ: "Asia/Kolkata",
    MARKET_OPEN: "09:15",
    MARKET_CLOSE: "15:30",
    STRATEGIES: "ema_cross",
    STRATEGIES_OPEN: "orb",
    STRATEGIES_OPEN_INIT: "breakout",
    SELECTOR_OPEN_WINDOW_MIN: 20,
  });

  try {
    const candles = makeCandlesFromCloses([100, 101, 102, 103], {
      startIso: "2026-01-02T09:15:00+05:30",
    });
    const picked = pickStrategies({
      candles,
      env,
      now: new Date(candles[candles.length - 1].ts),
    });

    assert.equal(picked.regime, "OPEN");
    assert.equal(picked.meta.sessionPhase, "OPEN_INIT");
    assert.ok(
      picked.strategyIds.includes("breakout"),
      "phase-specific OPEN_INIT mappings should merge in deterministically",
    );
  } finally {
    envRestore();
  }
}

function testSessionContextHelpers() {
  const { sessionContextSummary } = require(PATHS.strategyUtils);

  const candles = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 99, 100, 98, 100, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 100, 101, 99, 101, 5000),
    makeCandle(Date.parse("2026-01-02T09:15:00+05:30"), 103, 104, 102, 103.5, 100),
    makeCandle(Date.parse("2026-01-02T09:20:00+05:30"), 103.5, 105, 103, 104.5, 120),
    makeCandle(Date.parse("2026-01-02T09:25:00+05:30"), 104.5, 105.5, 104, 105, 140),
  ];

  const summary = sessionContextSummary(candles, {
    endTs: candles[candles.length - 1].ts,
    orbMinutes: 15,
  });

  assert.equal(summary.previousClose, 101);
  assert.equal(summary.gapContext.direction, "UP");
  assert.equal(summary.gapContext.sizeBucket, "LARGE");
  assert.equal(summary.currentSession.high, 105.5);
  assert.equal(summary.previousSession.high, 101);
  assert.equal(summary.openingRange.high, 105.5);
  assert.equal(summary.openingRange.low, 102);
  assert.equal(summary.sessionElapsedMin, 10);
}

function testRsiFadeUsesSessionVwap() {
  const { rsiFadeStrategy } = require(PATHS.rsiFadeStrategy);

  const priorSession = [
    makeCandle(Date.parse("2026-01-01T15:10:00+05:30"), 200, 201, 199, 200, 5000),
    makeCandle(Date.parse("2026-01-01T15:11:00+05:30"), 200, 201, 199, 200, 5000),
    makeCandle(Date.parse("2026-01-01T15:12:00+05:30"), 200, 201, 199, 200, 5000),
  ];
  const currentSession = makeCandlesFromCloses(
    [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 110.4],
    {
      startIso: "2026-01-02T09:15:00+05:30",
    },
  );

  const signal = rsiFadeStrategy({
    candles: [...priorSession, ...currentSession],
    period: 3,
    ob: 70,
    os: 30,
    vwapLookback: 120,
  });

  assert.equal(
    signal?.side,
    "SELL",
    "prior-session candles should not pollute the session VWAP anchor for RSI fade rejection sequences",
  );
  assert.equal(signal?.meta?.anchor, "SESSION_VWAP");
}

function testRsiDeterminism() {
  const { rsi } = require(PATHS.strategyUtils);

  const mixed = makeCandlesFromCloses(
    [100, 101, 100.5, 102, 101.2, 102.8, 102.1, 103.2, 102.7, 104.0, 103.4, 104.6, 104.1, 105.0, 104.7, 105.4],
  );
  const first = rsi(mixed, 14);
  const second = rsi(mixed, 14);
  assert.equal(first, second, "RSI should be stable and deterministic");

  const upOnly = rsi(
    makeCandlesFromCloses(Array.from({ length: 20 }, (_, index) => 100 + index)),
    14,
  );
  const downOnly = rsi(
    makeCandlesFromCloses(Array.from({ length: 20 }, (_, index) => 100 - index)),
    14,
  );
  assert.equal(upOnly, 100);
  assert.ok(downOnly < 1);
}

function testNativeSetupEvaluators() {
  const { evaluateBreakoutSetup } = require(PATHS.breakoutStrategy);
  const { evaluateVwapReclaimSetup } = require(PATHS.vwapReclaimStrategy);
  const { evaluateRsiFadeSetup } = require(PATHS.rsiFadeStrategy);
  const { evaluateEmaPullbackSetup } = require(PATHS.emaPullbackStrategy);

  const breakoutWatch = evaluateBreakoutSetup({
    candles: makeCandlesFromCloses([100, 100.2, 100.4, 100.55], {
      highs: [100.3, 100.45, 100.6, 100.62],
      volumes: [100, 100, 100, 120],
    }),
    lookback: 20,
    volLookback: 3,
    volMult: 1.2,
  });
  assert.equal(breakoutWatch?.setupState, "armed");
  assert.equal(breakoutWatch?.actionable, false);

  const breakoutTrigger = evaluateBreakoutSetup({
    candles: makeCandlesFromCloses([100, 100.2, 100.4, 101.0], {
      highs: [100.3, 100.45, 100.6, 101.1],
      volumes: [100, 100, 100, 240],
    }),
    lookback: 20,
    volLookback: 3,
    volMult: 1.2,
  });
  assert.equal(breakoutTrigger?.setupState, "triggered");
  assert.equal(breakoutTrigger?.actionable, true);

  const vwapHold = evaluateVwapReclaimSetup({
    candles: makeCandlesFromCloses([100, 101, 102, 103, 104, 105, 106], {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 100, 110, 110, 120, 120, 130],
    }),
    fast: 3,
    slow: 5,
    volLookback: 3,
    volMult: 1.0,
  });
  assert.equal(vwapHold?.setupState, "confirmed");
  assert.equal(vwapHold?.actionable, false);
  assert.equal(vwapHold?.candidate?.meta?.triggerType, "VWAP_HOLD_ABOVE");

  const rsiWatch = evaluateRsiFadeSetup({
    candles: makeCandlesFromCloses([110, 108, 106, 104, 102, 100, 98], {
      startIso: "2026-01-02T09:15:00+05:30",
    }),
    period: 3,
    ob: 70,
    os: 30,
  });
  assert.equal(rsiWatch?.setupState, "armed");
  assert.equal(rsiWatch?.actionable, false);

  const emaWatch = evaluateEmaPullbackSetup({
    candles: makeCandlesFromCloses([100, 101, 102, 103, 104, 102.5, 102.7], {
      startIso: "2026-01-02T09:15:00+05:30",
      volumes: [100, 100, 100, 100, 100, 110, 110],
    }),
    fast: 3,
    slow: 5,
    pullbackBars: 3,
    volLookback: 3,
    volMult: 1.0,
  });
  assert.equal(emaWatch?.setupState, "armed");
  assert.equal(emaWatch?.actionable, false);
}

function testSecondaryStrategySetupEngines() {
  const { evaluateVolumeSpikeSetup } = require(PATHS.volumeSpikeStrategy);
  const {
    evaluateBollingerSqueezeSetup,
  } = require(PATHS.bollingerSqueezeStrategy);
  const { evaluateEmaCrossSetup } = require(PATHS.emaCrossStrategy);

  const continuationWatch = evaluateVolumeSpikeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T09:15:00+05:30"), 100, 100.04, 99.98, 100.02, 100),
      makeCandle(Date.parse("2026-01-02T09:16:00+05:30"), 100.02, 100.06, 100.0, 100.03, 105),
      makeCandle(Date.parse("2026-01-02T09:17:00+05:30"), 100.03, 100.07, 100.01, 100.04, 110),
      makeCandle(Date.parse("2026-01-02T09:18:00+05:30"), 100.04, 100.08, 100.02, 100.05, 115),
      makeCandle(Date.parse("2026-01-02T09:19:00+05:30"), 100.05, 100.22, 100.04, 100.2, 360),
    ],
    volLookback: 3,
    volMult: 1.5,
    bodyFrac: 0.6,
  });
  assert.equal(continuationWatch?.setupState, "armed");
  assert.equal(continuationWatch?.candidate?.meta?.triggerType, "VOLUME_CONTINUATION_WATCH");
  assert.equal(continuationWatch?.candidate?.meta?.spikeFamily, "CONTINUATION");

  const continuationTrigger = evaluateVolumeSpikeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T09:16:00+05:30"), 100.02, 100.06, 100.0, 100.03, 105),
      makeCandle(Date.parse("2026-01-02T09:17:00+05:30"), 100.03, 100.07, 100.01, 100.04, 110),
      makeCandle(Date.parse("2026-01-02T09:18:00+05:30"), 100.04, 100.08, 100.02, 100.05, 115),
      makeCandle(Date.parse("2026-01-02T09:19:00+05:30"), 100.05, 100.22, 100.04, 100.2, 360),
      makeCandle(Date.parse("2026-01-02T09:20:00+05:30"), 100.2, 100.32, 100.18, 100.29, 220),
    ],
    volLookback: 3,
    volMult: 1.5,
    bodyFrac: 0.6,
    priorState: {
      side: "BUY",
      triggerType: "VOLUME_CONTINUATION_WATCH",
      triggerLevel: 100.22,
      anchorValue: 100.13,
      volumeRatio: 3.1,
    },
  });
  assert.equal(continuationTrigger?.setupState, "triggered");
  assert.equal(continuationTrigger?.candidate?.meta?.triggerType, "VOLUME_CONTINUATION");
  assert.equal(continuationTrigger?.candidate?.side, "BUY");

  const exhaustionWatch = evaluateVolumeSpikeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T10:00:00+05:30"), 99.8, 100.4, 99.6, 100, 100),
      makeCandle(Date.parse("2026-01-02T10:01:00+05:30"), 100.2, 101.4, 100.0, 101, 120),
      makeCandle(Date.parse("2026-01-02T10:02:00+05:30"), 101.2, 102.5, 101.0, 102, 130),
      makeCandle(Date.parse("2026-01-02T10:03:00+05:30"), 102.1, 103.6, 101.9, 103, 140),
      makeCandle(Date.parse("2026-01-02T10:04:00+05:30"), 104.2, 106.2, 104.0, 106, 500),
    ],
    volLookback: 3,
    volMult: 1.5,
    bodyFrac: 0.6,
  });
  assert.equal(exhaustionWatch?.setupState, "armed");
  assert.equal(exhaustionWatch?.candidate?.meta?.triggerType, "VOLUME_EXHAUSTION_WATCH");
  assert.equal(exhaustionWatch?.candidate?.meta?.spikeFamily, "EXHAUSTION");

  const squeezeArmed = evaluateBollingerSqueezeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T11:00:00+05:30"), 99.99, 100.02, 99.98, 100, 100),
      makeCandle(Date.parse("2026-01-02T11:01:00+05:30"), 100, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:02:00+05:30"), 100.01, 100.04, 100.0, 100.02, 100),
      makeCandle(Date.parse("2026-01-02T11:03:00+05:30"), 100.02, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:04:00+05:30"), 100.01, 100.035, 99.995, 100.015, 100),
      makeCandle(Date.parse("2026-01-02T11:05:00+05:30"), 100.015, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:06:00+05:30"), 100.01, 100.032, 99.992, 100.012, 100),
      makeCandle(Date.parse("2026-01-02T11:07:00+05:30"), 100.012, 100.03, 99.994, 100.011, 100),
    ],
    period: 5,
    std: 1,
    squeezePct: 0.004,
    volLookback: 3,
    volMult: 1.1,
  });
  assert.equal(squeezeArmed?.setupState, "armed");
  assert.equal(squeezeArmed?.candidate?.meta?.triggerType, "SQUEEZE_ARMED");

  const squeezeTrigger = evaluateBollingerSqueezeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T11:00:00+05:30"), 99.99, 100.02, 99.98, 100, 100),
      makeCandle(Date.parse("2026-01-02T11:01:00+05:30"), 100, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:02:00+05:30"), 100.01, 100.04, 100.0, 100.02, 100),
      makeCandle(Date.parse("2026-01-02T11:03:00+05:30"), 100.02, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:04:00+05:30"), 100.01, 100.035, 99.995, 100.015, 100),
      makeCandle(Date.parse("2026-01-02T11:05:00+05:30"), 100.015, 100.03, 99.99, 100.01, 100),
      makeCandle(Date.parse("2026-01-02T11:06:00+05:30"), 100.01, 100.032, 99.992, 100.012, 100),
      makeCandle(Date.parse("2026-01-02T11:07:00+05:30"), 100.012, 100.45, 100.0, 100.4, 260),
    ],
    period: 5,
    std: 1,
    squeezePct: 0.004,
    volLookback: 3,
    volMult: 1.1,
    priorState: {
      triggerType: "SQUEEZE_ARMED",
      setupState: "armed",
      candidateAgeBars: 1,
    },
  });
  assert.equal(squeezeTrigger?.setupState, "triggered");
  assert.equal(squeezeTrigger?.candidate?.meta?.triggerType, "SQUEEZE_BREAKOUT");

  const squeezeExpired = evaluateBollingerSqueezeSetup({
    candles: [
      makeCandle(Date.parse("2026-01-02T11:30:00+05:30"), 100, 100.3, 99.7, 100, 120),
      makeCandle(Date.parse("2026-01-02T11:31:00+05:30"), 100, 100.8, 99.8, 100.5, 120),
      makeCandle(Date.parse("2026-01-02T11:32:00+05:30"), 100.5, 100.7, 99.2, 99.5, 120),
      makeCandle(Date.parse("2026-01-02T11:33:00+05:30"), 99.5, 100.7, 99.3, 100.4, 120),
      makeCandle(Date.parse("2026-01-02T11:34:00+05:30"), 100.4, 100.6, 99.3, 99.6, 120),
      makeCandle(Date.parse("2026-01-02T11:35:00+05:30"), 99.6, 100.55, 99.4, 100.3, 120),
      makeCandle(Date.parse("2026-01-02T11:36:00+05:30"), 100.3, 100.5, 99.4, 99.7, 120),
      makeCandle(Date.parse("2026-01-02T11:37:00+05:30"), 99.7, 100.25, 99.55, 100.0, 120),
    ],
    period: 5,
    std: 1,
    squeezePct: 0.004,
    volLookback: 3,
    volMult: 1.1,
    priorState: {
      triggerType: "SQUEEZE_ARMED",
      setupState: "armed",
      side: "BUY",
      triggerLevel: 100.12,
      candidateAgeBars: 5,
    },
  });
  assert.equal(squeezeExpired?.setupState, "expired");
  assert.equal(squeezeExpired?.candidate?.meta?.triggerType, "SQUEEZE_STALE");

  const emaCrossTrigger = evaluateEmaCrossSetup({
    candles: makeCandlesFromCloses([101, 100.8, 100.5, 100.4, 100.7, 101.3], {
      startIso: "2026-01-02T12:00:00+05:30",
    }),
    fast: 2,
    slow: 4,
  });
  assert.equal(emaCrossTrigger?.setupState, "triggered");
  assert.equal(emaCrossTrigger?.candidate?.meta?.triggerType, "EMA_BULL_CROSS");

  const emaCrossConfirmed = evaluateEmaCrossSetup({
    candles: makeCandlesFromCloses([100, 100.2, 100.4, 100.6, 100.8, 101.0, 101.2], {
      startIso: "2026-01-02T12:10:00+05:30",
    }),
    fast: 2,
    slow: 4,
    priorState: {
      triggerType: "EMA_BULL_CROSS",
      side: "BUY",
      lastSeenTs: Date.parse("2026-01-02T12:15:00+05:30"),
    },
  });
  assert.equal(emaCrossConfirmed?.setupState, "confirmed");
  assert.equal(emaCrossConfirmed?.candidate?.meta?.triggerType, "EMA_BULL_CROSS_HOLD");
}

function testMtfUsesLiveActiveCandidateContext() {
  clearModules([PATHS.signalControls]);
  const {
    decorateSignalCandidate,
    applySetupLifecycle,
    resetSignalLayerState,
  } = require(PATHS.signalControls);

  const makeLowerCandidate = (context) =>
    decorateSignalCandidate(
      {
        strategyId: "ema_pullback",
        strategyStyle: "TREND",
        side: "BUY",
        confidence: 76,
        actionable: true,
        reason: "1m continuation",
        meta: {
          triggerType: "EMA_RECLAIM",
          anchorType: "EMA_FAST",
          patternQuality: 80,
          anchorQuality: 78,
          structureQuality: 82,
          volumeQuality: 66,
          freshness: 84,
        },
      },
      context,
    );

  const confirmedCandles = makeCandlesFromCloses(
    Array.from({ length: 20 }, (_, index) => 100 + index * 0.2),
    { startIso: "2026-01-02T10:00:00+05:30" },
  );
  const confirmedContext = {
    instrument_token: 4444,
    intervalMin: 3,
    candles: confirmedCandles,
    last: confirmedCandles[confirmedCandles.length - 1],
    stage: "close",
  };
  const lowerContext = {
    instrument_token: 4444,
    intervalMin: 1,
    candles: confirmedCandles,
    last: confirmedCandles[confirmedCandles.length - 1],
    stage: "close",
  };

  resetSignalLayerState();
  const baseline = makeLowerCandidate(lowerContext);

  const confirmedHigher = decorateSignalCandidate(
    {
      strategyId: "breakout",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 80,
      actionable: false,
      reason: "3m active breakout watch",
      meta: {
        setupState: "armed",
        triggerType: "SESSION_BREAKOUT_WATCH",
        anchorType: "SESSION_RANGE",
        patternQuality: 82,
        anchorQuality: 80,
        structureQuality: 84,
        volumeQuality: 70,
        freshness: 86,
      },
    },
    confirmedContext,
  );
  applySetupLifecycle(confirmedHigher, confirmedContext);
  const confirmedAligned = makeLowerCandidate(lowerContext);

  resetSignalLayerState();
  const previewHigher = decorateSignalCandidate(
    {
      strategyId: "breakout",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 80,
      actionable: false,
      reason: "3m preview breakout watch",
      meta: {
        setupState: "armed",
        triggerType: "SESSION_BREAKOUT_WATCH",
        anchorType: "SESSION_RANGE",
        patternQuality: 82,
        anchorQuality: 80,
        structureQuality: 84,
        volumeQuality: 70,
        freshness: 86,
      },
    },
    { ...confirmedContext, stage: "tick" },
  );
  applySetupLifecycle(previewHigher, { ...confirmedContext, stage: "tick" });
  const previewAligned = makeLowerCandidate(lowerContext);

  resetSignalLayerState();
  const staleCandles = makeCandlesFromCloses(
    Array.from({ length: 20 }, (_, index) => 100 + index * 0.15),
    { startIso: "2026-01-02T09:20:00+05:30" },
  );
  const staleContext = {
    instrument_token: 4444,
    intervalMin: 3,
    candles: staleCandles,
    last: staleCandles[staleCandles.length - 1],
    stage: "close",
  };
  const staleHigher = decorateSignalCandidate(
    {
      strategyId: "breakout",
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 80,
      actionable: false,
      reason: "stale 3m watch",
      meta: {
        setupState: "armed",
        triggerType: "SESSION_BREAKOUT_WATCH",
        anchorType: "SESSION_RANGE",
        patternQuality: 82,
        anchorQuality: 80,
        structureQuality: 84,
        volumeQuality: 70,
        freshness: 86,
      },
    },
    staleContext,
  );
  applySetupLifecycle(staleHigher, staleContext);
  const lateCandles = makeCandlesFromCloses(
    Array.from({ length: 20 }, (_, index) => 110 + index * 0.1),
    { startIso: "2026-01-02T12:00:00+05:30" },
  );
  const staleCheck = makeLowerCandidate({
    instrument_token: 4444,
    intervalMin: 1,
    candles: lateCandles,
    last: lateCandles[lateCandles.length - 1],
    stage: "close",
  });

  assert.ok(
    confirmedAligned.mtfAgreementScore > baseline.mtfAgreementScore,
    "active higher-interval setup context should help aligned lower-interval scoring even before a winner is selected",
  );
  assert.ok(
    confirmedAligned.mtfAgreementScore > previewAligned.mtfAgreementScore,
    "confirmed higher-interval setups should weigh more than provisional previews",
  );
  assert.ok(
    staleCheck.mtfAgreementScore <= confirmedAligned.mtfAgreementScore,
    "stale active setup context should decay instead of behaving like fresh alignment",
  );
}

async function testPipelinePreviewBoundary() {
  clearModules([PATHS.pipeline]);

  const strategyEngineModule = require(PATHS.strategyEngine);
  const previewSignals = [];
  const actionableSignals = [];
  let tickCalls = 0;

  const strategyRestore = patchObject(strategyEngineModule, {
    evaluateOnCandleTick: async () => {
      tickCalls += 1;
      if (tickCalls !== 1) return null;
      return {
        strategyId: "orb",
        strategyStyle: "OPEN",
        side: "BUY",
        confidence: 76,
        reason: "preview breakout",
        signalStage: "tick_preview",
        isProvisional: true,
        candleClosed: false,
        setupId: "orb:preview-1",
        meta: {
          setupId: "orb:preview-1",
          triggerType: "OPENING_RANGE_BREAKOUT",
          anchorType: "OPENING_RANGE",
        },
      };
    },
    evaluateOnCandleClose: async () => ({
      strategyId: "orb",
      strategyStyle: "OPEN",
      side: "BUY",
      confidence: 79,
      reason: "confirmed breakout",
      signalStage: "bar_close_confirmed",
      isProvisional: false,
      candleClosed: true,
      setupId: "orb:preview-1",
      setupLineage: "preview_to_confirmed",
      meta: {
        setupId: "orb:preview-1",
        setupLineage: "preview_to_confirmed",
        triggerType: "OPENING_RANGE_BREAKOUT",
        anchorType: "OPENING_RANGE",
      },
    }),
    resetSignalLayerState: () => {},
  });

  class BoundaryCandleBuilder {
    addIndexTokens() {}

    onTicks(ticks) {
      const tick = ticks?.[0];
      if (!tick) return [];
      const ts = new Date(tick.ts || "2026-01-02T09:20:00+05:30");
      this.current = {
        instrument_token: Number(tick.instrument_token),
        interval_min: 1,
        ts,
        open: Number(tick.last_price ?? 100) - 0.2,
        high: Number(tick.last_price ?? 100) + 0.3,
        low: Number(tick.last_price ?? 100) - 0.4,
        close: Number(tick.last_price ?? 100),
        volume: 120,
        source: "live",
      };
      return tick.closeNow ? [{ ...this.current }] : [];
    }

    finalizeDue() {
      return [];
    }

    getCurrentCandle() {
      return this.current || null;
    }
  }

  class BoundaryCandleCache {
    addCandles() {}

    addCandle(candle) {
      this.last = candle;
    }

    getCandles() {
      return this.last ? [this.last] : [];
    }
  }

  class BoundaryTradeManager {
    setRuntimeAddTokens() {}
    async init() {}
    onTick() {}
    async onSignal(signal) {
      actionableSignals.push(signal);
    }
    async onSignalPreview(signal) {
      previewSignals.push(signal);
    }
    async onOrderUpdate() {}
    async reconcile() { return { ok: true }; }
    async positionFirstReconcile() { return { ok: true }; }
    async setKillSwitch() {}
    async status() { return { ok: true }; }
    async stop() {}
  }

  const harness = loadPipelineHarness({
    envOverrides: {
      SIGNAL_INTERVALS: "1",
      SIGNAL_TICK_CONFIRM_ENABLED: "true",
      SIGNAL_PREVIEW_EMIT: "true",
      SIGNAL_PREVIEW_ACTIONABLE: "false",
      STRATEGIES: "orb",
      TELEMETRY_ENABLED: "false",
    },
    candleBuilderClass: BoundaryCandleBuilder,
    candleCacheClass: BoundaryCandleCache,
    tradeManagerClass: BoundaryTradeManager,
  });

  let pipeline;
  try {
    pipeline = harness.buildPipeline({ kite: {}, tickerCtrl: {} });
    await pipeline.initForTokens([333], { signalTokens: [333] });

    await pipeline.onTicks([
      {
        instrument_token: 333,
        last_price: 101,
        ts: "2026-01-02T09:20:00+05:30",
      },
    ]);

    assert.equal(previewSignals.length, 1);
    assert.equal(actionableSignals.length, 0);
    assert.equal(previewSignals[0].signalStage, "tick_preview");

    await pipeline.onTicks([
      {
        instrument_token: 333,
        last_price: 102,
        ts: "2026-01-02T09:21:00+05:30",
        closeNow: true,
      },
    ]);

    assert.equal(previewSignals.length, 1);
    assert.equal(actionableSignals.length, 1);
    assert.equal(actionableSignals[0].signalStage, "bar_close_confirmed");
    assert.equal(actionableSignals[0].setupLineage, "preview_to_confirmed");
  } finally {
    await pipeline?.stop?.();
    harness.restore();
    strategyRestore();
    clearModules([PATHS.pipeline]);
  }
}

async function testWeightedSelectorSignalIntegration() {
  clearModules([PATHS.strategyEngine]);

  const { env } = require(PATHS.config);
  const selectorModule = require(PATHS.selector);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_pullback,breakout",
    STRATEGY_SELECTOR_ENABLED: "true",
    TELEMETRY_ENABLED: "false",
  });
  const selectorRestore = patchObject(selectorModule, {
    pickStrategies: () => ({
      regime: "TREND_COMPRESSED",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "BREAKOUT_WATCH",
      regimeWeights: {
        TREND_COMPRESSED: 0.58,
        BREAKOUT_WATCH: 0.27,
        TREND: 0.1,
        RANGE: 0.05,
      },
      strategyIds: ["ema_pullback", "breakout"],
      strategyWeights: {
        ema_pullback: 0.78,
        breakout: 0.31,
      },
      meta: {
        sessionPhase: "MIDDAY_COMPRESSION",
        primaryRegime: "TREND_COMPRESSED",
        secondaryRegime: "BREAKOUT_WATCH",
        regimeWeights: {
          TREND_COMPRESSED: 0.58,
          BREAKOUT_WATCH: 0.27,
          TREND: 0.1,
          RANGE: 0.05,
        },
        strategyWeights: {
          ema_pullback: 0.78,
          breakout: 0.31,
        },
      },
    }),
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_pullback", "breakout"],
    runStrategy: (id) => ({
      strategyId: id,
      strategyStyle: "TREND",
      side: "BUY",
      confidence: 74,
      reason: `${id} candidate`,
      meta: {
        triggerType: id === "ema_pullback" ? "EMA_RECLAIM" : "SESSION_BREAKOUT",
        anchorType: id === "ema_pullback" ? "EMA_FAST" : "SESSION_RANGE",
        patternQuality: 72,
        anchorQuality: 70,
        structureQuality: 74,
        volumeQuality: 60,
        freshness: 82,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const { evaluateOnCandleClose } = require(PATHS.strategyEngine);
    const candles = makeCandlesFromCloses(
      Array.from({ length: 30 }, (_, index) => 100 + index * 0.08),
      { startIso: "2026-01-02T12:00:00+05:30" },
    );
    const signal = await evaluateOnCandleClose({
      instrument_token: 707,
      intervalMin: 1,
      candles,
    });

    assert.equal(signal?.strategyId, "ema_pullback");
    assert.equal(signal?.primaryRegime, "TREND_COMPRESSED");
    assert.equal(signal?.secondaryRegime, "BREAKOUT_WATCH");
    assert.ok(Number(signal?.regimeWeights?.TREND_COMPRESSED ?? 0) > 0.5);
    assert.ok(Number(signal?.scoreBreakdown?.selectorParticipation ?? 0) > 70);
  } finally {
    storeRestore();
    registryRestore();
    selectorRestore();
    envRestore();
    clearModules([PATHS.strategyEngine]);
  }
}

function testActiveSetupObservability() {
  clearModules([PATHS.signalControls]);

  const {
    decorateSignalCandidate,
    applySetupLifecycle,
    resetSignalLayerState,
    __debug,
  } = require(PATHS.signalControls);

  resetSignalLayerState();
  const candles = makeCandlesFromCloses(
    Array.from({ length: 20 }, (_, index) => 100 + index * 0.15),
    { startIso: "2026-01-02T13:00:00+05:30" },
  );
  const context = {
    instrument_token: 8181,
    intervalMin: 1,
    candles,
    last: candles[candles.length - 1],
    stage: "close",
    regimeMeta: {
      sessionPhase: "MIDDAY_COMPRESSION",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "BREAKOUT_WATCH",
      regimeWeights: {
        TREND_COMPRESSED: 0.61,
        BREAKOUT_WATCH: 0.24,
        RANGE: 0.15,
      },
      strategyWeights: {
        breakout: 0.72,
      },
    },
  };
  const candidate = decorateSignalCandidate(
    {
      strategyId: "breakout",
      strategyStyle: "TREND",
      strategyFamily: "BREAKOUT",
      side: "BUY",
      confidence: 79,
      actionable: false,
      reason: "session breakout arming",
      meta: {
        setupState: "armed",
        triggerType: "SESSION_BREAKOUT_WATCH",
        anchorType: "SESSION_RANGE",
        anchorValue: 102.5,
        triggerLevel: 102.8,
        patternQuality: 81,
        anchorQuality: 78,
        structureQuality: 83,
        volumeQuality: 64,
        freshness: 86,
      },
    },
    context,
  );
  const lifecycle = applySetupLifecycle(candidate, context);
  const snapshot = __debug.getSetupRegistrySnapshot()[0];

  assert.equal(lifecycle.suppress, false);
  assert.ok(snapshot.setupId);
  assert.ok(snapshot.lineageId);
  assert.equal(snapshot.setupState, "armed");
  assert.ok(Number(snapshot.qualityScore ?? 0) > 0);
  assert.ok(Number(snapshot.contextScore ?? 0) > 0);
  assert.ok(Number(snapshot.mtfAgreementScore ?? 0) > 0);
  assert.equal(snapshot.anchorMeta.anchorType, "SESSION_RANGE");
  assert.equal(snapshot.triggerMeta.triggerType, "SESSION_BREAKOUT_WATCH");
  assert.ok(Number(snapshot.regimeWeightsSnapshot?.TREND_COMPRESSED ?? 0) > 0.5);
}

function testScoreCalibrationActivationAndFallback() {
  delete process.env.SIGNAL_SCORE_CALIBRATION_FILE;
  clearModules([PATHS.signalControls, PATHS.scoreCalibration]);

  const candidate = {
    strategyId: "ema_cross",
    strategyStyle: "TREND",
    side: "BUY",
    confidence: 78,
    actionable: true,
    reason: "calibrated score",
    meta: {
      triggerType: "EMA_CROSS",
      anchorType: "EMA_FAST",
      patternQuality: 74,
      anchorQuality: 70,
      structureQuality: 76,
      volumeQuality: 64,
      freshness: 82,
    },
  };
  const candles = makeCandlesFromCloses(
    Array.from({ length: 20 }, (_, index) => 100 + index * 0.2),
  );
  const context = {
    instrument_token: 9999,
    intervalMin: 1,
    candles,
    last: candles[candles.length - 1],
    stage: "close",
  };

  const activeState = require(PATHS.scoreCalibration).describeCalibrationState();
  const activeControls = require(PATHS.signalControls);
  const active = activeControls.decorateSignalCandidate(candidate, context);
  assert.equal(activeState.calibrationActive, true);
  assert.equal(activeState.calibrationVersion, "repo-cal-v1");
  assert.equal(activeState.calibrationSource, "repo:signal_score_calibration.json");
  assert.equal(active.calibrationActive, true);
  assert.equal(active.calibrationSource, "repo:signal_score_calibration.json");
  assert.equal(active.fallbackReason, null);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-cal-"));
  const invalidArtifactPath = path.join(tempDir, "broken_score_calibration.json");
  const artifactPath = path.join(tempDir, "signal_score_calibration.json");
  fs.writeFileSync(invalidArtifactPath, "{ broken json");
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({
      version: "replay-v1",
      source: "artifact:test-fixture",
      strategies: {
        ema_cross: {
          raw: { floor: 65, ceil: 85, shape: 1.0 },
          finalWeights: {
            normalizedConfidence: 0.7,
            qualityScore: 0.15,
            contextScore: 0.15,
          },
          bias: 4,
        },
      },
    }),
  );

  try {
    process.env.SIGNAL_SCORE_CALIBRATION_FILE = invalidArtifactPath;
    clearModules([PATHS.signalControls, PATHS.scoreCalibration]);
    const invalidState = require(PATHS.scoreCalibration).describeCalibrationState();
    const invalidControls = require(PATHS.signalControls);
    const invalid = invalidControls.decorateSignalCandidate(candidate, context);
    const invalidRepeat = invalidControls.decorateSignalCandidate(candidate, context);

    assert.equal(invalidState.calibrationActive, false);
    assert.match(String(invalidState.fallbackReason || ""), /INVALID_ARTIFACT/);
    assert.equal(invalid.calibrationActive, false);
    assert.match(String(invalid.fallbackReason || ""), /INVALID_ARTIFACT/);
    assert.equal(
      invalid.finalSignalScore,
      invalidRepeat.finalSignalScore,
      "fallback scoring should stay deterministic even after invalid calibration loads",
    );

    process.env.SIGNAL_SCORE_CALIBRATION_FILE = artifactPath;
    clearModules([PATHS.signalControls, PATHS.scoreCalibration]);
    const calibratedControls = require(PATHS.signalControls);
    const calibrated = calibratedControls.decorateSignalCandidate(candidate, context);

    assert.equal(calibrated.calibrationVersion, "replay-v1");
    assert.equal(calibrated.calibrationSource, "artifact:test-fixture");
    assert.equal(calibrated.rawConfidence, active.rawConfidence);
    assert.notEqual(
      calibrated.finalSignalScore,
      active.finalSignalScore,
      "calibration artifacts should change deterministic ranking behavior",
    );
  } finally {
    delete process.env.SIGNAL_SCORE_CALIBRATION_FILE;
    clearModules([PATHS.signalControls, PATHS.scoreCalibration]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testSignalSuppressedForStyleRegimeMismatch() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls, PATHS.signalLifecycle]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const selectorModule = require(PATHS.selector);
  const candleStoreModule = require(PATHS.candleStore);
  const { logger } = require(PATHS.logger);
  const captured = [];

  const regimeWeights = {
    TREND_COMPRESSED: 0.72,
    RANGE: 0.18,
    TREND: 0.1,
  };

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "wick_reversal",
    STRATEGY_SELECTOR_ENABLED: "true",
    TELEMETRY_ENABLED: "false",
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["wick_reversal"],
    runStrategy: () => ({
      strategyId: "wick_reversal",
      side: "BUY",
      confidence: 78,
      reason: "counter trend wick",
      meta: {
        triggerType: "WICK_REVERSAL",
        anchorType: "PRICE",
        patternQuality: 82,
        anchorQuality: 80,
        structureQuality: 84,
        volumeQuality: 60,
        freshness: 88,
      },
    }),
  });
  const selectorRestore = patchObject(selectorModule, {
    pickStrategies: () => ({
      regime: "TREND_COMPRESSED",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "RANGE",
      regimeWeights,
      strategyIds: ["wick_reversal"],
      strategyWeights: { wick_reversal: 1 },
      meta: {
        sessionPhase: "REGULAR",
        primaryRegime: "TREND_COMPRESSED",
        secondaryRegime: "RANGE",
        regimeWeights,
        diffInAtr: 0.88,
        rangePct: 0.0042,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });
  const loggerRestore = patchObject(logger, {
    info(payload, message) {
      if (message === "[signal] suppressed (style/regime mismatch)") {
        captured.push({ payload, message });
      }
    },
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const signal = await evaluateOnCandleClose({
      instrument_token: 9001,
      intervalMin: 1,
      candles: makeCandlesFromCloses(
        Array.from({ length: 30 }, (_, index) => 100 + index * 0.15),
      ),
    });

    assert.equal(
      signal,
      null,
      "style/regime mismatches should be suppressed before the signal reaches the live trade path",
    );
    assert.equal(captured.length, 1);
    assert.match(
      captured[0].payload.reasonCode,
      /^SIGNAL_SUPPRESSED_FRAGILE_REVERSAL_/,
    );
    assert.equal(captured[0].payload.strategyStyle, "RANGE");
    assert.equal(captured[0].payload.regime, "TREND_COMPRESSED");
    assert.equal(captured[0].payload.regimeFamily, "TREND");
    assert.equal(captured[0].payload.exceptionChecked, true);
    assert.equal(captured[0].payload.exceptionAllowed, false);
    assert.match(
      captured[0].payload.exceptionReasonCode,
      /^FRAGILE_REVERSAL_/,
    );
    assert.equal(
      captured[0].payload.conversionSummary.styleGateDecision,
      "BLOCK",
    );
  } finally {
    loggerRestore();
    storeRestore();
    selectorRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls, PATHS.signalLifecycle]);
  }
}

function testFrozenRegimeSnapshotResolverPrefersFrozenSnapshot() {
  clearModules([PATHS.signalLifecycle]);

  const {
    freezeSignalRegimeSnapshot,
    resolveSignalRegimeSnapshot,
  } = require(PATHS.signalLifecycle);

  const frozenSnapshot = freezeSignalRegimeSnapshot({
    signal: {
      regime: "TREND_COMPRESSED",
      primaryRegime: "TREND_COMPRESSED",
      secondaryRegime: "RANGE",
      regimeWeights: {
        TREND_COMPRESSED: 0.72,
        RANGE: 0.18,
      },
      regimeMeta: {
        sessionPhase: "REGULAR",
        diffInAtr: 0.91,
        rangePct: 0.0045,
      },
    },
    context: {
      intervalMin: 1,
      stage: "close",
      last: { ts: "2026-01-02T10:15:00+05:30" },
    },
    selectorState: null,
    timestampMs: Date.parse("2026-01-02T10:15:05+05:30"),
  });

  const resolved = resolveSignalRegimeSnapshot({
    signal: {
      signalId: "sig-123",
      regimeSnapshot: frozenSnapshot,
      regime: frozenSnapshot.regime,
    },
    liveDetection: {
      regime: "RANGE",
      primaryRegime: "RANGE",
      secondaryRegime: "TREND",
      regimeWeights: {
        RANGE: 0.8,
        TREND: 0.2,
      },
      meta: {
        sessionPhase: "MIDDAY_COMPRESSION",
      },
    },
    intervalMin: 1,
    nowMs: Date.parse("2026-01-02T10:15:12+05:30"),
    liveTs: "2026-01-02T10:15:00+05:30",
  });

  assert.equal(resolved.snapshot.snapshotId, frozenSnapshot.snapshotId);
  assert.equal(resolved.frozenSnapshot.snapshotId, frozenSnapshot.snapshotId);
  assert.equal(resolved.mismatch, true);
  assert.ok(resolved.mismatchReasons.includes("REGIME"));
  assert.equal(resolved.liveSnapshot.regime, "RANGE");
}

function testExplicitPreEmitProfileCoverage() {
  clearModules([PATHS.signalLifecycle, PATHS.registry]);

  const { env } = require(PATHS.config);
  const { STRATEGY_META } = require(PATHS.registry);
  const {
    resolvePreEmitProfile,
    shouldEmitLiveCandidate,
  } = require(PATHS.signalLifecycle);

  const liveStrategies = [
    "ema_cross",
    "ema_pullback",
    "breakout",
    "vwap_reclaim",
    "orb",
    "bb_squeeze",
    "volume_spike",
    "fakeout",
    "rsi_fade",
    "wick_reversal",
  ];

  for (const strategyId of liveStrategies) {
    const meta = STRATEGY_META[strategyId];
    assert.ok(meta, `missing registry metadata for ${strategyId}`);

    const resolved = resolvePreEmitProfile(
      {
        strategyId,
        strategyStyle: meta.style,
        strategyFamily: meta.family,
        signalStage: "bar_close_confirmed",
        setupState: "triggered",
      },
      env,
    );
    assert.equal(resolved.resolved, true, `${strategyId} should resolve an explicit pre-emit profile`);
    assert.ok(resolved.profileSource, `${strategyId} should expose the resolved profile source`);
    assert.ok(resolved.profileId, `${strategyId} should expose the resolved profile id`);

    const weakGate = shouldEmitLiveCandidate({
      candidate: {
        strategyId,
        strategyStyle: meta.style,
        strategyFamily: meta.family,
        signalStage: "bar_close_confirmed",
        setupState: "forming",
        confidence: 42,
        rawConfidence: 42,
        normalizedConfidence: 50,
        qualityScore: 48,
        contextScore: 49,
        finalSignalScore: 50,
        mtfAgreementScore: 42,
        freshness: 45,
        stageScore: 82,
      },
      env,
    });
    assert.equal(weakGate.emit, false, `${strategyId} weak signal should be suppressed pre-emit`);
    assert.ok(
      Array.isArray(weakGate.suppressionReasons) && weakGate.suppressionReasons.length > 0,
      `${strategyId} weak signal should expose stable suppression reasons`,
    );

    const strongGate = shouldEmitLiveCandidate({
      candidate: {
        strategyId,
        strategyStyle: meta.style,
        strategyFamily: meta.family,
        signalStage: "bar_close_confirmed",
        setupState: "triggered",
        confidence: 82,
        rawConfidence: 82,
        normalizedConfidence: 79,
        qualityScore: 81,
        contextScore: 80,
        finalSignalScore: 83,
        mtfAgreementScore: 71,
        freshness: 88,
        stageScore: 94,
      },
      env,
    });
    assert.equal(strongGate.emit, true, `${strategyId} strong confirmed signal should pass pre-emit gating`);
  }

  const missingProfile = shouldEmitLiveCandidate({
    candidate: {
      strategyId: "unknown_strategy",
      strategyStyle: "TREND",
      strategyFamily: "TREND",
      signalStage: "bar_close_confirmed",
      setupState: "triggered",
      confidence: 90,
      rawConfidence: 90,
      normalizedConfidence: 90,
      qualityScore: 90,
      contextScore: 90,
      finalSignalScore: 90,
      mtfAgreementScore: 90,
      freshness: 90,
      stageScore: 94,
    },
    env,
  });
  assert.equal(missingProfile.emit, false);
  assert.equal(missingProfile.suppressionReason, "PREEMIT_PROFILE_MISSING");
}

async function testSignalCaptureCalibrationLoop() {
  clearModules([
    PATHS.strategyEngine,
    PATHS.signalControls,
    PATHS.scoreCalibration,
    PATHS.signalCapture,
    PATHS.buildSignalCalibrationScript,
  ]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-capture-cal-"));
  const artifactPath = path.join(tempDir, "generated_signal_calibration.json");

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_cross",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    MIN_SIGNAL_CONFIDENCE: 60,
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross"],
    runStrategy: () => ({
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 79,
      reason: "calibration loop candidate",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 76,
        anchorQuality: 73,
        structureQuality: 78,
        volumeQuality: 66,
        freshness: 84,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const { createSignalCapture } = require(PATHS.signalCapture);
    const {
      extractCalibrationRecords,
      buildCalibrationArtifactFromRecords,
      writeCalibrationArtifact,
    } = require(PATHS.buildSignalCalibrationScript);
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);

    const capture = createSignalCapture();
    const candles = makeCandlesFromCloses(
      Array.from({ length: 30 }, (_, index) => 100 + index * 0.2),
      { startIso: "2026-01-02T10:00:00+05:30" },
    );

    resetSignalLayerState();
    const signal = await evaluateOnCandleClose({
      instrument_token: 501,
      intervalMin: 1,
      candles,
      createdAtMs: Date.parse("2026-01-02T10:29:45+05:30"),
      recordTelemetry: false,
      signalCapture: capture,
    });

    assert.ok(signal, "engine should produce a captureable signal");
    capture.recordRoutingDecision({
      signal,
      accepted: true,
      routed: true,
      selectedContract: {
        selectedToken: 110501,
        selected: {
          strike: 22350,
          expiryISO: "2026-01-08",
        },
      },
      decisionStage: "backtest_admission",
      decisionOutcome: "ROUTED",
      mode: "OPT",
      underlying: "NIFTY",
    });
    capture.recordTradeOutcome({
      signalOutcomeKey: signal.signalOutcomeKey,
      outcomeScore: 0.82,
      outcome: "WIN",
      pnlR: 1.35,
      mfeR: 1.9,
      maeR: -0.35,
      holdingBucket: "SHORT",
    });
    capture.recordSignal({ strategyId: null, signalOutcomeKey: "invalid|partial" });

    const rows = capture.getRows();
    const selected = rows.find((row) => row.signalOutcomeKey === signal.signalOutcomeKey);
    assert.ok(selected, "signal capture should keep the routed signal row");
    assert.equal(selected.signalEventTs, signal.signalEventTs);
    assert.equal(selected.signalCreatedAt, signal.signalCreatedAt);
    assert.equal(selected.accepted, true);
    assert.equal(selected.routed, true);
    assert.equal(selected.outcome, "WIN");
    assert.ok(selected.patternQuality != null);
    assert.ok(selected.qualityScore != null);
    assert.ok(selected.contextScore != null);
    assert.ok(selected.finalSignalScore != null);
    assert.ok(selected.selectorParticipation != null);
    assert.ok(selected.calibrationSource != null);

    const { records, skipped } = extractCalibrationRecords(rows);
    assert.ok(records.length >= 1, "repo-produced capture rows should build calibration records directly");
    assert.ok(skipped.length >= 1, "invalid partial rows should be skipped without crashing");

    const artifact = buildCalibrationArtifactFromRecords(records, {
      source: "generated:test-signal-capture",
      outputPath: artifactPath,
    });
    assert.ok(artifact.strategies.ema_cross);
    writeCalibrationArtifact(artifact, artifactPath);

    const rawCandidate = {
      strategyId: "ema_cross",
      strategyStyle: "TREND",
      strategyFamily: "TREND",
      side: "BUY",
      confidence: 79,
      actionable: true,
      reason: "calibration loop candidate",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 76,
        anchorQuality: 73,
        structureQuality: 78,
        volumeQuality: 66,
        freshness: 84,
      },
    };
    const baselineContext = {
      instrument_token: 501,
      intervalMin: 1,
      candles,
      last: candles[candles.length - 1],
      stage: "close",
    };

    delete process.env.SIGNAL_SCORE_CALIBRATION_FILE;
    clearModules([PATHS.signalControls, PATHS.scoreCalibration]);
    const baselineControls = require(PATHS.signalControls);
    const baseline = baselineControls.decorateSignalCandidate(rawCandidate, baselineContext);

    process.env.SIGNAL_SCORE_CALIBRATION_FILE = artifactPath;
    clearModules([PATHS.signalControls, PATHS.scoreCalibration]);
    const calibratedControls = require(PATHS.signalControls);
    const calibrated = calibratedControls.decorateSignalCandidate(rawCandidate, baselineContext);

    assert.notEqual(
      calibrated.finalSignalScore,
      baseline.finalSignalScore,
      "capture-built artifacts should change deterministic scoring without reshaping",
    );
  } finally {
    delete process.env.SIGNAL_SCORE_CALIBRATION_FILE;
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([
      PATHS.strategyEngine,
      PATHS.signalControls,
      PATHS.scoreCalibration,
      PATHS.signalCapture,
      PATHS.buildSignalCalibrationScript,
    ]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testSignalStatePersistenceAndRestore() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-state-restore-"));
  const statePath = path.join(tempDir, "signal-layer-state.json");

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "orb",
    ORB_MINUTES: 3,
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    SIGNAL_STATE_PERSIST: "true",
    SIGNAL_STATE_PERSIST_PATH: statePath,
    SIGNAL_STATE_PERSIST_TTL_MIN: 180,
    SIGNAL_STATE_PERSIST_MAX_SETUPS: 500,
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["orb"],
    runStrategy: () => ({
      strategyId: "orb",
      side: "BUY",
      confidence: 82,
      reason: "persistent orb breakout",
      meta: {
        triggerLevel: 100,
        orbHigh: 100,
        orbLow: 98,
        orbMinutes: 3,
        triggerType: "OPENING_RANGE_BREAKOUT",
        anchorType: "OPENING_RANGE",
        patternQuality: 86,
        anchorQuality: 84,
        structureQuality: 83,
        volumeQuality: 74,
        freshness: 89,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    let { evaluateOnCandleClose, resetSignalLayerState } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const firstCandles = makeCandlesFromCloses([98, 99, 100, 101], {
      startIso: "2026-01-02T09:15:00+05:30",
    });
    const secondCandles = makeCandlesFromCloses([98, 99, 100, 101, 102], {
      startIso: "2026-01-02T09:15:00+05:30",
    });

    const first = await evaluateOnCandleClose({
      instrument_token: 771,
      intervalMin: 1,
      candles: firstCandles,
      recordTelemetry: false,
    });
    assert.equal(first?.strategyId, "orb");
    assert.equal(fs.existsSync(statePath), true, "persistence should flush state to disk");

    clearModules([PATHS.strategyEngine, PATHS.signalControls]);
    ({ evaluateOnCandleClose } = require(PATHS.strategyEngine));
    const second = await evaluateOnCandleClose({
      instrument_token: 771,
      intervalMin: 1,
      candles: secondCandles,
      recordTelemetry: false,
    });
    assert.equal(
      second,
      null,
      "duplicate suppression continuity should survive a process restart",
    );

    const { getSignalLayerStateSnapshot } = require(PATHS.signalControls);
    const snapshot = getSignalLayerStateSnapshot();
    assert.equal(snapshot.persistence.persistenceMode, "file");
    assert.match(String(snapshot.persistence.restoreSource || ""), /^file:/);
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testSignalStatePersistencePrunesStaleEntries() {
  clearModules([PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-state-prune-"));
  const statePath = path.join(tempDir, "signal-layer-state.json");
  const staleTs = Date.parse("2025-01-01T09:15:00Z");
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        version: 1,
        savedAt: "2026-01-02T09:20:00Z",
        setupRegistry: [
          {
            key: "771:1:orb:BUY:stale",
            token: 771,
            intervalMin: 1,
            strategyId: "orb",
            strategyStyle: "OPEN",
            strategyFamily: "OPEN",
            side: "BUY",
            setupState: "armed",
            status: "armed",
            lastSeenTs: staleTs,
            lastCandleTs: staleTs,
            ttlMs: 60_000,
            lastSignalStage: "tick_preview",
          },
        ],
        intervalSnapshots: [
          {
            key: "771:1",
            token: 771,
            intervalMin: 1,
            ts: staleTs,
            side: "BUY",
            strategyId: "orb",
            strategyStyle: "OPEN",
            strategyFamily: "OPEN",
            setupState: "armed",
            status: "armed",
          },
        ],
      },
      null,
      2,
    ),
  );

  const envRestore = patchObject(env, {
    SIGNAL_STATE_PERSIST: "true",
    SIGNAL_STATE_PERSIST_PATH: statePath,
    SIGNAL_STATE_PERSIST_TTL_MIN: 1,
    SIGNAL_STATE_PERSIST_MAX_SETUPS: 500,
  });

  try {
    const { getSignalLayerStateSnapshot } = require(PATHS.signalControls);
    const snapshot = getSignalLayerStateSnapshot();
    assert.equal(snapshot.setupRegistry.length, 0);
    assert.equal(snapshot.intervalSnapshots.length, 0);
    assert.ok(Number(snapshot.persistence.prunedSetupCount ?? 0) >= 1);
  } finally {
    envRestore();
    clearModules([PATHS.signalControls]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testSignalStatePersistenceFallbackToMemory() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signal-state-fallback-"));

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_cross",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    SIGNAL_STATE_PERSIST: "true",
    SIGNAL_STATE_PERSIST_PATH: tempDir,
    SIGNAL_STATE_PERSIST_TTL_MIN: 180,
    SIGNAL_STATE_PERSIST_MAX_SETUPS: 500,
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross"],
    runStrategy: () => ({
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 82,
      reason: "fallback still works",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 78,
        anchorQuality: 75,
        structureQuality: 80,
        volumeQuality: 68,
        freshness: 85,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const signal = await evaluateOnCandleClose({
      instrument_token: 772,
      intervalMin: 1,
      candles: makeCandlesFromCloses(
        Array.from({ length: 30 }, (_, index) => 100 + index * 0.1),
      ),
      recordTelemetry: false,
    });
    assert.ok(signal, "memory fallback should not break signal generation");

    const { describeSignalLayerPersistence } = require(PATHS.signalControls);
    const persistence = describeSignalLayerPersistence();
    assert.equal(persistence.persistenceMode, "memory_fallback");
    assert.match(String(persistence.fallbackReason || ""), /STATE_(RESTORE|PERSIST)_FAILED/);
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testTimingSemanticsAndDecisionObservability() {
  clearModules([PATHS.strategyEngine, PATHS.signalLifecycle, PATHS.signalControls]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_cross",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    MIN_SIGNAL_CONFIDENCE: 60,
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross"],
    runStrategy: () => ({
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 81,
      reason: "timing semantics",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 78,
        anchorQuality: 75,
        structureQuality: 80,
        volumeQuality: 68,
        freshness: 85,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    const {
      getSignalDecisionBreakdown,
      explainSignalSuppression,
      shouldEmitLiveCandidate,
    } = require(PATHS.signalLifecycle);

    const candles = makeCandlesFromCloses(
      Array.from({ length: 30 }, (_, index) => 100 + index * 0.15),
      { startIso: "2026-01-02T11:00:00+05:30" },
    );
    const firstCreatedAtMs = Date.parse("2026-01-02T11:29:31+05:30");
    const secondCreatedAtMs = Date.parse("2026-01-02T14:05:00+05:30");

    resetSignalLayerState();
    const first = await evaluateOnCandleClose({
      instrument_token: 773,
      intervalMin: 1,
      candles,
      createdAtMs: firstCreatedAtMs,
      recordTelemetry: false,
    });
    resetSignalLayerState();
    const second = await evaluateOnCandleClose({
      instrument_token: 773,
      intervalMin: 1,
      candles,
      createdAtMs: secondCreatedAtMs,
      recordTelemetry: false,
    });

    assert.ok(first);
    assert.ok(second);
    assert.equal(first.signalEventTs, candles[candles.length - 1].ts);
    assert.equal(first.signalCreatedAt, new Date(firstCreatedAtMs).toISOString());
    assert.equal(second.signalCreatedAt, new Date(secondCreatedAtMs).toISOString());
    assert.equal(
      first.finalSignalScore,
      second.finalSignalScore,
      "wall-clock creation time should not change deterministic signal scoring",
    );
    assert.equal(
      first.signalOutcomeKey,
      second.signalOutcomeKey,
      "event-time lineage keys should stay stable across different creation times",
    );

    const breakdown = getSignalDecisionBreakdown(first);
    assert.equal(breakdown.timing.signalEventTs, first.signalEventTs);
    assert.equal(breakdown.timing.signalCreatedAt, first.signalCreatedAt);
    assert.ok(breakdown.preEmit.profileSource);
    assert.ok(breakdown.lifecycle.setupId);
    assert.equal(
      breakdown.calibration.calibrationActive,
      first.calibrationActive,
    );
    assert.ok(breakdown.persistence);

    const weakGate = shouldEmitLiveCandidate({
      candidate: {
        strategyId: "ema_cross",
        strategyStyle: "TREND",
        strategyFamily: "TREND",
        signalStage: "bar_close_confirmed",
        setupState: "forming",
        confidence: 40,
        rawConfidence: 40,
        normalizedConfidence: 49,
        qualityScore: 48,
        contextScore: 47,
        finalSignalScore: 46,
        mtfAgreementScore: 40,
        freshness: 45,
        stageScore: 82,
      },
      env,
    });
    const suppression = explainSignalSuppression({
      ...first,
      suppressionReason: weakGate.suppressionReason,
      suppressionReasons: weakGate.suppressionReasons,
      signalDecision: {
        ...(first.signalDecision || {}),
        preEmit: weakGate.qualityMeta,
        routing: {
          ...((first.signalDecision || {}).routing || {}),
          suppressionReason: weakGate.suppressionReason,
          suppressionReasons: weakGate.suppressionReasons,
          rejectionReason: null,
        },
      },
    });
    assert.equal(suppression.suppressionReason, weakGate.suppressionReason);
    assert.ok(Array.isArray(suppression.suppressionReasons));
  } finally {
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalLifecycle, PATHS.signalControls]);
  }
}

async function testLowPreEmitConfidenceSuppressedBeforeRouting() {
  clearModules([PATHS.strategyEngine, PATHS.signalControls, PATHS.signalLifecycle]);

  const { env } = require(PATHS.config);
  const registryModule = require(PATHS.registry);
  const candleStoreModule = require(PATHS.candleStore);
  const { logger } = require(PATHS.logger);
  const captured = [];

  const envRestore = patchObject(env, {
    SIGNAL_INTERVALS: "1",
    STRATEGIES: "ema_cross",
    STRATEGY_SELECTOR_ENABLED: "false",
    TELEMETRY_ENABLED: "false",
    MIN_SIGNAL_CONFIDENCE: 75,
  });
  const registryRestore = patchObject(registryModule, {
    enabledStrategyIds: () => ["ema_cross"],
    runStrategy: () => ({
      strategyId: "ema_cross",
      side: "BUY",
      confidence: 48,
      reason: "weak ema cross",
      meta: {
        triggerType: "EMA_BULL_CROSS",
        anchorType: "EMA_FAST",
        patternQuality: 60,
        anchorQuality: 58,
        structureQuality: 62,
        volumeQuality: 55,
        freshness: 84,
      },
    }),
  });
  const storeRestore = patchObject(candleStoreModule, {
    getRecentCandles: async () => [],
  });
  const loggerRestore = patchObject(logger, {
    info(payload, message) {
      if (message === "[signal] suppressed (pre-emit profile)") {
        captured.push({ payload, message });
      }
    },
  });

  try {
    const {
      evaluateOnCandleClose,
      resetSignalLayerState,
    } = require(PATHS.strategyEngine);
    resetSignalLayerState();

    const signal = await evaluateOnCandleClose({
      instrument_token: 9002,
      intervalMin: 1,
      candles: makeCandlesFromCloses(
        Array.from({ length: 30 }, (_, index) => 100 + index * 0.05),
      ),
    });

    assert.equal(
      signal,
      null,
      "weak ema_cross signals should be suppressed before routing/admission work begins",
    );
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0].payload.reasonCode,
      "SIGNAL_SUPPRESSED_LOW_PREEMIT_CONFIDENCE",
    );
    assert.equal(captured[0].payload.rawConfidence, 48);
    assert.ok(Array.isArray(captured[0].payload.failedChecks));
    assert.ok(captured[0].payload.failedChecks.includes("LOW_RAW_CONFIDENCE"));
    assert.equal(captured[0].payload.profileSource, "strategy:ema_cross");
    assert.ok(Array.isArray(captured[0].payload.suppressionReasons));
    assert.ok(
      captured[0].payload.suppressionReasons.includes("LOW_PREEMIT_CONFIDENCE"),
    );
  } finally {
    loggerRestore();
    storeRestore();
    registryRestore();
    envRestore();
    clearModules([PATHS.strategyEngine, PATHS.signalControls, PATHS.signalLifecycle]);
  }
}

async function main() {
  await testSignalTokenScope();
  await testSelectorUsesCandleTimestamp();
  testRegistryWiring();
  testEmaPullbackStrategy();
  testFakeoutStrategy();
  testOrbStrategy();
  testOrbExpiryWindow();
  testVwapReclaimStrategy();
  testVolumeBaselineHelpers();
  testSessionAwareStructureStrategies();
  await testPipelinePreservesEarlyCachedCandles();
  testProfessionalStrategyMinimums();
  await testStrategyMinimumsAndEarlyOrbEvaluation();
  await testConfidenceNormalizationAndRawConfidence();
  await testProvisionalVsConfirmedSignals();
  await testDuplicateFireControl();
  await testLifecycleMemoryForAllCandidates();
  await testRsiFadeLifecycleReset();
  testFingerprintQuality();
  testMtfAgreementScoring();
  testSelectorCompressedTrendAndSessionVwap();
  testSelectorSessionPhaseBuckets();
  testSessionContextHelpers();
  testRsiFadeUsesSessionVwap();
  testRsiDeterminism();
  testNativeSetupEvaluators();
  testSecondaryStrategySetupEngines();
  testMtfUsesLiveActiveCandidateContext();
  await testPipelinePreviewBoundary();
  await testWeightedSelectorSignalIntegration();
  testActiveSetupObservability();
  testScoreCalibrationActivationAndFallback();
  await testSignalSuppressedForStyleRegimeMismatch();
  testFrozenRegimeSnapshotResolverPrefersFrozenSnapshot();
  testExplicitPreEmitProfileCoverage();
  await testSignalCaptureCalibrationLoop();
  await testSignalStatePersistenceAndRestore();
  testSignalStatePersistencePrunesStaleEntries();
  await testSignalStatePersistenceFallbackToMemory();
  await testTimingSemanticsAndDecisionObservability();
  await testLowPreEmitConfidenceSuppressedBeforeRouting();
  console.log("signalLayer.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
