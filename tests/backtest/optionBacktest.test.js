const assert = require("node:assert/strict");
const { buildOptionBacktestProvider } = require("../../src/backtest/optionBacktest");

async function testBacktestSelectionsAreMarkedNonLiveEquivalent() {
  const instruments = [
    {
      instrument_token: 111,
      name: "NIFTY",
      instrument_type: "CE",
      expiry: "2026-04-02T00:00:00.000Z",
      strike: 25000,
      exchange: "NFO",
      tradingsymbol: "NIFTY26APR25000CE",
    },
  ];
  const optionCandles = [
    {
      instrument_token: 111,
      ts: new Date("2026-03-20T09:20:00.000Z"),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000,
    },
  ];

  const db = {
    collection(name) {
      if (name === "instruments_cache") {
        return {
          find() {
            return {
              toArray: async () => instruments,
            };
          },
        };
      }
      return {
        find() {
          return {
            project() {
              return {
                toArray: async () => optionCandles,
              };
            },
          };
        },
      };
    },
  };

  const provider = await buildOptionBacktestProvider({
    db,
    intervalMin: 1,
    from: "2026-03-20T09:00:00.000Z",
    to: "2026-03-20T10:00:00.000Z",
    underlyingToken: 999,
    underlyingTradingsymbol: "NIFTY 50",
    optionType: "CE",
    strikeStep: 50,
    scanSteps: 0,
  });

  const selection = provider.selectContract({
    ts: optionCandles[0].ts,
    underlyingPrice: 25000,
  });

  assert.equal(provider.ready, true);
  assert.equal(selection.selected.selectionModel, "BACKTEST_SIMPLIFIED");
  assert.equal(selection.selected.liveEquivalent, false);
  assert.equal(selection.snapshot.selectionModel, "BACKTEST_SIMPLIFIED");
  assert.equal(selection.snapshot.parity, "NON_LIVE_EQUIVALENT");
}

async function main() {
  await testBacktestSelectionsAreMarkedNonLiveEquivalent();
  console.log("optionBacktest.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
