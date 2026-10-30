import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  type ExecutionFollowOptions,
  type ExecutionFollowStatus,
  type ExecutionHostApi,
} from "../../src/client/index.js";
import { createPortClient, servePort } from "../../src/port/index.js";
import { createStubHost, waitFor } from "../client/stub-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * One HTTP host followed two ways: directly by the HTTP client, and through a
 * port whose other end serves that same client. Whatever the host does, the
 * two follows must end alike (Codex review of #64).
 */
function twoWays(fetch: typeof globalThis.fetch): {
  direct: ExecutionHostApi;
  overPort: ExecutionHostApi;
} {
  const direct = createExecutionHostClient({
    baseUrl: "http://daemon.test",
    token: "stub-token",
    fetch,
  });
  const { port1, port2 } = new MessageChannel();
  const server = servePort(port2, direct);
  const overPort = createPortClient(port1);
  cleanups.push(() => {
    overPort.close();
    server.close();
  });
  return { direct, overPort };
}

/** A host whose event stream answers 503 every time, counting the asks. */
function unavailable() {
  let asked = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    if (String(input).endsWith("/events")) asked += 1;
    return new Response(JSON.stringify({ error: "draining" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, asked: () => asked };
}

async function follow(
  api: ExecutionHostApi,
  options: Omit<ExecutionFollowOptions, "onEnvelope">,
) {
  const statuses: ExecutionFollowStatus[] = [];
  const following = api.followSession("session-1", {
    ...options,
    onEnvelope: () => {},
    onStatus: (status) => {
      statuses.push(status);
    },
  });
  const end = await Promise.race([
    following.done,
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), 2_000),
    ),
  ]);
  if (end === "pending") await following.stop();
  return { end, statuses };
}

/** What can be compared of an end: its error as kind and status. */
function shape(end: unknown) {
  if (typeof end !== "object" || end === null) return end;
  const { error, ...rest } = end as { error?: unknown };
  return {
    ...rest,
    ...(error === undefined
      ? {}
      : {
          error:
            error instanceof ExecutionHostError
              ? { kind: error.kind, status: error.status, reason: error.reason }
              : String(error),
        }),
  };
}

function waitingShape(statuses: ExecutionFollowStatus[]) {
  return statuses
    .filter((status) => status.state === "waiting")
    .map((status) => ({ ...status, error: shape({ error: status.error }) }));
}

describe("a follow over a port ends as a direct one does", () => {
  it("gives up at once on a 503 with maxAttempts 0", async () => {
    const directHost = unavailable();
    const portHost = unavailable();
    const direct = await follow(twoWays(directHost.fetch).direct, {
      maxAttempts: 0,
    });
    const overPort = await follow(twoWays(portHost.fetch).overPort, {
      maxAttempts: 0,
    });
    expect(shape(direct.end)).toEqual({
      reason: "gave-up",
      lastSeq: 0,
      error: { kind: "http", status: 503, reason: "draining" },
    });
    expect(shape(overPort.end)).toEqual(shape(direct.end));
    expect(portHost.asked()).toBe(directHost.asked());
    expect(directHost.asked()).toBe(1);
  });

  it("retries by the caller's own limits and delays, saying why each time", async () => {
    const directHost = unavailable();
    const portHost = unavailable();
    const options = { maxAttempts: 2, retryDelayMs: () => 5 };
    const direct = await follow(twoWays(directHost.fetch).direct, options);
    const overPort = await follow(twoWays(portHost.fetch).overPort, options);
    expect(shape(direct.end)).toMatchObject({ reason: "gave-up" });
    expect(shape(overPort.end)).toEqual(shape(direct.end));
    expect(directHost.asked()).toBe(3);
    expect(portHost.asked()).toBe(3);
    expect(waitingShape(overPort.statuses)).toEqual(
      waitingShape(direct.statuses),
    );
    expect(waitingShape(direct.statuses)).toEqual([
      {
        state: "waiting",
        attempt: 1,
        delayMs: 5,
        error: { error: { kind: "http", status: 503, reason: "draining" } },
      },
      {
        state: "waiting",
        attempt: 2,
        delayMs: 5,
        error: { error: { kind: "http", status: 503, reason: "draining" } },
      },
    ]);
  });

  it("resumes after the host closes a stream, by the caller's delay, nothing twice", async () => {
    const host = createStubHost();
    const { overPort } = twoWays(host.fetch);
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "status", status: "idle" });
    const seqs: number[] = [];
    const statuses: ExecutionFollowStatus[] = [];
    const following = overPort.followSession("session-1", {
      retryDelayMs: () => 5,
      onEnvelope: (envelope) => {
        seqs.push(envelope.seq);
      },
      onStatus: (status) => {
        statuses.push(status);
      },
    });
    await waitFor(() => seqs.length === 2);
    host.closeStreams();
    await waitFor(() => statuses.some((status) => status.state === "waiting"));
    host.emit({ kind: "status", status: "running" });
    await waitFor(() => seqs.length === 3);
    await following.stop();
    expect(seqs).toEqual([1, 2, 3]);
    expect(statuses.find((status) => status.state === "waiting")).toMatchObject(
      { state: "waiting", attempt: 1, delayMs: 5, error: null },
    );
    expect(host.eventsRequests.map((request) => request.lastEventId)).toEqual([
      null,
      "2",
    ]);
  });
});
