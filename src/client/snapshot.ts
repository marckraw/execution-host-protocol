import {
  decodeExecutionActivitySignal,
  decodeExecutionContextWindow,
  decodeExecutionConversationItem,
  decodeExecutionSessionMetadata,
  decodeExecutionSessionWorkspace,
  decodeExecutionTurn,
  decodeExecutionTurnFileChange,
} from "../codecs.js";
import {
  EXECUTION_ATTENTION_STATES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_STATUSES,
  type ExecutionActivitySignal,
  type ExecutionAttentionState,
  type ExecutionContextWindow,
  type ExecutionConversationItem,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
  type ExecutionSessionMetadata,
  type ExecutionSessionStatus,
  type ExecutionSessionWorkspace,
  type ExecutionTurn,
  type ExecutionTurnFileChange,
} from "../types.js";

export interface ExecutionSessionSnapshotTurn extends ExecutionTurn {
  fileChanges: ExecutionTurnFileChange[];
}

/**
 * A session as its host holds it now (`GET /v0/execution/sessions/:id`): the
 * conversation the delta log adds up to, its turns with their diffs, and
 * `lastSeq`, the newest envelope it includes. A reader seeds from it and
 * streams from `lastSeq`, or refetches it to reconcile after a gap.
 *
 * The host's own projection rather than an envelope, so it lives beside the
 * client rather than in the contract; its parts are read by the contract's own
 * decoders.
 */
export interface ExecutionSessionSnapshot {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  providerId: string;
  /** Whether the host will take commands for it now. */
  commandable: boolean;
  status: ExecutionSessionStatus;
  attention: ExecutionAttentionState;
  activity: ExecutionActivitySignal;
  metadata: ExecutionSessionMetadata | null;
  continuationToken: string | null;
  contextWindow: ExecutionContextWindow | null;
  conversation: ExecutionConversationItem[];
  /** In `sequence` order. */
  turns: ExecutionSessionSnapshotTurn[];
  lastSeq: number;
  /** Where the host prepared the session; null when it reported none. */
  workspace: ExecutionSessionWorkspace | null;
  prUrl: string | null;
  roomId: string | null;
}

/**
 * Reads a snapshot. The frame of it is required — protocol version, ids, the
 * conversation, `lastSeq` — and, given `expectedSessionId`, it must be about
 * that session: a crossed answer is refused, not filed under the wrong one.
 *
 * Everything else degrades rather than costing the snapshot: an item of a kind
 * this build does not know, an unreadable item, turn or file change is dropped,
 * and a field it cannot read falls back to its empty value — each one named in
 * `warnings`, because a drop nobody can see is its own defect.
 */
export function decodeExecutionSessionSnapshot(
  raw: unknown,
  expectedSessionId?: string,
): ExecutionDecodeResult<ExecutionSessionSnapshot> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  if (raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported-protocol-version" };
  }
  if (
    !isNonEmptyString(raw.sessionId) ||
    (expectedSessionId !== undefined && raw.sessionId !== expectedSessionId) ||
    !isNonEmptyString(raw.providerId) ||
    !Array.isArray(raw.conversation) ||
    !Number.isSafeInteger(raw.lastSeq) ||
    (raw.lastSeq as number) < 0
  ) {
    return { ok: false, reason: "invalid-payload" };
  }

  const warnings: ExecutionDecodeWarning[] = [];
  const field = <T>(
    key: string,
    fallback: T,
    read: (value: unknown) => { ok: true; value: T } | { ok: false },
  ): T => {
    const value = raw[key];
    if (value === undefined) return fallback;
    const decoded = read(value);
    if (decoded.ok) return decoded.value;
    warnings.push({ reason: "dropped-invalid-field", path: key });
    return fallback;
  };

  const conversation: ExecutionConversationItem[] = [];
  raw.conversation.forEach((entry, index) => {
    const item = decodeExecutionConversationItem(entry);
    if (item.ok) {
      conversation.push(item.value);
      for (const warning of item.warnings ?? []) {
        warnings.push({
          ...warning,
          path: warning.path.replace(/^item/, `conversation.${index}`),
        });
      }
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `conversation.${index}`,
      });
    }
  });

  return {
    ok: true,
    value: {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId: raw.sessionId,
      providerId: raw.providerId,
      commandable: field<boolean>("commandable", false, (value) =>
        typeof value === "boolean" ? { ok: true, value } : { ok: false },
      ),
      status: field<ExecutionSessionStatus>("status", "idle", (value) =>
        oneOf(EXECUTION_SESSION_STATUSES, value),
      ),
      attention: field<ExecutionAttentionState>("attention", "none", (value) =>
        oneOf(EXECUTION_ATTENTION_STATES, value),
      ),
      activity: field<ExecutionActivitySignal>(
        "activity",
        null,
        decodeExecutionActivitySignal,
      ),
      metadata: field("metadata", null, decodeExecutionSessionMetadata),
      continuationToken: field("continuationToken", null, nullableString),
      contextWindow: field<ExecutionContextWindow | null>(
        "contextWindow",
        null,
        (value) =>
          value === null
            ? { ok: true, value: null }
            : decodeExecutionContextWindow(value),
      ),
      conversation,
      turns: readTurns(raw.turns, warnings),
      lastSeq: raw.lastSeq as number,
      workspace: field<ExecutionSessionWorkspace | null>(
        "workspace",
        null,
        (value) =>
          value === null
            ? { ok: true, value: null }
            : decodeExecutionSessionWorkspace(value),
      ),
      prUrl: field<string | null>("prUrl", null, (value) =>
        value === null || isHttpUrl(value)
          ? { ok: true, value: value as string | null }
          : { ok: false },
      ),
      roomId: field<string | null>("roomId", null, (value) =>
        value === null || isNonEmptyString(value)
          ? { ok: true, value: value as string | null }
          : { ok: false },
      ),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function readTurns(
  raw: unknown,
  warnings: ExecutionDecodeWarning[],
): ExecutionSessionSnapshotTurn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ reason: "dropped-invalid-field", path: "turns" });
    return [];
  }
  const turns: ExecutionSessionSnapshotTurn[] = [];
  raw.forEach((entry, index) => {
    const turn = decodeExecutionTurn(entry);
    if (!turn.ok) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `turns.${index}`,
      });
      return;
    }
    const { fileChanges: rawChanges, ...record } =
      turn.value as ExecutionTurn & {
        fileChanges?: unknown;
      };
    const fileChanges: ExecutionTurnFileChange[] = [];
    if (Array.isArray(rawChanges)) {
      rawChanges.forEach((change, changeIndex) => {
        const decoded = decodeExecutionTurnFileChange(change);
        if (decoded.ok) fileChanges.push(decoded.value);
        else {
          warnings.push({
            reason: "dropped-invalid-field",
            path: `turns.${index}.fileChanges.${changeIndex}`,
          });
        }
      });
    } else if (rawChanges !== undefined) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `turns.${index}.fileChanges`,
      });
    }
    turns.push({ ...record, fileChanges });
  });
  return turns.sort((left, right) => left.sequence - right.sequence);
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): { ok: true; value: T } | { ok: false } {
  return (values as readonly unknown[]).includes(value)
    ? { ok: true, value: value as T }
    : { ok: false };
}

function nullableString(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  return value === null || typeof value === "string"
    ? { ok: true, value }
    : { ok: false };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
