import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionHostClient,
  type ExecutionFollowStatus,
} from "../../src/client/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Read = ReadableStreamReadResult<Uint8Array>;
const end: Read = { done: true, value: undefined };
const chunk = (seq: number): Read => ({
  done: false,
  value: new TextEncoder().encode(
    `data: ${JSON.stringify({
      protocolVersion: 1,
      sessionId: "session-1",
      seq,
      event: { kind: "heartbeat" },
    })}\n\n`,
  ),
});

/** A broken fetch body: neither read nor cancel responds to its signal. */
function stuckHost() {
  const pendingRead = deferred<Read>();
  const pendingCancel = deferred<void>();
  const reading = deferred<void>();
  const read = vi.fn(() => {
    reading.resolve();
    return pendingRead.promise;
  });
  const cancel = vi.fn(() => pendingCancel.promise);
  let signal!: AbortSignal;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    signal = init!.signal!;
    // Only the response/reader surface used by events; using a real stream
    // here would make cancel settle read and hide the transport bug.
    return {
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response;
  });
  const client = createExecutionHostClient({
    baseUrl: "https://host.test",
    token: "t",
    fetch,
  });
  return {
    client,
    fetch,
    read,
    cancel,
    reading: reading.promise,
    pendingRead,
    pendingCancel,
    signal: () => signal,
  };
}

/** The next event-loop turn is a bound, not a sleep or a polling interval. */
async function withinTick<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    setImmediate().then(() => {
      throw new Error("did not settle within a tick");
    }),
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a fetch body that ignores abort (MAR-3751)", () => {
  it("ends events within a tick with read and cancel still pending", async () => {
    const host = stuckHost();
    const caller = new AbortController();
    const events = host.client
      .events("session-1", { signal: caller.signal })
      [Symbol.asyncIterator]();
    expect(await events.next()).toEqual({
      done: false,
      value: { type: "open" },
    });
    const next = events.next();
    await host.reading;
    caller.abort();

    expect(await withinTick(next)).toEqual(end);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(getEventListeners(host.signal(), "abort")).toHaveLength(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "signal"])(
    "settles follow.done on %s within a tick",
    async (how) => {
      const host = stuckHost();
      const caller = new AbortController();
      const onEnvelope = vi.fn();
      const follow = host.client.followSession("session-1", {
        signal: caller.signal,
        onEnvelope,
      });
      await host.reading;
      if (how === "stop") void follow.stop();
      else caller.abort();

      expect(await withinTick(follow.done)).toEqual({
        reason: "stopped",
        lastSeq: 0,
      });
      expect(onEnvelope).not.toHaveBeenCalled();
      expect(host.cancel).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reconnects after an idle abort despite pending read and cancel", async () => {
    const host = stuckHost();
    const waiting = deferred<ExecutionFollowStatus>();
    const reopened = deferred<void>();
    let opens = 0;
    const follow = host.client.followSession("session-1", {
      onEnvelope: () => {},
      idleTimeoutMs: 100,
      retryDelayMs: () => 10,
      onStatus: (status) => {
        if (status.state === "waiting") waiting.resolve(status);
        if (status.state === "open" && ++opens === 2) reopened.resolve();
      },
    });
    await host.reading;
    const firstSignal = host.signal();
    vi.advanceTimersByTime(100);
    expect(await withinTick(waiting.promise)).toMatchObject({
      state: "waiting",
      error: { kind: "timeout", operation: "events" },
    });
    expect(firstSignal.aborted).toBe(true);
    expect(getEventListeners(firstSignal, "abort")).toHaveLength(0);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10);
    await withinTick(reopened.promise);
    expect(host.fetch).toHaveBeenCalledTimes(2);
    expect(await withinTick(follow.stop())).toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles late rejections from both abandoned operations", async () => {
    const host = stuckHost();
    const caller = new AbortController();
    const escaped = vi.fn();
    process.on("unhandledRejection", escaped);
    try {
      const events = host.client
        .events("session-1", { signal: caller.signal })
        [Symbol.asyncIterator]();
      await events.next();
      const next = events.next();
      await host.reading;
      caller.abort();
      await withinTick(next);
      host.pendingRead.reject(new Error("late read failure"));
      host.pendingCancel.reject(new Error("late cancel failure"));
      // Node reports unhandled rejections before the next event-loop turn.
      await setImmediate();
      expect(escaped).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", escaped);
    }
  });
});

describe("abort boundaries and ordinary reads", () => {
  it.each(["before opening", "after opening"])(
    "ends when aborted %s, before the first read",
    async (when) => {
      const host = stuckHost();
      const caller = new AbortController();
      if (when === "before opening") caller.abort();
      const events = host.client
        .events("session-1", { signal: caller.signal })
        [Symbol.asyncIterator]();
      await events.next();
      caller.abort();
      expect(await withinTick(events.next())).toEqual(end);
      expect(host.read).not.toHaveBeenCalled();
      expect(host.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("an abort after EOF does nothing, even if cancellation remains pending", async () => {
    const host = stuckHost();
    host.read.mockResolvedValue(end);
    const caller = new AbortController();
    const events = host.client
      .events("session-1", { signal: caller.signal })
      [Symbol.asyncIterator]();
    await events.next();
    expect(await withinTick(events.next())).toEqual(end);
    caller.abort();
    expect(await events.next()).toEqual(end);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("events delivers a read resolved just before abort exactly once", async () => {
    const host = stuckHost();
    const caller = new AbortController();
    host.cancel.mockResolvedValue();
    const read = host.read.getMockImplementation()!;
    host.read.mockImplementation(() =>
      host.signal().aborted ? Promise.reject(host.signal().reason) : read(),
    );
    const events = host.client
      .events("session-1", { signal: caller.signal })
      [Symbol.asyncIterator]();
    await events.next();
    const next = events.next();
    await host.reading;
    host.pendingRead.resolve(chunk(1));
    caller.abort();
    expect(await withinTick(next)).toMatchObject({
      done: false,
      value: { type: "envelope", envelope: { seq: 1 } },
    });
    expect(await withinTick(events.next())).toEqual(end);
  });

  it("follow drops a read resolved just before stop, as before", async () => {
    const host = stuckHost();
    host.cancel.mockResolvedValue();
    const onEnvelope = vi.fn();
    const follow = host.client.followSession("session-1", { onEnvelope });
    await host.reading;
    host.pendingRead.resolve(chunk(1));
    expect(await withinTick(follow.stop())).toEqual({
      reason: "stopped",
      lastSeq: 0,
    });
    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it("drops a read that resolves after abort wins in the same tick", async () => {
    const host = stuckHost();
    const caller = new AbortController();
    const events = host.client
      .events("session-1", { signal: caller.signal })
      [Symbol.asyncIterator]();
    await events.next();
    const next = events.next();
    await host.reading;
    caller.abort();
    host.pendingRead.resolve(chunk(1));
    expect(await withinTick(next)).toEqual(end);
  });

  it("removes the per-read abort listener after every successful read and EOF", async () => {
    const host = stuckHost();
    host.cancel.mockResolvedValue();
    const events = host.client.events("session-1")[Symbol.asyncIterator]();
    await events.next();
    const signal = host.signal();
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");
    let seq = 0;
    host.read.mockImplementation(async () => {
      expect(getEventListeners(signal, "abort")).toHaveLength(1);
      return ++seq <= 1_000 ? chunk(seq) : end;
    });
    for (let expected = 1; expected <= 1_000; expected += 1) {
      expect(await events.next()).toMatchObject({
        done: false,
        value: { type: "envelope", envelope: { seq: expected } },
      });
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
      expect(added).toHaveBeenCalledTimes(expected);
      expect(removed).toHaveBeenCalledTimes(expected);
    }
    expect(await events.next()).toEqual(end);
    expect(added).toHaveBeenCalledTimes(1_001);
    expect(removed).toHaveBeenCalledTimes(1_001);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("removes the listener on read rejection and preserves the network error", async () => {
    const host = stuckHost();
    host.cancel.mockResolvedValue();
    host.read.mockRejectedValue(new Error("read failed"));
    const events = host.client.events("session-1")[Symbol.asyncIterator]();
    await events.next();
    await expect(events.next()).rejects.toMatchObject({ kind: "network" });
    expect(getEventListeners(host.signal(), "abort")).toHaveLength(0);
  });
});
