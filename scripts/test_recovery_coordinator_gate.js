#!/usr/bin/env node
const assert = require('node:assert/strict');
const { TradeManager } = require('../src/trading/tradeManager');

function makeManager() {
  const riskEngine = {
    setStateChangeHandler: () => {},
  };
  const kite = {
    async getPositions() {
      return { net: [{ instrument_token: 222, average_price: 205, quantity: 10 }] };
    },
  };
  const tm = new TradeManager({ kite, riskEngine });
  tm.reconcile = async () => {};
  return tm;
}

(async function run() {
  const tm = makeManager();
  let reconcileRuns = 0;
  tm.reconcile = async () => {
    reconcileRuns += 1;
  };

  const activeTrades = [
    { tradeId: 'T1', instrument_token: 111, status: 'LIVE' },
    { tradeId: 'T2', instrument_token: 222, status: 'LIVE', entryPrice: 200, qty: 10 },
  ];
  tm._getActiveTradesForFactGate = async () => activeTrades;
  const patched = [];
  tm._updateTradeFacts = async (tradeId, patch) => {
    patched.push({ tradeId, patch });
  };

  const blocked = await tm._globalFactRecoveryGate(new Map());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blockers.length, 1);
  assert.equal(blocked.blockers[0].tradeId, 'T1');

  const byId = new Map([
    ['ENTRY-T1', { average_price: 101, filled_quantity: 5, exchange_timestamp: new Date().toISOString() }],
  ]);
  activeTrades[0].entryOrderId = 'ENTRY-T1';

  const resumed = await tm._globalFactRecoveryGate(byId);
  assert.equal(resumed.ok, true);
  assert.ok(patched.some((x) => x.tradeId === 'T1'));
  assert.ok(reconcileRuns >= 1, 'blocked gate should trigger reconcile');

  console.log('✅ recovery coordinator gate blocks until global fact completeness and resumes afterwards');
})();
