function toNumberOrUndefined(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return Boolean(value);
}

function resolveAcceptanceField(raw = {}, aliases = []) {
  for (const field of aliases) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    const value = raw[field];
    if (value === undefined || value === null || value === "") continue;
    return {
      sourceField: field,
      rawValue: value,
    };
  }
  return {
    sourceField: null,
    rawValue: undefined,
  };
}

function normalizeSingleMonthContributionPct(value) {
  const numeric = toNumberOrUndefined(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
}

const ACCEPTANCE_FIELD_ALIASES = Object.freeze({
  minTrades: ["minTrades", "minimumTrades"],
  minNetPnl: ["minNetPnl"],
  minProfitFactor: ["minProfitFactor", "minimumProfitFactor"],
  minExpectancy: ["minExpectancy", "minimumExpectancy"],
  maxDrawdownAbs: ["maxDrawdownAbs", "maximumDrawdownInr"],
  maxDrawdownPct: ["maxDrawdownPct", "maximumDrawdownPct"],
  maxSingleMonthContributionPct: [
    "maxSingleMonthContributionPct",
    "maxSingleMonthPnlShare",
  ],
  minMonthsPositive: ["minMonthsPositive"],
  minOOSProfitFactor: ["minOOSProfitFactor"],
  minOOSNetPnl: ["minOOSNetPnl"],
  maxRejectedByDataIssuesPct: ["maxRejectedByDataIssuesPct"],
  maxForcedExitPct: ["maxForcedExitPct"],
  minWinRate: ["minWinRate", "minimumWinRate"],
  requireOutOfSampleProfitable: ["requireOutOfSampleProfitable"],
});

function canonicalizeAcceptanceConfig(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const acceptanceConfig = {
    minTrades: 0,
    minNetPnl: undefined,
    minProfitFactor: undefined,
    minExpectancy: undefined,
    maxDrawdownAbs: undefined,
    maxDrawdownPct: undefined,
    maxSingleMonthContributionPct: undefined,
    minMonthsPositive: undefined,
    minOOSProfitFactor: undefined,
    minOOSNetPnl: undefined,
    maxRejectedByDataIssuesPct: undefined,
    maxForcedExitPct: undefined,
    minWinRate: undefined,
    requireOutOfSampleProfitable: false,
  };
  const compatibility = {};

  for (const [canonicalField, aliases] of Object.entries(
    ACCEPTANCE_FIELD_ALIASES,
  )) {
    const resolved = resolveAcceptanceField(source, aliases);
    const rawValue = resolved.rawValue;
    let normalizedValue;
    let unit = null;
    let sourceUnit = null;

    if (canonicalField === "maxSingleMonthContributionPct") {
      normalizedValue = normalizeSingleMonthContributionPct(rawValue);
      if (Number.isFinite(normalizedValue)) {
        unit = "pct";
        const numeric = toNumberOrUndefined(rawValue);
        sourceUnit =
          Number.isFinite(numeric) && Math.abs(numeric) <= 1 ? "ratio" : "pct";
      }
    } else if (canonicalField === "requireOutOfSampleProfitable") {
      normalizedValue =
        resolved.sourceField !== null ? toBoolean(rawValue, false) : false;
    } else {
      normalizedValue = toNumberOrUndefined(rawValue);
    }

    if (canonicalField === "minTrades" && normalizedValue === undefined) {
      normalizedValue = 0;
    }

    acceptanceConfig[canonicalField] = normalizedValue;
    compatibility[canonicalField] = {
      canonicalField,
      sourceField: resolved.sourceField,
      rawValue: resolved.sourceField === null ? null : rawValue,
      normalizedValue:
        normalizedValue === undefined ? null : normalizedValue,
      unit,
      sourceUnit,
    };
  }

  return {
    acceptanceConfig,
    compatibility,
  };
}

function normalizeAcceptanceConfig(raw = {}) {
  return canonicalizeAcceptanceConfig(raw).acceptanceConfig;
}

module.exports = {
  ACCEPTANCE_FIELD_ALIASES,
  canonicalizeAcceptanceConfig,
  normalizeAcceptanceConfig,
  normalizeSingleMonthContributionPct,
};
