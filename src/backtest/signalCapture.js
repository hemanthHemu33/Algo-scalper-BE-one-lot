const { buildSignalOutcomeKey } = require("../strategy/signalLifecycle");

function toIsoOrNull(value) {
  if (value == null) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBooleanOrNull(value) {
  if (value == null) return null;
  return value === true;
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function outcomeLabelFromValue(value) {
  const text = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!text) return null;
  if (["WIN", "PROFIT", "POSITIVE"].includes(text)) return "WIN";
  if (["LOSS", "LOSE", "NEGATIVE"].includes(text)) return "LOSS";
  if (["NEUTRAL", "FLAT", "BREAKEVEN"].includes(text)) return "NEUTRAL";
  return text;
}

function scoreOutcome({ outcomeScore, outcome, pnlR }) {
  const numericScore = Number(outcomeScore);
  if (Number.isFinite(numericScore)) {
    return Math.max(0, Math.min(1, numericScore));
  }
  const label = outcomeLabelFromValue(outcome);
  if (label === "WIN") return 1;
  if (label === "LOSS") return 0;
  if (label === "NEUTRAL") return 0.5;
  const pnl = Number(pnlR);
  if (!Number.isFinite(pnl)) return null;
  return Math.max(0, Math.min(1, 0.5 + pnl * 0.25));
}

function labelOutcome({ outcome, pnlR, outcomeScore }) {
  const label = outcomeLabelFromValue(outcome);
  if (label) return label;
  const pnl = Number(pnlR);
  if (Number.isFinite(pnl)) {
    if (pnl > 0.15) return "WIN";
    if (pnl < -0.15) return "LOSS";
    return "NEUTRAL";
  }
  const score = Number(outcomeScore);
  if (Number.isFinite(score)) {
    if (score >= 0.67) return "WIN";
    if (score <= 0.33) return "LOSS";
    return "NEUTRAL";
  }
  return null;
}

function riskRMultiple({ trade, fallbackRiskInr = null }) {
  const explicitRiskInr = Number(trade?.riskInr);
  if (Number.isFinite(explicitRiskInr) && explicitRiskInr > 0) return explicitRiskInr;
  const entry = Number(trade?.entryPrice);
  const stop = Number(trade?.initialStopLoss ?? trade?.stopLoss);
  const qty = Number(trade?.initialQty ?? trade?.qty);
  if (
    Number.isFinite(entry) &&
    Number.isFinite(stop) &&
    Number.isFinite(qty) &&
    qty > 0 &&
    entry !== stop
  ) {
    return Math.abs(entry - stop) * qty;
  }
  const fallback = Number(fallbackRiskInr);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
}

function holdingBucketFromTrade(trade) {
  const holdCandles = Number(trade?.holdCandles);
  if (Number.isFinite(holdCandles)) {
    if (holdCandles <= 1) return "INSTANT";
    if (holdCandles <= 3) return "SHORT";
    if (holdCandles <= 8) return "MEDIUM";
    return "LONG";
  }
  return null;
}

function normalizeCapturedSignalRecord(row = {}) {
  const signal = row.signal && typeof row.signal === "object" ? row.signal : row;
  const decision = signal?.signalDecision || row?.signalDecision || {};
  const score = decision?.score || {};
  const preEmit = signal?.preEmit || decision?.preEmit || {};
  const lifecycle = decision?.lifecycle || {};
  const routing = decision?.routing || {};
  const calibration = decision?.calibration || {};
  const persistence = decision?.persistence || {};
  const timing = decision?.timing || {};
  const selector = decision?.selector || {};
  const selectedContract = row.selectedContract || signal.selectedContract || null;

  const normalized = {
    ts: toIsoOrNull(
      row.ts ||
        signal.ts ||
        timing.signalEventTs ||
        signal.signalEventTs ||
        signal.candle?.ts,
    ),
    candleTs: toIsoOrNull(
      row.candleTs || row.eventTs || signal.candle?.ts || signal.signalEventTs || signal.ts,
    ),
    eventTs: toIsoOrNull(
      row.eventTs || signal.signalEventTs || timing.signalEventTs || signal.candle?.ts || signal.ts,
    ),
    signalCreatedAt: toIsoOrNull(
      row.signalCreatedAt || signal.signalCreatedAt || timing.signalCreatedAt,
    ),
    signalDecisionTs: toIsoOrNull(
      row.signalDecisionTs || signal.signalDecisionTs || timing.signalDecisionTs,
    ),
    signalEventTs: toIsoOrNull(
      row.signalEventTs || signal.signalEventTs || timing.signalEventTs || signal.candle?.ts,
    ),
    token: toNumberOrNull(
      row.token || row.instrument_token || signal.token || signal.instrument_token,
    ),
    underlying: nonEmptyString(row.underlying || row.underlyingSymbol || signal.underlying),
    intervalMin: toNumberOrNull(
      row.intervalMin || signal.intervalMin || signal.candle?.interval_min,
    ),
    mode: nonEmptyString(row.mode || signal.mode),
    strategyId: nonEmptyString(row.strategyId || signal.strategyId),
    strategyFamily: nonEmptyString(row.strategyFamily || signal.strategyFamily),
    strategyStyle: nonEmptyString(row.strategyStyle || signal.strategyStyle),
    side: nonEmptyString(row.side || signal.side),
    regime: nonEmptyString(row.regime || signal.regime || selector.regime),
    confidence: toNumberOrNull(row.confidence ?? signal.confidence ?? signal.rawConfidence),
    rawConfidence: toNumberOrNull(
      row.rawConfidence ?? signal.rawConfidence ?? signal.confidence,
    ),
    normalizedConfidence: toNumberOrNull(
      row.normalizedConfidence ?? signal.normalizedConfidence ?? score.normalizedConfidence,
    ),
    patternQuality: toNumberOrNull(
      row.patternQuality ?? signal.patternQuality ?? score.patternQuality,
    ),
    volumeQuality: toNumberOrNull(
      row.volumeQuality ?? signal.volumeQuality ?? score.volumeQuality,
    ),
    anchorQuality: toNumberOrNull(
      row.anchorQuality ?? signal.anchorQuality ?? score.anchorQuality,
    ),
    structureQuality: toNumberOrNull(
      row.structureQuality ?? signal.structureQuality ?? score.structureQuality,
    ),
    qualityScore: toNumberOrNull(row.qualityScore ?? signal.qualityScore ?? score.qualityScore),
    regimeAlignment: toNumberOrNull(
      row.regimeAlignment ?? signal.regimeAlignment ?? score.regimeAlignment,
    ),
    freshness: toNumberOrNull(row.freshness ?? signal.freshness ?? score.freshness),
    antiChop: toNumberOrNull(row.antiChop ?? signal.antiChop ?? score.antiChop),
    antiGap: toNumberOrNull(row.antiGap ?? signal.antiGap ?? score.antiGap),
    stageScore: toNumberOrNull(row.stageScore ?? signal.stageScore ?? score.stageScore),
    selectorParticipation: toNumberOrNull(
      row.selectorParticipation ??
        signal.selectorParticipation ??
        score.selectorParticipation,
    ),
    mtfAgreementScore: toNumberOrNull(
      row.mtfAgreementScore ?? signal.mtfAgreementScore ?? score.mtfAgreementScore,
    ),
    mtfBias: nonEmptyString(row.mtfBias || signal.mtfBias || score.mtfBias),
    contextScore: toNumberOrNull(row.contextScore ?? signal.contextScore ?? score.contextScore),
    finalSignalScore: toNumberOrNull(
      row.finalSignalScore ?? signal.finalSignalScore ?? score.finalSignalScore,
    ),
    calibrationActive: toBooleanOrNull(
      row.calibrationActive ?? signal.calibrationActive ?? calibration.calibrationActive,
    ),
    calibrationVersion:
      row.calibrationVersion || signal.calibrationVersion || calibration.calibrationVersion || null,
    calibrationSource:
      row.calibrationSource || signal.calibrationSource || calibration.calibrationSource || null,
    setupId: row.setupId || signal.setupId || lifecycle.setupId || signal.meta?.setupId || null,
    setupState:
      row.setupState ||
      signal.setupState ||
      lifecycle.setupState ||
      signal.meta?.setupState ||
      null,
    setupLineage:
      row.setupLineage ||
      signal.setupLineage ||
      lifecycle.setupLineage ||
      signal.meta?.setupLineage ||
      null,
    signalStage:
      row.signalStage || signal.signalStage || lifecycle.signalStage || null,
    isProvisional: toBooleanOrNull(
      row.isProvisional ?? signal.isProvisional ?? lifecycle.isProvisional,
    ),
    candleClosed: toBooleanOrNull(
      row.candleClosed ?? signal.candleClosed ?? lifecycle.candleClosed,
    ),
    emitted: toBooleanOrNull(row.emitted ?? signal.emitted ?? routing.emitted),
    routed: toBooleanOrNull(row.routed ?? signal.routed ?? routing.routed),
    accepted: toBooleanOrNull(row.accepted ?? signal.accepted ?? routing.accepted),
    selectedInSignalLayer: toBooleanOrNull(
      row.selectedInSignalLayer ??
        signal.selectedInSignalLayer ??
        routing.selectedInSignalLayer,
    ),
    rejectionReason:
      row.rejectionReason || signal.rejectionReason || routing.rejectionReason || null,
    suppressionReason:
      row.suppressionReason || signal.suppressionReason || routing.suppressionReason || null,
    suppressionReasons: clone(
      row.suppressionReasons ||
        signal.suppressionReasons ||
        routing.suppressionReasons ||
        null,
    ),
    selectedContractToken: toNumberOrNull(
      row.selectedContractToken ??
        signal.selectedContractToken ??
        selectedContract?.selectedToken ??
        selectedContract?.token,
    ),
    selectedStrike: toNumberOrNull(
      row.selectedStrike ?? signal.selectedStrike ?? selectedContract?.selected?.strike,
    ),
    selectedExpiry:
      row.selectedExpiry ||
      signal.selectedExpiry ||
      selectedContract?.selected?.expiryISO ||
      selectedContract?.selected?.expiry ||
      null,
    signalId: row.signalId || signal.signalId || decision.signalId || null,
    signalOutcomeKey:
      row.signalOutcomeKey ||
      signal.signalOutcomeKey ||
      decision.signalOutcomeKey ||
      buildSignalOutcomeKey(signal, {
        instrument_token: row.token || signal.instrument_token,
        intervalMin: row.intervalMin || signal.intervalMin,
        last: row.signalEventTs || signal.signalEventTs || signal.candle?.ts,
      }),
    decisionStage:
      row.decisionStage || row.stage || signal.decisionStage || routing.decisionStage || null,
    decisionOutcome:
      row.decisionOutcome ||
      row.outcomeState ||
      signal.decisionOutcome ||
      routing.decisionOutcome ||
      null,
    profileSource: preEmit.profileSource || row.profileSource || null,
    profileId: preEmit.profileId || row.profileId || null,
    profileChain: clone(preEmit.profileChain || row.profileChain || null),
    resolvedThresholds: clone(preEmit.resolvedThresholds || row.resolvedThresholds || null),
    failedChecks: clone(preEmit.failedChecks || row.failedChecks || null),
    failingDimensions: clone(preEmit.failingDimensions || row.failingDimensions || null),
    persistenceMode: persistence.persistenceMode || row.persistenceMode || null,
    persistencePath: persistence.persistencePath || row.persistencePath || null,
    persistenceRestoreSource: persistence.restoreSource || row.persistenceRestoreSource || null,
    persistenceFallbackReason:
      persistence.fallbackReason || row.persistenceFallbackReason || null,
    outcomeScore: toNumberOrNull(row.outcomeScore),
    outcome: outcomeLabelFromValue(row.outcome),
    pnlR: toNumberOrNull(row.pnlR),
    mfeR: toNumberOrNull(row.mfeR),
    maeR: toNumberOrNull(row.maeR),
    holdingBucket: nonEmptyString(row.holdingBucket),
  };

  return normalized;
}

function mergeRecords(existing = {}, incoming = {}) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (value === null) {
      if (!(key in next)) next[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      next[key] = value.slice();
      continue;
    }
    if (typeof value === "object") {
      next[key] = clone(value);
      continue;
    }
    next[key] = value;
  }
  if (!next.signalOutcomeKey) {
    next.signalOutcomeKey = buildSignalOutcomeKey(next, {
      instrument_token: next.token,
      intervalMin: next.intervalMin,
      last: next.signalEventTs || next.eventTs || next.ts,
    });
  }
  if (!next.ts) {
    next.ts = next.signalEventTs || next.eventTs || next.candleTs || null;
  }
  return next;
}

function buildCaptureKey(row) {
  return (
    row.signalOutcomeKey ||
    buildSignalOutcomeKey(row, {
      instrument_token: row.token,
      intervalMin: row.intervalMin,
      last: row.signalEventTs || row.eventTs || row.ts,
    }) ||
    [
      row.token || "na",
      row.intervalMin || "na",
      row.signalEventTs || row.eventTs || row.ts || "na",
      row.strategyId || "na",
      row.side || "na",
      row.signalStage || "na",
      row.setupId || "na",
    ].join("|")
  );
}

function recordFromTrade(trade = {}) {
  const riskInr = riskRMultiple({ trade });
  const netPnl = Number(trade?.netPnl);
  const pnlR = Number.isFinite(riskInr) && riskInr > 0 && Number.isFinite(netPnl)
    ? netPnl / riskInr
    : null;
  const riskPoints = (() => {
    const entry = Number(trade?.entryPrice);
    const stop = Number(trade?.initialStopLoss ?? trade?.stopLoss);
    return Number.isFinite(entry) && Number.isFinite(stop) && entry !== stop
      ? Math.abs(entry - stop)
      : null;
  })();
  const mfeR =
    Number.isFinite(riskPoints) && riskPoints > 0 && Number.isFinite(Number(trade?.MFE))
      ? Number(trade.MFE) / riskPoints
      : null;
  const maeR =
    Number.isFinite(riskPoints) && riskPoints > 0 && Number.isFinite(Number(trade?.MAE))
      ? -Number(trade.MAE) / riskPoints
      : null;
  const outcome = labelOutcome({ pnlR });
  return {
    signalOutcomeKey: trade?.signalOutcomeKey || null,
    outcomeScore: scoreOutcome({ pnlR, outcome }),
    outcome,
    pnlR,
    mfeR,
    maeR,
    holdingBucket: holdingBucketFromTrade(trade),
  };
}

function createSignalCapture() {
  const rowsByKey = new Map();

  function upsert(row = {}) {
    const normalized = normalizeCapturedSignalRecord(row);
    const key = buildCaptureKey(normalized);
    const existing = rowsByKey.get(key) || {};
    const next = mergeRecords(existing, normalized);
    rowsByKey.set(key, next);
    return next;
  }

  function recordSignal(row) {
    return upsert(row);
  }

  function recordSignalDecision({
    signal,
    selectedContract = null,
    mode = null,
    underlying = null,
    ...rest
  }) {
    return upsert({
      signal,
      mode: mode || signal?.mode || null,
      underlying: underlying || signal?.underlying || null,
      selectedContract,
      ...rest,
    });
  }

  function recordRoutingDecision({
    signal,
    accepted = false,
    routed = false,
    rejectionReason = null,
    selectedContract = null,
    ...rest
  }) {
    return recordSignalDecision({
      signal,
      accepted,
      routed,
      rejectionReason,
      selectedContract,
      ...rest,
    });
  }

  function recordTradeOutcome({ signalOutcomeKey = null, trade = null, ...rest }) {
    const tradeDerived = trade ? recordFromTrade(trade) : {};
    return upsert({
      signalOutcomeKey: signalOutcomeKey || tradeDerived.signalOutcomeKey,
      ...tradeDerived,
      ...rest,
    });
  }

  function attachOutcomes(outcomes = []) {
    const source = Array.isArray(outcomes) ? outcomes : Array.from(outcomes.values?.() || []);
    for (const outcome of source) {
      if (!outcome) continue;
      if (outcome.tradeId || outcome.entryPrice || outcome.signalOutcomeKey) {
        recordTradeOutcome({ trade: outcome, signalOutcomeKey: outcome.signalOutcomeKey });
        continue;
      }
      upsert(outcome);
    }
    return getRows();
  }

  function getRows() {
    return Array.from(rowsByKey.values()).sort((a, b) => {
      const aTs = new Date(a.signalEventTs || a.eventTs || a.ts || 0).getTime();
      const bTs = new Date(b.signalEventTs || b.eventTs || b.ts || 0).getTime();
      if (aTs !== bTs) return aTs - bTs;
      return String(a.signalOutcomeKey || "").localeCompare(String(b.signalOutcomeKey || ""));
    });
  }

  function buildCalibrationRecords({ requireOutcome = true } = {}) {
    return getRows().filter((row) => {
      if (!row.strategyId || row.intervalMin == null) return false;
      if (row.normalizedConfidence == null) return false;
      if (row.qualityScore == null) return false;
      if (row.contextScore == null) return false;
      if (requireOutcome && row.outcomeScore == null) return false;
      return true;
    });
  }

  return {
    recordSignal,
    recordSignalDecision,
    recordRoutingDecision,
    recordTradeOutcome,
    attachOutcomes,
    buildCalibrationRecords,
    getRows,
  };
}

module.exports = {
  createSignalCapture,
  normalizeCapturedSignalRecord,
  buildSignalCaptureKey: buildCaptureKey,
  labelOutcome,
  scoreOutcome,
};
