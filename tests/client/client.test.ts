import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  type ExecutionHostClientOptions,
  type ExecutionStreamFrame,
} from "../../src/client/index.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionStartRequest,
} from "../../src/index.js";
import {
  personActorFixture,
  sessionWorkspaceFixtures,
} from "../fixtures/contract-fixtures.js";
import { createStubHost, type StubHost, waitFor } from "./stub-host.js";

let host: StubHost;
let warnings: Array<
  Parameters<NonNullable<ExecutionHostClientOptions["onWarnings"]>>[0]
>;

beforeEach(() => {
  host = createStubHost();
  warnings = [];
});

const client = (overrides: Partial<ExecutionHostClientOptions> = {}) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: host.fetch,
    createCommandId: (() => {
      let next = 0;
      return () => `minted-${(next += 1)}`;
    })(),
    onWarnings: (notice) => warnings.push(notice),
    ...overrides,
  });

const startRequest = (sessionId: string): ExecutionStartRequest => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  providerId: "claude",
  config: {
    sessionId,
    initialMessage: "Ship the staging banner",
    model: null,
    effort: null,
    continuationToken: null,
  },
  actor: personActorFixture,
});

describe("health and capabilities", () => {
  it("reads /health without sending the token", async () => {
    const health = await client().health();

    expect(health.capabilities).toContain("deltas.append.v1");
    expect(host.healthRequests).toEqual([{ authorization: null }]);
  });

  it("refuses a /health that is not a host's", async () => {
    host.healthBody = { status: "maintenance" };
    await expect(client().health()).rejects.toMatchObject({
      kind: "malformed",
      operation: "health",
    });
  });

  it("is connected only when the token is accepted too", async () => {
    expect(await client().handshake()).toMatchObject({ status: "connected" });
    expect(await client({ token: "not-the-token" }).handshake()).toMatchObject({
      status: "unauthorized",
      detail: "The host refused the token",
    });
    expect(await client({ token: " " }).handshake()).toMatchObject({
      status: "unauthorized",
    });
  });

  it("calls a host that does not answer unreachable, and never throws for it", async () => {
    const down = client({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await down.handshake()).toMatchObject({
      status: "unreachable",
      health: null,
    });
  });

  it("calls a host on another apiVersion incompatible", async () => {
    host.healthBody = { status: "ok", apiVersion: "v1" };
    expect(await client().handshake()).toMatchObject({
      status: "incompatible",
    });
  });

  it("lists the host's Projects", async () => {
    host.projectsBody = {
      projects: [
        { id: "new-blok", name: "new-blok", workingDirectory: "/srv/new-blok" },
      ],
    };
    expect(await client().projects()).toEqual([
      {
        id: "new-blok",
        name: "new-blok",
        workingDirectory: "/srv/new-blok",
        origin: null,
        originKey: null,
        environments: [],
      },
    ]);
  });
});

describe("starting a session", () => {
  it("sends who started it and a minted command id, and reads the echo", async () => {
    host.startBody = (request) => ({
      protocolVersion: 1,
      sessionId: (request.config as { sessionId: string }).sessionId,
      workspace: sessionWorkspaceFixtures.project.value,
    });

    expect(await client().start(startRequest("session-new"))).toEqual({
      status: "started",
      sessionId: "session-new",
      commandId: "minted-1",
      workspace: sessionWorkspaceFixtures.project.value,
    });
    expect(host.startRequests[0]).toMatchObject({
      commandId: "minted-1",
      actor: personActorFixture,
    });
  });

  it("keeps a command id the caller chose", async () => {
    const result = await client().start({
      ...startRequest("session-new"),
      commandId: "caller-1",
    });
    expect(result).toMatchObject({ status: "started", commandId: "caller-1" });
  });

  it("refuses a start id the host would refuse, before sending anything", async () => {
    await expect(
      client().start({ ...startRequest("session-new"), commandId: "" }),
    ).rejects.toThrow(TypeError);
    expect(host.startRequests).toEqual([]);
  });

  it("says a session already exists rather than failing", async () => {
    expect(await client().start(startRequest("session-1"))).toEqual({
      status: "exists",
      sessionId: "session-1",
      commandId: "minted-1",
    });
  });

  it("refuses an answer about another session", async () => {
    host.startBody = () => ({ protocolVersion: 1, sessionId: "someone-else" });
    await expect(
      client().start(startRequest("session-new")),
    ).rejects.toMatchObject({
      kind: "malformed",
      reason: "the host answered about session someone-else, not session-new",
    });
  });

  it("degrades an echoed workspace it cannot read to none, out loud", async () => {
    host.startBody = () => ({
      protocolVersion: 1,
      sessionId: "session-new",
      workspace: { mode: "sublet" },
    });
    expect(await client().start(startRequest("session-new"))).toMatchObject({
      status: "started",
      workspace: null,
    });
    expect(warnings).toEqual([
      {
        operation: "start",
        sessionId: "session-new",
        warnings: [{ reason: "dropped-invalid-field", path: "workspace" }],
      },
    ]);
  });

  it("carries the host's own words when it refuses, and never the token", async () => {
    host.startStatus = 502;
    const error = await client()
      .start(startRequest("session-new"))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "http",
      status: 502,
      reason: "Provider claude failed to start",
      message: "start failed: HTTP 502: Provider claude failed to start",
    });
    expect(JSON.stringify(error) + String(error)).not.toContain(host.token);
  });
});

describe("commands", () => {
  it("sends every command in an envelope with its actor and command id", async () => {
    const result = await client().command(
      "session-1",
      { kind: "send-message", text: "And the footer" },
      { actor: personActorFixture },
    );

    expect(result).toEqual({ status: "accepted", commandId: "minted-1" });
    expect(host.commandRequests).toEqual([
      {
        sessionId: "session-1",
        body: {
          protocolVersion: 1,
          sessionId: "session-1",
          commandId: "minted-1",
          actor: personActorFixture,
          command: { kind: "send-message", text: "And the footer" },
        },
      },
    ]);
  });

  it("reuses a command id the caller passes, so a retry is the same command", async () => {
    const send = () =>
      client().command(
        "session-1",
        { kind: "interrupt" },
        { commandId: "retry-me" },
      );
    await send();
    await send();
    expect(
      host.commandRequests.map((request) => request.body.commandId),
    ).toEqual(["retry-me", "retry-me"]);
  });

  it("refuses a command id the host would refuse, before sending anything", async () => {
    for (const commandId of ["", "c".repeat(257)]) {
      await expect(
        client().command("session-1", { kind: "stop" }, { commandId }),
      ).rejects.toThrow(TypeError);
    }
    await expect(
      client({ createCommandId: () => "" }).command("session-1", {
        kind: "stop",
      }),
    ).rejects.toThrow(/createCommandId/);
    expect(host.commandRequests).toEqual([]);
  });

  it("says when the host has no such session", async () => {
    expect(await client().command("session-gone", { kind: "stop" })).toEqual({
      status: "no-session",
      commandId: "minted-1",
    });
  });

  it("throws the host's refusal for anything else", async () => {
    host.commandStatus = 409;
    await expect(
      client().command("session-1", { kind: "steer", text: "faster" }),
    ).rejects.toMatchObject({
      kind: "http",
      status: 409,
      operation: "command steer",
      reason: "Session has stopped",
    });
  });

  it("refuses a token the host refuses", async () => {
    await expect(
      client({ token: "wrong" }).command("session-1", { kind: "stop" }),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });
});

describe("snapshots and requests", () => {
  it("reads a snapshot, and null for a session the host does not have", async () => {
    host.snapshots.set("session-1", {
      protocolVersion: 1,
      sessionId: "session-1",
      providerId: "claude",
      status: "running",
      conversation: [],
      lastSeq: 3,
    });
    expect(await client().snapshot("session-1")).toMatchObject({
      status: "running",
      lastSeq: 3,
    });
    expect(await client().snapshot("session-2")).toBeNull();
  });

  it("refuses a snapshot it cannot read", async () => {
    host.snapshots.set("session-1", {
      protocolVersion: 1,
      sessionId: "session-1",
    });
    await expect(client().snapshot("session-1")).rejects.toMatchObject({
      kind: "malformed",
      operation: "snapshot",
    });
  });

  it("gives up on a request at its deadline, and lets the caller abort one", async () => {
    const hanging = client({
      requestTimeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        ),
    });
    await expect(hanging.snapshot("session-1")).rejects.toMatchObject({
      kind: "timeout",
      reason: "no answer within 20 ms",
    });

    const caller = new AbortController();
    const pending = hanging.snapshot("session-1", {
      signal: caller.signal,
      timeoutMs: 60_000,
    });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("one connection to the event stream", () => {
  const collect = async (
    stream: AsyncIterable<ExecutionStreamFrame>,
    until: (frames: ExecutionStreamFrame[]) => boolean,
  ) => {
    const frames: ExecutionStreamFrame[] = [];
    for await (const frame of stream) {
      frames.push(frame);
      if (until(frames)) break;
    }
    return frames;
  };

  it("resumes after a sequence number, asks for increments, and names the replay", async () => {
    host.emit({ kind: "status", status: "running" });
    host.emit({ kind: "activity", activity: "thinking" });
    host.emit({ kind: "status", status: "completed" });

    const frames = await collect(
      client().events("session-1", { afterSeq: 1, deltas: "append" }),
      (seen) => seen.some((frame) => frame.type === "caught-up"),
    );

    expect(host.eventsRequests).toEqual([
      {
        sessionId: "session-1",
        lastEventId: "1",
        deltas: "append",
        authorization: `Bearer ${host.token}`,
      },
    ]);
    expect(frames.map((frame) => frame.type)).toEqual([
      "open",
      "envelope",
      "envelope",
      "caught-up",
    ]);
    expect(frames[1]).toMatchObject({ replay: true, envelope: { seq: 2 } });
    expect(frames[3]).toEqual({ type: "caught-up", throughSeq: 3 });
    expect(host.openStreams()).toBe(0);
  });

  it("decodes a newer kind as skipped and a broken frame as unreadable", async () => {
    host.framing = false;
    const frames = client().events("session-1");
    const seen: ExecutionStreamFrame[] = [];
    const reading = (async () => {
      for await (const frame of frames) {
        seen.push(frame);
        if (seen.length === 4) break;
      }
    })();
    await waitFor(() => host.openStreams() === 1);
    host.writeRaw(
      'id: 1\ndata: {"protocolVersion":1,"sessionId":"session-1","seq":1,"event":{"kind":"presence"}}\n\n',
    );
    host.writeRaw("id: 2\ndata: {broken\n\n");
    host.writeRaw(
      'id: 3\ndata: {"protocolVersion":1,"sessionId":"another","seq":3,"event":{"kind":"heartbeat"}}\n\n',
    );
    await reading;

    expect(seen).toEqual([
      { type: "open" },
      {
        type: "skipped",
        replay: false,
        skipped: {
          sessionId: "session-1",
          seq: 1,
          path: "event.kind",
          kind: "presence",
        },
      },
      { type: "unreadable", reason: "malformed-json", id: "2", replay: false },
      // About another session: it says nothing about where this one is.
      {
        type: "unreadable",
        reason: "invalid-envelope",
        id: null,
        replay: false,
      },
    ]);
  });

  it("reads only unnamed, `message` and `replay` frames, as EventSource does", async () => {
    host.framing = false;
    const frames = client().events("session-1");
    const seen: ExecutionStreamFrame[] = [];
    const reading = (async () => {
      for await (const frame of frames) {
        seen.push(frame);
        if (seen.length === 3) break;
      }
    })();
    await waitFor(() => host.openStreams() === 1);
    const envelope = (seq: number) =>
      `{"protocolVersion":1,"sessionId":"session-1","seq":${seq},"event":{"kind":"heartbeat"}}`;
    host.writeRaw(`event: presence\nid: 1\ndata: ${envelope(1)}\n\n`);
    host.writeRaw("event: ping\ndata: not an envelope\n\n");
    host.writeRaw(`event: message\nid: 1\ndata: ${envelope(1)}\n\n`);
    host.writeRaw(`event: replay\nid: 2\ndata: ${envelope(2)}\n\n`);
    await reading;

    expect(
      seen.map((frame) => [frame.type, "replay" in frame && frame.replay]),
    ).toEqual([
      ["open", false],
      ["envelope", false],
      ["envelope", true],
    ]);
  });

  it("refuses an answer without a body, as React Native's fetch can give", async () => {
    const bodiless = client({
      fetch: async () =>
        ({ ok: true, status: 200, body: undefined }) as unknown as Response,
    });
    const reading = (async () => {
      for await (const frame of bodiless.events("session-1")) void frame;
    })();
    await expect(reading).rejects.toMatchObject({
      kind: "malformed",
      operation: "events",
    });
  });

  it("fails to open with the host's verdict", async () => {
    await expect(
      collect(client().events("session-gone"), () => true),
    ).rejects.toMatchObject({
      kind: "not-found",
      status: 404,
      operation: "events",
    });
  });

  it("ends quietly when the caller aborts it", async () => {
    const caller = new AbortController();
    const seen: ExecutionStreamFrame[] = [];
    const reading = collect(
      client().events("session-1", { signal: caller.signal }),
      (frames) => {
        seen.push(frames.at(-1)!);
        return false;
      },
    );
    await waitFor(() => seen.some((frame) => frame.type === "caught-up"));
    caller.abort();
    await expect(reading).resolves.toEqual([
      { type: "open" },
      { type: "caught-up", throughSeq: 0 },
    ]);
    expect(host.openStreams()).toBe(0);
  });

  it("fails a connection that goes quiet past its idle timeout", async () => {
    host.framing = false;
    await expect(
      collect(client().events("session-1", { idleTimeoutMs: 30 }), () => false),
    ).rejects.toMatchObject({ kind: "timeout", operation: "events" });
    expect(host.openStreams()).toBe(0);
  });
});

describe("the token", () => {
  const SECRET = "sk-live-SECRET-0123456789";

  it("refuses a token no request could carry, without repeating it", () => {
    for (const token of [`${SECRET}\nextra`, `${SECRET}\u0000`, `${SECRET}é`]) {
      let thrown: unknown;
      try {
        client({ token });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).not.toContain("SECRET");
    }
  });

  it("sends a token with surrounding whitespace the way fetch would, trimmed", async () => {
    await client({ token: `  ${host.token}\n` }).command("session-1", {
      kind: "stop",
    });
    expect(host.commandRequests).toHaveLength(1);
  });

  it("keeps the token out of every message it builds from a failure", async () => {
    // A runtime that quotes the header it choked on.
    const echoing = client({
      token: SECRET,
      fetch: async (_input, init) => {
        const value = new Headers(init?.headers).get("Authorization");
        throw new TypeError(
          `Headers.append: "${value}" is an invalid header value`,
        );
      },
    });
    const error = await echoing.snapshot("session-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error.reason).not.toContain(SECRET);
    expect(error.message).not.toContain(SECRET);
    expect(String(error.cause ?? "")).not.toContain(SECRET);
    expect(error.reason).toContain("[token]");

    const handshake = await client({
      token: SECRET,
      fetch: async (input, init) => {
        if (String(input).endsWith("/health")) return host.fetch(input, init);
        throw new TypeError(`bad header Bearer ${SECRET}`);
      },
    }).handshake();
    expect(handshake.status).toBe("unreachable");
    expect(handshake.detail).not.toContain(SECRET);
  });

  it("keeps the token out of a host's refusal that quotes it", async () => {
    const quoting = client({
      token: SECRET,
      fetch: async () =>
        new Response(JSON.stringify({ error: `token ${SECRET} is revoked` }), {
          status: 403,
        }),
    });
    const error = await quoting
      .command("session-1", { kind: "stop" })
      .catch((caught) => caught);
    expect(error).toMatchObject({ kind: "auth", status: 403 });
    expect(error.reason).toBe("token [token] is revoked");
  });

  it("keeps the token out of what a follow reports", async () => {
    const statuses: unknown[] = [];
    const followed = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: SECRET,
      fetch: async () => {
        throw new TypeError(`bad header Bearer ${SECRET}`);
      },
    }).followSession("session-1", {
      onEnvelope: () => {},
      onStatus: (status) => statuses.push(status),
      retryDelayMs: () => 0,
      maxAttempts: 1,
    });
    const end = await followed.done;

    expect(end.reason).toBe("gave-up");
    expect(
      JSON.stringify(statuses) + String((end as { error?: unknown }).error),
    ).not.toContain(SECRET);
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: "waiting",
        error: expect.objectContaining({ kind: "network" }),
      }),
    );
  });
});
