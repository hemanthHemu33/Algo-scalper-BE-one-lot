const https = require("https");
const { env } = require("../config");
const { logger } = require("../logger");

const TELEGRAM_HOST = "api.telegram.org";
const TELEGRAM_MAX_TEXT = 4096;

let serial = Promise.resolve();
let nextAllowedAt = 0;

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Number(ms) || 0)),
  );
}

function isEnabled() {
  const enabledFlag =
    env.TELEGRAM_NOTIFICATIONS_ENABLED ?? env.TELEGRAM_ENABLED ?? "false";
  return (
    String(enabledFlag).trim().toLowerCase() === "true" &&
    !!env.TELEGRAM_BOT_TOKEN &&
    !!env.TELEGRAM_CHAT_ID
  );
}

function normalizeParseMode(parseMode) {
  const raw = String(parseMode || env.TELEGRAM_PARSE_MODE || "HTML")
    .trim()
    .toUpperCase();
  return ["HTML", "MARKDOWN", "MARKDOWNV2"].includes(raw) ? raw : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function truncateText(text, max = TELEGRAM_MAX_TEXT) {
  const raw = String(text ?? "");
  const limit = Math.max(1, Number(max) || TELEGRAM_MAX_TEXT);
  if (raw.length <= limit) return raw;
  return raw.slice(0, Math.max(0, limit - 3)) + "...";
}

function parseJsonSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function postJson(hostname, path, bodyObj) {
  const body = Buffer.from(JSON.stringify(bodyObj), "utf8");
  const opts = {
    hostname,
    path,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": body.length,
    },
    timeout: Math.max(1000, Number(env.TELEGRAM_API_TIMEOUT_MS ?? 10000)),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({
          status: Number(res.statusCode ?? 0),
          data,
          json: parseJsonSafe(data),
        });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("telegram_timeout")));
    req.write(body);
    req.end();
  });
}

async function waitTurn() {
  const now = Date.now();
  if (nextAllowedAt > now) {
    await sleep(nextAllowedAt - now);
  }
}

function reserveNextWindow(delayMs = null) {
  const minGap = Math.max(
    0,
    Number(delayMs ?? env.TELEGRAM_RATE_LIMIT_MS ?? 300),
  );
  nextAllowedAt = Date.now() + minGap;
}

function queue(fn) {
  const run = async () => {
    await waitTurn();
    return fn();
  };
  serial = serial.then(run, run);
  return serial;
}

function buildTelegramError(method, res) {
  const description =
    res?.json?.description ||
    res?.data ||
    `${method} failed with status ${res?.status || "unknown"}`;
  const error = new Error(description);
  error.status = Number(res?.status ?? 0);
  error.method = method;
  error.response = res?.json || res?.data || null;
  const retryAfterSec = Number(res?.json?.parameters?.retry_after);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    error.retryAfterMs = retryAfterSec * 1000;
  }
  return error;
}

function errorMessageLower(error) {
  return String(error?.message || "").trim().toLowerCase();
}

function isRetryableTelegramError(error) {
  const status = Number(error?.status ?? 0);
  const message = errorMessageLower(error);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return [
    "telegram_timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "socket hang up",
    "temporarily unavailable",
    "too many requests",
    "network",
  ].some((pattern) => message.includes(pattern));
}

function isTelegramMessageNotModifiedError(error) {
  return errorMessageLower(error).includes("message is not modified");
}

function isPermanentTelegramEditFailure(error) {
  const message = errorMessageLower(error);
  return (
    String(error?.code || "").toUpperCase() === "INVALID_TELEGRAM_MESSAGE_ID" ||
    message.includes("invalid_telegram_message_id") ||
    message.includes("message to edit not found") ||
    message.includes("message can't be edited") ||
    message.includes("message can not be edited") ||
    message.includes("message identifier is not specified") ||
    message.includes("chat not found")
  );
}

function isPermanentTelegramSendFailure(error) {
  if (isRetryableTelegramError(error)) return false;
  const status = Number(error?.status ?? 0);
  const message = errorMessageLower(error);
  if ([400, 403, 404].includes(status)) return true;
  return [
    "chat not found",
    "bot was blocked by the user",
    "have no rights to send a message",
    "user is deactivated",
    "forbidden",
  ].some((pattern) => message.includes(pattern));
}

function classifyTelegramError(error, options = {}) {
  const operation = String(options?.operation || "send").toLowerCase();
  const retryable = isRetryableTelegramError(error);
  const noChange = operation === "edit" && isTelegramMessageNotModifiedError(error);
  const permanentEditFailure =
    operation === "edit" && isPermanentTelegramEditFailure(error);
  const permanentSendFailure =
    operation === "send" && isPermanentTelegramSendFailure(error);

  return {
    operation,
    retryable,
    noChange,
    permanentEditFailure,
    permanentSendFailure,
    permanent: Boolean(
      noChange ||
        permanentEditFailure ||
        permanentSendFailure ||
        (!retryable &&
          Number(error?.status ?? 0) >= 400 &&
          Number(error?.status ?? 0) < 500),
    ),
  };
}

async function callTelegram(method, payload, attempt = 0) {
  if (!isEnabled()) return { skipped: true, ok: true };

  const res = await postJson(
    TELEGRAM_HOST,
    `/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    payload,
  );

  if (res.status >= 200 && res.status < 300 && res.json?.ok !== false) {
    reserveNextWindow();
    return {
      ok: true,
      result: res.json?.result || null,
      status: res.status,
      raw: res.json || res.data,
    };
  }

  const error = buildTelegramError(method, res);
  const retryAfterMs = Math.max(
    1000,
    Number(error.retryAfterMs ?? env.TELEGRAM_OUTBOX_RETRY_BASE_MS ?? 1500),
  );

  if (error.status === 429 && attempt < 1) {
    logger.warn(
      { method, retryAfterMs, response: error.response },
      "[telegram] rate limited; retrying once",
    );
    reserveNextWindow(retryAfterMs);
    await sleep(retryAfterMs);
    return callTelegram(method, payload, attempt + 1);
  }

  logger.warn(
    { method, status: error.status, response: error.response },
    "[telegram] api error",
  );
  throw error;
}

function buildMessagePayload(text, options = {}) {
  const parseMode = normalizeParseMode(options.parseMode);
  const payload = {
    chat_id: options.chatId || env.TELEGRAM_CHAT_ID,
    text: truncateText(text),
    disable_web_page_preview: options.disableWebPagePreview !== false,
  };
  if (parseMode) payload.parse_mode = parseMode;
  if (options.messageThreadId != null) {
    payload.message_thread_id = options.messageThreadId;
  }
  if (options.replyMarkup) payload.reply_markup = options.replyMarkup;
  return payload;
}

async function sendMessage(text, options = {}) {
  if (!isEnabled()) return { skipped: true, ok: true };
  return queue(async () => {
    const payload = buildMessagePayload(text, options);
    const result = await callTelegram("sendMessage", payload);
    return {
      ok: true,
      messageId: result?.result?.message_id ?? null,
      raw: result?.raw ?? null,
    };
  });
}

async function editMessageText(messageId, text, options = {}) {
  if (!isEnabled()) return { skipped: true, ok: true };
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0) {
    const error = new Error("invalid_telegram_message_id");
    error.code = "INVALID_TELEGRAM_MESSAGE_ID";
    throw error;
  }

  return queue(async () => {
    const payload = buildMessagePayload(text, options);
    payload.message_id = id;
    const result = await callTelegram("editMessageText", payload);
    const editedResult = result?.result || null;
    return {
      ok: true,
      messageId:
        Number(editedResult?.message_id ?? payload.message_id) ||
        payload.message_id,
      raw: result?.raw ?? null,
    };
  });
}

async function sendTelegramMessage(text, options = {}) {
  try {
    return await sendMessage(text, options);
  } catch (error) {
    logger.warn(
      { err: error?.message || String(error) },
      "[telegram] send error",
    );
    return { ok: false, error: error?.message || String(error) };
  }
}

module.exports = {
  TELEGRAM_MAX_TEXT,
  escapeHtml,
  truncateText,
  sendMessage,
  editMessageText,
  sendTelegramMessage,
  isEnabled,
  isRetryableTelegramError,
  isPermanentTelegramEditFailure,
  isPermanentTelegramSendFailure,
  isTelegramMessageNotModifiedError,
  classifyTelegramError,
};
