import {
  ExecutionStartSelectionError,
  hostTakesSelections,
} from "./selections.js";
import { isExecutionInstructions } from "../instructions.js";
import {
  ExecutionStartInstructionsError,
  hostTakesInstructions,
} from "./instructions.js";
import { isExecutionSelectionNames } from "../selections.js";
import {
  decodeExecutionProjectListResponse,
  decodeExecutionProviderListResponse,
  decodeExecutionSessionPatchRefusal,
  decodeExecutionSessionPatchRequest,
  decodeExecutionSessionPatchResponse,
  decodeExecutionSessionWorkspace,
  encodeExecutionCommandEnvelope,
  encodeExecutionSessionPatchRequest,
  encodeExecutionStartRequest,
} from "../codecs.js";
import { checkExecutionInlineAttachments } from "../attachments.js";
import {
  confirmsExecutionFileReach,
  decodeExecutionFileReachRefusal,
  isExecutionFileReach,
  type ExecutionFileReach,
  type ExecutionFileReachEcho,
} from "../file-reach.js";
import { isStringArray } from "../guards.js";
import {
  confirmsExecutionStartRequirements,
  decodeExecutionHostProfile,
  decodeExecutionStartRequirementsRefusal,
} from "../host-profile.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_PATCH_REFUSAL_STATUS,
  type ExecutionActor,
  type ExecutionDecodeWarning,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostProfile,
  type ExecutionPermissionConfig,
  type ExecutionProject,
  type ExecutionProvider,
  type ExecutionSessionPatchAppliesFrom,
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
  hostTakesStructuredInteractions,
  interactionResponseRefusal,
} from "./interactions.js";
import {
  ExecutionSessionPatchError,
  hostTakesPermissionModes,
  permissionModesRefusal,
} from "./session-patch.js";
import {
  followExecutionSession,
  type ExecutionFollowOptions,
  type ExecutionSessionFollow,
} from "./follow.js";
import {
  evaluateExecutionHostHandshake,
  hostEnforcesFileReach,
  hostEnforcesStartRequirements,
  parseExecutionHostHealth,
  type ExecutionHostHandshake,
  type ExecutionHostHealth,
  type ExecutionHostMetaProbe,
} from "./health.js";
import {
  ExecutionHostError,
  boundedReason,
  ExecutionStartFileReachError,
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
  attachmentByteLimit,
  attachmentDownloadFailure,
  attachmentPathId,
  cancelAttachmentBody,
  readAttachmentBytes,
  type ExecutionAttachmentDownloadKind,
  type ExecutionAttachmentDownloadResult,
} from "./attachment-download.js";
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
  prepareTaskOutput,
  readTaskOutputAnswer,
  TASK_OUTPUT_ANSWER_MAX_BYTES,
  TASK_OUTPUT_REFUSAL_MAX_BYTES,
  taskOutputRefusal,
  type ExecutionTaskOutputOptions,
  type ExecutionTaskOutputResult,
} from "./task-output.js";
import type { ExecutionHostApi } from "./api.js";
import {
  decodeExecutionSessionChanges,
  type ExecutionSessionChangesResult,
} from "./session-changes.js";
import {
  decodeExecutionTurnUsagePage,
  encodeExecutionTurnUsageQuery,
  type ExecutionTurnUsagePage,
  type ExecutionTurnUsageQuery,
} from "../turn-usage.js";
import {
  decodeExecutionSessionList,
  encodeExecutionSessionListQuery,
  type ExecutionSessionList,
  type ExecutionSessionListQuery,
} from "./session-list.js";
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

export interface ExecutionAttachmentDownloadOptions extends ExecutionRequestOptions {
  /**
   * What the attachment is, which sets the ceiling (MAR-3973): `tool` (the
   * default), an image on a tool result, 8 MiB; `inline`, an image or file
   * sent with a message, 10 MiB. The caller's word, not checked: a host serves
   * both from one route. Pass `inline` only for an attachment on a message,
   * never for a tool-result item's `attachments` (`items.toolAttachments.v1`);
   * a tool image over 8 MiB is refused only when labelled a tool.
   */
  kind?: ExecutionAttachmentDownloadKind;
  /**
   * Defaults to the kind's ceiling; a positive whole number no greater than
   * it.
   */
  maxBytes?: number;
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
/**
 * `fileReach` is present for a start that carried one (MAR-4352): what the
 * host echoed it holds the session to, already checked against what was
 * asked, with the ABI it fences with.
 */
export type ExecutionStartResult =
  | {
      status: "started";
      sessionId: string;
      commandId: string;
      workspace: ExecutionSessionWorkspace | null;
      fileReach?: NonNullable<ExecutionFileReachEcho["fileReach"]>;
    }
  | {
      status: "exists";
      sessionId: string;
      commandId: string;
      fileReach?: NonNullable<ExecutionFileReachEcho["fileReach"]>;
    };

/** `no-session` — the host has no session by that id (404). */
export interface ExecutionCommandResult {
  status: "accepted" | "no-session";
  commandId: string;
}

/**
 * `patched` — the host took the patch, and says what it holds now: the title
 * as stored when the patch named one, the model and effort the session's
 * next turn runs on when it named either (MAR-3662), and the permission policy
 * it runs under when it named one, with when that applies (MAR-4052).
 * `no-session` — the host has no session by that id (404). A coded refusal is
 * an `ExecutionSessionPatchError`.
 */
export type ExecutionSessionPatchResult =
  | {
      status: "patched";
      sessionId: string;
      title?: string | null;
      model?: string | null;
      effort?: string | null;
      permissionConfig?: ExecutionPermissionConfig;
      appliesFrom?: ExecutionSessionPatchAppliesFrom;
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

/**
 * The HTTP carrier of an `ExecutionHostApi` (MAR-4862), and what only a host
 * on the network has besides: health, the handshake, its profile, teardown,
 * one-shots and the raw event stream.
 */
export interface ExecutionHostClient extends ExecutionHostApi {
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
   * A start carrying `fileReach` reads the same one `/health` too, and is
   * refused here, unsent, with an `ExecutionStartFileReachError` coded
   * `file-reach-unenforced` when the host does not advertise
   * `start.fileReach.v1`. The host's 400 coded `file-reach-refused`, and a
   * 201 or 409 that does not echo exactly that reach, are the same error;
   * the unconfirmed session a 201 made is deleted (MAR-4352). A malformed
   * `fileReach` is a `TypeError`, unsent.
   * `config.instructions` is capped at 32 KiB UTF-8 (TypeError before probing).
   * When present, including an empty string, the same health probe must
   * advertise start.instructions.v1, or ExecutionStartInstructionsError
   * refuses it unsent with code instructions-unsupported (MAR-4364).
   * A capable host's 400 instructions-unsupported-provider is the same typed
   * error, with its distinct code and status 400. See providers().sessionInstructions.
   * Instructions are fixed at the first successful start. A 409 / exists
   * neither updates nor confirms them; use a fresh id to establish a frame.
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
   * (MAR-3783). One carrying `options.interactionResponse` reads the same
   * one `/health`, and is refused here, unsent, with an
   * `ExecutionInteractionResponseError` when the host does not advertise
   * `interactions.structured` (MAR-4002). Images only, or none, and no
   * `interactionResponse`: one request, as before.
   */
  command(
    sessionId: string,
    command: ExecutionHostCommand,
    options?: ExecutionCommandOptions,
  ): Promise<ExecutionCommandResult>;
  /**
   * Changes a session's settings (`PATCH /v0/execution/sessions/:id`): its
   * title, on a host advertising `sessions.modelSelection.v1` the model
   * and effort its turns run on from the next one (MAR-3662), and its
   * permission policy on a host advertising `sessions.permissionModes.v1`
   * (MAR-4052). A patch the protocol would refuse throws a `TypeError` before
   * anything is sent. A `permissionConfig` for a host without the capability
   * costs one `/health` and throws an `ExecutionSessionPatchError` coded
   * `unsupported-on-host`, unsent. The host's coded refusals are one too —
   * `turn-running` (409), `unsupported-on-host` and
   * `unsupported-for-provider` (400) — and any other refusal, such as a
   * selection its catalog does not offer, is an `ExecutionHostError` carrying
   * the host's reason.
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
   * One page of the sessions the host holds for this token
   * (`GET /v0/execution/sessions`), newest first: a client token sees the
   * sessions it owns, the operator's sees all. A query agents-daemon would
   * refuse is a `TypeError` or `RangeError`, unsent. Pass the page's
   * `nextCursor` as `cursor` for the next one. A session or field this build
   * cannot read is dropped and named in `warnings`; an unreadable page is
   * `malformed`.
   */
  listSessions(
    query?: ExecutionSessionListQuery,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionList>;
  /**
   * The session's changes across all its turns
   * (`GET .../changes?scope=combined`). It does not read `/health` first;
   * gate on `turns.fileChanges.combined` in its capabilities, since a host
   * without the route answers 404 too, which reads as `no-session`. 409 and
   * 410 are `unavailable`; any other refusal is an `ExecutionHostError`, and
   * an answer about another session `malformed`.
   */
  sessionChanges(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionChangesResult>;
  /**
   * One page of what the host's turns cost (`GET /v0/usage/turns`,
   * `turns.usage.v1`, MAR-4943), in the order it recorded them, oldest
   * first. `since` starts a read and `cursor` carries one on; a query naming
   * both, or one the protocol would refuse otherwise, is a `TypeError` or
   * `RangeError`, unsent. It does not read `/health` first: gate on
   * `hostRecordsTurnUsage(health)`, since a host without the route answers
   * 404, an `ExecutionHostError` of kind `not-found`. A record this build
   * cannot read is dropped and named in `warnings`; an unreadable page is
   * `malformed`.
   */
  listTurnUsage(
    query?: ExecutionTurnUsageQuery,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionTurnUsagePage>;
  /**
   * Authenticated GET of a session attachment, with both IDs encoded. Reads
   * at most the kind's ceiling — 8 MiB for a tool image (the default), 10 MiB
   * for an inline upload — or a smaller maxBytes, within the request deadline,
   * through injected fetch. Throws ExecutionHostError with fixed client reasons;
   * a caller's abort is rethrown. MIME and length claims are not validation.
   */
  downloadAttachment(
    sessionId: string,
    attachmentId: string,
    options?: ExecutionAttachmentDownloadOptions,
  ): Promise<ExecutionAttachmentDownloadResult>;
  /**
   * The end of one task's output (`GET .../tasks/:taskId/output?tail=`,
   * `tasks.output.v1`, MAR-3981): whole lines from at most the last `tail`
   * bytes of the file (default and most 65536), as host-redacted text, with
   * the task's status and where the window sits in the file. Names a task, never a file: an id the route cannot name
   * or an option it does not take is a `TypeError`, a `tail` out of bounds a
   * `RangeError`, before anything is sent. It does not read `/health` first;
   * gate on `hostReadsTaskOutput(health)`. Every refusal is an
   * `ExecutionTaskOutputError` with a code; a host without the route is
   * `unsupported`. Only a host that cannot be reached, or does not answer
   * within the health timeout, is an `ExecutionHostError`.
   */
  taskOutput(
    sessionId: string,
    taskId: string,
    options?: ExecutionTaskOutputOptions,
  ): Promise<ExecutionTaskOutputResult>;
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
   * Facade: JSON and bounded binary reads share one authenticated request.
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
      accept?: string;
      timeoutMs: number;
      signal: AbortSignal | undefined;
    },
    read: (
      response: Response,
      body: {
        json(): Promise<unknown>;
        /** The body, or null when it is longer than `maxBytes`. */
        atMost(maxBytes: number): Promise<string | null>;
        bytes(maxBytes: number): Promise<ExecutionAttachmentDownloadResult>;
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
            Accept: init.accept ?? "application/json",
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
      const bytes = async (
        maxBytes: number,
      ): Promise<ExecutionAttachmentDownloadResult> => {
        try {
          return await readAttachmentBytes(response, maxBytes, deadline.signal);
        } catch (error) {
          const failure = transport(error);
          deadline.close();
          throw failure;
        }
      };
      return await read(response, { json, atMost, bytes });
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
      const selections = [
        startRequest.config.mcpServers,
        startRequest.config.skills,
      ];
      for (const names of selections) {
        if (names !== undefined && !isExecutionSelectionNames(names))
          throw new TypeError(
            "Session selections must be bounded arrays of inventory names",
          );
      }
      const selected = selections.some((names) => names !== undefined);
      const commandId = commandIdFor(startRequest.commandId);
      const sessionId = startRequest.config.sessionId;
      const requires: unknown = startRequest.requires ?? [];
      // Checked here, where the mistake is: a host would refuse it, and one
      // predating `requires` would ignore it.
      if (!isStringArray(requires)) {
        throw new TypeError("requires must be an array of non-empty trait ids");
      }
      const fileReach: unknown = startRequest.fileReach;
      // Checked here, where the mistake is: a host would refuse it, and one
      // predating `fileReach` would start the session unfenced.
      if (fileReach !== undefined && !isExecutionFileReach(fileReach)) {
        throw new TypeError(
          "fileReach must be { entries } with at most 32 entries, each a path of 1 to 256 characters and an access of read or write",
        );
      }
      const reach = fileReach as ExecutionFileReach | undefined;
      const instructions: unknown = startRequest.config.instructions;
      if (
        instructions !== undefined &&
        !isExecutionInstructions(instructions)
      ) {
        throw new TypeError(
          "config.instructions must be a string of at most 32768 UTF-8 bytes",
        );
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
      if (
        requires.length > 0 ||
        withFiles ||
        reach ||
        instructions !== undefined ||
        selected
      ) {
        const probed = await health({
          signal: requestOptions.signal,
          timeoutMs: Math.min(
            healthTimeoutMs,
            requestOptions.timeoutMs ?? healthTimeoutMs,
          ),
        });
        if (instructions !== undefined && !hostTakesInstructions(probed)) {
          throw new ExecutionStartInstructionsError(
            "instructions-unsupported",
            probed.executionProtocolValid
              ? "the host does not advertise start.instructions.v1; nothing was sent"
              : "the host's protocol descriptor is unreadable; nothing was sent",
          );
        }
        if (selected && !hostTakesSelections(probed)) {
          throw new ExecutionStartSelectionError(
            "selection-unsupported",
            "The host does not advertise start.selections.v1; nothing was sent",
          );
        }
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
        if (reach && !hostEnforcesFileReach(probed)) {
          throw new ExecutionStartFileReachError(
            "file-reach-unenforced",
            probed.executionProtocolValid
              ? "the host does not advertise start.fileReach.v1, so it could start the session unfenced; nothing was sent"
              : "the host's protocol descriptor is unreadable, so it cannot be trusted to hold the session to its file reach; nothing was sent",
            { fileReach: reach },
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
          | ExecutionStartResult
          | {
              status: "unconfirmed";
              httpStatus: number;
              unconfirmed: "requires" | "fileReach";
              /** Why, in the client's words, where it isn't the echo. */
              why?: string;
            }
        > => {
          if (response.status === 409) {
            if (requires.length === 0 && !reach) {
              await response.body?.cancel().catch(() => {});
              return { status: "exists", sessionId, commandId };
            }
            // The session is older than this request: what it was checked
            // against is the host's echo on the 409, or nothing (MAR-3725).
            const existing = parseOrNull(await refusalText(response));
            if (
              requires.length > 0 &&
              !confirmsExecutionStartRequirements(existing, requires)
            ) {
              throw new ExecutionStartRequirementsError(
                "requirements-unconfirmed",
                `the host already has session ${sessionId}, and does not echo that it was checked for ${requires.join(", ")}; it was left running`,
                { requires, status: 409, sessionId, sessionDeleted: null },
              );
            }
            // Held to another reach, or to none, it is not this start's
            // session to adopt (MAR-4352).
            if (reach && !confirmsExecutionFileReach(existing, reach)) {
              throw new ExecutionStartFileReachError(
                "file-reach-unconfirmed",
                `the host already has session ${sessionId}, and does not echo that it holds it to this file reach; it was left running`,
                {
                  fileReach: reach,
                  status: 409,
                  sessionId,
                  sessionDeleted: null,
                },
              );
            }
            return {
              status: "exists",
              sessionId,
              commandId,
              ...(reach ? { fileReach: echoedFileReach(existing) } : {}),
            };
          }
          if (!response.ok) {
            const text = await refusalText(response);
            const refusal = parseOrNull(text);
            if (
              instructions !== undefined &&
              response.status === 400 &&
              isRecord(refusal) &&
              refusal.code === "instructions-unsupported-provider"
            ) {
              throw new ExecutionStartInstructionsError(
                "instructions-unsupported-provider",
                "the host cannot apply session instructions for this provider",
                400,
              );
            }
            const reason = reasonOfText(
              text,
              response.status,
              connection.scrub,
            );
            if (
              selected &&
              response.status === 400 &&
              isRecord(refusal) &&
              (refusal.code === "unknown-mcp-server" ||
                refusal.code === "unknown-skill" ||
                refusal.code === "selection-unsupported-provider")
            ) {
              throw new ExecutionStartSelectionError(
                refusal.code,
                refusal.reason === "mcpServers" || refusal.reason === "skills"
                  ? refusal.reason
                  : "The host refused the session selections",
                400,
              );
            }

            // The code is honoured where the protocol puts it: on a 400.
            const unmet =
              response.status === 400
                ? decodeExecutionStartRequirementsRefusal(refusal)
                : null;
            const reachRefused =
              response.status === 400 && reach
                ? decodeExecutionFileReachRefusal(refusal)
                : null;
            if (reachRefused?.ok && reach) {
              // Only problems about this reach: the host's indexes are its
              // words, and may point past it.
              const problems = reachRefused.value.problems.filter(
                (problem) =>
                  problem.entry === null ||
                  problem.entry < reach.entries.length,
              );
              throw new ExecutionStartFileReachError(
                "file-reach-refused",
                boundedReason(reachRefused.value.error, connection.scrub),
                {
                  fileReach: reach,
                  problems: problems.length > 0 ? problems : null,
                  status: response.status,
                },
              );
            }
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
          // A 2xx to a start carrying a reach made the session it asked for,
          // whatever its body says. One that can't be read, or names no
          // session or another, confirms nothing: the requested session is
          // deleted, as for a missing echo (MAR-4352).
          const unverified = (why: string) => ({
            status: "unconfirmed" as const,
            httpStatus: response.status,
            unconfirmed: "fileReach" as const,
            why,
          });
          let echo: unknown;
          try {
            echo = await body.json();
          } catch (error) {
            if (!reach) throw error;
            return unverified("its answer could not be read");
          }
          const echoed = isRecord(echo) ? echo.sessionId : undefined;
          if (reach && echoed !== sessionId) {
            return unverified(
              typeof echoed === "string"
                ? "its answer is about another session"
                : "its answer names no session",
            );
          }
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
            return {
              status: "unconfirmed",
              httpStatus: response.status,
              unconfirmed: "requires",
            };
          }
          if (reach && !confirmsExecutionFileReach(echo, reach)) {
            return {
              status: "unconfirmed",
              httpStatus: response.status,
              unconfirmed: "fileReach",
            };
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
          return {
            status: "started",
            sessionId,
            commandId,
            workspace,
            ...(reach ? { fileReach: echoedFileReach(echo) } : {}),
          };
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
      const fate = sessionDeleted
        ? "it was deleted"
        : "deleting it failed, so it may still be running";
      if (answer.unconfirmed === "fileReach" && reach) {
        throw new ExecutionStartFileReachError(
          "file-reach-unconfirmed",
          answer.why
            ? `the host started session ${sessionId}, but ${answer.why}, so it does not confirm this file reach; ${fate}`
            : `the host started session ${sessionId} without echoing that it holds it to this file reach; ${fate}`,
          {
            fileReach: reach,
            status: answer.httpStatus,
            sessionId,
            sessionDeleted,
          },
        );
      }
      throw new ExecutionStartRequirementsError(
        "requirements-unconfirmed",
        `the host started session ${sessionId} without echoing that it checked ${requires.join(", ")}; ${fate}`,
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
      const withChoices =
        command.kind === "send-message" &&
        command.options?.interactionResponse !== undefined;
      // A host that predates files refuses the whole command, text and all,
      // and one that predates structured answers may drop the choices and
      // read the text alone, so the only safe place to refuse is here,
      // before it is sent (MAR-4002).
      if (withFiles || withChoices) {
        const probed = await health({
          signal: commandOptions.signal,
          timeoutMs: Math.min(
            healthTimeoutMs,
            commandOptions.timeoutMs ?? healthTimeoutMs,
          ),
        });
        if (withFiles && !hostTakesInlineFiles(probed)) {
          throw inlineFilesRefusal(operation, probed);
        }
        if (withChoices && !hostTakesStructuredInteractions(probed)) {
          throw interactionResponseRefusal(operation, probed);
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
          "A session patch names at least one of title, model, effort and permissionConfig, and nothing else: model and effort are null or an id of 1 to 256 characters, title null or a string, permissionConfig a permission policy with no field it does not know",
        );
      }
      // A host that predates live modes refuses the field as an unknown one,
      // in words about something else; the capability says it before then.
      if (patch.permissionConfig !== undefined) {
        const probed = await health({
          signal: requestOptions.signal,
          timeoutMs: Math.min(
            healthTimeoutMs,
            requestOptions.timeoutMs ?? healthTimeoutMs,
          ),
        });
        if (!hostTakesPermissionModes(probed)) {
          throw permissionModesRefusal(sessionId, probed);
        }
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
          if (!response.ok) {
            const text = await refusalText(response);
            // A code is honoured only with the status it comes with.
            const coded = decodeExecutionSessionPatchRefusal(parseOrNull(text));
            if (
              coded.ok &&
              EXECUTION_SESSION_PATCH_REFUSAL_STATUS[coded.value.code] ===
                response.status
            ) {
              throw new ExecutionSessionPatchError(
                coded.value.code,
                boundedReason(coded.value.error, connection.scrub),
                { sessionId, status: response.status },
              );
            }
            throw new ExecutionHostError(
              kindOfStatus(response.status),
              reasonOfText(text, response.status, connection.scrub),
              { operation: "patch session", status: response.status },
            );
          }
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

    listSessions: async (query = {}, requestOptions = {}) => {
      const search = encodeExecutionSessionListQuery(query);
      return request(
        "list sessions",
        `/v0/execution/sessions${search === "" ? "" : `?${search}`}`,
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body): Promise<ExecutionSessionList> => {
          if (!response.ok) throw await refusal("list sessions", response);
          const decoded = decodeExecutionSessionList(await body.json());
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              `the session list is unreadable (${decoded.reason})`,
              { operation: "list sessions", status: response.status },
            );
          }
          return decoded.value;
        },
      );
    },

    sessionChanges: (sessionId, requestOptions = {}) =>
      request(
        "session changes",
        `${sessionPath(sessionId)}/changes?scope=combined`,
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body): Promise<ExecutionSessionChangesResult> => {
          if (response.status === 404) {
            await response.body?.cancel().catch(() => {});
            return { status: "no-session", sessionId };
          }
          if (response.status === 409 || response.status === 410) {
            await response.body?.cancel().catch(() => {});
            return {
              status: "unavailable",
              sessionId,
              reason: response.status === 409 ? "not-recorded" : "pruned",
            };
          }
          if (!response.ok) throw await refusal("session changes", response);
          const decoded = decodeExecutionSessionChanges(
            await body.json(),
            sessionId,
          );
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              `the changes are unreadable (${decoded.reason})`,
              { operation: "session changes", status: response.status },
            );
          }
          return { status: "changes", sessionId, ...decoded.value };
        },
      ),

    listTurnUsage: async (query = {}, requestOptions = {}) => {
      const search = encodeExecutionTurnUsageQuery(query);
      return request(
        "list turn usage",
        `/v0/usage/turns${search === "" ? "" : `?${search}`}`,
        {
          method: "GET",
          authenticated: true,
          timeoutMs: requestOptions.timeoutMs ?? requestTimeoutMs,
          signal: requestOptions.signal,
        },
        async (response, body): Promise<ExecutionTurnUsagePage> => {
          if (!response.ok) throw await refusal("list turn usage", response);
          const decoded = decodeExecutionTurnUsagePage(await body.json());
          if (!decoded.ok) {
            throw new ExecutionHostError(
              "malformed",
              `the turn usage is unreadable (${decoded.reason})`,
              { operation: "list turn usage", status: response.status },
            );
          }
          return decoded.value;
        },
      );
    },

    downloadAttachment: async (
      sessionId,
      attachmentId,
      downloadOptions = {},
    ) => {
      const {
        kind = "tool",
        maxBytes: requestedBytes,
        signal,
        timeoutMs = requestTimeoutMs,
      } = downloadOptions;
      const maxBytes = attachmentByteLimit(kind, requestedBytes);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(
          "timeoutMs must be a finite positive number of milliseconds",
        );
      }
      const path = `/v0/execution/sessions/${attachmentPathId(
        sessionId,
      )}/attachments/${attachmentPathId(attachmentId)}`;
      if (signal?.aborted) throw signal.reason;
      try {
        return await request(
          "download attachment",
          path,
          {
            method: "GET",
            authenticated: true,
            accept: "application/octet-stream",
            timeoutMs,
            signal,
          },
          async (response, body) => {
            if (!response.ok || response.redirected) {
              cancelAttachmentBody(response);
              throw attachmentDownloadFailure(
                response.redirected ? "http" : kindOfStatus(response.status),
                response.status,
              );
            }
            return body.bytes(maxBytes);
          },
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ExecutionHostError) {
          throw attachmentDownloadFailure(error.kind, error.status);
        }
        throw error;
      }
    },

    taskOutput: async (sessionId, taskId, taskOptions = {}) => {
      // Every option read once, here, before anything is awaited.
      const { target, tail } = prepareTaskOutput(
        sessionId,
        taskId,
        taskOptions,
      );
      const { signal, timeoutMs = healthTimeoutMs } = taskOptions;
      const asked = { sessionId, taskId, tail };
      return request(
        "task output",
        target,
        { method: "GET", authenticated: true, timeoutMs, signal },
        async (response, answer): Promise<ExecutionTaskOutputResult> => {
          if (!response.ok) {
            // An unreadable refusal still has a status; a caller's abort is
            // still theirs.
            const refusal = await answer
              .atMost(TASK_OUTPUT_REFUSAL_MAX_BYTES)
              .catch((error: unknown) => {
                if (signal?.aborted) throw error;
                return null;
              });
            throw taskOutputRefusal(response.status, refusal ?? "", asked);
          }
          return readTaskOutputAnswer(
            response.status,
            await answer.atMost(TASK_OUTPUT_ANSWER_MAX_BYTES),
            asked,
          );
        },
      );
    },

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

/** A confirmed echo's reach, copied: what the host holds the session to. */
function echoedFileReach(
  answer: unknown,
): NonNullable<ExecutionFileReachEcho["fileReach"]> {
  const echoed = (answer as ExecutionFileReachEcho).fileReach!;
  return {
    entries: echoed.entries.map((entry) => ({
      path: entry.path,
      access: entry.access,
    })),
    abi: echoed.abi,
  };
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
