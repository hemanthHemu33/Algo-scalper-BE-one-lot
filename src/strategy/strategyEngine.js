const { env } = require("../config");
const { getRecentCandles } = require("../market/candleStore");
const registry = require("./registry");
const { pickStrategies } = require("./selector");
const {
  getMinCandlesForSignal,
  getMinCandlesForRegime,
  resolveStrategyMinCandles,
} = require("./minCandles");
const {
  decorateSignalCandidate,
  applySetupLifecycle,
  rememberFiredSignal,
  lookupStrategyState,
  resetSignalLayerState,
  describeSignalLayerPersistence,
} = require("./signalControls");
const {
  buildSignalLifecycleId,
  buildSignalTiming,
  buildSignalOutcomeKey,
  buildSignalConversionSummary,
  freezeSignalRegimeSnapshot,
  isStrategyStyleAllowedForRegime,
  shouldEmitLiveCandidate,
} = require("./signalLifecycle");
const { telemetry } = require("../telemetry/signalTelemetry");
const { logger } = require("../logger");

function enabledIntervals() {
  return String(env.SIGNAL_INTERVALS || "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function mergeCandlesByTs(primary, secondary) {
  const map = new Map();
  for (const candle of primary || []) {
    const ts = candle?.ts ? new Date(candle.ts).getTime() : null;
    if (Number.isFinite(ts)) map.set(ts, candle);
  }
  for (const candle of secondary || []) {
    const ts = candle?.ts ? new Date(candle.ts).getTime() : null;
    if (Number.isFinite(ts)) map.set(ts, candle);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function selectorNowFromCandle(last) {
  const ts = last?.ts ? new Date(last.ts).getTime() : NaN;
  if (Number.isFinite(ts)) return new Date(ts);
  return new Date();
}

function attachSignalLifecycleContext(candidate, context, selectorState, options = {}) {
  const createdAtMs = Number(options.createdAtMs ?? Date.now());
  const timing = buildSignalTiming({
    signal: candidate,
    context,
    createdAtMs,
    decisionTsMs: createdAtMs,
  });
  const regimeSnapshot = freezeSignalRegimeSnapshot({
    signal: candidate,
    context,
    selectorState,
    timestampMs: createdAtMs,
  });

  const regimeMeta = {
    ...(selectorState?.meta || candidate?.regimeMeta || {}),
    regimeWeights:
      regimeSnapshot.regimeWeights ||
      selectorState?.regimeWeights ||
      candidate?.regimeWeights ||
      null,
    primaryRegime:
      regimeSnapshot.primaryRegime !== "UNKNOWN"
        ? regimeSnapshot.primaryRegime
        : selectorState?.primaryRegime || selectorState?.regime || null,
    secondaryRegime:
      regimeSnapshot.secondaryRegime !== "UNKNOWN"
        ? regimeSnapshot.secondaryRegime
        : selectorState?.secondaryRegime || null,
  };

  return {
    ...candidate,
    signalId: candidate?.signalId || buildSignalLifecycleId(),
    signalEventTs: timing.signalEventTs,
    signalCreatedAt: timing.signalCreatedAt,
    signalDecisionTs: timing.signalDecisionTs,
    regimeSnapshot,
    regimeSnapshotId: regimeSnapshot.snapshotId,
    signalOutcomeKey:
      candidate?.signalOutcomeKey ||
      buildSignalOutcomeKey(
        {
          ...candidate,
          signalEventTs: timing.signalEventTs,
        },
        context,
      ),
    regime:
      regimeSnapshot.regime !== "UNKNOWN"
        ? regimeSnapshot.regime
        : selectorState?.regime || candidate?.regime || null,
    primaryRegime:
      regimeSnapshot.primaryRegime !== "UNKNOWN"
        ? regimeSnapshot.primaryRegime
        : selectorState?.primaryRegime || selectorState?.regime || null,
    secondaryRegime:
      regimeSnapshot.secondaryRegime !== "UNKNOWN"
        ? regimeSnapshot.secondaryRegime
        : selectorState?.secondaryRegime || null,
    regimeWeights:
      regimeSnapshot.regimeWeights ||
      selectorState?.regimeWeights ||
      candidate?.regimeWeights ||
      null,
    regimeMeta,
    entryPipeline: {
      signalCreatedAt: timing.signalCreatedAt,
      signalEventTs: timing.signalEventTs,
    },
  };
}

function buildSignalDecisionTrace(signal, context, selectorState, patch = {}) {
  const scoreBreakdown = signal?.scoreBreakdown || {};
  const routingPatch = patch.routing || {};
  return {
    signalId: signal?.signalId || null,
    signalOutcomeKey: signal?.signalOutcomeKey || null,
    timing: {
      signalEventTs: signal?.signalEventTs || null,
      signalCreatedAt: signal?.signalCreatedAt || null,
      signalDecisionTs: signal?.signalDecisionTs || signal?.signalCreatedAt || null,
    },
    score: {
      rawConfidence: Number(signal?.rawConfidence ?? signal?.confidence ?? 0),
      normalizedConfidence: Number(signal?.normalizedConfidence ?? 0),
      patternQuality: Number(signal?.patternQuality ?? scoreBreakdown.patternQuality ?? 0),
      volumeQuality: Number(signal?.volumeQuality ?? scoreBreakdown.volumeQuality ?? 0),
      anchorQuality: Number(signal?.anchorQuality ?? scoreBreakdown.anchorQuality ?? 0),
      structureQuality: Number(signal?.structureQuality ?? scoreBreakdown.structureQuality ?? 0),
      qualityScore: Number(signal?.qualityScore ?? 0),
      regimeAlignment: Number(signal?.regimeAlignment ?? scoreBreakdown.regimeAlignment ?? 0),
      freshness: Number(signal?.freshness ?? scoreBreakdown.freshness ?? 0),
      antiChop: Number(signal?.antiChop ?? 100 - Number(scoreBreakdown.chopPenalty ?? 0)),
      antiGap: Number(signal?.antiGap ?? 100 - Number(scoreBreakdown.gapPenalty ?? 0)),
      stageScore: Number(signal?.stageScore ?? scoreBreakdown.stageScore ?? 0),
      selectorParticipation: Number(
        signal?.selectorParticipation ?? scoreBreakdown.selectorParticipation ?? 0,
      ),
      mtfAgreementScore: Number(signal?.mtfAgreementScore ?? 0),
      mtfBias: signal?.mtfBias || scoreBreakdown.mtfBias || null,
      contextScore: Number(signal?.contextScore ?? 0),
      finalSignalScore: Number(signal?.finalSignalScore ?? 0),
    },
    preEmit: patch.preEmit ?? signal?.preEmit ?? null,
    conversion: patch.conversion ?? signal?.conversionSummary ?? null,
    lifecycle: {
      setupId: signal?.meta?.setupId || signal?.setupId || null,
      parentSetupId: signal?.meta?.parentSetupId || signal?.parentSetupId || null,
      lineageId: signal?.meta?.lineageId || signal?.lineageId || null,
      setupState: signal?.setupState || signal?.meta?.setupState || null,
      setupLineage: signal?.meta?.setupLineage || signal?.setupLineage || null,
      setupObservationCount: Number(
        signal?.meta?.setupObservationCount ?? signal?.setupObservationCount ?? 0,
      ),
      signalStage: signal?.signalStage || null,
      isProvisional: signal?.isProvisional === true,
      candleClosed: signal?.candleClosed === true,
    },
    mtf: {
      mtfAgreementScore: Number(signal?.mtfAgreementScore ?? 0),
      mtfBias: signal?.mtfBias || null,
      mtfState: signal?.mtfState || scoreBreakdown.mtfState || null,
      mtfContributors: scoreBreakdown.mtfContributors || null,
      mtfExpectedIntervals: scoreBreakdown.mtfExpectedIntervals || null,
      mtfUsedIntervals: scoreBreakdown.mtfUsedIntervals || null,
      mtfMissingIntervals: scoreBreakdown.mtfMissingIntervals || null,
      mtfStaleIntervals: scoreBreakdown.mtfStaleIntervals || null,
      mtfFallbackReason:
        signal?.mtfFallbackReason || scoreBreakdown.mtfFallbackReason || null,
      mtfDegraded:
        signal?.mtfDegraded === true || scoreBreakdown.mtfDegraded === true,
    },
    calibration: {
      calibrationActive: signal?.calibrationActive === true,
      calibrationVersion: signal?.calibrationVersion || null,
      calibrationSource: signal?.calibrationSource || null,
      fallbackReason: signal?.fallbackReason || null,
    },
    selector: {
      regime: signal?.regime || selectorState?.regime || context?.regime || null,
      primaryRegime:
        signal?.primaryRegime || selectorState?.primaryRegime || selectorState?.regime || null,
      secondaryRegime: signal?.secondaryRegime || selectorState?.secondaryRegime || null,
      regimeWeights: signal?.regimeWeights || selectorState?.regimeWeights || null,
      strategyParticipationWeight:
        signal?.meta?.strategyParticipationWeight ??
        selectorState?.strategyWeights?.[signal?.strategyId] ??
        null,
    },
    routing: {
      decisionStage: routingPatch.decisionStage ?? signal?.decisionStage ?? null,
      decisionOutcome: routingPatch.decisionOutcome ?? signal?.decisionOutcome ?? null,
      emitted: routingPatch.emitted ?? signal?.emitted ?? false,
      routed: routingPatch.routed ?? signal?.routed ?? false,
      accepted: routingPatch.accepted ?? signal?.accepted ?? false,
      selectedInSignalLayer:
        routingPatch.selectedInSignalLayer ?? signal?.selectedInSignalLayer ?? false,
      suppressionReason:
        routingPatch.suppressionReason ?? signal?.suppressionReason ?? null,
      suppressionReasons:
        routingPatch.suppressionReasons ?? signal?.suppressionReasons ?? null,
      rejectionReason: routingPatch.rejectionReason ?? signal?.rejectionReason ?? null,
      beforeRouting:
        routingPatch.beforeRouting != null
          ? routingPatch.beforeRouting === true
          : signal?.beforeRouting === true,
    },
    persistence: describeSignalLayerPersistence(),
  };
}

function attachSignalDecisionState(signal, context, selectorState, patch = {}) {
  const routingPatch = patch.routing || {};
  let next = {
    ...signal,
    preEmit: patch.preEmit ?? signal?.preEmit ?? null,
    emitted: routingPatch.emitted ?? signal?.emitted ?? false,
    routed: routingPatch.routed ?? signal?.routed ?? false,
    accepted: routingPatch.accepted ?? signal?.accepted ?? false,
    selectedInSignalLayer:
      routingPatch.selectedInSignalLayer ?? signal?.selectedInSignalLayer ?? false,
    suppressionReason:
      routingPatch.suppressionReason ?? signal?.suppressionReason ?? null,
    suppressionReasons:
      routingPatch.suppressionReasons ?? signal?.suppressionReasons ?? null,
    rejectionReason:
      routingPatch.rejectionReason ?? signal?.rejectionReason ?? null,
    decisionStage: routingPatch.decisionStage ?? signal?.decisionStage ?? null,
    decisionOutcome: routingPatch.decisionOutcome ?? signal?.decisionOutcome ?? null,
    beforeRouting:
      routingPatch.beforeRouting != null
        ? routingPatch.beforeRouting === true
        : signal?.beforeRouting === true,
  };
  next = {
    ...next,
    conversionSummary: buildSignalConversionSummary(next, patch.conversion || {
      preEmitDecision:
        routingPatch.decisionStage === "signal_preemit"
          ? routingPatch.decisionOutcome || null
          : next?.conversionSummary?.preEmitDecision || null,
      preEmitFailureReasons:
        routingPatch.decisionStage === "signal_preemit" &&
        routingPatch.decisionOutcome === "SUPPRESSED"
          ? routingPatch.suppressionReasons || next?.suppressionReasons || []
          : next?.conversionSummary?.preEmitFailureReasons || null,
      mtfState: next?.mtfState || next?.scoreBreakdown?.mtfState || null,
      routeAttempted:
        routingPatch.routed != null
          ? routingPatch.routed === true
          : next?.conversionSummary?.routeAttempted ?? false,
      finalReasonCode:
        routingPatch.rejectionReason ||
        routingPatch.suppressionReason ||
        next?.rejectionReason ||
        next?.suppressionReason ||
        null,
      finalOutcome:
        routingPatch.decisionOutcome === "SUPPRESSED" &&
        routingPatch.suppressionReason === "STYLE_REGIME_MISMATCH"
          ? "SUPPRESSED_STYLE_REGIME"
          : routingPatch.decisionOutcome === "SUPPRESSED" &&
              String(routingPatch.suppressionReason || "").includes("MTF")
            ? "SUPPRESSED_MTF"
            : routingPatch.decisionOutcome === "SUPPRESSED" &&
                routingPatch.suppressionReason
              ? "SUPPRESSED_CONFIDENCE"
              : routingPatch.decisionOutcome === "OUTRANKED"
                ? "OUTRANKED"
                : routingPatch.decisionOutcome === "EMITTED_NOT_ROUTED"
                  ? "BLOCKED_ROUTING"
                  : null,
    }),
  };
  next.signalDecision = buildSignalDecisionTrace(next, context, selectorState, patch);
  return next;
}

function captureSignalDecision(signalCapture, signal, patch = {}) {
  if (!signalCapture) return;
  if (typeof signalCapture.recordSignalDecision === "function") {
    signalCapture.recordSignalDecision({ signal, ...patch });
    return;
  }
  if (typeof signalCapture.recordSignal === "function") {
    signalCapture.recordSignal({ ...signal, ...patch });
  }
}

async function ensureSeriesForEvaluation({
  instrument_token,
  intervalMin,
  candles,
  strategyIds,
}) {
  const targetHistory = Math.max(
    getMinCandlesForSignal(env, intervalMin, strategyIds),
    String(env.STRATEGY_SELECTOR_ENABLED || "false") === "true"
      ? getMinCandlesForRegime(env)
      : 2,
  );

  let series = candles;
  if (!series || series.length < targetHistory) {
    const fetched = await getRecentCandles(instrument_token, intervalMin, 400);
    if (series && series.length) {
      series = mergeCandlesByTs(fetched, series);
    } else {
      series = fetched;
    }
  }

  return series && series.length ? series : null;
}

async function evaluateOnCandleClose({
  instrument_token,
  intervalMin,
  candles,
  createdAtMs = null,
  recordTelemetry = true,
  signalCapture = null,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;

  const strategyIds = registry.enabledStrategyIds();
  if (!strategyIds.length) return null;
  const series = await ensureSeriesForEvaluation({
    instrument_token,
    intervalMin,
    candles,
    strategyIds,
  });
  if (!series || !series.length) return null;

  const last = series[series.length - 1];
  return evaluateFromCandles({
    candles: series,
    last,
    instrument_token,
    intervalMin,
    stage: "close",
    strategyIds,
    createdAtMs,
    recordTelemetry,
    signalCapture,
  });
}

async function evaluateOnCandleTick({
  instrument_token,
  intervalMin,
  liveCandle,
  candles,
  createdAtMs = null,
  recordTelemetry = true,
  signalCapture = null,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;

  const strategyIds = registry.enabledStrategyIds();
  if (!strategyIds.length) return null;
  const series = await ensureSeriesForEvaluation({
    instrument_token,
    intervalMin,
    candles,
    strategyIds,
  });
  if (!series || !series.length) return null;

  const live = liveCandle || null;
  if (!live || !live.ts) return null;

  const last = series[series.length - 1];
  const lastTs = last?.ts ? new Date(last.ts).getTime() : null;
  const liveTs = new Date(live.ts).getTime();

  let merged = series.slice();
  if (lastTs != null && liveTs === lastTs) {
    merged[merged.length - 1] = live;
  } else {
    merged.push(live);
  }

  return evaluateFromCandles({
    candles: merged,
    last: live,
    instrument_token,
    intervalMin,
    stage: "tick",
    strategyIds,
    createdAtMs,
    recordTelemetry,
    signalCapture,
  });
}

function enrichSetupCandidate(setup, candidate) {
  if (!candidate) return null;
  const meta = {
    ...(candidate.meta || {}),
    setupState:
      setup?.setupState ||
      candidate?.meta?.setupState ||
      candidate?.setupState ||
      null,
    actionable:
      setup?.actionable != null ? setup.actionable === true : candidate?.actionable === true,
  };
  if (setup?.anchorMeta && typeof setup.anchorMeta === "object") {
    Object.assign(meta, setup.anchorMeta);
  }
  if (setup?.triggerMeta && typeof setup.triggerMeta === "object") {
    Object.assign(meta, setup.triggerMeta);
  }
  return {
    ...candidate,
    actionable:
      setup?.actionable != null ? setup.actionable === true : candidate?.actionable === true,
    meta,
    setupState: meta.setupState,
  };
}

function sortSignals(signals) {
  signals.sort((a, b) => {
    const finalScore = Number(b.finalSignalScore ?? 0) - Number(a.finalSignalScore ?? 0);
    if (finalScore !== 0) return finalScore;
    const closed = Number(b.candleClosed === true) - Number(a.candleClosed === true);
    if (closed !== 0) return closed;
    const norm = Number(b.normalizedConfidence ?? 0) - Number(a.normalizedConfidence ?? 0);
    if (norm !== 0) return norm;
    return Number(b.rawConfidence ?? 0) - Number(a.rawConfidence ?? 0);
  });
}

function styleGateContextForCandidate(candidate) {
  const scoreBreakdown = candidate?.scoreBreakdown || {};
  const meta = candidate?.meta || {};
  return {
    strategyId: candidate?.strategyId || null,
    strategyStyle: candidate?.strategyStyle || null,
    regime: candidate?.regimeSnapshot?.regime || candidate?.regime || null,
    marketState:
      candidate?.marketState ||
      meta.marketState ||
      scoreBreakdown.marketState ||
      candidate?.regimeMeta?.marketState ||
      null,
    candidate,
    levelAcceptance:
      meta.levelAcceptance ||
      scoreBreakdown.levelAcceptance ||
      candidate?.levelAcceptance ||
      null,
    dangerStack:
      meta.dangerStack ||
      scoreBreakdown.dangerStack ||
      candidate?.dangerStack ||
      null,
    mtf: {
      mtfState: candidate?.mtfState || scoreBreakdown.mtfState || null,
      mtfBias: candidate?.mtfBias || scoreBreakdown.mtfBias || null,
      mtfAgreementScore:
        candidate?.mtfAgreementScore ?? scoreBreakdown.mtfAgreementScore ?? null,
    },
    dteDays:
      candidate?.dteDays ??
      candidate?.dte ??
      meta.dteDays ??
      meta.dte ??
      meta.productAdaptation?.dte ??
      scoreBreakdown.dte ??
      null,
    confidence: candidate?.rawConfidence ?? candidate?.confidence ?? null,
    regimeSnapshot: candidate?.regimeSnapshot || null,
    env,
  };
}

function styleGateConversionPatch(styleGate) {
  const exceptionMeta = styleGate?.exceptionMeta || null;
  const exceptionReasonCode =
    styleGate?.exceptionReasonCode || exceptionMeta?.reasonCode || null;
  return {
    styleGateDecision: styleGate?.allowedByException
      ? "PASS_EXCEPTION"
      : styleGate?.allowed
        ? "PASS"
        : "BLOCK",
    styleGateReasonCode:
      exceptionReasonCode ||
      (styleGate?.allowed ? "STYLE_REGIME_ALLOWED" : "STYLE_REGIME_MISMATCH"),
    styleGateExceptionType:
      styleGate?.exceptionType || exceptionMeta?.exceptionType || null,
    styleGateFailedChecks: exceptionMeta?.failedChecks || [],
    marketState: exceptionMeta?.marketState || null,
    exceptionAllowed: styleGate?.allowedByException === true,
  };
}

function styleGateSuppressionReason(styleGate) {
  return (
    styleGate?.exceptionReasonCode ||
    styleGate?.exceptionMeta?.reasonCode ||
    "STYLE_REGIME_MISMATCH"
  );
}

function signalReasonCodeFromSuppression(reason) {
  if (String(reason || "").startsWith("FRAGILE_REVERSAL_")) {
    return `SIGNAL_SUPPRESSED_${reason}`;
  }
  return "SIGNAL_SUPPRESSED_STYLE_REGIME_MISMATCH";
}

function finalOutcomeForPreEmitSuppression(reason) {
  if (String(reason || "").includes("MTF")) return "SUPPRESSED_MTF";
  if (reason) return "SUPPRESSED_CONFIDENCE";
  return null;
}

function materializeSelectedSignal(best, { last, intervalMin, instrument_token, stage, selectorState }) {
  return {
    ...best,
    signalId: best.signalId,
    signalOutcomeKey: best.signalOutcomeKey || null,
    signalEventTs: best.signalEventTs || last?.ts || null,
    signalCreatedAt: best.signalCreatedAt || null,
    signalDecisionTs: best.signalDecisionTs || best.signalCreatedAt || null,
    strategyId: best.strategyId || env.STRATEGY_ID,
    strategyStyle: best.strategyStyle || null,
    strategyFamily: best.strategyFamily || null,
    confidence: Number(best.rawConfidence ?? best.confidence ?? 0),
    rawConfidence: Number(best.rawConfidence ?? best.confidence ?? 0),
    normalizedConfidence: Number(best.normalizedConfidence ?? 0),
    patternQuality: Number(best.patternQuality ?? best.scoreBreakdown?.patternQuality ?? 0),
    volumeQuality: Number(best.volumeQuality ?? best.scoreBreakdown?.volumeQuality ?? 0),
    anchorQuality: Number(best.anchorQuality ?? best.scoreBreakdown?.anchorQuality ?? 0),
    structureQuality: Number(best.structureQuality ?? best.scoreBreakdown?.structureQuality ?? 0),
    qualityScore: Number(best.qualityScore ?? 0),
    regimeAlignment: Number(best.regimeAlignment ?? best.scoreBreakdown?.regimeAlignment ?? 0),
    freshness: Number(best.freshness ?? best.scoreBreakdown?.freshness ?? 0),
    antiChop: Number(best.antiChop ?? 100 - Number(best.scoreBreakdown?.chopPenalty ?? 0)),
    antiGap: Number(best.antiGap ?? 100 - Number(best.scoreBreakdown?.gapPenalty ?? 0)),
    stageScore: Number(best.stageScore ?? best.scoreBreakdown?.stageScore ?? 0),
    selectorParticipation: Number(
      best.selectorParticipation ?? best.scoreBreakdown?.selectorParticipation ?? 0,
    ),
    contextScore: Number(best.contextScore ?? 0),
    finalSignalScore: Number(best.finalSignalScore ?? 0),
    mtfAgreementScore: Number(best.mtfAgreementScore ?? 0),
    mtfBias: best.mtfBias || null,
    scoreBreakdown: best.scoreBreakdown || null,
    calibrationVersion: best.calibrationVersion || null,
    calibrationSource: best.calibrationSource || null,
    calibrationActive: best.calibrationActive === true,
    fallbackReason: best.fallbackReason || null,
    instrument_token: Number(instrument_token),
    intervalMin: Number(intervalMin),
    regime: best.regime || selectorState?.regime || null,
    primaryRegime: best.primaryRegime || selectorState?.primaryRegime || selectorState?.regime || null,
    secondaryRegime: best.secondaryRegime || selectorState?.secondaryRegime || null,
    regimeWeights: best.regimeWeights || selectorState?.regimeWeights || null,
    regimeMeta: best.regimeMeta || selectorState?.meta || null,
    regimeSnapshot: best.regimeSnapshot || null,
    regimeSnapshotId: best.regimeSnapshotId || null,
    side: best.side,
    reason: best.reason,
    meta: best.meta || null,
    setupState: best.setupState || best.meta?.setupState || null,
    setupObservationCount: Number(
      best.meta?.setupObservationCount ?? best.setupObservationCount ?? 0,
    ),
    triggerType: best.triggerType || best.meta?.triggerType || null,
    anchorType: best.anchorType || best.meta?.anchorType || null,
    signalStage: best.signalStage || null,
    isProvisional: best.isProvisional === true,
    candleClosed: best.candleClosed === true,
    setupLineage: best.meta?.setupLineage || null,
    setupId: best.meta?.setupId || null,
    parentSetupId: best.meta?.parentSetupId || null,
    lineageId: best.meta?.lineageId || null,
    candle: {
      interval_min: Number(intervalMin),
      ts: last?.ts || null,
      open: last?.open,
      high: last?.high,
      low: last?.low,
      close: last?.close,
      volume: last?.volume,
      source: last?.source,
      synthetic: last?.synthetic,
    },
    entryPipeline: best.entryPipeline || null,
    ts: last?.ts || null,
    stage,
  };
}

function evaluateSignalSetFromCandles({
  candles,
  last,
  instrument_token,
  intervalMin,
  stage,
  strategyIds,
  createdAtMs = null,
  recordTelemetry = true,
  signalCapture = null,
}) {
  let ids = Array.isArray(strategyIds) ? strategyIds.slice() : registry.enabledStrategyIds();
  if (!ids.length) return null;

  const selectorEnabled = String(env.STRATEGY_SELECTOR_ENABLED || "false") === "true";
  let sel = null;
  if (selectorEnabled) {
    sel = pickStrategies({ candles, env, now: selectorNowFromCandle(last) });
    if (sel?.strategyIds?.length) ids = sel.strategyIds;
  }

  const recentForVolume = (candles || []).slice(-30);
  const isVolumeUnavailable =
    recentForVolume.length > 0 &&
    recentForVolume.every((candle) => Number(candle?.volume ?? 0) <= 0);

  const context = {
    regime: sel?.regime || null,
    regimeMeta: sel?.meta || null,
    intervalMin,
    candles,
    last,
    stage,
    instrument_token,
  };
  const decisionStage = stage === "tick" ? "selector_tick" : "selector";
  const emittedSignals = [];

  for (const id of ids) {
    const minCandles = resolveStrategyMinCandles(id, intervalMin, env);
    if (!candles || candles.length < minCandles) continue;

    const strategyWeight = Number(sel?.strategyWeights?.[id] ?? 1);
    const priorState = lookupStrategyState({
      token: instrument_token,
      intervalMin,
      strategyId: id,
    });
    const setup = registry.evaluateSetup(id, candles, {
      intervalMin,
      disableVolumeStrategies: isVolumeUnavailable,
      priorState,
      regimeWeights: sel?.regimeWeights || null,
      primaryRegime: sel?.primaryRegime || sel?.regime || null,
      secondaryRegime: sel?.secondaryRegime || null,
      strategyWeight,
    });
    if (!setup?.candidate) continue;

    const rawCandidate = enrichSetupCandidate(setup, setup.candidate);
    rawCandidate.meta = {
      ...(rawCandidate.meta || {}),
      strategyParticipationWeight: strategyWeight,
      regimeWeightsSnapshot: sel?.regimeWeights || null,
      primaryRegime: sel?.primaryRegime || sel?.regime || null,
      secondaryRegime: sel?.secondaryRegime || null,
    };

    const candidate = decorateSignalCandidate(rawCandidate, context);
    const lifecycle = applySetupLifecycle(candidate, context);
    let liveCandidate = attachSignalLifecycleContext(
      lifecycle.candidate || candidate,
      context,
      sel,
      { createdAtMs: createdAtMs != null ? createdAtMs : Date.now() },
    );
    liveCandidate = attachSignalDecisionState(liveCandidate, context, sel, {
      routing: {
        decisionStage: "candidate_observed",
        decisionOutcome:
          liveCandidate.actionable === true ? "CANDIDATE_OBSERVED" : "SETUP_OBSERVED",
        emitted: false,
        routed: false,
        accepted: false,
        beforeRouting: true,
      },
    });

    if (recordTelemetry) {
      telemetry.recordCandidate({
        strategyId: liveCandidate.strategyId,
        strategyStyle: liveCandidate.strategyStyle,
        side: liveCandidate.side,
        confidence: liveCandidate.rawConfidence,
        instrument_token: Number(instrument_token),
        intervalMin: Number(intervalMin),
        ts: liveCandidate.signalEventTs || last?.ts,
        stage,
        signalStage: liveCandidate.signalStage,
        setupState: liveCandidate.setupState,
        finalSignalScore: Number(liveCandidate.finalSignalScore ?? 0),
      });
    }
    captureSignalDecision(signalCapture, liveCandidate, {
      decisionStage: "candidate_observed",
      decisionOutcome: liveCandidate.decisionOutcome,
    });

    if (setup.actionable !== true || liveCandidate.actionable !== true) {
      continue;
    }

    if (lifecycle.suppress) {
      const suppressedCandidate = attachSignalDecisionState(liveCandidate, context, sel, {
        routing: {
          decisionStage: "setup_lifecycle",
          decisionOutcome: "SUPPRESSED",
          emitted: false,
          routed: false,
          accepted: false,
          beforeRouting: true,
          suppressionReason: lifecycle.reason || "SETUP_NOT_MATURE",
          suppressionReasons: [lifecycle.reason || "SETUP_NOT_MATURE"],
        },
      });
      if (recordTelemetry) {
        telemetry.recordDecision({
          signal: suppressedCandidate,
          token: Number(instrument_token),
          outcome: "SUPPRESSED",
          stage: "setup_lifecycle",
          reason: lifecycle.reason || "SETUP_NOT_MATURE",
          meta: {
            signalId: suppressedCandidate.signalId,
            signalOutcomeKey: suppressedCandidate.signalOutcomeKey,
            signalEventTs: suppressedCandidate.signalEventTs,
            setupId: suppressedCandidate.meta?.setupId || null,
            setupState: suppressedCandidate.setupState || null,
          },
        });
      }
      captureSignalDecision(signalCapture, suppressedCandidate, {
        decisionStage: "setup_lifecycle",
        decisionOutcome: "SUPPRESSED",
      });
      continue;
    }

    const styleGate = isStrategyStyleAllowedForRegime(
      styleGateContextForCandidate(liveCandidate),
    );
    if (!styleGate.allowed) {
      const styleSuppressionReason = styleGateSuppressionReason(styleGate);
      const conversionPatch = {
        ...styleGateConversionPatch(styleGate),
        preEmitDecision: "SUPPRESSED",
        preEmitFailureReasons: [styleSuppressionReason],
        mtfState: liveCandidate?.mtfState || liveCandidate?.scoreBreakdown?.mtfState || null,
        routeAttempted: false,
        finalReasonCode: styleSuppressionReason,
        finalOutcome: "SUPPRESSED_STYLE_REGIME",
      };
      const suppressedCandidate = attachSignalDecisionState(liveCandidate, context, sel, {
        routing: {
          decisionStage: "signal_preemit",
          decisionOutcome: "SUPPRESSED",
          emitted: false,
          routed: false,
          accepted: false,
          beforeRouting: true,
          suppressionReason: styleSuppressionReason,
          suppressionReasons: [styleSuppressionReason],
        },
        conversion: conversionPatch,
      });
      const exceptionMeta = styleGate.exceptionMeta || null;
      const suppressionMeta = {
        signalId: suppressedCandidate.signalId,
        signalOutcomeKey: suppressedCandidate.signalOutcomeKey,
        signalEventTs: suppressedCandidate.signalEventTs,
        strategy: suppressedCandidate.strategyId,
        strategyStyle: styleGate.strategyStyle,
        regime: styleGate.regime,
        marketState:
          exceptionMeta?.marketState ||
          suppressedCandidate.marketState ||
          suppressedCandidate.meta?.marketState ||
          null,
        regimeFamily: styleGate.regimeFamily,
        timeframeUsed:
          suppressedCandidate.regimeSnapshot?.sourceTimeframeMin ?? Number(intervalMin),
        confidence: Number(
          suppressedCandidate.rawConfidence ?? suppressedCandidate.confidence ?? 0,
        ),
        allowedRegimes: styleGate.allowedRegimes,
        exceptionChecked: styleGate.exceptionChecked === true,
        exceptionAllowed: styleGate.exceptionAllowed === true,
        exceptionReasonCode:
          styleGate.exceptionReasonCode || exceptionMeta?.reasonCode || null,
        exceptionFailedChecks: exceptionMeta?.failedChecks || [],
        confidenceUsed: exceptionMeta?.confidenceUsed ?? null,
        mtfState:
          exceptionMeta?.mtfState ||
          suppressedCandidate.mtfState ||
          suppressedCandidate.scoreBreakdown?.mtfState ||
          null,
        mtfAgreementScore:
          exceptionMeta?.mtfAgreementScore ??
          suppressedCandidate.mtfAgreementScore ??
          suppressedCandidate.scoreBreakdown?.mtfAgreementScore ??
          null,
        dteDays: exceptionMeta?.dteDays ?? suppressedCandidate.dteDays ?? suppressedCandidate.dte ?? null,
        dangerStackScore:
          exceptionMeta?.dangerStackScore ??
          suppressedCandidate.dangerStackScore ??
          suppressedCandidate.meta?.dangerStack?.dangerStackScore ??
          null,
        levelRejectionDetected: exceptionMeta?.levelRejectionDetected === true,
        sessionExtremeDetected: exceptionMeta?.sessionExtremeDetected === true,
        regimeSnapshotId: suppressedCandidate.regimeSnapshotId,
        conversionSummary: suppressedCandidate.conversionSummary || null,
      };
      if (recordTelemetry) {
        logger.info(
          {
            reasonCode: signalReasonCodeFromSuppression(styleSuppressionReason),
            ...suppressionMeta,
          },
          "[signal] suppressed (style/regime mismatch)",
        );
        telemetry.recordDecision({
          signal: suppressedCandidate,
          token: Number(instrument_token),
          outcome: "SUPPRESSED",
          stage: "signal_preemit",
          reason: signalReasonCodeFromSuppression(styleSuppressionReason),
          meta: suppressionMeta,
        });
      }
      captureSignalDecision(signalCapture, suppressedCandidate, {
        decisionStage: "signal_preemit",
        decisionOutcome: "SUPPRESSED",
      });
      continue;
    }

    if (
      styleGate.allowedByException === true &&
      recordTelemetry &&
      String(env.FRAGILE_REVERSAL_TELEMETRY_ENABLED ?? "true") === "true"
    ) {
      const exceptionMeta = styleGate.exceptionMeta || null;
      logger.info(
        {
          reasonCode: "SIGNAL_ALLOWED_FRAGILE_REVERSAL_EXCEPTION",
          exceptionType: "FRAGILE_REVERSAL",
          strategy: liveCandidate.strategyId,
          regime: styleGate.regime,
          marketState:
            exceptionMeta?.marketState ||
            liveCandidate.marketState ||
            liveCandidate.meta?.marketState ||
            null,
          checksPassed: exceptionMeta?.checksPassed || [],
          riskTier: "STRICT_EXCEPTION",
          confidenceUsed: exceptionMeta?.confidenceUsed ?? null,
          mtfState: exceptionMeta?.mtfState || null,
          mtfAgreementScore: exceptionMeta?.mtfAgreementScore ?? null,
          dteDays: exceptionMeta?.dteDays ?? null,
          dangerStackScore: exceptionMeta?.dangerStackScore ?? null,
          levelRejectionDetected: exceptionMeta?.levelRejectionDetected === true,
          sessionExtremeDetected: exceptionMeta?.sessionExtremeDetected === true,
        },
        "[signal] allowed (fragile reversal exception)",
      );
    }

    const preEmitGate = shouldEmitLiveCandidate({
      candidate: liveCandidate,
      env,
    });
    if (!preEmitGate.emit) {
      const conversionPatch = {
        ...styleGateConversionPatch(styleGate),
        preEmitDecision: "SUPPRESSED",
        preEmitFailureReasons: preEmitGate.suppressionReasons,
        mtfState: liveCandidate?.mtfState || liveCandidate?.scoreBreakdown?.mtfState || null,
        routeAttempted: false,
        finalReasonCode: preEmitGate.suppressionReason,
        finalOutcome: finalOutcomeForPreEmitSuppression(preEmitGate.suppressionReason),
      };
      const suppressedCandidate = attachSignalDecisionState(liveCandidate, context, sel, {
        preEmit: preEmitGate.qualityMeta,
        routing: {
          decisionStage: "signal_preemit",
          decisionOutcome: "SUPPRESSED",
          emitted: false,
          routed: false,
          accepted: false,
          beforeRouting: true,
          suppressionReason: preEmitGate.suppressionReason,
          suppressionReasons: preEmitGate.suppressionReasons,
        },
        conversion: conversionPatch,
      });
      const suppressionMeta = {
        signalId: suppressedCandidate.signalId,
        signalOutcomeKey: suppressedCandidate.signalOutcomeKey,
        signalEventTs: suppressedCandidate.signalEventTs,
        strategy: suppressedCandidate.strategyId,
        regime: suppressedCandidate.regimeSnapshot?.regime || suppressedCandidate.regime || null,
        regimeSnapshotId: suppressedCandidate.regimeSnapshotId,
        ...preEmitGate.qualityMeta,
        conversionSummary: suppressedCandidate.conversionSummary || null,
      };
      if (recordTelemetry) {
        logger.info(
          {
            reasonCode: preEmitGate.reasonCode || "SIGNAL_SUPPRESSED_PREEMIT_PROFILE",
            ...suppressionMeta,
          },
          "[signal] suppressed (pre-emit profile)",
        );
        telemetry.recordDecision({
          signal: suppressedCandidate,
          token: Number(instrument_token),
          outcome: "SUPPRESSED",
          stage: "signal_preemit",
          reason: preEmitGate.reasonCode || "SIGNAL_SUPPRESSED_PREEMIT_PROFILE",
          meta: suppressionMeta,
        });
      }
      captureSignalDecision(signalCapture, suppressedCandidate, {
        decisionStage: "signal_preemit",
        decisionOutcome: "SUPPRESSED",
      });
      continue;
    }

    const emittedCandidate = attachSignalDecisionState(liveCandidate, context, sel, {
      preEmit: preEmitGate.qualityMeta,
      routing: {
        decisionStage: "signal_preemit",
        decisionOutcome: "EMITTED",
        emitted: true,
        routed: false,
        accepted: false,
        beforeRouting: true,
      },
      conversion: {
        ...styleGateConversionPatch(styleGate),
        preEmitDecision: "EMITTED",
        preEmitFailureReasons: [],
        mtfState: liveCandidate?.mtfState || liveCandidate?.scoreBreakdown?.mtfState || null,
        routeAttempted: false,
        finalReasonCode: null,
        finalOutcome: null,
      },
    });
    emittedSignals.push(emittedCandidate);
    captureSignalDecision(signalCapture, emittedCandidate, {
      decisionStage: "signal_preemit",
      decisionOutcome: "EMITTED",
    });
  }

  if (!emittedSignals.length) return null;

  sortSignals(emittedSignals);
  let best = attachSignalDecisionState(emittedSignals[0], context, sel, {
    routing: {
      decisionStage,
      decisionOutcome: "SELECTED",
      emitted: true,
      routed: false,
      accepted: false,
      selectedInSignalLayer: true,
      beforeRouting: false,
    },
  });

  const rankedSignals = [best];
  for (const loser of emittedSignals.slice(1)) {
    const outrankedSignal = attachSignalDecisionState(loser, context, sel, {
      routing: {
        decisionStage,
        decisionOutcome: "OUTRANKED",
        emitted: true,
        routed: false,
        accepted: false,
        selectedInSignalLayer: false,
        beforeRouting: false,
        rejectionReason: "OUTRANKED",
      },
    });
    rankedSignals.push(outrankedSignal);
    if (recordTelemetry) {
      telemetry.recordDecision({
        signal: outrankedSignal,
        token: Number(instrument_token),
        outcome: "OUTRANKED",
        stage: decisionStage,
        reason: outrankedSignal.reason,
        meta: {
          signalId: outrankedSignal.signalId || null,
          signalOutcomeKey: outrankedSignal.signalOutcomeKey || null,
          signalEventTs: outrankedSignal.signalEventTs || null,
          outrankedBy: best.strategyId,
          scoreGap: Number((best.finalSignalScore ?? 0) - (outrankedSignal.finalSignalScore ?? 0)),
          setupId: outrankedSignal.meta?.setupId || null,
          signalStage: outrankedSignal.signalStage || null,
          conversionSummary: outrankedSignal.conversionSummary || null,
        },
      });
    }
    captureSignalDecision(signalCapture, outrankedSignal, {
      decisionStage,
      decisionOutcome: "OUTRANKED",
    });
  }

  if (String(env.ALLOW_SYNTHETIC_SIGNALS || "false") !== "true") {
    if (last?.source && last.source !== "live") {
      const blockedBest = attachSignalDecisionState(best, context, sel, {
        routing: {
          decisionStage,
          decisionOutcome: "EMITTED_NOT_ROUTED",
          emitted: true,
          routed: false,
          accepted: false,
          selectedInSignalLayer: true,
          beforeRouting: false,
          rejectionReason: "NON_LIVE_CANDLE_SOURCE",
        },
      });
      rankedSignals[0] = blockedBest;
      captureSignalDecision(signalCapture, blockedBest, {
        decisionStage,
        decisionOutcome: "EMITTED_NOT_ROUTED",
      });
      return {
        signals: rankedSignals.map((signal) => ({
          ...signal,
          selectedAsBestSignal: signal.signalId === blockedBest.signalId,
        })),
        selectedSignal: null,
        regime: sel?.regime || null,
        regimeMeta: sel?.meta || null,
        primaryRegime: sel?.primaryRegime || sel?.regime || null,
        secondaryRegime: sel?.secondaryRegime || null,
        strategyIds: ids.slice(),
        candle: last || null,
      };
    }
    if (last?.synthetic) {
      const blockedBest = attachSignalDecisionState(best, context, sel, {
        routing: {
          decisionStage,
          decisionOutcome: "EMITTED_NOT_ROUTED",
          emitted: true,
          routed: false,
          accepted: false,
          selectedInSignalLayer: true,
          beforeRouting: false,
          rejectionReason: "SYNTHETIC_SIGNAL_BLOCK",
        },
      });
      rankedSignals[0] = blockedBest;
      captureSignalDecision(signalCapture, blockedBest, {
        decisionStage,
        decisionOutcome: "EMITTED_NOT_ROUTED",
      });
      return {
        signals: rankedSignals.map((signal) => ({
          ...signal,
          selectedAsBestSignal: signal.signalId === blockedBest.signalId,
        })),
        selectedSignal: null,
        regime: sel?.regime || null,
        regimeMeta: sel?.meta || null,
        primaryRegime: sel?.primaryRegime || sel?.regime || null,
        secondaryRegime: sel?.secondaryRegime || null,
        strategyIds: ids.slice(),
        candle: last || null,
      };
    }
  }

  rememberFiredSignal(best, context);
  best = attachSignalDecisionState(best, context, sel, {
    routing: {
      decisionStage,
      decisionOutcome: "SELECTED",
      emitted: true,
      routed: false,
      accepted: false,
      selectedInSignalLayer: true,
      beforeRouting: false,
    },
  });
  rankedSignals[0] = best;
  captureSignalDecision(signalCapture, best, {
    decisionStage,
    decisionOutcome: "SELECTED",
  });

  if (recordTelemetry) {
    telemetry.recordDecision({
      signal: {
        strategyId: best.strategyId,
        strategyStyle: best.strategyStyle,
        side: best.side,
        intervalMin: Number(intervalMin),
        signalStage: best.signalStage,
        signalId: best.signalId,
        signalEventTs: best.signalEventTs,
      },
      token: Number(instrument_token),
      outcome: "SELECTED",
      stage: decisionStage,
      reason: best.reason,
      meta: {
        signalId: best.signalId || null,
        signalOutcomeKey: best.signalOutcomeKey || null,
        signalEventTs: best.signalEventTs || null,
        regimeSnapshotId: best.regimeSnapshotId || null,
        confidence: Number(best.rawConfidence ?? best.confidence ?? 0),
        rawConfidence: Number(best.rawConfidence ?? best.confidence ?? 0),
        normalizedConfidence: Number(best.normalizedConfidence ?? 0),
        qualityScore: Number(best.qualityScore ?? 0),
        contextScore: Number(best.contextScore ?? 0),
        finalSignalScore: Number(best.finalSignalScore ?? 0),
        mtfAgreementScore: Number(best.mtfAgreementScore ?? 0),
        mtfBias: best.mtfBias || null,
        signalStage: best.signalStage || null,
        regime: sel?.regime || null,
        conversionSummary: best.conversionSummary || null,
      },
    });
  }

  const selectedSignal = materializeSelectedSignal(best, {
    last,
    intervalMin,
    instrument_token,
    stage,
    selectorState: sel,
  });
  const signals = rankedSignals.map((signal) => ({
    ...signal,
    selectedAsBestSignal: signal.signalId === selectedSignal.signalId,
  }));
  return {
    signals,
    selectedSignal,
    regime: sel?.regime || null,
    regimeMeta: sel?.meta || null,
    primaryRegime: sel?.primaryRegime || sel?.regime || null,
    secondaryRegime: sel?.secondaryRegime || null,
    strategyIds: ids.slice(),
    candle: last || null,
  };
}

function evaluateFromCandles(options) {
  const signalSet = evaluateSignalSetFromCandles(options);
  return signalSet?.selectedSignal || null;
}

module.exports = {
  evaluateOnCandleClose,
  evaluateOnCandleTick,
  evaluateSignalSetFromCandles,
  resetSignalLayerState,
};
