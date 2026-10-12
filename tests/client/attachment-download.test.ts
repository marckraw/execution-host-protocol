import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_TOOL_ATTACHMENT_MAX_BYTES } from "../../src/index.js";
import {
  createExecutionHostClient,
  ExecutionHostError,
} from "../../src/client/index.js";

const token = "private-bearer-token";
const clientFor = (fetch: typeof globalThis.fetch) =>
  createExecutionHostClient({
    baseUrl: "https://host.tailnet.test",
    token,
    fetch,
  });

function bodyOf(chunks: Uint8Array[], headers?: HeadersInit) {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  return { response: new Response(body, { headers }), body, cancel };
}

async function withinTick<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    setImmediate().then(() => {
      throw new Error("did not settle within a tick");
    }),
  ]);
}

function stuckBody() {
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let rejectRead!: (error: Error) => void;
  const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>(
    (_resolve, reject) => {
      rejectRead = reject;
    },
  );
  let rejectCancel!: (error: Error) => void;
  const pendingCancel = new Promise<void>((_resolve, reject) => {
    rejectCancel = reject;
  });
  const read = vi.fn(() => {
    reading();
    return pendingRead;
  });
  const cancel = vi.fn(() => pendingCancel);
  const releaseLock = vi.fn();
  let signal!: AbortSignal;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    signal = init!.signal!;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      redirected: false,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
  });
  return {
    client: clientFor(fetch),
    fetch,
    started,
    read,
    cancel,
    releaseLock,
    signal: () => signal,
    rejectRead,
    rejectCancel,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("bounded attachment downloads (MAR-3928)", () => {
  it("uses injected tailnet transport, authenticates, encodes both IDs, and consumes bytes", async () => {
    const held = bodyOf([new Uint8Array([0, 255]), new Uint8Array([17])], {
      "Content-Type": "text/plain",
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => held.response);
    const result = await clientFor(fetch).downloadAttachment(
      "session /?#雪",
      "https://other.test/a?#雪",
      { maxBytes: 3 },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      "https://host.tailnet.test/v0/execution/sessions/session%20%2F%3F%23%E9%9B%AA/attachments/https%3A%2F%2Fother.test%2Fa%3F%23%E9%9B%AA",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/octet-stream",
      },
    });
    expect(result).toEqual({
      bytes: new Uint8Array([0, 255, 17]),
      sizeBytes: 3,
    });
    expect(held.body.locked).toBe(false);
    expect(held.cancel).not.toHaveBeenCalled();
  });

  it("accepts the exact 8 MiB default ceiling", async () => {
    const held = bodyOf([new Uint8Array(EXECUTION_TOOL_ATTACHMENT_MAX_BYTES)]);
    const result = await clientFor(
      async () => held.response,
    ).downloadAttachment("s", "a");
    expect(result.sizeBytes).toBe(EXECUTION_TOOL_ATTACHMENT_MAX_BYTES);
    expect(result.bytes.byteLength).toBe(result.sizeBytes);
  });

  it.each([undefined, "1", "false", "999999999999999999999999"])(
    "rejects limit+1 despite Content-Length %s",
    async (length) => {
      const held = bodyOf(
        [new Uint8Array(3), new Uint8Array(2), new Uint8Array(1)],
        length === undefined ? undefined : { "Content-Length": length },
      );
      await expect(
        clientFor(async () => held.response).downloadAttachment("s", "a", {
          maxBytes: 4,
        }),
      ).rejects.toMatchObject({ kind: "malformed" });
      expect(held.cancel).toHaveBeenCalledOnce();
      expect(held.body.locked).toBe(false);
    },
  );

  it("rejects 8 MiB + 1 with no claimed length", async () => {
    const held = bodyOf([
      new Uint8Array(EXECUTION_TOOL_ATTACHMENT_MAX_BYTES + 1),
      new Uint8Array(1),
    ]);
    await expect(
      clientFor(async () => held.response).downloadAttachment("s", "a"),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(held.cancel).toHaveBeenCalledOnce();
    expect(held.body.locked).toBe(false);
  });

  it("refuses an oversized Content-Length before reading", async () => {
    const read = vi.fn();
    const cancel = vi.fn(async () => {});
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Length": "5" }),
      body: { getReader: read, cancel },
    } as unknown as Response;
    await expect(
      clientFor(async () => response).downloadAttachment("s", "a", {
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(read).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, "0", "2", "nonsense"])(
    "counts exact chunked bytes independently of claimed length %s",
    async (length) => {
      const held = bodyOf(
        [
          new Uint8Array(0),
          new Uint8Array([1]),
          new Uint8Array([2, 3]),
          new Uint8Array([4]),
        ],
        length === undefined ? undefined : { "Content-Length": length },
      );
      const result = await clientFor(
        async () => held.response,
      ).downloadAttachment("s", "a", { maxBytes: 4 });
      expect(result).toEqual({
        bytes: new Uint8Array([1, 2, 3, 4]),
        sizeBytes: 4,
      });
      expect(result.bytes.buffer.byteLength).toBe(4);
    },
  );

  it("refuses a missing stream without whole-body buffering", async () => {
    const response = new Response(null);
    const arrayBuffer = vi.spyOn(response, "arrayBuffer");
    const text = vi.spyOn(response, "text");
    await expect(
      clientFor(async () => response).downloadAttachment("s", "a"),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, EXECUTION_TOOL_ATTACHMENT_MAX_BYTES + 1])(
    "refuses invalid maxBytes %s before fetching",
    async (maxBytes) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        clientFor(fetch).downloadAttachment("s", "a", { maxBytes }),
      ).rejects.toThrow(RangeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", ".", ".."])(
    "refuses unsafe path ID %s before fetching",
    async (id) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const client = clientFor(fetch);
      await expect(client.downloadAttachment(id, "a")).rejects.toThrow(
        TypeError,
      );
      await expect(client.downloadAttachment("s", id)).rejects.toThrow(
        TypeError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [302, "http"],
    [401, "auth"],
    [403, "auth"],
    [404, "not-found"],
    [500, "http"],
  ])(
    "returns safe status errors for HTTP %s and cancels without reading",
    async (status, kind) => {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const getReader = vi.fn();
      const text = vi.fn();
      const response = {
        ok: false,
        status,
        headers: new Headers({ Location: "https://other.test" }),
        body: { cancel, getReader },
        text,
      } as unknown as Response;
      const error = await withinTick(
        clientFor(async () => response)
          .downloadAttachment("s", "a")
          .catch((error: unknown) => error),
      );
      expect(error).toBeInstanceOf(ExecutionHostError);
      expect(error).toMatchObject({
        kind,
        status,
        operation: "download attachment",
      });
      expect(error).not.toHaveProperty("cause");
      expect(text).not.toHaveBeenCalled();
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("rejects a redirect followed by an injected fetch", async () => {
    const cancel = vi.fn(async () => {});
    const response = {
      ok: true,
      status: 200,
      redirected: true,
      body: { cancel },
    } as unknown as Response;
    await expect(
      clientFor(async () => response).downloadAttachment("s", "a"),
    ).rejects.toMatchObject({ kind: "http", status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["fetch", "read"])(
    "omits raw %s diagnostics, nested causes and credentials",
    async (where) => {
      const diagnostic = new Error(`secret host path ${token}`, {
        cause: new Error("private nested cause"),
      });
      const held = bodyOf([]);
      const fetch = async () => {
        if (where === "fetch") throw diagnostic;
        return held.response;
      };
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const releaseLock = vi.fn();
      if (where === "read")
        vi.spyOn(held.body, "getReader").mockReturnValue({
          read: async () => {
            throw diagnostic;
          },
          cancel,
          releaseLock,
        } as unknown as ReadableStreamDefaultReader<Uint8Array>);
      const error = await clientFor(fetch)
        .downloadAttachment("s", "a")
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        kind: "network",
        reason: "the connection to the host failed",
      });
      expect(error).not.toHaveProperty("cause");
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain("secret host path");
      if (where === "read") {
        expect(cancel).toHaveBeenCalledOnce();
        expect(releaseLock).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([0, -1, NaN, Infinity])(
    "refuses invalid download timeout %s before fetching",
    async (timeoutMs) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      await expect(
        clientFor(fetch).downloadAttachment("s", "a", { timeoutMs }),
      ).rejects.toThrow(RangeError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not fetch for a caller already aborted", async () => {
    const host = stuckBody();
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    caller.abort(reason);
    await expect(
      host.client.downloadAttachment("s", "a", { signal: caller.signal }),
    ).rejects.toBe(reason);
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it.each(["caller", "deadline"])(
    "settles on %s despite stalled read and cancel; releases listeners and lock",
    async (how) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const host = stuckBody();
      const caller = new AbortController();
      const reason = new Error("caller stopped");
      const escaped = vi.fn();
      process.on("unhandledRejection", escaped);
      try {
        const pending = host.client
          .downloadAttachment("s", "a", {
            signal: caller.signal,
            timeoutMs: 100,
          })
          .catch((error: unknown) => error);
        await host.started;
        if (how === "caller") caller.abort(reason);
        else vi.advanceTimersByTime(100);
        const error = await withinTick(pending);
        if (how === "caller") expect(error).toBe(reason);
        else expect(error).toMatchObject({ kind: "timeout" });
        expect(host.cancel).toHaveBeenCalledOnce();
        expect(host.releaseLock).toHaveBeenCalledOnce();
        expect(host.signal().aborted).toBe(true);
        expect(getEventListeners(host.signal(), "abort")).toHaveLength(0);
        expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        host.rejectRead(new Error("late read failure"));
        host.rejectCancel(new Error("late cancel failure"));
        await setImmediate();
        expect(escaped).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", escaped);
      }
    },
  );

  it("keeps a total deadline through arriving chunks, without resetting it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const held = bodyOf([new Uint8Array([1])]);
    const reader = held.body.getReader();
    const realRead = reader.read.bind(reader);
    let signal!: AbortSignal;
    const read = vi.fn(async () => {
      if (read.mock.calls.length === 1) {
        vi.advanceTimersByTime(60);
        return realRead();
      }
      vi.advanceTimersByTime(40);
      return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    });
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn(() => reader.releaseLock());
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const client = clientFor(async (_input, init) => {
      signal = init!.signal!;
      return response;
    });
    await expect(
      withinTick(client.downloadAttachment("s", "a", { timeoutMs: 100 })),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("finishes and removes the deadline so later abort does nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const held = bodyOf([new Uint8Array([1])]);
    const caller = new AbortController();
    await clientFor(async () => held.response).downloadAttachment("s", "a", {
      signal: caller.signal,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    caller.abort();
    expect(held.cancel).not.toHaveBeenCalled();
    expect(held.body.locked).toBe(false);
  });
});
