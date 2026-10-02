import { describe, expect, it } from "vitest";
import {
  decodeExecutionSessionSnapshot,
  parseExecutionHostHealth,
} from "../../src/client/index.js";
import { evaluateExecutionHostHandshake } from "../../src/client/health.js";
import {
  attributedUserMessageFixture,
  conversationItemFixtures,
  sessionWorkspaceFixtures,
} from "../fixtures/contract-fixtures.js";
import { HEALTH_BODY } from "./stub-host.js";

describe("reading /health", () => {
  it("reads a daemon's real answer, capabilities it does not know included", () => {
    const health = parseExecutionHostHealth(structuredClone(HEALTH_BODY));

    expect(health).toMatchObject({
      version: "0.26.1",
      apiVersion: "v0",
      uptimeSeconds: 437707,
      providers: { claude: true, cursor: false },
      providerReadiness: {
        claude: { installed: true, authenticated: true },
        gemini: { installed: false, authenticated: false },
      },
      executionProtocolValid: true,
    });
    expect(health?.capabilities).toContain("deltas.append.v1");
    expect(health?.capabilities).toContain("push.v1");
    expect(health?.raw.retention).toEqual({ sessionRetentionDays: 90 });
  });

  it("reads a host older than the descriptor as offering nothing, not as broken", () => {
    const { executionProtocol, ...older } = structuredClone(HEALTH_BODY);
    void executionProtocol;
    expect(parseExecutionHostHealth(older)).toMatchObject({
      executionProtocol: null,
      executionProtocolValid: true,
      capabilities: [],
    });
  });

  it("marks a descriptor it cannot read as incompatible", () => {
    expect(
      parseExecutionHostHealth({
        ...HEALTH_BODY,
        executionProtocol: { version: 2, capabilities: [] },
      }),
    ).toMatchObject({ executionProtocol: null, executionProtocolValid: false });
  });

  it("leaves out readiness it cannot read rather than guessing it", () => {
    expect(
      parseExecutionHostHealth({
        ...HEALTH_BODY,
        providerReadiness: { claude: { installed: true }, codex: "ready" },
      })?.providerReadiness,
    ).toEqual({});
  });

  it("refuses a body that is not a host's", () => {
    for (const body of [null, [], "ok", { status: "down" }, {}]) {
      expect(parseExecutionHostHealth(body)).toBeNull();
    }
  });
});

describe("judging a handshake", () => {
  const health = parseExecutionHostHealth(HEALTH_BODY)!;

  it("is connected only when the host answers, speaks v0, and takes the token", () => {
    expect(
      evaluateExecutionHostHandshake(health, null, { kind: "ok" }),
    ).toEqual({ status: "connected", health, detail: null });
  });

  it("names each other outcome", () => {
    expect(
      evaluateExecutionHostHandshake(null, "refused", { kind: "ok" }).status,
    ).toBe("unreachable");
    expect(
      evaluateExecutionHostHandshake(health, null, {
        kind: "http",
        status: 401,
      }).status,
    ).toBe("unauthorized");
    expect(
      evaluateExecutionHostHandshake(health, null, { kind: "no-token" }).status,
    ).toBe("unauthorized");
    expect(
      evaluateExecutionHostHandshake(health, null, {
        kind: "http",
        status: 502,
      }).status,
    ).toBe("unreachable");
    expect(
      evaluateExecutionHostHandshake({ ...health, apiVersion: "v1" }, null, {
        kind: "ok",
      }).status,
    ).toBe("incompatible");
    expect(
      evaluateExecutionHostHandshake(
        { ...health, executionProtocolValid: false },
        null,
        { kind: "ok" },
      ).status,
    ).toBe("incompatible");
  });
});

const turn = {
  id: "turn-1",
  sessionId: "session-1",
  sequence: 1,
  startedAt: "2026-10-02T10:00:00.000Z",
  endedAt: "2026-10-02T10:01:00.000Z",
  status: "completed",
  summary: null,
};
const fileChange = {
  id: "change-1",
  sessionId: "session-1",
  turnId: "turn-1",
  filePath: "src/index.ts",
  oldPath: null,
  status: "modified",
  additions: 2,
  deletions: 1,
  diff: "@@ -1 +1,2 @@",
  truncated: false,
  binary: false,
  createdAt: "2026-10-02T10:01:00.000Z",
};
const snapshot = {
  protocolVersion: 1,
  sessionId: "session-1",
  providerId: "claude",
  commandable: true,
  status: "completed",
  attention: "finished",
  activity: null,
  metadata: { source: { surface: "accent" } },
  continuationToken: "thread-1",
  contextWindow: null,
  conversation: [
    attributedUserMessageFixture.value,
    conversationItemFixtures.message.value,
  ],
  turns: [
    { ...turn, id: "turn-2", sequence: 2, fileChanges: [] },
    { ...turn, fileChanges: [fileChange] },
  ],
  lastSeq: 17,
  workspace: sessionWorkspaceFixtures.project.value,
  prUrl: "https://github.com/marckraw/new-blok/pull/7",
  roomId: null,
};

describe("reading a snapshot", () => {
  it("reads the daemon's projection, turns in order, by the contract's decoders", () => {
    const decoded = decodeExecutionSessionSnapshot(
      structuredClone(snapshot),
      "session-1",
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        ...snapshot,
        turns: [
          { ...turn, fileChanges: [fileChange] },
          { ...turn, id: "turn-2", sequence: 2, fileChanges: [] },
        ],
      },
    });
  });

  it("refuses an answer about another session", () => {
    expect(decodeExecutionSessionSnapshot(snapshot, "session-2")).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("refuses one without the frame a reader resumes from", () => {
    for (const broken of [
      { ...snapshot, protocolVersion: 2 },
      { ...snapshot, lastSeq: -1 },
      { ...snapshot, lastSeq: "17" },
      { ...snapshot, conversation: null },
      { ...snapshot, providerId: "" },
    ]) {
      expect(decodeExecutionSessionSnapshot(broken).ok).toBe(false);
    }
  });

  it("drops what it cannot read, says so, and keeps the rest", () => {
    const decoded = decodeExecutionSessionSnapshot({
      ...snapshot,
      status: "paused",
      prUrl: "javascript:alert(1)",
      conversation: [
        { ...conversationItemFixtures.note.value, kind: "image" },
        { id: "broken" },
        {
          ...attributedUserMessageFixture.value,
          author: { kind: "robot", id: "r", displayName: "R" },
        },
      ],
      turns: [
        { ...turn, fileChanges: [fileChange, { id: "half" }] },
        { id: 2 },
      ],
    });
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.value.status).toBe("idle");
    expect(decoded.value.prUrl).toBeNull();
    expect(decoded.value.conversation).toHaveLength(1);
    expect(decoded.value.conversation[0]).not.toHaveProperty("author");
    expect(decoded.value.turns).toEqual([
      { ...turn, fileChanges: [fileChange] },
    ]);
    expect(decoded.warnings?.map((warning) => warning.path)).toEqual([
      "conversation.0",
      "conversation.1",
      "conversation.2.author",
      "status",
      "turns.0.fileChanges.1",
      "turns.1",
      "prUrl",
    ]);
  });

  it("reads a host that predates turns, the work address, and rooms", () => {
    const {
      turns: _turns,
      workspace: _workspace,
      prUrl: _prUrl,
      roomId: _roomId,
      ...older
    } = snapshot;
    void [_turns, _workspace, _prUrl, _roomId];
    expect(decodeExecutionSessionSnapshot(older)).toMatchObject({
      ok: true,
      value: { turns: [], workspace: null, prUrl: null, roomId: null },
    });
  });
});
