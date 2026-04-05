const assert = require("node:assert/strict");
const {
  buildContractSelectionObservability,
} = require("../../src/fno/optionsRouter");

function testNegativeRankingScoreIsExplicitlyExplained() {
  const observability = buildContractSelectionObservability({
    score: -12.4,
    ok: true,
    hardOk: true,
  });

  assert.equal(observability.ok, true);
  assert.equal(observability.eligibilityPassed, true);
  assert.equal(observability.minEligibilityChecksPassed, true);
  assert.equal(observability.rankingScore, -12.4);
  assert.equal(observability.rankingScoreSemantics, "LOWER_IS_BETTER");
  assert.equal(observability.selectedByFallback, false);
  assert.equal(observability.selectedReason, "PRIMARY_ELIGIBLE");
}

function testFallbackSelectionFlagsOverridePath() {
  const observability = buildContractSelectionObservability(
    {
      score: 18.2,
      ok: false,
      hardOk: true,
    },
    {
      selectedByFallback: true,
      fallbackReason: "PREMIUM_BAND_ONLY",
    },
  );

  assert.equal(observability.ok, false);
  assert.equal(observability.eligibilityPassed, false);
  assert.equal(observability.minEligibilityChecksPassed, true);
  assert.equal(observability.selectedByFallback, true);
  assert.equal(observability.fallbackReason, "PREMIUM_BAND_ONLY");
  assert.equal(observability.selectedReason, "FALLBACK_PREMIUM_BAND_ONLY");
}

function main() {
  testNegativeRankingScoreIsExplicitlyExplained();
  testFallbackSelectionFlagsOverridePath();
  console.log("optionsRouterObservability.test.js passed");
}

main();
