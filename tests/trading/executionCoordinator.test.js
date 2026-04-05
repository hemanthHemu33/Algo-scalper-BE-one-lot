const assert = require("node:assert/strict");
const { ExecutionCoordinator } = require("../../src/trading/executionCoordinator");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testReconcileAndOrderUpdateSerializePerTrade() {
  const coordinator = new ExecutionCoordinator();
  const events = [];
  let inFlight = 0;

  const reconcilePromise = coordinator.run(
    { key: "T-1", type: "RECONCILE_DIFF_RESOLUTION" },
    async () => {
      events.push("reconcile-start");
      inFlight += 1;
      assert.equal(inFlight, 1);
      await sleep(30);
      inFlight -= 1;
      events.push("reconcile-end");
    },
  );

  await sleep(5);

  const orderPromise = coordinator.run(
    { key: "T-1", type: "APPLY_ORDER_UPDATE" },
    async () => {
      events.push("order-start");
      assert.equal(inFlight, 0);
      inFlight += 1;
      await sleep(5);
      inFlight -= 1;
      events.push("order-end");
    },
  );

  await Promise.all([reconcilePromise, orderPromise]);

  assert.deepEqual(events, [
    "reconcile-start",
    "reconcile-end",
    "order-start",
    "order-end",
  ]);
}

async function testProtectionAndPanicSerializePerTrade() {
  const coordinator = new ExecutionCoordinator();
  const events = [];

  await coordinator.run({ key: "T-2", type: "ADJUST_PROTECTION" }, async () => {
    events.push("protect-start");
    await coordinator.run({ key: "T-2", type: "PANIC_EXIT" }, async () => {
      events.push("panic-inline");
    });
    events.push("protect-end");
  });

  assert.deepEqual(events, ["protect-start", "panic-inline", "protect-end"]);
}

async function main() {
  await testReconcileAndOrderUpdateSerializePerTrade();
  await testProtectionAndPanicSerializePerTrade();
  console.log("executionCoordinator.test.js passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
