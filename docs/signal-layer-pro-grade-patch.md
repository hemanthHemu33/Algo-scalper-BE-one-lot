# Signal Layer Pro-Grade Patch

What was missing
- Signal capture was too thin to rebuild calibration artifacts directly from repo-produced records.
- Pre-emit suppression was not explicit and inspectable for every live strategy.
- Setup memory lived only in-process, so restart continuity could break setup lineage and duplicate suppression.
- Signal timing mixed event time and wall-clock creation time in ways that were hard to replay and audit cleanly.
- Decision telemetry was not rich enough to explain suppression, ranking, routing, and later outcomes end to end.

What was added
- Expanded signal capture with score inputs, resolved pre-emit thresholds, setup lineage, timing fields, routing state, contract selection, persistence metadata, and joined outcomes.
- Deterministic capture -> outcome enrichment -> calibration artifact builder flow via `src/backtest/signalCapture.js` and `scripts/build_signal_score_calibration.js`.
- Explicit hierarchical pre-emit profiles for every live strategy, with stable machine-readable suppression reasons and resolved profile telemetry.
- Optional file-backed signal-layer state persistence for setup registry and interval snapshots, with safe fallback to memory mode and deterministic restore behavior.
- First-class `signalEventTs`, `signalCreatedAt`, and `signalDecisionTs` semantics wired through lifecycle, replay, backtest capture, and observability.
- Structured signal decision introspection through `getSignalDecisionBreakdown()`, `explainSignalSuppression()`, and `getSignalLayerStateSnapshot()`.

Why this is now pro-grade
- Every live strategy is covered by explicit pre-emit discipline before routing.
- Every emitted or suppressed candidate can be traced from setup formation through selection, routing, and outcome attachment.
- Calibration artifacts can be rebuilt from captured repo-native rows without manual reshaping.
- Important signal memory survives restart or falls back safely without breaking signal evaluation.
- Timing and telemetry are now explicit enough for deterministic replay, live debugging, and post-trade inspection.

New env/config flags
- `SIGNAL_STATE_PERSIST`
- `SIGNAL_STATE_PERSIST_PATH`
- `SIGNAL_STATE_PERSIST_TTL_MIN`
- `SIGNAL_STATE_PERSIST_MAX_SETUPS`
- `SIGNAL_PREEMIT_GLOBAL_MIN_NORMALIZED_CONFIDENCE`
- `SIGNAL_PREEMIT_GLOBAL_MIN_QUALITY_SCORE`
- `SIGNAL_PREEMIT_GLOBAL_MIN_CONTEXT_SCORE`
- `SIGNAL_PREEMIT_GLOBAL_MIN_FINAL_SCORE`
- `SIGNAL_PREEMIT_GLOBAL_MIN_MTF_SCORE`
- `SIGNAL_PREEMIT_GLOBAL_MIN_FRESHNESS`
