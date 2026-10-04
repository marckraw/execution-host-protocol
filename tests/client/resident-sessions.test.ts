import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  decodeExecutionSessionSnapshot,
  type ExecutionSessionFollow,
} from "../../src/client/index.js";
import type {
  ExecutionHostEvent,
  ExecutionSessionDelta,
} from "../../src/index.js";
import {
  conversationItemFixtures,
  evidenceFixtures,
} from "../fixtures/contract-fixtures.js";
import { followOn } from "./follow-recording.js";
import { createStubHost, type StubHost, waitFor } from "./stub-host.js";

/**
 * MAR-3679 through the client: a follower hears a session answer with its
 * tasks still running, the turn Claude Code opens by itself, the evidence,
 * and the items a subagent produced — and stops one task.
 */

let host: StubHost;
let follows: ExecutionSessionFollow[];

beforeEach(() => {
  host = createStubHost();
  follows = [];
});

afterEach(async () => {
  await Promise.all(follows.map((follow) => follow.stop()));
});

const client = () =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: host.fetch,
  });

const delta = (value: ExecutionSessionDelta): ExecutionHostEvent => ({
  kind: "delta",
  delta: value,
});

describe("following a resident session", () => {
  it("delivers answered, the running count, a harness turn, evidence and lineage, each as sent", async () => {
    const at = "2026-10-03T21:40:00.000Z";
    const events: ExecutionHostEvent[] = [
      delta({
        kind: "session.patch",
        patch: { status: "answered", runningTasks: 1 },
      }),
      delta({
        kind: "evidence",
        turnId: "turn-1",
        evidence: evidenceFixtures["task.changed"],
      }),
      delta({
        kind: "conversation.item.add",
        item: {
          ...conversationItemFixtures["tool-call"].value,
          agentRunId: "run-explore-1",
          taskId: "task-b7x2",
        },
      }),
      delta({
        kind: "session.patch",
        patch: { status: "running", runningTasks: 0 },
      }),
      delta({
        kind: "turn.add",
        turn: {
          id: "turn-2",
          sessionId: "session-1",
          sequence: 2,
          startedAt: at,
          endedAt: null,
          status: "running",
          summary: null,
          origin: "harness",
        },
      }),
      delta({
        kind: "evidence",
        turnId: null,
        evidence: evidenceFixtures["process.ended"],
      }),
    ];
    const sent = events.map((event) => host.emit(event));
    const recording = followOn(host, follows);
    await waitFor(() => recording.delivered.length === sent.length);

    expect(recording.delivered).toEqual(sent);
    expect(recording.skips).toEqual([]);
    expect(recording.gaps).toEqual([]);
  });

  it("steps over an evidence kind it does not know, without a gap", async () => {
    host.emit({ kind: "status", status: "answered" });
    host.emit(
      delta({
        kind: "evidence",
        turnId: "turn-1",
        // A newer host's fact, which this build has never heard of.
        evidence: { kind: "agent.paused", at: "now" } as never,
      }),
    );
    host.emit({ kind: "status", status: "completed" });
    const recording = followOn(host, follows);
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 3]);
    expect(recording.skips).toEqual([
      {
        reason: "unknown-kind",
        seq: 2,
        path: "event.delta.evidence.kind",
        kind: "agent.paused",
      },
    ]);
    expect(recording.gaps).toEqual([]);
  });
});

describe("stopping one task", () => {
  it("sends stop-task as a command, the session left alone", async () => {
    const result = await client().command(
      "session-1",
      { kind: "stop-task", taskId: "task-b7x2" },
      { commandId: "stop-b7x2" },
    );

    expect(result).toEqual({ status: "accepted", commandId: "stop-b7x2" });
    expect(host.commandRequests).toEqual([
      {
        sessionId: "session-1",
        body: {
          protocolVersion: 1,
          sessionId: "session-1",
          commandId: "stop-b7x2",
          command: { kind: "stop-task", taskId: "task-b7x2" },
        },
      },
    ]);
  });
});

describe("a resident session's snapshot", () => {
  const snapshot = {
    protocolVersion: 1,
    sessionId: "session-1",
    providerId: "claude",
    status: "answered",
    runningTasks: 2,
    conversation: [],
    turns: [
      {
        id: "turn-2",
        sessionId: "session-1",
        sequence: 2,
        startedAt: "2026-10-03T21:41:00.000Z",
        endedAt: null,
        status: "running",
        summary: null,
        origin: "harness",
      },
    ],
    lastSeq: 40,
  };

  it("reads answered, the running count, and each turn's origin", () => {
    const decoded = decodeExecutionSessionSnapshot(snapshot, "session-1");
    expect(decoded).toMatchObject({
      ok: true,
      value: {
        status: "answered",
        runningTasks: 2,
        turns: [{ ...snapshot.turns[0], fileChanges: [] }],
      },
    });
  });

  it("reads 0 from a host that does not say, and drops a count it cannot read", () => {
    const { runningTasks: _count, ...silent } = snapshot;
    void _count;
    expect(decodeExecutionSessionSnapshot(silent)).toMatchObject({
      ok: true,
      value: { runningTasks: 0 },
    });
    expect(
      decodeExecutionSessionSnapshot({ ...snapshot, runningTasks: -1 }),
    ).toMatchObject({
      ok: true,
      value: { runningTasks: 0 },
      warnings: [{ reason: "dropped-invalid-field", path: "runningTasks" }],
    });
  });
});
