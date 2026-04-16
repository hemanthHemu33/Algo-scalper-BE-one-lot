const { env } = require("../config");
const { escapeHtml } = require("./telegram");

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: env.CANDLE_TZ || "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function fmtTs(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime())
    ? dateFormatter.format(date)
    : dateFormatter.format(new Date());
}

function fmtNumber(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : null;
}

function fmtSigned(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return `${num >= 0 ? "+" : ""}${num.toFixed(digits)}`;
}

function pushLine(lines, label, value) {
  if (value == null || value === "") return;
  lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`);
}

function joinParts(parts, separator = " | ") {
  return (parts || []).filter(Boolean).join(separator) || null;
}

function compactMetaLines(meta = {}) {
  const lines = [];
  pushLine(lines, "Trade", meta.tradeId || meta.trade_id || null);
  pushLine(lines, "Order", meta.orderId || meta.order_id || null);
  pushLine(lines, "Symbol", meta.symbol || meta.tradingsymbol || null);
  pushLine(lines, "Side", meta.side || null);
  pushLine(lines, "Qty", meta.qty != null ? String(meta.qty) : null);
  pushLine(lines, "Status", meta.status || null);
  pushLine(lines, "Reason", meta.reason || meta.closeReason || meta.message || null);
  pushLine(lines, "Exit", meta.exitReason || meta.exitAuthority || null);
  return lines;
}

function formatIncidentEnvelope(envelope) {
  const payload = envelope?.payload || {};
  const meta = payload?.meta || {};
  const lines = [
    `<b>${escapeHtml(String(envelope?.severity || "info").toUpperCase())} INCIDENT</b>`,
  ];
  pushLine(lines, "Event", envelope?.event || "ALERT");
  pushLine(lines, "Message", payload?.message || meta?.message || meta?.reason || null);
  for (const line of compactMetaLines(meta)) lines.push(line);
  pushLine(lines, "Time", fmtTs(envelope?.createdAt));
  return lines.join("\n");
}

function milestoneLabel(event) {
  const mapping = {
    ENTRY_SUBMITTED: "Entry submitted",
    ENTRY_PARTIAL_FILL: "Entry partial fill",
    ENTRY_FILLED: "Entry filled",
    PROTECTION_LIVE: "Protection live",
    SL_LIVE: "SL live",
    TARGET_LIVE: "Target live",
    BE_ACTIVE: "BE active",
    PARTIAL_EXIT_FILLED: "Partial exit filled",
    EXITED_TARGET: "Exited target",
    EXITED_SL: "Exited stop",
    EXIT_FILLED_GENERIC: "Exit filled",
    PANIC_EXIT_FILLED: "Panic exit filled",
    TIME_STOP_EXIT: "Time-stop exit",
    FORCE_FLATTEN_EXIT: "Force-flatten exit",
    RESTART_FLATTEN_EXIT: "Restart flatten exit",
    PROTECTION_FAILURE_EXIT: "Protection-failure exit",
    GUARD_FAIL_EXIT: "Guard-fail exit",
    MANUAL_EXIT: "Manual exit",
    ENTRY_FAILED: "Entry failed",
    ENTRY_CANCELLED: "Entry cancelled",
  };
  return mapping[String(event || "").toUpperCase()] || String(event || "");
}

function formatMilestones(lines, milestones = []) {
  const items = Array.isArray(milestones) ? milestones.slice(-8) : [];
  if (!items.length) return;
  lines.push("<b>Milestones</b>");
  for (const item of items) {
    const time = item?.firstObservedAt || item?.createdAt || item?.updatedAt;
    const label = milestoneLabel(item?.milestone);
    const row = joinParts([time ? fmtTs(time) : null, label], " | ");
    if (row) lines.push(escapeHtml(row));
  }
}

function buildTradeHeader(current, isTerminal) {
  const entity = joinParts(
    [
      current?.symbol || "UNKNOWN",
      current?.side || null,
      current?.qty != null ? `x${current.qty}` : null,
    ],
    " ",
  );
  return `<b>${escapeHtml(isTerminal ? "TRADE CLOSED" : "TRADE LIVE")} | ${escapeHtml(entity || "UNKNOWN")}</b>`;
}

function formatTradeEnvelope(envelope) {
  const current = envelope?.payload?.current || {};
  const milestoneHistory = envelope?.payload?.milestoneHistory || [];
  const isTerminal = envelope?.kind === "trade_terminal" || current?.terminal;
  const lines = [buildTradeHeader(current, isTerminal)];

  pushLine(
    lines,
    "Status",
    joinParts(
      [
        current?.status || null,
        current?.terminalEvent || null,
        current?.closeFamily || null,
      ],
      " | ",
    ),
  );
  pushLine(
    lines,
    "Trade",
    joinParts([current?.tradeId || null, current?.strategyId || null]),
  );

  lines.push("<b>Entry</b>");
  pushLine(
    lines,
    "Fill",
    joinParts(
      [
        current?.entryPrice != null ? fmtNumber(current.entryPrice) : null,
        current?.expectedEntryPrice != null
          ? `Ref ${fmtNumber(current.expectedEntryPrice)}`
          : null,
      ],
    ),
  );
  pushLine(
    lines,
    "Qty",
    joinParts(
      [
        current?.qty != null ? String(current.qty) : null,
        current?.initialQty != null ? `Init ${current.initialQty}` : null,
        current?.exitedQty != null && current.exitedQty > 0
          ? `Exited ${current.exitedQty}`
          : null,
      ],
    ),
  );

  if (!isTerminal) {
    lines.push("<b>Live</b>");
    pushLine(
      lines,
      "Market",
      joinParts(
        [
          current?.ltp != null ? `LTP ${fmtNumber(current.ltp)}` : null,
          current?.pnlOpenInr != null
            ? `Open ${fmtSigned(current.pnlOpenInr)}`
            : null,
        ],
      ),
    );
  }

  lines.push("<b>Protection</b>");
  pushLine(
    lines,
    "Stops",
    joinParts(
      [
        current?.stopLoss != null ? `SL ${fmtNumber(current.stopLoss)}` : null,
        current?.targetPrice != null
          ? `Target ${fmtNumber(current.targetPrice)}`
          : null,
        current?.targetStateLabel || null,
      ],
    ),
  );
  pushLine(
    lines,
    "State",
    joinParts(
      [
        current?.alcStateLabel || null,
        current?.beStateLabel || null,
        current?.trailStateLabel || null,
        current?.protectionStage || null,
        current?.panicExitPending ? "Panic pending" : null,
      ],
    ),
  );

  if (isTerminal) {
    lines.push("<b>Exit</b>");
    pushLine(
      lines,
      "Summary",
      joinParts(
        [
          current?.terminalEvent || null,
          current?.exitFamily || null,
          current?.exitAuthority || null,
        ],
      ),
    );
    pushLine(
      lines,
      "Reason",
      joinParts([current?.exitReasonCode || null, current?.closeReason || null]),
    );
    pushLine(lines, "Exit Px", fmtNumber(current?.exitPrice));

    lines.push("<b>Realized</b>");
    pushLine(
      lines,
      "PnL",
      joinParts(
        [
          current?.pnlGrossInr != null
            ? `Gross ${fmtSigned(current.pnlGrossInr)}`
            : null,
          current?.pnlNetAfterEstCostsInr != null
            ? `Net ${fmtSigned(current.pnlNetAfterEstCostsInr)}`
            : null,
        ],
      ),
    );
  }

  formatMilestones(lines, milestoneHistory);
  pushLine(
    lines,
    "Updated",
    fmtTs(current?.displayUpdatedAt || current?.updatedAt || envelope?.createdAt),
  );
  return lines.join("\n");
}

function formatHeartbeatEnvelope(envelope) {
  const payload = envelope?.payload || {};
  const lines = ["<b>ENGINE HEARTBEAT</b>"];
  pushLine(lines, "Mode", payload.engineMode || null);
  pushLine(
    lines,
    "Trading",
    payload.tradingEnabled == null
      ? null
      : payload.tradingEnabled
        ? "enabled"
        : "halted",
  );
  pushLine(
    lines,
    "Active",
    joinParts(
      [
        payload.activeTradeCount != null ? String(payload.activeTradeCount) : null,
        payload.activeTradeSummary || null,
      ],
    ),
  );
  pushLine(lines, "Risk", payload.dailyRiskState || null);
  pushLine(
    lines,
    "Broker",
    joinParts(
      [
        payload.tickerConnected == null
          ? null
          : payload.tickerConnected
            ? "Ticker connected"
            : "Ticker down",
        payload.kiteSessionActive == null
          ? null
          : payload.kiteSessionActive
            ? "Kite active"
            : "Kite inactive",
      ],
    ),
  );
  pushLine(
    lines,
    "Kill Switch",
    payload.killSwitch == null ? null : payload.killSwitch ? "ON" : "OFF",
  );
  pushLine(
    lines,
    "Faults",
    payload.criticalFaultCount != null ? String(payload.criticalFaultCount) : null,
  );
  pushLine(lines, "Time", fmtTs(envelope?.createdAt));
  return lines.join("\n");
}

function formatEnvelopeToTelegram(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { text: "<b>INVALID NOTIFICATION</b>", parseMode: "HTML" };
  }

  if (envelope.kind === "trade_status" || envelope.kind === "trade_terminal") {
    return { text: formatTradeEnvelope(envelope), parseMode: "HTML" };
  }
  if (envelope.kind === "heartbeat") {
    return { text: formatHeartbeatEnvelope(envelope), parseMode: "HTML" };
  }
  return { text: formatIncidentEnvelope(envelope), parseMode: "HTML" };
}

module.exports = {
  formatEnvelopeToTelegram,
};
