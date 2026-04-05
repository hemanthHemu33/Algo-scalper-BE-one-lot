#!/usr/bin/env node
const assert = require('node:assert/strict');
const { canTransition } = require('../src/trading/tradeStateMachine');

(function run() {
  const allowed = canTransition('GUARD_FAILED', 'PANIC_EXIT_PLACED');
  assert.equal(allowed.ok, true, 'GUARD_FAILED -> PANIC_EXIT_PLACED should be allowed');

  const allowedConfirmed = canTransition('GUARD_FAILED', 'PANIC_EXIT_CONFIRMED');
  assert.equal(allowedConfirmed.ok, true, 'GUARD_FAILED -> PANIC_EXIT_CONFIRMED should be allowed');

  const blocked = canTransition('GUARD_FAILED', 'ENTRY_FILLED');
  assert.equal(blocked.ok, false, 'GUARD_FAILED -> ENTRY_FILLED must stay blocked');

  console.log('✅ guard-failed panic transition regression covered');
})();
