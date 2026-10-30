import type { ExecutionHostApi } from "../client/api.js";
import type {
  ExecutionFollowEnd,
  ExecutionSessionFollow,
} from "../client/follow.js";
import { ExecutionHostError } from "../client/http.js";
import { ExecutionTaskOutputError } from "../client/task-output.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionStartRequest,
} from "../types.js";

/**
 * A host under test, set up fresh for each case: the `ExecutionHostApi` to
 * hold to the contract, and the few things a case needs the host itself to
 * do, which no caller of the API can make it do.
 */
export interface ExecutionHostConformanceHost {
  api: ExecutionHostApi;
  /** A provider the host lists, and starts a session on when asked. */
  providerId: string;
  /**
   * Appends `events` to the session's log as its runtime would: the next
   * `seq`s, in order, to every follower. The session was started through
   * `api`.
   */
  emit(sessionId: string, events: ExecutionHostEvent[]): void | Promise<void>;
  /** Gives the session an attachment of these bytes, and says its id. */
  attach(sessionId: string, bytes: Uint8Array): string | Promise<string>;
  /**
   * Makes the session gone, as tearing it down does: the host no longer has
   * it, and the streams following it end.
   */
  remove(sessionId: string): void | Promise<void>;
  /** Runs after the case, whatever its outcome. */
  close?(): void | Promise<void>;
}

/**
 * What the suite registers its cases with: vitest's, Jest's, Bun's, mocha's
 * or `node:test`'s `describe` and `it`. Only `(name, body)` is called, so any
 * of them fits as it is.
 */
export interface ExecutionHostConformanceRunner {
  describe(name: string, body: () => void): unknown;
  it(name: string, body: () => Promise<void>): unknown;
}

export interface ExecutionHostConformanceOptions {
  /**
   * How long a case waits for the host to do what it should before failing.
   * Default 5 s; keep it under the runner's own case timeout.
   */
  waitMs?: number;
}

/** One case of the suite: a name, and what it holds `host` to. */
export interface ExecutionHostConformanceCase {
  name: string;
  run(
    host: ExecutionHostConformanceHost,
    options: Required<ExecutionHostConformanceOptions>,
  ): Promise<void>;
}

/** A case's failure: what the host did that the contract does not allow. */
export class ExecutionHostConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionHostConformanceError";
  }
}

/**
 * Registers the conformance suite for one `ExecutionHostApi` (MAR-4862) with
 * a test runner: each case sets up a fresh host with `setup` and closes it
 * after. Every carrier — HTTP, a port, an in-process runtime — must pass it
 * unchanged, so a caller can take any of them for another.
 *
 * ```ts
 * import { describe, it } from "vitest";
 * describeExecutionHostConformance({ describe, it }, "port", async () => {
 *   const runtime = createMyRuntime();
 *   const { port1, port2 } = new MessageChannel();
 *   const server = servePort(port2, runtime.api);
 *   const api = createPortClient(port1);
 *   return { api, providerId: "claude", ...runtime.hooks, close: () => api.close() };
 * });
 * ```
 */
export function describeExecutionHostConformance(
  runner: ExecutionHostConformanceRunner,
  name: string,
  setup: () =>
    ExecutionHostConformanceHost | Promise<ExecutionHostConformanceHost>,
  options: ExecutionHostConformanceOptions = {},
): void {
  const settled = { waitMs: options.waitMs ?? 5_000 };
  runner.describe(`ExecutionHostApi conformance: ${name}`, () => {
    for (const conformanceCase of executionHostConformanceCases) {
      runner.it(conformanceCase.name, async () => {
        const host = await setup();
        try {
          await conformanceCase.run(host, settled);
        } finally {
          await host.close?.();
        }
      });
    }
  });
}

let sessions = 0;

/** A session id no other case uses. */
function freshSessionId(): string {
  sessions += 1;
  return `conformance-${sessions}-${Math.random().toString(36).slice(2, 10)}`;
}

function startRequest(
  providerId: string,
  sessionId: string,
  commandId: string,
): ExecutionStartRequest {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId,
    commandId,
    config: {
      sessionId,
      initialMessage: "conformance",
      model: null,
      effort: null,
      continuationToken: null,
    },
  };
}

async function started(host: ExecutionHostConformanceHost): Promise<string> {
  const sessionId = freshSessionId();
  const result = await host.api.start(
    startRequest(host.providerId, sessionId, `${sessionId}-start`),
  );
  check(
    result.status === "started",
    `start answered ${result.status}, not started`,
  );
  return sessionId;
}

/** Events a case can tell apart from whatever the host logs on its own. */
function marked(sessionId: string, count: number): ExecutionHostEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "continuation-token" as const,
    token: `${sessionId}-mark-${index}`,
  }));
}

function isMark(envelope: ExecutionHostEventEnvelope, token: string): boolean {
  return (
    envelope.event.kind === "continuation-token" &&
    envelope.event.token === token
  );
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ExecutionHostConformanceError(message);
}

async function rejection(
  work: Promise<unknown>,
  what: string,
): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new ExecutionHostConformanceError(`${what} resolved; it should reject`);
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ExecutionHostConformanceError(`${what}: nothing within ${ms} ms`),
        ),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** How often `eventually` looks. */
export const CONFORMANCE_POLL_MS = 5;

/**
 * Resolves once `condition` holds, looking every `CONFORMANCE_POLL_MS`, or
 * rejects after `ms`. Either way it stops looking: a failed case leaves no
 * timer behind.
 */
function eventually(
  condition: () => boolean,
  ms: number,
  what: string,
): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const look = () => {
      if (condition()) return resolve();
      if (Date.now() - started >= ms) {
        return reject(
          new ExecutionHostConformanceError(`${what}: nothing within ${ms} ms`),
        );
      }
      setTimeout(look, CONFORMANCE_POLL_MS);
    };
    look();
  });
}

interface Following {
  follow: ExecutionSessionFollow;
  /** Envelopes whose handler returned, in the order they were handed on. */
  kept: ExecutionHostEventEnvelope[];
  /** The cursor each kept envelope was handed with. */
  cursors: number[];
  /** Resolves once `until` holds of what was kept. */
  reached: Promise<void>;
}

/**
 * Follows a session, keeping what it is handed, until `until` holds. A
 * handler may refuse an envelope, by throwing, through `refuse`.
 */
function follow(
  api: ExecutionHostApi,
  sessionId: string,
  afterSeq: number,
  until: (kept: ExecutionHostEventEnvelope[]) => boolean,
  refuse: (envelope: ExecutionHostEventEnvelope) => boolean = () => false,
): Following {
  const kept: ExecutionHostEventEnvelope[] = [];
  const cursors: number[] = [];
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const following = api.followSession(sessionId, {
    afterSeq,
    retryDelayMs: () => 10,
    onEnvelope: (envelope, info) => {
      if (refuse(envelope)) throw new Error("refused by the case");
      kept.push(envelope);
      cursors.push(info.cursor);
      if (until(kept)) arrive();
    },
  });
  if (until(kept)) arrive();
  return { follow: following, kept, cursors, reached };
}

/** What a sequence of kept envelopes must be: this session's, in order, once each. */
function checkOrder(
  kept: ExecutionHostEventEnvelope[],
  cursors: number[],
  sessionId: string,
  afterSeq: number,
): void {
  let last = afterSeq;
  kept.forEach((envelope, index) => {
    check(
      envelope.sessionId === sessionId,
      `envelope ${envelope.seq} is about session ${envelope.sessionId}, not ${sessionId}`,
    );
    check(
      envelope.seq > last,
      `envelope ${envelope.seq} came after ${last}: out of order or twice`,
    );
    check(
      cursors[index] === envelope.seq,
      `envelope ${envelope.seq} was handed cursor ${cursors[index]}`,
    );
    last = envelope.seq;
  });
}

/** Whether the last of `count` marks was kept: the earlier ones came before it. */
function hasAll(sessionId: string, count: number) {
  const last = `${sessionId}-mark-${count - 1}`;
  return (kept: ExecutionHostEventEnvelope[]) =>
    kept.some((envelope) => isMark(envelope, last));
}

async function ended(
  following: ExecutionSessionFollow,
  waitMs: number,
  what: string,
): Promise<ExecutionFollowEnd> {
  return within(following.done, waitMs, what);
}

function checkNotFound(error: unknown, what: string): void {
  check(
    error instanceof ExecutionHostError,
    `${what} failed with ${describe(error)}, not an ExecutionHostError`,
  );
  check(
    error.kind === "not-found",
    `${what} failed as ${error.kind}, not not-found`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

/**
 * The cases, in the order they are registered: for a runner that is neither
 * `describe` nor `it` shaped, run each with a fresh host.
 */
export const executionHostConformanceCases: readonly ExecutionHostConformanceCase[] =
  [
    {
      name: "lists the provider it starts sessions on",
      async run({ api, providerId }) {
        const providers = await api.providers();
        check(Array.isArray(providers), "providers() is not a list");
        check(
          providers.some((provider) => provider.id === providerId),
          `providers() does not list ${providerId}`,
        );
      },
    },
    {
      name: "lists its projects",
      async run({ api }) {
        check(Array.isArray(await api.projects()), "projects() is not a list");
      },
    },
    {
      name: "starts a session, echoing its ids, and answers exists the second time",
      async run({ api, providerId }) {
        const sessionId = freshSessionId();
        const first = await api.start(
          startRequest(providerId, sessionId, "conformance-start-1"),
        );
        check(first.status === "started", `start answered ${first.status}`);
        check(
          first.sessionId === sessionId,
          `start answered about ${first.sessionId}`,
        );
        check(
          first.commandId === "conformance-start-1",
          `start echoed command id ${first.commandId}`,
        );
        const again = await api.start(
          startRequest(providerId, sessionId, "conformance-start-2"),
        );
        check(
          again.status === "exists",
          `a second start answered ${again.status}, not exists`,
        );
      },
    },
    {
      name: "snapshots a session it has, and answers null for one it does not",
      async run(host) {
        const sessionId = await started(host);
        const snapshot = await host.api.snapshot(sessionId);
        check(snapshot !== null, "snapshot() of a started session is null");
        check(
          snapshot.sessionId === sessionId,
          `the snapshot is of ${snapshot.sessionId}`,
        );
        check(
          snapshot.providerId === host.providerId,
          `the snapshot names provider ${snapshot.providerId}`,
        );
        check(
          Number.isSafeInteger(snapshot.lastSeq) && snapshot.lastSeq >= 0,
          `the snapshot's lastSeq is ${snapshot.lastSeq}`,
        );
        check(
          (await host.api.snapshot(freshSessionId())) === null,
          "snapshot() of an unknown session is not null",
        );
      },
    },
    {
      name: "takes a command for a session it has, and answers no-session otherwise",
      async run(host) {
        const sessionId = await started(host);
        const command = {
          kind: "send-message" as const,
          text: "conformance",
        };
        const accepted = await host.api.command(sessionId, command, {
          commandId: "conformance-command",
        });
        check(
          accepted.status === "accepted",
          `command answered ${accepted.status}`,
        );
        check(
          accepted.commandId === "conformance-command",
          `command echoed ${accepted.commandId}`,
        );
        const missing = await host.api.command(freshSessionId(), command);
        check(
          missing.status === "no-session",
          `a command to an unknown session answered ${missing.status}`,
        );
      },
    },
    {
      name: "lists a session it started",
      async run(host) {
        const sessionId = await started(host);
        let cursor: string | undefined;
        for (let page = 0; page < 50; page += 1) {
          const list = await host.api.listSessions(
            cursor === undefined ? {} : { cursor },
          );
          check(Array.isArray(list.sessions), "listSessions() has no sessions");
          check(
            list.nextCursor === null || typeof list.nextCursor === "string",
            `nextCursor is ${String(list.nextCursor)}`,
          );
          const found = list.sessions.find(
            (session) => session.sessionId === sessionId,
          );
          if (found) {
            check(
              found.providerId === host.providerId,
              `the listed session names provider ${found.providerId}`,
            );
            return;
          }
          if (list.nextCursor === null) break;
          cursor = list.nextCursor;
        }
        throw new ExecutionHostConformanceError(
          `listSessions() does not list ${sessionId}`,
        );
      },
    },
    {
      name: "patches a session's title, and answers no-session otherwise",
      async run(host) {
        const sessionId = await started(host);
        const patched = await host.api.patchSession(sessionId, {
          title: "Conformance",
        });
        check(
          patched.status === "patched",
          `patchSession answered ${patched.status}`,
        );
        check(
          patched.title === "Conformance",
          `patchSession echoed title ${String(patched.title)}`,
        );
        const missing = await host.api.patchSession(freshSessionId(), {
          title: "Conformance",
        });
        check(
          missing.status === "no-session",
          `a patch of an unknown session answered ${missing.status}`,
        );
      },
    },
    {
      name: "refuses a patch that names nothing as a TypeError",
      async run(host) {
        const sessionId = await started(host);
        const error = await rejection(
          host.api.patchSession(sessionId, {}),
          "an empty patch",
        );
        check(
          error instanceof TypeError,
          `an empty patch failed with ${describe(error)}, not a TypeError`,
        );
      },
    },
    {
      name: "follows a session from the start, each envelope once and in order",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        await host.emit(sessionId, marked(sessionId, 3));
        const following = follow(host.api, sessionId, 0, hasAll(sessionId, 3));
        try {
          await within(following.reached, waitMs, "following from 0");
          checkOrder(following.kept, following.cursors, sessionId, 0);
          const marks = following.kept.filter(
            (envelope) => envelope.event.kind === "continuation-token",
          );
          check(
            [0, 1, 2].every((index) =>
              marks.some((envelope) =>
                isMark(envelope, `${sessionId}-mark-${index}`),
              ),
            ),
            "the follow did not hand on every emitted envelope",
          );
        } finally {
          await following.follow.stop();
        }
      },
    },
    {
      name: "resumes after a given seq with nothing missing and nothing twice",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        await host.emit(sessionId, marked(sessionId, 4));
        const first = follow(host.api, sessionId, 0, hasAll(sessionId, 4));
        try {
          await within(first.reached, waitMs, "following from 0");
        } finally {
          await first.follow.stop();
        }
        const all = first.kept;
        const from = all.findIndex((envelope) =>
          isMark(envelope, `${sessionId}-mark-1`),
        );
        check(from >= 0, "the first follow did not see the second mark");
        const afterSeq = all[from]!.seq;
        const resumed = follow(
          host.api,
          sessionId,
          afterSeq,
          hasAll(sessionId, 4),
        );
        try {
          await within(resumed.reached, waitMs, `resuming after ${afterSeq}`);
          checkOrder(resumed.kept, resumed.cursors, sessionId, afterSeq);
          const expected = all.slice(from + 1).map((envelope) => envelope.seq);
          const got = resumed.kept
            .slice(0, expected.length)
            .map((envelope) => envelope.seq);
          check(
            expected.join(",") === got.join(","),
            `resuming after ${afterSeq} handed on ${got.join(",")}, not ${expected.join(",")}`,
          );
          // And what happens next arrives live, after what was replayed.
          await host.emit(sessionId, [
            { kind: "continuation-token", token: `${sessionId}-live` },
          ]);
          await eventually(
            () =>
              resumed.kept.some((envelope) =>
                isMark(envelope, `${sessionId}-live`),
              ),
            waitMs,
            "a live envelope",
          );
          checkOrder(resumed.kept, resumed.cursors, sessionId, afterSeq);
        } finally {
          await resumed.follow.stop();
        }
      },
    },
    {
      name: "hands an envelope on again after its handler throws",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        await host.emit(sessionId, marked(sessionId, 3));
        let refusals = 0;
        const following = follow(
          host.api,
          sessionId,
          0,
          hasAll(sessionId, 3),
          (envelope) =>
            isMark(envelope, `${sessionId}-mark-1`) && refusals++ === 0,
        );
        try {
          await within(following.reached, waitMs, "following past a refusal");
          check(
            refusals === 2,
            `the refused envelope was offered ${refusals} times`,
          );
          checkOrder(following.kept, following.cursors, sessionId, 0);
          check(
            following.kept.some((envelope) =>
              isMark(envelope, `${sessionId}-mark-1`),
            ),
            "the refused envelope was never kept",
          );
        } finally {
          await following.follow.stop();
        }
      },
    },
    {
      name: "ends a follow when it is stopped",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        const following = follow(host.api, sessionId, 0, () => false);
        const end = await within(
          following.follow.stop(),
          waitMs,
          "stopping a follow",
        );
        check(end.reason === "stopped", `a stopped follow ended ${end.reason}`);
      },
    },
    {
      name: "ends a follow with not-found once the session is gone",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        await host.emit(sessionId, marked(sessionId, 1));
        const following = follow(host.api, sessionId, 0, hasAll(sessionId, 1));
        try {
          await within(following.reached, waitMs, "following");
        } catch (error) {
          await following.follow.stop();
          throw error;
        }
        await host.remove(sessionId);
        const end = await ended(
          following.follow,
          waitMs,
          "the follow's end",
        ).catch(async (error: unknown) => {
          await following.follow.stop();
          throw error;
        });
        check(
          end.reason === "no-session",
          `the follow of a removed session ended ${end.reason}`,
        );
        if (end.reason === "no-session") checkNotFound(end.error, "the follow");
      },
    },
    {
      name: "ends a follow of a session it does not have with not-found",
      async run({ api }, { waitMs }) {
        const following = follow(api, freshSessionId(), 0, () => false);
        const end = await ended(
          following.follow,
          waitMs,
          "the follow's end",
        ).catch(async (error: unknown) => {
          await following.follow.stop();
          throw error;
        });
        check(
          end.reason === "no-session",
          `the follow of an unknown session ended ${end.reason}`,
        );
        if (end.reason === "no-session") checkNotFound(end.error, "the follow");
      },
    },
    {
      name: "refuses task output of a session it does not have, by code",
      async run({ api }) {
        const error = await rejection(
          api.taskOutput(freshSessionId(), "task-1"),
          "task output of an unknown session",
        );
        check(
          error instanceof ExecutionTaskOutputError,
          `task output failed with ${describe(error)}, not an ExecutionTaskOutputError`,
        );
        check(
          error.code === "session-unknown",
          `task output failed as ${error.code}, not session-unknown`,
        );
      },
    },
    {
      name: "answers a session's changes, and no-session for one it does not have",
      async run(host) {
        const sessionId = await started(host);
        const changes = await host.api.sessionChanges(sessionId);
        check(
          changes.status === "changes" || changes.status === "unavailable",
          `the changes of a started session answered ${changes.status}`,
        );
        check(
          changes.sessionId === sessionId,
          `the changes are of ${changes.sessionId}`,
        );
        if (changes.status === "changes") {
          check(
            changes.fileChanges.every(
              (change) => change.sessionId === sessionId,
            ),
            "a change is about another session",
          );
        }
        const missing = await host.api.sessionChanges(freshSessionId());
        check(
          missing.status === "no-session",
          `the changes of an unknown session answered ${missing.status}`,
        );
      },
    },
    {
      name: "downloads an attachment's bytes",
      async run(host) {
        const sessionId = await started(host);
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]);
        const attachmentId = await host.attach(sessionId, bytes);
        const download = await host.api.downloadAttachment(
          sessionId,
          attachmentId,
        );
        check(
          download.bytes instanceof Uint8Array,
          "the download's bytes are not a Uint8Array",
        );
        check(
          download.sizeBytes === bytes.byteLength &&
            download.bytes.every((byte, index) => byte === bytes[index]),
          "the download's bytes are not the attachment's",
        );
      },
    },
    {
      name: "refuses an attachment it does not have as not-found",
      async run(host) {
        const sessionId = await started(host);
        const error = await rejection(
          host.api.downloadAttachment(sessionId, "no-such-attachment"),
          "downloading an unknown attachment",
        );
        checkNotFound(error, "downloading an unknown attachment");
      },
    },
    {
      name: "rejects with the caller's reason when its signal aborts",
      async run(host) {
        const sessionId = await started(host);
        const reason = new Error("the caller gave up");
        const error = await rejection(
          host.api.snapshot(sessionId, { signal: AbortSignal.abort(reason) }),
          "a snapshot with an aborted signal",
        );
        check(
          error === reason,
          `an aborted snapshot failed with ${describe(error)}, not the signal's reason`,
        );
      },
    },
  ];
