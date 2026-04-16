const assert = require("node:assert/strict");
const path = require("node:path");

const pkg = require(path.join(__dirname, "..", "..", "package.json"));

const defaultTestScript = String(pkg?.scripts?.test || "");
const mainSafetyScript = String(pkg?.scripts?.["test:main-safety"] || "");

assert.match(defaultTestScript, /test:main-safety/);
assert.match(mainSafetyScript, /test:proexit/);
assert.match(mainSafetyScript, /test:runtime/);

console.log("mainTestFlow.test.js passed");
