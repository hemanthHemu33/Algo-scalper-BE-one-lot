# Pro Exit Refactor

## New env variables

Winner protection layers:

- `GREEN_LOCK_ENABLED`, `GREEN_LOCK_ARM_R`, `GREEN_LOCK_PEAK_R`, `GREEN_LOCK_MIN_R`, `GREEN_LOCK_COST_MULT`
- `MFE_LOCK_LADDER_ENABLED`
- `MFE_LOCK_1_AT_R`, `MFE_LOCK_1_KEEP_R`
- `MFE_LOCK_2_AT_R`, `MFE_LOCK_2_KEEP_R`
- `MFE_LOCK_3_AT_R`, `MFE_LOCK_3_KEEP_R`
- `MFE_LOCK_4_AT_R`, `MFE_LOCK_4_KEEP_R`
- `MFE_LOCK_5_AT_R`, `MFE_LOCK_5_KEEP_R`
- `EXIT_HARD_GIVEBACK_T1_PEAK_R`, `EXIT_HARD_GIVEBACK_T1_R`
- `EXIT_HARD_GIVEBACK_T2_PEAK_R`, `EXIT_HARD_GIVEBACK_T2_R`
- `EXIT_HARD_GIVEBACK_T3_PEAK_R`, `EXIT_HARD_GIVEBACK_T3_PCT`
- `EXIT_HARD_GIVEBACK_CONFIRM_MS`, `EXIT_HARD_GIVEBACK_CONFIRM_TICKS`

Legacy `GIVEBACK_*` knobs are no longer part of the active runtime surface. Hard giveback is governed only by the `EXIT_HARD_GIVEBACK_*` rule ladder and confirmation settings.

Cadence and step:

- `DYNAMIC_EXIT_MIN_INTERVAL_MS`
- `DYNAMIC_EXIT_MIN_MODIFY_INTERVAL_MS`
- `DYN_STEP_TICKS_PRE_BE`
- `DYN_STEP_TICKS_POST_BE`
- `DYNAMIC_EXIT_MIN_HOLD_MS`
- `DYNAMIC_EXIT_EARLY_TIGHTEN_MIN_R`
- `DYNAMIC_EXIT_REQUIRE_SAFE_EXECUTION`
- `DYNAMIC_EXIT_MIN_EXECUTABLE_DISTANCE_TICKS`
- `DYNAMIC_EXIT_MAX_EXECUTABLE_SPREAD_BPS`

Options trailing:

- `OPTION_TRAIL_USE_UNDERLYING_CONFIRM`
- `OPTION_TRAIL_REQUIRE_EXECUTABLE_MFE`
- `OPTION_EXECUTABLE_PRICE_MODE`
- `OPTION_PREMIUM_TRAIL_WEIGHT`
- `OPTION_UNDERLYING_TRAIL_WEIGHT`

Failure fallback:

- `DYNAMIC_EXIT_DISABLE_ON_FAIL`
- `DYNAMIC_EXIT_CANCEL_REPLACE_ON_FAIL`
- `DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL`
- `DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH`

## Decision flow

1. Build mark and executable metrics.
2. Keep legacy time-stop / option quick-exit rules.
3. Start from the existing stop and initial SL.
4. Keep cost-safe BE from the existing engine.
5. Add green-lock floor once `currentR >= GREEN_LOCK_ARM_R` or `peakR >= GREEN_LOCK_PEAK_R`.
6. Add MFE ladder retention from the highest achieved peak R.
7. Evaluate hard giveback:
   - `RULE_A`: arm when `peakR >= EXIT_HARD_GIVEBACK_T1_PEAK_R` and `givebackR >= EXIT_HARD_GIVEBACK_T1_R`
   - `RULE_B`: arm when `peakR >= EXIT_HARD_GIVEBACK_T2_PEAK_R` and `givebackR >= EXIT_HARD_GIVEBACK_T2_R`
   - `RULE_C`: arm when `peakR >= EXIT_HARD_GIVEBACK_T3_PEAK_R` and `givebackPct >= EXIT_HARD_GIVEBACK_T3_PCT`
   - once armed, exit confirms after `EXIT_HARD_GIVEBACK_CONFIRM_TICKS` ticks or `EXIT_HARD_GIVEBACK_CONFIRM_MS` elapsed milliseconds
   - if giveback worsens while still armed, the same confirmation episode continues and the active rule is escalated instead of restarting the clock
8. Merge structure trail:
   - the stop cannot move above the initial risk stop until BE, green-lock, MFE lock, giveback defense, or an emergency defense rule has armed protection
   - cash/futures keep the existing structure candidate
   - options use premium trail, but full tightening prefers favorable underlying confirmation
   - options also require executable-safe conditions before sending the SL modify: minimum dwell, spread sanity, and enough distance from the executable bid/ask
9. Final stop is tighten-only:
   - `max(existingStop, initialStop, beFloor, greenFloor, mfeFloor, structureTrailFloor)` for longs
   - mirrored `min(...)` for shorts

## Peak R to retained R

- `1.00R -> 0.20R`
- `1.40R -> 0.45R`
- `1.80R -> 0.75R`
- `2.40R -> 1.10R`
- `3.00R -> 1.50R`

The ladder never downgrades during a live trade or after restart recovery.

## Failure fallback

1. Normal bounded modify retry via `_safeModifyOrder`.
2. If modify still fails and `DYNAMIC_EXIT_CANCEL_REPLACE_ON_FAIL=true`, cancel the old SL and place a fresh one at the protected stop.
3. If broker protection is still not trustworthy and `DYNAMIC_EXIT_SHADOW_MODE_ON_FAIL=true`, mark `shadowExitActive=true`.
4. If price breaches the protected shadow stop and `DYNAMIC_EXIT_PANIC_ON_SHADOW_BREACH=true`, trigger panic exit.

Entry-side note:

- `OPT_SL_FIT_WHEN_CAP_BLOCKS` is now opt-in. The engine blocks instead of over-tightening the initial stop just to force one lot under the risk cap.

## Live debugging

Inspect these persisted fields on active trades:

- `trueBePrice`
- `greenLockActive`, `greenLockFloorPrice`
- `peakExecutablePnlInr`, `peakExecutableR`
- `mfeLockTier`, `mfeLockFloorPrice`
- `givebackR`, `givebackPct`
- `hardGivebackExitArmed`, `hardGivebackRule`
- `hardGivebackConfirmTicks`, `givebackConfirmMs`, `hardGivebackArmedAt`
- `shadowExitActive`
- `lastProtectedR`, `lastProtectedInr`
- `lastExitPlanReason`

Dynamic exit logs now expose:

- `currentR`
- `peakR`
- `peakExecutableR`
- `givebackR`, `givebackPct`
- `hardGivebackConfirmTicks`, `hardGivebackConfirmTarget`
- `givebackConfirmMs`, `hardGivebackArmedAt`
- `existingStop`, `proposedStop`
- `greenLockActive`, `mfeLockTier`
- `shadowExitActive`
- `reason`
