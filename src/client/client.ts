import {
  decodeExecutionProjectListResponse,
  decodeExecutionSessionWorkspace,
  encodeExecutionCommandEnvelope,
  encodeExecutionStartRequest,
} from "../codecs.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionActor,
  type ExecutionDecodeWarning,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionProject,
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
  reasonOf,
  seconds,
  startDeadline,
} from "./http.js";
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
  /** The session as the host has it now, or null when it has none by that id. */
  snapshot(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionSnapshot | null>;
  /**
   * One connection to the session's event stream, decoded but not sequenced.
   * Most readers want `followSession`.
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
  const connection: HostConnection = {
    baseUrl,
    token: options.token,
    // Called bare, never as a method of the options object.
    fetch: (input, init) => fetchFn(input, init),
  };
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const createCommandId = options.createCommandId ?? randomCommandId;
  const sessionPath = (sessionId: string) =>
    `/v0/execution/sessions/${encodeURIComponent(sessionId)}`;

  /**
   * One request, within a deadline that covers reading the body too, handed to
   * `read` with the response. Failures on the way become `ExecutionHostError`;
   * a caller's abort is rethrown as it came.
   */
  const request = async <T>(
    operation: string,
    path: string,
    init: {
      method: "GET" | "POST";
      body?: string;
      authenticated: boolean;
      timeoutMs: number;
      signal: AbortSignal | undefined;
    },
    read: (response: Response) => Promise<T>,
  ): Promise<T> => {
    const deadline = startDeadline(init.signal, init.timeoutMs);
    try {
      const response = await connection.fetch(joinUrl(baseUrl, path), {
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
      });
      return await read(response);
    } catch (error) {
      throw failureOf(error, {
        operation,
        deadline,
        callerSignal: init.signal,
        timeoutReason: `no answer within ${seconds(init.timeoutMs)}`,
      });
    } finally {
      deadline.dispose();
    }
  };

  const refusal = async (operation: string, response: Response) =>
    new ExecutionHostError(
      kindOfStatus(response.status),
      await reasonOf(response),
      {
        operation,
        status: response.status,
      },
    );

  const json = async (
    operation: string,
    response: Response,
  ): Promise<unknown> => {
    const text = await response.text();
    try {
      return text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch (error) {
      throw new ExecutionHostError("malformed", "the answer is not JSON", {
        operation,
        status: response.status,
        cause: error,
      });
    }
  };

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
      async (response) => {
        if (!response.ok) throw await refusal("health", response);
        const parsed = parseExecutionHostHealth(await json("health", response));
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
    if (connection.token.trim() === "") return { kind: "no-token" };
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
        failure =
          error instanceof ExecutionHostError ? error.message : String(error);
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
        async (response) => {
          if (!response.ok) throw await refusal("projects", response);
          const decoded = decodeExecutionProjectListResponse(
            await json("projects", response),
          );
          if (!decoded.ok) {
            throw new ExecutionHostError("malformed", decoded.reason, {
              operation: "projects",
              status: response.status,
            });
          }
          return decoded.value.projects;
        },
      ),

    start: (startRequest, requestOptions = {}) => {
      const commandId = startRequest.commandId ?? createCommandId();
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
        async (response): Promise<ExecutionStartResult> => {
          if (response.status === 409) {
            await response.body?.cancel().catch(() => {});
            return { status: "exists", sessionId, commandId };
          }
          if (!response.ok) throw await refusal("start", response);
          const body = await json("start", response);
          const echoed = isRecord(body) ? body.sessionId : undefined;
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
          const raw = isRecord(body) ? body.workspace : undefined;
          if (raw !== undefined && raw !== null) {
            const decoded = decodeExecutionSessionWorkspace(raw);
            if (decoded.ok) workspace = decoded.value;
            else {
              // The session is running either way; an echo this build cannot
              // read degrades to "not reported", out loud.
              options.onWarnings?.({
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

    command: (sessionId, command, commandOptions = {}) => {
      const commandId = commandOptions.commandId ?? createCommandId();
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
        async (response) => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return null;
          }
          if (!response.ok) throw await refusal("snapshot", response);
          const decoded = decodeExecutionSessionSnapshot(
            await json("snapshot", response),
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
            options.onWarnings?.({
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
