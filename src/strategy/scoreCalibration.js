const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CALIBRATION = {
  version: "static-v2",
  source: "fallback:static",
  active: false,
  fallbackReason: "MISSING_ARTIFACT",
  defaults: {
    raw: null,
    qualityWeights: {
      patternQuality: 0.28,
      volumeQuality: 0.18,
      anchorQuality: 0.22,
      structureQuality: 0.32,
    },
    contextWeights: {
      regimeAlignment: 0.22,
      freshness: 0.15,
      antiChop: 0.1,
      stageScore: 0.14,
      mtfAgreementScore: 0.16,
      antiGap: 0.05,
      selectorParticipation: 0.18,
    },
    finalWeights: {
      normalizedConfidence: 0.34,
      qualityScore: 0.33,
      contextScore: 0.33,
    },
    bias: 0,
  },
  intervals: {},
  families: {},
  strategies: {},
};

let cachedPath = null;
let cachedMtimeMs = null;
let cachedCalibration = DEFAULT_CALIBRATION;

function calibrationPath() {
  return path.resolve(
    process.env.SIGNAL_SCORE_CALIBRATION_FILE ||
      path.join(__dirname, "..", "..", "config", "signal_score_calibration.json"),
  );
}

function mergeWeights(base, extra) {
  return {
    ...base,
    ...(extra || {}),
  };
}

function normalizeWeightMap(rawWeights, fallback) {
  const merged = mergeWeights(fallback, rawWeights);
  const cleaned = {};
  let total = 0;
  for (const [key, value] of Object.entries(merged)) {
    const numeric = Number(value);
    cleaned[key] = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
    total += cleaned[key];
  }
  if (!Number.isFinite(total) || total <= 0) {
    return { ...fallback };
  }
  const normalized = {};
  for (const [key, value] of Object.entries(cleaned)) {
    normalized[key] = Number((value / total).toFixed(4));
  }
  return normalized;
}

function normalizeRawProfile(rawProfile, fallback) {
  if (!rawProfile) return fallback;
  const floor = Number(rawProfile.floor);
  const ceil = Number(rawProfile.ceil);
  const shape = Number(rawProfile.shape ?? 1);
  if (!Number.isFinite(floor) || !Number.isFinite(ceil) || ceil <= floor) {
    return fallback;
  }
  return {
    floor: Number(floor.toFixed(2)),
    ceil: Number(ceil.toFixed(2)),
    shape: Number.isFinite(shape) && shape > 0 ? Number(shape.toFixed(4)) : 1,
  };
}

function intervalFamily(intervalMin) {
  const value = Number(intervalMin ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "INTRADAY";
  if (value <= 1) return "FAST";
  if (value <= 3) return "INTRADAY";
  return "SLOW";
}

function normalizeBucket(rawBucket, fallbackBucket) {
  if (!rawBucket || typeof rawBucket !== "object") return {};
  return {
    raw: normalizeRawProfile(rawBucket.raw, fallbackBucket.raw || null),
    qualityWeights: normalizeWeightMap(
      rawBucket.qualityWeights,
      fallbackBucket.qualityWeights,
    ),
    contextWeights: normalizeWeightMap(
      rawBucket.contextWeights,
      fallbackBucket.contextWeights,
    ),
    finalWeights: normalizeWeightMap(
      rawBucket.finalWeights,
      fallbackBucket.finalWeights,
    ),
    bias: Number.isFinite(Number(rawBucket.bias))
      ? Number(rawBucket.bias)
      : Number(fallbackBucket.bias || 0),
  };
}

function validateCalibrationArtifact(raw, artifactPath = calibrationPath()) {
  if (!raw || typeof raw !== "object") {
    throw new Error("artifact must be a JSON object");
  }

  const defaults = normalizeBucket(raw.defaults || {}, DEFAULT_CALIBRATION.defaults);
  const normalizeGroup = (group) => {
    const source = group && typeof group === "object" ? group : {};
    const next = {};
    for (const [key, value] of Object.entries(source)) {
      if (!value || typeof value !== "object") continue;
      next[String(key)] = normalizeBucket(value, defaults);
    }
    return next;
  };

  return {
    version: String(raw.version || DEFAULT_CALIBRATION.version),
    source: String(raw.source || `artifact:${path.basename(artifactPath)}`),
    active: true,
    fallbackReason: null,
    defaults,
    intervals: normalizeGroup(raw.intervals),
    families: normalizeGroup(raw.families),
    strategies: normalizeGroup(raw.strategies),
  };
}

function fallbackCalibration(reason, artifactPath = calibrationPath()) {
  return {
    ...DEFAULT_CALIBRATION,
    source: fs.existsSync(artifactPath)
      ? `fallback:${path.basename(artifactPath)}`
      : DEFAULT_CALIBRATION.source,
    fallbackReason: reason || DEFAULT_CALIBRATION.fallbackReason,
  };
}

function loadCalibration() {
  const artifactPath = calibrationPath();
  try {
    const stat = fs.statSync(artifactPath);
    if (
      cachedPath === artifactPath &&
      cachedMtimeMs === stat.mtimeMs &&
      cachedCalibration
    ) {
      return cachedCalibration;
    }

    const parsed = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    cachedCalibration = validateCalibrationArtifact(parsed, artifactPath);
    cachedPath = artifactPath;
    cachedMtimeMs = stat.mtimeMs;
    return cachedCalibration;
  } catch (error) {
    cachedPath = artifactPath;
    cachedMtimeMs = null;
    const reason =
      error?.code === "ENOENT"
        ? "MISSING_ARTIFACT"
        : `INVALID_ARTIFACT:${String(error?.message || error).slice(0, 120)}`;
    cachedCalibration = fallbackCalibration(reason, artifactPath);
    return cachedCalibration;
  }
}

function resolveScoreCalibration(strategyId, strategyFamily, intervalMin) {
  const artifact = loadCalibration();
  const intervalBucket =
    artifact.intervals?.[intervalFamily(intervalMin)] || {};
  const family = artifact.families?.[String(strategyFamily || "")] || {};
  const strategy = artifact.strategies?.[String(strategyId || "")] || {};

  return {
    version: artifact.version,
    source: artifact.source,
    active: artifact.active === true,
    fallbackReason: artifact.fallbackReason || null,
    raw:
      strategy.raw ||
      family.raw ||
      intervalBucket.raw ||
      artifact.defaults.raw ||
      null,
    qualityWeights: normalizeWeightMap(
      mergeWeights(
        mergeWeights(intervalBucket.qualityWeights, family.qualityWeights),
        strategy.qualityWeights,
      ),
      artifact.defaults.qualityWeights,
    ),
    contextWeights: normalizeWeightMap(
      mergeWeights(
        mergeWeights(intervalBucket.contextWeights, family.contextWeights),
        strategy.contextWeights,
      ),
      artifact.defaults.contextWeights,
    ),
    finalWeights: normalizeWeightMap(
      mergeWeights(
        mergeWeights(intervalBucket.finalWeights, family.finalWeights),
        strategy.finalWeights,
      ),
      artifact.defaults.finalWeights,
    ),
    bias:
      Number.isFinite(Number(strategy.bias))
        ? Number(strategy.bias)
        : Number.isFinite(Number(family.bias))
          ? Number(family.bias)
          : Number.isFinite(Number(intervalBucket.bias))
            ? Number(intervalBucket.bias)
            : Number(artifact.defaults.bias || 0),
  };
}

function describeCalibrationState() {
  const artifact = loadCalibration();
  return {
    calibrationActive: artifact.active === true,
    calibrationVersion: artifact.version,
    calibrationSource: artifact.source,
    fallbackReason: artifact.fallbackReason || null,
  };
}

function resetScoreCalibrationCache() {
  cachedPath = null;
  cachedMtimeMs = null;
  cachedCalibration = DEFAULT_CALIBRATION;
}

module.exports = {
  DEFAULT_CALIBRATION,
  calibrationPath,
  intervalFamily,
  validateCalibrationArtifact,
  loadCalibration,
  resolveScoreCalibration,
  describeCalibrationState,
  resetScoreCalibrationCache,
};
