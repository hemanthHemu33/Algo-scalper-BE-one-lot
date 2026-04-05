# Entry Execution Hardening

## What changed

- One-lot stop fitting is no longer allowed to rewrite the strategy stop aggressively.
- Limit-entry repricing is now strategy-aware:
  - breakout/open setups chase faster
  - trend pullbacks chase moderately
  - range/fade setups stay more patient
- Pending limit entries are revalidated before blunt timeout:
  - cancel when spread widens too far
  - cancel when premium drifts beyond the chase budget
  - cancel when the underlying moves against the trade enough to decay the original edge
  - use timeout only as the hard upper bound

## New env variables

- `OPT_SL_FIT_MIN_DISTANCE_KEEP_PCT`
- `ENTRY_LADDER_STYLE_ENABLED`
- `ENTRY_LADDER_USE_LIVE_QUOTE`
- `ENTRY_LADDER_URGENCY_BREAKOUT_MULT`
- `ENTRY_LADDER_URGENCY_OPEN_MULT`
- `ENTRY_LADDER_URGENCY_TREND_MULT`
- `ENTRY_LADDER_URGENCY_RANGE_MULT`
- `ENTRY_PENDING_EDGE_REVALIDATE_ENABLED`
- `ENTRY_PENDING_CANCEL_ON_EDGE_DECAY`
- `ENTRY_PENDING_REVALIDATE_AFTER_MS`
- `ENTRY_PENDING_MAX_SPREAD_BPS`
- `ENTRY_PENDING_MAX_ADVERSE_UL_BPS`
- `ENTRY_PENDING_MAX_MS_BREAKOUT`
- `ENTRY_PENDING_MAX_MS_OPEN`
- `ENTRY_PENDING_MAX_MS_TREND`
- `ENTRY_PENDING_MAX_MS_RANGE`

## Debugging

Inspect these trade fields while an entry is pending:

- `entryUrgencyKey`
- `entryRepriceCount`
- `entryPendingLastReason`
- `entryPendingLastCheckAt`

Typical cancel reasons:

- `ENTRY_PENDING_STALE`
- `ENTRY_SPREAD_WIDENED`
- `ENTRY_PRICE_DRIFT`
- `ENTRY_EDGE_DECAY`
