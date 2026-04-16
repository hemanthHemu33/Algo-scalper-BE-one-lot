const { DateTime } = require("luxon");
const { env } = require("../config");
const { logger } = require("../logger");
const { getDb } = require("../db");
const { reportFault, reportWindowedFault } = require("../runtime/errorBus");
const { isTransientMongoError } = require("../runtime/isTransientMongoError");
const {
  markMongoHealthy,
  markMongoDegraded,
} = require("../runtime/mongoRuntimeState");

/**
 * Trade outcome telemetry (pro tuning support).
 *
 * Tracks closed trades + fee-multiple (grossPnL / estimated costs).
 * This complements signalTelemetry (candidate/blocked reasons) with "did we beat costs?"
 */

function tz() {
  return env.CANDLE_TZ || "Asia/Kolkata";
}

function dayKey(now = new Date()) {
  try {
    return DateTime.fromJSDate(now, { zone: tz() }).toFormat("yyyy-LL-dd");
  } catch {
    const d = new Date(now);
    return d.toISOString().slice(0, 10);
  }
}

function safeKey(s, maxLen = 180) {
  const v = String(s || "").replace(/\s+/g, " ").trim();
  if (!v) return "UNKNOWN";
  return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
}

function inc(obj, key, n = 1) {
  if (!obj) return;
  const k = safeKey(key);
  obj[k] = (obj[k] || 0) + Number(n ?? 0);
}

function optionalKey(s, maxLen = 180) {
  const v = String(s || "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  return v.length > maxLen ? v.slice(0, maxLen) + "â€¦" : v;
}

function addMetric(agg, sumKey, countKey, value) {
  if (!agg) return;
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  agg[sumKey] = Number(agg[sumKey] || 0) + n;
  agg[countKey] = Number(agg[countKey] || 0) + 1;
}

function avgMetric(sum, count) {
  return count > 0 ? Math.round((sum / count) * 1000) / 1000 : null;
}

function sortCountsDesc(obj = {}, limit = null) {
  return Object.fromEntries(
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Number.isFinite(Number(limit)) ? Number(limit) : undefined),
  );
}

function makeBlockerFunnel() {
  return {
    received: 0,
    blockedPreRouteConfidence: 0,
    blockedPostRouteConfidence: 0,
    softPassedPostRouteConfidence: 0,
    multiTfTransitionPassed: 0,
    blockedPlanner: 0,
    plannerFallbackCount: 0,
    readinessBlockedStale: 0,
    readinessBlockedIncomplete: 0,
    blockedRiskFit: 0,
    compressedRiskFit: 0,
    breachAllowedRiskFit: 0,
    readyForExecution: 0,
    entryPlaced: 0,
  };
}

function makePlannerPathAgg() {
  return {
    countsByPath: {},
    acceptedByPath: {},
    blockedByPath: {},
    fallbackReasonCounts: {},
    byStrategy: {},
    byFamily: {},
  };
}

function normalizePlannerPath(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (["MODERN", "LEGACY_FALLBACK", "MIXED_ASSIST"].includes(raw)) return raw;
  return null;
}

function plannerPathObserved(item = {}, plannerPath = null) {
  const path = normalizePlannerPath(plannerPath);
  if (!path) return false;
  const outcome = String(item?.outcome || "").trim().toUpperCase();
  const stage = String(item?.stage || "").trim().toLowerCase();
  const reason = String(item?.reason || "").trim().toUpperCase();
  return outcome === "BLOCKED" || (stage === "entry" && reason === "READY_FOR_EXECUTION");
}

function normalizeAlcState(state) {
  const raw = String(state || "NONE").trim().toUpperCase();
  if (raw === "EXITED") return "EXIT";
  if (["NONE", "L1", "L2", "EXIT"].includes(raw)) return raw;
  return "NONE";
}

function safeMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return { note: "UNSERIALIZABLE_META" };
  }
}

function bucketFeeMultiple(x) {
  if (!Number.isFinite(x)) return "NA";
  if (x < 0) return "<0";
  if (x < 1) return "0-1";
  if (x < 2) return "1-2";
  if (x < 3) return "2-3";
  if (x < 5) return "3-5";
  return "5+";
}

class TradeTelemetry {
  constructor(options = {}) {
    this._enabled =
      options.enabled ??
      (String(env.TELEMETRY_ENABLED || "true") === "true" &&
        String(env.TELEMETRY_TRADES_ENABLED || "true") === "true");

    this._ringSize = Number(
      options.ringSize ?? env.TELEMETRY_TRADES_RING_SIZE ?? 300,
    );
    this._flushSec = Number(options.flushSec ?? env.TELEMETRY_FLUSH_SEC ?? 60);
    this._dailyCollection =
      options.dailyCollection ||
      env.TELEMETRY_TRADES_DAILY_COLLECTION ||
      "telemetry_trades_daily";

    this._state = this._freshState(dayKey());
    this._timer = null;
    this._mongoDegraded = false;
    this._mongoBackoffMs = 0;
    this._mongoNextFlushAt = 0;
  }

  _freshState(dk) {
    return {
      dayKey: dk,
      tz: tz(),
      startedAt: new Date(),
      updatedAt: new Date(),

      tradesClosedTotal: 0,
      closedByStrategy: {},
      closedByReason: {},
      feeMultipleBuckets: {},

      sumFeeMultiple: 0,
      countFeeMultiple: 0,

      sumNetAfterEstCostsInr: 0,
      sumGrossPnlInr: 0,
      sumEstCostsInr: 0,

      lastTrades: [], // ring buffer
      decisionsTotal: 0,
      decisionsByOutcome: {},
      decisionsByStage: {},
      decisionsByReason: {},
      lastDecisions: [], // ring buffer
      blockerFunnel: makeBlockerFunnel(),
      blockerReasonsTop: {},
      finalBlockerReasonByFamily: {},
      finalBlockerReasonByStrategy: {},
      plannerPathAgg: makePlannerPathAgg(),
      postRouteAgg: {
        hardBlockedCount: 0,
        softPassCount: 0,
        sumConfidenceGap: 0,
        countConfidenceGap: 0,
        sumExpectedRouteAdjustment: 0,
        countExpectedRouteAdjustment: 0,
        sumRoutedScore: 0,
        countRoutedScore: 0,
      },
      riskFitAgg: {
        rejectCount: 0,
        compressedCount: 0,
        breachAllowedCount: 0,
        sumOriginalRiskInr: 0,
        countOriginalRiskInr: 0,
        sumAdjustedRiskInr: 0,
        countAdjustedRiskInr: 0,
        sumBreachPct: 0,
        countBreachPct: 0,
      },
      alcTriggeredCount: 0,
      alcL1Count: 0,
      alcL2Count: 0,
      alcExitNowCount: 0,
      alcRetryCount: 0,
      alcRetryFailureCount: 0,
      alcAppliedConfirmedCount: 0,
      alcRequestedButNotAppliedCount: 0,
      alcSupersededCount: 0,
      alcAttributionLowConfidenceCount: 0,
      alcSavedRiskR: 0,
      alcSavedRiskInr: 0,
      alcBlockedCountByReason: {},
      alcActionByStrategy: {},
      alcActionByRegime: {},
      alcActionBySpreadRegime: {},
      alcSupersededBy: {},
      alcFinalProtectionOwner: {},
      alcFalsePositiveCandidates: 0,
    };
  }

  _rotateIfNeeded(now = new Date()) {
    const dk = dayKey(now);
    if (dk === this._state.dayKey) return;

    this.flush().catch((err) => { reportFault({ code: "TELEMETRY_TRADETELEMETRY_ASYNC", err, message: "[src/telemetry/tradeTelemetry.js] async task failed" }); });
    this._state = this._freshState(dk);
  }

  start() {
    if (!this._enabled) return;
    if (this._timer) return;

    if (Number.isFinite(this._flushSec) && this._flushSec > 0) {
      this._timer = setInterval(() => {
        this.flush().catch((err) => { reportFault({ code: "TELEMETRY_TRADETELEMETRY_ASYNC", err, message: "[src/telemetry/tradeTelemetry.js] async task failed" }); });
      }, this._flushSec * 1000);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _buildPostRouteStats() {
    const agg = this._state.postRouteAgg || {};
    return {
      hardBlockedCount: Number(agg.hardBlockedCount || 0),
      softPassCount: Number(agg.softPassCount || 0),
      avgConfidenceGap: avgMetric(
        Number(agg.sumConfidenceGap || 0),
        Number(agg.countConfidenceGap || 0),
      ),
      avgExpectedRouteAdjustment: avgMetric(
        Number(agg.sumExpectedRouteAdjustment || 0),
        Number(agg.countExpectedRouteAdjustment || 0),
      ),
      avgRoutedScore: avgMetric(
        Number(agg.sumRoutedScore || 0),
        Number(agg.countRoutedScore || 0),
      ),
    };
  }

  _buildRiskFitStats() {
    const agg = this._state.riskFitAgg || {};
    return {
      rejectCount: Number(agg.rejectCount || 0),
      compressedCount: Number(agg.compressedCount || 0),
      breachAllowedCount: Number(agg.breachAllowedCount || 0),
      avgOriginalRiskInr: avgMetric(
        Number(agg.sumOriginalRiskInr || 0),
        Number(agg.countOriginalRiskInr || 0),
      ),
      avgAdjustedRiskInr: avgMetric(
        Number(agg.sumAdjustedRiskInr || 0),
        Number(agg.countAdjustedRiskInr || 0),
      ),
      avgBreachPct: avgMetric(
        Number(agg.sumBreachPct || 0),
        Number(agg.countBreachPct || 0),
      ),
    };
  }

  _buildPlannerPathStats() {
    const agg = this._state.plannerPathAgg || {};
    return {
      countsByPath: { ...agg.countsByPath },
      acceptedByPath: { ...agg.acceptedByPath },
      blockedByPath: { ...agg.blockedByPath },
      fallbackReasonCounts: sortCountsDesc(agg.fallbackReasonCounts, 20),
      byStrategy: sortCountsDesc(agg.byStrategy, 20),
      byFamily: sortCountsDesc(agg.byFamily, 20),
    };
  }

  _applyDecisionAggregates(item = {}) {
    const out = safeKey(item?.outcome || "UNKNOWN", 40);
    const stg = safeKey(item?.stage || "unknown", 40);
    const rsn = safeKey(item?.reason || out, 140);
    const meta = item?.meta && typeof item.meta === "object" ? item.meta : {};

    if (out === "BLOCKED" || out === "ADJUSTED") {
      inc(this._state.blockerReasonsTop, rsn, 1);
    }

    if (stg === "signal" && rsn === "RECEIVED") {
      this._state.blockerFunnel.received += 1;
    }
    if (rsn === "PRE_ROUTE_LOW_CONFIDENCE") {
      this._state.blockerFunnel.blockedPreRouteConfidence += 1;
    }
    if (rsn === "POST_ROUTE_LOW_CONFIDENCE" && out === "BLOCKED") {
      this._state.blockerFunnel.blockedPostRouteConfidence += 1;
      this._state.postRouteAgg.hardBlockedCount += 1;
    }
    if (rsn === "POST_ROUTE_CONFIDENCE_SOFT_PASS" && out === "ADJUSTED") {
      this._state.blockerFunnel.softPassedPostRouteConfidence += 1;
      this._state.postRouteAgg.softPassCount += 1;
    }
    if (rsn === "MULTI_TF_TREND_TRANSITION_PASS" && out === "ADJUSTED") {
      this._state.blockerFunnel.multiTfTransitionPassed += 1;
    }
    if (stg === "planner" && out === "BLOCKED") {
      this._state.blockerFunnel.blockedPlanner += 1;
    }
    const plannerPath = normalizePlannerPath(meta?.plannerPathUsed);
    if (plannerPathObserved(item, plannerPath)) {
      inc(this._state.plannerPathAgg.countsByPath, plannerPath, 1);
      inc(
        this._state.plannerPathAgg.byStrategy,
        `${safeKey(meta?.strategyId || item?.strategyId || "UNKNOWN", 80)}|${plannerPath}`,
        1,
      );
      inc(
        this._state.plannerPathAgg.byFamily,
        `${safeKey(meta?.family || "UNKNOWN", 80)}|${plannerPath}`,
        1,
      );
      if (out === "BLOCKED") {
        inc(this._state.plannerPathAgg.blockedByPath, plannerPath, 1);
      } else {
        inc(this._state.plannerPathAgg.acceptedByPath, plannerPath, 1);
      }
      if (plannerPath === "LEGACY_FALLBACK" || plannerPath === "MIXED_ASSIST") {
        this._state.blockerFunnel.plannerFallbackCount += 1;
        const fallbackReason = optionalKey(
          meta?.plannerFallbackReason ||
            meta?.planFallbackReason ||
            meta?.fallbackReason,
          140,
        );
        if (fallbackReason) {
          inc(this._state.plannerPathAgg.fallbackReasonCounts, fallbackReason, 1);
        }
      }
    }
    if (String(meta?.readinessState || "").toUpperCase() === "BLOCKED_STALE") {
      this._state.blockerFunnel.readinessBlockedStale += 1;
    }
    if (String(meta?.readinessState || "").toUpperCase() === "BLOCKED_INCOMPLETE") {
      this._state.blockerFunnel.readinessBlockedIncomplete += 1;
    }
    if (stg === "risk_fit" && out === "BLOCKED") {
      this._state.blockerFunnel.blockedRiskFit += 1;
      this._state.riskFitAgg.rejectCount += 1;
    }
    if (stg === "risk_fit" && rsn === "COMPRESSED" && out === "ADJUSTED") {
      this._state.blockerFunnel.compressedRiskFit += 1;
      this._state.riskFitAgg.compressedCount += 1;
    }
    if (stg === "risk_fit" && rsn === "BREACH_ALLOWED" && out === "ADJUSTED") {
      this._state.blockerFunnel.breachAllowedRiskFit += 1;
      this._state.riskFitAgg.breachAllowedCount += 1;
    }
    if (stg === "entry" && rsn === "READY_FOR_EXECUTION") {
      this._state.blockerFunnel.readyForExecution += 1;
    }
    if (stg === "entry" && out === "ENTRY_PLACED") {
      this._state.blockerFunnel.entryPlaced += 1;
    }
    if (out === "BLOCKED") {
      inc(
        this._state.finalBlockerReasonByFamily,
        `${safeKey(meta?.family || "UNKNOWN", 80)}|${rsn}`,
        1,
      );
      inc(
        this._state.finalBlockerReasonByStrategy,
        `${safeKey(meta?.strategyId || item?.strategyId || "UNKNOWN", 80)}|${rsn}`,
        1,
      );
    }

    if (
      rsn === "POST_ROUTE_LOW_CONFIDENCE" ||
      rsn === "POST_ROUTE_CONFIDENCE_SOFT_PASS"
    ) {
      addMetric(
        this._state.postRouteAgg,
        "sumConfidenceGap",
        "countConfidenceGap",
        meta?.confidenceGap,
      );
      addMetric(
        this._state.postRouteAgg,
        "sumExpectedRouteAdjustment",
        "countExpectedRouteAdjustment",
        meta?.expectedRouteAdjustment,
      );
      addMetric(
        this._state.postRouteAgg,
        "sumRoutedScore",
        "countRoutedScore",
        meta?.routedScore ?? meta?.conf,
      );
    }

    if (stg === "risk_fit") {
      addMetric(
        this._state.riskFitAgg,
        "sumOriginalRiskInr",
        "countOriginalRiskInr",
        meta?.originalRiskInr,
      );
      addMetric(
        this._state.riskFitAgg,
        "sumAdjustedRiskInr",
        "countAdjustedRiskInr",
        meta?.adjustedRiskInr,
      );
      addMetric(
        this._state.riskFitAgg,
        "sumBreachPct",
        "countBreachPct",
        meta?.breachPct,
      );
    }
  }

  recordDecision({
    tradeId,
    signalId,
    strategyId,
    side,
    token,
    outcome,
    stage,
    reason,
    meta,
  }) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    const sid = safeKey(strategyId || "UNKNOWN", 80);
    const out = safeKey(outcome || "UNKNOWN", 40);
    const stg = safeKey(stage || "unknown", 40);
    const rsn = safeKey(reason || out, 140);
    const key = safeKey(`${stg}|${rsn}`, 220);

    this._state.updatedAt = new Date();
    this._state.decisionsTotal += 1;
    inc(this._state.decisionsByOutcome, out, 1);
    inc(this._state.decisionsByStage, stg, 1);
    inc(this._state.decisionsByReason, key, 1);

    const item = {
      ts: Date.now(),
      dayKey: this._state.dayKey,
      tradeId: String(tradeId || ""),
      signalId: signalId ? String(signalId) : null,
      strategyId: sid,
      side: side || null,
      token: Number.isFinite(Number(token)) ? Number(token) : null,
      outcome: out,
      stage: stg,
      reason: rsn,
      meta: safeMeta(meta),
    };
    this._applyDecisionAggregates(item);

    this._state.lastDecisions.push(item);
    if (this._state.lastDecisions.length > this._ringSize) {
      this._state.lastDecisions.splice(
        0,
        this._state.lastDecisions.length - this._ringSize,
      );
    }
  }

  recordTradeClose({
    tradeId,
    strategyId,
    side,
    closeReason,
    grossPnlInr,
    estCostInr,
    netAfterEstCostsInr,
    feeMultiple,
    alcAction = null,
    alcDesiredAction = null,
    alcTargetState = null,
    alcAppliedState = null,
    alcAppliedConfirmed = false,
    alcAppliedSource = null,
    alcAttributionConfidence = null,
    alcRequested = false,
    alcRequestedLevel = null,
    alcAppliedLevel = null,
    alcRequestedButNotApplied = false,
    alcAppliedButSuperseded = false,
    alcSupersededBy = null,
    alcFinalProtectionOwner = null,
    alcRetryCount = 0,
    alcSavedRiskR = null,
    alcSavedRiskInr = null,
    alcBlockedReason = null,
    alcFalsePositiveCandidate = false,
    regime = null,
    spreadRegime = null,
  }) {
    if (!this._enabled) return;
    this._rotateIfNeeded(new Date());

    this._state.updatedAt = new Date();
    this._state.tradesClosedTotal += 1;

    const sid = safeKey(strategyId || "UNKNOWN", 80);
    const rsn = safeKey(closeReason || "UNKNOWN", 140);
    const normalizedTargetState = normalizeAlcState(alcTargetState);
    const normalizedAppliedState = normalizeAlcState(alcAppliedState);
    const normalizedRequestedLevel = normalizeAlcState(
      alcRequestedLevel || normalizedTargetState,
    );
    const normalizedAppliedLevel = normalizeAlcState(
      alcAppliedLevel || normalizedAppliedState,
    );
    const normalizedAction = safeKey(
      alcAction || alcDesiredAction || normalizedRequestedLevel,
      40,
    );
    const alcTriggered =
      Boolean(alcRequested) ||
      normalizedRequestedLevel !== "NONE" ||
      normalizedAppliedLevel !== "NONE";
    const appliedConfirmed =
      Boolean(alcAppliedConfirmed) || normalizedAppliedLevel !== "NONE";

    inc(this._state.closedByStrategy, sid, 1);
    inc(this._state.closedByReason, rsn, 1);
    inc(this._state.feeMultipleBuckets, bucketFeeMultiple(feeMultiple), 1);
    if (alcTriggered) {
      this._state.alcTriggeredCount += 1;
      if (normalizedRequestedLevel === "L1" || normalizedAppliedLevel === "L1") {
        this._state.alcL1Count += 1;
      }
      if (normalizedRequestedLevel === "L2" || normalizedAppliedLevel === "L2") {
        this._state.alcL2Count += 1;
      }
      if (normalizedRequestedLevel === "EXIT" || normalizedAppliedLevel === "EXIT") {
        this._state.alcExitNowCount += 1;
      }
      if (appliedConfirmed) {
        this._state.alcAppliedConfirmedCount += 1;
      }
      if (alcRequestedButNotApplied) {
        this._state.alcRequestedButNotAppliedCount += 1;
      }
      if (alcAppliedButSuperseded) {
        this._state.alcSupersededCount += 1;
      }
      if (String(alcAttributionConfidence || "").trim().toUpperCase() === "LOW") {
        this._state.alcAttributionLowConfidenceCount += 1;
      }
      inc(this._state.alcActionByStrategy, `${sid}|${normalizedAction}`, 1);
      inc(this._state.alcActionByRegime, `${safeKey(regime || "UNKNOWN", 60)}|${normalizedAction}`, 1);
      inc(
        this._state.alcActionBySpreadRegime,
        `${safeKey(spreadRegime || "UNKNOWN", 60)}|${normalizedAction}`,
        1,
      );
      if (alcSupersededBy) {
        inc(this._state.alcSupersededBy, alcSupersededBy, 1);
      }
      if (alcFinalProtectionOwner) {
        inc(this._state.alcFinalProtectionOwner, alcFinalProtectionOwner, 1);
      }
    }
    if (Number.isFinite(Number(alcRetryCount)) && Number(alcRetryCount) > 0) {
      this._state.alcRetryCount += Number(alcRetryCount);
      if (normalizedAppliedState === "NONE") {
        this._state.alcRetryFailureCount += 1;
      }
    }
    if (alcBlockedReason) {
      inc(this._state.alcBlockedCountByReason, alcBlockedReason, 1);
    }
    if (Number.isFinite(Number(alcSavedRiskR))) {
      this._state.alcSavedRiskR += Number(alcSavedRiskR);
    }
    if (Number.isFinite(Number(alcSavedRiskInr))) {
      this._state.alcSavedRiskInr += Number(alcSavedRiskInr);
    }
    if (alcFalsePositiveCandidate) {
      this._state.alcFalsePositiveCandidates += 1;
    }

    const fm = Number(feeMultiple);
    if (Number.isFinite(fm)) {
      this._state.sumFeeMultiple += fm;
      this._state.countFeeMultiple += 1;
    }

    const g = Number(grossPnlInr ?? 0);
    const c = Number(estCostInr ?? 0);
    const n = Number(netAfterEstCostsInr ?? 0);
    if (Number.isFinite(g)) this._state.sumGrossPnlInr += g;
    if (Number.isFinite(c)) this._state.sumEstCostsInr += c;
    if (Number.isFinite(n)) this._state.sumNetAfterEstCostsInr += n;

    const item = {
      ts: Date.now(),
      dayKey: this._state.dayKey,
      tradeId: String(tradeId || ""),
      strategyId: sid,
      side: side || null,
      closeReason: rsn,
      grossPnlInr: Number.isFinite(g) ? g : null,
      estCostInr: Number.isFinite(c) ? c : null,
      netAfterEstCostsInr: Number.isFinite(n) ? n : null,
      feeMultiple: Number.isFinite(fm) ? fm : null,
      alcAction: alcTriggered ? normalizedAction : null,
      alcTargetState: alcTriggered ? normalizedTargetState : null,
      alcAppliedState: alcTriggered ? normalizedAppliedLevel : null,
      alcAppliedConfirmed: alcTriggered ? appliedConfirmed : false,
      alcAppliedSource:
        alcTriggered && alcAppliedSource
          ? safeKey(alcAppliedSource, 40)
          : null,
      alcAttributionConfidence:
        alcTriggered && alcAttributionConfidence
          ? safeKey(alcAttributionConfidence, 20)
          : null,
      alcRequested: alcTriggered ? Boolean(alcRequested) : false,
      alcRequestedLevel: alcTriggered ? normalizedRequestedLevel : null,
      alcRequestedButNotApplied:
        alcTriggered ? Boolean(alcRequestedButNotApplied) : false,
      alcAppliedButSuperseded:
        alcTriggered ? Boolean(alcAppliedButSuperseded) : false,
      alcSupersededBy:
        alcTriggered && alcSupersededBy ? safeKey(alcSupersededBy, 60) : null,
      alcFinalProtectionOwner:
        alcTriggered && alcFinalProtectionOwner
          ? safeKey(alcFinalProtectionOwner, 60)
          : null,
      alcRetryCount:
        Number.isFinite(Number(alcRetryCount)) && Number(alcRetryCount) > 0
          ? Number(alcRetryCount)
          : 0,
      alcSavedRiskR: Number.isFinite(Number(alcSavedRiskR))
        ? Number(alcSavedRiskR)
        : null,
      alcSavedRiskInr: Number.isFinite(Number(alcSavedRiskInr))
        ? Number(alcSavedRiskInr)
        : null,
      alcBlockedReason: alcBlockedReason ? safeKey(alcBlockedReason, 80) : null,
      regime: regime ? safeKey(regime, 60) : null,
      spreadRegime: spreadRegime ? safeKey(spreadRegime, 60) : null,
    };

    this._state.lastTrades.push(item);
    if (this._state.lastTrades.length > this._ringSize) {
      this._state.lastTrades.splice(
        0,
        this._state.lastTrades.length - this._ringSize
      );
    }
  }

  snapshot() {
    const s = this._state;
    const avgFeeMultiple =
      s.countFeeMultiple > 0 ? s.sumFeeMultiple / s.countFeeMultiple : null;

    return {
      enabled: this._enabled,
      dayKey: s.dayKey,
      tz: s.tz,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      tradesClosedTotal: s.tradesClosedTotal,
      closedByStrategy: s.closedByStrategy,
      closedByReason: s.closedByReason,
      feeMultipleBuckets: s.feeMultipleBuckets,
      avgFeeMultiple,
      sumGrossPnlInr: s.sumGrossPnlInr,
      sumEstCostsInr: s.sumEstCostsInr,
      sumNetAfterEstCostsInr: s.sumNetAfterEstCostsInr,
      lastTrades: s.lastTrades.slice(-50),
      decisionsTotal: s.decisionsTotal,
      decisionsByOutcome: s.decisionsByOutcome,
      decisionsByStage: s.decisionsByStage,
      decisionsByReason: s.decisionsByReason,
      blockerFunnel: { ...s.blockerFunnel },
      blockerReasonsTop: sortCountsDesc(s.blockerReasonsTop, 10),
      finalBlockerReasonByFamily: sortCountsDesc(s.finalBlockerReasonByFamily, 10),
      finalBlockerReasonByStrategy: sortCountsDesc(s.finalBlockerReasonByStrategy, 10),
      plannerPathStats: this._buildPlannerPathStats(),
      postRouteStats: this._buildPostRouteStats(),
      riskFitStats: this._buildRiskFitStats(),
      alcSummary: {
        triggeredCount: Number(s.alcTriggeredCount || 0),
        l1Count: Number(s.alcL1Count || 0),
        l2Count: Number(s.alcL2Count || 0),
        exitNowCount: Number(s.alcExitNowCount || 0),
        retryCount: Number(s.alcRetryCount || 0),
        retryFailureCount: Number(s.alcRetryFailureCount || 0),
        appliedConfirmedCount: Number(s.alcAppliedConfirmedCount || 0),
        requestedButNotAppliedCount: Number(
          s.alcRequestedButNotAppliedCount || 0,
        ),
        supersededCount: Number(s.alcSupersededCount || 0),
        attributionLowConfidenceCount: Number(
          s.alcAttributionLowConfidenceCount || 0,
        ),
        savedRiskR: Number(s.alcSavedRiskR || 0),
        savedRiskInr: Number(s.alcSavedRiskInr || 0),
        blockedCountByReason: sortCountsDesc(s.alcBlockedCountByReason, 10),
        falsePositiveCandidates: Number(s.alcFalsePositiveCandidates || 0),
        actionByStrategy: sortCountsDesc(s.alcActionByStrategy, 20),
        actionByRegime: sortCountsDesc(s.alcActionByRegime, 20),
        actionBySpreadRegime: sortCountsDesc(s.alcActionBySpreadRegime, 20),
        supersededBy: sortCountsDesc(s.alcSupersededBy, 20),
        finalProtectionOwner: sortCountsDesc(s.alcFinalProtectionOwner, 20),
      },
      lastDecisions: s.lastDecisions.slice(-50),
    };
  }

  _nextMongoBackoffMs() {
    this._mongoBackoffMs = this._mongoBackoffMs
      ? Math.min(this._mongoBackoffMs * 2, 15_000)
      : 1_000;
    this._mongoNextFlushAt = Date.now() + this._mongoBackoffMs;
    return this._mongoBackoffMs;
  }

  _markMongoFlushRecovered() {
    if (!this._mongoDegraded) {
      this._mongoBackoffMs = 0;
      this._mongoNextFlushAt = 0;
      return;
    }
    this._mongoDegraded = false;
    this._mongoBackoffMs = 0;
    this._mongoNextFlushAt = 0;
    markMongoHealthy();
    logger.info("[tradeTelemetry] mongo recovered; flush resumed");
  }

  _deferMongoFlush(error) {
    const backoffMs = this._nextMongoBackoffMs();
    this._mongoDegraded = true;
    markMongoDegraded({
      error,
      reason: "trade_telemetry_flush",
    });
    reportWindowedFault({
      windowKey: "trade_telemetry_mongo_degraded",
      windowMs: 30_000,
      code: "TRADE_TELEMETRY_MONGO_DEGRADED",
      err: error,
      message: "[tradeTelemetry] mongo degraded; flush deferred",
      meta: { backoffMs },
    });
    return { ok: false, reason: "mongo_degraded", deferredMs: backoffMs };
  }

  async flush() {
    if (!this._enabled) return { ok: false, reason: "disabled" };
    this._rotateIfNeeded(new Date());
    if (this._mongoNextFlushAt && Date.now() < this._mongoNextFlushAt) {
      return {
        ok: false,
        reason: "mongo_backoff",
        deferredMs: Math.max(0, this._mongoNextFlushAt - Date.now()),
      };
    }

    let db;
    try {
      db = getDb();
    } catch {
      return { ok: false, reason: "db_not_ready" };
    }

    const snapshot = this.snapshot();
    const doc = {
      ...snapshot,
      lastTrades: this._state.lastTrades.slice(-200),
      lastDecisions: this._state.lastDecisions.slice(-200),
      updatedAt: new Date(),
    };

    try {
      const col = db.collection(this._dailyCollection);
      await col.updateOne(
        { dayKey: doc.dayKey },
        { $set: doc, $setOnInsert: { createdAt: new Date() } },
        { upsert: true }
      );
      this._markMongoFlushRecovered();
      return { ok: true, dayKey: doc.dayKey };
    } catch (e) {
      if (isTransientMongoError(e)) {
        return this._deferMongoFlush(e);
      }
      logger.warn({ e: e?.message || String(e) }, "[tradeTelemetry] flush failed");
      return { ok: false, reason: "flush_failed", error: e?.message };
    }
  }
  async readDailyFromDb(dk) {
    let db;
    try {
      db = getDb();
    } catch {
      return null;
    }
    const day = safeKey(dk || this._state.dayKey, 20);
    try {
      const col = db.collection(this._dailyCollection);
      return await col.findOne({ dayKey: day });
    } catch {
      return null;
    }
  }

}

const tradeTelemetry = new TradeTelemetry();

module.exports = { TradeTelemetry, tradeTelemetry };
