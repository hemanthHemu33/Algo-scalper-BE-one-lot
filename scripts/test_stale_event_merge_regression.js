#!/usr/bin/env node
const assert = require('node:assert/strict');

const dbPath = require.resolve('../src/db');
delete require.cache[dbPath];

const rows = new Map();
rows.set('T-STALE', { tradeId: 'T-STALE', status: 'LIVE' });

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    getDb: () => ({
      collection: (name) => {
        if (name !== 'trades') throw new Error(`unexpected collection ${name}`);
        return {
          findOne: async ({ tradeId }) => rows.get(tradeId) || null,
          updateOne: async ({ tradeId }, { $set }) => {
            const cur = rows.get(tradeId);
            if (!cur) return { acknowledged: true, matchedCount: 0 };
            rows.set(tradeId, { ...cur, ...$set });
            return { acknowledged: true, matchedCount: 1 };
          },
        };
      },
    }),
  },
};

const { updateTrade } = require('../src/trading/tradeStore');

(async function run() {
  await updateTrade('T-STALE', {
    status: 'ENTRY_FILLED',
    entryPrice: 123.45,
    qty: 10,
  });

  const final = rows.get('T-STALE');
  assert.equal(final.status, 'LIVE', 'stale ENTRY_FILLED should not regress status');
  assert.equal(final.entryPrice, 123.45, 'facts should still be merged');
  assert.equal(final.qty, 10, 'facts should still be merged');

  console.log('✅ stale-event merge regression covered (status stays LIVE, facts merge)');
})();
