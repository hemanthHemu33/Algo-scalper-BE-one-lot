const RETRY_STATE = new Map();

function numeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalize(value, fallback = "UNKNOWN") {
  const out = String(value || "")
    .trim()
    .toUpperCase();
  return out || fallback;
}

function zoneFromLevel(level, atrValue, zoneAtr) {
  const lvl = Number(level);
  const atr = Math.max(0.01, Number(atrValue || 0));
  const width = Math.max(0.05, atr * Math.max(0.1, Number(zoneAtr || 0.35)));
  if (!Number.isFinite(lvl)) return "NA";
  return `${Math.round(lvl / width)}@${width.toFixed(2)}`;
}

function isFragileState(marketState) {
  const state = normalize(marketState, "");
  return (
    state === "TREND_COMPRESSED" ||
    state === "BREAKOUT_WATCH" ||
    state === "FAILED_BREAKOUT" ||
    state === "RANGE_CHOP" ||
    state === "TRAP_RISK_HIGH" ||
    state === "NO_TRADE"
  );
}

function cleanupEntryFailures(entry, lookbackMs, nowTs) {
  const cutoff = nowTs - lookbackMs;
  entry.failures = (entry.failures || []).filter((ts) => Number(ts) >= cutoff);
}

function buildRetryKey({
  token,
  intervalMin,
  side,
  thesisFamily,
  levelZone,
}) {
  if (!Number.isFinite(Number(token)) || !Number.isFinite(Number(intervalMin))) return null;
  return [
    Number(token),
    Number(intervalMin),
    normalize(side, "BUY"),
    normalize(thesisFamily, "GENERIC"),
    String(levelZone || "NA"),
  ].join(":");
}

function evaluateRetryGovernor({
  candidate = null,
  context = {},
  levelAcceptance = null,
  marketState = null,
  nowTs = Date.now(),
  env = {},
}) {
  const enabled =
    String(env.THESIS_RETRY_GOVERNOR_ENABLED ?? "true") === "true";
  const token = Number(context?.instrument_token);
  const intervalMin = Number(context?.intervalMin ?? 1);
  const side = normalize(candidate?.side, "BUY");
  const thesisFamily =
    candidate?.strategyFamily || candidate?.strategyStyle || candidate?.strategyId || "GENERIC";
  const levelZone = zoneFromLevel(
    levelAcceptance?.nearestKeyLevel || candidate?.meta?.triggerLevel || candidate?.meta?.anchorValue,
    levelAcceptance?.acceptanceMeta?.atrValue || candidate?.meta?.atr || 0,
    env.THESIS_RETRY_ZONE_ATR,
  );
  const key = buildRetryKey({
    token,
    intervalMin,
    side,
    thesisFamily,
    levelZone,
  });
  if (!enabled || !key) {
    return {
      blocked: false,
      key,
      failureCount: 0,
      blockedUntil: null,
      reasonCode: null,
      state: "DISABLED",
    };
  }

  const lookbackMin = Math.max(1, numeric(env.THESIS_RETRY_LOOKBACK_MIN, 35));
  const maxFailures = Math.max(1, numeric(env.THESIS_RETRY_MAX_FAILURES, 2));
  const blockMin = Math.max(1, numeric(env.THESIS_RETRY_BLOCK_MINUTES, 18));
  const lookbackMs = lookbackMin * 60_000;
  const blockMs = blockMin * 60_000;

  const entry = RETRY_STATE.get(key) || {
    failures: [],
    blockedUntil: 0,
  };
  cleanupEntryFailures(entry, lookbackMs, nowTs);

  const fragileState = isFragileState(marketState);
  const rejectionDrivenFailure =
    levelAcceptance?.breakoutRejected === true ||
    levelAcceptance?.repeatedRejectionDetected === true;
  if (fragileState && rejectionDrivenFailure) {
    entry.failures.push(Number(nowTs));
  }

  const inCooldown = Number(entry.blockedUntil || 0) > Number(nowTs);
  if (!inCooldown && fragileState && entry.failures.length >= maxFailures) {
    entry.blockedUntil = Number(nowTs) + blockMs;
  }
  RETRY_STATE.set(key, entry);

  const blocked = Number(entry.blockedUntil || 0) > Number(nowTs);
  return {
    blocked,
    key,
    failureCount: entry.failures.length,
    blockedUntil: blocked ? new Date(entry.blockedUntil).toISOString() : null,
    reasonCode: blocked ? "RETRY_GOVERNOR_BLOCK" : null,
    state: blocked ? "BLOCKED" : fragileState ? "TRACKING" : "IDLE",
  };
}

function resetRetryGovernor() {
  RETRY_STATE.clear();
}

function getRetryGovernorSnapshot() {
  return Array.from(RETRY_STATE.entries()).map(([key, value]) => ({
    key,
    failures: Array.isArray(value?.failures) ? value.failures.slice() : [],
    blockedUntil: Number(value?.blockedUntil || 0) || null,
  }));
}

module.exports = {
  evaluateRetryGovernor,
  resetRetryGovernor,
  getRetryGovernorSnapshot,
};
