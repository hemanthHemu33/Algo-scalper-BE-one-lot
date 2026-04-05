# Backtest Framework Completion

## What was added

- Config-driven backtest loading with validation and CLI override support.
- Standalone data validation command and structured `data_quality_report.json`.
- Signal, admission, and rejection decision logs with normalized reason codes.
- Portfolio-state and risk-governor simulation for capital, daily loss, drawdown, concurrency, and open-risk controls.
- Rich report packs under `reports/backtests/<runId>/` with CSV, JSON, and Markdown outputs.
- Monthly, regime, and reason-breakdown analytics.
- Matrix batch runner and walk-forward runner.
- Acceptance verdict evaluation for single runs and OOS walk-forward output.
- Focused tests for the new framework modules.

## How it works

- `scripts/bt_run.js` now accepts `--config=...` and resolves the new config sections into the internal replay config.
- `src/backtest/runBacktest.js` still uses the existing replay/evaluation loop, execution realism, dynamic contract selection, and dynamic exits.
- The new backtest layers wrap around that core to add governance, logging, analytics, and reporting.
- Matrix and walk-forward runners reuse the same `runBacktest` entry point so all child runs emit the same report pack shape.

## How to run it

```bash
npm run bt:backfill -- --token=260105 --from=2026-01-01 --to=2026-01-31T23:59:59+05:30 --interval=1 --chunkDays=10
npm run bt:prepare-options -- --underlyingToken=260105 --underlying="NIFTY 50" --optionType=ALL --from=2026-01-01 --to=2026-01-31 --interval=1 --refreshInstruments=true
npm run bt:validate-data -- --config=config/backtests/nifty_opt_1m_sample.json
npm run bt:run -- --config=config/backtests/nifty_opt_1m_sample.json
npm run bt:matrix -- --config=config/backtests/nifty_opt_matrix_sample.json
npm run bt:wfa -- --config=config/backtests/nifty_opt_walkforward_sample.json
```

## Intentionally out of scope

- No changes to live trading behavior, live broker placement, or production APIs.
- No rewrite of the replay engine or signal formulas.
- No redesign of the existing dynamic exit math beyond backtest logging and portfolio integration.
- No forced multi-position architecture rewrite beyond governor-aware simulation on top of the current flow.
