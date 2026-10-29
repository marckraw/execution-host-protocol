import { decodeExecutionTurnFileChange } from "../codecs.js";
import { isRecord } from "../guards.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
  type ExecutionTurnFileChange,
} from "../types.js";

/**
 * A session's changes across all its turns, against where it began
 * (`GET .../changes?scope=combined`, `turns.fileChanges.combined`).
 *
 * `changes` — what the session changed, each file once. `no-session` — the
 * host has no session by that id (404). `unavailable` — the host has the
 * session but cannot say: `not-recorded` for a session older than the
 * capability, which kept no baseline (409), `pruned` for one whose workspace
 * is gone (410).
 */
export type ExecutionSessionChangesResult =
  | {
      status: "changes";
      sessionId: string;
      fileChanges: ExecutionTurnFileChange[];
      /** Changes this build could not read, dropped and named. */
      warnings: ExecutionDecodeWarning[];
    }
  | { status: "no-session"; sessionId: string }
  | {
      status: "unavailable";
      sessionId: string;
      reason: "not-recorded" | "pruned";
    };

/** The status each `unavailable` reason comes with. */
export const EXECUTION_SESSION_CHANGES_UNAVAILABLE_STATUS = {
  "not-recorded": 409,
  pruned: 410,
} as const;

/**
 * Reads a combined-changes answer. Its frame is required, and every change
 * must be about `sessionId`: an answer about another session is refused, not
 * filed under this one. An unreadable change is dropped and named.
 */
export function decodeExecutionSessionChanges(
  raw: unknown,
  sessionId: string,
): ExecutionDecodeResult<{
  fileChanges: ExecutionTurnFileChange[];
  warnings: ExecutionDecodeWarning[];
}> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  if (raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported-protocol-version" };
  }
  if (raw.scope !== "combined" || !Array.isArray(raw.fileChanges)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const fileChanges: ExecutionTurnFileChange[] = [];
  const warnings: ExecutionDecodeWarning[] = [];
  for (const [index, entry] of raw.fileChanges.entries()) {
    const decoded = decodeExecutionTurnFileChange(entry);
    if (!decoded.ok) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `fileChanges.${index}`,
      });
      continue;
    }
    if (decoded.value.sessionId !== sessionId) {
      return { ok: false, reason: "invalid-payload" };
    }
    fileChanges.push(decoded.value);
  }
  return {
    ok: true,
    value: { fileChanges, warnings },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
