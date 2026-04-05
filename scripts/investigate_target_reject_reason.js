#!/usr/bin/env node
const { connectMongo, closeMongo } = require('../src/db');

function parseArgs(argv) {
  const args = { orderId: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--orderId' || a === '--order-id') && argv[i + 1]) {
      args.orderId = String(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

(async function run() {
  const { orderId } = parseArgs(process.argv);
  if (!orderId) {
    console.error('Usage: node scripts/investigate_target_reject_reason.js --orderId <order_id>');
    process.exit(1);
  }

  try {
    const { db } = await connectMongo();
    const logs = db.collection('order_logs');

    const firstSeen = await logs.find({ order_id: orderId }).sort({ createdAt: 1 }).limit(1).next();
    const firstRejected = await logs
      .find({ order_id: orderId, status: 'REJECTED' })
      .sort({ createdAt: 1 })
      .limit(1)
      .next();

    if (!firstSeen) {
      console.log(JSON.stringify({ ok: false, orderId, reason: 'ORDER_NOT_FOUND_IN_ORDER_LOGS' }, null, 2));
      return;
    }

    const payload = {
      ok: true,
      orderId,
      firstSeen: {
        createdAt: firstSeen.createdAt || null,
        status: firstSeen.status || null,
        status_message: firstSeen.status_message || null,
        status_message_raw: firstSeen.status_message_raw || null,
      },
      firstRejected: firstRejected
        ? {
            createdAt: firstRejected.createdAt || null,
            status: firstRejected.status || null,
            status_message: firstRejected.status_message || null,
            status_message_raw: firstRejected.status_message_raw || null,
          }
        : null,
    };

    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          orderId,
          reason: 'DB_LOOKUP_FAILED',
          error: err?.message || String(err),
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
  } finally {
    await closeMongo().catch(() => {});
  }
})();
