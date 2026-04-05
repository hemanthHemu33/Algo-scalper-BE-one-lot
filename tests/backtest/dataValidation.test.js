const assert = require("node:assert/strict");
const { validateBacktestData } = require("../../src/backtest/dataValidation");

const candles = [
  { ts: new Date("2026-01-01T09:15:00+05:30"), open: 100, high: 101, low: 99, close: 100.5 },
  { ts: new Date("2026-01-01T09:16:00+05:30"), open: 100.5, high: 101.5, low: 100, close: 101 },
  { ts: new Date("2026-01-01T09:16:00+05:30"), open: 101, high: 101.2, low: 100.8, close: 101.1 },
];

const report = validateBacktestData({
  candles,
  intervalMin: 1,
  timezone: "Asia/Kolkata",
  range: {
    from: "2026-01-01T09:15:00+05:30",
    to: "2026-01-01T09:17:00+05:30",
  },
  underlyingToken: 260105,
  tokenInstrument: null,
  optionProvider: {
    ready: true,
    stats: { duplicateTimestampCount: 1 },
    listTokens() {
      return [12345];
    },
    listInstruments() {
      return [{ instrument_token: 12345, expiry: "2026-01-08T15:30:00+05:30" }];
    },
    getCandlesByToken() {
      return [];
    },
    getCandleAtTs() {
      return null;
    },
  },
  signalSelections: [
    {
      ts: "2026-01-01T09:16:00+05:30",
      selectedContractToken: 12345,
      selectedExpiry: "2025-12-31T15:30:00+05:30",
      selectedInstrument: null,
      usedCandleTs: "2026-01-01T09:17:00+05:30",
    },
  ],
  lookAheadGuard: true,
});

const codes = new Set(report.issues.map((issue) => issue.code));
assert.ok(codes.has("MISSING_INSTRUMENT_METADATA"));
assert.ok(codes.has("DUPLICATE_TIMESTAMP"));
assert.ok(codes.has("MISSING_OPTION_CANDLE"));
assert.ok(codes.has("CONTRACT_EXPIRY_SANITY"));
assert.ok(codes.has("LOOK_AHEAD_GUARD"));
assert.ok(Array.isArray(report.continuityByDay));
assert.ok(Array.isArray(report.optionCoverageByDay));
assert.equal(report.settings.lookAheadGuardEnabled, true);

const disabledReport = validateBacktestData({
  candles,
  intervalMin: 1,
  timezone: "Asia/Kolkata",
  range: {
    from: "2026-01-01T09:15:00+05:30",
    to: "2026-01-01T09:17:00+05:30",
  },
  underlyingToken: 260105,
  tokenInstrument: null,
  optionProvider: {
    ready: true,
    stats: { duplicateTimestampCount: 0 },
    listTokens() {
      return [12345];
    },
    listInstruments() {
      return [{ instrument_token: 12345, expiry: "2026-01-08T15:30:00+05:30" }];
    },
    getCandlesByToken() {
      return [];
    },
    getCandleAtTs() {
      return null;
    },
  },
  signalSelections: [
    {
      ts: "2026-01-01T09:16:00+05:30",
      selectedContractToken: 12345,
      selectedExpiry: "2025-12-31T15:30:00+05:30",
      selectedInstrument: null,
      usedCandleTs: "2026-01-01T09:17:00+05:30",
    },
  ],
  lookAheadGuard: false,
});

const disabledCodes = new Set(disabledReport.issues.map((issue) => issue.code));
assert.ok(!disabledCodes.has("LOOK_AHEAD_GUARD"));
assert.ok(disabledCodes.has("CONTRACT_EXPIRY_SANITY"));
assert.equal(disabledReport.settings.lookAheadGuardEnabled, false);

console.log("dataValidation.test.js passed");
