const fs = require("node:fs");
const path = require("node:path");
const {
  intervalFamily,
  validateCalibrationArtifact,
} = require("../src/strategy/scoreCalibration");
const {
  normalizeCapturedSignalRecord,
  scoreOutcome,
  labelOutcome,
} = require("../src/backtest/signalCapture");

function usage() {
  console.error(
    "Usage: node scripts/build_signal_score_calibration.js <input.json> [output.json]",
  );
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues, pct) {
  if (!sortedValues.length) return null;
  const index = Math.max(
    0,
    Math.min(sortedValues.length - 1, Math.round((sortedValues.length - 1) * pct)),
  );
  return sortedValues[index];
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function normalizeOutcomeScore(record) {
  return scoreOutcome({
    outcomeScore: record?.outcomeScore,
    outcome: record?.outcome,
    pnlR: record?.pnlR,
  });
}

function normalizeCalibrationRecord(record) {
  const normalized = normalizeCapturedSignalRecord(record);
  const outcomeScore = normalizeOutcomeScore(normalized);
  const strategyId = String(normalized?.strategyId || "").trim();
  const intervalMin = Number(normalized?.intervalMin);
  if (!strategyId || !Number.isFinite(intervalMin) || intervalMin <= 0) return null;

  return {
    strategyId,
    strategyFamily: String(normalized?.strategyFamily || "").trim() || null,
    intervalMin,
    rawConfidence: Number(normalized?.rawConfidence ?? normalized?.confidence),
    normalizedConfidence: Number(normalized?.normalizedConfidence),
    patternQuality: Number(normalized?.patternQuality),
    volumeQuality: Number(normalized?.volumeQuality),
    anchorQuality: Number(normalized?.anchorQuality),
    structureQuality: Number(normalized?.structureQuality),
    qualityScore: Number(normalized?.qualityScore),
    regimeAlignment: Number(normalized?.regimeAlignment),
    freshness: Number(normalized?.freshness),
    antiChop: Number(normalized?.antiChop),
    stageScore: Number(normalized?.stageScore),
    mtfAgreementScore: Number(normalized?.mtfAgreementScore),
    antiGap: Number(normalized?.antiGap),
    selectorParticipation: Number(normalized?.selectorParticipation),
    contextScore: Number(normalized?.contextScore),
    finalSignalScore: Number(normalized?.finalSignalScore),
    outcomeScore,
    outcome: labelOutcome({
      outcome: normalized?.outcome,
      pnlR: normalized?.pnlR,
      outcomeScore,
    }),
    pnlR: Number(normalized?.pnlR),
    mfeR: Number(normalized?.mfeR),
    maeR: Number(normalized?.maeR),
  };
}

function extractCalibrationRecords(input) {
  const rawRecords = Array.isArray(input)
    ? input
    : Array.isArray(input?.records)
      ? input.records
      : Array.isArray(input?.rows)
        ? input.rows
        : null;
  if (!rawRecords?.length) {
    throw new Error("No calibration records found in input file");
  }

  const accepted = [];
  const skipped = [];
  for (const rawRecord of rawRecords) {
    const normalized = normalizeCalibrationRecord(rawRecord);
    if (!normalized) {
      skipped.push({
        record: rawRecord,
        reason: "MISSING_STRATEGY_OR_INTERVAL",
      });
      continue;
    }
    if (!Number.isFinite(normalized.outcomeScore)) {
      skipped.push({
        record: rawRecord,
        reason: "MISSING_OUTCOME",
      });
      continue;
    }
    accepted.push(normalized);
  }
  if (!accepted.length) {
    throw new Error("No valid calibration records found after normalization");
  }
  return {
    records: accepted,
    skipped,
  };
}

function weightFromOutcome(records, key) {
  const weighted = records
    .map((record) => ({
      feature: Number(record?.[key]),
      outcome: Number(record?.outcomeScore),
    }))
    .filter((entry) => Number.isFinite(entry.feature) && Number.isFinite(entry.outcome));
  if (!weighted.length) return null;

  const featureMean = average(weighted.map((entry) => entry.feature)) || 0;
  const outcomeMean = average(weighted.map((entry) => entry.outcome)) || 0;
  let numerator = 0;
  let featureVar = 0;
  let outcomeVar = 0;
  for (const entry of weighted) {
    const dx = entry.feature - featureMean;
    const dy = entry.outcome - outcomeMean;
    numerator += dx * dy;
    featureVar += dx * dx;
    outcomeVar += dy * dy;
  }

  const denom = Math.sqrt(featureVar * outcomeVar);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return clamp01((numerator / denom + 1) / 2);
}

function normalizeWeights(rawWeights, fallback) {
  const merged = {};
  for (const key of Object.keys(fallback)) {
    merged[key] = Number.isFinite(Number(rawWeights?.[key]))
      ? Math.max(0, Number(rawWeights[key]))
      : Number(fallback[key]);
  }
  const total = Object.values(merged).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return fallback;

  const normalized = {};
  for (const [key, value] of Object.entries(merged)) {
    normalized[key] = Number((value / total).toFixed(4));
  }
  return normalized;
}

function biasFromOutcomes(records) {
  const outcomes = records
    .map((record) => Number(record?.outcomeScore))
    .filter(Number.isFinite);
  if (!outcomes.length) return 0;
  const mean = average(outcomes);
  return Number((((mean ?? 0) - 0.5) * 8).toFixed(2));
}

function rawProfile(records) {
  const rawConfidence = records
    .map((record) => Number(record?.rawConfidence))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (rawConfidence.length < 5) return null;
  return {
    floor: Number((percentile(rawConfidence, 0.1) ?? 55).toFixed(2)),
    ceil: Number((percentile(rawConfidence, 0.9) ?? 95).toFixed(2)),
    shape: 1.0,
  };
}

function buildBucket(records, fallbackQuality, fallbackContext, fallbackFinal) {
  return {
    raw: rawProfile(records),
    qualityWeights: normalizeWeights(
      {
        patternQuality: weightFromOutcome(records, "patternQuality"),
        volumeQuality: weightFromOutcome(records, "volumeQuality"),
        anchorQuality: weightFromOutcome(records, "anchorQuality"),
        structureQuality: weightFromOutcome(records, "structureQuality"),
      },
      fallbackQuality,
    ),
    contextWeights: normalizeWeights(
      {
        regimeAlignment: weightFromOutcome(records, "regimeAlignment"),
        freshness: weightFromOutcome(records, "freshness"),
        antiChop: weightFromOutcome(records, "antiChop"),
        stageScore: weightFromOutcome(records, "stageScore"),
        mtfAgreementScore: weightFromOutcome(records, "mtfAgreementScore"),
        antiGap: weightFromOutcome(records, "antiGap"),
        selectorParticipation: weightFromOutcome(records, "selectorParticipation"),
      },
      fallbackContext,
    ),
    finalWeights: normalizeWeights(
      {
        normalizedConfidence: weightFromOutcome(records, "normalizedConfidence"),
        qualityScore: weightFromOutcome(records, "qualityScore"),
        contextScore: weightFromOutcome(records, "contextScore"),
      },
      fallbackFinal,
    ),
    bias: biasFromOutcomes(records),
  };
}

function groupRecords(records, keyFn) {
  const grouped = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!key) continue;
    const bucket = grouped.get(key) || [];
    bucket.push(record);
    grouped.set(key, bucket);
  }
  return grouped;
}

function buildCalibrationArtifactFromRecords(records, options = {}) {
  const fallbackQuality = options.fallbackQuality || {
    patternQuality: 0.28,
    volumeQuality: 0.18,
    anchorQuality: 0.22,
    structureQuality: 0.32,
  };
  const fallbackContext = options.fallbackContext || {
    regimeAlignment: 0.22,
    freshness: 0.15,
    antiChop: 0.1,
    stageScore: 0.14,
    mtfAgreementScore: 0.16,
    antiGap: 0.05,
    selectorParticipation: 0.18,
  };
  const fallbackFinal = options.fallbackFinal || {
    normalizedConfidence: 0.34,
    qualityScore: 0.33,
    contextScore: 0.33,
  };

  const strategies = {};
  for (const [strategyId, bucket] of groupRecords(records, (record) =>
    String(record?.strategyId || "").trim(),
  ).entries()) {
    strategies[strategyId] = buildBucket(
      bucket,
      fallbackQuality,
      fallbackContext,
      fallbackFinal,
    );
  }

  const families = {};
  for (const [familyId, bucket] of groupRecords(records, (record) =>
    String(record?.strategyFamily || "").trim(),
  ).entries()) {
    families[familyId] = buildBucket(
      bucket,
      fallbackQuality,
      fallbackContext,
      fallbackFinal,
    );
  }

  const intervals = {};
  for (const [intervalId, bucket] of groupRecords(records, (record) =>
    intervalFamily(record?.intervalMin),
  ).entries()) {
    intervals[intervalId] = buildBucket(
      bucket,
      fallbackQuality,
      fallbackContext,
      fallbackFinal,
    );
  }

  return validateCalibrationArtifact(
    {
      version:
        options.version || `replay-${new Date().toISOString()}`,
      source: options.source || "generated:signal_capture",
      defaults: {
        qualityWeights: fallbackQuality,
        contextWeights: fallbackContext,
        finalWeights: fallbackFinal,
        bias: 0,
      },
      intervals,
      families,
      strategies,
    },
    options.outputPath,
  );
}

function writeCalibrationArtifact(artifact, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outputPath;
}

function main() {
  const inputPath = process.argv[2];
  const outputPath =
    process.argv[3] ||
    path.join(process.cwd(), "config", "signal_score_calibration.json");
  if (!inputPath) usage();

  const input = readJson(path.resolve(inputPath));
  const { records, skipped } = extractCalibrationRecords(input);
  const artifact = buildCalibrationArtifactFromRecords(records, {
    outputPath,
    source: `generated:${path.basename(inputPath)}`,
  });
  writeCalibrationArtifact(artifact, outputPath);
  console.log(
    `Wrote signal score calibration to ${outputPath} (${records.length} usable / ${skipped.length} skipped)`,
  );
}

module.exports = {
  extractCalibrationRecords,
  normalizeCalibrationRecord,
  buildCalibrationArtifactFromRecords,
  writeCalibrationArtifact,
};

if (require.main === module) {
  main();
}
