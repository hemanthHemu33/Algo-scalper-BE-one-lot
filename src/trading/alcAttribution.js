const STATE_RANK = Object.freeze({
  NONE: 0,
  L1: 1,
  L2: 2,
  EXIT: 3,
});

function n(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAlcState(state, fallback = "NONE") {
  const raw = String(state || fallback).trim().toUpperCase();
  if (raw === "EXITED") return "EXIT";
  if (Object.prototype.hasOwnProperty.call(STATE_RANK, raw)) return raw;
  return fallback;
}

function maxAlcState(...states) {
  return states
    .map((state) => normalizeAlcState(state))
    .sort((left, right) => (STATE_RANK[right] ?? 0) - (STATE_RANK[left] ?? 0))[0] || "NONE";
}

function normalizeAlcAppliedSource(source, fallback = null) {
  const raw = String(source || "").trim().toUpperCase();
  if (!raw) return fallback;
  if (raw === "ALC_EXIT" || raw === "ALC_EXIT_NOW") return "ALC_EXIT_NOW";
  if (raw === "ALC_L1" || raw === "ALC_L2") return raw;
  return fallback;
}

function normalizeAlcAttributionConfidence(value, fallback = null) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return fallback;
  if (["LOW", "MEDIUM", "HIGH"].includes(raw)) return raw;
  return fallback;
}

function alcAppliedSourceForState(state) {
  const normalizedState = normalizeAlcState(state);
  if (normalizedState === "L1") return "ALC_L1";
  if (normalizedState === "L2") return "ALC_L2";
  if (normalizedState === "EXIT") return "ALC_EXIT_NOW";
  return null;
}

function alcSourceMatchesState(source, state) {
  const normalizedSource = normalizeAlcAppliedSource(source);
  const expectedSource = alcAppliedSourceForState(state);
  return Boolean(normalizedSource && expectedSource && normalizedSource === expectedSource);
}

function finalProtectionOwnerFromTrade(trade = {}, fallback = null) {
  const explicitOwner =
    trade?.alcFinalProtectionOwner ??
    trade?.loserCompressionFinalProtectionOwner ??
    fallback;
  const normalizedExplicitOwner = explicitOwner
    ? String(explicitOwner).trim().toUpperCase()
    : null;

  const exitReasonCode = String(
    trade?.exitReasonCode ??
      trade?.loserExitReasonCode ??
      trade?.panicExitReason ??
      "",
  )
    .trim()
    .toUpperCase();
  const normalizedAppliedSource = normalizeAlcAppliedSource(
    trade?.loserCompressionAppliedSource,
  );
  const normalizedAppliedState = normalizeAlcState(
    trade?.loserCompressionAppliedState,
  );
  const alcExitLineageLive =
    normalizedAppliedSource === "ALC_EXIT_NOW" ||
    normalizeAlcAppliedSource(normalizedExplicitOwner) === "ALC_EXIT_NOW" ||
    normalizedAppliedState === "EXIT" ||
    exitReasonCode === "ALC_EXIT_NOW" ||
    (Boolean(trade?.loserExitTriggered) &&
      String(
        trade?.loserExitReasonCode ??
          trade?.loserCompressionReasonAtLastAction ??
          "",
      )
        .trim()
        .toUpperCase() === "ALC_EXIT_NOW");
  if (alcExitLineageLive) return "ALC_EXIT_NOW";

  if (normalizedExplicitOwner) return normalizedExplicitOwner;

  const protectedStopSource = String(trade?.protectedStopSource || "")
    .trim()
    .toUpperCase();
  if (protectedStopSource) return protectedStopSource;

  const exitAuthority = String(trade?.exitAuthority || "")
    .trim()
    .toUpperCase();
  if (exitAuthority) return exitAuthority;

  return null;
}

function computeSavedRisk({
  side,
  entryPrice,
  initialStopLoss,
  protectedPrice,
  riskInr,
}) {
  const entry = n(entryPrice, NaN);
  const initialStop = n(initialStopLoss, NaN);
  const protection = n(protectedPrice, NaN);
  if (
    !(
      Number.isFinite(entry) &&
      Number.isFinite(initialStop) &&
      Number.isFinite(protection)
    )
  ) {
    return { alcSavedRiskR: null, alcSavedRiskInr: null };
  }
  const originalRiskPts = Math.abs(entry - initialStop);
  if (!(originalRiskPts > 0)) {
    return { alcSavedRiskR: null, alcSavedRiskInr: null };
  }
  const savedRiskPts =
    String(side || "BUY").toUpperCase() === "SELL"
      ? Math.max(0, initialStop - protection)
      : Math.max(0, protection - initialStop);
  const alcSavedRiskR = savedRiskPts / originalRiskPts;
  return {
    alcSavedRiskR,
    alcSavedRiskInr:
      Number.isFinite(Number(riskInr)) && Number(riskInr) > 0
        ? alcSavedRiskR * Number(riskInr)
        : null,
  };
}

function deriveAlcAttribution(trade = {}, options = {}) {
  const targetState = normalizeAlcState(
    trade?.loserCompressionTargetState ?? trade?.loserCompressionState,
  );
  const submittedState = normalizeAlcState(
    trade?.loserCompressionSubmittedState ?? targetState,
  );
  const rawAppliedState = normalizeAlcState(trade?.loserCompressionAppliedState);
  const explicitConfirmed =
    Boolean(options.appliedConfirmed) ||
    Boolean(trade?.loserCompressionAppliedConfirmed);
  let appliedSource = normalizeAlcAppliedSource(
    options.appliedSource ??
      trade?.loserCompressionAppliedSource ??
      (rawAppliedState === "EXIT" &&
      String(
        trade?.loserExitReasonCode ?? trade?.exitReasonCode ?? "",
      ).trim().toUpperCase() === "ALC_EXIT_NOW"
        ? "ALC_EXIT_NOW"
        : null),
  );
  let attributionConfidence = normalizeAlcAttributionConfidence(
    options.attributionConfidence ??
      trade?.loserCompressionAttributionConfidence,
  );
  const lastConfirmedStop = n(trade?.loserCompressionLastConfirmedStop, NaN);
  const lastConfirmedAt = Date.parse(trade?.loserCompressionLastConfirmedAt || "");

  let appliedState = "NONE";
  if (rawAppliedState === "EXIT") {
    if (
      explicitConfirmed ||
      appliedSource === "ALC_EXIT_NOW" ||
      String(
        trade?.loserExitReasonCode ?? trade?.exitReasonCode ?? "",
      ).trim().toUpperCase() === "ALC_EXIT_NOW"
    ) {
      appliedState = "EXIT";
      appliedSource = appliedSource || "ALC_EXIT_NOW";
      attributionConfidence =
        attributionConfidence || (explicitConfirmed ? "HIGH" : "MEDIUM");
    }
  } else if (rawAppliedState !== "NONE") {
    if (alcSourceMatchesState(appliedSource, rawAppliedState)) {
      appliedState = rawAppliedState;
      attributionConfidence =
        attributionConfidence ||
        (explicitConfirmed ? "HIGH" : Number.isFinite(lastConfirmedAt) ? "MEDIUM" : "HIGH");
    } else if (explicitConfirmed && Number.isFinite(lastConfirmedStop)) {
      const legacyOwner = normalizeAlcAppliedSource(
        options.finalProtectionOwner ?? trade?.protectedStopSource,
      );
      if (alcSourceMatchesState(legacyOwner, rawAppliedState)) {
        appliedState = rawAppliedState;
        appliedSource = legacyOwner;
        attributionConfidence = attributionConfidence || "MEDIUM";
      }
    }
  }

  const alcRequestedLevel = maxAlcState(targetState, submittedState, rawAppliedState);
  const alcRequested = alcRequestedLevel !== "NONE";
  const alcAppliedConfirmed = appliedState !== "NONE";
  const alcAppliedLevel = alcAppliedConfirmed ? appliedState : null;
  if (alcAppliedConfirmed && !appliedSource) {
    appliedSource = alcAppliedSourceForState(appliedState);
  }
  if (alcAppliedConfirmed && !attributionConfidence) {
    attributionConfidence = explicitConfirmed ? "HIGH" : "MEDIUM";
  }

  const alcFinalProtectionOwner =
    finalProtectionOwnerFromTrade(trade, options.finalProtectionOwner) ||
    appliedSource;
  const finalOwnerIsAlc = normalizeAlcAppliedSource(alcFinalProtectionOwner);
  const alcAppliedButSuperseded = Boolean(
    alcAppliedConfirmed &&
      alcFinalProtectionOwner &&
      !finalOwnerIsAlc &&
      alcFinalProtectionOwner !== appliedSource,
  );
  const alcSupersededBy = alcAppliedButSuperseded
    ? alcFinalProtectionOwner
    : null;
  const alcRequestedButNotApplied = Boolean(alcRequested && !alcAppliedConfirmed);

  const protectedPrice =
    appliedState === "EXIT"
      ? n(options.exitPrice ?? trade?.exitPrice ?? trade?.exit_price, NaN)
      : n(options.appliedStopPrice ?? trade?.loserCompressionLastConfirmedStop, NaN);
  const savedRisk = alcAppliedConfirmed
    ? computeSavedRisk({
        side: options.side ?? trade?.side,
        entryPrice: options.entryPrice ?? trade?.entryPrice ?? trade?.entry_price,
        initialStopLoss:
          options.initialStopLoss ??
          trade?.initialStopLoss ??
          trade?.strategyStopLoss ??
          trade?.sizingStopLoss,
        protectedPrice,
        riskInr:
          options.riskInr ??
          trade?.executionRiskInr ??
          trade?.execution_risk_inr,
      })
    : { alcSavedRiskR: null, alcSavedRiskInr: null };

  return {
    alcRequested,
    alcRequestedLevel: alcRequested ? alcRequestedLevel : null,
    alcAppliedConfirmed,
    alcAppliedLevel,
    alcAppliedSource: appliedSource || null,
    alcAttributionConfidence: attributionConfidence || null,
    alcRequestedButNotApplied,
    alcAppliedButSuperseded,
    alcSupersededBy,
    alcFinalProtectionOwner: alcFinalProtectionOwner || null,
    alcSavedRiskR: savedRisk.alcSavedRiskR,
    alcSavedRiskInr: savedRisk.alcSavedRiskInr,
  };
}

module.exports = {
  alcAppliedSourceForState,
  alcSourceMatchesState,
  deriveAlcAttribution,
  finalProtectionOwnerFromTrade,
  normalizeAlcAppliedSource,
  normalizeAlcAttributionConfidence,
  normalizeAlcState,
};
