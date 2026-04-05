const assert = require("node:assert/strict");
const { env: configEnv } = require("../../src/config");
const { computeDynamicExitPlan } = require("../../src/trading/dynamicExitManager");
const { BASE_NOW, makeTrade, makeEnv, flatCandles, applyPlanPatch } = require("./_helpers");

const env = makeEnv();
const legacyGivebackKeys = [
  "GIVEBACK_CAP_ENABLED",
  "GIVEBACK_CAP_MIN_PEAK_R",
  "GIVEBACK_CAP_R",
  "GIVEBACK_EXIT_ENABLED",
  "GIVEBACK_EXIT_AT_PEAK_R",
  "GIVEBACK_EXIT_R",
  "GIVEBACK_HARD_DEFENSE_PEAK_R",
  "GIVEBACK_HARD_DEFENSE_KEEP_PCT",
];

function evalPlan(trade, ltp, offsetMs, envOverride = env) {
  return computeDynamicExitPlan({
    trade,
    ltp,
    candles: flatCandles(),
    nowTs: BASE_NOW + offsetMs,
    env: envOverride,
  });
}

for (const key of legacyGivebackKeys) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(configEnv, key),
    false,
    `${key} should not remain in the active config surface`,
  );
}

let trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 110.6, 60_000));
const belowThreshold = evalPlan(trade, 107.8, 61_000);
assert.equal(belowThreshold.ok, true);
assert.equal(Boolean(belowThreshold.shouldExitNow), false);
assert.equal(Boolean(belowThreshold.meta?.hardGivebackExitArmed), false);

trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 110.6, 60_000));
const noisyArm = evalPlan(trade, 107.2, 61_000);
assert.equal(noisyArm.ok, true);
assert.equal(Boolean(noisyArm.shouldExitNow), false);
assert.equal(Boolean(noisyArm.meta?.hardGivebackExitArmed), true);
assert.equal(noisyArm.meta?.hardGivebackRule, "RULE_A");
assert.equal(Number(noisyArm.meta?.hardGivebackConfirmTicks ?? 0), 1);
assert.equal(Number(noisyArm.meta?.hardGivebackConfirmTarget ?? 0), 2);
assert.equal(
  noisyArm.meta?.hardGivebackArmedAt,
  new Date(BASE_NOW + 61_000).toISOString(),
);
assert.equal(Number(noisyArm.tradePatch?.hardGivebackConfirmTicks ?? 0), 1);
trade = applyPlanPatch(trade, noisyArm);
const noisyRecover = evalPlan(trade, 109.9, 62_000);
assert.equal(Boolean(noisyRecover.shouldExitNow), false);
assert.equal(Boolean(noisyRecover.meta?.hardGivebackExitArmed), false);
assert.equal(Number(noisyRecover.tradePatch?.hardGivebackConfirmTicks ?? 0), 0);
assert.equal(Number(noisyRecover.meta?.givebackConfirmMs ?? 0), 0);
assert.equal(noisyRecover.meta?.hardGivebackArmedAt ?? null, null);
assert.equal(noisyRecover.action, null);
assert.equal(noisyRecover.shouldExitNowReason ?? null, null);
trade = applyPlanPatch(trade, noisyRecover);
const rearmAfterRecover = evalPlan(trade, 107.2, 63_000);
assert.equal(Boolean(rearmAfterRecover.meta?.hardGivebackExitArmed), true);
assert.equal(Number(rearmAfterRecover.meta?.hardGivebackConfirmTicks ?? 0), 1);
assert.equal(
  rearmAfterRecover.meta?.hardGivebackArmedAt,
  new Date(BASE_NOW + 63_000).toISOString(),
);

trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 110.6, 60_000));
const confirmA1 = evalPlan(trade, 107.2, 61_000);
assert.equal(Boolean(confirmA1.shouldExitNow), false);
trade = applyPlanPatch(trade, confirmA1);
const confirmA2 = evalPlan(trade, 107.0, 62_000);
assert.equal(Boolean(confirmA2.shouldExitNow), true);
assert.equal(confirmA2.action?.reason, "GIVEBACK_CAP");
assert.equal(confirmA2.meta?.hardGivebackRule, "RULE_A");

trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 113.0, 60_000));
const confirmB1 = evalPlan(trade, 109.5, 61_000);
assert.equal(Boolean(confirmB1.shouldExitNow), false);
assert.equal(Boolean(confirmB1.meta?.hardGivebackExitArmed), true);
assert.equal(confirmB1.meta?.hardGivebackRule, "RULE_B");
assert.equal(Number(confirmB1.tradePatch?.hardGivebackConfirmTicks ?? 0), 1);
trade = applyPlanPatch(trade, confirmB1);
const confirmB2 = evalPlan(trade, 109.4, 62_000);
assert.equal(Boolean(confirmB2.shouldExitNow), true);
assert.equal(Boolean(confirmB2.meta?.hardGivebackExitArmed), true);
assert.equal(confirmB2.meta?.hardGivebackRule, "RULE_B");
assert.equal(Number(confirmB2.tradePatch?.hardGivebackConfirmTicks ?? 0), 2);
assert.equal(confirmB2.action?.reason, "GIVEBACK_CAP");
assert.equal(confirmB2.sl, null);

trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 116.0, 60_000));
const confirmC1 = evalPlan(trade, 110.8, 61_000);
assert.equal(Boolean(confirmC1.shouldExitNow), false);
assert.equal(confirmC1.meta?.hardGivebackRule, "RULE_C");
trade = applyPlanPatch(trade, confirmC1);
const confirmC2 = evalPlan(trade, 110.7, 62_000);
assert.equal(Boolean(confirmC2.shouldExitNow), true);
assert.equal(confirmC2.action?.reason, "GIVEBACK_CAP");
assert.equal(confirmC2.meta?.hardGivebackRule, "RULE_C");

const timeConfirmEnv = makeEnv({
  EXIT_HARD_GIVEBACK_CONFIRM_MS: 800,
  EXIT_HARD_GIVEBACK_CONFIRM_TICKS: 3,
});
trade = makeTrade();
trade = applyPlanPatch(trade, evalPlan(trade, 110.6, 60_000, timeConfirmEnv));
const confirmMs1 = evalPlan(trade, 107.2, 61_000, timeConfirmEnv);
assert.equal(Boolean(confirmMs1.shouldExitNow), false);
assert.equal(Boolean(confirmMs1.meta?.hardGivebackExitArmed), true);
assert.equal(Number(confirmMs1.tradePatch?.hardGivebackConfirmTicks ?? 0), 1);
assert.equal(Number(confirmMs1.meta?.givebackConfirmMs ?? 0), 0);
trade = applyPlanPatch(trade, confirmMs1);
const confirmMs2 = evalPlan(trade, 107.1, 61_500, timeConfirmEnv);
assert.equal(Boolean(confirmMs2.shouldExitNow), false);
assert.equal(Number(confirmMs2.tradePatch?.hardGivebackConfirmTicks ?? 0), 2);
assert.ok(Number(confirmMs2.meta?.givebackConfirmMs ?? 0) < 800);
trade = applyPlanPatch(trade, confirmMs2);
const confirmMs3 = evalPlan(trade, 107.0, 61_900, timeConfirmEnv);
assert.equal(Boolean(confirmMs3.shouldExitNow), true);
assert.equal(confirmMs3.meta?.hardGivebackRule, "RULE_A");
assert.equal(Number(confirmMs3.tradePatch?.hardGivebackConfirmTicks ?? 0), 3);
assert.ok(Number(confirmMs3.meta?.givebackConfirmMs ?? 0) >= 800);
assert.equal(confirmMs3.action?.reason, "GIVEBACK_CAP");

const escalationEnv = makeEnv({
  EXIT_HARD_GIVEBACK_CONFIRM_MS: 999_999,
  EXIT_HARD_GIVEBACK_CONFIRM_TICKS: 3,
});
trade = makeTrade({
  peakLtp: 110.6,
  peakPnlInr: 106,
  peakExecutablePnlInr: 106,
});
const escalateA1 = evalPlan(trade, 107.2, 61_000, escalationEnv);
assert.equal(Boolean(escalateA1.shouldExitNow), false);
assert.equal(escalateA1.meta?.hardGivebackRule, "RULE_A");
assert.equal(Number(escalateA1.meta?.hardGivebackConfirmTicks ?? 0), 1);
const episodeArmedAtA = escalateA1.meta?.hardGivebackArmedAt;
trade = applyPlanPatch(trade, escalateA1);
trade = {
  ...trade,
  peakLtp: 113.0,
  peakPnlInr: 130,
  peakExecutablePnlInr: 130,
};
const escalateB2 = evalPlan(trade, 109.4, 62_000, escalationEnv);
assert.equal(Boolean(escalateB2.shouldExitNow), false);
assert.equal(escalateB2.meta?.hardGivebackRule, "RULE_B");
assert.equal(Number(escalateB2.meta?.hardGivebackConfirmTicks ?? 0), 2);
assert.equal(Number(escalateB2.meta?.hardGivebackConfirmTarget ?? 0), 3);
assert.equal(escalateB2.meta?.hardGivebackArmedAt, episodeArmedAtA);

trade = makeTrade({
  peakLtp: 113.0,
  peakPnlInr: 130,
  peakExecutablePnlInr: 130,
});
const escalateB1 = evalPlan(trade, 109.4, 61_000, escalationEnv);
assert.equal(Boolean(escalateB1.shouldExitNow), false);
assert.equal(escalateB1.meta?.hardGivebackRule, "RULE_B");
assert.equal(Number(escalateB1.meta?.hardGivebackConfirmTicks ?? 0), 1);
const episodeArmedAtB = escalateB1.meta?.hardGivebackArmedAt;
trade = applyPlanPatch(trade, escalateB1);
trade = {
  ...trade,
  peakLtp: 116.0,
  peakPnlInr: 160,
  peakExecutablePnlInr: 160,
};
const escalateC2 = evalPlan(trade, 111.0, 62_000, escalationEnv);
assert.equal(Boolean(escalateC2.shouldExitNow), false);
assert.equal(escalateC2.meta?.hardGivebackRule, "RULE_C");
assert.equal(Number(escalateC2.meta?.hardGivebackConfirmTicks ?? 0), 2);
assert.equal(Number(escalateC2.meta?.hardGivebackConfirmTarget ?? 0), 3);
assert.equal(escalateC2.meta?.hardGivebackArmedAt, episodeArmedAtB);

console.log("givebackCap.test.js passed");
