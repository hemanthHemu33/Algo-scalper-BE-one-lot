# Entry execution calibration (IOC retry/fallback)

This guide is for live calibration of microstructure execution knobs per segment/instrument latency profile.

## Relevant env knobs

- `ENTRY_PASSIVE_MAX_SPREAD_BPS_OPT`
- `ENTRY_AGGRESSIVE_MAX_SPREAD_BPS_OPT`
- `ENTRY_MARKET_FALLBACK_MAX_SPREAD_BPS_OPT`
- `ENTRY_IOC_BASE_BUFFER_TICKS`
- `ENTRY_IOC_BASE_BUFFER_TICKS_OPT` *(new override for options)*
- `ENTRY_LADDER_MAX_CHASE_BPS`
- `ENTRY_LADDER_MAX_CHASE_BPS_OPT` *(new override for options)*
- `ENTRY_LADDER_TICKS`
- `ENTRY_LADDER_STEP_DELAY_MS`
- `ENTRY_LIMIT_FALLBACK_TO_MARKET`

## Suggested calibration workflow

1. Enable `[entry_exec] decision` and `[entry_exec] result` logs in paper/live shadow runs.
2. Slice by `tradingsymbol` and `segment` and compute:
   - IOC unmatched ratio
   - IOC success attempt distribution (attempt 1/2/3)
   - market fallback usage rate
   - slippage bps versus expected entry
3. For high-latency / thin contracts:
   - increase `ENTRY_IOC_BASE_BUFFER_TICKS_OPT` by 1 tick steps
   - keep `ENTRY_LADDER_MAX_CHASE_BPS_OPT` tight enough to cap tail slippage
4. If fallback-to-market is enabled, cap with `ENTRY_MARKET_FALLBACK_MAX_SPREAD_BPS_OPT` so fallback only triggers in acceptable spread states.
5. Re-run weekly or after broker/exchange behavior changes.

## OMS unmatched detection hardening

IOC unmatched cancel now checks:

- status message patterns (`status_message`, `status_message_raw`), and
- explicit OMS fields when present (`status_code`, `status_code_raw`, `cancel_reason`, `cancel_reason_code`, `oms_status_code`, `meta.*`).

If your broker payload exposes a stable explicit enum, prefer feeding that enum as `cancel_reason_code`/`status_code` and avoid relying only on text.
