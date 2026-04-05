"use strict";

function computeRawSlipBps(expected, avg) {
  const exp = Number(expected);
  const fill = Number(avg);
  if (!(exp > 0) || !(fill > 0)) return 0;
  return ((fill - exp) / exp) * 10000;
}

function computeAdverseSlipBps(side, expected, avg) {
  const raw = computeRawSlipBps(expected, avg);
  const normalizedSide = String(side || "BUY").toUpperCase();
  if (normalizedSide === "BUY") return Math.max(0, raw);
  if (normalizedSide === "SELL") return Math.max(0, -raw);
  return Math.max(0, raw);
}

function computeFavorableSlipBps(side, expected, avg) {
  const raw = computeRawSlipBps(expected, avg);
  const normalizedSide = String(side || "BUY").toUpperCase();
  if (normalizedSide === "BUY") return Math.max(0, -raw);
  if (normalizedSide === "SELL") return Math.max(0, raw);
  return 0;
}

function isFillAtOrBetterThanLimit({
  entryType,
  entrySide,
  avgFillPrice,
  submittedLimitPrice,
}) {
  const normalizedType = String(entryType || "").toUpperCase();
  if (normalizedType !== "LIMIT") return false;

  const avg = Number(avgFillPrice);
  const limit = Number(submittedLimitPrice);
  if (!(avg > 0) || !(limit > 0)) return false;

  const normalizedSide = String(entrySide || "BUY").toUpperCase();
  if (normalizedSide === "BUY") return avg <= limit;
  if (normalizedSide === "SELL") return avg >= limit;
  return false;
}

function evaluateEntrySlippageGuard({
  entrySide,
  entryType,
  expectedPrice,
  avgFillPrice,
  submittedLimitPrice,
  thresholdBps,
  guardForLimit = true,
}) {
  const normalizedSide = String(entrySide || "BUY").toUpperCase();
  const normalizedType = String(entryType || "MARKET").toUpperCase();
  const rawSlipBps = computeRawSlipBps(expectedPrice, avgFillPrice);
  const adverseSlipBps = computeAdverseSlipBps(
    normalizedSide,
    expectedPrice,
    avgFillPrice,
  );
  const favorableSlipBps = computeFavorableSlipBps(
    normalizedSide,
    expectedPrice,
    avgFillPrice,
  );
  const threshold = Number.isFinite(Number(thresholdBps))
    ? Number(thresholdBps)
    : 0;
  const isAtOrBetterThanLimit = isFillAtOrBetterThanLimit({
    entryType: normalizedType,
    entrySide: normalizedSide,
    avgFillPrice,
    submittedLimitPrice,
  });
  const guardEnabled = normalizedType === "MARKET" || Boolean(guardForLimit);

  let triggered = false;
  let reason = "within adverse threshold";

  if (!(Number(expectedPrice) > 0) || !(Number(avgFillPrice) > 0)) {
    reason = "missing price inputs";
  } else if (!guardEnabled && normalizedType === "LIMIT") {
    reason = "limit slippage guard disabled";
  } else if (isAtOrBetterThanLimit) {
    reason = "LIMIT fill at-or-better than submitted price";
  } else if (favorableSlipBps > 0) {
    reason = "favorable slippage";
  } else if (adverseSlipBps > threshold) {
    triggered = true;
    reason =
      normalizedSide === "SELL"
        ? "SELL fill worse than expected beyond threshold"
        : "BUY fill worse than expected beyond threshold";
  }

  return {
    rawSlipBps,
    adverseSlipBps,
    favorableSlipBps,
    thresholdBps: threshold,
    isAtOrBetterThanLimit,
    guardEnabled,
    triggered,
    reason,
  };
}

module.exports = {
  computeRawSlipBps,
  computeAdverseSlipBps,
  computeFavorableSlipBps,
  isFillAtOrBetterThanLimit,
  evaluateEntrySlippageGuard,
};
