import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionSessionPatchError,
} from "../../src/client/index.js";
import type {
  ExecutionPermissionConfig,
  ExecutionSessionPatchRequest,
} from "../../src/index.js";
import { createStubHost, HEALTH_BODY, type StubHost } from "./stub-host.js";

/** MAR-3662: the client's way to change a session's model and effort. */

let host: StubHost;

beforeEach(() => {
  host = createStubHost();
});

const client = (token = host.token) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token,
    fetch: host.fetch,
  });

describe("patching a session", () => {
  it("sends the patch as it is and reads what the host holds now", async () => {
    host.patchBody = (sessionId) => ({
      protocolVersion: 1,
      sessionId,
      model: "claude-opus-5-5",
      effort: "high",
    });

    const result = await client().patchSession("session-1", {
      model: "claude-opus-5-5",
      effort: "high",
    });

    expect(result).toEqual({
      status: "patched",
      sessionId: "session-1",
      model: "claude-opus-5-5",
      effort: "high",
    });
    expect(host.patchRequests).toEqual([
      {
        sessionId: "session-1",
        body: { model: "claude-opus-5-5", effort: "high" },
      },
    ]);
  });

  it("reads a host's title-only answer", async () => {
    host.patchBody = (sessionId, patch) => ({ sessionId, title: patch.title });
    expect(
      await client().patchSession("session-1", { title: "Staging banner" }),
    ).toEqual({
      status: "patched",
      sessionId: "session-1",
      title: "Staging banner",
    });
  });

  it("says when the host has no such session", async () => {
    expect(
      await client().patchSession("session-gone", { model: "opus" }),
    ).toEqual({ status: "no-session", sessionId: "session-gone" });
  });

  it("throws the host's refusal of a selection its catalog does not offer", async () => {
    host.patchStatus = 400;
    const refusal = await client()
      .patchSession("session-1", { model: "gpt-6" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({
      kind: "http",
      status: 400,
      operation: "patch session",
      reason: "Invalid session patch: claude has no model gpt-6",
    });
  });

  it("refuses a patch the protocol would refuse, before sending anything", async () => {
    for (const patch of [
      {},
      { model: "" },
      { effort: "e".repeat(257) },
      { model: "opus", providerId: "claude" },
      { permissionConfig: { preset: "full" } },
      { permissionConfig: { preset: "yolo", claudeCodee: {} } },
    ]) {
      await expect(
        client().patchSession(
          "session-1",
          patch as ExecutionSessionPatchRequest,
        ),
      ).rejects.toThrow(TypeError);
    }
    expect(host.patchRequests).toEqual([]);
  });

  it("refuses an answer about another session", async () => {
    host.patchBody = () => ({ protocolVersion: 1, sessionId: "session-2" });
    await expect(
      client().patchSession("session-1", { model: "opus" }),
    ).rejects.toMatchObject({ kind: "malformed", operation: "patch session" });
  });

  it("refuses a token the host refuses", async () => {
    await expect(
      client("wrong").patchSession("session-1", { model: "opus" }),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("changing a running session's mode (MAR-4052)", () => {
  const codexPlan: ExecutionPermissionConfig = {
    preset: "custom",
    codex: {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
      collaborationMode: "plan",
    },
  };
  // accent.'s FULL_ACCESS: full access, with every provider's part spelt out.
  const fullAccess: ExecutionPermissionConfig = {
    preset: "yolo",
    claudeCode: { permissionMode: "bypassPermissions" },
    codex: { approvalPolicy: "never", sandbox: "danger-full-access" },
  };

  const advertising = (capabilities: string[]) => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities },
    };
  };

  beforeEach(() => {
    advertising([
      ...HEALTH_BODY.executionProtocol.capabilities,
      "sessions.permissionModes.v1",
    ]);
  });

  const refusalOf = (patch: ExecutionSessionPatchRequest) =>
    client()
      .patchSession("session-1", patch)
      .catch((error: unknown) => error);

  it.each([
    ["Codex's plan with its reviewer", codexPlan, "next-turn"],
    ["accent.'s full access", fullAccess, "now"],
    ["custom with no part, which runs as ask", { preset: "custom" }, "now"],
  ] as const)(
    "sends %s as it is and reads the policy and when it applies",
    async (_name, permissionConfig, appliesFrom) => {
      host.patchBody = (sessionId, patch) => ({
        protocolVersion: 1,
        sessionId,
        permissionConfig: patch.permissionConfig,
        appliesFrom,
      });

      expect(
        await client().patchSession("session-1", { permissionConfig }),
      ).toEqual({
        status: "patched",
        sessionId: "session-1",
        permissionConfig,
        appliesFrom,
      });
      expect(host.patchRequests).toEqual([
        { sessionId: "session-1", body: { permissionConfig } },
      ]);
    },
  );

  it("refuses a mode on a host without sessions.permissionModes.v1, unsent", async () => {
    advertising(HEALTH_BODY.executionProtocol.capabilities);
    const refusal = await refusalOf({ permissionConfig: fullAccess });

    expect(refusal).toBeInstanceOf(ExecutionSessionPatchError);
    expect(refusal).not.toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({
      code: "unsupported-on-host",
      operation: "patch session",
      sessionId: "session-1",
      status: null,
    });
    expect((refusal as ExecutionSessionPatchError).reason).toContain(
      "sessions.permissionModes.v1",
    );
    expect(host.patchRequests).toEqual([]);
  });

  it("refuses a mode on a host whose descriptor is unreadable, unsent", async () => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: {
        version: 99,
        capabilities: ["sessions.permissionModes.v1"],
      },
    };
    const refusal = (await refusalOf({
      permissionConfig: fullAccess,
    })) as ExecutionSessionPatchError;
    expect(refusal.code).toBe("unsupported-on-host");
    expect(refusal.reason).toContain("descriptor is unreadable");
    expect(host.patchRequests).toEqual([]);
  });

  it("asks the host nothing first for a patch without a mode", async () => {
    advertising([]);
    await client().patchSession("session-1", { model: "opus" });
    expect(host.healthRequests).toEqual([]);
    expect(host.patchRequests).toHaveLength(1);
  });

  it.each([
    [409, "turn-running", "A turn is running; try again when it ends"],
    [400, "unsupported-on-host", "This session is not resident"],
    [400, "unsupported-for-provider", "claude has no collaborationMode"],
  ] as const)("throws the host's %i coded %s", async (status, code, error) => {
    host.patchStatus = status;
    host.patchRefusal = { error, code };
    const refusal = await refusalOf({ permissionConfig: codexPlan });

    expect(refusal).toBeInstanceOf(ExecutionSessionPatchError);
    expect(refusal).toMatchObject({
      code,
      status,
      reason: error,
      sessionId: "session-1",
    });
  });

  it("speaks for a coded refusal the host left without words", async () => {
    host.patchStatus = 409;
    host.patchRefusal = { code: "turn-running" };
    expect(await refusalOf({ permissionConfig: codexPlan })).toMatchObject({
      code: "turn-running",
      reason: "A turn is running; the mode can change once it ends",
    });
  });

  it.each([
    [
      "a code with another status",
      400,
      { error: "Busy", code: "turn-running" },
    ],
    ["a code it does not know", 409, { error: "Busy", code: "turn-busy" }],
    ["no code", 409, { error: "Busy" }],
  ])("leaves %s to the host's words", async (_name, status, body) => {
    host.patchStatus = status;
    host.patchRefusal = body;
    const refusal = await refusalOf({ permissionConfig: codexPlan });

    expect(refusal).toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({
      kind: "http",
      status,
      operation: "patch session",
      reason: "Busy",
    });
  });
});
