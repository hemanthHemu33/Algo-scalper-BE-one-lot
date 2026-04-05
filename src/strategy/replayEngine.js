const { env } = require("../config");
const { enabledStrategyIds } = require("./registry");
const {
  evaluateSignalSetFromCandles,
  resetSignalLayerState,
} = require("./strategyEngine");

function enabledIntervals() {
  return String(env.SIGNAL_INTERVALS || "1")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function evaluateSignalSetOnCandles({
  candles,
  intervalMin,
  instrument_token = null,
  now = new Date(),
  recordTelemetry = false,
  signalCapture = null,
}) {
  const allow = enabledIntervals();
  if (!allow.includes(Number(intervalMin))) return null;
  if (!candles || candles.length < 50) return null;

  const strategyIds = enabledStrategyIds();
  if (!strategyIds.length) return null;

  const last = candles[candles.length - 1];
  return evaluateSignalSetFromCandles({
    candles,
    last,
    instrument_token,
    intervalMin,
    stage: "close",
    strategyIds,
    createdAtMs: now instanceof Date ? now.getTime() : new Date(now).getTime(),
    recordTelemetry,
    signalCapture,
  });
}

function evaluateOnCandles(options) {
  const signalSet = evaluateSignalSetOnCandles(options);
  return signalSet?.selectedSignal || null;
}

module.exports = {
  evaluateOnCandles,
  evaluateSignalSetOnCandles,
  resetSignalLayerState,
};
