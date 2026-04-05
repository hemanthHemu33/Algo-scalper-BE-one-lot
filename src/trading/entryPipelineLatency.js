function toMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function diffMs(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

const DEFAULT_STAGE_BUDGETS_MS = Object.freeze({
  signalToRouteStartMs: 250,
  routeToContractSelectionMs: 1600,
  contractSelectionToBackfillStartMs: 250,
  backfillMs: 250,
  postSelectionToAdmissionMs: 2200,
  admissionToOrderIntentMs: 600,
});

function buildEntryPipelineLatency({
  timeline = {},
  nowMs = Date.now(),
  stageBudgetsMs = DEFAULT_STAGE_BUDGETS_MS,
  totalBudgetMs = null,
}) {
  const stamps = {
    signalEventTs: toMs(timeline.signalEventTs),
    signalCreatedAt: toMs(timeline.signalCreatedAt),
    routeStartAt: toMs(timeline.routeStartAt),
    contractSelectedAt: toMs(timeline.contractSelectedAt),
    backfillStartAt: toMs(timeline.backfillStartAt),
    backfillEndAt: toMs(timeline.backfillEndAt),
    admissionCheckAt: toMs(timeline.admissionCheckAt),
    orderIntentCreatedAt: toMs(timeline.orderIntentCreatedAt),
  };

  const referenceSignalTs = stamps.signalEventTs ?? stamps.signalCreatedAt;

  const stageMs = {
    signalToRouteStartMs: diffMs(stamps.signalCreatedAt, stamps.routeStartAt),
    routeToContractSelectionMs: diffMs(
      stamps.routeStartAt,
      stamps.contractSelectedAt,
    ),
    contractSelectionToBackfillStartMs: diffMs(
      stamps.contractSelectedAt,
      stamps.backfillStartAt,
    ),
    backfillMs: diffMs(stamps.backfillStartAt, stamps.backfillEndAt),
    postSelectionToAdmissionMs: diffMs(
      stamps.backfillEndAt ??
        stamps.contractSelectedAt ??
        stamps.routeStartAt,
      stamps.admissionCheckAt,
    ),
    admissionToOrderIntentMs: diffMs(
      stamps.admissionCheckAt,
      stamps.orderIntentCreatedAt,
    ),
  };

  const endMs =
    stamps.orderIntentCreatedAt ??
    stamps.admissionCheckAt ??
    Number(nowMs);
  const totalAgeMs = diffMs(stamps.signalCreatedAt, endMs);
  const marketAgeMs = diffMs(referenceSignalTs, endMs);

  let culpritStage = null;
  let culpritDurationMs = null;
  let culpritBudgetMs = null;

  for (const [stage, duration] of Object.entries(stageMs)) {
    const budget = Number(stageBudgetsMs?.[stage]);
    if (!Number.isFinite(duration) || !Number.isFinite(budget)) continue;
    if (duration <= budget) continue;
    if (culpritDurationMs == null || duration > culpritDurationMs) {
      culpritStage = stage;
      culpritDurationMs = duration;
      culpritBudgetMs = budget;
    }
  }

  const totalBudgetExceeded =
    Number.isFinite(totalAgeMs) &&
    Number.isFinite(Number(totalBudgetMs)) &&
    totalAgeMs > Number(totalBudgetMs);

  return {
    timestamps: {
      signalEventTs: toIso(stamps.signalEventTs),
      signalCreatedAt: toIso(stamps.signalCreatedAt),
      routeStartAt: toIso(stamps.routeStartAt),
      contractSelectedAt: toIso(stamps.contractSelectedAt),
      backfillStartAt: toIso(stamps.backfillStartAt),
      backfillEndAt: toIso(stamps.backfillEndAt),
      admissionCheckAt: toIso(stamps.admissionCheckAt),
      orderIntentCreatedAt: toIso(stamps.orderIntentCreatedAt),
    },
    stageMs,
    totalAgeMs,
    marketAgeMs,
    culpritStage,
    culpritDurationMs,
    culpritBudgetMs,
    totalBudgetMs: Number.isFinite(Number(totalBudgetMs))
      ? Number(totalBudgetMs)
      : null,
    totalBudgetExceeded,
  };
}

module.exports = {
  DEFAULT_STAGE_BUDGETS_MS,
  buildEntryPipelineLatency,
};
