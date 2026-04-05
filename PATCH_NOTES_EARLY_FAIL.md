# PATCH_NOTES_EARLY_FAIL

## What changed

- Tightened `EARLY_STALL_EXIT` so it now needs:
  - a minimum post-entry age
  - a minimum bars-since-entry threshold
  - weak/no follow-through
  - adverse drift
  - confirmation across multiple evals / time
- Tightened `EARLY_STRUCTURE_FAILURE` so it now uses an explicit reference level, applies a configurable breach buffer, and requires confirmation before authorizing exit.
- Normalized early-fail telemetry through the dynamic-exit path and added one concise runtime log when an early-fail exit is authorized before panic-exit execution starts.

## Why panic exits were overfiring before

- Stall logic treated ordinary hesitation too aggressively and could authorize exits before the trade had a fair follow-through window.
- Structure failure relied on a very small heuristic instead of a buffered, confirmed invalidation anchor.
- Runtime logs exposed the exit reason, but not enough context to explain whether the engine was still in grace, confirming a candidate, or acting on a decisive breach.

## How behavior is safer now

- Breakout / ORB-style trades get extra stall grace before they can be classified as failed.
- Stall exits no longer fire on one noisy eval; they need persistent weakness after the observation window.
- Structure exits prefer underlying-led invalidation when available, so option premium wiggle alone is less likely to trigger a panic exit.
- Early-fail telemetry now shows:
  - mode
  - candidate / confirmed state
  - confirmation counters
  - reference source and level
  - breach amount
  - buffer used
  - MFE / MAE at decision

## New config knobs

- `EARLY_STALL_MIN_TRADE_AGE_MS`
- `EARLY_STALL_MIN_BARS_SINCE_ENTRY`
- `EARLY_STALL_CONFIRM_TICKS`
- `EARLY_STALL_CONFIRM_MS`
- `EARLY_STALL_MIN_MFE_R`
- `EARLY_STALL_MAX_ADVERSE_R`
- `EARLY_STALL_BREAKOUT_GRACE_MS`
- `EARLY_STALL_ORB_GRACE_MS`
- `EARLY_STRUCTURE_FAIL_CONFIRM_TICKS`
- `EARLY_STRUCTURE_FAIL_CONFIRM_MS`
- `EARLY_STRUCTURE_FAIL_BUFFER_POINTS`
- `EARLY_STRUCTURE_FAIL_BUFFER_TICKS`
- `EARLY_STRUCTURE_FAIL_BUFFER_ATR_FRACTION`
- `EARLY_STRUCTURE_FAIL_USE_UNDERLYING`
- `EARLY_FAIL_LOG_VERBOSE`

## Backward compatibility

- Existing `EARLY_FAIL_MAX_STALL_MS` remains parsed as a legacy fallback if the new stall age knob is absent in a custom test env/object.
- Panic-exit execution plumbing is unchanged; only the early-fail authorization rules and telemetry were hardened.

## Final cleanup closeout

### What was still pending

- Checked-in operator templates did not expose the full early-fail knob set.
- `EARLY_FAIL_LOG_VERBOSE` was only partially live because the early-fail authorization warning still forced verbose telemetry.
- Acceptance coverage still lacked explicit ms-based confirmation checks, the underlying toggle regression, the normal-SL-only regression, and a compact-log regression.
- A few telemetry fields were slightly stronger in name than in what this path actually computes.

### What was cleaned up

- Added the early-fail knobs to `.env` and `config/runtime_knobs.json`, aligned to the names parsed in `src/config.js`.
- Made the runtime auth warning use the same verbosity-gated telemetry builder as the normal dynamic-exit eval log.
- Kept compact early-fail auth/eval logs useful when verbose mode is off by retaining reason, mode, reference level, breach, confirmation status, and trade age.
- Added focused tests for ms-based stall confirmation, ms-based structure confirmation, underlying toggle behavior, normal-SL-only non-interference, winner-protection precedence, and verbose-off auth logging.
- Normalized telemetry semantics by exposing `earlyFailAdverseRAtDecision` and keeping `earlyFailMaeAtDecision` as a legacy alias, while ensuring `earlyFailMfeAtDecision` is not reported as negative.

### Scope confirmation

- No core early-fail thresholds were retuned in this closeout.
- No signal generation, scoring, optimizer, routing, entry, SL sizing, BE/trail/giveback, broker flow, or reconciler behavior was widened.
