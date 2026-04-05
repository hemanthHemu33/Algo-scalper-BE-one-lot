const assert = require("node:assert/strict");
const { env } = require("../../src/config");
const {
  marginAwareQty,
  marginAwareSizing,
  capQtyByConfig,
} = require("../../src/trading/marginSizer");

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = env[key];
    env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      env[key] = value;
    }
  }
}

async function main() {
  await withEnv(
    {
      USE_MARGIN_SIZING: "false",
      MAX_QTY: undefined,
      MAX_POSITION_VALUE_INR: undefined,
      MAX_QTY_HARDCAP: 10000,
    },
    async () => {
      const qty = await marginAwareQty({
        kite: null,
        entryParams: {},
        entryPriceGuess: NaN,
        qtyByRisk: 250,
      });

      assert.equal(qty, 0);
    },
  );

  await withEnv(
    {
      USE_MARGIN_SIZING: "false",
      MAX_QTY: 120,
      MAX_POSITION_VALUE_INR: undefined,
      MAX_QTY_HARDCAP: 10000,
    },
    async () => {
      const qty = await marginAwareQty({
        kite: null,
        entryParams: {},
        entryPriceGuess: 250,
        qtyByRisk: 250,
      });

      assert.equal(qty, 120);
    },
  );

  await withEnv(
    {
      MAX_QTY: undefined,
      MAX_POSITION_VALUE_INR: 10000,
      MAX_QTY_HARDCAP: 10000,
    },
    async () => {
      const qty = capQtyByConfig({
        qty: 100,
        entryPriceGuess: 250,
      });

      assert.equal(qty, 40);
    },
  );

  await withEnv(
    {
      USE_MARGIN_SIZING: "true",
      MARGIN_ALLOW_ESTIMATED_ORDER_MARGIN: "false",
      MAX_QTY: undefined,
      MAX_POSITION_VALUE_INR: undefined,
      MAX_QTY_HARDCAP: 10000,
    },
    async () => {
      const result = await marginAwareSizing({
        kite: {
          getMargins: async () => {
            throw new Error("margins down");
          },
        },
        entryParams: {},
        entryPriceGuess: 250,
        qtyByRisk: 50,
      });

      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.equal(result.reason, "MARGIN_FUNDS_UNAVAILABLE");
      assert.equal(result.qty, 0);
    },
  );

  await withEnv(
    {
      USE_MARGIN_SIZING: "true",
      MARGIN_ALLOW_ESTIMATED_ORDER_MARGIN: "false",
      MAX_QTY: undefined,
      MAX_POSITION_VALUE_INR: undefined,
      MAX_QTY_HARDCAP: 10000,
    },
    async () => {
      const result = await marginAwareSizing({
        kite: {
          getMargins: async () => ({
            equity: { available: { cash: 50000 } },
          }),
          orderMargins: async () => {
            throw new Error("order margins unavailable");
          },
        },
        entryParams: {
          exchange: "NFO",
          tradingsymbol: "NIFTY26MAR24500CE",
          transaction_type: "BUY",
          product: "MIS",
          order_type: "MARKET",
        },
        entryPriceGuess: 250,
        qtyByRisk: 50,
      });

      assert.equal(result.ok, false);
      assert.equal(result.blocked, true);
      assert.equal(result.reason, "ORDER_MARGINS_FAILED");
      assert.equal(result.qty, 0);
    },
  );

  console.log("marginSizer.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
