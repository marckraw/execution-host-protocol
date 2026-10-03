import assert from "node:assert/strict";
import { createRequire } from "node:module";

const packageName = "@mrck-labs/execution-host-protocol";
const require = createRequire(import.meta.url);

const commonJs = require(packageName);
const esModule = await import(packageName);

for (const loaded of [commonJs, esModule]) {
  assert.equal(loaded.EXECUTION_PROTOCOL_VERSION, 1);
  assert.equal(typeof loaded.decodeExecutionEventEnvelope, "function");
  assert.equal(typeof loaded.decodeExecutionCommandEnvelope, "function");
  assert.equal(typeof loaded.decodeExecutionSessionPatchRequest, "function");
  assert.equal(typeof loaded.decodeExecutionProviderListResponse, "function");
  // The root is the contract: the client is reachable only by its subpath.
  assert.equal(loaded.createExecutionHostClient, undefined);
}

const commonJsClient = require(`${packageName}/client`);
const esModuleClient = await import(`${packageName}/client`);

for (const loaded of [commonJsClient, esModuleClient]) {
  assert.equal(typeof loaded.createExecutionHostClient, "function");
  assert.equal(typeof loaded.ExecutionHostError, "function");
  assert.equal(typeof loaded.decodeExecutionSessionSnapshot, "function");
  const client = loaded.createExecutionHostClient({
    baseUrl: "http://127.0.0.1:1",
    token: "check",
    fetch: async () => new Response(null, { status: 503 }),
  });
  assert.equal(typeof client.followSession, "function");
  assert.equal(typeof client.patchSession, "function");
  assert.equal(typeof client.providers, "function");
  assert.equal(typeof client.deleteSession, "function");
}

console.log("Package exports resolve from CommonJS and ESM, root and client.");
