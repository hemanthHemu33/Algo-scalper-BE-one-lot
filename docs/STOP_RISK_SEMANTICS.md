# Stop / Risk Semantics

## Core model

- `strategyStopLoss`: immutable strategy invalidation stop. This is the original R anchor.
- `sizingStopLoss`: stop used only for pre-entry sizing checks. It defaults to `strategyStopLoss`.
- `brokerStopLoss`: currently active protective stop in the market. Legacy `stopLoss` mirrors this field.

Backward compatibility:

- `initialStopLoss` now maps to `strategyStopLoss`.
- Old trades without `strategyStopLoss` normalize to `initialStopLoss ?? stopLoss`.

## Why post-fill SL refit is dangerous

Post-fill stop refit silently changes trade invalidation after the trade already exists. That causes:

- inconsistent R math between entry, fill, and exit
- false “risk compliance” created by tightening the stop
- broken trailing / BE logic because the original risk anchor is lost

This patch removes post-fill SL rescue. After fill, the engine recomputes risk against the preserved `strategyStopLoss` and either:

- tags the breach
- exits on hard breach

It does not rewrite the stop to fit the budget.

## One-lot risk fit

Sizing now starts from the actual strategy stop.

Formula:

- `strategyRiskPts = abs(entryPrice - strategyStopLoss)`
- `oneLotAllInRiskInr = ((strategyRiskPts + expectedSlippagePts) * lotSize) + feePerLotInr`
- `maxLotsByRisk = floor(riskBudgetInr / oneLotAllInRiskInr)`

Behavior:

- if `maxLotsByRisk >= 1`, quantity is sized from that stop
- if `maxLotsByRisk < 1`, the trade is rejected by default
- `FORCE_ONE_LOT_WITH_BREACH_TAG` may allow one lot only within a small configured breach band
- stop compression is never used post-fill

## Soft / hard breach handling

Post-fill risk is computed from:

- actual fill price
- preserved `strategyStopLoss`
- filled quantity

States:

- `NONE`: true risk is within cap
- `SOFT`: above cap but within the configured soft band
- `HARD`: above the configured hard band

Default actions:

- `SOFT`: `TAG_ONLY`
- `HARD`: `EXIT`

## New envs

- `PRE_ENTRY_SL_COMPRESSION_ENABLED=false`
- `PRE_ENTRY_SL_COMPRESSION_MAX_PCT=0.10`
- `PRE_ENTRY_SL_COMPRESSION_MAX_TICKS=6`
- `PRE_ENTRY_SL_COMPRESSION_ALLOW_OPEN=false`
- `PRE_ENTRY_SL_COMPRESSION_REQUIRE_RR_FLOOR=true`
- `PRE_ENTRY_SL_COMPRESSION_MIN_RR=1.8`
- `FNO_FORCE_ONE_LOT_MAX_BREACH_PCT=8`
- `FNO_FORCE_ONE_LOT_REQUIRE_TAG=true`
- `POST_FILL_RISK_SOFT_BREACH_PCT=5`
- `POST_FILL_RISK_HARD_BREACH_PCT=12`
- `POST_FILL_RISK_SOFT_ACTION=TAG_ONLY`
- `POST_FILL_RISK_HARD_ACTION=EXIT`
- `POST_FILL_RISK_REDUCE_IF_POSSIBLE=true`

## Expected live behavior

Example 1:

- strategy stop implies one-lot risk of `₹2580`
- risk budget is `₹700`
- engine rejects the trade under `FNO_MIN_LOT_POLICY=STRICT`

Example 2:

- entry fills worse than expected
- actual risk at the same strategy stop rises above cap by 4%
- trade is tagged `SOFT`, stop stays unchanged

Example 3:

- entry fills much worse and actual risk exceeds the hard band
- trade is marked `HARD` and panic-exited
- stop semantics are preserved in the trade record for audit/debug
