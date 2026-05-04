const pino = require("pino");
const { recordRuntimeLog } = require("./runtime/runtimeLogStore");

const logTimezone = process.env.LOG_TZ || "Asia/Kolkata";
const prettyLogs = process.env.LOG_PRETTY !== "false";

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: logTimezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false
});

function istTimestamp() {
  const parts = timeFormatter.formatToParts(new Date());
  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const ts = `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}.${partMap.fractionalSecond}`;
  return `,\"time\":\"${ts} ${logTimezone}\"`;
}

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: istTimestamp,
  transport: prettyLogs
    ? {
      target: "pino-pretty",
      options: {
        colorize: Boolean(process.stdout.isTTY),
        translateTime: "yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname"
      }
    }
    : undefined
});

for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
  const original = logger[level].bind(logger);
  logger[level] = (...args) => {
    if (
      typeof logger.isLevelEnabled !== "function" ||
      logger.isLevelEnabled(level)
    ) {
      recordRuntimeLog(level, args);
    }
    return original(...args);
  };
}

module.exports = { logger };
