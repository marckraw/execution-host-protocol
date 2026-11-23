import type {
  ExecutionMcpProvider,
  ExecutionMcpServerList,
  ExecutionMcpSignIn,
  ExecutionMcpSignInStatus,
} from "../mcp.js";
import type {
  ExecutionHostCommand,
  ExecutionProject,
  ExecutionProvider,
  ExecutionSessionPatchRequest,
  ExecutionStartRequest,
} from "../types.js";
import type {
  ExecutionTurnUsagePage,
  ExecutionTurnUsageQuery,
} from "../turn-usage.js";
import type { ExecutionAttachmentDownloadResult } from "./attachment-download.js";
import type {
  ExecutionAttachmentDownloadOptions,
  ExecutionCommandOptions,
  ExecutionCommandResult,
  ExecutionRequestOptions,
  ExecutionSessionPatchResult,
  ExecutionStartResult,
} from "./client.js";
import type {
  ExecutionFollowOptions,
  ExecutionSessionFollow,
} from "./follow.js";
import type { ExecutionSessionChangesResult } from "./session-changes.js";
import type {
  ExecutionSessionList,
  ExecutionSessionListQuery,
} from "./session-list.js";
import type { ExecutionSessionSnapshot } from "./snapshot.js";
import type {
  ExecutionTaskOutputOptions,
  ExecutionTaskOutputResult,
} from "./task-output.js";

/**
 * What an execution host does, whatever carries it (MAR-4862): the HTTP
 * client (`createExecutionHostClient`), a `MessagePort` (`/port`), or a
 * runtime in the same process. A caller written against this runs on any of
 * them unchanged, and `/testing`'s conformance suite holds each to the same
 * answers.
 *
 * The rules every carrier keeps:
 *
 * - A refusal is the same error whatever carried it: an `ExecutionHostError`
 *   with its `kind`, or the operation's own typed error (an
 *   `ExecutionSessionPatchError`, an `ExecutionTaskOutputError`, …), and a
 *   request the protocol would refuse is a `TypeError` or `RangeError`.
 * - "No such session" is an answer where the HTTP client gives one —
 *   `snapshot` null, `no-session` from `command`, `patchSession` and
 *   `sessionChanges` — and an `ExecutionHostError` of kind `not-found`
 *   elsewhere.
 * - A caller's `signal` abort rejects with the signal's reason. `timeoutMs`
 *   is the carrier's to honour: over HTTP it bounds the request.
 * - A follow delivers each envelope once and in `seq` order, resumes after
 *   `afterSeq` with nothing missing and nothing twice, and ends only when it
 *   is stopped, the host says the session is gone (or refuses the caller),
 *   or the caller's `maxAttempts` run out: the same end, after the same
 *   `waiting` statuses, as the HTTP client's.
 *
 * Health, the handshake, the host profile, teardown and one-shots stay on the
 * HTTP client: they are about a host on the network, not about sessions. The
 * MCP connections are here, though no session's: a host in the same process
 * as its owner manages its providers' sign-ins as one on the network does.
 */
export interface ExecutionHostApi {
  /** The providers the host serves, with the models and efforts each offers. */
  providers(options?: ExecutionRequestOptions): Promise<ExecutionProvider[]>;
  /** The Projects the host advertises. */
  projects(options?: ExecutionRequestOptions): Promise<ExecutionProject[]>;
  /**
   * Starts a session with its first turn. `exists` when the host already has
   * a session by that id.
   */
  start(
    request: ExecutionStartRequest,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionStartResult>;
  /** Sends a session a command; `no-session` when the host has none by that id. */
  command(
    sessionId: string,
    command: ExecutionHostCommand,
    options?: ExecutionCommandOptions,
  ): Promise<ExecutionCommandResult>;
  /** One page of the sessions the host holds for the caller, newest first. */
  listSessions(
    query?: ExecutionSessionListQuery,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionList>;
  /** The session as the host has it now, or null when it has none by that id. */
  snapshot(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionSnapshot | null>;
  /** Changes a session's title, model, effort or permission policy. */
  patchSession(
    sessionId: string,
    patch: ExecutionSessionPatchRequest,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionPatchResult>;
  /**
   * Follows the session across turns until stopped. See
   * `ExecutionFollowOptions`; a carrier with no connection of its own (a
   * runtime in the same process) ignores `idleTimeoutMs` and
   * `maxFrameLength`.
   */
  followSession(
    sessionId: string,
    options: ExecutionFollowOptions,
  ): ExecutionSessionFollow;
  /** The end of one background task's output (`tasks.output.v1`). */
  taskOutput(
    sessionId: string,
    taskId: string,
    options?: ExecutionTaskOutputOptions,
  ): Promise<ExecutionTaskOutputResult>;
  /**
   * The session's changes across all its turns
   * (`turns.fileChanges.combined`).
   */
  sessionChanges(
    sessionId: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionSessionChangesResult>;
  /** The bytes of one attachment of a session, bounded by its kind's ceiling. */
  downloadAttachment(
    sessionId: string,
    attachmentId: string,
    options?: ExecutionAttachmentDownloadOptions,
  ): Promise<ExecutionAttachmentDownloadResult>;
  /**
   * One page of what the host's turns cost, in the order it recorded them
   * (`turns.usage.v1`, MAR-4943). A host that records none refuses it as
   * `not-found`, as an older host's 404 is.
   */
  listTurnUsage(
    query?: ExecutionTurnUsageQuery,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionTurnUsagePage>;
  /**
   * The MCP servers `provider` can use on the host, each with its state
   * (`mcp.connections.v1`, MAR-5668). A server this build cannot read is
   * dropped and named in `warnings`.
   *
   * Every MCP call refuses a provider other than `claude` or `codex`, a
   * server name `isExecutionMcpServerName` refuses, or a callback URL
   * `isExecutionMcpUrl` refuses, as a `TypeError`, before anything is sent;
   * and every refusal of the host's is an `ExecutionMcpError` with a code.
   * A host that manages no MCP connections, as one shared by several people
   * does not, refuses each `unavailable-on-host`; one predating them,
   * `unsupported`. None reads `/health` first: gate on
   * `hostManagesMcpConnections(health)`.
   */
  mcpServers(
    provider: ExecutionMcpProvider,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionMcpServerList>;
  /**
   * Starts signing in to `server`, and answers the page to open in the
   * owner's browser. **`signInUrl` is a secret**: open it, and never log,
   * record or store it. The sign-in is `pending` until the browser comes
   * back, the caller cancels it, or `expiresAt` passes. While one is
   * pending, asking again answers the same one. `not-offered` for a server
   * that needs no sign-in or is managed elsewhere (a claude.ai connector),
   * `unknown-server` for a name the provider does not have.
   */
  mcpSignIn(
    provider: ExecutionMcpProvider,
    server: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionMcpSignIn>;
  /**
   * Where `server`'s latest sign-in is: `pending`, `connected`, `failed` (an
   * expired one too) or `cancelled`. `no-sign-in` when it has none the host
   * remembers: none started since the host started, or the server was
   * signed out since.
   */
  mcpSignInState(
    provider: ExecutionMcpProvider,
    server: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionMcpSignInStatus>;
  /**
   * Finishes a pending sign-in with the URL the provider's page sent the
   * browser to, for when that browser cannot reach the provider's own
   * callback on the host's loopback. **`callbackUrl` is a secret**: it
   * carries the authorization code. Answers the sign-in's state after it; a
   * sign-in no longer pending answers as it is. `rejected` for a URL that is
   * not this sign-in's, which leaves it pending; `no-sign-in` when there is
   * none.
   */
  mcpFinishSignIn(
    provider: ExecutionMcpProvider,
    server: string,
    callbackUrl: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionMcpSignInStatus>;
  /**
   * Cancels a pending sign-in, and answers its state after: `cancelled`, or
   * how it ended if it ended first (`connected` when the browser won).
   * `no-sign-in` when there is none.
   */
  mcpCancelSignIn(
    provider: ExecutionMcpProvider,
    server: string,
    options?: ExecutionRequestOptions,
  ): Promise<ExecutionMcpSignInStatus>;
  /**
   * Signs out of `server`: the provider forgets its sign-in, the server
   * needs one again, and the host forgets the server's latest sign-in,
   * cancelling it if it is pending. Signing out of a server not signed in
   * is no error.
   */
  mcpSignOut(
    provider: ExecutionMcpProvider,
    server: string,
    options?: ExecutionRequestOptions,
  ): Promise<void>;
}
