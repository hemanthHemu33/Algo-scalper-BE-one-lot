const fs = require("fs");

function escapeCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return escapeCell(JSON.stringify(value));
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function inferColumns(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function toCsv(rows, columns = null) {
  const resolvedColumns = Array.isArray(columns) && columns.length ? columns : inferColumns(rows);
  const lines = [resolvedColumns.map(escapeCell).join(",")];
  for (const row of rows || []) {
    lines.push(resolvedColumns.map((column) => escapeCell(row?.[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function writeCsv(filePath, rows, columns = null) {
  fs.writeFileSync(filePath, toCsv(rows, columns), "utf8");
}

module.exports = {
  inferColumns,
  toCsv,
  writeCsv,
};
