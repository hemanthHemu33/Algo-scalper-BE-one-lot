const { DateTime } = require("luxon");
const { buildBoundsForToday, getSessionForDateTime } = require("../market/marketCalendar");

function addIssue(issues, severity, code, message, sample = null) {
  issues.push({
    severity,
    code,
    message,
    sample,
  });
}

function isoDay(value, timezone) {
  return DateTime.fromJSDate(new Date(value), { zone: timezone }).toFormat("yyyy-LL-dd");
}

function expectedSessionTimestamps({ from, to, intervalMin, timezone }) {
  const out = [];
  let cursor = DateTime.fromJSDate(new Date(from), { zone: timezone }).startOf("day");
  const end = DateTime.fromJSDate(new Date(to), { zone: timezone }).startOf("day");
  while (cursor <= end) {
    const sessionRef = cursor.set({ hour: 12, minute: 0 });
    const session = getSessionForDateTime(sessionRef);
    if (session.allowTradingDay) {
      const { open, close } = buildBoundsForToday(session, sessionRef);
      if (open?.isValid && close?.isValid) {
        let bucket = open;
        while (bucket < close) {
          out.push(bucket.toISO());
          bucket = bucket.plus({ minutes: intervalMin });
        }
      }
    }
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

function summarizeIssues(issues) {
  const summary = {
    totalIssues: issues.length,
    info: 0,
    warn: 0,
    fail: 0,
    byCode: {},
    hardFail: false,
  };
  for (const issue of issues) {
    summary[issue.severity] += 1;
    summary.byCode[issue.code] = (summary.byCode[issue.code] || 0) + 1;
  }
  summary.hardFail = summary.fail > 0;
  return summary;
}

function sampleIssues(issues, limit = 50) {
  return issues.slice(0, limit);
}

function validateInstrumentMetadata(issues, instrument, tokenLabel) {
  if (instrument) return;
  addIssue(issues, "fail", "MISSING_INSTRUMENT_METADATA", `Instrument metadata missing for ${tokenLabel}`, {
    token: tokenLabel,
  });
}

function buildUnderlyingContinuityByDay({ candles = [], intervalMin, timezone, range }) {
  const expected = expectedSessionTimestamps({
    from: range.from,
    to: range.to,
    intervalMin,
    timezone,
  });
  const expectedByDay = new Map();
  for (const isoTs of expected) {
    const day = isoDay(isoTs, timezone);
    if (!expectedByDay.has(day)) expectedByDay.set(day, []);
    expectedByDay.get(day).push(isoTs);
  }

  const dayStats = new Map();
  for (const candle of candles) {
    const day = isoDay(candle.ts, timezone);
    if (!dayStats.has(day)) {
      dayStats.set(day, {
        day,
        actualBars: 0,
        duplicateBars: 0,
        sessionViolations: 0,
        gapCount: 0,
        firstTs: null,
        lastTs: null,
        actualSet: new Set(),
      });
    }
    const row = dayStats.get(day);
    const tsIso = new Date(candle.ts).toISOString();
    if (row.actualSet.has(tsIso)) row.duplicateBars += 1;
    row.actualSet.add(tsIso);
    row.actualBars += 1;
    row.firstTs = row.firstTs || tsIso;
    row.lastTs = tsIso;
  }

  const ordered = [...candles].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const intervalMs = Number(intervalMin) * 60 * 1000;
  for (let index = 1; index < ordered.length; index += 1) {
    const prev = ordered[index - 1];
    const candle = ordered[index];
    const prevDt = DateTime.fromJSDate(new Date(prev.ts), { zone: timezone });
    const dt = DateTime.fromJSDate(new Date(candle.ts), { zone: timezone });
    const prevMs = prevDt.toMillis();
    const nowMs = dt.toMillis();
    if (prevDt.toFormat("yyyy-LL-dd") === dt.toFormat("yyyy-LL-dd") && nowMs - prevMs > intervalMs) {
      const row = dayStats.get(dt.toFormat("yyyy-LL-dd"));
      if (row) row.gapCount += 1;
    }

    const closeTs = dt.plus({ minutes: intervalMin });
    const session = getSessionForDateTime(closeTs);
    const { open, close } = buildBoundsForToday(session, closeTs);
    const inSession =
      session.allowTradingDay &&
      open?.isValid &&
      close?.isValid &&
      closeTs.toMillis() >= open.toMillis() &&
      closeTs.toMillis() <= close.toMillis();
    if (!inSession) {
      const row = dayStats.get(dt.toFormat("yyyy-LL-dd"));
      if (row) row.sessionViolations += 1;
    }
  }

  const days = Array.from(new Set([...expectedByDay.keys(), ...dayStats.keys()])).sort();
  return days.map((day) => {
    const stats = dayStats.get(day) || {
      day,
      actualBars: 0,
      duplicateBars: 0,
      sessionViolations: 0,
      gapCount: 0,
      firstTs: null,
      lastTs: null,
      actualSet: new Set(),
    };
    const expectedRows = expectedByDay.get(day) || [];
    const missingBars = expectedRows.filter((tsIso) => !stats.actualSet.has(new Date(tsIso).toISOString())).length;
    const expectedBars = expectedRows.length;
    return {
      day,
      expectedBars,
      actualBars: stats.actualBars,
      missingBars,
      duplicateBars: stats.duplicateBars,
      gapCount: stats.gapCount,
      sessionViolations: stats.sessionViolations,
      continuityPct: expectedBars > 0 ? ((expectedBars - missingBars) / expectedBars) * 100 : 0,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
    };
  });
}

function validateCandleSeries({ issues, candles = [], intervalMin, timezone, tokenLabel, range }) {
  const intervalMs = Math.max(1, Number(intervalMin)) * 60 * 1000;
  const seen = new Set();
  const ordered = [...candles].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  for (let index = 0; index < ordered.length; index += 1) {
    const candle = ordered[index];
    const iso = new Date(candle?.ts).toISOString();
    const ts = new Date(candle?.ts).getTime();
    const dt = DateTime.fromJSDate(new Date(candle?.ts), { zone: timezone });

    if (seen.has(iso)) {
      addIssue(issues, "fail", "DUPLICATE_TIMESTAMP", `Duplicate timestamp detected for ${tokenLabel}`, {
        token: tokenLabel,
        ts: candle?.ts || null,
      });
    } else {
      seen.add(iso);
    }

    if (!dt.isValid || dt.second !== 0 || dt.millisecond !== 0 || dt.minute % intervalMin !== 0) {
      addIssue(issues, "fail", "INTERVAL_ALIGNMENT", `Misaligned candle detected for ${tokenLabel}`, {
        token: tokenLabel,
        ts: candle?.ts || null,
      });
    }

    const closeTs = dt.plus({ minutes: intervalMin });
    const session = getSessionForDateTime(closeTs);
    const { open, close } = buildBoundsForToday(session, closeTs);
    const inSession =
      session.allowTradingDay &&
      open?.isValid &&
      close?.isValid &&
      closeTs.toMillis() >= open.toMillis() &&
      closeTs.toMillis() <= close.toMillis();
    if (!inSession) {
      addIssue(issues, "fail", "OUT_OF_SESSION", `Out-of-session candle detected for ${tokenLabel}`, {
        token: tokenLabel,
        ts: candle?.ts || null,
        dayKey: session.dayKey,
      });
    }

    if (index === 0) continue;
    const prev = ordered[index - 1];
    const prevTs = new Date(prev?.ts).getTime();
    const diff = ts - prevTs;
    if (!Number.isFinite(ts) || !Number.isFinite(prevTs) || diff <= 0) {
      addIssue(issues, "fail", "NON_MONOTONIC_TIMESTAMP", `Non-monotonic timestamps detected for ${tokenLabel}`, {
        token: tokenLabel,
        prevTs: prev?.ts || null,
        ts: candle?.ts || null,
      });
      continue;
    }
    const prevDt = DateTime.fromJSDate(new Date(prev.ts), { zone: timezone });
    if (prevDt.toFormat("yyyy-LL-dd") === dt.toFormat("yyyy-LL-dd") && diff > intervalMs) {
      addIssue(issues, "warn", "INTRA_SESSION_GAP", `Intra-session gap detected for ${tokenLabel}`, {
        token: tokenLabel,
        prevTs: prev?.ts || null,
        ts: candle?.ts || null,
        gapMs: diff - intervalMs,
      });
    }
  }

  if (range?.from && range?.to) {
    const continuityByDay = buildUnderlyingContinuityByDay({ candles: ordered, intervalMin, timezone, range });
    for (const dayRow of continuityByDay) {
      if (dayRow.missingBars > 0) {
        addIssue(issues, "warn", "MISSING_RANGE_CANDLE", `Missing candles detected for ${tokenLabel} on ${dayRow.day}`, {
          token: tokenLabel,
          day: dayRow.day,
          missingBars: dayRow.missingBars,
          expectedBars: dayRow.expectedBars,
        });
      }
    }
  }
}

function validateOptionSelections(issues, optionProvider, selections = [], timezone, { lookAheadGuard = true } = {}) {
  for (const selection of selections || []) {
    if (!selection?.selectedContractToken) {
      addIssue(issues, "fail", "MISSING_OPTION_CONTRACT", "Selected signal has no option contract", selection);
      continue;
    }
    const optionCandle = optionProvider?.getCandleAtTs?.(selection.selectedContractToken, selection.ts);
    if (!optionCandle) {
      addIssue(issues, "fail", "MISSING_OPTION_CANDLE", "Option candle missing at selected timestamp", selection);
    }
    if (!selection.selectedInstrument) {
      addIssue(issues, "fail", "MISSING_OPTION_METADATA", "Selected option contract has no metadata", selection);
    }
    if (selection.selectedExpiry) {
      const signalDt = DateTime.fromJSDate(new Date(selection.ts), { zone: timezone });
      const expiryDt = DateTime.fromJSDate(new Date(selection.selectedExpiry), { zone: timezone });
      if (signalDt.isValid && expiryDt.isValid && expiryDt.endOf("day") < signalDt.startOf("minute")) {
        addIssue(
          issues,
          "fail",
          "CONTRACT_EXPIRY_SANITY",
          "Selected contract expiry is earlier than the signal timestamp",
          selection,
        );
      }
    }
    if (
      lookAheadGuard &&
      selection.usedCandleTs &&
      new Date(selection.usedCandleTs).getTime() > new Date(selection.ts).getTime()
    ) {
      addIssue(issues, "fail", "LOOK_AHEAD_GUARD", "Selected option candle appears to come from the future", selection);
    }
  }
}

function buildOptionCoverageByDay({ optionProvider, signalSelections = [], range, timezone }) {
  if (!optionProvider?.ready) {
    return {
      rows: [],
      summary: {
        optionTokens: 0,
        tokensWithCandles: 0,
        tokensWithoutCandles: 0,
        thinTokens: 0,
        contractAvailabilityPct: 0,
      },
    };
  }

  const instruments = optionProvider.listInstruments?.() || [];
  const tokens = optionProvider.listTokens?.() || [];
  const rowsByDay = new Map();

  let tokensWithCandles = 0;
  let thinTokens = 0;
  for (const token of tokens) {
    const candles = optionProvider.getCandlesByToken?.(token) || [];
    if (candles.length > 0) tokensWithCandles += 1;
    if (candles.length > 0 && candles.length < 10) thinTokens += 1;
    for (const candle of candles) {
      const day = isoDay(candle.ts, timezone);
      if (!rowsByDay.has(day)) {
        rowsByDay.set(day, {
          day,
          contractsWithCandles: new Set(),
          candleCount: 0,
          selectedSignals: 0,
          selectedContractsMissing: 0,
        });
      }
      const row = rowsByDay.get(day);
      row.contractsWithCandles.add(Number(token));
      row.candleCount += 1;
    }
  }

  for (const selection of signalSelections || []) {
    const day = isoDay(selection.ts, timezone);
    if (!rowsByDay.has(day)) {
      rowsByDay.set(day, {
        day,
        contractsWithCandles: new Set(),
        candleCount: 0,
        selectedSignals: 0,
        selectedContractsMissing: 0,
      });
    }
    const row = rowsByDay.get(day);
    row.selectedSignals += 1;
    if (!selection.selectedContractToken || !optionProvider.getCandleAtTs?.(selection.selectedContractToken, selection.ts)) {
      row.selectedContractsMissing += 1;
    }
  }

  const rows = Array.from(rowsByDay.values())
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((row) => ({
      day: row.day,
      contractsWithCandles: row.contractsWithCandles.size,
      candleCount: row.candleCount,
      selectedSignals: row.selectedSignals,
      selectedContractsMissing: row.selectedContractsMissing,
      coveragePct: row.selectedSignals > 0 ? ((row.selectedSignals - row.selectedContractsMissing) / row.selectedSignals) * 100 : 100,
    }));

  const fromMs = new Date(range?.from).getTime();
  const toMs = new Date(range?.to).getTime();
  const contractsInRange = instruments.filter((instrument) => {
    const expiry = instrument?.expiry ? new Date(instrument.expiry).getTime() : Number.NaN;
    return !Number.isFinite(expiry) || expiry >= fromMs || expiry >= toMs;
  });

  return {
    rows,
    summary: {
      optionTokens: tokens.length,
      tokensWithCandles,
      tokensWithoutCandles: Math.max(0, tokens.length - tokensWithCandles),
      thinTokens,
      candidateContractsInRange: contractsInRange.length,
      contractAvailabilityPct: tokens.length > 0 ? (tokensWithCandles / tokens.length) * 100 : 0,
      duplicateTimestampCount: Number(optionProvider.stats?.duplicateTimestampCount || 0),
    },
  };
}

function buildUnderlyingCoverageSummary(continuityByDay = [], candles = []) {
  const expectedBars = continuityByDay.reduce((acc, row) => acc + Number(row.expectedBars || 0), 0);
  const actualBars = candles.length;
  const missingBars = continuityByDay.reduce((acc, row) => acc + Number(row.missingBars || 0), 0);
  return {
    dayCount: continuityByDay.length,
    totalCandles: actualBars,
    expectedBars,
    missingBars,
    continuityPct: expectedBars > 0 ? ((expectedBars - missingBars) / expectedBars) * 100 : 0,
  };
}

function validateBacktestData({
  candles = [],
  intervalMin,
  timezone,
  range,
  underlyingToken,
  tokenInstrument,
  optionProvider = null,
  signalSelections = [],
  lookAheadGuard = true,
}) {
  const issues = [];
  validateInstrumentMetadata(issues, tokenInstrument, underlyingToken);
  validateCandleSeries({
    issues,
    candles,
    intervalMin,
    timezone,
    tokenLabel: underlyingToken,
    range,
  });

  const continuityByDay = buildUnderlyingContinuityByDay({
    candles: [...candles].sort((a, b) => new Date(a.ts) - new Date(b.ts)),
    intervalMin,
    timezone,
    range,
  });

  if (!candles.length) {
    addIssue(issues, "fail", "EMPTY_UNDERLYING_DATASET", "Underlying dataset is empty", {
      token: underlyingToken,
    });
  }

  const optionCoverage = buildOptionCoverageByDay({
    optionProvider,
    signalSelections,
    range,
    timezone,
  });

  if (optionProvider?.ready) {
    if (Number(optionProvider.stats?.duplicateTimestampCount || 0) > 0) {
      addIssue(issues, "fail", "OPTION_DUPLICATE_TIMESTAMP", "Duplicate option timestamps detected in provider load", {
        duplicateTimestampCount: optionProvider.stats.duplicateTimestampCount,
      });
    }
    if (!(Number(optionCoverage.summary.optionTokens || 0) > 0)) {
      addIssue(issues, "fail", "EMPTY_OPTION_DATASET", "No option contracts were available for the selected range", null);
    }
    if (!(Number(optionCoverage.summary.tokensWithCandles || 0) > 0)) {
      addIssue(issues, "fail", "EMPTY_OPTION_CANDLES", "Option dataset contains no candles in the selected range", null);
    }
    if (Number(optionCoverage.summary.thinTokens || 0) > 0) {
      addIssue(issues, "warn", "THIN_OPTION_DATASET", "Some option contracts have too few candles for reliable replay", {
        thinTokens: optionCoverage.summary.thinTokens,
      });
    }
    for (const row of optionCoverage.rows) {
      if (row.selectedContractsMissing > 0) {
        addIssue(issues, "warn", "OPTION_DAY_COVERAGE_GAP", `Option coverage gaps detected on ${row.day}`, row);
      }
    }
  }

  if (signalSelections?.length) {
    validateOptionSelections(issues, optionProvider, signalSelections, timezone, { lookAheadGuard });
  }

  const summary = summarizeIssues(issues);
  return {
    generatedAt: new Date().toISOString(),
    hardFail: summary.hardFail,
    settings: {
      lookAheadGuardEnabled: Boolean(lookAheadGuard),
    },
    summary,
    underlyingCoverage: buildUnderlyingCoverageSummary(continuityByDay, candles),
    continuityByDay,
    optionCoverageByDay: optionCoverage.rows,
    optionDatasetSummary: optionCoverage.summary,
    issues,
    samples: sampleIssues(issues),
  };
}

function hasHardFailures(report) {
  return Boolean(report?.hardFail || Number(report?.summary?.fail || 0) > 0);
}

module.exports = {
  addIssue,
  buildOptionCoverageByDay,
  buildUnderlyingContinuityByDay,
  expectedSessionTimestamps,
  hasHardFailures,
  sampleIssues,
  summarizeIssues,
  validateBacktestData,
  validateCandleSeries,
  validateInstrumentMetadata,
  validateOptionSelections,
};
