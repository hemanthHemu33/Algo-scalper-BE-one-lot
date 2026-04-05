#!/usr/bin/env node
const assert = require('node:assert/strict');
const { computeDynamicExitPlan } = require('../src/trading/dynamicExitManager');

const BASE_NOW = Date.parse('2026-01-01T09:15:00.000Z');

function makeTrade(overrides = {}) {
  return {
    side: 'BUY',
    qty: 10,
    initialQty: 10,
    entryPrice: 100,
    stopLoss: 90,
    initialStopLoss: 90,
    riskInr: 100,
    rr: 1,
    createdAt: new Date(BASE_NOW).toISOString(),
    entryFilledAt: new Date(BASE_NOW).toISOString(),
    underlying_ltp: 20000,
    instrument: {
      tick_size: 0.05,
      segment: 'NFO-OPT',
      tradingsymbol: 'NIFTY26JAN20000CE',
    },
    ...overrides,
  };
}

function makeEnv(overrides = {}) {
  return {
    MIN_GREEN_ENABLED: 'false',
    TIME_STOP_NO_PROGRESS_MIN: 5,
    TIME_STOP_NO_PROGRESS_MFE_R: 0.2,
    TIME_STOP_NO_PROGRESS_REQUIRE_UL_CONFIRM: 'true',
    TIME_STOP_NO_PROGRESS_UL_BPS: 12,
    TIME_STOP_MAX_HOLD_MIN: 0,
    TIME_STOP_MAX_HOLD_SKIP_IF_PNL_R: 0.8,
    TIME_STOP_MAX_HOLD_SKIP_IF_PEAK_R: 1,
    TIME_STOP_MAX_HOLD_SKIP_IF_LOCKED: 'true',
    BE_ARM_R: 0.6,
    TRAIL_ARM_R: 99,
    PROFIT_LOCK_ENABLED: 'false',
    PROFIT_LOCK_R: 1,
    PROFIT_LOCK_KEEP_R: 0.25,
    PROFIT_LOCK_MIN_INR: 0,
    DYN_TRAIL_STEP_TICKS: 1,
    DYN_STEP_TICKS_PRE_BE: 1,
    DYN_STEP_TICKS_POST_BE: 1,
    TRIGGER_BUFFER_TICKS: 1,
    ...overrides,
  };
}


function flatCandles(count = 30, price = 100) {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(BASE_NOW - (count - i) * 60_000).toISOString(),
    open: price,
    high: price + 0.1,
    low: price - 0.1,
    close: price,
    volume: 1000,
  }));
}

function applyPlanPatch(trade, plan) {
  const next = { ...trade };
  if (plan?.sl?.stopLoss) next.stopLoss = Number(plan.sl.stopLoss);
  if (plan?.tradePatch && typeof plan.tradePatch === 'object') {
    Object.assign(next, plan.tradePatch);
  }
  return next;
}

function runFeed({ trade, env, points }) {
  let currentTrade = { ...trade };
  const plans = [];
  for (const p of points) {
    const nowTs = BASE_NOW + p.min * 60_000;
    const plan = computeDynamicExitPlan({
      trade: currentTrade,
      ltp: p.ltp,
      underlyingLtp: p.underlyingLtp,
      nowTs,
      env,
      candles: [],
    });
    plans.push(plan);
    currentTrade = applyPlanPatch(currentTrade, plan);
  }
  return { plans, trade: currentTrade };
}

const scenarios = [
  {
    name: 'no-progress triggers (premium + no UL move)',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv();
      const { plans } = runFeed({
        trade,
        env,
        points: [
          { min: 1, ltp: 100.05, underlyingLtp: 20002 },
          { min: 6, ltp: 100.1, underlyingLtp: 20002 },
        ],
      });
      const plan = plans.at(-1);
      assert.equal(plan.ok, true);
      assert.equal(plan.action?.reason, 'TIME_STOP_NO_PROGRESS');
      assert.equal(Boolean(plan.tradePatch?.timeStopTriggeredAt), true);
    },
  },
  {
    name: 'no-progress still triggers when peak price R is exactly 0',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv();
      const plan = computeDynamicExitPlan({
        trade,
        ltp: 100,
        underlyingLtp: 20000,
        nowTs: BASE_NOW + 6 * 60_000,
        env,
        candles: [],
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.action?.reason, 'TIME_STOP_NO_PROGRESS');
      assert.equal(plan.meta?.mfeR, 0);
    },
  },
  {
    name: 'no-progress skipped (premium no move but UL moved)',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv();
      const { plans } = runFeed({
        trade,
        env,
        points: [{ min: 6, ltp: 100.1, underlyingLtp: 20100 }],
      });
      const plan = plans[0];
      assert.equal(plan.ok, true);
      assert.equal(Boolean(plan.action?.exitNow), false);
      assert.notEqual(plan.action?.reason, 'TIME_STOP_NO_PROGRESS');
    },
  },
  {
    name: 'no-progress supports price-only mode when UL is unknown',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv({ TIME_STOP_NO_PROGRESS_UL_MODE: 'PRICE_ONLY_ON_UNKNOWN' });
      const plan = computeDynamicExitPlan({
        trade,
        ltp: 100.1,
        underlyingLtp: null,
        nowTs: BASE_NOW + 6 * 60_000,
        env,
        candles: flatCandles(),
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.action?.reason, 'TIME_STOP_NO_PROGRESS');
      assert.equal(plan.meta?.noProgressUnderlyingStatus, 'UNKNOWN');
      assert.equal(plan.meta?.noProgressUnderlyingMode, 'PRICE_ONLY_ON_UNKNOWN');
    },
  },

  {
    name: 'no-progress triggers for non-options even when UL confirm is enabled',
    run: () => {
      const trade = makeTrade({
        instrument: {
          tick_size: 0.05,
          segment: 'NSE',
          tradingsymbol: 'RELIANCE',
        },
        underlying_ltp: undefined,
      });
      const env = makeEnv();
      const plan = computeDynamicExitPlan({
        trade,
        ltp: 100.1,
        underlyingLtp: null,
        nowTs: BASE_NOW + 6 * 60_000,
        env,
        candles: flatCandles(),
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.action?.reason, 'TIME_STOP_NO_PROGRESS');
      assert.equal(plan.meta?.noProgressUnderlyingConfirm, false);
      assert.equal(plan.meta?.noProgressUnderlyingStatus, 'BYPASSED');
    },
  },
  {
    name: 'max-hold triggers on low current pnl',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv({
        TIME_STOP_NO_PROGRESS_MIN: 0,
        TIME_STOP_MAX_HOLD_MIN: 10,
      });
      const { plans } = runFeed({
        trade,
        env,
        points: [{ min: 12, ltp: 101, underlyingLtp: 20005 }],
      });
      const plan = plans[0];
      assert.equal(plan.ok, true);
      assert.equal(plan.action?.reason, 'TIME_STOP_MAX_HOLD');
    },
  },
  {
    name: 'max-hold skipped on peak>=1R',
    run: () => {
      const trade = makeTrade({ peakPnlInr: 100 });
      const env = makeEnv({
        TIME_STOP_NO_PROGRESS_MIN: 0,
        TIME_STOP_MAX_HOLD_MIN: 10,
      });
      const plan = computeDynamicExitPlan({
        trade,
        ltp: 101,
        underlyingLtp: 20005,
        nowTs: BASE_NOW + 12 * 60_000,
        env,
        candles: [],
      });
      assert.equal(plan.ok, true);
      assert.equal(Boolean(plan.action?.exitNow), false);
      assert.equal(plan.meta?.maxHoldSkipReason, 'PEAK_R');
    },
  },
  {
    name: 'be-priority SL move remains forced until BE is broker-applied',
    run: () => {
      const trade = makeTrade({
        beLocked: true,
        beAppliedAt: null,
        stopLoss: 95,
        slTrigger: 95,
      });
      const env = makeEnv({
        BE_ARM_R: 0.1,
        DYN_STEP_TICKS_PRE_BE: 1000,
        DYN_STEP_TICKS_POST_BE: 1000,
      });
      const plan = computeDynamicExitPlan({
        trade,
        ltp: 106,
        marketQuote: { bid: 105.8, ask: 106.2, ltp: 106 },
        underlyingLtp: 20004,
        nowTs: BASE_NOW + 3 * 60_000,
        env,
        candles: [],
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.meta?.skipReason?.includes('be_priority_sl_move'), true);
      assert.equal(Number(plan.sl?.stopLoss) > Number(trade.stopLoss), true);
      assert.equal(Number(plan.meta?.desiredStopLoss) >= Number(plan.meta?.beFloor ?? 0), true);
    },
  },
  {
    name: 'profit lock arms at +1R and SL lock is valid',
    run: () => {
      const trade = makeTrade();
      const env = makeEnv({
        PROFIT_LOCK_ENABLED: 'true',
        PROFIT_LOCK_R: 1,
        PROFIT_LOCK_KEEP_R: 0.25,
      });
      const ltp = 110;
      const plan = computeDynamicExitPlan({
        trade,
        ltp,
        marketQuote: { bid: 109.8, ask: 110.2, ltp },
        underlyingLtp: 20010,
        nowTs: BASE_NOW + 2 * 60_000,
        env,
        candles: [],
      });
      assert.equal(plan.ok, true);
      assert.equal(Boolean(plan.tradePatch?.profitLockArmedAt), true);
      assert.equal(plan.tradePatch?.profitLockInr, 25);
      assert.equal(plan.tradePatch?.profitLockR, 0.25);
      assert.ok(Number(plan.meta?.desiredStopLoss) >= 102.5);
      assert.ok(Number(plan.meta?.desiredStopLoss) >= Number(plan.meta?.beFloor ?? 0));
      assert.ok(Number(plan.sl?.stopLoss) < ltp, 'SL trigger must stay below LTP for BUY');
      assert.ok(Number(plan.sl?.stopLoss) > trade.stopLoss, 'SL must tighten, not loosen');
    },
  },
  {
    name: 'latch prevents repeated alert patching',
    run: () => {
      const env = makeEnv();
      const initialTrade = makeTrade();
      const first = computeDynamicExitPlan({
        trade: initialTrade,
        ltp: 100.1,
        underlyingLtp: 20002,
        nowTs: BASE_NOW + 6 * 60_000,
        env,
        candles: [],
      });
      assert.equal(first.action?.reason, 'TIME_STOP_NO_PROGRESS');
      const latchedTrade = applyPlanPatch(initialTrade, first);
      const second = computeDynamicExitPlan({
        trade: latchedTrade,
        ltp: 100.1,
        underlyingLtp: 20002,
        nowTs: BASE_NOW + 7 * 60_000,
        env,
        candles: [],
      });
      assert.equal(Boolean(second.action?.exitNow), false);
      assert.equal(second.tradePatch?.timeStopTriggeredAt, undefined);
    },
  },
];

let passed = 0;
for (const s of scenarios) {
  try {
    s.run();
    passed += 1;
    console.log(`✅ ${s.name}`);
  } catch (err) {
    console.error(`❌ ${s.name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`\n${passed}/${scenarios.length} scenarios passed.`);
}
