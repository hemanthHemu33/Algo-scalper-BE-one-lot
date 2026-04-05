# Exit Hardening Patch Note

## Problem observed in live logs
- Rare late `ENTRY_FILLED` updates were still showing up after the trade had already advanced into SL/LIVE states, creating stale-transition log noise.

## Root cause
- The final stale-transition safety guard was correct, but repeated identical late updates could log the same ignore message over and over.
- `DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION` was already being consumed in code, but it was not cleanly declared in central config or exposed in `.env`.

## Fixes applied
- Declared `DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION` in [src/config.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/config.js) with project-standard boolean parsing and a default of `false`.
- Added `DYNAMIC_EXIT_ALLOW_SAFE_PRE_BE_STOP_COMPRESSION=false` to [.env](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/.env).
- Normalized the remaining read sites to use that single config key directly.
- Added a short in-memory dedup window for identical stale `ENTRY_FILLED` guard logs in [src/trading/tradeStore.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/trading/tradeStore.js).

## Files touched
- [src/config.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/config.js)
- [src/trading/proExitLayers.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/trading/proExitLayers.js)
- [src/trading/tradeManager.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/trading/tradeManager.js)
- [src/trading/tradeStore.js](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/src/trading/tradeStore.js)
- [.env](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/.env)

## Expected runtime behavior now
- The main exit hardening remains enforced by the final authority gate, so stop-improving changes still require an approved protection/authority path before they can take effect.
- The stale-transition guard still blocks late `ENTRY_FILLED` regressions exactly as before.
- The remaining fallback safety is the stale-transition guard itself; only duplicate log lines are suppressed for a short window, not the protection.

## Config note
- Removed the exposed `BE_LOCK_ENABLED` env flag from [.env](C:/Users/heman/Desktop/algo-scalper-BE/working backup/kite-scalper-engine-v1.3-FNO-back-test-23-02-2026/kite-scalper-engine-v1.3-FNO-back-test/.env). Breakeven activation is governed by `BE_ARM_R` and the active protection path, not that legacy toggle.
