const { deriveAlcAttribution } = require("./alcAttribution");

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
    ALC_EXIT_NOW: {
      exitFamily: "LOSS_CONTAINMENT",
      exitReasonCode: "ALC_EXIT_NOW",
      exitAuthority: "ADAPTIVE_LOSER_ENGINE",
    },
  };

  const base = normalized ? mapping[normalized] || null : null;
  return {
    exitFamily: overrides.exitFamily ?? base?.exitFamily ?? null,
    exitReasonCode: overrides.exitReasonCode ?? base?.exitReasonCode ?? normalized ?? null,
    exitAuthority: overrides.exitAuthority ?? base?.exitAuthority ?? null,
  };
}

function resolveAlcDerived(row = {}) {
  return deriveAlcAttribution(row, {
    side: row?.side ?? row?.transaction_type,
    entryPrice: row?.entryPrice ?? row?.entry_price,
    initialStopLoss:
      row?.initialStopLoss ??
      row?.initial_stop_loss ??
      row?.strategyStopLoss ??
      row?.strategy_stop_loss ??
      row?.sizingStopLoss ??
      row?.sizing_stop_loss,
    riskInr: row?.executionRiskInr ?? row?.execution_risk_inr,
    exitPrice: row?.exitPrice ?? row?.exit_price,
    finalProtectionOwner:
      row?.protectedStopSource ??
      row?.protected_stop_source ??
      row?.exitReasonCode ??
      row?.exit_reason_code ??
      row?.exitAuthority ??
      row?.exit_authority ??
      null,
  });
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
  if (n(trade?.earlyWinnerTier, 0) > 0) return "MFE_LOCK";
  if (bool(trade?.earlyWinnerActive)) return "EARLY_WINNER";
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
      bool(source?.earlyWinnerActive) ||
      bool(source?.earlyWinnerConfirmed) ||
      bool(source?.earlyWinnerHandoffReady) ||
      n(source?.earlyWinnerTier, 0) > 0 ||
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
    case "dynamicTrailArmR":
      return {
        found:
          row.dynamicTrailArmR !== undefined ||
          row.dynamic_trail_arm_r !== undefined,
        value: n(row.dynamicTrailArmR ?? row.dynamic_trail_arm_r, null),
      };
    case "handoffMaturity":
      return {
        found:
          row.handoffMaturity !== undefined ||
          row.handoff_maturity !== undefined,
        value: n(row.handoffMaturity ?? row.handoff_maturity, 0),
      };
    case "structureCandidateAvailable":
      return {
        found:
          row.structureCandidateAvailable !== undefined ||
          row.structure_candidate_available !== undefined,
        value: bool(
          row.structureCandidateAvailable ?? row.structure_candidate_available,
          false,
        ),
      };
    case "structureReferenceType":
      return {
        found:
          row.structureReferenceType !== undefined ||
          row.structure_reference_type !== undefined,
        value:
          row.structureReferenceType ?? row.structure_reference_type ?? null,
      };
    case "structureReferencePrice":
      return {
        found:
          row.structureReferencePrice !== undefined ||
          row.structure_reference_price !== undefined,
        value: n(
          row.structureReferencePrice ?? row.structure_reference_price,
          null,
        ),
      };
    case "structureMappedFloor":
      return {
        found:
          row.structureMappedFloor !== undefined ||
          row.structure_mapped_floor !== undefined,
        value: n(row.structureMappedFloor ?? row.structure_mapped_floor, null),
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
    case "loserCompressionDesiredAction":
      return {
        found:
          row.loserCompressionDesiredAction !== undefined ||
          row.loser_compression_desired_action !== undefined,
        value:
          row.loserCompressionDesiredAction ??
          row.loser_compression_desired_action ??
          "HOLD",
      };
    case "loserCompressionTargetState":
      return {
        found:
          row.loserCompressionTargetState !== undefined ||
          row.loser_compression_target_state !== undefined,
        value:
          row.loserCompressionTargetState ??
          row.loser_compression_target_state ??
          "NONE",
      };
    case "loserCompressionSubmittedState":
      return {
        found:
          row.loserCompressionSubmittedState !== undefined ||
          row.loser_compression_submitted_state !== undefined,
        value:
          row.loserCompressionSubmittedState ??
          row.loser_compression_submitted_state ??
          "NONE",
      };
    case "loserCompressionAppliedState":
      return {
        found:
          row.loserCompressionAppliedState !== undefined ||
          row.loser_compression_applied_state !== undefined,
        value:
          row.loserCompressionAppliedState ??
          row.loser_compression_applied_state ??
          "NONE",
      };
    case "loserCompressionPendingAction":
      return {
        found:
          row.loserCompressionPendingAction !== undefined ||
          row.loser_compression_pending_action !== undefined,
        value:
          row.loserCompressionPendingAction ??
          row.loser_compression_pending_action ??
          null,
      };
    case "loserCompressionPendingSince":
      return {
        found:
          row.loserCompressionPendingSince !== undefined ||
          row.loser_compression_pending_since !== undefined,
        value: isoOrNull(
          row.loserCompressionPendingSince ??
            row.loser_compression_pending_since,
        ),
      };
    case "loserCompressionLastRequestedStop":
      return {
        found:
          row.loserCompressionLastRequestedStop !== undefined ||
          row.loser_compression_last_requested_stop !== undefined,
        value: n(
          row.loserCompressionLastRequestedStop ??
            row.loser_compression_last_requested_stop,
          null,
        ),
      };
    case "loserCompressionLastConfirmedStop":
      return {
        found:
          row.loserCompressionLastConfirmedStop !== undefined ||
          row.loser_compression_last_confirmed_stop !== undefined,
        value: n(
          row.loserCompressionLastConfirmedStop ??
            row.loser_compression_last_confirmed_stop,
          null,
        ),
      };
    case "loserCompressionLastAttemptAt":
      return {
        found:
          row.loserCompressionLastAttemptAt !== undefined ||
          row.loser_compression_last_attempt_at !== undefined,
        value: isoOrNull(
          row.loserCompressionLastAttemptAt ??
            row.loser_compression_last_attempt_at,
        ),
      };
    case "loserCompressionLastConfirmedAt":
      return {
        found:
          row.loserCompressionLastConfirmedAt !== undefined ||
          row.loser_compression_last_confirmed_at !== undefined,
        value: isoOrNull(
          row.loserCompressionLastConfirmedAt ??
            row.loser_compression_last_confirmed_at,
        ),
      };
    case "loserCompressionAppliedSource":
      return {
        found:
          row.loserCompressionAppliedSource !== undefined ||
          row.loser_compression_applied_source !== undefined,
        value:
          row.loserCompressionAppliedSource ??
          row.loser_compression_applied_source ??
          resolveAlcDerived(row).alcAppliedSource ??
          null,
      };
    case "loserCompressionAppliedConfirmed":
      return {
        found:
          row.loserCompressionAppliedConfirmed !== undefined ||
          row.loser_compression_applied_confirmed !== undefined,
        value: bool(
          row.loserCompressionAppliedConfirmed ??
            row.loser_compression_applied_confirmed ??
            resolveAlcDerived(row).alcAppliedConfirmed,
          false,
        ),
      };
    case "loserCompressionAttributionConfidence":
      return {
        found:
          row.loserCompressionAttributionConfidence !== undefined ||
          row.loser_compression_attribution_confidence !== undefined,
        value:
          row.loserCompressionAttributionConfidence ??
          row.loser_compression_attribution_confidence ??
          resolveAlcDerived(row).alcAttributionConfidence ??
          null,
      };
    case "loserCompressionRetryCount":
      return {
        found:
          row.loserCompressionRetryCount !== undefined ||
          row.loser_compression_retry_count !== undefined,
        value: n(
          row.loserCompressionRetryCount ??
            row.loser_compression_retry_count,
          0,
        ),
      };
    case "loserCompressionState":
      return {
        found:
          row.loserCompressionState !== undefined ||
          row.loser_compression_state !== undefined,
        value:
          row.loserCompressionState ?? row.loser_compression_state ?? "NONE",
      };
    case "loserCompressionLastActionAt":
      return {
        found:
          row.loserCompressionLastActionAt !== undefined ||
          row.loser_compression_last_action_at !== undefined,
        value: isoOrNull(
          row.loserCompressionLastActionAt ??
            row.loser_compression_last_action_at,
        ),
      };
    case "loserCompressionActivatedAt":
      return {
        found:
          row.loserCompressionActivatedAt !== undefined ||
          row.loser_compression_activated_at !== undefined,
        value: isoOrNull(
          row.loserCompressionActivatedAt ??
            row.loser_compression_activated_at,
        ),
      };
    case "loserCompressionEscalatedAt":
      return {
        found:
          row.loserCompressionEscalatedAt !== undefined ||
          row.loser_compression_escalated_at !== undefined,
        value: isoOrNull(
          row.loserCompressionEscalatedAt ??
            row.loser_compression_escalated_at,
        ),
      };
    case "loserCompressionScoreAtLastAction":
      return {
        found:
          row.loserCompressionScoreAtLastAction !== undefined ||
          row.loser_compression_score_at_last_action !== undefined,
        value: n(
          row.loserCompressionScoreAtLastAction ??
            row.loser_compression_score_at_last_action,
          null,
        ),
      };
    case "loserCompressionReasonAtLastAction":
      return {
        found:
          row.loserCompressionReasonAtLastAction !== undefined ||
          row.loser_compression_reason_at_last_action !== undefined,
        value:
          row.loserCompressionReasonAtLastAction ??
          row.loser_compression_reason_at_last_action ??
          null,
      };
    case "loserCompressionBlockedReason":
      return {
        found:
          row.loserCompressionBlockedReason !== undefined ||
          row.loser_compression_blocked_reason !== undefined,
        value:
          row.loserCompressionBlockedReason ??
          row.loser_compression_blocked_reason ??
          null,
      };
    case "loserCompressionLastAction":
      return {
        found:
          row.loserCompressionLastAction !== undefined ||
          row.loser_compression_last_action !== undefined,
        value:
          row.loserCompressionLastAction ??
          row.loser_compression_last_action ??
          null,
      };
    case "loserCompressionTriggeredAt":
      return {
        found:
          row.loserCompressionTriggeredAt !== undefined ||
          row.loser_compression_triggered_at !== undefined,
        value: isoOrNull(
          row.loserCompressionTriggeredAt ??
            row.loser_compression_triggered_at,
        ),
      };
    case "loserExitTriggered":
      return {
        found:
          row.loserExitTriggered !== undefined ||
          row.loser_exit_triggered !== undefined,
        value: bool(row.loserExitTriggered ?? row.loser_exit_triggered, false),
      };
    case "loserExitReasonCode":
      return {
        found:
          row.loserExitReasonCode !== undefined ||
          row.loser_exit_reason_code !== undefined,
        value:
          row.loserExitReasonCode ??
          row.loser_exit_reason_code ??
          null,
      };
    case "alcRequested":
      return {
        found:
          row.alcRequested !== undefined || row.alc_requested !== undefined,
        value: bool(
          row.alcRequested ?? row.alc_requested ?? resolveAlcDerived(row).alcRequested,
          false,
        ),
      };
    case "alcAppliedConfirmed":
      return {
        found:
          row.alcAppliedConfirmed !== undefined ||
          row.alc_applied_confirmed !== undefined,
        value: bool(
          row.alcAppliedConfirmed ??
            row.alc_applied_confirmed ??
            row.loserCompressionAppliedConfirmed ??
            row.loser_compression_applied_confirmed ??
            resolveAlcDerived(row).alcAppliedConfirmed,
          false,
        ),
      };
    case "alcRequestedLevel":
      return {
        found:
          row.alcRequestedLevel !== undefined ||
          row.alc_requested_level !== undefined,
        value:
          row.alcRequestedLevel ??
          row.alc_requested_level ??
          resolveAlcDerived(row).alcRequestedLevel ??
          null,
      };
    case "alcAppliedLevel":
      return {
        found:
          row.alcAppliedLevel !== undefined ||
          row.alc_applied_level !== undefined,
        value:
          row.alcAppliedLevel ??
          row.alc_applied_level ??
          resolveAlcDerived(row).alcAppliedLevel ??
          null,
      };
    case "alcAppliedSource":
      return {
        found:
          row.alcAppliedSource !== undefined ||
          row.alc_applied_source !== undefined,
        value:
          row.alcAppliedSource ??
          row.alc_applied_source ??
          resolveAlcDerived(row).alcAppliedSource ??
          null,
      };
    case "alcAttributionConfidence":
      return {
        found:
          row.alcAttributionConfidence !== undefined ||
          row.alc_attribution_confidence !== undefined,
        value:
          row.alcAttributionConfidence ??
          row.alc_attribution_confidence ??
          resolveAlcDerived(row).alcAttributionConfidence ??
          null,
      };
    case "alcRequestedButNotApplied":
      return {
        found:
          row.alcRequestedButNotApplied !== undefined ||
          row.alc_requested_but_not_applied !== undefined,
        value: bool(
          row.alcRequestedButNotApplied ??
            row.alc_requested_but_not_applied ??
            resolveAlcDerived(row).alcRequestedButNotApplied,
          false,
        ),
      };
    case "alcAppliedButSuperseded":
      return {
        found:
          row.alcAppliedButSuperseded !== undefined ||
          row.alc_applied_but_superseded !== undefined,
        value: bool(
          row.alcAppliedButSuperseded ??
            row.alc_applied_but_superseded ??
            resolveAlcDerived(row).alcAppliedButSuperseded,
          false,
        ),
      };
    case "alcSupersededBy":
      return {
        found:
          row.alcSupersededBy !== undefined ||
          row.alc_superseded_by !== undefined,
        value:
          row.alcSupersededBy ??
          row.alc_superseded_by ??
          resolveAlcDerived(row).alcSupersededBy ??
          null,
      };
    case "alcFinalProtectionOwner":
      return {
        found:
          row.alcFinalProtectionOwner !== undefined ||
          row.alc_final_protection_owner !== undefined,
        value:
          row.alcFinalProtectionOwner ??
          row.alc_final_protection_owner ??
          resolveAlcDerived(row).alcFinalProtectionOwner ??
          null,
      };
    case "alcSavedRiskR":
      return {
        found:
          row.alcSavedRiskR !== undefined ||
          row.alc_saved_risk_r !== undefined,
        value: n(
          row.alcSavedRiskR ??
            row.alc_saved_risk_r ??
            resolveAlcDerived(row).alcSavedRiskR,
          null,
        ),
      };
    case "alcSavedRiskInr":
      return {
        found:
          row.alcSavedRiskInr !== undefined ||
          row.alc_saved_risk_inr !== undefined,
        value: n(
          row.alcSavedRiskInr ??
            row.alc_saved_risk_inr ??
            resolveAlcDerived(row).alcSavedRiskInr,
          null,
        ),
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
  { key: "earlyWinnerActive", defaultValue: false },
  { key: "earlyWinnerConfirmed", defaultValue: false },
  { key: "earlyWinnerHandoffReady", defaultValue: false },
  { key: "earlyWinnerTier", defaultValue: 0 },
  { key: "dynamicTrailArmR", defaultValue: null },
  { key: "handoffMaturity", defaultValue: 0 },
  { key: "structureCandidateAvailable", defaultValue: false },
  { key: "structureReferenceType", defaultValue: null },
  { key: "structureReferencePrice", defaultValue: null },
  { key: "structureMappedFloor", defaultValue: null },
  { key: "protectionPhase", defaultValue: "PHASE_0_NO_PROTECTION" },
  { key: "protectedStopSource", defaultValue: null },
  { key: "protectionStateVersion", defaultValue: 0 },
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
  { key: "loserCompressionDesiredAction", defaultValue: "HOLD" },
  { key: "loserCompressionTargetState", defaultValue: "NONE" },
  { key: "loserCompressionSubmittedState", defaultValue: "NONE" },
  { key: "loserCompressionAppliedState", defaultValue: "NONE" },
  { key: "loserCompressionPendingAction", defaultValue: null },
  { key: "loserCompressionPendingSince", defaultValue: null },
  { key: "loserCompressionLastRequestedStop", defaultValue: null },
  { key: "loserCompressionLastConfirmedStop", defaultValue: null },
  { key: "loserCompressionLastAttemptAt", defaultValue: null },
  { key: "loserCompressionLastConfirmedAt", defaultValue: null },
  { key: "loserCompressionAppliedSource", defaultValue: null },
  { key: "loserCompressionAppliedConfirmed", defaultValue: false },
  { key: "loserCompressionAttributionConfidence", defaultValue: null },
  { key: "loserCompressionRetryCount", defaultValue: 0 },
  { key: "loserCompressionState", defaultValue: "NONE" },
  { key: "loserCompressionLastActionAt", defaultValue: null },
  { key: "loserCompressionActivatedAt", defaultValue: null },
  { key: "loserCompressionEscalatedAt", defaultValue: null },
  { key: "loserCompressionScoreAtLastAction", defaultValue: null },
  { key: "loserCompressionReasonAtLastAction", defaultValue: null },
  { key: "loserCompressionBlockedReason", defaultValue: null },
  { key: "loserCompressionLastAction", defaultValue: null },
  { key: "loserCompressionTriggeredAt", defaultValue: null },
  { key: "loserExitTriggered", defaultValue: false },
  { key: "loserExitReasonCode", defaultValue: null },
  { key: "alcRequested", defaultValue: false },
  { key: "alcAppliedConfirmed", defaultValue: false },
  { key: "alcRequestedLevel", defaultValue: null },
  { key: "alcAppliedLevel", defaultValue: null },
  { key: "alcAppliedSource", defaultValue: null },
  { key: "alcAttributionConfidence", defaultValue: null },
  { key: "alcRequestedButNotApplied", defaultValue: false },
  { key: "alcAppliedButSuperseded", defaultValue: false },
  { key: "alcSupersededBy", defaultValue: null },
  { key: "alcFinalProtectionOwner", defaultValue: null },
  { key: "alcSavedRiskR", defaultValue: null },
  { key: "alcSavedRiskInr", defaultValue: null },
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
