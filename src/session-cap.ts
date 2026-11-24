import { isRecord, isSafeNonNegativeInteger } from "./guards.js";
import type { ExecutionDecodeResult } from "./types.js";

/**
 * A provider's own cap on its live sessions on a host, and how many are live
 * now (MAR-5692): `sessionCap` on a provider in `GET /v0/providers`.
 * Antigravity's, on the daemon (`ANTIGRAVITY_MAX_SESSIONS`). It protects the
 * machine and the provider's quota, and is no check on who asks: past it, a
 * start or a command that needs a new process is refused, whoever sent it,
 * as the host refuses anything, in its own words. A client reads it to say
 * how many run and how many may; it never changes it.
 */
export interface ExecutionProviderSessionCap {
  /** How many of its sessions may be live at once. 0 starts none. */
  maxConcurrentSessions: number;
  /**
   * How many are live now, as the host counts them: a session that holds a
   * process of the provider's, or is being given one.
   */
  liveSessions: number;
}

/**
 * Reads a provider's `sessionCap` (MAR-5692), strictly: both counts
 * non-negative integers. Fields beyond those are ignored. The provider
 * listing reads one it cannot read as absent, with a warning: unknown, not
 * "no cap".
 */
export function decodeExecutionProviderSessionCap(
  raw: unknown,
): ExecutionDecodeResult<ExecutionProviderSessionCap> {
  if (
    !isRecord(raw) ||
    !isSafeNonNegativeInteger(raw.maxConcurrentSessions) ||
    !isSafeNonNegativeInteger(raw.liveSessions)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      maxConcurrentSessions: raw.maxConcurrentSessions,
      liveSessions: raw.liveSessions,
    },
  };
}
