import {
  decodeExecutionOneShotRequest,
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
} from "../../src/index.js";
import { linuxHostProfileFixture } from "../fixtures/host-profile-fixtures.js";

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
  hostBody: unknown;
  hostStatus: number;
  hostRequests: Array<{ authorization: string | null }>;
  projectsBody: unknown;
  /** The answer to `GET /v0/providers`; agents-daemon's catalogue by default. */
  providersBody: unknown;
  providersStatus: number;
  /** The sessions a `DELETE` was sent for, in order, found or not. */
  deleteRequests: string[];
  /** Status a `DELETE` of a session the host has answers with. */
  deleteStatus: number;
  startRequests: Array<Record<string, unknown>>;
  startStatus: number;
  /** The `requires` a 409 echoes for a session the stub already has. */
  existingRequires: string[];
  /** What a start refused by `startStatus` answers with. */
  startRefusal: unknown;
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
  /** Every one-shot request: its body exactly as sent, and its token. */
  oneShotRequests: Array<{ body: string; authorization: string | null }>;
  /**
   * Status the next one-shots answer with. A refusal quotes the prompt and the
   * token on purpose, as no host should, to show neither reaches an error.
   */
  oneShotStatus: number;
  /** The `code` a refusal carries; null sends none. */
  oneShotCode: string | null;
  /** The answer to a one-shot; by default a line naming what was asked. */
  oneShotAnswer: ((request: Record<string, unknown>) => unknown) | null;
  /**
   * `released`: the route as agents-daemon ships it before `oneshot.v1` —
   * a strict schema of `providerId`, `model`, `effort`, `prompt` and
   * `timeoutMs` that answers 400 to any other field, `contract` included,
   * and runs whatever it accepts with tools on. Whatever `/health` says.
   */
  oneShotRoute: "oneshot.v1" | "released";
  /** The prompts the host actually ran. */
  oneShotRuns: string[];
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
    hostBody: linuxHostProfileFixture,
    hostStatus: 200,
    hostRequests: [],
    projectsBody: { projects: [] },
    providersBody: PROVIDERS_BODY,
    providersStatus: 200,
    deleteRequests: [],
    deleteStatus: 200,
    startRequests: [],
    startStatus: 201,
    existingRequires: [],
    startRefusal: { error: "Provider claude failed to start" },
    startBody: null,
    commandRequests: [],
    commandStatus: 202,
    patchRequests: [],
    patchStatus: 200,
    patchBody: null,
    sessions: new Set(["session-1"]),
    snapshots: new Map(),
    token: "stub-token",
    oneShotRequests: [],
    oneShotStatus: 200,
    oneShotCode: null,
    oneShotAnswer: null,
    oneShotRoute: "oneshot.v1",
    oneShotRuns: [],

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
      if (path === "/v0/host") {
        host.hostRequests.push({ authorization: headers.get("Authorization") });
        return json(host.hostBody, host.hostStatus);
      }
      if (path === "/v0/meta") return json({ providers: [] }, host.metaStatus);
      if (path === "/v0/projects") return json(host.projectsBody);
      if (path === "/v0/providers") {
        return json(host.providersBody, host.providersStatus);
      }

      if (path === "/v0/oneshot" && method === "POST") {
        const raw = String(init?.body);
        host.oneShotRequests.push({
          body: raw,
          authorization: headers.get("Authorization"),
        });
        const decoded =
          host.oneShotRoute === "released"
            ? releasedOneShotSchema(raw)
            : decodeExecutionOneShotRequest(raw);
        if (!decoded.ok) return json({ error: "Validation error" }, 400);
        const { providerId, model, effort, prompt } = decoded.value;
        if (host.oneShotStatus !== 200) {
          return json(
            {
              error: `Refused ${prompt} for Bearer ${host.token}`,
              ...(host.oneShotCode === null ? {} : { code: host.oneShotCode }),
            },
            host.oneShotStatus,
          );
        }
        if (providerId !== "claude" && providerId !== "codex") {
          return json(
            { error: "Provider was not found", code: "provider-unknown" },
            404,
          );
        }
        host.oneShotRuns.push(prompt);
        return json(
          host.oneShotAnswer?.({ ...decoded.value }) ?? {
            text: `${providerId}/${model}/${effort ?? "default"} read ${prompt.length} characters`,
          },
        );
      }

      if (path === "/v0/execution/sessions" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        host.startRequests.push(body);
        const sessionId = (body.config as { sessionId: string }).sessionId;
        if (host.sessions.has(sessionId)) {
          return json(
            {
              error: `Session already exists: ${sessionId}`,
              // What it was checked against, as a `start.requires.v1` host
              // says (MAR-3725); the stub's sessions were checked for none.
              ...(body.requires === undefined
                ? {}
                : { requires: host.existingRequires }),
            },
            409,
          );
        }
        if (host.startStatus !== 201) {
          return json(host.startRefusal, host.startStatus);
        }
        host.sessions.add(sessionId);
        return json(
          host.startBody?.(body) ?? {
            protocolVersion: EXECUTION_PROTOCOL_VERSION,
            sessionId,
            // As a host advertising `start.requires.v1` does (MAR-3725).
            ...(body.requires === undefined ? {} : { requires: body.requires }),
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

      if (method === "DELETE") {
        host.deleteRequests.push(sessionId);
        if (!host.sessions.has(sessionId)) {
          return json({ error: `Session not found: ${sessionId}` }, 404);
        }
        if (host.deleteStatus !== 200) {
          return json({ error: "Teardown failed" }, host.deleteStatus);
        }
        // The host forgets the session and ends the streams following it:
        // a follower that reconnects hears 404.
        host.sessions.delete(sessionId);
        host.snapshots.delete(sessionId);
        for (const stream of [...streams]) {
          if (stream.sessionId !== sessionId) continue;
          stream.detach();
          stream.controller.close();
        }
        return json({ deleted: true });
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

/**
 * agents-daemon's `oneShotRequestSchema` as released (`src/routes/validation.ts`
 * on master): `z.object({...}).strict()`, so a field it does not know is a 400.
 */
function releasedOneShotSchema(raw: string):
  | {
      ok: true;
      value: {
        providerId: string;
        model: string;
        effort?: string;
        prompt: string;
      };
    }
  | { ok: false } {
  const body = JSON.parse(raw) as Record<string, unknown>;
  const known = new Set([
    "providerId",
    "model",
    "effort",
    "prompt",
    "timeoutMs",
  ]);
  const id = (value: unknown) =>
    typeof value === "string" && value.trim() !== "";
  if (
    !Object.keys(body).every((field) => known.has(field)) ||
    !id(body.providerId) ||
    !id(body.model) ||
    !(body.effort === undefined || id(body.effort)) ||
    !id(body.prompt)
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    value: body as {
      providerId: string;
      model: string;
      effort?: string;
      prompt: string;
    },
  };
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

/**
 * The shape of agents-daemon's `GET /v0/providers`, as accent.'s gateway reads
 * it (MAR-3655): `models` carry their own `effortOptions`, a provider with none
 * says what it takes in `features.effortLevels`, and both carry fields this
 * client does not read, on purpose.
 */
export const PROVIDERS_BODY = {
  providers: [
    {
      id: "claude",
      label: "Claude",
      available: true,
      authenticated: true,
      features: { effortLevels: ["low", "medium", "high"], resume: true },
      models: [
        {
          slug: "claude-opus-5-5",
          label: "Opus 5.5",
          defaultEffort: "medium",
          effortOptions: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
          contextWindow: 200000,
        },
        { slug: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      available: true,
      authenticated: false,
      models: [],
    },
  ],
};
