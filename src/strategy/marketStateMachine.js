const {
  isFragileReversalState,
  isFragileReversalStrategyAllowed,
  isRangeReversalStrategy,
} = require("./fragileReversalPermission");

const MARKET_STATES = Object.freeze({
  OPEN_DRIVE: "OPEN_DRIVE",
  CLEAN_TREND: "CLEAN_TREND",
  TREND_COMPRESSED: "TREND_COMPRESSED",
  BREAKOUT_WATCH: "BREAKOUT_WATCH",
  FAILED_BREAKOUT: "FAILED_BREAKOUT",
  RANGE_CHOP: "RANGE_CHOP",
  TRAP_RISK_HIGH: "TRAP_RISK_HIGH",
  NO_TRADE: "NO_TRADE",
});

const UGLY_FRAGILE_STATES = new Set([
  MARKET_STATES.TREND_COMPRESSED,
  MARKET_STATES.BREAKOUT_WATCH,
  MARKET_STATES.FAILED_BREAKOUT,
  MARKET_STATES.RANGE_CHOP,
  MARKET_STATES.TRAP_RISK_HIGH,
  MARKET_STATES.NO_TRADE,
]);

const DANGEROUS_STRATEGY_IDS = new Set([
  "breakout",
  "volume_spike",
  "ema_cross",
]);

const SOFT_PENALTY_STRATEGY_IDS = new Set(["ema_pullback", "bb_squeeze"]);

function parseList(spec) {
  return String(spec || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  return Number.isFinite(Number(value));
}

function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function normalizeRegime(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return normalized || "UNKNOWN";
}

function normalizeMarketState(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  return MARKET_STATES[normalized] || normalized || MARKET_STATES.RANGE_CHOP;
}

function marketStateFamily(marketState) {
  const state = normalizeMarketState(marketState);
  if (state === MARKET_STATES.OPEN_DRIVE) return "OPEN";
  if (state === MARKET_STATES.CLEAN_TREND) return "TREND";
  if (state === MARKET_STATES.RANGE_CHOP) return "RANGE";
  if (state === MARKET_STATES.NO_TRADE) return "NO_TRADE";
  if (
    state === MARKET_STATES.TREND_COMPRESSED ||
    state === MARKET_STATES.BREAKOUT_WATCH ||
    state === MARKET_STATES.FAILED_BREAKOUT ||
    state === MARKET_STATES.TRAP_RISK_HIGH
  ) {
    return "FRAGILE";
  }
  return "UNKNOWN";
}

function baseMarketStateFromRegime({ regime, primaryRegime, regimeWeights }) {
  const primary = normalizeRegime(primaryRegime || regime);
  if (primary === "OPEN") return MARKET_STATES.OPEN_DRIVE;
  if (primary === "TREND") return MARKET_STATES.CLEAN_TREND;
  if (primary === "TREND_COMPRESSED") return MARKET_STATES.TREND_COMPRESSED;
  if (primary === "BREAKOUT_WATCH") return MARKET_STATES.BREAKOUT_WATCH;
  if (primary === "RANGE") return MARKET_STATES.RANGE_CHOP;

  const watchWeight = Number(regimeWeights?.BREAKOUT_WATCH ?? 0);
  const compressedWeight = Number(regimeWeights?.TREND_COMPRESSED ?? 0);
  const trendWeight = Number(regimeWeights?.TREND ?? 0);
  const rangeWeight = Number(regimeWeights?.RANGE ?? 0);
  if (watchWeight >= 0.24 && watchWeight >= trendWeight) {
    return MARKET_STATES.BREAKOUT_WATCH;
  }
  if (compressedWeight >= 0.3 && compressedWeight >= rangeWeight) {
    return MARKET_STATES.TREND_COMPRESSED;
  }
  if (trendWeight >= rangeWeight) return MARKET_STATES.CLEAN_TREND;
  return MARKET_STATES.RANGE_CHOP;
}

function resolveMarketState({
  regime,
  primaryRegime,
  regimeWeights,
  levelAcceptance = null,
  dangerStack = null,
  retryGovernor = null,
  dteDays = null,
  env = {},
}) {
  const engineEnabled =
    String(env.MARKET_STATE_ENGINE_ENABLED ?? "true") === "true";
  let marketState = baseMarketStateFromRegime({
    regime,
    primaryRegime,
    regimeWeights,
  });
  if (!engineEnabled) {
    return {
      marketState,
      marketStateFamily: marketStateFamily(marketState),
      escalations: [],
    };
  }

  const escalations = [];
  const failedBreakoutEnabled =
    String(env.MARKET_STATE_FAILED_BREAKOUT_ENABLED ?? "true") === "true";
  const trapRiskEnabled =
    String(env.MARKET_STATE_TRAP_RISK_ENABLED ?? "true") === "true";
  const noTradeEnabled =
    String(env.MARKET_STATE_NO_TRADE_ENABLED ?? "true") === "true";
  const oneDte = hasFiniteNumber(dteDays) && Number(dteDays) <= 1;
  const keyLevelType = String(levelAcceptance?.keyLevelType || "")
    .trim()
    .toUpperCase();
  const actionableLevelContext =
    !keyLevelType ||
    keyLevelType === "TRIGGER" ||
    keyLevelType === "RESISTANCE" ||
    keyLevelType === "SUPPORT" ||
    keyLevelType === "ANCHOR";

  if (failedBreakoutEnabled) {
    const rejectionMinCount = Math.max(
      1,
      Number(env.LEVEL_REJECTION_MIN_COUNT ?? 2),
    );
    const rejectionCount = Number(levelAcceptance?.rejectionCount ?? 0);
    const rejectionDrivenFailure =
      actionableLevelContext &&
      levelAcceptance?.breakoutRejected === true &&
      levelAcceptance?.breakoutAccepted !== true &&
      (levelAcceptance?.repeatedRejectionDetected === true ||
        rejectionCount >= rejectionMinCount);
    if (rejectionDrivenFailure) {
      marketState = MARKET_STATES.FAILED_BREAKOUT;
      escalations.push("FAILED_BREAKOUT_REJECTION");
    }
  }

  if (trapRiskEnabled) {
    const trapFromRetry = retryGovernor?.blocked === true;
    const trapFromStack =
      Number(dangerStack?.dangerStackScore ?? 0) >=
      Number(env.DANGER_STACK_A_PLUS_ONLY_SCORE ?? 60);
    const trapFromStructure =
      actionableLevelContext &&
      levelAcceptance?.repeatedRejectionDetected === true &&
      levelAcceptance?.breakoutRejected === true;
    if (trapFromRetry || trapFromStack || trapFromStructure) {
      marketState = MARKET_STATES.TRAP_RISK_HIGH;
      escalations.push(
        trapFromRetry
          ? "TRAP_RETRY_GOVERNOR"
          : trapFromStack
            ? "TRAP_DANGER_STACK"
            : "TRAP_STRUCTURE_REJECTION",
      );
    }
  }

  if (noTradeEnabled) {
    const noTradeScore = Number(env.DANGER_STACK_NO_TRADE_SCORE ?? 80);
    const noTradeByScore = Number(dangerStack?.dangerStackScore ?? 0) >= noTradeScore;
    const noTradeByState =
      marketState === MARKET_STATES.TRAP_RISK_HIGH && oneDte;
    if (noTradeByScore || noTradeByState) {
      marketState = MARKET_STATES.NO_TRADE;
      escalations.push(noTradeByScore ? "NO_TRADE_DANGER_STACK" : "NO_TRADE_TRAP_ONE_DTE");
    }
  }

  return {
    marketState,
    marketStateFamily: marketStateFamily(marketState),
    escalations,
  };
}

function bucketStrategiesForState(env, marketState) {
  const state = normalizeMarketState(marketState);
  const openDrive = parseList(env.STRATEGIES_OPEN_DRIVE || env.STRATEGIES_OPEN);
  const cleanTrend = parseList(env.STRATEGIES_CLEAN_TREND || env.STRATEGIES_TREND);
  const compressed = parseList(env.STRATEGIES_TREND_COMPRESSED);
  const breakoutWatch = parseList(
    env.STRATEGIES_BREAKOUT_WATCH || env.STRATEGIES_TREND_COMPRESSED,
  );
  const failed = parseList(
    env.STRATEGIES_FAILED_BREAKOUT ||
      env.STRATEGIES_BREAKOUT_WATCH ||
      env.STRATEGIES_TREND_COMPRESSED,
  );
  const rangeChop = parseList(env.STRATEGIES_RANGE_CHOP || env.STRATEGIES_RANGE);
  const trap = parseList(env.STRATEGIES_TRAP_RISK_HIGH);
  const noTrade = parseList(env.STRATEGIES_NO_TRADE);

  if (state === MARKET_STATES.OPEN_DRIVE) return uniq(openDrive);
  if (state === MARKET_STATES.CLEAN_TREND) return uniq(cleanTrend);
  if (state === MARKET_STATES.TREND_COMPRESSED) return uniq(compressed);
  if (state === MARKET_STATES.BREAKOUT_WATCH) return uniq(breakoutWatch);
  if (state === MARKET_STATES.FAILED_BREAKOUT) return uniq(failed);
  if (state === MARKET_STATES.RANGE_CHOP) return uniq(rangeChop);
  if (state === MARKET_STATES.TRAP_RISK_HIGH) return uniq(trap);
  if (state === MARKET_STATES.NO_TRADE) return uniq(noTrade);
  return [];
}

function buildStrategyPermissionMatrix({
  marketState,
  allowedStrategies = [],
  allStrategies = [],
  env = {},
}) {
  const state = normalizeMarketState(marketState);
  const blocked = new Set();
  const penalized = new Set();
  const blockedReasons = new Map();
  const blockStrategy = (strategyId, reasonCode, extra = {}) => {
    const id = String(strategyId || "").trim();
    if (!id) return;
    blocked.add(id);
    if (!blockedReasons.has(id)) {
      blockedReasons.set(id, {
        strategyId: id,
        reasonCode,
        marketState: state,
        ...extra,
      });
    }
  };

  if (state === MARKET_STATES.TREND_COMPRESSED || state === MARKET_STATES.BREAKOUT_WATCH) {
    DANGEROUS_STRATEGY_IDS.forEach((id) =>
      blockStrategy(id, "DANGEROUS_CONTINUATION_FRAGILE_STATE"),
    );
    SOFT_PENALTY_STRATEGY_IDS.forEach((id) => penalized.add(id));
  } else if (state === MARKET_STATES.FAILED_BREAKOUT || state === MARKET_STATES.RANGE_CHOP) {
    DANGEROUS_STRATEGY_IDS.forEach((id) =>
      blockStrategy(id, "DANGEROUS_CONTINUATION_FRAGILE_STATE"),
    );
    SOFT_PENALTY_STRATEGY_IDS.forEach((id) =>
      blockStrategy(id, "SOFT_CONTINUATION_BLOCKED_FRAGILE_STATE"),
    );
  } else if (state === MARKET_STATES.TRAP_RISK_HIGH || state === MARKET_STATES.NO_TRADE) {
    allStrategies.forEach((id) =>
      blockStrategy(id, "MARKET_STATE_BLOCKS_NEW_ENTRIES"),
    );
  }

  if (isFragileReversalState(state)) {
    uniq([...allowedStrategies, ...allStrategies]).forEach((id) => {
      if (!isRangeReversalStrategy(id)) return;
      if (isFragileReversalStrategyAllowed({ env, marketState: state, strategyId: id })) {
        return;
      }
      blockStrategy(id, "RANGE_FRAGILE_REQUIRES_EXCEPTION", {
        exceptionReasonCode: "FRAGILE_REVERSAL_STRATEGY_NOT_ALLOWED",
      });
    });
  }

  const finalAllowed = uniq(allowedStrategies).filter((id) => !blocked.has(id));
  const blockedArr = uniq(
    Array.from(blocked).filter((id) => id && allStrategies.includes(id)),
  );
  const penalizedArr = uniq(
    Array.from(penalized).filter(
      (id) => id && !blocked.has(id) && allStrategies.includes(id),
    ),
  );

  return {
    allowedStrategies: finalAllowed,
    penalizedStrategies: penalizedArr,
    blockedStrategies: blockedArr,
    blockedStrategiesWithReasons: blockedArr.map((id) => blockedReasons.get(id)).filter(Boolean),
  };
}

function isFragileMarketState(marketState) {
  return UGLY_FRAGILE_STATES.has(normalizeMarketState(marketState));
}

module.exports = {
  MARKET_STATES,
  UGLY_FRAGILE_STATES,
  DANGEROUS_STRATEGY_IDS,
  SOFT_PENALTY_STRATEGY_IDS,
  normalizeRegime,
  normalizeMarketState,
  marketStateFamily,
  baseMarketStateFromRegime,
  resolveMarketState,
  bucketStrategiesForState,
  buildStrategyPermissionMatrix,
  isFragileMarketState,
  parseList,
};
