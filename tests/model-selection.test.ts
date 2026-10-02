import { describe, expect, it } from "vitest";
import { decodeExecutionSessionSnapshot } from "../src/client/index.js";
import {
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionEventEnvelope,
  decodeExecutionSessionPatchRequest,
  decodeExecutionSessionPatchResponse,
  encodeExecutionEventEnvelope,
  encodeExecutionSessionPatchRequest,
  type ExecutionHostEventEnvelope,
  type ExecutionSessionPatchRequest,
} from "../src/index.js";

/**
 * MAR-3662: a session's model and effort change between turns. The patch that
 * asks for it, the host's answer, the `session.patch` that tells followers, and
 * the snapshot that says what the next turn runs on.
 */

const sessionPatch = (patch: Record<string, unknown>, seq = 9) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "accent_8f2c",
    seq,
    event: { kind: "delta", delta: { kind: "session.patch", patch } },
  });

describe("the capability", () => {
  it("is a known id", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "sessions.modelSelection.v1",
    );
  });
});

describe("a session patch (MAR-3662)", () => {
  const patches: Array<[string, ExecutionSessionPatchRequest]> = [
    ["a model and an effort", { model: "claude-opus-5-5", effort: "high" }],
    ["the provider's default model", { model: null }],
    ["an effort alone", { effort: "max" }],
    ["the model's default effort", { effort: null }],
    ["a title alone", { title: "Staging banner" }],
    ["a cleared title", { title: null }],
    [
      "a title and a selection",
      { title: "Staging banner", model: "sonnet", effort: "medium" },
    ],
  ];

  it.each(patches)("round-trips %s", (_name, patch) => {
    expect(
      decodeExecutionSessionPatchRequest(
        encodeExecutionSessionPatchRequest(patch),
      ),
    ).toEqual({ ok: true, value: patch });
  });

  it("reads a body exactly as sent, with nothing added", () => {
    expect(
      decodeExecutionSessionPatchRequest('{"model":"opus","effort":"high"}'),
    ).toEqual({ ok: true, value: { model: "opus", effort: "high" } });
  });

  const refused: Array<[string, unknown]> = [
    ["an empty patch", {}],
    ["a misspelt field", { model: "opus", modle: "sonnet" }],
    ["a field from another request", { model: "opus", providerId: "claude" }],
    ["a protocol version", { protocolVersion: 1, model: "opus" }],
    ["an empty model", { model: "" }],
    ["a numeric model", { model: 5 }],
    ["a model over 256 characters", { model: "m".repeat(257) }],
    ["an empty effort", { effort: "" }],
    ["a boolean effort", { effort: false }],
    ["an effort over 256 characters", { effort: "e".repeat(257) }],
    ["a numeric title", { title: 5 }],
    ["an array", ["opus"]],
    ["a bare model", "opus"],
    ["null", null],
  ];

  it.each(refused)("refuses %s", (_name, body) => {
    expect(decodeExecutionSessionPatchRequest(JSON.stringify(body))).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("refuses a body that is not JSON", () => {
    expect(decodeExecutionSessionPatchRequest("{model: opus}")).toEqual({
      ok: false,
      reason: "malformed-json",
    });
  });

  it("takes a model at the bound", () => {
    expect(
      decodeExecutionSessionPatchRequest(
        JSON.stringify({ model: "m".repeat(256) }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe("the host's answer to a session patch (MAR-3662)", () => {
  it("reads a selection answer and ignores fields it does not know", () => {
    expect(
      decodeExecutionSessionPatchResponse({
        protocolVersion: 1,
        sessionId: "accent_8f2c",
        model: "claude-opus-5-5",
        effort: null,
        appliesFrom: "next-turn",
      }),
    ).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "accent_8f2c",
        model: "claude-opus-5-5",
        effort: null,
      },
    });
  });

  it("reads the title-only answer every host gives", () => {
    expect(
      decodeExecutionSessionPatchResponse({
        sessionId: "accent_8f2c",
        title: "Staging banner",
      }),
    ).toEqual({
      ok: true,
      value: { sessionId: "accent_8f2c", title: "Staging banner" },
    });
  });

  it("refuses an answer it cannot read", () => {
    expect(
      decodeExecutionSessionPatchResponse({
        protocolVersion: 2,
        sessionId: "accent_8f2c",
      }),
    ).toEqual({ ok: false, reason: "unsupported-protocol-version" });
    for (const broken of [
      { model: "opus" },
      { sessionId: "", model: "opus" },
      { sessionId: "accent_8f2c", model: "" },
      { sessionId: "accent_8f2c", effort: 5 },
      { sessionId: "accent_8f2c", title: 5 },
      "accent_8f2c",
    ]) {
      expect(decodeExecutionSessionPatchResponse(broken)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    }
  });
});

describe("followers hear the change in session.patch (MAR-3662)", () => {
  it("round-trips a selection, a default included", () => {
    for (const patch of [
      { model: "claude-opus-5-5", effort: "high" },
      { model: null, effort: null },
    ]) {
      const envelope: ExecutionHostEventEnvelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "accent_8f2c",
        seq: 9,
        event: { kind: "delta", delta: { kind: "session.patch", patch } },
      };
      expect(
        decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(envelope)),
      ).toEqual({ ok: true, value: envelope });
    }
  });

  it("refuses a selection that is not one, as it refuses any field it cannot read", () => {
    for (const patch of [
      { model: "", effort: "high" },
      { model: 5, effort: "high" },
      { model: "opus", effort: {} },
    ]) {
      expect(decodeExecutionEventEnvelope(sessionPatch(patch))).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    }
  });

  it("leaves a patch without a selection as it was", () => {
    expect(
      decodeExecutionEventEnvelope(sessionPatch({ roomId: "room-1" })),
    ).toMatchObject({
      ok: true,
      value: {
        event: {
          delta: { kind: "session.patch", patch: { roomId: "room-1" } },
        },
      },
    });
  });
});

describe("the snapshot says what the next turn runs on (MAR-3662)", () => {
  const snapshot = {
    protocolVersion: 1,
    sessionId: "accent_8f2c",
    providerId: "claude",
    model: "claude-opus-5-5",
    effort: "medium",
    commandable: true,
    status: "idle",
    attention: "none",
    activity: null,
    metadata: null,
    continuationToken: "thread-1",
    contextWindow: null,
    conversation: [],
    turns: [],
    lastSeq: 12,
    workspace: null,
    prUrl: null,
    roomId: null,
  };

  it("reads the model and effort, defaults included", () => {
    expect(decodeExecutionSessionSnapshot(snapshot)).toMatchObject({
      ok: true,
      value: { model: "claude-opus-5-5", effort: "medium" },
    });
    const defaults = decodeExecutionSessionSnapshot({
      ...snapshot,
      model: null,
      effort: null,
    });
    expect(defaults).toMatchObject({
      ok: true,
      value: { model: null, effort: null },
    });
  });

  it("keeps a host that does not say apart from one that says the default", () => {
    const { model: _model, effort: _effort, ...older } = snapshot;
    void [_model, _effort];
    const decoded = decodeExecutionSessionSnapshot(older);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value).not.toHaveProperty("model");
    expect(decoded.value).not.toHaveProperty("effort");
    expect(decoded.warnings).toBeUndefined();
  });

  it("drops a selection it cannot read, and says so", () => {
    const decoded = decodeExecutionSessionSnapshot({
      ...snapshot,
      model: "",
      effort: 3,
    });
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.value).not.toHaveProperty("model");
    expect(decoded.value).not.toHaveProperty("effort");
    expect(decoded.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "model" },
      { reason: "dropped-invalid-field", path: "effort" },
    ]);
  });
});
