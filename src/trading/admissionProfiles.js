const { getStrategyMeta } = require("../strategy/registry");

function normalizeStyle(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (!raw) return "UNKNOWN";
  if (raw.includes("OPEN")) return "OPEN";
  if (raw.includes("TREND")) return "TREND";
  if (raw.includes("RANGE")) return "RANGE";
  return raw;
}

function normalizeFamily(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "generic";
  if (["breakout", "bb_squeeze", "volume_spike"].includes(raw)) {
    return raw === "volume_spike" ? "breakout" : raw;
  }
  if (
    [
      "ema_pullback",
      "ema_cross",
      "vwap_reclaim",
      "orb",
      "fakeout",
      "wick_reversal",
      "rsi_fade",
    ].includes(raw)
  ) {
    return raw;
  }
  if (raw === "trend") return "ema_pullback";
  if (raw === "vwap") return "vwap_reclaim";
  if (raw === "open") return "orb";
  return "generic";
}

const DEFAULT_PROFILE = Object.freeze({
  profileId: "admission:default",
  style: "UNKNOWN",
  family: "generic",
  allowedRegimeFamilies: [],
  allowTransitionPass: false,
  transitionPassProfile: null,
  postRouteSoftPass: {
    enabled: false,
    profileId: null,
    maxConfidenceGap: 4,
    maxSpreadBpsFactor: 0.8,
    minHealthBuffer: 6,
    minDepth: 8,
  },
  freshnessSensitiveBreakout: false,
  requiresPlannerContextTrio: false,
  fallbackStrictness: "LEGACY_OK",
});

const ADMISSION_PROFILES = Object.freeze({
  breakout: {
    profileId: "trend:breakout_core",
    style: "TREND",
    family: "breakout",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: true,
    transitionPassProfile: "breakout_transition",
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 5,
      maxSpreadBpsFactor: 0.8,
      minHealthBuffer: 6,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: true,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  bb_squeeze: {
    profileId: "trend:breakout_transition",
    style: "TREND",
    family: "bb_squeeze",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: true,
    transitionPassProfile: "breakout_transition",
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 5,
      maxSpreadBpsFactor: 0.8,
      minHealthBuffer: 6,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: true,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  ema_pullback: {
    profileId: "trend:ema_pullback_core",
    style: "TREND",
    family: "ema_pullback",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 5,
      maxSpreadBpsFactor: 0.8,
      minHealthBuffer: 6,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  ema_cross: {
    profileId: "trend:ema_cross_core",
    style: "TREND",
    family: "ema_cross",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 5,
      maxSpreadBpsFactor: 0.8,
      minHealthBuffer: 6,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  vwap_reclaim: {
    profileId: "trend:vwap_reclaim_core",
    style: "TREND",
    family: "vwap_reclaim",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 5,
      maxSpreadBpsFactor: 0.8,
      minHealthBuffer: 6,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  orb: {
    profileId: "open:orb_core",
    style: "OPEN",
    family: "orb",
    allowedRegimeFamilies: ["OPEN", "TREND"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: true,
      profileId: "open_near_threshold_clean_contract",
      maxConfidenceGap: 4,
      maxSpreadBpsFactor: 0.75,
      minHealthBuffer: 8,
      minDepth: 10,
    },
    freshnessSensitiveBreakout: true,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  volume_spike: {
    profileId: "trend:volume_spike_core",
    style: "TREND",
    family: "breakout",
    allowedRegimeFamilies: ["TREND", "OPEN"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: true,
      profileId: "trend_near_threshold_clean_contract",
      maxConfidenceGap: 4,
      maxSpreadBpsFactor: 0.75,
      minHealthBuffer: 7,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: true,
    requiresPlannerContextTrio: true,
    fallbackStrictness: "STRICT",
  },
  fakeout: {
    profileId: "range:fakeout_core",
    style: "RANGE",
    family: "fakeout",
    allowedRegimeFamilies: ["RANGE"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: false,
      profileId: null,
      maxConfidenceGap: 3,
      maxSpreadBpsFactor: 0.7,
      minHealthBuffer: 8,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: false,
    fallbackStrictness: "LEGACY_OK",
  },
  rsi_fade: {
    profileId: "range:rsi_fade_core",
    style: "RANGE",
    family: "rsi_fade",
    allowedRegimeFamilies: ["RANGE"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: false,
      profileId: null,
      maxConfidenceGap: 3,
      maxSpreadBpsFactor: 0.7,
      minHealthBuffer: 8,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: false,
    fallbackStrictness: "LEGACY_OK",
  },
  wick_reversal: {
    profileId: "range:wick_reversal_core",
    style: "RANGE",
    family: "wick_reversal",
    allowedRegimeFamilies: ["RANGE"],
    allowTransitionPass: false,
    transitionPassProfile: null,
    postRouteSoftPass: {
      enabled: false,
      profileId: null,
      maxConfidenceGap: 3,
      maxSpreadBpsFactor: 0.7,
      minHealthBuffer: 8,
      minDepth: 8,
    },
    freshnessSensitiveBreakout: false,
    requiresPlannerContextTrio: false,
    fallbackStrictness: "LEGACY_OK",
  },
});

function hasExplicitAdmissionProfile(strategyId) {
  const id = String(strategyId || "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(ADMISSION_PROFILES, id);
}

function envFlagEnabled(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
}

function listExplicitAdmissionProfiles() {
  return Object.freeze(Object.keys(ADMISSION_PROFILES));
}

function assertExplicitAdmissionProfiles(strategyIds = []) {
  const missing = Array.from(strategyIds || []).filter(
    (strategyId) => !hasExplicitAdmissionProfile(strategyId),
  );
  if (missing.length) {
    throw new Error(
      `MISSING_ADMISSION_PROFILES:${missing
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(",")}`,
    );
  }
  return true;
}

function shouldEnforceExplicitAdmissionProfiles({
  nodeEnv = process.env.NODE_ENV,
  strict = process.env.ADMISSION_PROFILE_STRICT,
} = {}) {
  if (envFlagEnabled(strict)) return true;
  return String(nodeEnv || "development").trim().toLowerCase() !== "production";
}

function assertRuntimeAdmissionProfiles(strategyIds = [], options = {}) {
  if (!shouldEnforceExplicitAdmissionProfiles(options)) return true;
  return assertExplicitAdmissionProfiles(strategyIds);
}

function getAdmissionProfile(strategyId, strategyStyle = null) {
  const id = String(strategyId || "")
    .trim()
    .toLowerCase();
  const strategyMeta = getStrategyMeta(id);
  const metaStyle = normalizeStyle(strategyStyle || strategyMeta?.style);
  const profile = ADMISSION_PROFILES[id] || null;

  return Object.freeze({
    ...DEFAULT_PROFILE,
    ...(profile || {}),
    style: normalizeStyle(profile?.style || metaStyle),
    family: normalizeFamily(profile?.family || id || strategyMeta?.family),
    strategyId: id || null,
  });
}

module.exports = {
  getAdmissionProfile,
  hasExplicitAdmissionProfile,
  listExplicitAdmissionProfiles,
  assertExplicitAdmissionProfiles,
  assertRuntimeAdmissionProfiles,
  shouldEnforceExplicitAdmissionProfiles,
  normalizeAdmissionFamily: normalizeFamily,
  normalizeAdmissionStyle: normalizeStyle,
};
