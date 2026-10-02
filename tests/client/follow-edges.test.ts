import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  type ExecutionFollowOptions,
  type ExecutionSessionFollow,
} from "../../src/client/index.js";
import { followOn, type Recording } from "./follow-recording.js";
import { createStubHost, type StubHost, waitFor } from "./stub-host.js";

/**
 * The edges of `followSession` a first review found (MAR-3638): progress that
 * is not progress, a stop that races a connection, frames that claim a place
 * they do not have, and the mutations the core suite let through.
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

const follow = (options: Partial<ExecutionFollowOptions> = {}): Recording =>
  followOn(host, follows, options);

const envelope = (seq: number, sessionId = "session-1") =>
  JSON.stringify({
    protocolVersion: 1,
    sessionId,
    seq,
    event: { kind: "activity", activity: "streaming" },
  });

/** Every events request the host answers, it hangs up `afterMs` later. */
const hangUpAfter = (afterMs: number) => {
  const answer = host.fetch;
  let opened = 0;
  host.fetch = async (input, init) => {
    const response = await answer(input, init);
    if (String(input).includes("/events") && response.ok) {
      opened += 1;
      setTimeout(() => host.closeStreams(), afterMs);
    }
    return response;
  };
  return () => opened;
};

/** A host that never answers: each request settles only when it is aborted. */
const blackHole = () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = (_input, init) => {
    requests += 1;
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      ),
    );
  };
  return { fetch, requests: () => requests };
};

describe("stopping from inside a status report", () => {
  it("never connects when the first `connecting` report stops it", async () => {
    const hole = blackHole();
    const client = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: "t",
      fetch: hole.fetch,
    });
    // The handle is in scope: the first report comes after followSession returns.
    const followed: ExecutionSessionFollow = client.followSession("session-1", {
      idleTimeoutMs: 60_000,
      onEnvelope: () => {},
      onStatus: (status) => {
        if (status.state === "connecting") void followed.stop();
      },
    });
    follows.push(followed);

    await expect(followed.done).resolves.toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
    expect(hole.requests()).toBe(0);
  });

  it("never opens another connection once a reconnect's report stops it", async () => {
    host.eventsStatus = 503;
    let requestsAfterStop = 0;
    let stopped = false;
    const answer = host.fetch;
    host.fetch = (input, init) => {
      if (stopped) requestsAfterStop += 1;
      return answer(input, init);
    };
    const recording: Recording = follow({
      onStatus: (status) => {
        if (status.state === "connecting" && status.attempt === 1) {
          stopped = true;
          void recording.follow.stop();
        }
      },
    });

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "stopped",
    });
    expect(requestsAfterStop).toBe(0);
  });
});

describe("what counts as progress", () => {
  it("does not count a connection that only said it caught up", async () => {
    const opened = hangUpAfter(1);
    const recording = follow({ maxAttempts: 3 });

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "gave-up",
    });
    expect(recording.delays).toEqual([1, 2, 3]);
    expect(opened()).toBe(4);
  });

  it("counts a connection that stayed open as healthy, though it delivered nothing", async () => {
    host.framing = false;
    hangUpAfter(40);
    const recording = follow({ maxAttempts: 2, healthyAfterMs: 15 });
    await waitFor(() => host.eventsRequests.length >= 5, 5_000);

    expect(recording.delays.every((attempt) => attempt === 1)).toBe(true);
    expect(await Promise.race([recording.follow.done, "following"])).toBe(
      "following",
    );
  });

  it("still gives up on connections a proxy cuts the moment they open", async () => {
    host.framing = false;
    const answer = host.fetch;
    host.fetch = async (input, init) => {
      const response = await answer(input, init);
      if (String(input).includes("/events")) {
        setTimeout(() => {
          host.writeRaw(": keep-alive\n\n");
          host.closeStreams();
        }, 1);
      }
      return response;
    };
    const recording = follow({ maxAttempts: 3 });

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "gave-up",
    });
    expect(recording.delays).toEqual([1, 2, 3]);
  });

  it("backs off and resumes when the gap handler itself fails", async () => {
    host.framing = false;
    let calls = 0;
    const recording: Recording = follow({
      onGap: (gap) => {
        calls += 1;
        recording.gaps.push(gap);
        if (calls === 1) throw new Error("the snapshot could not be read");
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(() => recording.delivered.length === 3);

    expect(recording.seqs()).toEqual([1, 2, 3]);
    expect(recording.delays).toEqual([1]);
  });
});

describe("frames that claim a place they do not have", () => {
  it("never moves the cursor for an envelope about another session", async () => {
    for (let index = 0; index < 3; index += 1) {
      host.emit({ kind: "status", status: "running" });
    }
    const recording = follow();
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );
    host.writeRaw(`id: 50\ndata: ${envelope(50, "another-session")}\n\n`);
    host.emit({ kind: "activity", activity: "thinking" });
    await waitFor(() => recording.delivered.length === 4);

    expect(recording.follow.lastSeq).toBe(4);
    expect(recording.skips).toEqual([
      { reason: "unreadable", seq: null, detail: "invalid-envelope" },
    ]);
    expect(recording.gaps).toEqual([]);
  });

  it("reads a frame named replay after caught-up as live: its hole is loss", async () => {
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "completed" });
    const recording = follow();
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );
    host.writeRaw(`event: replay\nid: 4\ndata: ${envelope(4)}\n\n`);
    await waitFor(() => recording.gaps.length === 1);

    expect(recording.gaps).toEqual([{ reason: "hole", lastSeq: 2, seq: 4 }]);
    expect(recording.seqs()).toEqual([1, 2]);
  });

  it("ignores frames under a name it does not know, as EventSource does", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.writeRaw(`event: presence\nid: 2\ndata: ${envelope(2)}\n\n`);
    host.writeRaw("event: ping\nid: 7\ndata: not an envelope\n\n");
    host.writeRaw(`event: message\nid: 2\ndata: ${envelope(2)}\n\n`);
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 2]);
    expect(recording.skips).toEqual([]);
    expect(recording.gaps).toEqual([]);
  });
});

describe("the cursor and the replay boundary", () => {
  it("M1: stands the cursor at a caught-up above it", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    await waitFor(() => recording.delivered.length === 1);
    host.writeRaw('event: caught-up\ndata: {"throughSeq":7}\n\n');
    host.writeRaw(`id: 8\ndata: ${envelope(8)}\n\n`);
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 8]);
    expect(recording.gaps).toEqual([]);
    expect(recording.statuses).toContainEqual({ state: "live", lastSeq: 7 });
  });

  it("M1b: never moves the cursor back for a caught-up below it", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    for (let index = 0; index < 5; index += 1) {
      host.emit({ kind: "status", status: "running" });
    }
    await waitFor(() => recording.delivered.length === 5);
    host.writeRaw('event: caught-up\ndata: {"throughSeq":3}\n\n');
    host.writeRaw(`id: 4\ndata: ${envelope(4)}\n\n`);
    host.writeRaw(`id: 6\ndata: ${envelope(6)}\n\n`);
    await waitFor(() => recording.delivered.length === 6);

    expect(recording.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(recording.follow.lastSeq).toBe(6);
  });

  it("M2: does not count the time a handler takes against the idle timeout", async () => {
    host.framing = false;
    const recording: Recording = follow({
      idleTimeoutMs: 40,
      onEnvelope: async (delivered) => {
        recording.delivered.push(delivered);
        await new Promise((resolve) => setTimeout(resolve, 150));
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "completed" });
    const keepAlive = setInterval(() => host.writeRaw(": keep-alive\n\n"), 10);
    try {
      await waitFor(() => recording.delivered.length === 2, 3_000);
    } finally {
      clearInterval(keepAlive);
    }

    expect(
      recording.statuses.filter((status) => status.state === "waiting"),
    ).toEqual([]);
  });

  it("M3: resumes after the cursor a gap handler returns for an unreadable frame", async () => {
    host.framing = false;
    const recording: Recording = follow({
      onGap: (gap) => {
        recording.gaps.push(gap);
        return 5;
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.writeRaw("id: 2\ndata: {broken\n\n");
    for (const seq of [3, 4, 5, 6]) {
      host.writeRaw(`id: ${seq}\ndata: ${envelope(seq)}\n\n`);
    }
    await waitFor(() => recording.follow.lastSeq === 6);

    expect(recording.seqs()).toEqual([1, 6]);
    expect(recording.gaps).toEqual([
      { reason: "unreadable", lastSeq: 1, seq: 2 },
    ]);
  });

  it("M4: keeps forgiving holes through the live frames a host flushes before caught-up", async () => {
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "activity", activity: "streaming" });
    host.emit({ kind: "activity", activity: "streaming" });
    // 3 was pruned; 4 and 5 arrived while the replay was being read.
    host.prune(3);
    host.bufferedSeqs.add(4).add(5);
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.prune(6);
    host.emit({ kind: "activity", activity: "thinking" });
    host.bufferedSeqs.add(7);
    const recording = follow();
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );

    expect(recording.seqs()).toEqual([1, 2, 4, 5, 7]);
    expect(recording.gaps).toEqual([]);
    expect(recording.statuses).toContainEqual({ state: "live", lastSeq: 7 });
  });

  it("M5: hands nothing on after stop(), not even frames already read", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const recording: Recording = follow({
      onEnvelope: async (delivered) => {
        recording.delivered.push(delivered);
        if (delivered.seq === 1) await held;
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emitBatch([
      { kind: "status", status: "running" },
      { kind: "activity", activity: "thinking" },
      { kind: "activity", activity: "streaming" },
    ]);
    await waitFor(() => recording.delivered.length === 1);
    const stopping = recording.follow.stop();
    release();

    await expect(stopping).resolves.toEqual({ reason: "stopped", lastSeq: 1 });
    expect(recording.seqs()).toEqual([1]);
  });
});
