import {
  decodeExecutionCommandEnvelope,
  decodeExecutionSessionPatchRequest,
  decodeExecutionStartRequest,
  encodeExecutionSessionPatchRequest,
  encodeExecutionTurnUsageQuery,
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionSessionPatchRequest,
  type ExecutionTurn,
  type ExecutionTurnUsage,
  type ExecutionTurnUsagePage,
  type ExecutionTurnUsageRecord,
} from "../../src/index.js";
import {
  ExecutionHostError,
  ExecutionTaskOutputError,
  type ExecutionHostApi,
  type ExecutionSessionSummary,
  type ExecutionStreamFrame,
} from "../../src/client/index.js";
import { followExecutionSession } from "../../src/client/follow.js";
import type { ExecutionHostConformanceHost } from "../../src/testing/index.js";
import { PROVIDERS_BODY } from "../client/stub-host.js";

/**
 * One execution host in memory, the way agents-daemon keeps one: sessions
 * with their envelope logs and attachments. Two faces read it — an
 * `ExecutionHostApi` (`fakeApi`) and the daemon's HTTP routes behind a fake
 * `fetch` (`fakeFetch`) — so the conformance suite can hold the port and the
 * HTTP client to the same host.
 */
export interface FakeSession {
  sessionId: string;
  providerId: string;
  title: string | null;
  log: ExecutionHostEventEnvelope[];
  attachments: Map<string, Uint8Array>;
  turns: ExecutionTurn[];
  createdAt: string;
}

export interface FakeHostOptions {
  /**
   * Whether it records what turns cost (`turns.usage.v1`). Without it, it is
   * a host predating it: no hook, and the history is a 404.
   */
  recordsUsage?: boolean;
}

export class FakeHostModel {
  readonly sessions = new Map<string, FakeSession>();
  /** Every turn's usage, in the order it was recorded. */
  readonly usage: ExecutionTurnUsageRecord[] = [];
  readonly recordsUsage: boolean;
  /** Told of each envelope logged, and of a session going (`null`). */
  readonly watchers = new Set<
    (sessionId: string, envelope: ExecutionHostEventEnvelope | null) => void
  >();
  private created = 0;
  private turnsEnded = 0;

  constructor(options: FakeHostOptions = {}) {
    this.recordsUsage = options.recordsUsage ?? true;
  }

  start(sessionId: string, providerId: string): "started" | "exists" {
    if (this.sessions.has(sessionId)) return "exists";
    this.created += 1;
    this.sessions.set(sessionId, {
      sessionId,
      providerId,
      title: null,
      log: [],
      attachments: new Map(),
      turns: [],
      createdAt: new Date(
        Date.UTC(2026, 9, 29, 0, 0, this.created),
      ).toISOString(),
    });
    // As a host does, the start is on the log before anything else.
    this.emit(sessionId, [{ kind: "status", status: "running" }]);
    return "started";
  }

  emit(sessionId: string, events: ExecutionHostEvent[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    for (const event of events) {
      const envelope: ExecutionHostEventEnvelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        seq: session.log.length + 1,
        event,
      };
      session.log.push(envelope);
      for (const watch of this.watchers) watch(sessionId, envelope);
    }
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const watch of this.watchers) watch(sessionId, null);
  }

  attach(sessionId: string, bytes: Uint8Array): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const id = `attachment-${session.attachments.size + 1}`;
    session.attachments.set(id, bytes.slice());
    return id;
  }

  /**
   * Runs a turn that ends having cost `usage`, as a runtime does when its
   * provider reports it: `turn.add`, then the `turn.patch` that ends it with
   * its usage, and a record in the history.
   */
  endTurnWithUsage(sessionId: string, usage: ExecutionTurnUsage): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    this.turnsEnded += 1;
    const turnId = `turn-${this.turnsEnded}`;
    const startedAt = new Date().toISOString();
    const turn: ExecutionTurn = {
      id: turnId,
      sessionId,
      sequence: session.turns.length + 1,
      startedAt,
      endedAt: null,
      status: "running",
      summary: null,
      origin: "user",
    };
    session.turns.push(turn);
    this.emit(sessionId, [
      { kind: "delta", delta: { kind: "turn.add", turn: { ...turn } } },
    ]);
    const endedAt = new Date().toISOString();
    Object.assign(turn, { endedAt, status: "completed", usage });
    this.emit(sessionId, [
      {
        kind: "delta",
        delta: {
          kind: "turn.patch",
          turnId,
          patch: { endedAt, status: "completed", usage },
        },
      },
    ]);
    this.usage.push({
      turnId,
      sessionId,
      endedAt,
      source: "live",
      ...usage,
    });
    return turnId;
  }

  /**
   * One page of the usage history: the cursor is where the last page's scan
   * ended, with the `since` it started with; the default page is 2.
   */
  usagePage(query: {
    since?: string;
    cursor?: string;
    limit?: number;
  }): Omit<ExecutionTurnUsagePage, "warnings"> {
    let from = 0;
    let since = query.since;
    if (query.cursor !== undefined) {
      const [position, given] = query.cursor.split("|");
      from = Number(position);
      since = given === "" ? undefined : given;
    }
    const limit = query.limit ?? 2;
    const matches = (record: ExecutionTurnUsageRecord) =>
      since === undefined || Date.parse(record.endedAt) >= Date.parse(since);
    const records: ExecutionTurnUsageRecord[] = [];
    let position = from;
    while (position < this.usage.length && records.length < limit) {
      const record = this.usage[position]!;
      position += 1;
      if (matches(record)) records.push(record);
    }
    if (records.length < limit) position = this.usage.length;
    return {
      records,
      nextCursor:
        position === 0 && query.cursor === undefined
          ? null
          : `${position}|${since ?? ""}`,
      hasMore: this.usage.slice(position).some(matches),
    };
  }

  summary(session: FakeSession): ExecutionSessionSummary {
    return {
      sessionId: session.sessionId,
      providerId: session.providerId,
      name: session.sessionId,
      title: session.title,
      commandable: true,
      status: "running",
      attention: "none",
      activity: null,
      metadata: null,
      contextWindow: null,
      conversationItemCount: 0,
      lastSeq: session.log.length,
      workspace: null,
      prUrl: null,
      roomId: null,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
      deletedAt: null,
    };
  }

  /** Newest first, `limit` to a page, the cursor an offset. */
  page(cursor: string | undefined, limit = 2) {
    const all = [...this.sessions.values()].reverse();
    const offset = cursor === undefined ? 0 : Number(cursor);
    const sessions = all.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      sessions: sessions.map((session) => this.summary(session)),
      nextCursor: next < all.length ? String(next) : null,
    };
  }

  snapshot(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId,
      providerId: session.providerId,
      commandable: true,
      status: "running" as const,
      runningTasks: 0,
      attention: "none" as const,
      activity: null,
      metadata: null,
      continuationToken: null,
      contextWindow: null,
      conversation: [],
      turns: session.turns.map((turn) => ({ ...turn, fileChanges: [] })),
      lastSeq: session.log.length,
      workspace: null,
      prUrl: null,
      roomId: null,
    };
  }

  /**
   * The session's frames after `afterSeq`: its log as a named replay, a
   * `caught-up`, then each envelope as it is logged. Throws `not-found` for a
   * session the host does not have, and ends when it goes.
   */
  async *frames(
    sessionId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): AsyncGenerator<ExecutionStreamFrame> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ExecutionHostError(
        "not-found",
        `Session not found: ${sessionId}`,
        {
          operation: "events",
          status: 404,
        },
      );
    }
    const live: Array<ExecutionHostEventEnvelope | null> = [];
    let wake: (() => void) | null = null;
    const watch = (id: string, envelope: ExecutionHostEventEnvelope | null) => {
      if (id !== sessionId) return;
      live.push(envelope);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.watchers.add(watch);
    signal.addEventListener("abort", onAbort);
    try {
      yield { type: "open" };
      const replay = session.log.filter((envelope) => envelope.seq > afterSeq);
      for (const envelope of replay) {
        yield { type: "envelope", envelope, replay: true, warnings: [] };
      }
      yield { type: "caught-up", throughSeq: session.log.length };
      let last = session.log.length;
      for (;;) {
        if (signal.aborted) return;
        const next = live.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
          continue;
        }
        // Gone: the stream ends, and the next one is a 404.
        if (next === null) {
          throw new ExecutionHostError("not-found", "Session not found", {
            operation: "events",
            status: 404,
          });
        }
        if (next.seq <= last) continue;
        last = next.seq;
        yield { type: "envelope", envelope: next, replay: false, warnings: [] };
      }
    } finally {
      this.watchers.delete(watch);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

const PROVIDERS = PROVIDERS_BODY.providers.map((provider) => ({
  ...provider,
})) as unknown as Awaited<ReturnType<ExecutionHostApi["providers"]>>;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/** The model as an `ExecutionHostApi`, as a runtime in the same process is one. */
export function fakeApi(model: FakeHostModel): ExecutionHostApi {
  return {
    providers: async (options) => {
      aborted(options?.signal);
      return PROVIDERS;
    },
    projects: async (options) => {
      aborted(options?.signal);
      return [];
    },
    start: async (request, options) => {
      aborted(options?.signal);
      const commandId = request.commandId ?? "minted";
      const sessionId = request.config.sessionId;
      const status = model.start(sessionId, request.providerId);
      return status === "started"
        ? { status, sessionId, commandId, workspace: null }
        : { status, sessionId, commandId };
    },
    command: async (sessionId, _command, options) => {
      aborted(options?.signal);
      return {
        status: model.sessions.has(sessionId) ? "accepted" : "no-session",
        commandId: options?.commandId ?? "minted",
      };
    },
    listSessions: async (query, options) => {
      aborted(options?.signal);
      return { ...model.page(query?.cursor, query?.limit), warnings: [] };
    },
    snapshot: async (sessionId, options) => {
      aborted(options?.signal);
      return model.snapshot(sessionId);
    },
    patchSession: async (sessionId, patch, options) => {
      aborted(options?.signal);
      checkPatch(patch);
      const session = model.sessions.get(sessionId);
      if (!session) return { status: "no-session", sessionId };
      if (patch.title !== undefined) session.title = patch.title;
      return {
        status: "patched",
        sessionId,
        ...(patch.title === undefined ? {} : { title: session.title }),
      };
    },
    followSession: (sessionId, options) =>
      followExecutionSession(
        (afterSeq, open) => model.frames(sessionId, afterSeq, open.signal),
        sessionId,
        options,
      ),
    taskOutput: async (sessionId, taskId, options) => {
      aborted(options?.signal);
      const code = model.sessions.has(sessionId)
        ? "task-unknown"
        : "session-unknown";
      throw new ExecutionTaskOutputError(code, `the host has no ${code}`, {
        status: 404,
        sessionId,
        taskId,
      });
    },
    sessionChanges: async (sessionId, options) => {
      aborted(options?.signal);
      return model.sessions.has(sessionId)
        ? { status: "changes", sessionId, fileChanges: [], warnings: [] }
        : { status: "no-session", sessionId };
    },
    downloadAttachment: async (sessionId, attachmentId, options) => {
      aborted(options?.signal);
      const bytes = model.sessions
        .get(sessionId)
        ?.attachments.get(attachmentId);
      if (bytes === undefined) {
        throw new ExecutionHostError(
          "not-found",
          "the host has no such attachment",
          { operation: "download attachment", status: 404 },
        );
      }
      return { bytes: bytes.slice(), sizeBytes: bytes.byteLength };
    },
    listTurnUsage: async (query = {}, options) => {
      aborted(options?.signal);
      // Refused as the HTTP client refuses it, before anything else.
      encodeExecutionTurnUsageQuery(query);
      if (!model.recordsUsage) {
        throw new ExecutionHostError("not-found", "Route not found", {
          operation: "list turn usage",
          status: 404,
        });
      }
      return { ...model.usagePage(query), warnings: [] };
    },
  };
}

function checkPatch(patch: ExecutionSessionPatchRequest): void {
  const decoded = decodeExecutionSessionPatchRequest(
    encodeExecutionSessionPatchRequest(patch),
  );
  if (!decoded.ok) throw new TypeError("A session patch names something");
}

const encoder = new TextEncoder();

/**
 * The model behind agents-daemon's HTTP routes, as a `fetch`: the shapes the
 * daemon answers with, its 404s, and its event stream with a named replay.
 */
export function fakeFetch(
  model: FakeHostModel,
  token: string,
): typeof globalThis.fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const notFound = (what: string) => json({ error: `${what} not found` }, 404);

  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const method = init?.method ?? "GET";
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const headers = new Headers(init?.headers);
    if (headers.get("Authorization") !== `Bearer ${token}`) {
      return json({ error: "Unauthorized" }, 401);
    }
    const path = url.pathname;
    if (path === "/v0/providers") return json(PROVIDERS_BODY);
    if (path === "/v0/usage/turns" && model.recordsUsage) {
      const limit = url.searchParams.get("limit");
      return json({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        ...model.usagePage({
          since: url.searchParams.get("since") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
          limit: limit === null ? undefined : Number(limit),
        }),
      });
    }
    if (path === "/v0/projects") return json({ projects: [] });
    if (path === "/v0/execution/sessions") {
      if (method === "POST") {
        const decoded = decodeExecutionStartRequest(String(init?.body));
        if (!decoded.ok) return json({ error: "Invalid start request" }, 400);
        const { sessionId } = decoded.value.config;
        const status = model.start(sessionId, decoded.value.providerId);
        return status === "exists"
          ? json({ error: `Session already exists: ${sessionId}` }, 409)
          : json(
              { protocolVersion: EXECUTION_PROTOCOL_VERSION, sessionId },
              201,
            );
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const limit = url.searchParams.get("limit");
      return json({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        ...model.page(cursor, limit === null ? undefined : Number(limit)),
      });
    }
    const match =
      /^\/v0\/execution\/sessions\/([^/]+)(\/commands|\/events|\/changes|\/attachments\/[^/]+|\/tasks\/[^/]+\/output)?$/.exec(
        path,
      );
    if (!match) return notFound("Route");
    const sessionId = decodeURIComponent(match[1]!);
    const session = model.sessions.get(sessionId);
    const rest = match[2] ?? "";

    if (rest.startsWith("/tasks/")) {
      const code = session ? "task-unknown" : "session-unknown";
      return json({ error: code, code }, 404);
    }
    if (!session) return notFound("Session");
    if (rest === "/commands") {
      const decoded = decodeExecutionCommandEnvelope(String(init?.body));
      if (!decoded.ok) return json({ error: "Invalid command envelope" }, 400);
      return json({ accepted: true }, 202);
    }
    if (rest === "/changes") {
      return json({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        scope: "combined",
        fileChanges: [],
      });
    }
    if (rest.startsWith("/attachments/")) {
      const id = decodeURIComponent(rest.slice("/attachments/".length));
      const bytes = session.attachments.get(id);
      if (bytes === undefined) return notFound("Attachment");
      return new Response(bytes.slice(), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (rest === "/events") {
      const after = Number(headers.get("Last-Event-ID") ?? 0);
      const stop = new AbortController();
      signal?.addEventListener("abort", () => stop.abort(), { once: true });
      const frames = model.frames(sessionId, after, stop.signal);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await frames.next();
            if (next.done) return controller.close();
            const frame = next.value;
            if (frame.type === "envelope") {
              const name = frame.replay ? "event: replay\n" : "";
              controller.enqueue(
                encoder.encode(
                  `${name}id: ${frame.envelope.seq}\ndata: ${JSON.stringify(frame.envelope)}\n\n`,
                ),
              );
            } else if (frame.type === "caught-up") {
              controller.enqueue(
                encoder.encode(
                  `event: caught-up\ndata: ${JSON.stringify({ throughSeq: frame.throughSeq })}\n\n`,
                ),
              );
            }
          } catch {
            // The session went: the daemon ends its streams.
            controller.close();
          }
        },
        cancel() {
          stop.abort();
          void frames.return(undefined);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    if (method === "PATCH") {
      const decoded = decodeExecutionSessionPatchRequest(String(init?.body));
      if (!decoded.ok) return json({ error: "Invalid session patch" }, 400);
      if (decoded.value.title !== undefined)
        session.title = decoded.value.title;
      return json({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        ...(decoded.value.title === undefined ? {} : { title: session.title }),
      });
    }
    if (method === "GET") return json(model.snapshot(sessionId));
    return notFound("Route");
  };
}

/** The hooks a conformance case needs of the model, whatever face it wears. */
export function modelHooks(
  model: FakeHostModel,
): Omit<ExecutionHostConformanceHost, "api"> {
  return {
    providerId: "claude",
    emit: (sessionId, events) => model.emit(sessionId, events),
    attach: (sessionId, bytes) => model.attach(sessionId, bytes),
    remove: (sessionId) => model.remove(sessionId),
    ...(model.recordsUsage
      ? {
          endTurnWithUsage: (sessionId: string, usage: ExecutionTurnUsage) =>
            model.endTurnWithUsage(sessionId, usage),
        }
      : {}),
  };
}
