function createAdmissionLog() {
  const rows = [];

  function recordDecision(row) {
    rows.push({
      signalTs: row.signalTs || null,
      token: Number.isFinite(Number(row.token)) ? Number(row.token) : null,
      strategyId: row.strategyId || null,
      gate: row.gate || null,
      passed: Boolean(row.passed),
      reasonCode: row.reasonCode || null,
      message: row.message || null,
      details: row.details || null,
    });
  }

  function recordGateSet(base, decisions) {
    for (const decision of decisions || []) {
      recordDecision({
        ...base,
        ...decision,
      });
    }
  }

  return {
    recordDecision,
    recordGateSet,
    getRows() {
      return rows.slice();
    },
  };
}

module.exports = { createAdmissionLog };
