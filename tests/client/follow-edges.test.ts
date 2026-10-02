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

/**
 * Every events request the host answers, it hangs up `afterMs` later. The
 * timer holds this test's stub, never the module's `host`: one that fired
 * after its test ended would hang up on the next test's stream.
 */
const hangUpAfter = (afterMs: number) => {
  const stub = host;
  const answer = stub.fetch;
  let opened = 0;
  stub.fetch = async (input, init) => {
    const response = await answer(input, init);
    if (String(input).includes("/events") && response.ok) {
      opened += 1;
      setTimeout(() => stub.closeStreams(), afterMs);
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
    const stub = host;
    const answer = stub.fetch;
    stub.fetch = async (input, init) => {
      const response = await answer(input, init);
      if (String(input).includes("/events")) {
        setTimeout(() => {
          stub.writeRaw(": keep-alive\n\n");
          stub.closeStreams();
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
    const stub = host;
    const keepAlive = setInterval(() => stub.writeRaw(": keep-alive\n\n"), 10);
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
    let signal: AbortSignal | null = null;
    const recording: Recording = follow({
      onEnvelope: async (delivered, info) => {
        recording.delivered.push(delivered);
        if (delivered.seq === 1) {
          signal = info.signal;
          await held;
        }
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

    // The handler for 1 had not returned when stop() was called, so 1 is not
    // kept: stop() does not wait on a handler, and tells it to give up.
    await expect(stopping).resolves.toEqual({ reason: "stopped", lastSeq: 0 });
    expect(signal!.aborted).toBe(true);
    expect(recording.seqs()).toEqual([1]);
  });
});

describe("listeners and handlers that misbehave", () => {
  it("never lets an async status listener's rejection escape", async () => {
    const escaped: unknown[] = [];
    const onEscape = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onEscape);
    try {
      host.eventsStatus = 503;
      const recording = follow({
        onStatus: async () => {
          throw new Error("the log sink is down");
        },
      });
      await waitFor(() => host.eventsRequests.length >= 5);
      await recording.follow.stop();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onEscape);
    }

    expect(escaped).toEqual([]);
  });

  it("lets a handler stop the follow it belongs to, without deadlock", async () => {
    let followed: ExecutionSessionFollow | null = null;
    const recording: Recording = follow({
      onEnvelope: async () => {
        await followed!.stop();
      },
    });
    followed = recording.follow;
    host.emit({ kind: "status", status: "running" });

    await expect(recording.follow.done).resolves.toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
  });

  it("stops at once though a handler never settles, and tells it to give up", async () => {
    let signal: AbortSignal | null = null;
    const recording = follow({
      onEnvelope: (_envelope, info) => {
        signal = info.signal;
        return new Promise<void>(() => {});
      },
    });
    host.emit({ kind: "status", status: "running" });
    await waitFor(() => signal !== null);
    const started = Date.now();

    await expect(recording.follow.stop()).resolves.toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(signal!.aborted).toBe(true);
  });

  it("hands each envelope the cursor to persist with it", async () => {
    const seen: Array<[number, number, number]> = [];
    const recording: Recording = follow({
      onEnvelope: (delivered, info) => {
        seen.push([delivered.seq, info.cursor, recording.follow.lastSeq]);
      },
    });
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "completed" });
    await waitFor(() => seen.length === 2);

    // follow.lastSeq moves only once the handler has kept the envelope.
    expect(seen).toEqual([
      [1, 1, 0],
      [2, 2, 1],
    ]);
    expect(recording.follow.lastSeq).toBe(2);
  });

  it("offers a frame again after the backoff when its skip handler throws", async () => {
    host.framing = false;
    let throwing = true;
    const recording: Recording = follow({
      onSkip: (skip) => {
        if (throwing) throw new Error("the skip log is down");
        recording.skips.push(skip);
      },
    });
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    // A frame the reader cannot place in its stream, kept by the host.
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.log[1] = {
      ...host.log[1]!,
      event: {
        kind: "presence",
      } as unknown as (typeof host.log)[number]["event"],
    };
    host.writeRaw(`id: 2\ndata: ${JSON.stringify(host.log[1])}\n\n`);
    await waitFor(() => recording.delays.length >= 2);
    throwing = false;
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 3]);
    expect(recording.skips).toEqual([
      { reason: "unknown-kind", seq: 2, path: "event.kind", kind: "presence" },
    ]);
    expect(recording.delays.slice(0, 2)).toEqual([1, 2]);
  });

  it("ends with `crashed`, not `gave-up`, when its own machinery throws", async () => {
    host.eventsStatus = 503;
    const recording = follow({
      retryDelayMs: () => {
        throw new Error("a bug in the caller's backoff");
      },
    });

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "crashed",
      error: { message: "a bug in the caller's backoff" },
    });
  });
});

describe("timers a caller can get wrong", () => {
  it("treats an idle timeout past what a timer holds as forever, not as at once", async () => {
    const recording = follow({ idleTimeoutMs: 30 * 24 * 60 * 60 * 1000 });
    await waitFor(() => host.openStreams() === 1);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(host.eventsRequests).toHaveLength(1);
    expect(
      recording.statuses.filter((status) => status.state === "waiting"),
    ).toEqual([]);
  });

  it("caps a reconnect wait at what a timer holds", async () => {
    host.eventsStatus = 503;
    const recording = follow({ retryDelayMs: () => Number.POSITIVE_INFINITY });
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "waiting"),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(host.eventsRequests).toHaveLength(1);
  });

  it("refuses an idle timeout that is not a positive duration", () => {
    for (const idleTimeoutMs of [0, -1, Number.NaN]) {
      expect(() => follow({ idleTimeoutMs })).toThrow(RangeError);
    }
  });
});

describe("what ends a follow, and what does not", () => {
  it("ends on a 403 from the stream, as a proxy or WAF may answer", async () => {
    host.eventsStatus = 403;
    await expect(follow().follow.done).resolves.toMatchObject({
      reason: "unauthorized",
      error: { kind: "auth", status: 403 },
    });
  });

  it("ends with the cursor it reached when the session goes away mid-follow", async () => {
    const recording = follow();
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "completed" });
    await waitFor(() => recording.delivered.length === 2);
    host.sessions.delete("session-1");
    host.closeStreams();

    await expect(recording.follow.done).resolves.toMatchObject({
      reason: "no-session",
      lastSeq: 2,
    });
  });

  it("repairs a live hole on a host that names its replay", async () => {
    const recording = follow();
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "live"),
    );
    host.emit({ kind: "status", status: "running" });
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "activity", activity: "streaming" });
    await waitFor(() => recording.delivered.length === 3);

    expect(recording.seqs()).toEqual([1, 2, 3]);
    expect(recording.gaps).toEqual([{ reason: "hole", lastSeq: 1, seq: 3 }]);
    expect(lastEventIdsOf(host)).toEqual([null, "1"]);
  });

  it("keeps nothing of a frame a hang-up cut short, and the resume replays it", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    host.emit({ kind: "status", status: "running" });
    host.loseFrame({ kind: "activity", activity: "thinking" });
    host.writeRaw(`id: 2\ndata: ${JSON.stringify(host.log.at(-1))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    host.closeStreams();
    await waitFor(() => recording.delivered.length === 2);

    expect(recording.seqs()).toEqual([1, 2]);
    expect(lastEventIdsOf(host)).toEqual([null, "1"]);
  });

  it("replaces a connection whose host never answers at all", async () => {
    const hole = blackHole();
    const statuses: unknown[] = [];
    const followed = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: "t",
      fetch: hole.fetch,
    }).followSession("session-1", {
      idleTimeoutMs: 20,
      onEnvelope: () => {},
      onStatus: (status) => statuses.push(status),
      retryDelayMs: () => 0,
    });
    follows.push(followed);
    await waitFor(() => hole.requests() >= 3);

    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        error: expect.objectContaining({ kind: "timeout" }),
      }),
    );
  });

  it("reads a character the network cut in two", async () => {
    host.framing = false;
    const recording = follow();
    await waitFor(() => host.openStreams() === 1);
    const bytes = new TextEncoder().encode(
      `id: 1\ndata: ${JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 1,
        event: { kind: "continuation-token", token: "zażółć 🙂" },
      })}\n\n`,
    );
    const cut = bytes.indexOf(0xf0) + 2; // inside the emoji's four bytes
    host.writeBytes(bytes.slice(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 5));
    host.writeBytes(bytes.slice(cut));
    await waitFor(() => recording.delivered.length === 1);

    expect(recording.delivered[0]!.event).toEqual({
      kind: "continuation-token",
      token: "zażółć 🙂",
    });
  });

  it("refuses a frame past its size cap instead of buffering it forever", async () => {
    host.framing = false;
    const recording = follow({ maxFrameLength: 1_000 });
    await waitFor(() => host.openStreams() === 1);
    host.writeRaw(`id: 1\ndata: ${"x".repeat(2_000)}`);
    await waitFor(() =>
      recording.statuses.some((status) => status.state === "waiting"),
    );

    expect(recording.statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        error: expect.objectContaining({ kind: "malformed" }),
      }),
    );
  });
});

function lastEventIdsOf(stub: StubHost) {
  return stub.eventsRequests.map((request) => request.lastEventId);
}
