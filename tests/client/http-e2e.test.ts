import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExecutionHostClient } from "../../src/client/index.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  encodeExecutionEventEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
} from "../../src/index.js";
import { personActorFixture } from "../fixtures/contract-fixtures.js";
import { HEALTH_BODY, waitFor } from "./stub-host.js";

/**
 * The same client against a real socket and Node's own `fetch`: what the fake
 * fetch cannot show — chunks split mid-frame, a host that hangs up, and a
 * follow that lets go of its connection when stopped.
 */
const TOKEN = "e2e-token";

let server: Server;
let baseUrl: string;
let log: ExecutionHostEventEnvelope[];
let streams: ServerResponse[];
let streamRequests: Array<{ lastEventId: string | undefined; closed: boolean }>;
let commands: unknown[];

const frame = (envelope: ExecutionHostEventEnvelope, name?: string) =>
  `${name ? `event: ${name}\n` : ""}id: ${envelope.seq}\ndata: ${encodeExecutionEventEnvelope(envelope)}\n\n`;

const emit = (event: ExecutionHostEvent) => {
  const envelope: ExecutionHostEventEnvelope = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-e2e",
    seq: log.length + 1,
    event,
  };
  log.push(envelope);
  // Cut every frame in two, mid-line, so the reader must reassemble it.
  const text = frame(envelope);
  const cut = Math.floor(text.length / 2);
  for (const stream of streams) {
    stream.write(text.slice(0, cut));
    stream.write(text.slice(cut));
  }
};

const handle = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/health") return json(200, HEALTH_BODY);
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    return json(401, { error: "Unauthorized" });
  }
  const body = await new Promise<string>((resolve) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => resolve(text));
  });
  if (url.pathname === "/v0/meta") return json(200, { providers: [] });
  if (url.pathname === "/v0/execution/sessions" && request.method === "POST") {
    return json(201, { protocolVersion: 1, sessionId: "session-e2e" });
  }
  if (url.pathname === "/v0/execution/sessions/session-e2e/commands") {
    commands.push(JSON.parse(body));
    return json(202, { accepted: true });
  }
  if (url.pathname === "/v0/execution/sessions/session-e2e/events") {
    const lastEventId = request.headers["last-event-id"] as string | undefined;
    const seen = { lastEventId, closed: false };
    streamRequests.push(seen);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const after = Number(lastEventId ?? 0);
    const replay = log.filter((envelope) => envelope.seq > after);
    for (const envelope of replay) response.write(frame(envelope, "replay"));
    response.write(
      `event: caught-up\ndata: ${JSON.stringify({ throughSeq: replay.at(-1)?.seq ?? after })}\n\n`,
    );
    streams.push(response);
    // The response's close, not the request's: on a kept-alive socket a
    // request the host ended never closes, while a client hanging up does.
    response.on("close", () => {
      seen.closed = true;
      streams = streams.filter((stream) => stream !== response);
    });
    return;
  }
  return json(404, { error: "Not found" });
};

beforeEach(async () => {
  log = [];
  streams = [];
  streamRequests = [];
  commands = [];
  server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("over a real socket", () => {
  it("starts, commands, follows across a hang-up, and lets go when stopped", async () => {
    const client = createExecutionHostClient({ baseUrl, token: TOKEN });
    expect(await client.handshake()).toMatchObject({ status: "connected" });
    expect(
      await client.start({
        protocolVersion: 1,
        providerId: "claude",
        config: {
          sessionId: "session-e2e",
          initialMessage: "hello",
          model: null,
          effort: null,
          continuationToken: null,
        },
      }),
    ).toMatchObject({ status: "started", sessionId: "session-e2e" });

    const seqs: number[] = [];
    const follow = client.followSession("session-e2e", {
      onEnvelope: (envelope) => {
        seqs.push(envelope.seq);
      },
      retryDelayMs: () => 10,
    });
    await waitFor(() => streams.length === 1);
    emit({ kind: "status", status: "running" });
    emit({ kind: "status", status: "completed" });
    await waitFor(() => seqs.length === 2);

    // The host hangs up — a restart, a deploy — and the follow resumes.
    for (const stream of streams) stream.end();
    await waitFor(() => streamRequests.length === 2 && streams.length === 1);
    expect(streamRequests[1]?.lastEventId).toBe("2");

    // A later turn, sent by someone else, reaches the same follow.
    await client.command(
      "session-e2e",
      { kind: "send-message", text: "and the footer" },
      { actor: personActorFixture, commandId: "e2e-1" },
    );
    emit({ kind: "status", status: "running" });
    await waitFor(() => seqs.length === 3);

    expect(seqs).toEqual([1, 2, 3]);
    expect(commands).toEqual([
      {
        protocolVersion: 1,
        sessionId: "session-e2e",
        commandId: "e2e-1",
        actor: personActorFixture,
        command: { kind: "send-message", text: "and the footer" },
      },
    ]);
    await expect(follow.stop()).resolves.toEqual({
      reason: "stopped",
      lastSeq: 3,
    });
    await waitFor(() => streamRequests.every((request) => request.closed));
  });
});

describe("a host that redirects", () => {
  it("never follows it: the token stays with the host it was given to", async () => {
    const elsewhere: Array<{ url: string; authorization: string | null }> = [];
    const other = createServer((request, response) => {
      elsewhere.push({
        url: request.url ?? "",
        authorization: request.headers.authorization ?? null,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"projects":[]}');
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
    const moved = createServer((request, response) => {
      response.writeHead(request.method === "POST" ? 307 : 302, {
        Location: `${otherUrl}${request.url ?? "/"}`,
      });
      response.end();
    });
    await new Promise<void>((resolve) => moved.listen(0, "127.0.0.1", resolve));
    try {
      const client = createExecutionHostClient({
        baseUrl: `http://127.0.0.1:${(moved.address() as AddressInfo).port}`,
        token: TOKEN,
      });

      await expect(client.projects()).rejects.toMatchObject({
        kind: "network",
      });
      await expect(
        client.command("session-e2e", { kind: "stop" }),
      ).rejects.toMatchObject({ kind: "network" });
      expect(elsewhere).toEqual([]);
    } finally {
      moved.closeAllConnections();
      other.closeAllConnections();
      await new Promise((resolve) => moved.close(resolve));
      await new Promise((resolve) => other.close(resolve));
    }
  });
});
