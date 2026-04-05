const DEFAULT_FLAGS = Object.freeze({
  blockedByCapital: false,
  blockedByDailyLoss: false,
  blockedByCooldown: false,
  blockedByConcurrency: false,
  blockedByRiskFit: false,
  blockedByTimeWindow: false,
  blockedByDataQuality: false,
  blockedByNoContract: false,
  blockedBySpreadOrLiquidity: false,
  blockedByOptimizerGate: false,
  blockedByExistingPosition: false,
});

const REASON_DEFINITIONS = {
  ACCEPTED: {
    text: "Signal admitted for entry",
    flags: {},
  },
  CONFIDENCE_TOO_LOW: {
    text: "Signal confidence is below the configured threshold",
    flags: {},
  },
  ALLOWED_STRATEGIES_BLOCK: {
    text: "Strategy is not enabled for this backtest run",
    flags: {},
  },
  OPTIMIZER_VETO: {
    text: "Signal was blocked by the optimizer gate",
    flags: { blockedByOptimizerGate: true },
  },
  COOLDOWN_BLOCK: {
    text: "Signal is inside the configured cooldown window",
    flags: { blockedByCooldown: true },
  },
  MAX_CONCURRENT_BLOCK: {
    text: "Maximum concurrent position limit reached",
    flags: { blockedByConcurrency: true, blockedByExistingPosition: true },
  },
  DAILY_LOSS_HALT: {
    text: "Daily loss limit has been reached",
    flags: { blockedByDailyLoss: true },
  },
  MAX_DRAWDOWN_HALT: {
    text: "Absolute drawdown halt is active",
    flags: { blockedByRiskFit: true },
  },
  MAX_DRAWDOWN_PCT_HALT: {
    text: "Percentage drawdown halt is active",
    flags: { blockedByRiskFit: true },
  },
  MAX_CONSECUTIVE_LOSSES_HALT: {
    text: "Consecutive-loss halt is active",
    flags: { blockedByRiskFit: true },
  },
  MAX_TRADES_PER_DAY_HALT: {
    text: "Maximum trades per day reached",
    flags: { blockedByRiskFit: true },
  },
  MAX_OPEN_RISK_HALT: {
    text: "Open-risk limit has been reached",
    flags: { blockedByRiskFit: true },
  },
  ENTRY_CUTOFF_BLOCK: {
    text: "Entry cutoff time has passed",
    flags: { blockedByTimeWindow: true },
  },
  SKIP_ON_DRAWDOWN_BLOCK: {
    text: "Entry blocked because drawdown skip threshold is active",
    flags: { blockedByRiskFit: true },
  },
  STALE_SIGNAL_BLOCK: {
    text: "Signal became stale before the configured execution delay",
    flags: {},
  },
  MISSING_OPTION_CONTRACT: {
    text: "No option contract was available for the signal",
    flags: { blockedByNoContract: true },
  },
  MISSING_TRADED_CANDLE: {
    text: "No tradable candle was available at the selected timestamp",
    flags: { blockedByDataQuality: true },
  },
  DATA_QUALITY_BLOCK: {
    text: "Data-quality checks blocked the signal",
    flags: { blockedByDataQuality: true },
  },
  MISSING_LIQUIDITY: {
    text: "Liquidity or spread checks blocked the signal",
    flags: { blockedBySpreadOrLiquidity: true },
  },
  CAPITAL_OR_RISK_FIT_FAILED: {
    text: "Capital or risk budgets could not fit the trade",
    flags: { blockedByCapital: true, blockedByRiskFit: true },
  },
  INSUFFICIENT_CAPITAL: {
    text: "Free capital could not fund the trade",
    flags: { blockedByCapital: true },
  },
  INSUFFICIENT_RISK_BUDGET: {
    text: "Risk budget could not support one lot",
    flags: { blockedByRiskFit: true },
  },
  SIZE_LT_ONE_LOT: {
    text: "Allowed position size is below one lot",
    flags: { blockedByCapital: true, blockedByRiskFit: true },
  },
  FORCE_EOD_END: {
    text: "Trade was force-closed at backtest end",
    flags: {},
  },
  FORCE_EOD_DATA_END: {
    text: "Trade was force-closed at data end",
    flags: {},
  },
  FORCE_EOD_SESSION_BOUNDARY: {
    text: "Trade was force-closed at session boundary",
    flags: {},
  },
  FORCE_EOD_GAP_BOUNDARY: {
    text: "Trade was force-closed because of a session gap boundary",
    flags: {},
  },
  STOPLOSS: {
    text: "Trade exited by stop loss",
    flags: {},
  },
  TARGET: {
    text: "Trade exited by target",
    flags: {},
  },
  DYNAMIC_EXIT: {
    text: "Trade exited by dynamic exit logic",
    flags: {},
  },
  UNKNOWN: {
    text: "Unknown reason",
    flags: {},
  },
};

const REASON_ALIASES = {
  ACCEPT: "ACCEPTED",
  ACCEPTED_SIGNAL: "ACCEPTED",
  CONFIDENCE_LOW: "CONFIDENCE_TOO_LOW",
  OPTIMIZER_GATE: "OPTIMIZER_VETO",
  COOL_DOWN_BLOCK: "COOLDOWN_BLOCK",
  EXISTING_POSITION_BLOCK: "MAX_CONCURRENT_BLOCK",
  DAILY_LOSS_BLOCK: "DAILY_LOSS_HALT",
  DRAWDOWN_BLOCK: "MAX_DRAWDOWN_HALT",
  DRAWDOWN_PCT_BLOCK: "MAX_DRAWDOWN_PCT_HALT",
  MAX_CONCURRENT_POSITIONS: "MAX_CONCURRENT_BLOCK",
  MAX_OPEN_RISK_BLOCK: "MAX_OPEN_RISK_HALT",
  ENTRY_CUTOFF: "ENTRY_CUTOFF_BLOCK",
  NO_CONTRACT: "MISSING_OPTION_CONTRACT",
  NO_TRADE_CANDLE: "MISSING_TRADED_CANDLE",
  DATA_ISSUE: "DATA_QUALITY_BLOCK",
  LIQUIDITY_BLOCK: "MISSING_LIQUIDITY",
  SPREAD_BLOCK: "MISSING_LIQUIDITY",
  RISK_FIT_FAILED: "CAPITAL_OR_RISK_FIT_FAILED",
  STOP_LOSS: "STOPLOSS",
  STOPLOSS_HIT: "STOPLOSS",
  TAKE_PROFIT: "TARGET",
  TIME_STOP: "DYNAMIC_EXIT",
  FORCE_EXIT: "FORCE_EOD_END",
  FORCE_EOD: "FORCE_EOD_END",
  FORCE_SESSION_BOUNDARY: "FORCE_EOD_SESSION_BOUNDARY",
};

function sanitizeReasonCode(value) {
  return (
    String(value || "UNKNOWN")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "UNKNOWN"
  );
}

function normalizeReasonCode(value) {
  const sanitized = sanitizeReasonCode(value);
  const resolved = REASON_ALIASES[sanitized] || sanitized;
  return REASON_DEFINITIONS[resolved] ? resolved : "UNKNOWN";
}

function normalizeExitReasonCode(value) {
  return normalizeReasonCode(value);
}

function describeReasonCode(value) {
  const code = normalizeReasonCode(value);
  return REASON_DEFINITIONS[code]?.text || REASON_DEFINITIONS.UNKNOWN.text;
}

function buildReasonFlags(value) {
  const code = normalizeReasonCode(value);
  return {
    ...DEFAULT_FLAGS,
    ...(REASON_DEFINITIONS[code]?.flags || {}),
  };
}

function toReasonSummary(value) {
  const reasonCode = normalizeReasonCode(value);
  return {
    reasonCode,
    reasonText: describeReasonCode(reasonCode),
    ...buildReasonFlags(reasonCode),
  };
}

module.exports = {
  DEFAULT_FLAGS,
  REASON_ALIASES,
  REASON_DEFINITIONS,
  buildReasonFlags,
  describeReasonCode,
  normalizeExitReasonCode,
  normalizeReasonCode,
  sanitizeReasonCode,
  toReasonSummary,
};
