const DEFAULT_ADMISSION_THRESHOLDS = Object.freeze({
  confidenceGapBuckets: Object.freeze({
    tightMax: 1,
    smallMax: 3,
    nearThresholdMax: 5,
  }),
  freshnessBuckets: Object.freeze({
    freshMin: 88,
    goodMin: 74,
    agingMin: 58,
  }),
  mismatchBuckets: Object.freeze({
    weakFloor: 8,
    weakFactor: 0.55,
  }),
  routeQuality: Object.freeze({
    maxSpreadBps: 35,
    minHealthScore: 45,
    minDepth: 8,
    spreadTightFactor: 0.5,
    spreadElevatedFactor: 1.2,
    materialSpreadExtraBps: 5,
    healthGoodBuffer: 6,
    healthStrongBuffer: 18,
    depthDeepMultiplier: 2,
    depthThinFactor: 0.5,
    weakHealthFloor: 55,
  }),
  softPass: Object.freeze({
    confidenceSoftBand: 4,
    minHealthBuffer: 6,
    minHealthBufferFloor: 4,
    maxSpreadBpsFactor: 0.8,
    minSpreadFactorFloor: 0.6,
    minDepth: 8,
    fallbackWeakGapDivisor: 2,
    fallbackWeakGapFloor: 1,
    deltaGapMax: 0.12,
  }),
  transitionPass: Object.freeze({
    weakMismatchLimit: 22,
    minFreshness: 82,
    freshnessFloor: 78,
    minConfidence: 74,
    confidenceFloor: 68,
    minStructureQuality: 72,
    structureFloor: 62,
    minVolumeQuality: 68,
    volumeFloor: 58,
    minBoundaryQuality: 70,
    boundaryFloor: 58,
    minExpansionQuality: 70,
    expansionFloor: 58,
  }),
});

function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveAdmissionThresholds({ config = {}, profile = null } = {}) {
  const routeDefaults = DEFAULT_ADMISSION_THRESHOLDS.routeQuality;
  const softDefaults = DEFAULT_ADMISSION_THRESHOLDS.softPass;
  const transitionDefaults = DEFAULT_ADMISSION_THRESHOLDS.transitionPass;
  const profileSoftPass = profile?.postRouteSoftPass || {};

  const maxSpreadBps = Math.max(
    1,
    Number(config?.OPT_MAX_SPREAD_BPS ?? routeDefaults.maxSpreadBps),
  );
  const minHealthScore = Math.max(
    routeDefaults.minHealthScore,
    Number(config?.OPT_HEALTH_SCORE_MIN ?? routeDefaults.minHealthScore),
  );
  const minDepth = Math.max(
    routeDefaults.minDepth,
    Number(config?.POST_ROUTE_SOFT_PASS_MIN_DEPTH ?? routeDefaults.minDepth),
  );
  const weakHealthFloor = Math.max(routeDefaults.weakHealthFloor, minHealthScore);
  const confidenceSoftBand = Math.max(
    0,
    Number(
      config?.POST_ROUTE_CONFIDENCE_SOFT_BAND ??
        softDefaults.confidenceSoftBand,
    ),
  );
  const maxConfidenceGap = Math.max(
    confidenceSoftBand,
    Number(profileSoftPass?.maxConfidenceGap ?? confidenceSoftBand),
  );
  const softHealthBuffer = Math.max(
    softDefaults.minHealthBufferFloor,
    Number(
      profileSoftPass?.minHealthBuffer ??
        config?.POST_ROUTE_SOFT_PASS_HEALTH_BUFFER ??
        softDefaults.minHealthBuffer,
    ),
  );
  const softDepthFloor = Math.max(
    routeDefaults.minDepth,
    Number(profileSoftPass?.minDepth ?? minDepth),
  );
  const softSpreadFactor = Math.max(
    softDefaults.minSpreadFactorFloor,
    Number(profileSoftPass?.maxSpreadBpsFactor ?? softDefaults.maxSpreadBpsFactor),
  );
  const weakMismatchLimit = Math.max(
    DEFAULT_ADMISSION_THRESHOLDS.mismatchBuckets.weakFloor,
    Number(
      config?.MULTI_TF_TRANSITION_MAX_OPPOSITE_BPS ??
        transitionDefaults.weakMismatchLimit,
    ),
  );

  const resolved = {
    confidenceGapBuckets: DEFAULT_ADMISSION_THRESHOLDS.confidenceGapBuckets,
    freshnessBuckets: DEFAULT_ADMISSION_THRESHOLDS.freshnessBuckets,
    mismatchBuckets: DEFAULT_ADMISSION_THRESHOLDS.mismatchBuckets,
    routeQuality: Object.freeze({
      maxSpreadBps,
      minHealthScore,
      minDepth,
      spreadTightFactor: routeDefaults.spreadTightFactor,
      spreadElevatedFactor: routeDefaults.spreadElevatedFactor,
      materialSpreadLimit: Math.max(
        maxSpreadBps + routeDefaults.materialSpreadExtraBps,
        maxSpreadBps * routeDefaults.spreadElevatedFactor,
      ),
      healthGoodBuffer: routeDefaults.healthGoodBuffer,
      healthStrongBuffer: routeDefaults.healthStrongBuffer,
      weakHealthFloor,
      depthDeepMultiplier: routeDefaults.depthDeepMultiplier,
      depthThinFactor: routeDefaults.depthThinFactor,
    }),
    softPass: Object.freeze({
      supported: profileSoftPass?.enabled === true,
      profileId: profileSoftPass?.profileId || null,
      confidenceSoftBand,
      maxConfidenceGap,
      healthBuffer: softHealthBuffer,
      healthFloor: weakHealthFloor + softHealthBuffer,
      depthFloor: softDepthFloor,
      spreadFactor: softSpreadFactor,
      spreadLimit: maxSpreadBps * softSpreadFactor,
      weakFallbackGap: Math.max(
        softDefaults.fallbackWeakGapFloor,
        confidenceSoftBand / softDefaults.fallbackWeakGapDivisor,
      ),
      deltaGapMax: softDefaults.deltaGapMax,
    }),
    transitionPass: Object.freeze({
      weakMismatchLimit,
      minFreshness: Math.max(
        transitionDefaults.freshnessFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_FRESHNESS ??
            transitionDefaults.minFreshness,
        ),
      ),
      minConfidence: Math.max(
        transitionDefaults.confidenceFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_CONFIDENCE ??
            transitionDefaults.minConfidence,
        ),
      ),
      minStructureQuality: Math.max(
        transitionDefaults.structureFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_STRUCTURE_QUALITY ??
            transitionDefaults.minStructureQuality,
        ),
      ),
      minVolumeQuality: Math.max(
        transitionDefaults.volumeFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_VOLUME_QUALITY ??
            transitionDefaults.minVolumeQuality,
        ),
      ),
      minBoundaryQuality: Math.max(
        transitionDefaults.boundaryFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_BOUNDARY_QUALITY ??
            transitionDefaults.minBoundaryQuality,
        ),
      ),
      minExpansionQuality: Math.max(
        transitionDefaults.expansionFloor,
        Number(
          config?.MULTI_TF_TRANSITION_MIN_EXPANSION_QUALITY ??
            transitionDefaults.minExpansionQuality,
        ),
      ),
      contractQuality: Object.freeze({
        maxSpreadBps,
        minHealthScore: weakHealthFloor,
        minDepth: softDepthFloor,
      }),
    }),
  };

  return Object.freeze(resolved);
}

function resolveBucketThresholds(options = {}) {
  return resolveAdmissionThresholds(options).routeQuality;
}

function resolveSoftPassThresholds(options = {}) {
  return resolveAdmissionThresholds(options).softPass;
}

function resolveTransitionPassThresholds(options = {}) {
  return resolveAdmissionThresholds(options).transitionPass;
}

module.exports = {
  DEFAULT_ADMISSION_THRESHOLDS,
  resolveAdmissionThresholds,
  resolveBucketThresholds,
  resolveSoftPassThresholds,
  resolveTransitionPassThresholds,
  toFiniteOrNull,
};
