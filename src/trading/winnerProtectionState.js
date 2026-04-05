const WINNER_PROTECTION_FIELDS = Object.freeze([
  { key: "peakExecutableR", aliases: ["peak_executable_r"], defaultValue: 0 },
  { key: "currentExecutableR", aliases: ["current_executable_r"], defaultValue: 0 },
  { key: "protectedPeakR", aliases: ["protected_peak_r"], defaultValue: 0 },
  { key: "protectedCurrentR", aliases: ["protected_current_r"], defaultValue: 0 },
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
