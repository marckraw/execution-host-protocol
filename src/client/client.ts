import {
  decodeExecutionProjectListResponse,
  decodeExecutionProviderListResponse,
  decodeExecutionSessionPatchRequest,
  decodeExecutionSessionPatchResponse,
  decodeExecutionSessionWorkspace,
  encodeExecutionCommandEnvelope,
  encodeExecutionSessionPatchRequest,
  encodeExecutionStartRequest,
} from "../codecs.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionActor,
  type ExecutionDecodeWarning,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionProject,
  type ExecutionProvider,
  type ExecutionSessionPatchRequest,
  type ExecutionSessionWorkspace,
  type ExecutionStartRequest,
} from "../types.js";
import {
  followExecutionSession,
  type ExecutionFollowOptions,
  type ExecutionSessionFollow,
} from "./follow.js";
import {
  evaluateExecutionHostHandshake,
  parseExecutionHostHealth,
  type ExecutionHostHandshake,
  type ExecutionHostHealth,
  type ExecutionHostMetaProbe,
} from "./health.js";
import {
  ExecutionHostError,
  failureOf,
  joinUrl,
  kindOfStatus,
  positiveMs,
  reasonOf,
  scrubberFor,
  seconds,
  startDeadline,
  usableToken,
} from "./http.js";
import { notify } from "./listeners.js";
import {
  decodeExecutionSessionSnapshot,
  type ExecutionSessionSnapshot,
} from "./snapshot.js";
import {
  streamSessionEvents,
  type ExecutionEventStreamOptions,
  type ExecutionStreamFrame,
  type HostConnection,
} from "./stream.js";

export interface ExecutionHostClientOptions {
  /** Where the host answers, e.g. `https://agents.example.com`. */
  baseUrl: string;
  /** The host's bearer token. Sent in the `Authorization` header and nowhere else. */
  token: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** How long a request may take, body included. Default 60 s: a start spawns a provider. */
  requestTimeoutMs?: number;
  /** How long `/health` and the token probe may take. Default 15 s: a cold host probes its providers. */
  healthTimeoutMs?: number;
  /** Mints the command id of a request sent without one. Default `crypto.randomUUID()`. */
  createCommandId?: () => string;
  /**
   * Hears what a start echo or a snapshot had to drop to be read, so a drop is
   * never silent. Envelopes' own warnings reach `followSession`'s `onEnvelope`.
   */
  onWarnings?(notice: {
    operation: "start" | "snapshot";
    sessionId: string;
    warnings: ExecutionDecodeWarning[];
  }): void;
}

export interface ExecutionRequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's timeout for this request. */
  timeoutMs?: number;
}

export interface ExecutionCommandOptions extends ExecutionRequestOptions {
  /** Who is sending it (MAR-3633). */
  actor?: ExecutionActor;
  /** The client's id for the command; minted when absent. Reuse it to retry. */
  commandId?: string;
}

/**
 * `started` — the host accepted the session; `workspace` is where it says it
 * prepared it, when it says. `exists` — it already has a session by that id
 * (409): a retried start, or one another process made first.
 */
export type ExecutionStartResult =
  | {
      status: "started";
      sessionId: string;
      commandId: string;
      workspace: ExecutionSessionWorkspace | null;
    }
  | { status: "exists"; sessionId: string; commandId: string };

/** `no-session` — the host has no session by that id (404). */
export interface ExecutionCommandResult {
  status: "accepted" | "no-session";
  commandId: string;
}

/**
 * `patched` — the host took the patch, and says what it holds now: the title
 * as stored when the patch named one, and the model and effort the session's
 * next turn runs on when it named either (MAR-3662). `no-session` — the host
 * has no session by that id (404).
 */
export type ExecutionSessionPatchResult =
  | {
      status: "patched";
      sessionId: string;
      title?: string | null;
      model?: string | null;
      effort?: string | null;
    }
  | { status: "no-session"; sessionId: string };

/**
 * `deleted` — the host tore the session down: its provider stopped, its
 * workspace and log gone. `no-session` — the host has no session by that id
 * (404): torn down already, or never there.
 */
export interface ExecutionDeleteSessionResult {
  status: "deleted" | "no-session";
  sessionId: string;
}

export interface ExecutionHostClient {
  readonly baseUrl: string;
  /** `GET /health`, unauthenticated. Throws `ExecutionHostError` when unreadable. */
  health(options?: ExecutionRequestOptions): Promise<ExecutionHostHealth>;
  /**
   * `/health`, then `GET /v0/meta` with the token, judged together: is the
   * host there, does it speak this protocol, does it take the token. Never
   * throws, except for the caller's own abort.
   */
  handshake(options?: ExecutionRequestOptions): Promise<ExecutionHostHandshake>;
  /** The Projects the host advertises (`GET /v0/projects`). */
  projects(options?: ExecutionRequestOptions): Promise<ExecutionProject[]>;
  /**
   * The providers the host serves, with the models and efforts each offers
   * (`GET /v0/providers`): the catalogue a session's model and effort are
   * checked against. Takes the health timeout, not the request one — it is a
   * read of what the host already knows.
   */
  providers(options?: ExecutionRequestOptions): Promise<ExecutionProvider[]>;
  /** Starts a session with its first turn. The request's `commandId` is minted when absent. */
  start(
    request: ExecutionStartRequest,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionStartResult>;
  /** Sends a session a command, saying who sent it. */
  command(
    sessionId: string,
    command: ExecutionHostCommand,
    options?: ExecutionCommandOptions,
  ): Promise<ExecutionCommandResult>;
  /**
   * Changes a session's settings (`PATCH /v0/execution/sessions/:id`): its
   * title, and on a host advertising `sessions.modelSelection.v1` the model
   * and effort its turns run on from the next one (MAR-3662). A patch the
   * protocol would refuse throws before anything is sent; a selection the
   * host's catalog does not offer is its 400, an `ExecutionHostError`
   * carrying the host's reason.
   */
  patchSession(
    sessionId: string,
    patch: ExecutionSessionPatchRequest,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionPatchResult>;
  /**
   * Tears a session down (`DELETE /v0/execution/sessions/:id`): the provider
   * stops, the workspace and the log go, and the streams following it end —
   * a follower that reconnects hears 404, `no-session`. Deleting a session the
   * host does not have is `no-session`, not an error, so a retry after a lost
   * answer is safe. Any other refusal throws an `ExecutionHostError`.
   */
  deleteSession(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionDeleteSessionResult>;
  /** The session as the host has it now, or null when it has none by that id. */
  snapshot(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionSnapshot | null>;
  /**
   * One connection to the session's event stream, decoded but not sequenced.
   * Most readers want `followSession`. When the caller's `signal` aborts the
   * iteration ends, it does not throw — the same as `followSession`, whose
   * `done` says `stopped`. A caller that must tell an abort from the host
   * closing the stream checks `signal.aborted` once the loop ends; anything
   * else that ends it (the host closing, a break in the connection, the idle
   * timeout) is not an abort and is as the stream reported it.
   */
  events(
    sessionId: string,
    options?: ExecutionEventStreamOptions,
  ): AsyncIterable<ExecutionStreamFrame>;
  /**
   * Follows the session across turns, reconnecting, resuming and reporting
   * gaps, until stopped. See `ExecutionFollowOptions`.
   */
  followSession(
    sessionId: string,
    options: ExecutionFollowOptions,
  ): ExecutionSessionFollow;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;

/**
 * A client for one execution host — agents-daemon's HTTP API — in plain
 * JavaScript with no dependencies beyond the protocol it ships with, so it
 * loads anywhere `fetch` does: Node 20+, Bun, browsers, Electron, React Native.
 */
export function createExecutionHostClient(
  options: ExecutionHostClientOptions,
): ExecutionHostClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (baseUrl === "") throw new TypeError("baseUrl is required");
  const fetchFn: typeof globalThis.fetch | undefined =
    options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new TypeError("No fetch: pass one in options.fetch");
  }
  const token = usableToken(options.token);
  const connection: HostConnection = {
    baseUrl,
    token,
    scrub: scrubberFor(token),
    // Called bare, never as a method of the options object.
    fetch: (input, init) => fetchFn(input, init),
  };
  const requestTimeoutMs = positiveMs(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const healthTimeoutMs = positiveMs(
    options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    "healthTimeoutMs",
  );
  const mintCommandId = options.createCommandId ?? randomCommandId;
  /**
   * The command id a request carries: the caller's, or a minted one — checked
   * here, where the mistake is, rather than refused by the host as a 400.
   */
  const commandIdFor = (given: string | undefined): string =>
    given === undefined
      ? checkedCommandId(mintCommandId(), "createCommandId() must return")
      : checkedCommandId(given, "commandId must be");
  const sessionPath = (sessionId: string) =>
    `/v0/execution/sessions/${encodeURIComponent(sessionId)}`;

  /**
   * One request, within a deadline that covers reading the body too, handed to
   * `read` with the response. Only what `fetch` and the body throw becomes a
   * transport `ExecutionHostError` — a listener's mistake, or this client's,
   * is not a failure to reach the host. A caller's abort is rethrown as it
   * came.
   */
  const request = async <T>(
    operation: string,
    path: string,
    init: {
      method: "GET" | "POST" | "PATCH" | "DELETE";
      body?: string;
      authenticated: boolean;
      timeoutMs: number;
      signal: AbortSignal | undefined;
    },
    read: (
      response: Response,
      body: { json(): Promise<unknown> },
    ) => Promise<T>,
  ): Promise<T> => {
    const timeoutMs = positiveMs(init.timeoutMs, "timeoutMs");
    const deadline = startDeadline(init.signal, timeoutMs);
    const transport = (error: unknown) =>
      failureOf(error, {
        operation,
        deadline,
        callerSignal: init.signal,
        timeoutReason: `no answer within ${seconds(timeoutMs)}`,
        scrub: connection.scrub,
      });
    try {
      let response: Response;
      try {
        response = await connection.fetch(joinUrl(baseUrl, path), {
          method: init.method,
          headers: {
            Accept: "application/json",
            ...(init.authenticated
              ? { Authorization: `Bearer ${connection.token}` }
              : {}),
            ...(init.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: deadline.signal,
          // A redirect would carry the token wherever it points, and a 302
          // turns a POST into a GET: a host that moved is a configuration fix.
          redirect: "error",
        });
      } catch (error) {
        throw transport(error);
      }
      const json = async (): Promise<unknown> => {
        let text: string;
        try {
          text = await response.text();
        } catch (error) {
          throw transport(error);
        }
        try {
          return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
        } catch {
          throw new ExecutionHostError("malformed", "the answer is not JSON", {
            operation,
            status: response.status,
          });
        }
      };
      return await read(response, { json });
    } finally {
      deadline.dispose();
    }
  };

  const refusal = async (operation: string, response: Response) =>
    new ExecutionHostError(
      kindOfStatus(response.status),
      await reasonOf(response, connection.scrub),
      {
        operation,
        status: response.status,
      },
    );

  const health = (requestOptions: ExecutionRequestOptions = {}) =>
    request(
      "health",
      "/health",
      {
        method: "GET",
        authenticated: false,
        timeoutMs: requestOptions.timeoutMs ?? healthTimeoutMs,
        signal: requestOptions.signal,
      },
      async (response, body) => {
        if (!response.ok) throw await refusal("health", response);
        const parsed = parseExecutionHostHealth(await body.json());
        if (parsed === null) {
          throw new ExecutionHostError(
            "malformed",
            "/health does not look like an execution host's",
            { operation: "health", status: response.status },
          );
        }
        return parsed;
      },
    );

  const probeMeta = async (
    requestOptions: ExecutionRequestOptions,
  ): Promise<ExecutionHostMetaProbe> => {
    if (connection.token === "") return { kind: "no-token" };
    try {
      return await request(
        "meta",
        "/v0/meta",
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? healthTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response) => {
          await response.body?.cancel().catch(() => {});
          return response.ok
            ? { kind: "ok" as const }
            : { kind: "http" as const, status: response.status };
        },
      );
    } catch (error) {
      if (requestOptions.signal?.aborted) throw error;
      return {
        kind: "network-error",
        message:
          error instanceof ExecutionHostError ? error.reason : String(error),
      };
    }
  };

  return {
    baseUrl,

    health,

    handshake: async (requestOptions = {}) => {
      let parsed: ExecutionHostHealth | null = null;
      let failure: string | null = null;
      try {
        parsed = await health(requestOptions);
      } catch (error) {
        if (requestOptions.signal?.aborted) throw error;
        failure = connection.scrub(
          error instanceof ExecutionHostError ? error.message : String(error),
        );
      }
      const meta: ExecutionHostMetaProbe =
        parsed === null
          ? { kind: "no-token" }
          : await probeMeta(requestOptions);
      return evaluateExecutionHostHandshake(parsed, failure, meta);
    },

    projects: (requestOptions = {}) =>
      request(
        "projects",
        "/v0/projects",
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body) => {
          if (!response.ok) throw await refusal("projects", response);
          const decoded = decodeExecutionProjectListResponse(await body.json());
          if (!decoded.ok) {
            throw new ExecutionHostError("malformed", decoded.reason, {
              operation: "projects",
              status: response.status,
            });
          }
          return decoded.value.projects;
        },
      ),

    providers: (requestOptions = {}) =>
      request(
        "providers",
        "/v0/providers",
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? healthTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body) => {
          if (!response.ok) throw await refusal("providers", response);
          const decoded = decodeExecutionProviderListResponse(
            await body.json(),
          );
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              `the catalogue is unreadable (${decoded.reason})`,
              { operation: "providers", status: response.status },
            );
          }
          return decoded.value.providers;
        },
      ),

    start: async (startRequest, requestOptions = {}) => {
      const commandId = commandIdFor(startRequest.commandId);
      const sessionId = startRequest.config.sessionId;
      return request(
        "start",
        "/v0/execution/sessions",
        {
          method: "POST",
          body: encodeExecutionStartRequest({ ...startRequest, commandId }),
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body): Promise<ExecutionStartResult> => {
          if (response.status === 409) {
            await response.body?.cancel().catch(() => {});
            return { status: "exists", sessionId, commandId };
          }
          if (!response.ok) throw await refusal("start", response);
          const echo = await body.json();
          const echoed = isRecord(echo) ? echo.sessionId : undefined;
          // An answer about another session is not an answer about this one,
          // and filing it here would describe this session with another's
          // workspace (Convergence MAR-2694).
          if (echoed !== sessionId) {
            throw new ExecutionHostError(
              "malformed",
              typeof echoed === "string"
                ? `the host answered about session ${echoed}, not ${sessionId}`
                : "the answer names no session",
              { operation: "start", status: response.status },
            );
          }
          let workspace: ExecutionSessionWorkspace | null = null;
          const raw = isRecord(echo) ? echo.workspace : undefined;
          if (raw !== undefined && raw !== null) {
            const decoded = decodeExecutionSessionWorkspace(raw);
            if (decoded.ok) workspace = decoded.value;
            else {
              // The session is running either way; an echo this build cannot
              // read degrades to "not reported", out loud.
              notify(options.onWarnings, {
                operation: "start",
                sessionId,
                warnings: [
                  { reason: "dropped-invalid-field", path: "workspace" },
                ],
              });
            }
          }
          return { status: "started", sessionId, commandId, workspace };
        },
      );
    },

    command: async (sessionId, command, commandOptions = {}) => {
      const commandId = commandIdFor(commandOptions.commandId);
      const envelope: ExecutionHostCommandEnvelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId,
        commandId,
        ...(commandOptions.actor ? { actor: commandOptions.actor } : {}),
        command,
      };
      const operation = `command ${command.kind}`;
      return request(
        operation,
        `${sessionPath(sessionId)}/commands`,
        {
          method: "POST",
          body: encodeExecutionCommandEnvelope(envelope),
          authenticated: true,
          timeoutMs: commandOptions.timeoutMs ?? requestTimeoutMs,
          signal: commandOptions.signal,
        },
        async (response): Promise<ExecutionCommandResult> => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return { status: "no-session", commandId };
          }
          if (!response.ok) throw await refusal(operation, response);
          await response.body?.cancel().catch(() => {});
          return { status: "accepted", commandId };
        },
      );
    },

    patchSession: async (sessionId, patch, requestOptions = {}) => {
      const body = encodeExecutionSessionPatchRequest(patch);
      // Checked here, where the mistake is, rather than refused by the host.
      if (!decodeExecutionSessionPatchRequest(body).ok) {
        throw new TypeError(
          "A session patch names at least one of title, model and effort, and nothing else: model and effort are null or an id of 1 to 256 characters, title null or a string",
        );
      }
      return request(
        "patch session",
        sessionPath(sessionId),
        {
          method: "PATCH",
          body,
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, answer): Promise<ExecutionSessionPatchResult> => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return { status: "no-session", sessionId };
          }
          if (!response.ok) throw await refusal("patch session", response);
          const decoded = decodeExecutionSessionPatchResponse(
            await answer.json(),
          );
          if (!decoded.ok || decoded.value.sessionId !== sessionId) {
            throw new ExecutionHostError(
              "malformed",
              decoded.ok
                ? `the host answered about session ${decoded.value.sessionId}, not ${sessionId}`
                : `the answer is unreadable (${decoded.reason})`,
              { operation: "patch session", status: response.status },
            );
          }
          const { protocolVersion: _version, ...held } = decoded.value;
          return { status: "patched", ...held };
        },
      );
    },

    deleteSession: (sessionId, requestOptions = {}) =>
      request(
        "delete session",
        sessionPath(sessionId),
        {
          method: "DELETE",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response): Promise<ExecutionDeleteSessionResult> => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return { status: "no-session", sessionId };
          }
          if (!response.ok) throw await refusal("delete session", response);
          await response.body?.cancel().catch(() => {});
          return { status: "deleted", sessionId };
        },
      ),

    snapshot: (sessionId, requestOptions = {}) =>
      request(
        "snapshot",
        sessionPath(sessionId),
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body) => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return null;
          }
          if (!response.ok) throw await refusal("snapshot", response);
          const decoded = decodeExecutionSessionSnapshot(
            await body.json(),
            sessionId,
          );
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              `the snapshot is unreadable (${decoded.reason})`,
              { operation: "snapshot", status: response.status },
            );
          }
          if (decoded.warnings?.length) {
            notify(options.onWarnings, {
              operation: "snapshot",
              sessionId,
              warnings: decoded.warnings,
            });
          }
          return decoded.value;
        },
      ),

    events: (sessionId, streamOptions) =>
      streamSessionEvents(connection, sessionId, streamOptions),

    followSession: (sessionId, followOptions) =>
      followExecutionSession(
        (afterSeq, open) =>
          streamSessionEvents(connection, sessionId, { afterSeq, ...open }),
        sessionId,
        followOptions,
      ),
  };
}

/** The bound the protocol puts on a command id (MAR-3633). */
const COMMAND_ID_MAX_LENGTH = 256;

function checkedCommandId(commandId: unknown, rule: string): string {
  if (
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    commandId.length > COMMAND_ID_MAX_LENGTH
  ) {
    throw new TypeError(
      `${rule} a non-empty string of at most ${COMMAND_ID_MAX_LENGTH} characters`,
    );
  }
  return commandId;
}

function randomCommandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  // Unique within a session is all a command id needs to be.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
