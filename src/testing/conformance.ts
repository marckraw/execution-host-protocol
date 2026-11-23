import type { ExecutionHostApi } from "../client/api.js";
import type {
  ExecutionFollowEnd,
  ExecutionSessionFollow,
} from "../client/follow.js";
import { ExecutionHostError } from "../client/http.js";
import { ExecutionMcpError } from "../client/mcp.js";
import { ExecutionStartWorksInError } from "../client/works-in.js";
import { ExecutionTaskOutputError } from "../client/task-output.js";
import { isTimestamp } from "../guards.js";
import {
  EXECUTION_MCP_SERVER_SOURCES,
  EXECUTION_MCP_SERVER_STATES,
  isExecutionMcpServerName,
  isExecutionMcpUrl,
  type ExecutionMcpProvider,
  type ExecutionMcpServer,
  type ExecutionMcpSignIn,
  type ExecutionMcpSignInState,
  type ExecutionMcpSignInStatus,
} from "../mcp.js";
import type {
  ExecutionTurnUsage,
  ExecutionTurnUsageQuery,
  ExecutionTurnUsageRecord,
} from "../turn-usage.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionProtocolCapability,
  type ExecutionStartRequest,
} from "../types.js";
import type { ExecutionWorksIn } from "../works-in.js";

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
   * What the host advertises, as its `/health` says it
   * (`executionProtocol.capabilities`). The suite holds a host to the hooks
   * what it advertises needs: one advertising `start.worksIn.v1` must give
   * it `checkouts` (MAR-5673).
   */
  capabilities: readonly ExecutionProtocolCapability[];
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
  /**
   * The MCP connections of a host that manages them (`mcp.connections.v1`,
   * MAR-5668). Leave it out for one that manages none, as a host shared by
   * several people does not: the suite then holds every MCP call to refusing
   * `unavailable-on-host`, or `unsupported` as a host predating them does.
   */
  mcp?: ExecutionHostConformanceMcp;
  /**
   * Starts in a person's own checkout, on a host that places them
   * (`start.worksIn.v1`, MAR-5673). Required of a host that advertises it,
   * which fails every checkout case without it. Leave it out only for a
   * host that places none: the suite then skips those cases.
   */
  checkouts?: ExecutionHostConformanceCheckouts;
  /** Runs after the case, whatever its outcome. */
  close?(): void | Promise<void>;
}

/** What the checkout cases need of a host that places starts in checkouts. */
export interface ExecutionHostConformanceCheckouts {
  /**
   * The top of a git checkout a start may name as its `workingDirectory`,
   * as the host's checkout root reads it, with no session working in it when
   * the case starts. Each case gets one of its own.
   */
  workingDirectory: string;
  /**
   * Keeps the turn of every session the host starts from now on running, as
   * its provider at work does, until the function it gives back is called:
   * those sessions work in their checkout meanwhile.
   */
  holdTurns(): () => void | Promise<void>;
}

/** What the MCP cases need of a host that manages MCP connections. */
export interface ExecutionHostConformanceMcp {
  provider: ExecutionMcpProvider;
  /**
   * A server of the provider's the host lists as `needs-sign-in`, which
   * offers a sign-in, with none pending when the case starts.
   */
  server: string;
  /**
   * Finishes the server's pending sign-in as the owner's browser coming back
   * to the provider's own loopback callback does: the server is connected.
   */
  completeSignIn(): void | Promise<void>;
  /**
   * The URL the provider's page sends the browser to for `signIn`, which
   * `mcpFinishSignIn` takes. Leave it out to check only its refusals.
   */
  callbackUrl?(signIn: ExecutionMcpSignIn): string | Promise<string>;
  /**
   * Makes the server's pending sign-in run out of time now, as `expiresAt`
   * passing does: the host stops waiting, and the sign-in fails. Leave it
   * out to skip the expiry case.
   */
  expireSignIn?(): void | Promise<void>;
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

/**
 * The host's checkout hooks, or null for a host that places no starts in
 * checkouts and so skips those cases. One that advertises `start.worksIn.v1`
 * without them fails: a host that skipped the cases by leaving the hook out
 * would never be held to what it advertises.
 */
function checkoutsOf(
  host: ExecutionHostConformanceHost,
): ExecutionHostConformanceCheckouts | null {
  if (host.checkouts) return host.checkouts;
  check(
    !host.capabilities.includes("start.worksIn.v1"),
    "the host advertises start.worksIn.v1, but gives the suite no checkouts to hold it to",
  );
  return null;
}

/** A start in the checkout cases' folder, asking for `worksIn`. */
async function placedStart(
  host: ExecutionHostConformanceHost,
  checkouts: ExecutionHostConformanceCheckouts,
  worksIn: ExecutionWorksIn,
) {
  const sessionId = freshSessionId();
  const request = startRequest(
    host.providerId,
    sessionId,
    `${sessionId}-start`,
  );
  const result = await host.api.start({
    ...request,
    config: {
      ...request.config,
      workingDirectory: checkouts.workingDirectory,
      worksIn,
    },
  });
  return { sessionId, result };
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

/** That `work` rejects with an `ExecutionMcpError` coded one of `codes`. */
async function checkMcpRefusal(
  work: Promise<unknown>,
  codes: readonly string[],
  what: string,
): Promise<ExecutionMcpError> {
  const error = await rejection(work, what);
  check(
    error instanceof ExecutionMcpError,
    `${what} failed with ${describe(error)}, not an ExecutionMcpError`,
  );
  check(
    codes.includes(error.code),
    `${what} failed as ${error.code}, not ${codes.join(" or ")}`,
  );
  return error;
}

/** Resolves once `state` answers `expected`, asking every few ms, or fails after `ms`. */
async function signInReaches(
  host: ExecutionHostConformanceHost & { mcp: ExecutionHostConformanceMcp },
  expected: ExecutionMcpSignInState,
  ms: number,
): Promise<void> {
  const { provider, server } = host.mcp;
  const started = Date.now();
  let last: string = "nothing";
  for (;;) {
    const status = await host.api.mcpSignInState(provider, server);
    if (status.state === expected) return;
    last = status.state;
    if (Date.now() - started >= ms) {
      throw new ExecutionHostConformanceError(
        `${server}'s sign-in is ${last}, not ${expected}, after ${ms} ms`,
      );
    }
    await pause(CONFORMANCE_POLL_MS);
  }
}

/** The host's row for the case's server, which it must list. */
async function mcpServerRow(
  host: ExecutionHostConformanceHost & { mcp: ExecutionHostConformanceMcp },
): Promise<ExecutionMcpServer> {
  const { provider, server } = host.mcp;
  const list = await host.api.mcpServers(provider);
  const row = list.servers.find((entry) => entry.name === server);
  check(row !== undefined, `mcpServers(${provider}) does not list ${server}`);
  return row;
}

function servesMcp(
  host: ExecutionHostConformanceHost,
): host is ExecutionHostConformanceHost & { mcp: ExecutionHostConformanceMcp } {
  return host.mcp !== undefined;
}

/** A callback URL no sign-in is waiting for, with a code a refusal must not quote. */
const STRAY_CALLBACK =
  "http://localhost:1/callback?code=conformance-secret-code&state=conformance-stray";

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
      name: "lists MCP servers, each once and readable, or refuses every MCP call on a host that manages none",
      async run(host) {
        if (!servesMcp(host)) {
          const server = "conformance-server";
          const calls: Array<[string, () => Promise<unknown>]> = [
            ["mcpServers", () => host.api.mcpServers("claude")],
            ["mcpSignIn", () => host.api.mcpSignIn("claude", server)],
            ["mcpSignInState", () => host.api.mcpSignInState("claude", server)],
            [
              "mcpFinishSignIn",
              () => host.api.mcpFinishSignIn("claude", server, STRAY_CALLBACK),
            ],
            [
              "mcpCancelSignIn",
              () => host.api.mcpCancelSignIn("claude", server),
            ],
            ["mcpSignOut", () => host.api.mcpSignOut("claude", server)],
          ];
          for (const [name, call] of calls) {
            await checkMcpRefusal(
              call(),
              ["unavailable-on-host", "unsupported"],
              `${name} on a host without MCP connections`,
            );
          }
          return;
        }
        const { provider, server } = host.mcp;
        const list = await host.api.mcpServers(provider);
        check(
          Array.isArray(list.servers) && Array.isArray(list.warnings),
          `mcpServers(${provider}) has no servers or no warnings`,
        );
        const names = new Set<string>();
        for (const row of list.servers) {
          check(
            isExecutionMcpServerName(row.name),
            "mcpServers lists a server by a name no call can address",
          );
          check(!names.has(row.name), `mcpServers lists ${row.name} twice`);
          names.add(row.name);
          check(
            (EXECUTION_MCP_SERVER_SOURCES as readonly string[]).includes(
              row.source,
            ),
            `${row.name}'s source is ${String(row.source)}`,
          );
          check(
            (EXECUTION_MCP_SERVER_STATES as readonly string[]).includes(
              row.state,
            ),
            `${row.name}'s state is ${String(row.state)}`,
          );
          check(
            typeof row.transport === "string" && row.transport.length > 0,
            `${row.name} has no transport`,
          );
        }
        const row = await mcpServerRow(host);
        check(
          row.state === "needs-sign-in",
          `${server} is ${row.state}, not needs-sign-in`,
        );
      },
    },
    {
      name: "signs in to an MCP server: a URL to open, the same sign-in when asked again, then connected",
      async run(host, { waitMs }) {
        if (!servesMcp(host)) return;
        const { provider, server } = host.mcp;
        const before = Date.now();
        const signIn = await host.api.mcpSignIn(provider, server);
        // Never quoted: a failure message is a log line.
        check(
          isExecutionMcpUrl(signIn.signInUrl),
          "the sign-in's URL is not an http or https URL",
        );
        check(
          typeof signIn.callbackExpected === "boolean",
          "the sign-in does not say whether a callback is expected",
        );
        check(
          isTimestamp(signIn.expiresAt) &&
            Date.parse(signIn.expiresAt) > before,
          `the sign-in expires at ${String(signIn.expiresAt)}, not after it started`,
        );
        const status = await host.api.mcpSignInState(provider, server);
        check(
          status.state === "pending",
          `a sign-in just started is ${status.state}, not pending`,
        );
        const again = await host.api.mcpSignIn(provider, server);
        check(
          again.signInUrl === signIn.signInUrl &&
            again.expiresAt === signIn.expiresAt,
          "a second sign-in while one is pending is not the pending one",
        );
        await host.mcp.completeSignIn();
        await signInReaches(host, "connected", waitMs);
        const row = await mcpServerRow(host);
        check(
          row.state === "connected",
          `${server} is ${row.state} once signed in, not connected`,
        );
      },
    },
    {
      name: "cancels a pending MCP sign-in, and says how one that ended first ended",
      async run(host, { waitMs }) {
        if (!servesMcp(host)) return;
        const { provider, server } = host.mcp;
        await host.api.mcpSignIn(provider, server);
        const cancelled = await host.api.mcpCancelSignIn(provider, server);
        check(
          cancelled.state === "cancelled",
          `a cancelled sign-in is ${cancelled.state}, not cancelled`,
        );
        await signInReaches(host, "cancelled", waitMs);
        const row = await mcpServerRow(host);
        check(
          row.state === "needs-sign-in",
          `${server} is ${row.state} after a cancelled sign-in, not needs-sign-in`,
        );
        await host.api.mcpSignIn(provider, server);
        await signInReaches(host, "pending", waitMs);
        await host.mcp.completeSignIn();
        await signInReaches(host, "connected", waitMs);
        const late = await host.api.mcpCancelSignIn(provider, server);
        check(
          late.state === "connected",
          `cancelling a sign-in that connected first answers ${late.state}, not connected`,
        );
      },
    },
    {
      name: "finishes an MCP sign-in from its callback URL, refusing one not its own and keeping the sign-in pending",
      async run(host, { waitMs }) {
        if (!servesMcp(host)) return;
        const { provider, server } = host.mcp;
        await checkMcpRefusal(
          host.api.mcpFinishSignIn(provider, server, STRAY_CALLBACK),
          ["no-sign-in"],
          "finishing a sign-in that was never started",
        );
        const signIn = await host.api.mcpSignIn(provider, server);
        // A callback that is not the sign-in's is refused, and costs the
        // owner nothing: the sign-in they are finishing in their browser
        // stays pending.
        const stray = await checkMcpRefusal(
          host.api.mcpFinishSignIn(provider, server, STRAY_CALLBACK),
          ["rejected"],
          "finishing with a callback that is not the sign-in's",
        );
        check(
          !`${stray.message} ${stray.reason}`.includes(
            "conformance-secret-code",
          ),
          "the refusal of a callback URL quotes its code",
        );
        const after = await host.api.mcpSignInState(provider, server);
        check(
          after.state === "pending",
          `a sign-in is ${after.state} after a callback not its own, not pending`,
        );
        const again = await host.api.mcpSignIn(provider, server);
        check(
          again.signInUrl === signIn.signInUrl,
          "a stray callback replaced the pending sign-in",
        );
        if (host.mcp.callbackUrl === undefined) return;
        const finished = await host.api.mcpFinishSignIn(
          provider,
          server,
          await host.mcp.callbackUrl(signIn),
        );
        check(
          finished.state === "pending" || finished.state === "connected",
          `a finished sign-in is ${finished.state}`,
        );
        await signInReaches(host, "connected", waitMs);
        const row = await mcpServerRow(host);
        check(
          row.state === "connected",
          `${server} is ${row.state} once its sign-in was finished, not connected`,
        );
      },
    },
    {
      name: "fails an MCP sign-in whose time runs out, and starts a fresh one after it",
      async run(host) {
        if (!servesMcp(host) || host.mcp.expireSignIn === undefined) return;
        const { provider, server } = host.mcp;
        const first = await host.api.mcpSignIn(provider, server);
        await host.mcp.expireSignIn();
        const expired = await host.api.mcpSignInState(provider, server);
        check(
          expired.state === "failed",
          `a sign-in whose time ran out is ${expired.state}, not failed`,
        );
        const cancelled = await host.api.mcpCancelSignIn(provider, server);
        check(
          cancelled.state === "failed",
          `cancelling a sign-in whose time ran out answers ${cancelled.state}, not failed`,
        );
        if (host.mcp.callbackUrl !== undefined) {
          const late = await host.api
            .mcpFinishSignIn(
              provider,
              server,
              await host.mcp.callbackUrl(first),
            )
            .catch((error: unknown) => error);
          check(
            late instanceof ExecutionMcpError ||
              (late as ExecutionMcpSignInStatus).state === "failed",
            "finishing a sign-in whose time ran out did not leave it failed",
          );
        }
        const row = await mcpServerRow(host);
        check(
          row.state === "needs-sign-in",
          `${server} is ${row.state} after its sign-in ran out, not needs-sign-in`,
        );
        const fresh = await host.api.mcpSignIn(provider, server);
        check(
          fresh.signInUrl !== first.signInUrl,
          "signing in after one ran out answered the old sign-in",
        );
        const status = await host.api.mcpSignInState(provider, server);
        check(
          status.state === "pending",
          `a fresh sign-in is ${status.state}, not pending`,
        );
      },
    },
    {
      name: "signs out of an MCP server, which then needs a sign-in again",
      async run(host, { waitMs }) {
        if (!servesMcp(host)) return;
        const { provider, server } = host.mcp;
        await host.api.mcpSignIn(provider, server);
        await host.mcp.completeSignIn();
        await signInReaches(host, "connected", waitMs);
        await host.api.mcpSignOut(provider, server);
        const row = await mcpServerRow(host);
        check(
          row.state === "needs-sign-in",
          `${server} is ${row.state} once signed out, not needs-sign-in`,
        );
        await checkMcpRefusal(
          host.api.mcpSignInState(provider, server),
          ["no-sign-in"],
          "the state of a sign-in signed out since",
        );
        await host.api.mcpSignOut(provider, server);
      },
    },
    {
      name: "refuses an MCP server the provider does not have, and a sign-in that is not there",
      async run(host) {
        if (!servesMcp(host)) return;
        const { provider, server } = host.mcp;
        const unknown = `conformance-no-such-server-${Math.random().toString(36).slice(2, 10)}`;
        await checkMcpRefusal(
          host.api.mcpSignIn(provider, unknown),
          ["unknown-server"],
          "signing in to a server the provider does not have",
        );
        await checkMcpRefusal(
          host.api.mcpSignOut(provider, unknown),
          ["unknown-server"],
          "signing out of a server the provider does not have",
        );
        await checkMcpRefusal(
          host.api.mcpSignInState(provider, server),
          ["no-sign-in"],
          "the state of a sign-in never started",
        );
        await checkMcpRefusal(
          host.api.mcpCancelSignIn(provider, server),
          ["no-sign-in"],
          "cancelling a sign-in never started",
        );
      },
    },
    {
      name: "refuses an MCP call the protocol would refuse as a TypeError",
      async run(host) {
        const provider = host.mcp?.provider ?? "claude";
        const server = host.mcp?.server ?? "conformance-server";
        const calls: Array<[string, () => Promise<unknown>]> = [
          [
            "a provider it does not know",
            () => host.api.mcpServers("gemini" as ExecutionMcpProvider),
          ],
          ["an empty server name", () => host.api.mcpSignIn(provider, "")],
          [
            "no server at all",
            () => host.api.mcpSignOut(provider, null as unknown as string),
          ],
          [
            "a server name with a bidi override",
            () => host.api.mcpSignOut(provider, "linear\u202e"),
          ],
          [
            "a callback URL that is not http or https",
            () =>
              host.api.mcpFinishSignIn(provider, server, "javascript:alert(1)"),
          ],
        ];
        for (const [what, call] of calls) {
          const error = await rejection(call(), what);
          check(
            error instanceof TypeError,
            `an MCP call with ${what} failed with ${describe(error)}, not a TypeError`,
          );
        }
      },
    },
    {
      name: "hands a follower mcp.needs-sign-in as it was sent",
      async run(host, { waitMs }) {
        const sessionId = await started(host);
        const mark = marked(sessionId, 1);
        await host.emit(sessionId, [
          { kind: "mcp.needs-sign-in", provider: "codex", server: "linear" },
          ...mark,
        ]);
        const following = follow(host.api, sessionId, 0, hasAll(sessionId, 1));
        try {
          await within(following.reached, waitMs, "the follow");
        } finally {
          await following.follow.stop();
        }
        const event = following.kept.find(
          (envelope) => envelope.event.kind === "mcp.needs-sign-in",
        )?.event;
        check(
          event !== undefined,
          "the follow was not handed mcp.needs-sign-in",
        );
        check(
          event.kind === "mcp.needs-sign-in" &&
            event.provider === "codex" &&
            event.server === "linear",
          "mcp.needs-sign-in arrived about another provider or server",
        );
      },
    },
    {
      name: "works a start in a free checkout there, and says so, or in a worktree of its own when asked",
      async run(host) {
        const checkouts = checkoutsOf(host);
        if (!checkouts) return;
        const release = checkouts.holdTurns();
        try {
          const inIt = await placedStart(host, checkouts, "checkout");
          check(
            inIt.result.status === "started" &&
              inIt.result.worksIn?.place === "checkout" &&
              inIt.result.worksIn.workingThere.length === 0 &&
              inIt.result.worksIn.checkoutRoot.length > 0,
            `a checkout start in a free checkout answered ${describe(inIt.result)}, not started in the checkout beside nobody`,
          );
          const own = await placedStart(host, checkouts, "worktree");
          check(
            own.result.status === "started" &&
              own.result.worksIn?.place === "worktree",
            `a worktree start answered ${describe(own.result)}, not started in a worktree`,
          );
        } finally {
          await release();
        }
      },
    },
    {
      name: "refuses a checkout another session works in, naming it, and gives auto a worktree",
      async run(host) {
        const checkouts = checkoutsOf(host);
        if (!checkouts) return;
        const release = checkouts.holdTurns();
        try {
          const first = await placedStart(host, checkouts, "checkout");
          check(
            first.result.status === "started",
            "the first checkout start did not start",
          );
          const refused = await rejection(
            placedStart(host, checkouts, "checkout"),
            "a checkout start beside a session at work",
          );
          check(
            refused instanceof ExecutionStartWorksInError &&
              refused.code === "checkout-taken" &&
              refused.status === 409 &&
              refused.workingThere.includes(first.sessionId),
            `a checkout start beside a session at work failed with ${describe(refused)}, not checkout-taken naming it`,
          );
          const auto = await placedStart(host, checkouts, "auto");
          check(
            auto.result.status === "started" &&
              auto.result.worksIn?.place === "worktree" &&
              auto.result.worksIn.workingThere.includes(first.sessionId),
            `an auto start beside a session at work answered ${describe(auto.result)}, not a worktree naming it`,
          );
        } finally {
          await release();
        }
      },
    },
    {
      name: "settles a session, idempotently, says so in its snapshot and the list, and frees its checkout",
      async run(host) {
        const checkouts = checkoutsOf(host);
        if (!checkouts) return;
        const release = checkouts.holdTurns();
        try {
          const first = await placedStart(host, checkouts, "checkout");
          for (const attempt of ["first", "again"]) {
            const answer = await host.api.patchSession(first.sessionId, {
              settled: true,
            });
            check(
              answer.status === "patched" && answer.settled === true,
              `settling it (${attempt}) answered ${describe(answer)}, not patched and settled`,
            );
          }
          const snapshot = await host.api.snapshot(first.sessionId);
          check(
            snapshot?.settled === true,
            "its snapshot does not say it is settled",
          );
          const listed = (await host.api.listSessions()).sessions.find(
            (one) => one.sessionId === first.sessionId,
          );
          check(
            listed?.settled === true,
            "the list does not say it is settled",
          );
          const next = await placedStart(host, checkouts, "checkout");
          check(
            next.result.status === "started" &&
              next.result.worksIn?.place === "checkout",
            `a checkout start beside a settled session answered ${describe(next.result)}, not started in the checkout`,
          );
          for (const attempt of ["first", "again"]) {
            const answer = await host.api.patchSession(first.sessionId, {
              settled: false,
            });
            check(
              answer.status === "patched" && answer.settled === false,
              `taking the settle back (${attempt}) answered ${describe(answer)}, not patched and unsettled`,
            );
          }
          check(
            (await host.api.snapshot(first.sessionId))?.settled === undefined,
            "its snapshot still says it is settled once that was taken back",
          );
        } finally {
          await release();
        }
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
