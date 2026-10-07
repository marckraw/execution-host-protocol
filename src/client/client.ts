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
import { checkExecutionInlineAttachments } from "../attachments.js";
import { isStringArray } from "../guards.js";
import {
  confirmsExecutionStartRequirements,
  decodeExecutionHostProfile,
  decodeExecutionStartRequirementsRefusal,
} from "../host-profile.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionActor,
  type ExecutionDecodeWarning,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostProfile,
  type ExecutionProject,
  type ExecutionProvider,
  type ExecutionSessionPatchRequest,
  type ExecutionSessionWorkspace,
  type ExecutionStartRequest,
} from "../types.js";
import {
  hostTakesInlineFiles,
  inlineAttachmentsRefusal,
  inlineFilesRefusal,
  withoutHostWords,
} from "./attachments.js";
import {
  followExecutionSession,
  type ExecutionFollowOptions,
  type ExecutionSessionFollow,
} from "./follow.js";
import {
  evaluateExecutionHostHandshake,
  hostEnforcesStartRequirements,
  parseExecutionHostHealth,
  type ExecutionHostHandshake,
  type ExecutionHostHealth,
  type ExecutionHostMetaProbe,
} from "./health.js";
import {
  ExecutionHostError,
  boundedReason,
  ExecutionStartRequirementsError,
  failureOf,
  joinUrl,
  kindOfStatus,
  positiveMs,
  reasonOf,
  reasonOfText,
  refusalText,
  scrubberFor,
  seconds,
  startDeadline,
  usableToken,
} from "./http.js";
import { notify } from "./listeners.js";
import {
  ExecutionOneShotError,
  ONESHOT_ANSWER_MAX_BYTES,
  ONESHOT_REFUSAL_MAX_BYTES,
  oneShotFailure,
  oneShotRefusal,
  oneShotUnreachable,
  prepareOneShot,
  readAtMost,
  readOneShotAnswer,
  type ExecutionOneShotOptions,
  type ExecutionOneShotResult,
} from "./oneshot.js";
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
   * Hears what a start echo, a snapshot or a host profile had to drop to be
   * read, so a drop is never silent. Envelopes' own warnings reach
   * `followSession`'s `onEnvelope`.
   */
  onWarnings?(notice: ExecutionWarningsNotice): void;
}

/**
 * What a read had to drop. A host profile belongs to no session, so its
 * notice's `sessionId` is null (MAR-3725).
 */
export type ExecutionWarningsNotice =
  | {
      operation: "start" | "snapshot";
      sessionId: string;
      warnings: ExecutionDecodeWarning[];
    }
  | { operation: "host"; sessionId: null; warnings: ExecutionDecodeWarning[] };

export interface ExecutionRequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's timeout for this request. */
  timeoutMs?: number;
}

/**
 * A host profile and what had to be dropped to read it (MAR-3725). A profile
 * with warnings under-claims: a host whose Xcode entry was unreadable may
 * have Xcode, so a caller treats a warned absence as unknown, not as none.
 */
export interface ExecutionHostProfileReading {
  profile: ExecutionHostProfile;
  warnings: ExecutionDecodeWarning[];
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
  /**
   * Authenticated `GET /v0/host`: identity, traits and device inventory
   * (`host.profile.v1`, MAR-3699). Uses the health timeout. An older host's
   * 404 is an `ExecutionHostError`, not an empty profile. An unreadable
   * inventory entry is dropped, returned in `warnings` and told to the
   * client's `onWarnings`; an unreadable identity or platform is `malformed`,
   * naming the field (MAR-3725).
   */
  host(options?: ExecutionRequestOptions): Promise<ExecutionHostProfileReading>;
  /** The Projects the host advertises (`GET /v0/projects`). */
  projects(options?: ExecutionRequestOptions): Promise<ExecutionProject[]>;
  /**
   * The providers the host serves, with the models and efforts each offers
   * (`GET /v0/providers`): the catalogue a session's model and effort are
   * checked against. Takes the health timeout, not the request one — it is a
   * read of what the host already knows.
   */
  providers(options?: ExecutionRequestOptions): Promise<ExecutionProvider[]>;
  /**
   * Starts a session with its first turn. The request's `commandId` is minted
   * when absent. A start that `requires` traits first reads `/health`
   * (within the health timeout, or the caller's when shorter), and is refused
   * here, unsent, with an `ExecutionStartRequirementsError` when the host
   * does not advertise `start.requires.v1`. The host's own 400 coded
   * `requirements-unmet`, and a 201 that does not echo the traits, are the
   * same error (MAR-3725). A failed probe is its `ExecutionHostError`, with
   * operation `health`. Without `requires`, nothing changes: one request.
   * `config.inlineAttachments` are checked as `command()` checks them, and a
   * start carrying a file reads the same one `/health` (MAR-3783).
   */
  start(
    request: ExecutionStartRequest,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionStartResult>;
  /**
   * Sends a session a command, saying who sent it. A `send-message` whose
   * `inlineAttachments` are past the limits, or malformed, throws an
   * `ExecutionInlineAttachmentsError` before anything is sent. One carrying a
   * `kind: "file"` entry first reads `/health` (as a start with `requires`
   * does), and is refused here, unsent, with code `files-unsupported` when
   * the host does not advertise `attachments.inline-file.v1`; its failures
   * then carry the client's words only, never the host's or a file's
   * (MAR-3783). Images only, or none: one request, as before.
   */
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
  /**
   * One tool-less answer to one prompt from one of the host's providers
   * (`POST /v0/oneshot`, `oneshot.v1`, MAR-3775): no workspace, no session,
   * nothing kept. A request the protocol would refuse throws a `TypeError`
   * before anything is sent. Then it reads `/health` (the health timeout; a
   * failed probe is its `ExecutionHostError`, operation `health`), and a host
   * that does not advertise `oneshot.v1` is refused here, unsent, as
   * `ExecutionOneShotError` code `unsupported`. The body always carries
   * `contract: "oneshot.v1"`, which a host released before the id refuses
   * whatever its `/health` said. Every refusal is an `ExecutionOneShotError`
   * too; only a host that cannot be reached is an `ExecutionHostError`, in the
   * client's own words. No error carries the prompt, the answer or the token.
   */
  oneShot(options: ExecutionOneShotOptions): Promise<ExecutionOneShotResult>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;

/**
 * A client for one execution host — agents-daemon's HTTP API — in plain
 * JavaScript with no dependencies beyond the protocol it ships with, so it
 * loads anywhere `fetch` does: Node 20+, Bun, browsers, Electron, React Native.
 * Facade: typed host operations share one transport and refusal boundary.
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
      body: {
        json(): Promise<unknown>;
        /** The body, or null when it is longer than `maxBytes`. */
        atMost(maxBytes: number): Promise<string | null>;
      },
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
      const atMost = async (maxBytes: number): Promise<string | null> => {
        try {
          return await readAtMost(response, maxBytes);
        } catch (error) {
          throw transport(error);
        }
      };
      return await read(response, { json, atMost });
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

  const deleteSession = (
    sessionId: string,
    requestOptions: ExecutionRequestOptions = {},
  ): Promise<ExecutionDeleteSessionResult> =>
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
    );

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

    host: (requestOptions = {}) =>
      request(
        "host",
        "/v0/host",
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? healthTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body) => {
          if (!response.ok) throw await refusal("host", response);
          const decoded = decodeExecutionHostProfile(await body.json());
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              decoded.path === undefined
                ? decoded.reason
                : `${decoded.reason} at ${decoded.path}`,
              { operation: "host", status: response.status },
            );
          }
          const warnings = decoded.warnings ?? [];
          if (warnings.length > 0) {
            notify(options.onWarnings, {
              operation: "host",
              sessionId: null,
              warnings,
            });
          }
          return { profile: decoded.value, warnings };
        },
      ),

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
      const requires: unknown = startRequest.requires ?? [];
      // Checked here, where the mistake is: a host would refuse it, and one
      // predating `requires` would ignore it.
      if (!isStringArray(requires)) {
        throw new TypeError("requires must be an array of non-empty trait ids");
      }
      const withFiles = carriesFiles(
        "start",
        startRequest.config.inlineAttachments,
      );
      const told = (error: unknown): never => {
        throw withFiles ? withoutHostWords(error) : error;
      };
      // A host that predates `requires` drops it and starts anyway, so the
      // only safe place to refuse is here, before it is sent (MAR-3725).
      if (requires.length > 0 || withFiles) {
        const probed = await health({
          signal: requestOptions.signal,
          timeoutMs: Math.min(
            healthTimeoutMs,
            requestOptions.timeoutMs ?? healthTimeoutMs,
          ),
        });
        if (withFiles && !hostTakesInlineFiles(probed)) {
          throw inlineFilesRefusal("start", probed);
        }
        if (requires.length > 0 && !hostEnforcesStartRequirements(probed)) {
          throw new ExecutionStartRequirementsError(
            "requirements-unenforced",
            probed.executionProtocolValid
              ? `the host does not advertise start.requires.v1, so it could start without ${requires.join(", ")}; nothing was sent`
              : `the host's protocol descriptor is unreadable, so it cannot be trusted to check ${requires.join(", ")}; nothing was sent`,
            { requires },
          );
        }
      }
      const answer = await request(
        "start",
        "/v0/execution/sessions",
        {
          method: "POST",
          body: encodeExecutionStartRequest({ ...startRequest, commandId }),
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (
          response,
          body,
        ): Promise<
          ExecutionStartResult | { status: "unconfirmed"; httpStatus: number }
        > => {
          if (response.status === 409) {
            if (requires.length === 0) {
              await response.body?.cancel().catch(() => {});
              return { status: "exists", sessionId, commandId };
            }
            // The session is older than this request: what it was checked
            // against is the host's echo on the 409, or nothing (MAR-3725).
            const existing = parseOrNull(await refusalText(response));
            if (!confirmsExecutionStartRequirements(existing, requires)) {
              throw new ExecutionStartRequirementsError(
                "requirements-unconfirmed",
                `the host already has session ${sessionId}, and does not echo that it was checked for ${requires.join(", ")}; it was left running`,
                { requires, status: 409, sessionId, sessionDeleted: null },
              );
            }
            return { status: "exists", sessionId, commandId };
          }
          if (!response.ok) {
            const text = await refusalText(response);
            const reason = reasonOfText(
              text,
              response.status,
              connection.scrub,
            );
            // The code is honoured where the protocol puts it: on a 400.
            const unmet =
              response.status === 400
                ? decodeExecutionStartRequirementsRefusal(parseOrNull(text))
                : null;
            if (unmet?.ok) {
              // Only traits this start asked for: the host's list is its
              // words, unscrubbed and unbounded, and may name anything.
              const missingTraits = requires.filter((trait) =>
                unmet.value.missingTraits.includes(trait),
              );
              throw new ExecutionStartRequirementsError(
                "requirements-unmet",
                boundedReason(unmet.value.error, connection.scrub),
                {
                  requires,
                  missingTraits:
                    missingTraits.length > 0 ? missingTraits : null,
                  status: response.status,
                },
              );
            }
            throw new ExecutionHostError(
              kindOfStatus(response.status),
              reason,
              {
                operation: "start",
                status: response.status,
              },
            );
          }
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
          if (
            requires.length > 0 &&
            !confirmsExecutionStartRequirements(echo, requires)
          ) {
            return { status: "unconfirmed", httpStatus: response.status };
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
      ).catch(told);
      if (answer.status !== "unconfirmed") return answer;
      // This request created the session, so deleting it loses nothing
      // older; left running, it would hold a host's place for its turn.
      // Best effort, and outside the caller's signal: cleanup is not the
      // caller's to cancel (MAR-3725).
      const sessionDeleted = await deleteSession(sessionId, {
        timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
      }).then(
        () => true,
        () => false,
      );
      throw new ExecutionStartRequirementsError(
        "requirements-unconfirmed",
        `the host started session ${sessionId} without echoing that it checked ${requires.join(", ")}; ${sessionDeleted ? "it was deleted" : "deleting it failed, so it may still be running"}`,
        { requires, status: answer.httpStatus, sessionId, sessionDeleted },
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
      const withFiles =
        command.kind === "send-message" &&
        carriesFiles(operation, command.inlineAttachments);
      // A host that predates files refuses the whole command, text and all,
      // so the only safe place to refuse is here, before it is sent.
      if (withFiles) {
        const probed = await health({
          signal: commandOptions.signal,
          timeoutMs: Math.min(
            healthTimeoutMs,
            commandOptions.timeoutMs ?? healthTimeoutMs,
          ),
        });
        if (!hostTakesInlineFiles(probed)) {
          throw inlineFilesRefusal(operation, probed);
        }
      }
      const told = (error: unknown): never => {
        throw withFiles ? withoutHostWords(error) : error;
      };
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
      ).catch(told);
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

    deleteSession,

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

    oneShot: async (oneShotOptions) => {
      // Every option read once, here, before anything is awaited.
      const {
        body,
        deadlineMs: timeoutMs,
        signal,
      } = prepareOneShot(oneShotOptions);
      // A host that serves the route without advertising `oneshot.v1` has
      // not promised to run the prompt as nothing more than a prompt, so the
      // only safe place to refuse is here, before it is sent (MAR-3775).
      const probed = await health({ signal, timeoutMs: healthTimeoutMs });
      if (!probed.capabilities.includes("oneshot.v1")) {
        throw new ExecutionOneShotError(
          "unsupported",
          probed.executionProtocolValid
            ? "the host does not advertise oneshot.v1; nothing was sent"
            : "the host's protocol descriptor is unreadable, so it cannot be trusted with oneshot.v1; nothing was sent",
          { sent: false },
        );
      }
      try {
        return await request(
          "oneshot",
          "/v0/oneshot",
          {
            method: "POST",
            body,
            authenticated: true,
            timeoutMs,
            signal,
          },
          async (response, answer): Promise<ExecutionOneShotResult> => {
            if (!response.ok) {
              // An unreadable refusal still has a status; a caller's abort
              // is still theirs.
              const refusal = await answer
                .atMost(ONESHOT_REFUSAL_MAX_BYTES)
                .catch((error: unknown) => {
                  if (signal?.aborted) throw error;
                  return null;
                });
              throw oneShotRefusal(response.status, refusal ?? "");
            }
            const text = await answer.atMost(ONESHOT_ANSWER_MAX_BYTES);
            if (text === null) {
              throw oneShotFailure(
                "malformed",
                response.status,
                `it is longer than ${ONESHOT_ANSWER_MAX_BYTES} bytes`,
              );
            }
            const decoded = readOneShotAnswer(text);
            if (decoded === null) {
              throw oneShotFailure(
                "malformed",
                response.status,
                "it has no text, or text longer than 65536 characters",
              );
            }
            return decoded;
          },
        );
      } catch (error) {
        // The client's deadline is the host's timeout plus its grace: either
        // way the provider did not answer in time.
        if (
          error instanceof ExecutionHostError &&
          error.kind === "timeout" &&
          !signal?.aborted
        ) {
          throw oneShotFailure(
            "timed-out",
            null,
            `no answer within ${seconds(timeoutMs)}`,
          );
        }
        if (
          error instanceof ExecutionHostError &&
          error.kind === "network" &&
          !signal?.aborted
        ) {
          throw oneShotUnreachable();
        }
        throw error;
      }
    },
  };
}

/**
 * Whether a request's inline attachments hold a file, once ones the host
 * would refuse are refused here, unsent (MAR-3783).
 */
function carriesFiles(operation: string, attachments: unknown): boolean {
  const checked = checkExecutionInlineAttachments(attachments);
  if (!checked.ok) throw inlineAttachmentsRefusal(operation, checked);
  return checked.files > 0;
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

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
