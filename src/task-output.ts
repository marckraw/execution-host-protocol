import {
  isNonEmptyString,
  isRecord,
  isSafeNonNegativeInteger,
} from "./guards.js";
import type { AgentRunStatus } from "./harness-evidence.js";
import type { ExecutionDecodeResult } from "./types.js";

/**
 * A task's output (`tasks.output.v1`, MAR-3981): authenticated
 * `GET /v0/execution/sessions/:sessionId/tasks/:taskId/output?tail=<bytes>`,
 * the end of what one task — a background command — has written, at most
 * 64 KiB of it, with the task's status.
 *
 * The request names a session and a task, never a file. The host serves only
 * a task its own record of that session knows, from the path it recorded for
 * it, and refuses a recorded path outside the session's worktree and the
 * provider's own task directory. Nothing in the request is ever part of a
 * path the host opens.
 *
 * The answer is text the host has redacted, as it redacts every other text it
 * sends, not the file's bytes.
 */

/** The most a tail may ask for, and the longest window an answer covers. */
export const EXECUTION_TASK_OUTPUT_MAX_BYTES = 65_536;

/**
 * The longest `text`, in UTF-16 code units (JavaScript string length). A
 * window of at most `EXECUTION_TASK_OUTPUT_MAX_BYTES` decodes to at most this
 * many; a host whose redaction would lengthen it past the cap reads a shorter
 * window instead.
 */
export const EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH = 65_536;

/** The longest task id. */
export const EXECUTION_TASK_OUTPUT_TASK_ID_MAX_LENGTH = 256;

/**
 * A task id this route can name: an ASCII letter or digit, then letters,
 * digits, `.`, `_` or `-`. No separator, no dot segment, nothing a path could
 * be made of. Claude Code's task ids (`b7x2k9q1`) are all of this shape.
 */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ROUTE =
  /^\/v0\/execution\/sessions\/([^/?#]+)\/tasks\/([^/?#]+)\/output$/;

/** `tail`: a whole number of bytes, written without sign or leading zeros. */
const TAIL = /^[1-9][0-9]{0,5}$/;

/** RFC 3339 in UTC or with an offset, as `Date.prototype.toISOString` writes it. */
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A task's status, as `SessionTask.status` in its evidence names it. */
export const EXECUTION_TASK_OUTPUT_STATUSES = [
  "running",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const satisfies readonly AgentRunStatus[];

export interface ExecutionTaskOutputRequest {
  sessionId: string;
  /** The `taskId` the task's evidence named. A task, never a file. */
  taskId: string;
  /**
   * How many bytes from the end of the output file to read: a whole number
   * from 1 to `EXECUTION_TASK_OUTPUT_MAX_BYTES`. Absent, the most.
   */
  tail?: number;
}

/**
 * The host's answer. Bytes are the output file's, as it lies on the host's
 * disk; `text` is what the host made of the window of them it read.
 *
 * - The window is the file's bytes from `startOffset` to `totalBytes`, at
 *   most `tail` of them. `truncated` is true exactly when it starts after the
 *   file's first byte.
 * - `text` is that window decoded as UTF-8 and redacted by the host. Each
 *   invalid sequence is U+FFFD, and a byte order mark is a character like any
 *   other. A window never starts inside a character: one the tail cut is
 *   skipped whole, so `startOffset` may be up to 3 bytes past where the tail
 *   reached. A character still being written at the end of the file is
 *   U+FFFD until the next read.
 * - Redaction rewrites the text, so its length says nothing about the
 *   window's: `startOffset` and `totalBytes` are positions in the file, not in
 *   `text`.
 */
export interface ExecutionTaskOutputResponse {
  sessionId: string;
  taskId: string;
  /** The task's status when the host read its output. */
  status: AgentRunStatus;
  /** Host-redacted, at most `EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH` long. */
  text: string;
  /** The byte the window starts at: 0 when it holds the whole file. */
  startOffset: number;
  /** The output file's size, in bytes, when the host read it. */
  totalBytes: number;
  /** `startOffset > 0`: the window does not hold the file's start. */
  truncated: boolean;
  /** When the host read the file: an RFC 3339 timestamp. */
  readAt: string;
}

/**
 * Why a host refused to read a task's output, with the status it answers:
 *
 * - `session-unknown` (404): it has no session by that id.
 * - `task-unknown` (404): the session's record knows no task by that id.
 * - `no-output` (404): the task has no output file — it never had one, as a
 *   subagent does not, or the file is gone.
 * - `read-refused` (403): its policy will not read this task's output — the
 *   recorded path is outside the session's worktree and the provider's task
 *   directory, or it serves no output for tasks of this kind.
 * - `rejected` (400): it will not take the request — a `tail` out of bounds,
 *   a task id this route cannot name, or a query parameter it does not know.
 */
export const EXECUTION_TASK_OUTPUT_REFUSAL_CODES = [
  "session-unknown",
  "task-unknown",
  "no-output",
  "read-refused",
  "rejected",
] as const;
export type ExecutionTaskOutputRefusalCode =
  (typeof EXECUTION_TASK_OUTPUT_REFUSAL_CODES)[number];

/** The status a host answers each refusal with, and the only one it may. */
export const EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES = {
  "session-unknown": 404,
  "task-unknown": 404,
  "no-output": 404,
  "read-refused": 403,
  rejected: 400,
} as const satisfies Record<ExecutionTaskOutputRefusalCode, number>;

/**
 * A host's refusal body: `{ error, code }`. `error` is for a person and never
 * names the output file's path. Other fields are ignored.
 */
export interface ExecutionTaskOutputRefusal {
  error: string;
  code: ExecutionTaskOutputRefusalCode;
}

const STATUSES: ReadonlySet<string> = new Set(EXECUTION_TASK_OUTPUT_STATUSES);
const REFUSAL_CODES: ReadonlySet<string> = new Set(
  EXECUTION_TASK_OUTPUT_REFUSAL_CODES,
);

/**
 * The request target of a task-output read: its path, both ids encoded, and
 * its `tail` when given. Throws a `TypeError` for an id the route cannot name
 * and a `RangeError` for a `tail` out of bounds, so no request past the cap
 * can be written.
 */
export function encodeExecutionTaskOutputRequest(
  request: ExecutionTaskOutputRequest,
): string {
  if (!isSessionId(request.sessionId)) {
    throw new TypeError(
      "sessionId must be a non-empty string other than a dot segment",
    );
  }
  if (!isTaskId(request.taskId)) {
    throw new TypeError(
      `taskId must be 1 to ${EXECUTION_TASK_OUTPUT_TASK_ID_MAX_LENGTH} ASCII letters, digits, '.', '_' or '-', starting with a letter or digit`,
    );
  }
  if (request.tail !== undefined && !isTail(request.tail)) {
    throw new RangeError(
      `tail must be a whole number of bytes from 1 to ${EXECUTION_TASK_OUTPUT_MAX_BYTES}`,
    );
  }
  const path = `/v0/execution/sessions/${encodeURIComponent(request.sessionId)}/tasks/${encodeURIComponent(request.taskId)}/output`;
  return request.tail === undefined ? path : `${path}?tail=${request.tail}`;
}

/**
 * Reads a task-output request target — its path and query, as on the request
 * line (`/v0/execution/sessions/s/tasks/t/output?tail=4096`) — as a host
 * does. Strict: the query holds `tail` once or not at all, and nothing else,
 * so a `path` or `file` parameter is refused rather than ignored. An absent
 * `tail` is the most, `EXECUTION_TASK_OUTPUT_MAX_BYTES`.
 */
export function decodeExecutionTaskOutputRequest(
  target: string,
): ExecutionDecodeResult<Required<ExecutionTaskOutputRequest>> {
  const invalid = { ok: false, reason: "invalid-payload" } as const;
  if (typeof target !== "string" || target.includes("#")) return invalid;
  const queryAt = target.indexOf("?");
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const query = queryAt === -1 ? "" : target.slice(queryAt + 1);
  const route = ROUTE.exec(path);
  if (!route) return invalid;
  const sessionId = decodedSegment(route[1]!);
  const taskId = decodedSegment(route[2]!);
  if (!isSessionId(sessionId) || !isTaskId(taskId)) return invalid;
  let tail: number = EXECUTION_TASK_OUTPUT_MAX_BYTES;
  if (query !== "") {
    const parameters = query.split("&");
    const value = parameters[0]?.startsWith("tail=")
      ? parameters[0].slice("tail=".length)
      : null;
    if (parameters.length !== 1 || value === null || !TAIL.test(value)) {
      return invalid;
    }
    tail = Number(value);
    if (!isTail(tail)) return invalid;
  }
  return { ok: true, value: { sessionId, taskId, tail } };
}

/**
 * The body of a host's answer, its fields always in the same order. Throws a
 * `TypeError` for an answer `decodeExecutionTaskOutputResponse` would refuse:
 * a window past the cap, text past its cap, or `truncated` that contradicts
 * `startOffset`.
 */
export function encodeExecutionTaskOutputResponse(
  response: ExecutionTaskOutputResponse,
): string {
  const body = JSON.stringify({
    sessionId: response.sessionId,
    taskId: response.taskId,
    status: response.status,
    text: response.text,
    startOffset: response.startOffset,
    totalBytes: response.totalBytes,
    truncated: response.truncated,
    readAt: response.readAt,
  });
  if (!decodeExecutionTaskOutputResponse(JSON.parse(body)).ok) {
    throw new TypeError(
      `A task's output is a window of at most ${EXECUTION_TASK_OUTPUT_MAX_BYTES} bytes, from startOffset to totalBytes, truncated exactly when startOffset is past 0; text of at most ${EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH} characters, empty for an empty window; a known status; and readAt an RFC 3339 timestamp`,
    );
  }
  return body;
}

/**
 * Reads a host's answer. Fields it does not know are ignored; every field it
 * knows is required and checked, the window's bound included, so an answer
 * past the cap is refused, never read.
 */
export function decodeExecutionTaskOutputResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTaskOutputResponse> {
  if (
    !isRecord(raw) ||
    !isSessionId(raw.sessionId) ||
    !isTaskId(raw.taskId) ||
    typeof raw.status !== "string" ||
    !STATUSES.has(raw.status) ||
    typeof raw.text !== "string" ||
    raw.text.length > EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH ||
    !isSafeNonNegativeInteger(raw.startOffset) ||
    !isSafeNonNegativeInteger(raw.totalBytes) ||
    raw.startOffset > raw.totalBytes ||
    raw.totalBytes - raw.startOffset > EXECUTION_TASK_OUTPUT_MAX_BYTES ||
    raw.truncated !== raw.startOffset > 0 ||
    (raw.startOffset === raw.totalBytes && raw.text !== "") ||
    !isTimestamp(raw.readAt)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      sessionId: raw.sessionId,
      taskId: raw.taskId,
      status: raw.status as AgentRunStatus,
      text: raw.text,
      startOffset: raw.startOffset,
      totalBytes: raw.totalBytes,
      truncated: raw.truncated,
      readAt: raw.readAt,
    },
  };
}

/**
 * Reads a host's refusal. A code this build does not know is
 * `invalid-payload`: the status is then all a reader has to go on.
 */
export function decodeExecutionTaskOutputRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTaskOutputRefusal> {
  if (
    !isRecord(raw) ||
    typeof raw.error !== "string" ||
    typeof raw.code !== "string" ||
    !REFUSAL_CODES.has(raw.code)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      error: raw.error,
      code: raw.code as ExecutionTaskOutputRefusalCode,
    },
  };
}

/**
 * The text of a window, before redaction, as a host makes it: `bytes` are the
 * file's from `offset` to its end. When `offset` is past 0, up to 3 leading
 * UTF-8 continuation bytes — the rest of a character the tail cut — are
 * skipped, and `startOffset` moves past them. The rest is decoded as UTF-8,
 * each invalid sequence as U+FFFD, a byte order mark kept. The host then
 * redacts `text` before it sends it.
 */
export function decodeExecutionTaskOutputWindow(
  bytes: Uint8Array,
  offset: number,
): { startOffset: number; text: string } {
  if (!isSafeNonNegativeInteger(offset)) {
    throw new RangeError("offset must be a whole number of bytes");
  }
  let skipped = 0;
  if (offset > 0) {
    while (skipped < 3 && ((bytes[skipped] ?? 0) & 0xc0) === 0x80) skipped++;
  }
  return {
    startOffset: offset + skipped,
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      bytes.subarray(skipped),
    ),
  };
}

function isSessionId(value: unknown): value is string {
  return isNonEmptyString(value) && value !== "." && value !== "..";
}

function isTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= EXECUTION_TASK_OUTPUT_TASK_ID_MAX_LENGTH &&
    TASK_ID.test(value)
  );
}

function isTail(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= EXECUTION_TASK_OUTPUT_MAX_BYTES
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

/** A path segment, percent-decoded; null when its escapes are broken. */
function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
