import {
  decodeExecutionActivitySignal,
  decodeExecutionContextWindow,
  decodeExecutionPermissionConfig,
  decodeExecutionSessionMetadata,
  decodeExecutionSessionWorkspace,
} from "../codecs.js";
import {
  isBoundedString,
  isNonEmptyString,
  isRecord,
  isSafeNonNegativeInteger,
} from "../guards.js";
import {
  EXECUTION_ATTENTION_STATES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_STATUSES,
  type ExecutionActivitySignal,
  type ExecutionAttentionState,
  type ExecutionContextWindow,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
  type ExecutionPermissionConfig,
  type ExecutionSessionMetadata,
  type ExecutionSessionStatus,
  type ExecutionSessionWorkspace,
} from "../types.js";
import { isHttpUrl, nullableString, oneOf } from "./snapshot.js";

/**
 * Which sessions to list (`GET /v0/execution/sessions`), as agents-daemon
 * reads its query. Every field is optional; none lists the newest first.
 */
export interface ExecutionSessionListQuery {
  /** The `nextCursor` of the page before. */
  cursor?: string;
  /** A whole number from 1 to 100. The host's default when absent. */
  limit?: number;
  status?: ExecutionSessionStatus;
  providerId?: string;
  /** Words to search titles and names for; at most 256 characters. */
  q?: string;
  roomId?: string;
  /** Include torn-down sessions, with their `deletedAt`. */
  includeDeleted?: boolean;
}

/**
 * One session as a host lists it: its snapshot without the conversation, the
 * turns or the continuation token, with what a list shows besides. Like a
 * snapshot, the host's own projection, read here beside the client.
 */
export interface ExecutionSessionSummary {
  sessionId: string;
  providerId: string;
  /** The host's name for it; null when it gave none. */
  name: string | null;
  title: string | null;
  /** Absent when the host did not say, as on a snapshot. */
  model?: string | null;
  /** Absent when the host did not say, as on a snapshot. */
  effort?: string | null;
  /** Absent when the host did not say, or said it unreadably. */
  permissionConfig?: ExecutionPermissionConfig;
  commandable: boolean;
  status: ExecutionSessionStatus;
  attention: ExecutionAttentionState;
  activity: ExecutionActivitySignal;
  metadata: ExecutionSessionMetadata | null;
  contextWindow: ExecutionContextWindow | null;
  /** How many conversation items it holds; null when the host did not say. */
  conversationItemCount: number | null;
  /** The newest envelope it includes: where a follower of it would resume. */
  lastSeq: number;
  workspace: ExecutionSessionWorkspace | null;
  prUrl: string | null;
  roomId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** When it was torn down; null for a session that was not. */
  deletedAt: string | null;
}

/**
 * One page of sessions. `nextCursor` asks for the next page; null is the last.
 * A session or field this build could not read is dropped and named in
 * `warnings`, so a short page is never silently short.
 */
export interface ExecutionSessionList {
  sessions: ExecutionSessionSummary[];
  nextCursor: string | null;
  warnings: ExecutionDecodeWarning[];
}

const LIST_LIMIT_MAX = 100;
const LIST_CURSOR_MAX_LENGTH = 1024;
const LIST_PROVIDER_ID_MAX_LENGTH = 100;
const LIST_QUERY_MAX_LENGTH = 256;
const LIST_ROOM_ID_MAX_LENGTH = 200;

/**
 * The query string for a list, or a `TypeError` / `RangeError` for a query
 * agents-daemon would refuse: checked here, where the mistake is.
 */
export function encodeExecutionSessionListQuery(
  query: ExecutionSessionListQuery,
): string {
  if (!isRecord(query as unknown)) {
    throw new TypeError("A session list query is an object");
  }
  const params = new URLSearchParams();
  const { cursor, limit, status, providerId, q, roomId, includeDeleted } =
    query;
  if (cursor !== undefined) {
    if (!isBoundedString(cursor, LIST_CURSOR_MAX_LENGTH)) {
      throw new TypeError(
        `cursor must be a nextCursor: 1 to ${LIST_CURSOR_MAX_LENGTH} characters`,
      );
    }
    params.set("cursor", cursor);
  }
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
      throw new RangeError(
        `limit must be a whole number from 1 to ${LIST_LIMIT_MAX}`,
      );
    }
    params.set("limit", String(limit));
  }
  if (status !== undefined) {
    if (!(EXECUTION_SESSION_STATUSES as readonly unknown[]).includes(status)) {
      throw new TypeError(
        `status must be one of ${EXECUTION_SESSION_STATUSES.join(", ")}`,
      );
    }
    params.set("status", status);
  }
  if (providerId !== undefined) {
    if (
      !isBoundedString(providerId, LIST_PROVIDER_ID_MAX_LENGTH) ||
      providerId.trim() !== providerId
    ) {
      throw new TypeError(
        `providerId must be 1 to ${LIST_PROVIDER_ID_MAX_LENGTH} characters, without surrounding spaces`,
      );
    }
    params.set("providerId", providerId);
  }
  if (q !== undefined) {
    if (typeof q !== "string" || q.trim().length > LIST_QUERY_MAX_LENGTH) {
      throw new TypeError(
        `q must be a string of at most ${LIST_QUERY_MAX_LENGTH} characters`,
      );
    }
    params.set("q", q);
  }
  if (roomId !== undefined) {
    if (
      !isBoundedString(roomId, LIST_ROOM_ID_MAX_LENGTH) ||
      roomId.trim() !== roomId
    ) {
      throw new TypeError(
        `roomId must be 1 to ${LIST_ROOM_ID_MAX_LENGTH} characters, without surrounding spaces`,
      );
    }
    params.set("roomId", roomId);
  }
  if (includeDeleted !== undefined) {
    if (typeof includeDeleted !== "boolean") {
      throw new TypeError("includeDeleted must be true or false");
    }
    if (includeDeleted) params.set("includeDeleted", "true");
  }
  return params.toString();
}

/**
 * Reads a page of sessions. The frame is required — protocol version and a
 * `sessions` array — and so is each session's `sessionId`, `providerId` and
 * `lastSeq`: one without them is dropped. Everything else degrades to its
 * empty value, named in `warnings`, as a snapshot's fields do.
 */
export function decodeExecutionSessionList(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionList> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  if (raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported-protocol-version" };
  }
  if (!Array.isArray(raw.sessions)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const warnings: ExecutionDecodeWarning[] = [];
  const sessions: ExecutionSessionSummary[] = [];
  raw.sessions.forEach((entry, index) => {
    const summary = readSummary(entry, `sessions.${index}`, warnings);
    if (summary === null) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `sessions.${index}`,
      });
    } else sessions.push(summary);
  });
  let nextCursor: string | null = null;
  if (raw.nextCursor !== undefined && raw.nextCursor !== null) {
    if (isBoundedString(raw.nextCursor, LIST_CURSOR_MAX_LENGTH)) {
      nextCursor = raw.nextCursor;
    } else {
      warnings.push({ reason: "dropped-invalid-field", path: "nextCursor" });
    }
  }
  return {
    ok: true,
    value: { sessions, nextCursor, warnings },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function readSummary(
  raw: unknown,
  path: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionSessionSummary | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.sessionId) ||
    !isNonEmptyString(raw.providerId) ||
    !isSafeNonNegativeInteger(raw.lastSeq)
  ) {
    return null;
  }
  const field = <T>(
    key: string,
    fallback: T,
    read: (value: unknown) => { ok: true; value: T } | { ok: false },
  ): T => {
    const value = raw[key];
    if (value === undefined) return fallback;
    const decoded = read(value);
    if (decoded.ok) return decoded.value;
    warnings.push({ reason: "dropped-invalid-field", path: `${path}.${key}` });
    return fallback;
  };
  /** A non-empty string or null: an id, a name, a timestamp as written. */
  const text = (value: unknown) =>
    value === null || isNonEmptyString(value)
      ? { ok: true as const, value }
      : { ok: false as const };
  const nullable =
    <T>(read: (value: unknown) => { ok: true; value: T } | { ok: false }) =>
    (value: unknown): { ok: true; value: T | null } | { ok: false } =>
      value === null ? { ok: true, value: null } : read(value);

  const model = field<string | null | undefined>("model", undefined, text);
  const effort = field<string | null | undefined>("effort", undefined, text);
  const permissionConfig =
    raw.permissionConfig === null
      ? undefined
      : field<ExecutionPermissionConfig | undefined>(
          "permissionConfig",
          undefined,
          decodeExecutionPermissionConfig,
        );
  return {
    sessionId: raw.sessionId,
    providerId: raw.providerId,
    name: field<string | null>("name", null, text),
    title: field<string | null>("title", null, nullableString),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(permissionConfig === undefined ? {} : { permissionConfig }),
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
    contextWindow: field<ExecutionContextWindow | null>(
      "contextWindow",
      null,
      nullable(decodeExecutionContextWindow),
    ),
    conversationItemCount: field<number | null>(
      "conversationItemCount",
      null,
      (value) =>
        value === null || isSafeNonNegativeInteger(value)
          ? { ok: true, value }
          : { ok: false },
    ),
    lastSeq: raw.lastSeq,
    workspace: field<ExecutionSessionWorkspace | null>(
      "workspace",
      null,
      nullable(decodeExecutionSessionWorkspace),
    ),
    prUrl: field<string | null>("prUrl", null, (value) =>
      value === null || isHttpUrl(value) ? { ok: true, value } : { ok: false },
    ),
    roomId: field<string | null>("roomId", null, text),
    createdAt: field<string | null>("createdAt", null, text),
    updatedAt: field<string | null>("updatedAt", null, text),
    deletedAt: field<string | null>("deletedAt", null, text),
  };
}
