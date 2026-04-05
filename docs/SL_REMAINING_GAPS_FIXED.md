Stop ownership gaps closed:
- Removed budget-stop overwrite on full and partial fills; strategy stop remains immutable and broker stop mirrors it only.
- Post-fill risk recheck now tags SOFT/HARD breaches, optionally reduces or exits on HARD, and never re-fits SL.
- Dynamic exit/targets anchor R from `strategyStopLoss` (fallback to legacy `initialStopLoss`/`stopLoss` for old trades).
- Trade state now carries `strategyStopLoss`, `sizingStopLoss`, `brokerStopLoss`, `originalRiskPts`, `originalRiskInr`, `riskBudgetInr`, `postFillTrueRiskInr`, `riskBreachState`, `postFillRiskAction` with restart-safe normalization.
- Defensive logging warns on strategy stop mutation and records soft/hard breach handling.

Why post-fill SL refit was removed:
- It silently changed strategy invalidation after fill, corrupting R math and trailing decisions. Breaches are now handled by tagging, reduction, or exit while keeping the original stop meaning intact.

Soft/hard breach behavior:
- SOFT: `riskBreachState=SOFT`, `postFillRiskAction=TAG_ONLY`, stops unchanged.
- HARD: try safe reduce if allowed, else panic exit; stops unchanged and action logged.
