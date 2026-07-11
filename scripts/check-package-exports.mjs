import assert from "node:assert/strict";
import { createRequire } from "node:module";

const packageName = "@marckraw/execution-host-protocol";
const require = createRequire(import.meta.url);

const commonJs = require(packageName);
const esModule = await import(packageName);

for (const loaded of [commonJs, esModule]) {
  assert.equal(loaded.EXECUTION_PROTOCOL_VERSION, 1);
  assert.equal(typeof loaded.decodeExecutionEventEnvelope, "function");
  assert.equal(typeof loaded.decodeExecutionCommandEnvelope, "function");
}

console.log("Package exports resolve from CommonJS and ESM.");
