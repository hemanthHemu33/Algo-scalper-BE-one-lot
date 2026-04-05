const assert = require("node:assert/strict");
const {
  buildCompressionTelemetryMeta,
  TradeManager,
  evaluatePreRouteTradability,
  evaluatePreRouteConfidenceGate,
  resolveMinLotRiskPolicyDecision,
  resolvePreEntrySlFitDecision,
  resolvePreRouteConfidenceAllowance,
} = require("../../src/trading/tradeManager");

const defaultAllowance = resolvePreRouteConfidenceAllowance({});
assert.equal(defaultAllowance, 14);
assert.equal(
  resolvePreRouteConfidenceAllowance({
    OPT_PRE_ROUTE_MAX_CONF_BOOST: 9,
  }),
  9,
);
assert.equal(
  resolvePreRouteConfidenceAllowance({
    OPT_PRE_ROUTE_MAX_CONF_BOOST: 30,
  }),
  22,
);

const blockedPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 60,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(blockedPreRouteGate.preRouteAllowanceUsed, 14);
assert.equal(blockedPreRouteGate.conf, 60);
assert.equal(blockedPreRouteGate.minConf, 75);
assert.equal(blockedPreRouteGate.routeConfidenceDecision, "SOFT_PENALTY");
assert.equal(blockedPreRouteGate.blocked, false);
assert.ok(blockedPreRouteGate.softPenaltyApplied >= 2);

const passPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 61,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(passPreRouteGate.blocked, false);
assert.equal(passPreRouteGate.routeConfidenceDecision, "PASS");

const hardRejectPreRouteGate = evaluatePreRouteConfidenceGate({
  mustRouteUnderlyingToOption: true,
  conf: 22,
  minConf: 75,
  preRouteAllowanceUsed: defaultAllowance,
});

assert.equal(hardRejectPreRouteGate.blocked, true);
assert.equal(hardRejectPreRouteGate.routeConfidenceDecision, "HARD_REJECT");

const likelyNonTradable = evaluatePreRouteTradability({
  signal: { strategyStyle: "TREND" },
  underlying: "NIFTY",
  lotSize: 50,
  riskBudgetInr: 1800,
  config: {
    FNO_MIN_LOT_POLICY: "STRICT",
    OPT_MIN_PREMIUM_NIFTY: 250,
    OPT_MAX_PREMIUM_NIFTY: 500,
    OPT_SL_MODE: "PREMIUM_PCT",
    OPT_SL_PCT: 12,
    OPT_DELTA_BAND_MIN: 0.35,
    OPT_DELTA_BAND_MAX: 0.65,
    OPT_DELTA_TARGET: 0.65,
    EXPECTED_SLIPPAGE_POINTS: 0,
    EXPECTED_FEES_PER_LOT_INR: 0,
  },
});

assert.equal(likelyNonTradable.blocked, true);
assert.equal(likelyNonTradable.reasonCode, "OPTION_EXPRESSION_NOT_TRADABLE");
assert.equal(likelyNonTradable.tradabilityState, "LIKELY_UNTRADABLE");
assert.ok(likelyNonTradable.meta.estimatedOneLotRiskInr > 1800);
assert.equal(likelyNonTradable.meta.lotSize, 50);

const postRouteConfidence = TradeManager.prototype._finalOptionSignalConfidence.call(
  {},
  {
    baseConfidence: 60,
    liqMeta: {
      healthScore: 95,
      spreadBps: 20,
    },
  },
);
assert.equal(postRouteConfidence, 69);

const capBlockedSkip = resolvePreEntrySlFitDecision({
  config: {
    PRE_ENTRY_SL_COMPRESSION_ENABLED: true,
    OPT_SL_FIT_ENABLED: false,
    OPT_SL_FIT_WHEN_CAP_BLOCKS: false,
  },
  optionMeta: { underlying: "NIFTY" },
  lotSize: 50,
  strategyRiskFit: { fitsMinTradable: false },
});

assert.deepEqual(capBlockedSkip, {
  strategyFitsMinTradable: false,
  slFitEnabled: true,
  slFitWhenCapBlocks: false,
  compressionAttempted: false,
  compressionSkipReason: "CAP_BLOCK_COMPRESSION_DISABLED",
});

const capBlockedAttempt = resolvePreEntrySlFitDecision({
  config: {
    PRE_ENTRY_SL_COMPRESSION_ENABLED: true,
    OPT_SL_FIT_ENABLED: false,
    OPT_SL_FIT_WHEN_CAP_BLOCKS: true,
  },
  optionMeta: { underlying: "NIFTY" },
  lotSize: 50,
  strategyRiskFit: { fitsMinTradable: false },
});

assert.equal(capBlockedAttempt.strategyFitsMinTradable, false);
assert.equal(capBlockedAttempt.slFitEnabled, true);
assert.equal(capBlockedAttempt.slFitWhenCapBlocks, true);
assert.equal(capBlockedAttempt.compressionAttempted, true);
assert.equal(capBlockedAttempt.compressionSkipReason, null);

assert.deepEqual(
  resolveMinLotRiskPolicyDecision({
    config: {
      ALLOW_ONE_LOT_RISK_BUFFER_PCT: 25,
      FNO_MIN_LOT_POLICY: "STRICT",
    },
    lotSize: 50,
    riskBudgetInr: 1800,
    strategyRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2200,
      breachPct: 22.22,
    },
    sizingRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2200,
      breachPct: 22.22,
    },
    riskFitMode: "FIT",
    minLotPolicy: "STRICT",
  }),
  {
    allowOneLot: true,
    hardReject: false,
    riskFitDecision: "BREACH_ALLOWED",
    riskFitMode: "BUFFER_ALLOWED",
    riskBreachState: "SOFT",
    originalRiskInr: 2200,
    adjustedRiskInr: 2200,
    riskBreachPct: 22.22,
    riskBreachTag: "RISK_BREACH_ALLOWED",
    bufferPctAllowed: 25,
  },
);

assert.deepEqual(
  resolveMinLotRiskPolicyDecision({
    config: {
      ALLOW_ONE_LOT_RISK_BUFFER_PCT: 25,
      FNO_MIN_LOT_POLICY: "STRICT",
    },
    lotSize: 50,
    riskBudgetInr: 1800,
    strategyRiskFit: {
      fitsMinTradable: false,
      oneLotAllInRiskInr: 2400,
      breachPct: 33.33,
    },
    sizingRiskFit: {
      fitsMinTradable: true,
      oneLotAllInRiskInr: 1760,
      breachPct: 0,
    },
    riskFitMode: "COMPRESSED_FIT",
    minLotPolicy: "STRICT",
  }),
  {
    allowOneLot: false,
    hardReject: false,
    riskFitDecision: "COMPRESSED",
    riskFitMode: "COMPRESSED_FIT",
    riskBreachState: "NONE",
    originalRiskInr: 2400,
    adjustedRiskInr: 1760,
    riskBreachPct: 0,
    riskBreachTag: null,
    bufferPctAllowed: 25,
  },
);

assert.deepEqual(
  buildCompressionTelemetryMeta({
    compressionPts: 0.6,
    maxCompressionPct: 10,
    maxCompressionTicks: 6,
    maxCompressionPoints: 0.75,
    maxCompressionPtsByTick: 0.3,
    maxCompressionPtsEffective: 0.3,
    limitSourceUsed: "TICKS",
  }),
  {
    compressionPts: 0.6,
    maxCompressionPct: 10,
    maxCompressionTicks: 6,
    maxCompressionPoints: 0.75,
    maxCompressionPtsByTick: 0.3,
    maxCompressionPtsEffective: 0.3,
    limitSourceUsed: "TICKS",
  },
);

assert.deepEqual(buildCompressionTelemetryMeta(null), {
  compressionPts: null,
  maxCompressionPct: null,
  maxCompressionTicks: null,
  maxCompressionPoints: null,
  maxCompressionPtsByTick: null,
  maxCompressionPtsEffective: null,
  limitSourceUsed: null,
});

console.log("tradeManagerAdmission.test.js passed");
