const assert = require("node:assert/strict");
const {
  computeRawSlipBps,
  computeAdverseSlipBps,
  computeFavorableSlipBps,
  evaluateEntrySlippageGuard,
} = require("../../src/trading/entrySlippageGuard");
const { TradeManager, STATUS } = require("../../src/trading/tradeManager");
const { env } = require("../../src/config");

function approx(actual, expected, tolerance = 0.02) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

const buyFavorableRaw = computeRawSlipBps(186.4, 183.65);
approx(buyFavorableRaw, -147.53);
approx(computeAdverseSlipBps("BUY", 186.4, 183.65), 0);
approx(computeFavorableSlipBps("BUY", 186.4, 183.65), 147.53);

const buyFavorable = evaluateEntrySlippageGuard({
  entrySide: "BUY",
  entryType: "MARKET",
  expectedPrice: 186.4,
  avgFillPrice: 183.65,
  thresholdBps: 140,
});
assert.equal(buyFavorable.triggered, false);
assert.equal(buyFavorable.reason, "favorable slippage");

const buyWithinThreshold = evaluateEntrySlippageGuard({
  entrySide: "BUY",
  entryType: "MARKET",
  expectedPrice: 186.4,
  avgFillPrice: 188.0,
  thresholdBps: 140,
});
assert.equal(buyWithinThreshold.triggered, false);
approx(buyWithinThreshold.adverseSlipBps, 85.84);
assert.equal(buyWithinThreshold.reason, "within adverse threshold");

const buyBeyondThreshold = evaluateEntrySlippageGuard({
  entrySide: "BUY",
  entryType: "MARKET",
  expectedPrice: 186.4,
  avgFillPrice: 190.0,
  thresholdBps: 140,
});
assert.equal(buyBeyondThreshold.triggered, true);
approx(buyBeyondThreshold.adverseSlipBps, 193.13);
assert.equal(
  buyBeyondThreshold.reason,
  "BUY fill worse than expected beyond threshold",
);

const sellFavorable = evaluateEntrySlippageGuard({
  entrySide: "SELL",
  entryType: "MARKET",
  expectedPrice: 186.4,
  avgFillPrice: 188.5,
  thresholdBps: 140,
});
assert.equal(sellFavorable.triggered, false);
assert.equal(sellFavorable.reason, "favorable slippage");
approx(sellFavorable.favorableSlipBps, 112.66);

const sellBeyondThreshold = evaluateEntrySlippageGuard({
  entrySide: "SELL",
  entryType: "MARKET",
  expectedPrice: 186.4,
  avgFillPrice: 183.0,
  thresholdBps: 140,
});
assert.equal(sellBeyondThreshold.triggered, true);
approx(sellBeyondThreshold.adverseSlipBps, 182.40);
assert.equal(
  sellBeyondThreshold.reason,
  "SELL fill worse than expected beyond threshold",
);

const limitBuyBetter = evaluateEntrySlippageGuard({
  entrySide: "BUY",
  entryType: "LIMIT",
  expectedPrice: 186.4,
  avgFillPrice: 183.65,
  submittedLimitPrice: 186.4,
  thresholdBps: 140,
  guardForLimit: true,
});
assert.equal(limitBuyBetter.triggered, false);
assert.equal(limitBuyBetter.isAtOrBetterThanLimit, true);
assert.equal(
  limitBuyBetter.reason,
  "LIMIT fill at-or-better than submitted price",
);

const limitSellBetter = evaluateEntrySlippageGuard({
  entrySide: "SELL",
  entryType: "LIMIT",
  expectedPrice: 186.4,
  avgFillPrice: 188.0,
  submittedLimitPrice: 186.4,
  thresholdBps: 140,
  guardForLimit: true,
});
assert.equal(limitSellBetter.triggered, false);
assert.equal(limitSellBetter.isAtOrBetterThanLimit, true);
assert.equal(
  limitSellBetter.reason,
  "LIMIT fill at-or-better than submitted price",
);

async function testPanicStartSkipsDynamicExit() {
  const previous = env.DYNAMIC_EXITS_ENABLED;
  try {
    env.DYNAMIC_EXITS_ENABLED = "true";

    const tm = new TradeManager({ kite: {}, riskEngine: {} });
    let ltpCalls = 0;
    tm._getLtp = async () => {
      ltpCalls += 1;
      return 100;
    };

    await tm._maybeDynamicAdjustExits(
      {
        tradeId: "panic-1",
        status: STATUS.ENTRY_FILLED,
        instrument_token: 12345,
        slOrderId: "SL-1",
        panicExitPending: true,
      },
      new Map(),
    );

    assert.equal(ltpCalls, 0);
  } finally {
    env.DYNAMIC_EXITS_ENABLED = previous;
  }
}

testPanicStartSkipsDynamicExit()
  .then(() => {
    console.log("entrySlippageGuard.test.js passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
