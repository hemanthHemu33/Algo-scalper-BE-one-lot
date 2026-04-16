function textParts(error) {
  const parts = [];
  let cur = error;
  let depth = 0;
  while (cur && depth < 2) {
    parts.push(String(cur?.name || ""));
    parts.push(String(cur?.code || ""));
    parts.push(String(cur?.codeName || ""));
    parts.push(String(cur?.message || ""));
    cur = cur?.cause;
    depth += 1;
  }
  return parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isTransientMongoError(error) {
  if (!error) return false;

  const parts = textParts(error);
  const joined = parts.join(" | ");

  if (
    joined.includes("mongonetworkerror") ||
    joined.includes("mongonetworktimeouterror") ||
    joined.includes("mongoserverselectionerror") ||
    joined.includes("mongopoolclearederror")
  ) {
    return true;
  }

  if (joined.includes("econnreset") || joined.includes("econnaborted")) {
    return true;
  }

  if (joined.includes("connection pool")) return true;
  if (joined.includes("server selection")) return true;

  if (joined.includes("topology is closed")) {
    return joined.includes("mongo") || joined.includes("topology");
  }

  if (
    joined.includes("timed out") &&
    (joined.includes("mongo") ||
      joined.includes("topology") ||
      joined.includes("server selection"))
  ) {
    return true;
  }

  return false;
}

module.exports = { isTransientMongoError };
