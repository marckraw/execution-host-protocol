import type { ExecutionHostApi } from "../client/api.js";
import type {
  ExecutionFollowEnd,
  ExecutionSessionFollow,
} from "../client/follow.js";
import { ExecutionHostError } from "../client/http.js";
import { ExecutionTaskOutputError } from "../client/task-output.js";
import { isTimestamp } from "../guards.js";
import type {
  ExecutionTurnUsage,
  ExecutionTurnUsageQuery,
  ExecutionTurnUsageRecord,
} from "../turn-usage.js";
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
  /**
   * Runs a turn of the session that ends having cost `usage`, as the host's
   * runtime does when its provider reports what a turn cost
   * (`turns.usage.v1`, MAR-4943), and says the turn's id: the turn is on the
   * session's log and in its snapshot, its `turn.patch` carries the usage,
   * and `listTurnUsage` lists it, `live`.
   *
   * Leave it out for a host that records no usage: the suite then holds it
   * to refusing `listTurnUsage` as `not-found`, as an older host's 404 is.
   */
  endTurnWithUsage?(
    sessionId: string,
    usage: ExecutionTurnUsage,
  ): string | Promise<string>;
  /**
   * Records a turn's usage as the host's backfill reads it back from its
   * history: a `backfill` record of a turn that ended at `endedAt`, long
   * before the case runs, recorded now, after everything before it. Says its
   * `turnId`. A record listed out of the order turns ended is what shows a
   * cursor that lost its `since`, so a host that backfills gives the suite
   * this. Leave it out for one that does not: the cases use live turns alone.
   */
  backfillTurnUsage?(
    usage: ExecutionTurnUsage,
    endedAt: string,
  ): string | Promise<string>;
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
 * A turn's usage the case can tell apart from another's: `n` in its tokens,
 * on two models whose parts add up to the turn's, priced at list.
 */
function usageFor(providerId: string, n: number): ExecutionTurnUsage {
  return {
    providerId,
    model: "conformance-main",
    accountId: null,
    tokens: {
      input: 100 + n,
      cacheWrite5m: 30,
      cacheWrite1h: 2,
      cacheRead: 2_000,
      output: 50,
      reasoning: 8,
    },
    costUsdReported: 0.0425,
    costBasis: "list",
    models: [
      {
        model: "conformance-main",
        tokens: {
          input: 90 + n,
          cacheWrite5m: 30,
          cacheWrite1h: 2,
          cacheRead: 1_500,
          output: 40,
          reasoning: 8,
        },
        costUsdReported: 0.04,
      },
      {
        model: "conformance-helper",
        tokens: {
          input: 10,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 500,
          output: 10,
          reasoning: 0,
        },
        costUsdReported: 0.0025,
      },
    ],
  };
}

/** The usage's own fields, keys in order, for comparing two of them. */
function usageText(usage: ExecutionTurnUsage): string {
  const { providerId, model, accountId, tokens } = usage;
  return canonical({
    providerId,
    model,
    accountId,
    tokens,
    costUsdReported: usage.costUsdReported,
    costBasis: usage.costBasis,
    models: usage.models,
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, part: unknown) =>
    typeof part === "object" && part !== null && !Array.isArray(part)
      ? Object.fromEntries(
          Object.entries(part).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : part,
  );
}

function checkUsage(
  got: ExecutionTurnUsage | undefined,
  expected: ExecutionTurnUsage,
  what: string,
): void {
  check(got !== undefined, `${what} carries no usage`);
  check(
    usageText(got) === usageText(expected),
    `${what} carries ${usageText(got)}, not ${usageText(expected)}`,
  );
}

/**
 * The host's `endTurnWithUsage`, or null after checking that a host without
 * one refuses the history as an older host does.
 */
async function usageRecorder(
  host: ExecutionHostConformanceHost,
): Promise<NonNullable<
  ExecutionHostConformanceHost["endTurnWithUsage"]
> | null> {
  if (host.endTurnWithUsage) return host.endTurnWithUsage.bind(host);
  const error = await rejection(
    host.api.listTurnUsage(),
    "the usage history of a host that records none",
  );
  checkNotFound(error, "the usage history of a host that records none");
  return null;
}

/**
 * Reads the usage history from `query` to its end, a page of at most `limit`
 * at a time, checking each page's frame. Returns the records and the last
 * cursor the host gave.
 */
async function readHistory(
  api: ExecutionHostApi,
  query: Omit<ExecutionTurnUsageQuery, "cursor" | "limit">,
  limit: number,
  cursor?: string,
): Promise<{
  records: ExecutionTurnUsageRecord[];
  cursor: string | undefined;
}> {
  const records: ExecutionTurnUsageRecord[] = [];
  let last = cursor;
  for (let page = 0; page < 200; page += 1) {
    const read = await api.listTurnUsage(
      last === undefined ? { ...query, limit } : { cursor: last, limit },
    );
    check(Array.isArray(read.records), "listTurnUsage() has no records");
    check(
      read.records.length <= limit,
      `a page of at most ${limit} held ${read.records.length}`,
    );
    check(
      typeof read.hasMore === "boolean",
      `hasMore is ${String(read.hasMore)}`,
    );
    check(
      read.nextCursor === null || typeof read.nextCursor === "string",
      `nextCursor is ${String(read.nextCursor)}`,
    );
    check(
      read.records.length === 0 || read.nextCursor !== null,
      "a page with records gave no cursor to resume after it",
    );
    check(
      !read.hasMore || read.nextCursor !== null,
      "a page with more after it gave no cursor",
    );
    records.push(...read.records);
    if (read.nextCursor !== null) last = read.nextCursor;
    if (!read.hasMore) return { records, cursor: last };
  }
  throw new ExecutionHostConformanceError(
    "the usage history did not end within 200 pages",
  );
}

/** When the backfilled turns of the cases ended: long before any live one. */
const LONG_AGO = "2020-01-01T00:00:00.000Z";

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `since` just after the turn ended, by the host's own clock: the turn is
 * before it, and a turn the host ends later is after it.
 */
async function sinceAfter(
  api: ExecutionHostApi,
  turnId: string,
): Promise<string> {
  const { records } = await readHistory(api, {}, 500);
  const record = records.find((entry) => entry.turnId === turnId);
  check(record !== undefined, `the usage history does not list ${turnId}`);
  return new Date(Date.parse(record.endedAt) + 1).toISOString();
}

/**
 * Which of `turnIds` a read since `since` lists, and in which order, by the
 * whole history: those that ended at or after it, in the order recorded.
 */
async function endedSince(
  api: ExecutionHostApi,
  turnIds: string[],
  since: string,
): Promise<string[]> {
  const { records } = await readHistory(api, {}, 500);
  placesOf(records, turnIds, "the usage history");
  return records
    .filter(
      (record) =>
        turnIds.includes(record.turnId) &&
        Date.parse(record.endedAt) >= Date.parse(since),
    )
    .map((record) => record.turnId);
}

/**
 * That a read since `since` lists no turn that ended before it, and of
 * `turnIds`, exactly `expected`, in order.
 */
function checkSince(
  records: ExecutionTurnUsageRecord[],
  since: string,
  turnIds: string[],
  expected: string[],
  what: string,
): void {
  const early = records.find(
    (record) => Date.parse(record.endedAt) < Date.parse(since),
  );
  check(
    early === undefined,
    `${what} lists turn ${early?.turnId}, which ended at ${early?.endedAt}, before it`,
  );
  const got = records
    .map((record) => record.turnId)
    .filter((turnId) => turnIds.includes(turnId));
  check(
    got.join(",") === expected.join(","),
    `${what} lists ${got.join(",")}, not ${expected.join(",")}`,
  );
}

/** Where each of `turnIds` sits in `records`, checking it is there once. */
function placesOf(
  records: ExecutionTurnUsageRecord[],
  turnIds: string[],
  what: string,
): number[] {
  return turnIds.map((turnId) => {
    const count = records.filter((record) => record.turnId === turnId).length;
    check(count === 1, `${what} holds turn ${turnId} ${count} times, not once`);
    return records.findIndex((record) => record.turnId === turnId);
  });
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
      name: "refuses a turn usage query the protocol would refuse",
      async run({ api }) {
        const refused: Array<
          [
            ExecutionTurnUsageQuery,
            string,
            typeof TypeError | typeof RangeError,
          ]
        > = [
          [
            { since: "2026-10-30T00:00:00.000Z", cursor: "c" },
            "since with a cursor",
            TypeError,
          ],
          [{ since: "yesterday" }, "a since that is no timestamp", TypeError],
          [{ limit: 0 }, "a limit of 0", RangeError],
          [{ limit: 501 }, "a limit of 501", RangeError],
        ];
        for (const [query, what, kind] of refused) {
          const error = await rejection(api.listTurnUsage(query), what);
          check(
            error instanceof kind,
            `${what} failed with ${describe(error)}, not a ${kind.name}`,
          );
        }
      },
    },
    {
      name: "hands a turn's usage to its followers and its snapshot",
      async run(host, { waitMs }) {
        const endTurn = await usageRecorder(host);
        if (endTurn === null) return;
        const sessionId = await started(host);
        const usage = usageFor(host.providerId, 1);
        const turnId = await endTurn(sessionId, usage);
        check(
          typeof turnId === "string" && turnId.length > 0,
          `endTurnWithUsage said turn ${String(turnId)}`,
        );
        const carriesUsage = (envelope: ExecutionHostEventEnvelope) =>
          envelope.event.kind === "delta" &&
          envelope.event.delta.kind === "turn.patch" &&
          envelope.event.delta.turnId === turnId &&
          envelope.event.delta.patch.usage !== undefined;
        const following = follow(host.api, sessionId, 0, (kept) =>
          kept.some(carriesUsage),
        );
        try {
          await within(following.reached, waitMs, "the turn's usage");
          const envelope = following.kept.find(carriesUsage)!;
          if (
            envelope.event.kind === "delta" &&
            envelope.event.delta.kind === "turn.patch"
          ) {
            checkUsage(
              envelope.event.delta.patch.usage,
              usage,
              "the turn's turn.patch",
            );
          }
        } finally {
          await following.follow.stop();
        }
        const snapshot = await host.api.snapshot(sessionId);
        check(snapshot !== null, "snapshot() of a started session is null");
        const turn = snapshot.turns.find((entry) => entry.id === turnId);
        check(turn !== undefined, `the snapshot has no turn ${turnId}`);
        checkUsage(turn.usage, usage, `the snapshot's turn ${turnId}`);
      },
    },
    {
      name: "lists turn usage in the order recorded, each once, and catches up from its last cursor",
      async run(host) {
        const endTurn = await usageRecorder(host);
        if (endTurn === null) return;
        const first = await started(host);
        const second = await started(host);
        const ended: Array<[string, string, ExecutionTurnUsage]> = [];
        for (const [sessionId, n] of [
          [first, 1],
          [second, 2],
          [first, 3],
        ] as const) {
          const usage = usageFor(host.providerId, n);
          ended.push([sessionId, await endTurn(sessionId, usage), usage]);
        }
        const read = await readHistory(host.api, {}, 1);
        const places = placesOf(
          read.records,
          ended.map(([, turnId]) => turnId),
          "the usage history",
        );
        check(
          places.every(
            (place, index) => index === 0 || place > places[index - 1]!,
          ),
          `the usage history lists the turns at ${places.join(",")}, not in the order they ended`,
        );
        ended.forEach(([sessionId, turnId, usage], index) => {
          const record = read.records[places[index]!]!;
          check(
            record.sessionId === sessionId,
            `turn ${turnId}'s record names session ${String(record.sessionId)}, not ${sessionId}`,
          );
          check(
            record.source === "live",
            `turn ${turnId}'s record is ${record.source}, not live`,
          );
          check(
            isTimestamp(record.endedAt),
            `turn ${turnId}'s record ended at ${String(record.endedAt)}`,
          );
          checkUsage(record, usage, `turn ${turnId}'s record`);
        });
        check(
          read.cursor !== undefined,
          "the usage history gave no cursor to catch up from",
        );

        const usage = usageFor(host.providerId, 4);
        const later = await endTurn(second, usage);
        const caughtUp = await readHistory(host.api, {}, 2, read.cursor);
        placesOf(caughtUp.records, [later], "catching up");
        check(
          !caughtUp.records.some((record) =>
            ended.some(([, turnId]) => turnId === record.turnId),
          ),
          "catching up from the last cursor listed turns read before it",
        );
      },
    },
    {
      name: "lists only the turn usage of turns that ended since a given time",
      async run(host) {
        const endTurn = await usageRecorder(host);
        if (endTurn === null) return;
        const sessionId = await started(host);
        const before = new Date(Date.now() - 60_000).toISOString();
        const turnId = await endTurn(sessionId, usageFor(host.providerId, 5));
        const since = await readHistory(host.api, { since: before }, 2);
        placesOf(since.records, [turnId], `the usage history since ${before}`);
        check(
          since.records.every(
            (record) => Date.parse(record.endedAt) >= Date.parse(before),
          ),
          `the usage history since ${before} lists a turn that ended before it`,
        );
        const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
        const none = await readHistory(host.api, { since: tomorrow }, 2);
        check(
          none.records.length === 0,
          `the usage history since ${tomorrow} lists ${none.records.length} turns`,
        );
      },
    },
    {
      name: "pages turn usage since a given time, keeping since on every cursor",
      async run(host) {
        const endTurn = await usageRecorder(host);
        if (endTurn === null) return;
        const backfill = host.backfillTurnUsage?.bind(host);
        const sessionId = await started(host);
        // One live turn before `since`, and backfilled turns between those
        // after it: a cursor that lost `since` lists one of them.
        const early = await endTurn(sessionId, usageFor(host.providerId, 10));
        const since = await sinceAfter(host.api, early);
        await pause(5);
        const turnIds = [early];
        for (let n = 0; n < 3; n += 1) {
          if (backfill) {
            turnIds.push(
              await backfill(usageFor(host.providerId, 20 + n), LONG_AGO),
            );
          }
          turnIds.push(
            await endTurn(sessionId, usageFor(host.providerId, 11 + n)),
          );
        }
        const expected = await endedSince(host.api, turnIds, since);
        check(
          !expected.includes(early),
          `turn ${early} ended after ${since}, a moment after it ended`,
        );
        const read = await readHistory(host.api, { since }, 1);
        checkSince(
          read.records,
          since,
          turnIds,
          expected,
          `the usage history since ${since}, a page at a time`,
        );
      },
    },
    {
      name: "catches up from a read since a given time with only what ended since",
      async run(host) {
        const endTurn = await usageRecorder(host);
        if (endTurn === null) return;
        const backfill = host.backfillTurnUsage?.bind(host);
        const sessionId = await started(host);
        const early = await endTurn(sessionId, usageFor(host.providerId, 30));
        const since = await sinceAfter(host.api, early);
        await pause(5);
        await endTurn(sessionId, usageFor(host.providerId, 31));
        if (backfill) await backfill(usageFor(host.providerId, 32), LONG_AGO);
        const read = await readHistory(host.api, { since }, 1);
        check(
          read.cursor !== undefined,
          `the usage history since ${since} gave no cursor to catch up from`,
        );
        const later: string[] = [];
        if (backfill) {
          later.push(await backfill(usageFor(host.providerId, 33), LONG_AGO));
        }
        later.push(await endTurn(sessionId, usageFor(host.providerId, 34)));
        if (backfill) {
          later.push(await backfill(usageFor(host.providerId, 35), LONG_AGO));
        }
        const expected = await endedSince(host.api, later, since);
        const caughtUp = await readHistory(host.api, {}, 1, read.cursor);
        checkSince(
          caughtUp.records,
          since,
          later,
          expected,
          `catching up from the usage history since ${since}`,
        );
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
