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
  // Permission modes (MAR-4052): 0.27's readers, and 0.28's coded refusal.
  assert.equal(typeof loaded.decodeExecutionPermissionConfig, "function");
  assert.equal(typeof loaded.EXECUTION_INTERACTION_REQUEST_KINDS, "object");
  assert.equal(typeof loaded.decodeExecutionSessionPatchRefusal, "function");
  assert.deepEqual(loaded.EXECUTION_SESSION_PATCH_REFUSAL_STATUS, {
    "turn-running": 409,
    "unsupported-on-host": 400,
    "unsupported-for-provider": 400,
  });
  assert.equal(loaded.ExecutionSessionPatchError, undefined);
  assert.equal(typeof loaded.decodeExecutionHostProfile, "function");
  assert.equal(
    typeof loaded.decodeExecutionStartRequirementsRefusal,
    "function",
  );
  assert.equal(loaded.EXECUTION_START_REQUIREMENTS_UNMET, "requirements-unmet");
  assert.equal(typeof loaded.confirmsExecutionStartRequirements, "function");
  assert.equal(typeof loaded.checkExecutionInlineAttachments, "function");
  assert.equal(loaded.EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT, 4);
  assert.equal(loaded.EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH, 255);
  assert.equal(loaded.EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH, 255);
  assert.equal(loaded.EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT, 8);
  assert.equal(loaded.EXECUTION_INTERACTION_QUESTIONS_MAX_COUNT, 8);
  assert.equal(loaded.EXECUTION_INTERACTION_OPTIONS_MAX_COUNT, 16);
  assert.equal(loaded.EXECUTION_TOOL_ATTACHMENT_MAX_BYTES, 8_388_608);
  assert.equal(
    loaded.EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
    loaded.EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  );
  // The tool metadata readers are implementation details of the item codec.
  assert.equal(loaded.decodeToolAttachments, undefined);
  assert.equal(loaded.decodeToolAttachmentOmissions, undefined);
  // Shared guards are internal to the contract.
  assert.equal(loaded.isRecord, undefined);
  assert.equal(typeof loaded.decodeHarnessEvidence, "function");
  // The root is the contract: the client is reachable only by its subpath.
  assert.equal(loaded.createExecutionHostClient, undefined);
  assert.equal(loaded.readAttachmentBytes, undefined);
  assert.equal(loaded.readOrAbort, undefined);
}

const commonJsClient = require(`${packageName}/client`);
const esModuleClient = await import(`${packageName}/client`);

for (const loaded of [commonJsClient, esModuleClient]) {
  assert.equal(typeof loaded.createExecutionHostClient, "function");
  assert.equal(typeof loaded.ExecutionHostError, "function");
  assert.equal(typeof loaded.ExecutionStartRequirementsError, "function");
  assert.equal(typeof loaded.hostEnforcesStartRequirements, "function");
  assert.equal(typeof loaded.ExecutionInlineAttachmentsError, "function");
  assert.equal(typeof loaded.hostTakesInlineFiles, "function");
  assert.equal(typeof loaded.ExecutionInteractionResponseError, "function");
  assert.equal(typeof loaded.hostTakesStructuredInteractions, "function");
  assert.equal(typeof loaded.ExecutionSessionPatchError, "function");
  assert.equal(typeof loaded.hostTakesPermissionModes, "function");
  assert.equal(typeof loaded.decodeExecutionSessionSnapshot, "function");
  const client = loaded.createExecutionHostClient({
    baseUrl: "http://127.0.0.1:1",
    token: "check",
    fetch: async () => new Response(null, { status: 503 }),
  });
  assert.equal(typeof client.followSession, "function");
  assert.equal(typeof client.patchSession, "function");
  assert.equal(typeof client.providers, "function");
  assert.equal(typeof client.host, "function");
  assert.equal(typeof client.deleteSession, "function");
  assert.equal(typeof client.downloadAttachment, "function");
  assert.deepEqual(
    await client
      .downloadAttachment("s", "a")
      .catch((error) => ({ kind: error.kind, status: error.status })),
    { kind: "http", status: 503 },
  );
}

// One-shots (MAR-3775): the contract at the root, the method and its error on
// the client.
for (const loaded of [commonJs, esModule]) {
  assert.equal(typeof loaded.decodeExecutionOneShotResponse, "function");
  assert.equal(loaded.EXECUTION_ONESHOT_CONTRACT, "oneshot.v1");
}
for (const loaded of [commonJsClient, esModuleClient]) {
  assert.equal(typeof loaded.ExecutionOneShotError, "function");
  const client = loaded.createExecutionHostClient({
    baseUrl: "http://127.0.0.1:1",
    token: "check",
    fetch: async () => new Response(null, { status: 503 }),
  });
  assert.equal(typeof client.oneShot, "function");
}

// Task output (MAR-3981): the contract and its caps at the root, the method,
// its error and the capability check on the client.
for (const loaded of [commonJs, esModule]) {
  assert.equal(typeof loaded.decodeExecutionTaskOutputRequest, "function");
  assert.equal(typeof loaded.decodeExecutionTaskOutputResponse, "function");
  assert.equal(typeof loaded.decodeExecutionTaskOutputWindow, "function");
  assert.equal(typeof loaded.executionTaskOutputReadRange, "function");
  assert.equal(typeof loaded.executionSecretRedactionValues, "function");
  assert.equal(loaded.EXECUTION_TASK_OUTPUT_MAX_BYTES, 65_536);
  assert.ok(
    loaded.EXECUTION_PROTOCOL_CAPABILITY_IDS.includes("tasks.output.v1"),
  );
  assert.equal(loaded.ExecutionTaskOutputError, undefined);
}
for (const loaded of [commonJsClient, esModuleClient]) {
  assert.equal(typeof loaded.ExecutionTaskOutputError, "function");
  assert.equal(typeof loaded.hostReadsTaskOutput, "function");
  const client = loaded.createExecutionHostClient({
    baseUrl: "http://127.0.0.1:1",
    token: "check",
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal(
    await client
      .taskOutput("s", "t")
      .catch(
        (error) =>
          error instanceof loaded.ExecutionTaskOutputError && error.code,
      ),
    "unsupported",
  );
}

// Provider usage (MAR-4198): its capability and the shared window check at
// the root.
for (const loaded of [commonJs, esModule]) {
  assert.equal(typeof loaded.executionProviderUsageWindowLimits, "function");
  assert.ok(
    loaded.EXECUTION_PROTOCOL_CAPABILITY_IDS.includes("providers.usage.v1"),
  );
  assert.equal(loaded.EXECUTION_PROVIDER_USAGE_TEXT_MAX_LENGTH, 128);
}

console.log("Package exports resolve from CommonJS and ESM, root and client.");
