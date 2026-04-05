function n(v, fb = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function bool(v, fb = false) {
  if (v === null || v === undefined || v === "") return fb;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const raw = String(v).trim().toLowerCase();
  if (!raw) return fb;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  return fb;
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function adverseDriftPct({ side, plannedEntry, actualEntry }) {
  const planned = n(plannedEntry, NaN);
  const actual = n(actualEntry, NaN);
  if (!(Number.isFinite(planned) && planned > 0 && Number.isFinite(actual) && actual > 0)) {
    return 0;
  }
  const normalizedSide = String(side || "BUY").toUpperCase();
  if (normalizedSide === "SELL") {
    return actual < planned ? ((planned - actual) / planned) * 100 : 0;
  }
  return actual > planned ? ((actual - planned) / planned) * 100 : 0;
}

function normalizeLegacyReasonCode(reasonCode) {
  const raw = String(reasonCode || "").trim().toUpperCase();
  if (!raw) return null;
  if (raw === "SL_HIT") return "HARD_SL";
  if (raw === "HARD_GIVEBACK_EXIT") return "GIVEBACK_CAP";
  if (raw === "BREAK_EVEN_EXIT" || raw === "BE") return "BREAK_EVEN";
  if (raw.startsWith("MFE_LOCK_T")) return "MFE_LOCK";
  return raw;
}

function resolveExitLifecycle(reasonCode, overrides = {}) {
  const normalized = normalizeLegacyReasonCode(reasonCode);
  const mapping = {
    HARD_SL: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "HARD_SL",
      exitAuthority: "STOP_ORDER",
    },
    EARLY_NO_FOLLOW_THROUGH: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "EARLY_NO_FOLLOW_THROUGH",
      exitAuthority: "EARLY_FAIL_ENGINE",
    },
    EARLY_STRUCTURE_FAILURE: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "EARLY_STRUCTURE_FAILURE",
      exitAuthority: "EARLY_FAIL_ENGINE",
    },
    EARLY_STALL_EXIT: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "EARLY_STALL_EXIT",
      exitAuthority: "EARLY_FAIL_ENGINE",
    },
    TIME_STOP: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "TIME_STOP",
      exitAuthority: "TIME_STOP_ENGINE",
    },
    TIME_STOP_NO_PROGRESS: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "TIME_STOP_NO_PROGRESS",
      exitAuthority: "TIME_STOP_ENGINE",
    },
    TIME_STOP_MAX_HOLD: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "TIME_STOP_MAX_HOLD",
      exitAuthority: "TIME_STOP_ENGINE",
    },
    TIME_STOP_LATCH_ESCALATION: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "TIME_STOP_LATCH_ESCALATION",
      exitAuthority: "TIME_STOP_ENGINE",
    },
    BREAK_EVEN: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "BREAK_EVEN",
      exitAuthority: "STOP_ORDER",
    },
    GREEN_LOCK: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "GREEN_LOCK",
      exitAuthority: "STOP_ORDER",
    },
    MFE_LOCK: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "MFE_LOCK",
      exitAuthority: "STOP_ORDER",
    },
    GIVEBACK_CAP: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "GIVEBACK_CAP",
      exitAuthority: "WINNER_PROTECTION_ENGINE",
    },
    TRAIL_EXIT: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "TRAIL_EXIT",
      exitAuthority: "STOP_ORDER",
    },
    TARGET_HIT: {
      exitFamily: "WINNER_PROTECTION",
      exitReasonCode: "TARGET_HIT",
      exitAuthority: "TARGET_ORDER",
    },
    RECONCILE_EXIT: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "RECONCILE_EXIT",
      exitAuthority: "RECONCILER",
    },
    PANIC_EXIT: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "PANIC_EXIT",
      exitAuthority: "PANIC_EXIT_ENGINE",
    },
    POST_FILL_RISK_REDUCE_FULL: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "POST_FILL_RISK_REDUCE_FULL",
      exitAuthority: "POST_FILL_RISK_ENGINE",
    },
  };

  const base = normalized ? mapping[normalized] || null : null;
  return {
    exitFamily: overrides.exitFamily ?? base?.exitFamily ?? null,
    exitReasonCode: overrides.exitReasonCode ?? base?.exitReasonCode ?? normalized ?? null,
    exitAuthority: overrides.exitAuthority ?? base?.exitAuthority ?? null,
  };
}

function hasBeProtectionLive(source = {}) {
  const beAppliedAt =
    source?.beAppliedAt ??
    source?.be_applied_at ??
    null;
  const beAppliedStopLoss =
    source?.beAppliedStopLoss ??
    source?.be_applied_stop_loss;
  const hasBeAppliedAt =
    beAppliedAt instanceof Date
      ? Number.isFinite(beAppliedAt.getTime())
      : Boolean(isoOrNull(beAppliedAt));
  const hasBeAppliedStopLoss =
    beAppliedStopLoss !== null &&
    beAppliedStopLoss !== undefined &&
    Number.isFinite(n(beAppliedStopLoss, NaN));
  return Boolean(
    bool(source?.beApplied) ||
      hasBeAppliedAt ||
      hasBeAppliedStopLoss,
  );
}

function hasTrailProtectionLive(source = {}) {
  return Boolean(bool(source?.trailAllowed) || bool(source?.trailActive));
}

function deriveStopExitReasonCode(trade = {}) {
  const explicit = normalizeLegacyReasonCode(trade?.exitReasonCode || trade?.exitReason);
  if (
    explicit &&
    explicit !== "PANIC_EXIT" &&
    explicit !== "RECONCILE_EXIT" &&
    explicit !== "TARGET_HIT"
  ) {
    return explicit;
  }
  if (bool(trade?.trailActive)) {
    return "TRAIL_EXIT";
  }
  if (bool(trade?.givebackActive) || bool(trade?.hardGivebackExitArmed)) {
    return "GIVEBACK_CAP";
  }
  if (n(trade?.mfeLockTier, 0) > 0) return "MFE_LOCK";
  if (bool(trade?.greenLockActive)) return "GREEN_LOCK";
  if (hasBeProtectionLive(trade)) {
    return "BREAK_EVEN";
  }
  return "HARD_SL";
}

function isWinnerProtectionActive(source = {}) {
  return Boolean(
    hasBeProtectionLive(source) ||
      hasTrailProtectionLive(source) ||
      bool(source?.greenLockActive) ||
      bool(source?.profitLockArmed) ||
      n(source?.mfeLockTier, 0) > 0 ||
      bool(source?.givebackActive) ||
      bool(source?.hardGivebackExitArmed),
  );
}

function resolveLifecycleField(source = {}, key) {
  const row = source || {};
  switch (key) {
    case "signalTs":
      return {
        found:
          row.signalTs !== undefined ||
          row.signal_ts !== undefined ||
          row.decisionAt !== undefined ||
          row.decision_at !== undefined,
        value:
          isoOrNull(row.signalTs) ??
          isoOrNull(row.signal_ts) ??
          isoOrNull(row.decisionAt) ??
          isoOrNull(row.decision_at) ??
          null,
      };
    case "executionTs":
      return {
        found:
          row.executionTs !== undefined ||
          row.execution_ts !== undefined ||
          row.entryPlacedAt !== undefined ||
          row.entry_placed_at !== undefined,
        value:
          isoOrNull(row.executionTs) ??
          isoOrNull(row.execution_ts) ??
          isoOrNull(row.entryPlacedAt) ??
          isoOrNull(row.entry_placed_at) ??
          null,
      };
    case "signalAgeMs":
      return {
        found: row.signalAgeMs !== undefined || row.signal_age_ms !== undefined,
        value: n(row.signalAgeMs ?? row.signal_age_ms, null),
      };
    case "plannedEntry":
      return {
        found:
          row.plannedEntry !== undefined ||
          row.planned_entry !== undefined ||
          row.expectedEntryPrice !== undefined ||
          row.entryExpectedPrice !== undefined ||
          row.expected_entry_price !== undefined,
        value: n(
          row.plannedEntry ??
            row.planned_entry ??
            row.expectedEntryPrice ??
            row.entryExpectedPrice ??
            row.expected_entry_price,
          null,
        ),
      };
    case "actualEntry":
      return {
        found:
          row.actualEntry !== undefined ||
          row.actual_entry !== undefined ||
          row.entryPrice !== undefined ||
          row.entry_price !== undefined,
        value: n(row.actualEntry ?? row.actual_entry ?? row.entryPrice ?? row.entry_price, null),
      };
    case "entryDriftPct": {
      const explicitFound =
        row.entryDriftPct !== undefined || row.entry_drift_pct !== undefined;
      const explicitValue = n(row.entryDriftPct ?? row.entry_drift_pct, null);
      if (explicitFound) return { found: true, value: explicitValue };
      const planned = n(
        row.plannedEntry ?? row.expectedEntryPrice ?? row.entryExpectedPrice,
        NaN,
      );
      const actual = n(row.actualEntry ?? row.entryPrice, NaN);
      if (Number.isFinite(planned) && Number.isFinite(actual)) {
        return {
          found: true,
          value: adverseDriftPct({
            side: row.side ?? row.transaction_type,
            plannedEntry: planned,
            actualEntry: actual,
          }),
        };
      }
      return { found: false, value: 0 };
    }
    case "spreadBpsAtSelection":
      return {
        found:
          row.spreadBpsAtSelection !== undefined ||
          row.spread_bps_at_selection !== undefined ||
          row.quoteAtEntry?.bps !== undefined ||
          row.entrySpread !== undefined ||
          row.spreadAtEntry !== undefined,
        value: n(
          row.spreadBpsAtSelection ??
            row.spread_bps_at_selection ??
            row.quoteAtEntry?.bps ??
            row.entrySpread ??
            row.spreadAtEntry,
          null,
        ),
      };
    case "spreadBpsAtExecution":
      return {
        found:
          row.spreadBpsAtExecution !== undefined ||
          row.spread_bps_at_execution !== undefined,
        value: n(row.spreadBpsAtExecution ?? row.spread_bps_at_execution, null),
      };
    case "freshnessAccepted":
      return {
        found:
          row.freshnessAccepted !== undefined ||
          row.freshness_accepted !== undefined,
        value: bool(row.freshnessAccepted ?? row.freshness_accepted, false),
      };
    case "executionGateReason":
      return {
        found:
          row.executionGateReason !== undefined ||
          row.execution_gate_reason !== undefined,
        value: row.executionGateReason ?? row.execution_gate_reason ?? "NOT_EVALUATED",
      };
    case "earlyFailArmed":
      return {
        found: row.earlyFailArmed !== undefined || row.early_fail_armed !== undefined,
        value: bool(row.earlyFailArmed ?? row.early_fail_armed, false),
      };
    case "earlyFailReason":
      return {
        found: row.earlyFailReason !== undefined || row.early_fail_reason !== undefined,
        value: row.earlyFailReason ?? row.early_fail_reason ?? null,
      };
    case "peakR":
      return {
        found:
          row.peakR !== undefined ||
          row.peak_r !== undefined ||
          row.protectedPeakR !== undefined ||
          row.peakPnlR !== undefined,
        value: n(
          row.peakR ?? row.peak_r ?? row.protectedPeakR ?? row.peakPnlR,
          0,
        ),
      };
    case "peakPnlInr":
      return {
        found:
          row.peakPnlInr !== undefined ||
          row.peak_pnl_inr !== undefined,
        value: n(row.peakPnlInr ?? row.peak_pnl_inr, 0),
      };
    case "beEligible":
      return {
        found: row.beEligible !== undefined || row.be_eligible !== undefined,
        value: bool(row.beEligible ?? row.be_eligible ?? row.beLockHit ?? row.beLocked, false),
      };
    case "beLockHit":
      return {
        found:
          row.beArmed !== undefined ||
          row.be_armed !== undefined ||
          row.beLockHit !== undefined ||
          row.be_lock_hit !== undefined ||
          row.beLocked !== undefined ||
          row.be_locked !== undefined,
        // Legacy compatibility field: prefer explicit armed state, never live protection truth.
        value: bool(
          row.beArmed ?? row.be_armed ?? row.beLockHit ?? row.be_lock_hit ?? row.beLocked ?? row.be_locked,
          false,
        ),
      };
    case "trailHit":
      return {
        found:
          row.trailArmed !== undefined ||
          row.trail_armed !== undefined ||
          row.trailHit !== undefined ||
          row.trail_hit !== undefined ||
          row.trailLocked !== undefined ||
          row.trail_locked !== undefined,
        // Legacy compatibility field: prefer explicit armed state, never live protection truth.
        value: bool(
          row.trailArmed ??
            row.trail_armed ??
            row.trailHit ??
            row.trail_hit ??
            row.trailLocked ??
            row.trail_locked,
          false,
        ),
      };
    case "profitLockArmed":
      return {
        found:
          row.profitLockArmed !== undefined ||
          row.profit_lock_armed !== undefined ||
          row.profitLockArmedAt !== undefined ||
          row.profit_lock_armed_at !== undefined,
        value: bool(
          row.profitLockArmed ??
            row.profit_lock_armed ??
            row.profitLockArmedAt ??
            row.profit_lock_armed_at,
          false,
        ),
      };
    case "greenLockActive":
      return {
        found:
          row.greenLockActive !== undefined ||
          row.green_lock_active !== undefined,
        value: bool(row.greenLockActive ?? row.green_lock_active, false),
      };
    case "mfeLockTier":
      return {
        found: row.mfeLockTier !== undefined || row.mfe_lock_tier !== undefined,
        value: n(row.mfeLockTier ?? row.mfe_lock_tier, 0),
      };
    case "desiredStopLoss":
      return {
        found:
          row.desiredStopLoss !== undefined ||
          row.desired_stop_loss !== undefined,
        value: n(row.desiredStopLoss ?? row.desired_stop_loss, null),
      };
    case "telemetryProposalFloor":
      return {
        found:
          row.telemetryProposalFloor !== undefined ||
          row.telemetry_proposal_floor !== undefined,
        value: n(
          row.telemetryProposalFloor ?? row.telemetry_proposal_floor,
          null,
        ),
      };
    case "executableHardFloor":
      return {
        found:
          row.executableHardFloor !== undefined ||
          row.executable_hard_floor !== undefined,
        value: n(
          row.executableHardFloor ?? row.executable_hard_floor,
          null,
        ),
      };
    case "finalStopLoss":
      return {
        found:
          row.finalStopLoss !== undefined ||
          row.final_stop_loss !== undefined,
        value: n(row.finalStopLoss ?? row.final_stop_loss, null),
      };
    case "hardFloor":
      return {
        found: row.hardFloor !== undefined || row.hard_floor !== undefined,
        value: n(row.hardFloor ?? row.hard_floor, null),
      };
    case "structureTrailFloor":
      return {
        found:
          row.structureTrailFloor !== undefined ||
          row.structure_trail_floor !== undefined,
        value: n(row.structureTrailFloor ?? row.structure_trail_floor, null),
      };
    case "structureTrailSource":
      return {
        found:
          row.structureTrailSource !== undefined ||
          row.structure_trail_source !== undefined,
        value:
          row.structureTrailSource ?? row.structure_trail_source ?? null,
      };
    case "structureTrailAllowed":
      return {
        found:
          row.structureTrailAllowed !== undefined ||
          row.structure_trail_allowed !== undefined,
        value: bool(
          row.structureTrailAllowed ?? row.structure_trail_allowed,
          false,
        ),
      };
    case "protectionGateOpen":
      return {
        found:
          row.protectionGateOpen !== undefined ||
          row.protection_gate_open !== undefined,
        value: bool(row.protectionGateOpen ?? row.protection_gate_open, false),
      };
    case "winnerModeActive":
      return {
        found:
          row.winnerModeActive !== undefined ||
          row.winner_mode_active !== undefined,
        value: bool(row.winnerModeActive ?? row.winner_mode_active, false),
      };
    case "stopImproveAuthorized":
      return {
        found:
          row.stopImproveAuthorized !== undefined ||
          row.stop_improve_authorized !== undefined,
        value: bool(
          row.stopImproveAuthorized ?? row.stop_improve_authorized,
          false,
        ),
      };
    case "stopImproveBlockedReason":
      return {
        found:
          row.stopImproveBlockedReason !== undefined ||
          row.stop_improve_blocked_reason !== undefined,
        value:
          row.stopImproveBlockedReason ??
          row.stop_improve_blocked_reason ??
          null,
      };
    case "trailActive":
      return {
        found:
          row.trailActive !== undefined ||
          row.trail_active !== undefined,
        value: bool(
          row.trailActive ?? row.trail_active,
          false,
        ),
      };
    case "givebackActive":
      return {
        found:
          row.givebackActive !== undefined ||
          row.giveback_active !== undefined ||
          row.hardGivebackExitArmed !== undefined ||
          row.hard_giveback_exit_armed !== undefined,
        value: bool(
          row.givebackActive ??
            row.giveback_active ??
            row.hardGivebackExitArmed ??
            row.hard_giveback_exit_armed,
          false,
        ),
      };
    case "exitFamily":
    case "exitReasonCode":
    case "exitAuthority": {
      const found =
        row[key] !== undefined ||
        row[
          key
            .replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
            .replace(/^_/, "")
        ] !== undefined;
      const explicit = row[key] ??
        row[
          key
            .replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)
            .replace(/^_/, "")
        ] ??
        null;
      if (found) return { found: true, value: explicit };
      const derived = resolveExitLifecycle(
        row.exitReasonCode ?? row.exitReason ?? row.exit_reason ?? row.closeReason ?? row.close_reason,
      );
      return { found: false, value: derived[key] };
    }
    default:
      return { found: false, value: undefined };
  }
}

const TRADE_LIFECYCLE_FIELDS = Object.freeze([
  { key: "signalTs", defaultValue: null },
  { key: "executionTs", defaultValue: null },
  { key: "signalAgeMs", defaultValue: null },
  { key: "plannedEntry", defaultValue: null },
  { key: "actualEntry", defaultValue: null },
  { key: "entryDriftPct", defaultValue: 0 },
  { key: "spreadBpsAtSelection", defaultValue: null },
  { key: "spreadBpsAtExecution", defaultValue: null },
  { key: "freshnessAccepted", defaultValue: false },
  { key: "executionGateReason", defaultValue: "NOT_EVALUATED" },
  { key: "earlyFailArmed", defaultValue: false },
  { key: "earlyFailReason", defaultValue: null },
  { key: "peakR", defaultValue: 0 },
  { key: "peakPnlInr", defaultValue: 0 },
  { key: "beEligible", defaultValue: false },
  { key: "beLockHit", defaultValue: false },
  { key: "trailHit", defaultValue: false },
  { key: "profitLockArmed", defaultValue: false },
  { key: "greenLockActive", defaultValue: false },
  { key: "mfeLockTier", defaultValue: 0 },
  { key: "desiredStopLoss", defaultValue: null },
  { key: "telemetryProposalFloor", defaultValue: null },
  { key: "executableHardFloor", defaultValue: null },
  { key: "finalStopLoss", defaultValue: null },
  { key: "hardFloor", defaultValue: null },
  { key: "structureTrailFloor", defaultValue: null },
  { key: "structureTrailSource", defaultValue: null },
  { key: "structureTrailAllowed", defaultValue: false },
  { key: "protectionGateOpen", defaultValue: false },
  { key: "winnerModeActive", defaultValue: false },
  { key: "stopImproveAuthorized", defaultValue: false },
  { key: "stopImproveBlockedReason", defaultValue: null },
  { key: "trailActive", defaultValue: false },
  { key: "givebackActive", defaultValue: false },
  { key: "exitFamily", defaultValue: null },
  { key: "exitReasonCode", defaultValue: null },
  { key: "exitAuthority", defaultValue: null },
]);

const TRADE_LIFECYCLE_DEFAULTS = Object.freeze(
  Object.fromEntries(
    TRADE_LIFECYCLE_FIELDS.map((field) => [field.key, field.defaultValue]),
  ),
);

function normalizeTradeLifecycleState(source = {}) {
  const normalized = {};
  for (const field of TRADE_LIFECYCLE_FIELDS) {
    const resolved = resolveLifecycleField(source, field.key);
    normalized[field.key] =
      resolved.value !== undefined ? resolved.value : field.defaultValue;
  }
  return normalized;
}

function buildMissingTradeLifecyclePatch(source = {}) {
  const patch = {};
  for (const field of TRADE_LIFECYCLE_FIELDS) {
    const resolved = resolveLifecycleField(source, field.key);
    if (!resolved.found) patch[field.key] = field.defaultValue;
  }
  return patch;
}

module.exports = {
  TRADE_LIFECYCLE_FIELDS,
  TRADE_LIFECYCLE_DEFAULTS,
  adverseDriftPct,
  buildMissingTradeLifecyclePatch,
  deriveStopExitReasonCode,
  isWinnerProtectionActive,
  normalizeLegacyReasonCode,
  normalizeTradeLifecycleState,
  resolveExitLifecycle,
};
