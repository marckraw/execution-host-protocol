import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
} from "../../src/index.js";

/**
 * A stub execution host behind a fake `fetch`: the routes agents-daemon serves
 * and its event stream, which replays its log after `Last-Event-ID` and then
 * goes live — with switches for what goes wrong in the field.
 *
 * - `loseFrame` logs an envelope without writing it: the wire lost it, and a
 *   resume can still fetch it. The only honest way to stage a gap.
 * - `prune` deletes envelopes from the log, as a host does once an item
 *   settles: holes a replay cannot fill.
 * - `framing` names replayed frames `replay` and ends each replay with a
 *   `caught-up` frame (agents-daemon `414f740`); off, it streams as master does.
 *   As the host does, envelopes that arrived while the replay was being read
 *   (`bufferedSeqs`) follow the named replay unnamed, and `caught-up` carries
 *   the last `seq` written.
 */
export interface StubHost {
  fetch: typeof globalThis.fetch;
  /** Logs an envelope and writes it to every open stream of its session. */
  emit(
    event: ExecutionHostEvent,
    sessionId?: string,
  ): ExecutionHostEventEnvelope;
  loseFrame(event: ExecutionHostEvent, sessionId?: string): void;
  /** Logs several envelopes and writes them as ONE chunk, as a replay arrives. */
  emitBatch(events: ExecutionHostEvent[], sessionId?: string): void;
  /** Writes raw SSE text to every open stream (a frame the client cannot read). */
  writeRaw(text: string): void;
  /** Writes raw bytes to every open stream, cut wherever the test cuts them. */
  writeBytes(bytes: Uint8Array): void;
  /** The `redirect` mode of every request, in order. */
  redirectModes: Array<string | undefined>;
  prune(...seqs: number[]): void;
  /** Ends every open stream cleanly, as a host restart does. */
  closeStreams(): void;
  /** Breaks every open stream mid-read. */
  breakStreams(): void;
  framing: boolean;
  /** Logged envelopes a connection writes as live (unnamed) after its replay. */
  bufferedSeqs: Set<number>;
  log: ExecutionHostEventEnvelope[];
  openStreams(): number;
  eventsRequests: Array<{
    sessionId: string;
    lastEventId: string | null;
    deltas: string | null;
    authorization: string | null;
  }>;
  /** Status the next events requests answer with, instead of a stream. */
  eventsStatus: number;
  healthRequests: Array<{ authorization: string | null }>;
  healthBody: unknown;
  healthStatus: number;
  metaStatus: number;
  projectsBody: unknown;
  startRequests: Array<Record<string, unknown>>;
  startStatus: number;
  startBody: ((request: Record<string, unknown>) => unknown) | null;
  commandRequests: Array<{ sessionId: string; body: Record<string, unknown> }>;
  commandStatus: number;
  patchRequests: Array<{ sessionId: string; body: Record<string, unknown> }>;
  /** Status the next session patches answer with; 400 refuses the selection. */
  patchStatus: number;
  /** The answer to a session patch; by default the patch, echoed. */
  patchBody:
    ((sessionId: string, patch: Record<string, unknown>) => unknown) | null;
  sessions: Set<string>;
  snapshots: Map<string, unknown>;
  token: string;
}

const encoder = new TextEncoder();

interface OpenStream {
  sessionId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  detach: () => void;
}

export function createStubHost(): StubHost {
  const streams = new Set<OpenStream>();
  const counters = new Map<string, number>();

  const nextSeq = (sessionId: string) => {
    const seq = (counters.get(sessionId) ?? 0) + 1;
    counters.set(sessionId, seq);
    return seq;
  };
  const frame = (envelope: ExecutionHostEventEnvelope, name?: string) =>
    `${name ? `event: ${name}\n` : ""}id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`;
  const write = (sessionId: string | null, text: string) => {
    for (const stream of streams) {
      if (sessionId === null || stream.sessionId === sessionId) {
        stream.controller.enqueue(encoder.encode(text));
      }
    }
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const host: StubHost = {
    framing: true,
    bufferedSeqs: new Set(),
    log: [],
    eventsRequests: [],
    eventsStatus: 200,
    healthRequests: [],
    healthBody: HEALTH_BODY,
    healthStatus: 200,
    metaStatus: 200,
    projectsBody: { projects: [] },
    startRequests: [],
    startStatus: 201,
    startBody: null,
    commandRequests: [],
    commandStatus: 202,
    patchRequests: [],
    patchStatus: 200,
    patchBody: null,
    sessions: new Set(["session-1"]),
    snapshots: new Map(),
    token: "stub-token",

    emit(event, sessionId = "session-1") {
      const envelope: ExecutionHostEventEnvelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        seq: nextSeq(sessionId),
        event,
      };
      host.log.push(envelope);
      write(sessionId, frame(envelope));
      return envelope;
    },
    loseFrame(event, sessionId = "session-1") {
      host.log.push({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        seq: nextSeq(sessionId),
        event,
      });
    },
    emitBatch(events, sessionId = "session-1") {
      const envelopes = events.map((event) => ({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        seq: nextSeq(sessionId),
        event,
      }));
      host.log.push(...envelopes);
      write(sessionId, envelopes.map((envelope) => frame(envelope)).join(""));
    },
    writeRaw(text) {
      write(null, text);
    },
    writeBytes(bytes) {
      for (const stream of streams) stream.controller.enqueue(bytes);
    },
    redirectModes: [],
    prune(...seqs) {
      host.log = host.log.filter((envelope) => !seqs.includes(envelope.seq));
    },
    closeStreams() {
      for (const stream of [...streams]) {
        stream.detach();
        stream.controller.close();
      }
    },
    breakStreams() {
      for (const stream of [...streams]) {
        stream.detach();
        stream.controller.error(new TypeError("terminated"));
      }
    },
    openStreams: () => streams.size,

    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const signal = init?.signal ?? undefined;
      host.redirectModes.push(init?.redirect);
      if (signal?.aborted) throw abortError(signal);
      const authorized =
        headers.get("Authorization") === `Bearer ${host.token}`;
      const path = url.pathname;

      if (path === "/health") {
        host.healthRequests.push({
          authorization: headers.get("Authorization"),
        });
        return json(host.healthBody, host.healthStatus);
      }
      if (!authorized) return json({ error: "Unauthorized" }, 401);
      if (path === "/v0/meta") return json({ providers: [] }, host.metaStatus);
      if (path === "/v0/projects") return json(host.projectsBody);

      if (path === "/v0/execution/sessions" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        host.startRequests.push(body);
        const sessionId = (body.config as { sessionId: string }).sessionId;
        if (host.sessions.has(sessionId)) {
          return json({ error: `Session already exists: ${sessionId}` }, 409);
        }
        if (host.startStatus !== 201) {
          return json(
            { error: "Provider claude failed to start" },
            host.startStatus,
          );
        }
        host.sessions.add(sessionId);
        return json(
          host.startBody?.(body) ?? {
            protocolVersion: EXECUTION_PROTOCOL_VERSION,
            sessionId,
          },
          201,
        );
      }

      const match =
        /^\/v0\/execution\/sessions\/([^/]+)(\/commands|\/events)?$/.exec(path);
      if (!match) return json({ error: "Not found" }, 404);
      const sessionId = decodeURIComponent(match[1]!);

      if (match[2] === "/commands") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        host.commandRequests.push({ sessionId, body });
        if (!host.sessions.has(sessionId)) {
          return json({ error: `Session not found: ${sessionId}` }, 404);
        }
        return host.commandStatus === 202
          ? json({ accepted: true }, 202)
          : json({ error: "Session has stopped" }, host.commandStatus);
      }

      if (match[2] === "/events") {
        host.eventsRequests.push({
          sessionId,
          lastEventId: headers.get("Last-Event-ID"),
          deltas: url.searchParams.get("deltas"),
          authorization: headers.get("Authorization"),
        });
        if (host.eventsStatus !== 200) {
          return json({ error: "Session not found" }, host.eventsStatus);
        }
        if (!host.sessions.has(sessionId)) {
          return json({ error: `Session not found: ${sessionId}` }, 404);
        }
        const after = Number(headers.get("Last-Event-ID") ?? 0);
        let entry: OpenStream | null = null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const detach = () => {
              if (entry) streams.delete(entry);
              signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
              detach();
              try {
                controller.error(abortError(signal!));
              } catch {
                // Already closed.
              }
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            entry = { sessionId, controller, detach };
            streams.add(entry);
            let written = after;
            const pending = host.log.filter(
              (envelope) =>
                envelope.sessionId === sessionId && envelope.seq > after,
            );
            // The replay, then what arrived while it was being read, unnamed.
            for (const buffered of [false, true]) {
              for (const envelope of pending) {
                if (host.bufferedSeqs.has(envelope.seq) !== buffered) continue;
                const name = host.framing && !buffered ? "replay" : undefined;
                controller.enqueue(encoder.encode(frame(envelope, name)));
                written = envelope.seq;
              }
            }
            if (host.framing) {
              controller.enqueue(
                encoder.encode(
                  `event: caught-up\ndata: ${JSON.stringify({ throughSeq: written })}\n\n`,
                ),
              );
            }
          },
          cancel() {
            entry?.detach();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        host.patchRequests.push({ sessionId, body });
        if (!host.sessions.has(sessionId)) {
          return json({ error: `Session not found: ${sessionId}` }, 404);
        }
        if (host.patchStatus !== 200) {
          return json(
            { error: "Invalid session patch: claude has no model gpt-6" },
            host.patchStatus,
          );
        }
        return json(
          host.patchBody?.(sessionId, body) ?? {
            protocolVersion: EXECUTION_PROTOCOL_VERSION,
            sessionId,
            ...body,
          },
        );
      }

      if (method === "GET") {
        const snapshot = host.snapshots.get(sessionId);
        return snapshot === undefined
          ? json({ error: `Session not found: ${sessionId}` }, 404)
          : json(snapshot);
      }
      return json({ error: "Not found" }, 404);
    },
  };
  return host;
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("This operation was aborted", "AbortError")
  );
}

/**
 * The shape of agents-daemon's `GET /health`, from a 0.26.1 build
 * (`f62fd1b2`): unauthenticated, so nothing in it is secret. It carries
 * capability ids and fields this client does not read, on purpose.
 */
export const HEALTH_BODY = {
  status: "ok",
  version: "0.26.1",
  apiVersion: "v0",
  gitSha: "f62fd1b2b2cd5046c37487062cadb0985f06289f",
  buildTime: "2026-08-08T07:38:45Z",
  uptime: 437707,
  activeSessions: 0,
  providers: { claude: true, codex: true, cursor: false, gemini: false },
  providerReadiness: {
    claude: { installed: true, authenticated: true },
    codex: { installed: true, authenticated: true },
    cursor: { installed: false, authenticated: false },
    gemini: { installed: false, authenticated: false },
  },
  providerCatalog: { checkedAt: "2026-08-22T14:27:51.151Z", stale: false },
  executionProtocol: {
    version: 1,
    capabilities: [
      "commands.approval",
      "commands.cancelQueued",
      "events.replay",
      "interactions.structured",
      "sessions.metadata",
      "workspaces.materialize",
      "callbacks.status",
      "automation.create-pr",
      "attachments.inline-image",
      "turns.fileChanges",
      "turns.fileChanges.combined",
      "turns.fileChanges.multiRepo",
      "research.evidence",
      "deltas.append.v1",
      "rooms.v1",
      "projects.v1",
      "push.v1",
    ],
  },
  sessionDirectory: { search: true, stableCursor: true },
  retention: { sessionRetentionDays: 90 },
};

/** Polls until `condition` holds, on real timers, or fails the test. */
export async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const started = Date.now();
  let last = started;
  let longestPause = 0;
  let polls = 0;
  while (!condition()) {
    const now = Date.now();
    longestPause = Math.max(longestPause, now - last);
    last = now;
    polls += 1;
    // Saying how often it looked tells a stalled machine from a stuck test.
    if (now - started > timeoutMs) {
      throw new Error(
        `timed out waiting: ${polls} looks, the longest ${longestPause} ms apart`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
