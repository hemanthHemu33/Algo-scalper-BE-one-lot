# Feature Wiring Audit (2026-03-01)

## Scope
Audit of implementation/wiring status for three requested feature bundles:
1. Portfolio Risk Governor
2. Structure-aware Stop Anchors + Liquidity Buffers + Volatility Scaler
3. Execution Fill Quality + Slippage + Spread Adaptive Controls

## 1) Portfolio Risk Governor — Status: **Mostly implemented and wired**

### Implemented
- Dedicated module exists: `src/risk/portfolioGovernor.js`.
- Tracks daily realized PnL in INR and R, trades count, loss streak, open risk, order-error timestamps/count, and breaker cooldown state.
- Enforces gates for daily max loss INR, daily max loss R, max loss streak, max trades/day, max open risk R, and order-error breaker cooldown.
- Uses session-boundary day key through market calendar resolver (`getSessionForDateTime`) in IST.
- Persists to Mongo `risk_state` with `kind: portfolio_governor` and same-day upsert behavior.
- Deduplicates trade-close processing through `processedClosedTradeIds`.
- Integrated in `TradeManager`:
  - initialized with DB collection,
  - checked before new entries (`blocked_by_portfolio_governor`),
  - notified on trade open,
  - notified on trade close,
  - notified on place-order failures.
- Config knobs are present (including `BASE_R_INR_FALLBACK`).
- Jest suite exists for required scenarios (`test/portfolioGovernor.test.js`).

### Pending / gaps
- `TradeManager` currently calls `registerTradeClose` in two different close paths; dedupe inside governor prevents double counting, but close-hook ownership is split and could be consolidated for cleaner single-source close finalization.

## 2) Structure Anchors + Liquidity Buffers + Vol Scaler — Status: **Implemented and wired**

### Implemented
- `src/trading/structureLevels.js` computes day/prev-day/week highs-lows, ORB, VWAP, and last swing highs/lows.
- `src/trading/stopAnchors.js` maps strategy -> anchor family and returns anchor metadata + buffered SL recommendation.
- Liquidity buffer and round-level avoidance are applied through `applyLiquidityBuffer` plumbing in stop anchor computation.
- `src/trading/dynamicExitManager.js` integration:
  - level caching with TTL,
  - volatility scaler calculation and bounded scaling for minGreenR / BE arm / trail arm,
  - structure anchor application only after min-green gate,
  - BUY/SELL combine logic includes structure floor alongside BE/profit-lock/trail floors.
- Strategy anchor mapping via `STRATEGY_STOP_ANCHOR_MAP` is configurable.
- Required config knobs for this bundle are present.
- Jest suites exist and cover structure levels, stop anchors, and dynamic-exit structure integration.

### Pending / gaps
- No critical wiring gap found in this bundle during static review.

## 3) Execution Quality + Slippage + Spread Adaptive Controls — Status: **Mostly implemented and wired**

### Implemented
- New execution metrics store exists: `src/execution/executionMetrics.js` with Mongo persistence in `execution_state`.
- Tracks/derives avg entry/exit slippage, avg entry spread, spread reject rate, and modify fail rate.
- TradeManager integration:
  - execution metrics indexes ensured at init,
  - post-fill entry slippage (pts/inr/bps) computed and persisted on trade,
  - metrics updated on entry fills / exit fills / spread rejects / order-modify outcomes,
  - execution breaker gate checked before entry, with cooldown behavior.
- BE offset and min-green include slippage/spread-aware components (`BE_SLIP_MULT`, `BE_SPREAD_MULT`, `MIN_GREEN_SLIP_MULT`).
- Spread/depth/premium controls for options are wired (`ENTRY_MAX_SPREAD_BPS_OPT_PASSIVE`, `ENTRY_MAX_SPREAD_BPS_OPT_AGGR`, `ENTRY_MIN_PREMIUM`, depth checks for IOC).
- Required Jest suites exist (`executionMetrics`, `postFillReconcile`, `spreadGate.opt`, `executionBreaker`).

### Pending / gaps
- Follow-up implementation resolved the earlier microstructure integration failure and hardened order placement response handling; no open execution-quality wiring gaps remain from the requested list.

## Consolidated pending task list (from requested feature list)
- ✅ Completed in follow-up implementation pass:
  1. Fixed failing Jest integration flow in entry microstructure path (full Jest suite green).
  2. Hardened `_executeEntryByMicrostructure` for missing/invalid `_safePlaceOrder` responses (prevents undefined `orderId` dereference).
  3. Consolidated portfolio-governor close accounting to a single authoritative close-finalization path (`_finalizeClosed`) by removing duplicate close registration in `_bookRealizedPnl`.
- No remaining blockers identified from the requested list.

## Overall conclusion
- Requested feature sets are implemented, wired, and currently test-green for both `npm run test:jest` and `npm test`.
