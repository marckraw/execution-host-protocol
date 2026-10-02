import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executionRetryDelayMs,
  type ExecutionFollowOptions,
  type ExecutionSessionFollow,
} from "../../src/client/index.js";
import { followOn, type Recording } from "./follow-recording.js";
import { createStubHost, type StubHost, waitFor } from "./stub-host.js";

let host: StubHost;
let follows: ExecutionSessionFollow[];

beforeEach(() => {
  host = createStubHost();
  follows = [];
});

afterEach(async () => {
  await Promise.all(follows.map((follow) => follow.stop()));
});

/** Follows session-1 on the stub, recording everything the follow says. */
const follow = (
  options: Partial<ExecutionFollowOptions> = {},
  token = host.token,
): Recording => followOn(host, follows, options, token);

const lastEventIds = () =>
  host.eventsRequests.map((request) => request.lastEventId);

describe("followSession", () => {
  it("keeps following when a turn finishes: the next turn may be anybody's", async () => {
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "completed" });
    host.emit({ kind: "attention", attention: "finished" });
    const recording = follow();
    await waitFor(() => recording.delivered.length === 3);

    // Quiet between turns; then someone else writes, and the session runs again.
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "thinking" });
    await waitFor(() => recording.delivered.length === 5);

    expect(recording.seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(recording.follow.lastSeq).toBe(5);
    expect(host.eventsRequests).toHaveLength(1);
    expect(host.openStreams()).toBe(1);
  });

  it("resumes after the last envelope it kept when the host closes the stream", async () => {
    const recording = follow({ afterSeq: 0 });
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(() => recording.delivered.length === 2);

    host.closeStreams();
    await waitFor(
      () => host.eventsRequests.length === 2 && host.openStreams() === 1,
    );
    host.emit({ kind: "status", status: "completed" });
    await waitFor(() => recording.delivered.length === 3);

    expect(lastEventIds()).toEqual([null, "2"]);
    expect(recording.seqs()).toEqual([1, 2, 3]);
  });

  it("reconnects with growing waits while the host keeps failing, and resets once it delivers", async () => {
    host.eventsStatus = 503;
    const recording: Recording = follow({
      retryDelayMs: (attempt) => {
        recording.delays.push(attempt);
        // The host recovers after the third wait.
        if (recording.delays.length === 3) host.eventsStatus = 200;
        return 0;
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    await waitFor(() => recording.delivered.length === 1);
    host.breakStreams();
    await waitFor(
      () => recording.delays.length === 4 && host.openStreams() === 1,
    );

    expect(recording.delays).toEqual([1, 2, 3, 1]);
    expect(recording.statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        attempt: 1,
        error: expect.objectContaining({ kind: "http", status: 503 }),
      }),
    );
  });

  it("waits 1 s, 2 s, 4 s … up to 30 s by default", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(executionRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it("reports a live hole, never delivers above it, and resumes so the host replays it", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(() => recording.delivered.length === 3);

    expect(recording.gaps).toEqual([{ reason: "hole", lastSeq: 1, seq: 3 }]);
    expect(recording.seqs()).toEqual([1, 2, 3]);
    expect(lastEventIds()).toEqual([null, "1"]);
    // A hole on a delivering connection is repaired at once, not backed off.
    expect(recording.delays).toEqual([]);
  });

  it("resumes after the snapshot a gap handler refetched", async () => {
    host.framing = false;
    const recording = follow({
      onGap: (gap) => {
        recording.gaps.push(gap);
        return 3;
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(
      () => host.eventsRequests.length === 2 && host.openStreams() === 1,
    );
    host.emit({ kind: "status", status: "completed" });
    await waitFor(() => recording.delivered.length === 2);

    expect(lastEventIds()).toEqual([null, "3"]);
    expect(recording.seqs()).toEqual([1, 4]);
  });

  it("steps over pruned history inside a named replay without calling it a gap", async () => {
    for (let index = 0; index < 5; index += 1) {
      host.emit({ kind: "activity", activity: "streaming" });
    }
    host.prune(2, 3);
    const recording = follow();
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );

    expect(recording.seqs()).toEqual([1, 4, 5]);
    expect(recording.gaps).toEqual([]);
    expect(recording.delivered.every((envelope) => envelope.seq > 0)).toBe(
      true,
    );
    expect(recording.statuses.at(-1)).toEqual({ state: "live", lastSeq: 5 });
  });

  it("forgives only the first frame of a resume on a host that does not name its replay", async () => {
    host.framing = false;
    for (let index = 0; index < 6; index += 1) {
      host.emit({ kind: "activity", activity: "streaming" });
    }
    host.prune(2, 4);
    const recording = follow();
    await waitFor(() => recording.delivered.length === 4);

    expect(recording.seqs()).toEqual([1, 3, 5, 6]);
    // Each later hole costs one resume, whose first frame the host vouches for.
    expect(recording.gaps).toEqual([
      { reason: "hole", lastSeq: 1, seq: 3 },
      { reason: "hole", lastSeq: 3, seq: 5 },
    ]);
    expect(lastEventIds()).toEqual([null, "1", "3"]);
  });

  it("stands its cursor where the host says its replay caught up", async () => {
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "thinking" });
    const recording = follow({ afterSeq: 2 });
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );

    expect(recording.delivered).toEqual([]);
    expect(recording.statuses.slice(0, 3)).toEqual([
      { state: "connecting", afterSeq: 2, attempt: 0 },
      { state: "open", afterSeq: 2 },
      { state: "live", lastSeq: 2 },
    ]);
  });

  it("drops what it already holds when a host replays it again", async () => {
    host.framing = false;
    const recording = follow({ afterSeq: 0 });
    await waitFor(() => host.openStreams() === 1);
    const first = host.emit({ kind: "status", status: "running" });
    host.writeRaw(`id: 1\ndata: ${JSON.stringify(first)}\n\n`);
    host.emit({ kind: "status", status: "completed" });
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 2]);
  });

  it("steps over a kind it does not know, and keeps its place", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    // Written raw: the stub's own numbering knows nothing of these two.
    host.writeRaw(
      'id: 2\ndata: {"protocolVersion":1,"sessionId":"session-1","seq":2,"event":{"kind":"delta","delta":{"kind":"item.reaction"}}}\n\n',
    );
    host.writeRaw(
      'id: 3\ndata: {"protocolVersion":1,"sessionId":"session-1","seq":3,"event":{"kind":"heartbeat"}}\n\n',
    );
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.skips).toEqual([
      {
        reason: "unknown-kind",
        seq: 2,
        path: "event.delta.kind",
        kind: "item.reaction",
      },
    ]);
    expect(recording.gaps).toEqual([]);
    expect(recording.seqs()).toEqual([1, 3]);
  });

  it("steps over a frame it cannot read and asks for a refetch", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.writeRaw(
      'id: 2\ndata: {"protocolVersion":1,"sessionId":"session-1","seq":2,"event":{"kind":"status","status":"paused"}}\n\n',
    );
    host.writeRaw(
      'id: 3\ndata: {"protocolVersion":1,"sessionId":"session-1","seq":3,"event":{"kind":"heartbeat"}}\n\n',
    );
    host.writeRaw("data: no id, no envelope\n\n");
    await waitFor(
      () => recording.delivered.length === 2 && recording.skips.length === 2,
    );

    expect(recording.skips).toEqual([
      { reason: "unreadable", seq: 2, detail: "invalid-payload" },
      { reason: "unreadable", seq: null, detail: "malformed-json" },
    ]);
    expect(recording.gaps).toEqual([
      { reason: "unreadable", lastSeq: 1, seq: 2 },
    ]);
    expect(recording.seqs()).toEqual([1, 3]);
    expect(host.eventsRequests).toHaveLength(1);
  });

  it("delivers an envelope again when the reader failed to keep it", async () => {
    let failures = 0;
    const recording = follow({
      onEnvelope: (envelope) => {
        if (envelope.seq === 2 && failures === 0) {
          failures += 1;
          throw new Error("the database is restarting");
        }
        recording.delivered.push(envelope);
      },
    });
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "thinking" });
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 2]);
    expect(lastEventIds()).toEqual([null, "1"]);
    expect(recording.statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        error: expect.objectContaining({
          message: "the database is restarting",
        }),
      }),
    );
  });

  it("asks for increments on every connection", async () => {
    const recording = follow({ deltas: "append" });
    await waitFor(() => host.openStreams() === 1);
    host.closeStreams();
    await waitFor(() => host.eventsRequests.length === 2);
    await recording.follow.stop();

    expect(host.eventsRequests.map((request) => request.deltas)).toEqual([
      "append",
      "append",
    ]);
  });

  it("replaces a connection that goes quiet", async () => {
    host.framing = false;
    const recording = follow({ idleTimeoutMs: 30 });
    await waitFor(() => host.eventsRequests.length >= 2);

    expect(recording.statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        error: expect.objectContaining({ kind: "timeout" }),
      }),
    );
  });
});

describe("ending a follow", () => {
  it("stops mid-stream: the connection closes and nothing more is delivered", async () => {
    const recording = follow();
    host.emit({ kind: "status", status: "running" });
    await waitFor(() => recording.delivered.length === 1);

    await expect(recording.follow.stop()).resolves.toEqual({
      reason: "stopped",
      lastSeq: 1,
    });
    host.emit({ kind: "status", status: "completed" });
    expect(host.openStreams()).toBe(0);
    expect(recording.delivered).toHaveLength(1);
    expect(host.eventsRequests).toHaveLength(1);
  });

  it("stops during a backoff wait without waiting it out", async () => {
    host.eventsStatus = 503;
    const recording = follow({ retryDelayMs: () => 60_000 });
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "waiting"),
    );
    const started = Date.now();

    await expect(recording.follow.stop()).resolves.toMatchObject({
      reason: "stopped",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(host.eventsRequests).toHaveLength(1);
  });

  it("stops when the caller's signal aborts, and never starts on an aborted one", async () => {
    const caller = new AbortController();
    const recording = follow({ signal: caller.signal });
    await waitFor(() => host.openStreams() === 1);
    caller.abort();
    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "stopped",
    });

    const before = host.eventsRequests.length;
    const aborted = follow({ signal: AbortSignal.abort() });
    await expect(aborted.follow.done).resolves.toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
    expect(host.eventsRequests).toHaveLength(before);
  });

  it("ends on the host's verdicts: no such session, or a refused token", async () => {
    host.sessions.clear();
    await expect(follow().follow.done).resolves.toMatchObject({
      reason: "no-session",
      error: { kind: "not-found", status: 404 },
    });
    host.sessions.add("session-1");
    await expect(follow({}, "wrong-token").follow.done).resolves.toMatchObject({
      reason: "unauthorized",
      error: { kind: "auth", status: 401 },
    });
  });

  it("gives up only when told how many empty attempts to allow", async () => {
    host.eventsStatus = 502;
    const recording = follow({ maxAttempts: 2 });

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "gave-up",
      error: { kind: "http", status: 502 },
    });
    expect(host.eventsRequests).toHaveLength(3);
  });

  it("refuses a cursor that is not a whole number, or no envelope handler", () => {
    expect(() => follow({ afterSeq: -1 })).toThrow(RangeError);
    expect(() => follow({ afterSeq: 1.5 })).toThrow(RangeError);
    expect(() =>
      follow({ onEnvelope: undefined as unknown as () => void }),
    ).toThrow(TypeError);
  });
});
