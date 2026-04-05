const { RiskGovernor, createRiskGovernor } = require("./riskGovernor");

module.exports = {
  CapitalSimulator: RiskGovernor,
  createCapitalSimulator: createRiskGovernor,
};
