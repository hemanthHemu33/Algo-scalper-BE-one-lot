#!/usr/bin/env node
const assert = require('node:assert/strict');

const alertsPath = require.resolve('../src/alerts/alertService');
delete require.cache[alertsPath];
require.cache[alertsPath] = {
  id: alertsPath,
  filename: alertsPath,
  loaded: true,
  exports: { alert: async () => ({ ok: true, skipped: true }) },
};

const { TradeManager } = require('../src/trading/tradeManager');

(function run() {
  const riskCalls = [];
  const keyCalls = [];

  const fakeManager = {
    _buildRiskKey: ({ strategyId, underlying, token }) => {
      keyCalls.push({ strategyId, underlying, token });
      return `rk:${strategyId}:${underlying}:${token}`;
    },
    risk: {
      setCooldown: (riskKey, seconds, reason) => {
        riskCalls.push({ riskKey, seconds, reason });
      },
    },
  };

  const trade = {
    tradeId: 'T-CB-1',
    strategyId: 'STRAT-A',
    underlying_symbol: 'NIFTY',
    instrument_token: 260226,
  };
  const order = {
    status_message_raw: 'Order rejected: price band exceeded / circuit',
  };

  TradeManager.prototype._handleOrderRejection.call(fakeManager, {
    trade,
    order,
    role: 'TARGET',
  });

  assert.equal(keyCalls.length, 1, 'risk key should be built exactly once');
  assert.deepEqual(keyCalls[0], {
    strategyId: 'STRAT-A',
    underlying: 'NIFTY',
    token: 260226,
  });

  assert.equal(riskCalls.length, 1, 'cooldown should be set exactly once');
  assert.equal(riskCalls[0].riskKey, 'rk:STRAT-A:NIFTY:260226');
  assert.equal(riskCalls[0].reason, 'CIRCUIT_BREAKER');
  assert.ok(Number.isFinite(riskCalls[0].seconds) && riskCalls[0].seconds >= 60);

  console.log('✅ order rejection cooldown-key regression covered');
})();
