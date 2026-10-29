import type {
  ExecutionHostCommand,
  ExecutionProject,
  ExecutionProvider,
  ExecutionSessionPatchRequest,
  ExecutionStartRequest,
} from "../types.js";
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
 *   is stopped or the host says the session is gone (or refuses the caller).
 *
 * Health, the handshake, the host profile, teardown and one-shots stay on the
 * HTTP client: they are about a host on the network, not about sessions.
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
   * `ExecutionFollowOptions`; a carrier without a network ignores
   * `idleTimeoutMs` and `maxFrameLength`.
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
}
