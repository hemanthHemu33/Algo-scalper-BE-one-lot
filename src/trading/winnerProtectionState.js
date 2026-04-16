const WINNER_PROTECTION_FIELDS = Object.freeze([
  { key: "peakExecutableR", aliases: ["peak_executable_r"], defaultValue: 0 },
  { key: "currentExecutableR", aliases: ["current_executable_r"], defaultValue: 0 },
  { key: "protectedPeakR", aliases: ["protected_peak_r"], defaultValue: 0 },
  { key: "protectedCurrentR", aliases: ["protected_current_r"], defaultValue: 0 },
  {
    key: "earlyWinnerEligible",
    aliases: ["early_winner_eligible"],
    defaultValue: false,
  },
  {
    key: "earlyWinnerArmed",
    aliases: ["early_winner_armed"],
    defaultValue: false,
  },
  {
    key: "earlyWinnerConfirmed",
    aliases: ["early_winner_confirmed"],
    defaultValue: false,
  },
  {
    key: "earlyWinnerArmAt",
    aliases: ["early_winner_arm_at"],
    defaultValue: null,
  },
  {
    key: "earlyWinnerConfirmedAt",
    aliases: ["early_winner_confirmed_at"],
    defaultValue: null,
  },
  {
    key: "earlyWinnerConfirmTicks",
    aliases: ["early_winner_confirm_ticks"],
    defaultValue: 0,
  },
  {
    key: "earlyWinnerConfirmMs",
    aliases: ["early_winner_confirm_ms"],
    defaultValue: 0,
  },
  {
    key: "earlyWinnerTier",
    aliases: ["early_winner_tier"],
    defaultValue: 0,
  },
  {
    key: "earlyWinnerKeepR",
    aliases: ["early_winner_keep_r"],
    defaultValue: 0,
  },
  {
    key: "earlyWinnerFloorPrice",
    aliases: ["early_winner_floor_price"],
    defaultValue: null,
  },
  {
    key: "earlyWinnerFloorSource",
    aliases: ["early_winner_floor_source"],
    defaultValue: null,
  },
  {
    key: "earlyWinnerActive",
    aliases: ["early_winner_active"],
    defaultValue: false,
  },
  {
    key: "earlyWinnerMfeLockActive",
    aliases: ["early_winner_mfe_lock_active"],
    defaultValue: false,
  },
  {
    key: "earlyWinnerHandoffReady",
    aliases: ["early_winner_handoff_ready"],
    defaultValue: false,
  },
  {
    key: "dynamicTrailArmR",
    aliases: ["dynamic_trail_arm_r"],
    defaultValue: null,
  },
  {
    key: "handoffMaturity",
    aliases: ["handoff_maturity"],
    defaultValue: 0,
  },
  {
    key: "structureCandidateAvailable",
    aliases: ["structure_candidate_available"],
    defaultValue: false,
  },
  {
    key: "structureReferenceType",
    aliases: ["structure_reference_type"],
    defaultValue: null,
  },
  {
    key: "structureReferencePrice",
    aliases: ["structure_reference_price"],
    defaultValue: null,
  },
  {
    key: "structureMappedFloor",
    aliases: ["structure_mapped_floor"],
    defaultValue: null,
  },
  {
    key: "protectionPhase",
    aliases: ["protection_phase"],
    defaultValue: "PHASE_0_NO_PROTECTION",
  },
  {
    key: "protectionStateVersion",
    aliases: ["protection_state_version"],
    defaultValue: 0,
  },
  { key: "mfeLockTier", aliases: ["mfe_lock_tier"], defaultValue: 0 },
  { key: "mfeLockFloorR", aliases: ["mfe_lock_floor_r"], defaultValue: 0 },
  {
    key: "mfeLockFloorPrice",
    aliases: ["mfe_lock_floor_price"],
    defaultValue: null,
  },
  { key: "tightenActive", aliases: ["tighten_active"], defaultValue: false },
  {
    key: "tightenActivatedAtR",
    aliases: ["tighten_activated_at_r"],
    defaultValue: null,
  },
  {
    key: "post1RTrailGapR",
    aliases: ["post1r_trail_gap_r"],
    defaultValue: null,
  },
  {
    key: "post1RTrailFloorPrice",
    aliases: ["post1r_trail_floor_price"],
    defaultValue: null,
  },
  { key: "givebackR", aliases: ["giveback_r"], defaultValue: 0 },
  { key: "givebackPct", aliases: ["giveback_pct"], defaultValue: 0 },
  {
    key: "hardGivebackExitArmed",
    aliases: ["hard_giveback_exit_armed"],
    defaultValue: false,
  },
  {
    key: "hardGivebackRule",
    aliases: ["hard_giveback_rule"],
    defaultValue: null,
  },
  {
    key: "hardGivebackThresholdR",
    aliases: ["hard_giveback_threshold_r"],
    defaultValue: null,
  },
  {
    key: "hardGivebackThresholdPct",
    aliases: ["hard_giveback_threshold_pct"],
    defaultValue: null,
  },
  {
    key: "hardGivebackConfirmTicks",
    aliases: ["hard_giveback_confirm_ticks"],
    defaultValue: 0,
  },
  {
    key: "givebackConfirmMs",
    aliases: ["giveback_confirm_ms"],
    defaultValue: 0,
  },
  {
    key: "hardGivebackArmedAt",
    aliases: ["hard_giveback_armed_at"],
    defaultValue: null,
  },
  {
    key: "shouldExitNowReason",
    aliases: ["should_exit_now_reason"],
    defaultValue: null,
  },
]);

const WINNER_PROTECTION_DEFAULTS = Object.freeze(
  Object.fromEntries(
    WINNER_PROTECTION_FIELDS.map((field) => [field.key, field.defaultValue]),
  ),
);

function resolveFieldValue(source, field) {
  const row = source || {};
  for (const candidate of [field.key, ...(field.aliases || [])]) {
    if (!Object.prototype.hasOwnProperty.call(row, candidate)) continue;
    const value = row[candidate];
    if (value !== undefined) return { found: true, value };
  }
  return { found: false, value: undefined };
}

function normalizeWinnerProtectionState(source = {}) {
  const normalized = {};
  for (const field of WINNER_PROTECTION_FIELDS) {
    const resolved = resolveFieldValue(source, field);
    normalized[field.key] = resolved.found ? resolved.value : field.defaultValue;
  }
  return normalized;
}

function buildMissingWinnerProtectionPatch(source = {}) {
  const patch = {};
  for (const field of WINNER_PROTECTION_FIELDS) {
    const resolved = resolveFieldValue(source, field);
    if (!resolved.found) patch[field.key] = field.defaultValue;
  }
  return patch;
}

module.exports = {
  WINNER_PROTECTION_FIELDS,
  WINNER_PROTECTION_DEFAULTS,
  normalizeWinnerProtectionState,
  buildMissingWinnerProtectionPatch,
};
