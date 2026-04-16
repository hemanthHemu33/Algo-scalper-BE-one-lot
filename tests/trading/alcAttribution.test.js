const assert = require("node:assert/strict");

const { deriveAlcAttribution } = require("../../src/trading/alcAttribution");

const nonAlcTighter = deriveAlcAttribution({
  side: "BUY",
  entryPrice: 100,
  initialStopLoss: 90,
  executionRiskInr: 1000,
  loserCompressionTargetState: "L1",
  loserCompressionSubmittedState: "L1",
  loserCompressionAppliedState: "NONE",
  loserCompressionLastRequestedStop: 94.5,
  protectedStopSource: "GREEN_LOCK",
  stopLoss: 96,
  brokerStopLoss: 96,
});

assert.equal(nonAlcTighter.alcRequested, true);
assert.equal(nonAlcTighter.alcRequestedLevel, "L1");
assert.equal(nonAlcTighter.alcAppliedConfirmed, false);
assert.equal(nonAlcTighter.alcAppliedLevel, null);
assert.equal(nonAlcTighter.alcAppliedSource, null);
assert.equal(nonAlcTighter.alcSavedRiskR, null);

const confirmedThenWinner = deriveAlcAttribution({
  side: "BUY",
  entryPrice: 100,
  initialStopLoss: 90,
  executionRiskInr: 1000,
  loserCompressionTargetState: "L2",
  loserCompressionSubmittedState: "L2",
  loserCompressionAppliedState: "L2",
  loserCompressionAppliedSource: "ALC_L2",
  loserCompressionAppliedConfirmed: true,
  loserCompressionAttributionConfidence: "HIGH",
  loserCompressionLastConfirmedStop: 95,
  protectedStopSource: "GREEN_LOCK",
});

assert.equal(confirmedThenWinner.alcRequested, true);
assert.equal(confirmedThenWinner.alcAppliedConfirmed, true);
assert.equal(confirmedThenWinner.alcAppliedLevel, "L2");
assert.equal(confirmedThenWinner.alcAppliedSource, "ALC_L2");
assert.equal(confirmedThenWinner.alcAppliedButSuperseded, true);
assert.equal(confirmedThenWinner.alcSupersededBy, "GREEN_LOCK");
assert.equal(confirmedThenWinner.alcFinalProtectionOwner, "GREEN_LOCK");
assert.equal(confirmedThenWinner.alcSavedRiskR, 0.5);
assert.equal(confirmedThenWinner.alcSavedRiskInr, 500);

const requestedOnly = deriveAlcAttribution({
  side: "SELL",
  entryPrice: 100,
  initialStopLoss: 110,
  executionRiskInr: 1000,
  loserCompressionTargetState: "L2",
  loserCompressionSubmittedState: "L2",
  loserCompressionAppliedState: "NONE",
  loserCompressionRetryCount: 2,
});

assert.equal(requestedOnly.alcRequested, true);
assert.equal(requestedOnly.alcRequestedLevel, "L2");
assert.equal(requestedOnly.alcAppliedConfirmed, false);
assert.equal(requestedOnly.alcRequestedButNotApplied, true);

const alcExitOwned = deriveAlcAttribution({
  side: "BUY",
  entryPrice: 100,
  initialStopLoss: 90,
  executionRiskInr: 1000,
  loserCompressionAppliedState: "EXIT",
  loserCompressionAppliedConfirmed: true,
  loserCompressionAppliedSource: "ALC_EXIT_NOW",
  loserExitTriggered: true,
  loserExitReasonCode: "ALC_EXIT_NOW",
  exitReasonCode: "ALC_EXIT_NOW",
  exitAuthority: "ADAPTIVE_LOSER_ENGINE",
  exitPrice: 96,
});

assert.equal(alcExitOwned.alcAppliedLevel, "EXIT");
assert.equal(alcExitOwned.alcAppliedSource, "ALC_EXIT_NOW");
assert.equal(alcExitOwned.alcFinalProtectionOwner, "ALC_EXIT_NOW");
assert.equal(alcExitOwned.alcAppliedButSuperseded, false);
assert.equal(alcExitOwned.alcSupersededBy, null);

const nonAlcGenericExit = deriveAlcAttribution({
  side: "BUY",
  entryPrice: 100,
  initialStopLoss: 90,
  executionRiskInr: 1000,
  exitReasonCode: "PANIC_EXIT",
  exitAuthority: "PANIC_EXIT_ENGINE",
});

assert.equal(nonAlcGenericExit.alcFinalProtectionOwner, "PANIC_EXIT_ENGINE");

console.log("alcAttribution.test.js passed");
