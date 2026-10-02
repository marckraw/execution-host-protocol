import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
} from "../../src/client/index.js";
import type { ExecutionSessionPatchRequest } from "../../src/index.js";
import { createStubHost, type StubHost } from "./stub-host.js";

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
