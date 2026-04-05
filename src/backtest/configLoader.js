const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { z } = require("zod");
const { normalizeAcceptanceConfig } = require("./acceptanceConfig");

const DEFAULT_TIMEZONE = process.env.CANDLE_TZ || process.env.TZ || "Asia/Kolkata";
const DEFAULT_OUTPUT_DIR = path.join("reports", "backtests");

function boolish(defaultValue = false) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
}

function maybeNumber() {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().optional());
}

const acceptanceSchema = z
  .object({
    minTrades: maybeNumber().default(0),
    minNetPnl: maybeNumber(),
    minProfitFactor: maybeNumber(),
    minExpectancy: maybeNumber(),
    minWinRate: maybeNumber(),
    maxDrawdownAbs: maybeNumber(),
    maxDrawdownPct: maybeNumber(),
    maxSingleMonthContributionPct: maybeNumber(),
    minMonthsPositive: maybeNumber(),
    minOOSProfitFactor: maybeNumber(),
    minOOSNetPnl: maybeNumber(),
    maxRejectedByDataIssuesPct: maybeNumber(),
    maxForcedExitPct: maybeNumber(),
    minimumTrades: maybeNumber(),
    minimumWinRate: maybeNumber(),
    minimumExpectancy: maybeNumber(),
    minimumProfitFactor: maybeNumber(),
    maximumDrawdownInr: maybeNumber(),
    maximumDrawdownPct: maybeNumber(),
    requireOutOfSampleProfitable: boolish(false).default(false),
    maxSingleMonthPnlShare: maybeNumber(),
  })
  .default({});

const internalConfigSchema = z.object({
  runMeta: z
    .object({
      name: z.string().trim().min(1).default("backtest_run"),
      seed: z.coerce.number().int().default(42),
      notes: z.string().optional(),
      tags: z.array(z.string()).default([]),
    })
    .default({}),
  metadata: z
    .object({
      name: z.string().trim().min(1).default("backtest_run"),
      seed: z.coerce.number().int().default(42),
      notes: z.string().optional(),
      tags: z.array(z.string()).default([]),
    })
    .default({}),
  data: z.object({
    mode: z.enum(["EQ", "FUT", "OPT"]).default("EQ"),
    token: z.coerce.number(),
    underlying: z.string().default(""),
    from: z.string(),
    to: z.string(),
    interval: z.coerce.number().int().min(1).default(1),
    limit: maybeNumber().default(0),
    warmup: z.coerce.number().int().min(1).default(80),
    dynamicContracts: boolish(false).default(false),
    optionType: z.enum(["CE", "PE", "ALL"]).default("CE"),
    strikeStep: z.coerce.number().int().positive().default(50),
    scanSteps: z.coerce.number().int().min(0).default(2),
    greeksFilter: boolish(false).default(false),
    minDelta: z.coerce.number().min(0).max(1).default(0.2),
    maxDelta: z.coerce.number().min(0).max(1).default(0.85),
    ivMax: z.coerce.number().positive().default(2.5),
    timezone: z.string().default(DEFAULT_TIMEZONE),
  }),
  instrument: z
    .object({
      mode: z.enum(["EQ", "FUT", "OPT"]).default("EQ"),
      token: z.coerce.number(),
      underlying: z.string().default(""),
      dynamicContracts: boolish(false).default(false),
      optionType: z.enum(["CE", "PE", "ALL"]).default("CE"),
      strikeStep: z.coerce.number().int().positive().default(50),
      scanSteps: z.coerce.number().int().min(0).default(2),
      greeksFilter: boolish(false).default(false),
      minDelta: z.coerce.number().min(0).max(1).default(0.2),
      maxDelta: z.coerce.number().min(0).max(1).default(0.85),
      ivMax: z.coerce.number().positive().default(2.5),
    })
    .default({}),
  market: z
    .object({
      timezone: z.string().default(DEFAULT_TIMEZONE),
      forceEodExit: boolish(false).default(false),
      conservativePathExit: boolish(true).default(true),
    })
    .default({}),
  execution: z
    .object({
      execRealism: boolish(true).default(true),
      eventBroker: boolish(true).default(true),
      calibrationDays: z.coerce.number().int().min(1).default(5),
      calibrationMode: z.enum(["fixed", "recent"]).default("fixed"),
      slippageBps: z.coerce.number().min(0).default(3),
      spreadBps: z.coerce.number().min(0).default(0),
      partialFillProbability: z.coerce.number().min(0).max(1).default(0.15),
      minPartialFillRatio: z.coerce.number().min(0).max(1).default(0.35),
      delayMs: maybeNumber().default(0),
      minOptionVolume: maybeNumber().default(0),
      maxSpreadBps: maybeNumber(),
    })
    .default({}),
  capital: z
    .object({
      startingCapital: z.coerce.number().positive().default(50000),
      initialCapital: maybeNumber(),
      capitalPerTrade: maybeNumber(),
      marginMultiplier: z.coerce.number().positive().default(1),
      reserveBufferPct: z.coerce.number().min(0).max(100).default(0),
    })
    .default({}),
  risk: z
    .object({
      riskPerTradeInr: maybeNumber(),
      riskPerTradePct: maybeNumber(),
      maxDailyLossInr: maybeNumber(),
      maxDrawdownInr: maybeNumber(),
      maxDrawdownPct: maybeNumber(),
      maxConsecutiveLosses: maybeNumber(),
      maxTradesPerDay: maybeNumber(),
      maxConcurrentPositions: z.coerce.number().int().min(1).default(1),
      maxOpenRiskInr: maybeNumber(),
      cooldownCandles: z.coerce.number().int().min(0).default(0),
      staleSignalBars: z.coerce.number().int().min(0).default(5),
      staleSignalMs: maybeNumber(),
      entryCutoffTime: z.string().optional(),
      haltAfterConsecutiveLosses: maybeNumber(),
      skipEntriesAfterDrawdownPct: maybeNumber(),
      skipEntriesAfterDrawdownInr: maybeNumber(),
    })
    .default({}),
  strategy: z
    .object({
      qtyMode: z.enum(["fixed", "lot_based", "risk_based", "capital_capped"]).default("fixed"),
      defaultQty: z.coerce.number().positive().default(1),
      fixedQty: maybeNumber(),
      lotQty: maybeNumber(),
      rrTarget: z.coerce.number().positive().default(1.4),
      slPctFallback: z.coerce.number().positive().default(0.7),
      confidenceMin: z.coerce.number().min(0).max(100).default(0),
      targetEnabled: z.boolean().optional(),
      allowedStrategies: z.array(z.string()).default([]),
    })
    .default({}),
  strategies: z
    .object({
      qtyMode: z.enum(["fixed", "lot_based", "risk_based", "capital_capped"]).default("fixed"),
      defaultQty: z.coerce.number().positive().default(1),
      fixedQty: maybeNumber(),
      lotQty: maybeNumber(),
      confidenceThreshold: maybeNumber(),
      confidenceMin: maybeNumber(),
      allowed: z.array(z.string()).default([]),
      allowedStrategies: z.array(z.string()).default([]),
    })
    .default({}),
  exits: z
    .object({
      rrTarget: z.coerce.number().positive().default(1.4),
      slPctFallback: z.coerce.number().positive().default(0.7),
      targetEnabled: z.boolean().optional(),
    })
    .default({}),
  reporting: z
    .object({
      outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
      writeCsv: boolish(true).default(true),
      writeJson: boolish(true).default(true),
      writeMarkdown: boolish(true).default(true),
      persistMongo: boolish(false).default(false),
      legacyOutFile: z.string().optional(),
    })
    .default({}),
  reports: z
    .object({
      outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
      writeCsv: boolish(true).default(true),
      writeJson: boolish(true).default(true),
      writeMarkdown: boolish(true).default(true),
      persistMongo: boolish(false).default(false),
      legacyOutFile: z.string().optional(),
    })
    .default({}),
  validation: z
    .object({
      dataQualityMode: z.enum(["off", "warn", "strict"]).default("strict"),
      lookAheadGuard: boolish(true).default(true),
      acceptance: acceptanceSchema,
    })
    .default({}),
  acceptance: acceptanceSchema,
  matrix: z
    .object({
      dimensions: z.record(z.array(z.any())).default({}),
      outputDir: z.string().optional(),
      leaderboardSort: z.array(z.string()).default(["netPnl", "profitFactor", "expectancy"]),
    })
    .default({}),
  batch: z
    .object({
      dimensions: z.record(z.array(z.any())).default({}),
      outputDir: z.string().optional(),
      leaderboardSort: z.array(z.string()).default(["netPnl", "profitFactor", "expectancy"]),
    })
    .default({}),
  walkForward: z
    .object({
      trainWindowDays: z.coerce.number().int().min(1).default(20),
      testWindowDays: z.coerce.number().int().min(1).default(5),
      stepDays: z.coerce.number().int().min(1).optional(),
      anchored: boolish(false).default(false),
      anchorMode: z.enum(["rolling", "expanding"]).optional(),
      outputDir: z.string().optional(),
      candidateParamGrid: z.record(z.array(z.any())).default({}),
      selectionMetric: z.string().default("netPnl"),
    })
    .default({}),
});

const CLI_MAPPINGS = {
  mode: ["instrument", "mode"],
  token: ["instrument", "token"],
  underlying: ["instrument", "underlying"],
  from: ["data", "from"],
  to: ["data", "to"],
  interval: ["data", "interval"],
  limit: ["data", "limit"],
  warmup: ["data", "warmup"],
  dynamicContracts: ["instrument", "dynamicContracts"],
  optionType: ["instrument", "optionType"],
  strikeStep: ["instrument", "strikeStep"],
  scanSteps: ["instrument", "scanSteps"],
  greeksFilter: ["instrument", "greeksFilter"],
  minDelta: ["instrument", "minDelta"],
  maxDelta: ["instrument", "maxDelta"],
  ivMax: ["instrument", "ivMax"],
  timezone: ["market", "timezone"],
  forceEodExit: ["market", "forceEodExit"],
  execRealism: ["execution", "execRealism"],
  eventBroker: ["execution", "eventBroker"],
  calibrationDays: ["execution", "calibrationDays"],
  calibrationMode: ["execution", "calibrationMode"],
  slippageBps: ["execution", "slippageBps"],
  spreadBps: ["execution", "spreadBps"],
  partialFillProbability: ["execution", "partialFillProbability"],
  minPartialFillRatio: ["execution", "minPartialFillRatio"],
  executionDelayMs: ["execution", "delayMs"],
  qty: ["strategies", "defaultQty"],
  qtyMode: ["strategies", "qtyMode"],
  fixedQty: ["strategies", "fixedQty"],
  lotQty: ["strategies", "lotQty"],
  rr: ["exits", "rrTarget"],
  rrTarget: ["exits", "rrTarget"],
  slPct: ["exits", "slPctFallback"],
  slPctFallback: ["exits", "slPctFallback"],
  confidenceMin: ["strategies", "confidenceMin"],
  confidenceThreshold: ["strategies", "confidenceThreshold"],
  targetEnabled: ["exits", "targetEnabled"],
  seed: ["metadata", "seed"],
  name: ["metadata", "name"],
  startingCapital: ["capital", "startingCapital"],
  initialCapital: ["capital", "initialCapital"],
  capitalPerTrade: ["capital", "capitalPerTrade"],
  marginMultiplier: ["capital", "marginMultiplier"],
  reserveBufferPct: ["capital", "reserveBufferPct"],
  riskPerTradeInr: ["risk", "riskPerTradeInr"],
  riskPerTradePct: ["risk", "riskPerTradePct"],
  maxDailyLossInr: ["risk", "maxDailyLossInr"],
  maxDrawdownInr: ["risk", "maxDrawdownInr"],
  maxDrawdownPct: ["risk", "maxDrawdownPct"],
  maxConsecutiveLosses: ["risk", "maxConsecutiveLosses"],
  maxTradesPerDay: ["risk", "maxTradesPerDay"],
  maxConcurrentPositions: ["risk", "maxConcurrentPositions"],
  maxOpenRiskInr: ["risk", "maxOpenRiskInr"],
  cooldownCandles: ["risk", "cooldownCandles"],
  staleSignalBars: ["risk", "staleSignalBars"],
  staleSignalMs: ["risk", "staleSignalMs"],
  entryCutoffTime: ["risk", "entryCutoffTime"],
  dataQuality: ["validation", "dataQualityMode"],
  dataQualityMode: ["validation", "dataQualityMode"],
  lookAheadGuard: ["validation", "lookAheadGuard"],
  outputDir: ["reports", "outputDir"],
  writeCsv: ["reports", "writeCsv"],
  writeJson: ["reports", "writeJson"],
  writeMarkdown: ["reports", "writeMarkdown"],
  persistMongo: ["reports", "persistMongo"],
  out: ["reports", "legacyOutFile"],
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra === undefined ? base : extra;
  if (!isPlainObject(base) || !isPlainObject(extra)) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function setByPath(target, pathParts, value) {
  let cursor = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    const key = pathParts[index];
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[pathParts[pathParts.length - 1]] = value;
  return target;
}

function parseScalar(raw) {
  if (raw === true) return true;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const lower = trimmed.toLowerCase();
  if (["true", "false"].includes(lower)) return lower === "true";
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const raw = {};
  const cliConfig = {};
  for (const arg of argv) {
    if (!String(arg).startsWith("--")) continue;
    const body = String(arg).slice(2);
    const eqIdx = body.indexOf("=");
    const key = eqIdx >= 0 ? body.slice(0, eqIdx) : body;
    const rawValue = eqIdx >= 0 ? body.slice(eqIdx + 1) : true;
    raw[key] = rawValue;
    if (CLI_MAPPINGS[key]) setByPath(cliConfig, CLI_MAPPINGS[key], parseScalar(rawValue));
  }
  return {
    raw,
    cliConfig,
    configPath: raw.config ? path.resolve(process.cwd(), String(raw.config)) : null,
  };
}

function loadConfigFile(configPath) {
  if (!configPath) return {};
  if (!fs.existsSync(configPath)) throw new Error(`Backtest config file not found: ${configPath}`);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse backtest config JSON at ${configPath}: ${error.message}`);
  }
}

function normalizeMatrixConfig(raw = {}) {
  return {
    dimensions: raw.dimensions || {},
    outputDir: raw.outputDir,
    leaderboardSort: Array.isArray(raw.leaderboardSort) ? raw.leaderboardSort : ["netPnl", "profitFactor", "expectancy"],
  };
}

function normalizeWalkForwardConfig(raw = {}) {
  const anchorMode = raw.anchorMode || (raw.anchored ? "expanding" : "rolling");
  return {
    trainWindowDays: raw.trainWindowDays,
    testWindowDays: raw.testWindowDays,
    stepDays: raw.stepDays,
    anchored: anchorMode === "expanding",
    anchorMode,
    outputDir: raw.outputDir,
    candidateParamGrid: raw.candidateParamGrid || raw.candidateParams || {},
    selectionMetric: raw.selectionMetric || "netPnl",
  };
}

function assertNoUnsupportedBacktestConfig(raw = {}, cliArgs = {}) {
  const optimizerGateProvided =
    cliArgs.optimizerGateEnabled !== undefined ||
    raw?.strategy?.optimizerGateEnabled !== undefined ||
    raw?.strategies?.optimizerGateEnabled !== undefined;
  if (optimizerGateProvided) {
    throw new Error(
      "Invalid backtest config:\n- strategy.optimizerGateEnabled is not supported in backtest mode. Remove it from the config/CLI.",
    );
  }
}

function normalizeIncomingShape(raw = {}) {
  const metadata = deepMerge(raw.runMeta || {}, raw.metadata || {});
  const reports = deepMerge(raw.reporting || {}, raw.reports || {});
  const instrument = deepMerge(
    {
      mode: raw.data?.mode,
      token: raw.data?.token,
      underlying: raw.data?.underlying,
      dynamicContracts: raw.data?.dynamicContracts,
      optionType: raw.data?.optionType,
      strikeStep: raw.data?.strikeStep,
      scanSteps: raw.data?.scanSteps,
      greeksFilter: raw.data?.greeksFilter,
      minDelta: raw.data?.minDelta,
      maxDelta: raw.data?.maxDelta,
      ivMax: raw.data?.ivMax,
    },
    raw.instrument || {},
  );
  const data = deepMerge(raw.data || {}, {
    mode: instrument.mode,
    token: instrument.token,
    underlying: instrument.underlying,
    dynamicContracts: instrument.dynamicContracts,
    optionType: instrument.optionType,
    strikeStep: instrument.strikeStep,
    scanSteps: instrument.scanSteps,
    greeksFilter: instrument.greeksFilter,
    minDelta: instrument.minDelta,
    maxDelta: instrument.maxDelta,
    ivMax: instrument.ivMax,
  });
  const strategies = deepMerge(raw.strategy || {}, raw.strategies || {});
  const exits = deepMerge(
    {
      rrTarget: raw.strategy?.rrTarget,
      slPctFallback: raw.strategy?.slPctFallback,
      targetEnabled: raw.strategy?.targetEnabled,
    },
    raw.exits || {},
  );
  const capital = {
    ...raw.capital,
    startingCapital: raw.capital?.startingCapital ?? raw.capital?.initialCapital,
  };
  const validation = deepMerge(raw.validation || {}, {
    acceptance: normalizeAcceptanceConfig(raw.acceptance || raw.validation?.acceptance || {}),
  });
  return {
    ...raw,
    runMeta: metadata,
    metadata,
    data,
    instrument,
    capital,
    strategy: {
      qtyMode: strategies.qtyMode ?? raw.strategy?.qtyMode,
      defaultQty: strategies.defaultQty ?? raw.strategy?.defaultQty,
      fixedQty: strategies.fixedQty,
      lotQty: strategies.lotQty,
      rrTarget: exits.rrTarget,
      slPctFallback: exits.slPctFallback,
      confidenceMin: strategies.confidenceMin ?? strategies.confidenceThreshold ?? raw.strategy?.confidenceMin,
      targetEnabled: exits.targetEnabled ?? raw.strategy?.targetEnabled,
      allowedStrategies: strategies.allowedStrategies || strategies.allowed || raw.strategy?.allowedStrategies || [],
    },
    strategies,
    exits,
    reporting: reports,
    reports,
    validation,
    acceptance: validation.acceptance,
    matrix: normalizeMatrixConfig(raw.matrix || raw.batch || {}),
    batch: normalizeMatrixConfig(raw.batch || raw.matrix || {}),
    walkForward: normalizeWalkForwardConfig(raw.walkForward || {}),
  };
}

function normalizeResolvedConfig(config) {
  const timezone = config.market?.timezone || config.data?.timezone || DEFAULT_TIMEZONE;
  const outputDir = path.resolve(process.cwd(), config.reporting.outputDir || DEFAULT_OUTPUT_DIR);
  const walkForwardOutput = config.walkForward.outputDir
    ? path.resolve(process.cwd(), config.walkForward.outputDir)
    : undefined;
  const matrixOutput = config.matrix.outputDir ? path.resolve(process.cwd(), config.matrix.outputDir) : undefined;
  const acceptance = normalizeAcceptanceConfig(config.validation.acceptance || config.acceptance || {});

  const normalized = {
    ...config,
    metadata: {
      ...config.metadata,
      name: config.runMeta.name,
      seed: config.runMeta.seed,
      notes: config.runMeta.notes,
      tags: config.runMeta.tags,
    },
    data: {
      ...config.data,
      mode: String(config.data.mode || "EQ").toUpperCase(),
      optionType: String(config.data.optionType || "CE").toUpperCase(),
      timezone,
      limit: Number(config.data.limit || 0),
    },
    instrument: {
      ...config.instrument,
      mode: String(config.data.mode || "EQ").toUpperCase(),
      token: Number(config.data.token),
      underlying: config.data.underlying,
      dynamicContracts: Boolean(config.data.dynamicContracts),
      optionType: String(config.data.optionType || "CE").toUpperCase(),
      strikeStep: Number(config.data.strikeStep || 50),
      scanSteps: Number(config.data.scanSteps || 2),
      greeksFilter: Boolean(config.data.greeksFilter),
      minDelta: Number(config.data.minDelta),
      maxDelta: Number(config.data.maxDelta),
      ivMax: Number(config.data.ivMax),
    },
    market: {
      ...config.market,
      timezone,
    },
    capital: {
      ...config.capital,
      startingCapital: Number(config.capital.startingCapital),
      initialCapital: Number(config.capital.startingCapital),
    },
    strategy: {
      ...config.strategy,
      allowedStrategies: Array.isArray(config.strategy.allowedStrategies) ? config.strategy.allowedStrategies : [],
    },
    strategies: {
      ...config.strategies,
      qtyMode: config.strategy.qtyMode,
      defaultQty: config.strategy.defaultQty,
      fixedQty: config.strategy.fixedQty,
      lotQty: config.strategy.lotQty,
      confidenceMin: config.strategy.confidenceMin,
      confidenceThreshold: config.strategy.confidenceMin,
      allowed: config.strategy.allowedStrategies,
      allowedStrategies: config.strategy.allowedStrategies,
    },
    exits: {
      ...config.exits,
      rrTarget: Number(config.strategy.rrTarget),
      slPctFallback: Number(config.strategy.slPctFallback),
      targetEnabled: config.strategy.targetEnabled,
    },
    reporting: {
      ...config.reporting,
      outputDir,
      legacyOutFile: config.reporting.legacyOutFile
        ? path.resolve(process.cwd(), config.reporting.legacyOutFile)
        : undefined,
    },
    reports: {
      ...config.reports,
      outputDir,
    },
    validation: {
      ...config.validation,
      acceptance,
    },
    acceptance,
    matrix: {
      ...config.matrix,
      outputDir: matrixOutput,
    },
    batch: {
      ...config.batch,
      outputDir: matrixOutput,
    },
    walkForward: {
      ...config.walkForward,
      stepDays: Number(config.walkForward.stepDays || config.walkForward.testWindowDays || 1),
      anchored: String(config.walkForward.anchorMode || "rolling") === "expanding" || Boolean(config.walkForward.anchored),
      anchorMode:
        String(config.walkForward.anchorMode || (config.walkForward.anchored ? "expanding" : "rolling")).toLowerCase() ===
        "expanding"
          ? "expanding"
          : "rolling",
      outputDir: walkForwardOutput,
    },
  };

  normalized.runMeta = {
    ...normalized.runMeta,
    name: normalized.metadata.name,
    seed: normalized.metadata.seed,
    notes: normalized.metadata.notes,
    tags: normalized.metadata.tags,
  };

  return normalized;
}

function validateOutputDir(outputDir, errors) {
  if (!outputDir) {
    errors.push("reports.outputDir is required");
    return;
  }
  const resolved = path.resolve(process.cwd(), outputDir);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    errors.push(`reports.outputDir points to a file, not a directory: ${resolved}`);
    return;
  }
  const parent = path.dirname(resolved);
  if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) {
    errors.push(`reports.outputDir parent is not a directory: ${parent}`);
  }
}

function validateResolvedConfig(config) {
  const errors = [];
  const fromMs = new Date(config.data.from).getTime();
  const toMs = new Date(config.data.to).getTime();
  if (!Number.isFinite(fromMs)) errors.push("data.from must be a valid ISO date/time");
  if (!Number.isFinite(toMs)) errors.push("data.to must be a valid ISO date/time");
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs >= toMs) {
    errors.push("data.from must be earlier than data.to");
  }
  if (!(Number(config.data.interval) >= 1)) errors.push("data.interval must be a positive integer");
  if (!(Number(config.data.warmup) >= 1)) errors.push("data.warmup must be at least 1");
  if (!(Number(config.capital.startingCapital) > 0)) errors.push("capital.initialCapital must be greater than 0");
  if (config.capital.capitalPerTrade !== undefined && Number(config.capital.capitalPerTrade) <= 0) {
    errors.push("capital.capitalPerTrade must be greater than 0 when provided");
  }
  if (config.risk.riskPerTradeInr !== undefined && Number(config.risk.riskPerTradeInr) < 0) {
    errors.push("risk.riskPerTradeInr cannot be negative");
  }
  if (config.risk.riskPerTradePct !== undefined && Number(config.risk.riskPerTradePct) < 0) {
    errors.push("risk.riskPerTradePct cannot be negative");
  }
  if (config.risk.maxDailyLossInr !== undefined && Number(config.risk.maxDailyLossInr) < 0) {
    errors.push("risk.maxDailyLossInr cannot be negative");
  }
  if (config.risk.maxConcurrentPositions !== undefined && Number(config.risk.maxConcurrentPositions) < 1) {
    errors.push("risk.maxConcurrentPositions must be at least 1");
  }
  if (config.risk.entryCutoffTime !== undefined && config.risk.entryCutoffTime !== null) {
    const cutoff = String(config.risk.entryCutoffTime).trim();
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(cutoff)) {
      errors.push("risk.entryCutoffTime must use HH:mm format");
    }
  }
  if (config.data.mode === "OPT" && !config.data.underlying) {
    errors.push("instrument.underlying is required for OPT mode");
  }
  if (config.strategy.qtyMode === "fixed" && !(Number(config.strategy.fixedQty ?? config.strategy.defaultQty) > 0)) {
    errors.push("strategies.fixedQty/defaultQty must be greater than 0 for qtyMode=fixed");
  }
  if (config.strategy.qtyMode === "lot_based" && !(Number(config.strategy.lotQty ?? config.strategy.defaultQty) > 0)) {
    errors.push("strategies.lotQty/defaultQty must be greater than 0 for qtyMode=lot_based");
  }
  if (config.walkForward.trainWindowDays !== undefined && config.walkForward.testWindowDays !== undefined) {
    if (Number(config.walkForward.trainWindowDays) < 1 || Number(config.walkForward.testWindowDays) < 1) {
      errors.push("walkForward train/test windows must be positive integers");
    }
  }
  validateOutputDir(config.reporting.outputDir, errors);
  if (config.matrix.outputDir) validateOutputDir(config.matrix.outputDir, errors);
  if (config.walkForward.outputDir) validateOutputDir(config.walkForward.outputDir, errors);
  if (errors.length) {
    throw new Error(`Invalid backtest config:\n- ${errors.join("\n- ")}`);
  }
}

function configFingerprint(config) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 12);
}

function loadRunConfig({ argv = process.argv.slice(2), configOverrides = {} } = {}) {
  const parsed = parseCliArgs(argv);
  const fileConfig = loadConfigFile(parsed.configPath);
  const merged = deepMerge(deepMerge(fileConfig, configOverrides), parsed.cliConfig);
  assertNoUnsupportedBacktestConfig(merged, parsed.raw);
  const normalizedInput = normalizeIncomingShape(merged);
  const parsedConfig = internalConfigSchema.parse(normalizedInput);
  const config = normalizeResolvedConfig(parsedConfig);
  validateResolvedConfig(config);
  return {
    config,
    cliArgs: parsed.raw,
    configPath: parsed.configPath,
    fingerprint: configFingerprint(config),
  };
}

module.exports = {
  CLI_MAPPINGS,
  DEFAULT_OUTPUT_DIR,
  acceptanceSchema,
  configFingerprint,
  deepMerge,
  internalConfigSchema,
  loadConfigFile,
  loadRunConfig,
  assertNoUnsupportedBacktestConfig,
  normalizeAcceptanceConfig,
  normalizeIncomingShape,
  normalizeResolvedConfig,
  parseCliArgs,
  parseScalar,
  setByPath,
  validateResolvedConfig,
};
