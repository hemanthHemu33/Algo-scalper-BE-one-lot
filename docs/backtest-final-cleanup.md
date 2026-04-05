# Backtest Final Cleanup

## Fixed

- Entry cutoff enforcement in the backtest risk governor.
- `validation.lookAheadGuard` is now a real switch instead of an always-on check.
- `strategy.optimizerGateEnabled` is now explicitly unsupported in backtest config to remove dead-config ambiguity.

## Entry cutoff rule

- Cutoff format is `HH:mm`.
- The cutoff is interpreted in the configured backtest timezone, defaulting to `Asia/Kolkata`.
- Entries before the cutoff are allowed.
- Entries at the cutoff time are blocked.
- Entries after the cutoff are blocked with `ENTRY_CUTOFF_BLOCK`.
- Invalid cutoff config now fails validation instead of being silently ignored.

## lookAheadGuard behavior

- When `validation.lookAheadGuard=true`, future-candle selection violations are reported as `LOOK_AHEAD_GUARD`.
- When `validation.lookAheadGuard=false`, only that configurable look-ahead check is skipped.
- Other validation checks such as duplicates, gaps, expiry sanity, and missing option candles still run.

## optimizerGateEnabled resolution

- Backtest does not currently support an optimizer gate.
- `strategy.optimizerGateEnabled` now causes a fast, explicit config error in backtest mode.
- Sample configs and README are aligned with that behavior.

## Test status

- Targeted backtest test suite passes with `npm run test:backtest`.
