import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionHostError,
  ExecutionInlineAttachmentsError,
  ExecutionInteractionResponseError,
  ExecutionSessionPatchError,
  ExecutionStartFileReachError,
  ExecutionStartInstructionsError,
  ExecutionStartRequirementsError,
  ExecutionStartSelectionError,
  ExecutionTaskOutputError,
  type ExecutionHostApi,
  type ExecutionHostErrorKind,
  type ExecutionFollowOptions,
} from "../../src/client/index.js";
import {
  createPortClient,
  PORT_CHUNKS_IN_FLIGHT,
  PORT_FRAMES_PER_CHUNK,
  servePort,
  type ExecutionHostPort,
} from "../../src/port/index.js";
import { FakeHostModel, fakeApi } from "../conformance/fake-host.js";
import { waitFor } from "../client/stub-host.js";
import { MessagePortMainLike } from "./electron-port.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A fake host's API, served on one end of a channel and driven from the other. */
function connect(
  override: (api: ExecutionHostApi) => Partial<ExecutionHostApi> = () => ({}),
) {
  const model = new FakeHostModel();
  const base = fakeApi(model);
  const api = { ...base, ...override(base) };
  const { port1, port2 } = new MessageChannel();
  const sent: unknown[] = [];
  const hostPort: ExecutionHostPort = {
    postMessage: (message) => {
      sent.push(message);
      port2.postMessage(message);
    },
    addEventListener: (type, listener) =>
      port2.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      port2.removeEventListener(type, listener),
    start: () => port2.start(),
    close: () => port2.close(),
  };
  const server = servePort(hostPort, api);
  const client = createPortClient(port1);
  cleanups.push(() => {
    client.close();
    server.close();
  });
  return { model, client, server, sent, port1, port2 };
}

function onEnvelopes(sink: number[]): ExecutionFollowOptions["onEnvelope"] {
  return (envelope) => {
    sink.push(envelope.seq);
  };
}

describe("errors over a port", () => {
  const kinds: ExecutionHostErrorKind[] = [
    "network",
    "timeout",
    "auth",
    "not-found",
    "http",
    "malformed",
  ];

  it.each(kinds)("keeps an ExecutionHostError's kind %s", async (kind) => {
    const thrown = new ExecutionHostError(kind, "the host's words", {
      operation: "snapshot",
      status: kind === "auth" ? 401 : null,
    });
    const { client } = connect(() => ({
      snapshot: async () => {
        throw thrown;
      },
    }));
    const error = await client.snapshot("s").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind,
      reason: "the host's words",
      operation: "snapshot",
      status: thrown.status,
      message: thrown.message,
    });
  });

  it("keeps each typed error's class and fields", async () => {
    const reach = { entries: [{ path: "src", access: "read" as const }] };
    const errors: Error[] = [
      new ExecutionStartRequirementsError("requirements-unmet", "no Xcode", {
        requires: ["ios.simulator"],
        missingTraits: ["ios.simulator"],
        status: 400,
      }),
      new ExecutionStartFileReachError("file-reach-unconfirmed", "no echo", {
        fileReach: reach,
        problems: [{ problem: "outside-host-reach", entry: 0 }] as never,
        status: 201,
        sessionId: "s",
        sessionDeleted: true,
      }),
      new ExecutionStartInstructionsError(
        "instructions-unsupported-provider",
        "not for this provider",
        400,
      ),
      new ExecutionStartSelectionError("unknown-skill", "skills", 400),
      new ExecutionInlineAttachmentsError("too-many", "five is too many", {
        operation: "start",
        index: 4,
      }),
      new ExecutionInteractionResponseError(
        "interactions-unsupported",
        "no structured answers",
        { operation: "command send-message" },
      ),
      new ExecutionSessionPatchError("turn-running", "after this turn", {
        sessionId: "s",
        status: 409,
      }),
      new ExecutionTaskOutputError("no-output", "nothing written", {
        status: 404,
        sessionId: "s",
        taskId: "t",
      }),
      new TypeError("start takes a request"),
      new RangeError("tail out of range"),
    ];
    for (const thrown of errors) {
      const { client } = connect(() => ({
        start: async () => {
          throw thrown;
        },
      }));
      const error = await client
        .start({} as never)
        .catch((caught: unknown) => caught);
      expect(error, thrown.name).toBeInstanceOf(thrown.constructor);
      expect(error, thrown.name).toEqual(thrown);
      expect((error as Error).message).toBe(thrown.message);
    }
  });

  it("makes any other failure an ExecutionHostError of kind http", async () => {
    const { client } = connect(() => ({
      providers: async () => {
        throw new Error("database is locked");
      },
      projects: async () => {
        throw "a string";
      },
    }));
    await expect(client.providers()).rejects.toMatchObject({
      name: "ExecutionHostError",
      kind: "http",
      operation: "providers",
      reason: "database is locked",
    });
    await expect(client.projects()).rejects.toMatchObject({
      kind: "http",
      reason: "a string",
    });
  });

  it("refuses a method the port does not serve, as a TypeError", async () => {
    const { port1, port2 } = new MessageChannel();
    const server = servePort(port2, fakeApi(new FakeHostModel()));
    cleanups.push(() => {
      server.close();
      port1.close();
    });
    const answer = new Promise((resolve) =>
      port1.once("message", (message) => resolve(message)),
    );
    port1.postMessage({
      channel: "execution-host-port",
      v: 1,
      type: "call",
      id: 7,
      method: "deleteSession",
      args: ["s"],
    });
    expect(await answer).toMatchObject({
      type: "error",
      id: 7,
      error: {
        name: "TypeError",
        message: "The port does not serve deleteSession",
      },
    });
  });

  it("reads no message of another channel", async () => {
    const { client, port1 } = connect();
    port1.postMessage({ type: "call", id: 1, method: "providers", args: [] });
    port1.postMessage("noise");
    expect((await client.providers()).length).toBeGreaterThan(0);
  });
});

describe("calls over a port", () => {
  it("passes arguments and options, and the host's own signal", async () => {
    const seen: unknown[] = [];
    const { client } = connect((api) => ({
      command: async (sessionId, command, options) => {
        seen.push({ sessionId, command, options });
        return api.command(sessionId, command, options);
      },
    }));
    const caller = new AbortController();
    await client.command(
      "s",
      { kind: "stop" },
      {
        commandId: "c-1",
        actor: { kind: "agent", id: "anton" } as never,
        timeoutMs: 1234,
        signal: caller.signal,
      },
    );
    expect(seen).toEqual([
      {
        sessionId: "s",
        command: { kind: "stop" },
        options: {
          commandId: "c-1",
          actor: { kind: "agent", id: "anton" },
          timeoutMs: 1234,
          signal: expect.any(AbortSignal),
        },
      },
    ]);
  });

  it("rejects with the caller's reason at once, and cancels on the host", async () => {
    let hostSignal: AbortSignal | undefined;
    const { client } = connect(() => ({
      snapshot: (_sessionId, options) => {
        hostSignal = options?.signal;
        return new Promise(() => {});
      },
    }));
    const caller = new AbortController();
    const reason = new Error("gave up");
    const pending = client.snapshot("s", { signal: caller.signal });
    await waitFor(() => hostSignal !== undefined);
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await waitFor(() => hostSignal!.aborted);
  });

  it("carries an attachment's bytes", async () => {
    const { client, model } = connect();
    await client.start({
      protocolVersion: 1,
      providerId: "claude",
      config: {
        sessionId: "s",
        initialMessage: "hi",
        model: null,
        effort: null,
        continuationToken: null,
      },
    });
    const bytes = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
    const id = model.attach("s", bytes);
    const download = await client.downloadAttachment("s", id);
    expect(download.sizeBytes).toBe(bytes.byteLength);
    expect(download.bytes).toEqual(bytes);
  });

  it("rejects a value that does not clone, as an http failure", async () => {
    const { client } = connect(() => ({
      providers: async () => [{ id: "claude", label: () => "Claude" }] as never,
    }));
    await expect(client.providers()).rejects.toMatchObject({
      name: "ExecutionHostError",
      kind: "http",
    });
  });
});

describe("closing a port", () => {
  it("rejects what waits, and what comes after, as network failures", async () => {
    const { client, server } = connect(() => ({
      snapshot: () => new Promise(() => {}),
    }));
    const pending = client.snapshot("s");
    await new Promise((resolve) => setTimeout(resolve, 10));
    server.close();
    await expect(pending).rejects.toMatchObject({
      name: "ExecutionHostError",
      kind: "network",
      operation: "snapshot",
    });
    await expect(client.providers()).rejects.toMatchObject({
      kind: "network",
      operation: "providers",
    });
  });

  it("ends a follow gave-up when the host's side closes", async () => {
    const { client, server, model } = connect();
    model.start("s", "claude");
    const seqs: number[] = [];
    const follow = client.followSession("s", { onEnvelope: onEnvelopes(seqs) });
    await waitFor(() => seqs.length === 1);
    server.close();
    const end = await follow.done;
    expect(end).toMatchObject({ reason: "gave-up", lastSeq: 1 });
    expect(end.reason === "gave-up" && end.error).toMatchObject({
      name: "ExecutionHostError",
      kind: "network",
    });
  });

  it("ends a follow stopped when the client closes", async () => {
    const { client, model } = connect();
    model.start("s", "claude");
    const follow = client.followSession("s", { onEnvelope: () => {} });
    client.close();
    expect(await follow.done).toMatchObject({ reason: "stopped" });
  });

  it("stops the host's follow when the client stops its own", async () => {
    let hostFollow: ReturnType<ExecutionHostApi["followSession"]> | undefined;
    const { client, model } = connect((api) => ({
      followSession: (sessionId, options) =>
        (hostFollow = api.followSession(sessionId, options)),
    }));
    model.start("s", "claude");
    const seqs: number[] = [];
    const follow = client.followSession("s", { onEnvelope: onEnvelopes(seqs) });
    await waitFor(() => seqs.length === 1);
    await follow.stop();
    expect(await hostFollow!.done).toMatchObject({ reason: "stopped" });
  });
});

describe("following over a port", () => {
  it("sends a long replay in chunks, each envelope once and in order", async () => {
    const { client, model, sent } = connect();
    model.start("s", "claude");
    const count = 3_000;
    model.emit(
      "s",
      Array.from({ length: count - 1 }, (_, index) => ({
        kind: "continuation-token" as const,
        token: `t-${index}`,
      })),
    );
    const seqs: number[] = [];
    const follow = client.followSession("s", { onEnvelope: onEnvelopes(seqs) });
    await waitFor(() => seqs.length === count, 5_000);
    await follow.stop();
    expect(seqs).toEqual(
      Array.from({ length: count }, (_, index) => index + 1),
    );
    const chunks = sent.filter(
      (message) => (message as { type?: string }).type === "frames",
    ) as Array<{ frames: unknown[] }>;
    expect(
      chunks.every((chunk) => chunk.frames.length <= PORT_FRAMES_PER_CHUNK),
    ).toBe(true);
    // A handful of messages, not one per envelope.
    expect(chunks.length).toBeLessThan(count / 50);
  });

  it("runs the host's follow no further ahead than the chunks in flight", async () => {
    let handedOn = 0;
    const { client, model } = connect((api) => ({
      followSession: (sessionId, options) =>
        api.followSession(sessionId, {
          ...options,
          onEnvelope: (envelope, info) => {
            handedOn += 1;
            return options.onEnvelope(envelope, info);
          },
        }),
    }));
    model.start("s", "claude");
    model.emit(
      "s",
      Array.from({ length: 5_000 }, (_, index) => ({
        kind: "continuation-token" as const,
        token: `t-${index}`,
      })),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const follow = client.followSession("s", { onEnvelope: () => gate });
    await waitFor(() => handedOn > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Up to the chunks in flight, plus the one being filled.
    expect(handedOn).toBeLessThanOrEqual(
      (PORT_CHUNKS_IN_FLIGHT + 1) * PORT_FRAMES_PER_CHUNK + 1,
    );
    release();
    await follow.stop();
  });

  it("resumes after a given seq, with nothing missing and nothing twice", async () => {
    const { client, model } = connect();
    model.start("s", "claude");
    model.emit(
      "s",
      Array.from({ length: 9 }, (_, index) => ({
        kind: "continuation-token" as const,
        token: `t-${index}`,
      })),
    );
    const seqs: number[] = [];
    const follow = client.followSession("s", {
      afterSeq: 4,
      onEnvelope: onEnvelopes(seqs),
    });
    await waitFor(() => seqs.length === 6);
    model.emit("s", [{ kind: "status", status: "idle" }]);
    await waitFor(() => seqs.length === 7);
    await follow.stop();
    expect(seqs).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it("ends a stream whose frame does not clone, rather than the process", async () => {
    const { client, model } = connect((api) => ({
      followSession: (sessionId, options) =>
        api.followSession(sessionId, {
          ...options,
          onEnvelope: (envelope, info) =>
            options.onEnvelope(
              {
                ...envelope,
                event: { ...envelope.event, poison: () => {} },
              } as never,
              info,
            ),
        }),
    }));
    model.start("s", "claude");
    const statuses: unknown[] = [];
    const follow = client.followSession("s", {
      onEnvelope: () => {},
      onStatus: (status) => {
        statuses.push(status);
      },
    });
    await waitFor(() =>
      statuses.some(
        (status) =>
          (status as { state: string }).state === "waiting" &&
          (status as { error: unknown }).error instanceof ExecutionHostError,
      ),
    );
    await follow.stop();
  });

  it("hands on no envelope about another session", async () => {
    const { port1, port2 } = new MessageChannel();
    const client = createPortClient(port1);
    cleanups.push(() => {
      client.close();
      port2.close();
    });
    const envelope = (sessionId: string, seq: number) => ({
      protocolVersion: 1,
      sessionId,
      seq,
      event: { kind: "status", status: "idle" },
    });
    // A host that answers a follow with another session's envelope among its own.
    port2.on("message", (message: { type: string; id: number }) => {
      if (message.type !== "follow") return;
      port2.postMessage({
        channel: "execution-host-port",
        v: 1,
        type: "frames",
        id: message.id,
        frames: [
          { type: "open" },
          {
            type: "envelope",
            envelope: envelope("s", 1),
            replay: false,
            warnings: [],
          },
          {
            type: "envelope",
            envelope: envelope("other", 2),
            replay: false,
            warnings: [],
          },
          {
            type: "envelope",
            envelope: envelope("s", 2),
            replay: false,
            warnings: [],
          },
          null,
        ],
      });
    });
    const seqs: number[] = [];
    const skips: unknown[] = [];
    const follow = client.followSession("s", {
      onEnvelope: onEnvelopes(seqs),
      onSkip: (skip) => {
        skips.push(skip);
      },
    });
    await waitFor(() => seqs.length === 2 && skips.length === 2);
    await follow.stop();
    expect(seqs).toEqual([1, 2]);
    expect(skips).toEqual([
      { reason: "unreadable", seq: null, detail: "invalid-envelope" },
      { reason: "unreadable", seq: null, detail: "invalid-payload" },
    ]);
  });

  it("ends no-session, with a not-found error, when the session goes", async () => {
    const { client, model } = connect();
    model.start("s", "claude");
    const seqs: number[] = [];
    const follow = client.followSession("s", { onEnvelope: onEnvelopes(seqs) });
    await waitFor(() => seqs.length === 1);
    model.remove("s");
    const end = await follow.done;
    expect(end.reason).toBe("no-session");
    expect(end.reason === "no-session" && end.error).toMatchObject({
      name: "ExecutionHostError",
      kind: "not-found",
    });
  });
});

describe("ports", () => {
  it("hears an Electron-shaped port close, and lets go of it", async () => {
    const { port1, port2 } = new MessageChannel();
    const hostPort = new MessagePortMainLike(port2);
    const server = servePort(hostPort, {
      ...fakeApi(new FakeHostModel()),
      snapshot: () => new Promise(() => {}),
    });
    const clientPort = new MessagePortMainLike(port1);
    const client = createPortClient(clientPort);
    expect(clientPort.listenerCount("message")).toBe(1);
    const pending = client.snapshot("s");
    await new Promise((resolve) => setTimeout(resolve, 10));
    server.close();
    await expect(pending).rejects.toMatchObject({ kind: "network" });
    expect(clientPort.listenerCount("message")).toBe(0);
    expect(hostPort.listenerCount("message")).toBe(0);
  });

  it("refuses a port it cannot listen to", () => {
    expect(() =>
      createPortClient({ postMessage: () => {} } as ExecutionHostPort),
    ).toThrow(TypeError);
  });
});
