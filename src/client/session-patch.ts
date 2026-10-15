import type { ExecutionSessionPatchRefusalCode } from "../types.js";
import type { ExecutionHostHealth } from "./health.js";

/**
 * Why a session patch did not change the session (MAR-4052): a host's coded
 * refusal, or `unsupported-on-host` from this client itself, when the host
 * does not advertise `sessions.permissionModes.v1` and the patch names a
 * `permissionConfig`. `turn-running` — a turn is running; send it again once
 * it ends. The others — not on this host, or not for this provider.
 */
export type ExecutionSessionPatchErrorCode = ExecutionSessionPatchRefusalCode;

/**
 * A session patch refused, by the host or before it was sent (MAR-4052): one a
 * caller can branch on to say "after this turn" or "not here", without reading
 * the host's prose. Nothing the patch named changed. Not an
 * `ExecutionHostError`: a caller converting errors checks for both.
 */
export class ExecutionSessionPatchError extends Error {
  readonly code: ExecutionSessionPatchErrorCode;
  readonly operation = "patch session";
  readonly sessionId: string;
  /** The host's status for its refusal; null when nothing was sent. */
  readonly status: number | null;
  /** Safe to show: the host's words, scrubbed and cut, or the client's own. */
  readonly reason: string;

  constructor(
    code: ExecutionSessionPatchErrorCode,
    reason: string,
    details: { sessionId: string; status?: number | null },
  ) {
    const status = details.status ?? null;
    super(
      `patch session failed: ${status === null ? code : `HTTP ${status}`}: ${reason}`,
    );
    this.name = "ExecutionSessionPatchError";
    this.code = code;
    this.sessionId = details.sessionId;
    this.status = status;
    this.reason = reason;
  }
}

/**
 * Whether the host changes a running session's mode
 * (`sessions.permissionModes.v1`). A host that does not refuses a patch's
 * `permissionConfig` as an unknown field, so `patchSession()` will not send
 * one there, and a client can hide its switcher.
 */
export function hostTakesPermissionModes(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("sessions.permissionModes.v1");
}

export function permissionModesRefusal(
  sessionId: string,
  health: Pick<ExecutionHostHealth, "executionProtocolValid">,
): ExecutionSessionPatchError {
  return new ExecutionSessionPatchError(
    "unsupported-on-host",
    health.executionProtocolValid
      ? "the host does not advertise sessions.permissionModes.v1, so it cannot change a running session's mode; nothing was sent"
      : "the host's protocol descriptor is unreadable, so it cannot be trusted to change a running session's mode; nothing was sent",
    { sessionId },
  );
}
