const { env } = require("../config");
const { sendTelegramMessage } = require("./telegram");
const { logger } = require("../logger");
const os = require("os");

const LEVELS = { info: 10, warn: 20, error: 30 };
const LEVEL_BADGES = {
  info: "🟢 INFO",
  warn: "🟠 WARN",
  error: "🔴 ERROR",
};

function minLevel() {
  const l = String(env.TELEGRAM_MIN_LEVEL || "info").toLowerCase();
  return LEVELS[l] ?? LEVELS.info;
}

function fmtMeta(meta) {
  if (!meta) return "";
  try {
    const s = JSON.stringify(meta);
    const maxChars = Number(env.TELEGRAM_MAX_META_CHARS || 1500);
    return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
  } catch {
    return String(meta);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildDetailedMessage(level, message, meta) {
  const now = new Date().toISOString();
  const badge = LEVEL_BADGES[level] || LEVEL_BADGES.info;
  const base = [
    `<b>${badge}</b>`,
    `<b>Event:</b> ${escapeHtml(message)}`,
    `<b>Time:</b> ${now}`,
    `<b>Host:</b> ${escapeHtml(os.hostname())}`,
  ];
  const m = fmtMeta(meta);
  const mathLines = buildTradeMathLines(message, meta);
  if (mathLines.length) {
    base.push(`<b>Math</b>\n${mathLines.map((line) => escapeHtml(line)).join("\n")}`);
  }
  if (m) base.push(`<b>Meta</b>\n<pre>${escapeHtml(m)}</pre>`);
  return base.join("\n");
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function sourceText(v) {
  const s = String(v || "").trim().toUpperCase();
  return s || null;
}

function buildTradeMathLines(message, meta) {
  if (!meta || typeof meta !== "object") return [];
  const text = String(message || "").toLowerCase();
  const lines = [];

  if (text.includes("entry placing")) {
    const entry = n(meta.entryRef);
    const sl = n(meta.stopLoss);
    const qty = n(meta.qty);
    if (entry != null && sl != null) {
      const riskPts = Math.abs(entry - sl);
      lines.push(`Risk points = |Entry ${entry} - SL ${sl}| = ${riskPts.toFixed(2)}`);
      if (qty != null) {
        lines.push(`Per-lot move = ${riskPts.toFixed(2)} × Qty ${qty}`);
      }
    }
  }

  if (text.includes("entry filled")) {
    const avg = n(meta.avg);
    const expected = n(meta.expected);
    if (avg != null && expected != null && expected !== 0) {
      const bps = (Math.abs(avg - expected) / Math.abs(expected)) * 10000;
      lines.push(
        `Slippage bps = |Fill ${avg} - Expected ${expected}| ÷ ${Math.abs(expected)} × 10000 = ${bps.toFixed(2)}`,
      );
    }
  }

  if (text.includes("be armed") || text.includes("be lock active")) {
    const be = n(meta.beLockedAtPrice);
    const mg = n(meta.minGreenPts);
    const entry = n(meta.entryPrice);
    const side = String(meta.side || "").toUpperCase();
    const beSource = sourceText(meta.beFloorSource);
    if (beSource) {
      lines.push(`BE floor source = ${beSource}`);
    }
    if (beSource === "MIN_GREEN" && be != null && mg != null && entry != null) {
      const op = side === "SELL" ? "-" : "+";
      lines.push(`Min-green floor = Entry ${entry} ${op} ${mg} = ${be}`);
    }
  }

  if (
    text.includes("sl trailed") ||
    text.includes("sl moved to be") ||
    text.includes("sl moved to profit lock") ||
    text.includes("sl updated")
  ) {
    const prev = n(meta.prevStopLoss);
    const next = n(meta.stopLoss);
    if (prev != null && next != null) {
      const delta = next - prev;
      lines.push(`Trail move = New SL ${next} - Old SL ${prev} = ${delta.toFixed(2)}`);
    }
    const protectionSource = sourceText(
      meta.protectedStopSource || meta.beFloorSource,
    );
    if (protectionSource) {
      lines.push(`Protection source = ${protectionSource}`);
    }
    const beFloor = n(meta.beFloor);
    if (next != null && beFloor != null) {
      lines.push(`BE distance = SL ${next} - BE floor ${beFloor} = ${(next - beFloor).toFixed(2)}`);
    }
  }

  return lines;
}

async function alert(level, message, meta) {
  const lv = String(level || "info").toLowerCase();
  const score = LEVELS[lv] ?? LEVELS.info;
  if (score < minLevel()) return;

  const detailed = String(env.TELEGRAM_DETAILED || "true") === "true";
  const text = detailed
    ? buildDetailedMessage(lv, message, meta)
    : meta
      ? `${message}\n\n${fmtMeta(meta)}`
      : message;

  logger.info({ level: lv }, "[alert] " + message);
  await sendTelegramMessage(text);
}

module.exports = { alert };
