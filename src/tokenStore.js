// src/tokenStore.js
const { env } = require("./config");
const { getDb } = require("./db");

async function readLatestTokenDoc() {
  const db = getDb();
  const col = db.collection(env.TOKENS_COLLECTION);

  const filter = {};
  if (env.TOKEN_FILTER_USER_ID) filter.user_id = env.TOKEN_FILTER_USER_ID;
  if (env.TOKEN_FILTER_API_KEY) filter.api_key = env.TOKEN_FILTER_API_KEY;
  if (env.TOKEN_FILTER_ENV) filter.environment = env.TOKEN_FILTER_ENV;

  const doc = await col
    .aggregate([
      { $match: filter },
      {
        $addFields: {
          sortUpdatedAt: { $ifNull: ["$updatedAt", "$createdAt"] },
        },
      },
      { $sort: { sortUpdatedAt: -1, createdAt: -1, _id: -1 } },
      { $limit: 1 },
    ])
    .next();

  // IMPORTANT: Don't crash the engine if there is no token yet.
  // We'll keep running and let tokenWatcher poll / watch for a login update.
  if (!doc) {
    return {
      doc: null,
      accessToken: null,
      reason: "NO_TOKEN_DOC",
      filter,
      collection: env.TOKENS_COLLECTION,
    };
  }

  const accessToken =
    doc.access_token ||
    doc.accessToken ||
    doc.token ||
    doc.access ||
    doc.kite_access_token ||
    null;

  if (!accessToken || String(accessToken).trim().length < 5) {
    return {
      doc,
      accessToken: null,
      reason: "MISSING_ACCESS_TOKEN",
      filter,
      collection: env.TOKENS_COLLECTION,
    };
  }

  if (doc && !doc.updatedAt && doc.createdAt) {
    doc.updatedAt = doc.createdAt;
  }

  return {
    doc,
    accessToken: String(accessToken),
    filter,
    collection: env.TOKENS_COLLECTION,
  };
}

module.exports = { readLatestTokenDoc };
