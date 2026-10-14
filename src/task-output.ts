import { isRecord, isSafeNonNegativeInteger } from "./guards.js";
import type { AgentRunStatus } from "./harness-evidence.js";
import type { ExecutionDecodeResult } from "./types.js";

/**
 * A task's output (`tasks.output.v1`, MAR-3981): authenticated
 * `GET /v0/execution/sessions/:sessionId/tasks/:taskId/output?tail=<bytes>`,
 * the end of what one task — a background command — has written, at most
 * 64 KiB of the file, with the task's status.
 *
 * The request names a session and a task, never a file. The host serves only
 * a task its own record of that session knows. It takes the file's path from
 * the provider's structured event for the task, or derives it as
 * `<the session's own provider task directory>/<taskId>.output`; never from
 * tool-result or any other text a model or a tool wrote. It reads only a
 * regular file, linked once, directly inside that session's own task
 * directory. Nothing in the request is ever part of a path the host opens
 * except the task id, whose grammar cannot form one.
 *
 * The answer is text the host has redacted, as it redacts every other text it
 * sends, not the file's bytes, and its window holds whole lines only, so a
 * secret is never cut at its edges (see `decodeExecutionTaskOutputWindow`).
 */

/** The most of the file a tail may ask for, and the longest window an answer covers. */
export const EXECUTION_TASK_OUTPUT_MAX_BYTES = 65_536;

/**
 * The longest `text`, in UTF-16 code units (JavaScript string length). A
 * window of at most `EXECUTION_TASK_OUTPUT_MAX_BYTES` decodes to at most this
 * many. A host whose redaction lengthens it past the cap makes the window
 * again with half the tail, and halves again until the text fits.
 */
export const EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH = 65_536;

/** The longest task id. */
export const EXECUTION_TASK_OUTPUT_TASK_ID_MAX_LENGTH = 256;

/** The longest session id this route can name. */
export const EXECUTION_TASK_OUTPUT_SESSION_ID_MAX_LENGTH = 256;

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
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** A control character, C0, DEL or C1. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A surrogate without its pair: not text, and not encodable as UTF-8. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A task's status, as `SessionTask.status` in its evidence names it. */
export const EXECUTION_TASK_OUTPUT_STATUSES = [
  "running",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const satisfies readonly AgentRunStatus[];

/**
 * The statuses of a task whose process has ended, so its output file is
 * whole: a last line without a line break is shown, not held back.
 */
const FINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export interface ExecutionTaskOutputRequest {
  /**
   * 1 to 256 characters, with no `/`, `\\`, control character or lone
   * surrogate, and not `.` or `..` — before or after NFKC normalization, so
   * a fullwidth `．．` or `／` is refused too.
   */
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
 * - The window is the file's bytes from `startOffset` to `endOffset`, whole
 *   lines only (`decodeExecutionTaskOutputWindow`). It starts at most `tail`
 *   bytes before `totalBytes`: `totalBytes - startOffset <= tail`.
 *   `truncated` is true exactly when it starts after the file's first byte.
 *   `endOffset` is before `totalBytes` only while the task may still write:
 *   its last line, not yet ended by a line break, is held back.
 * - `text` is that window decoded as UTF-8 and redacted by the host. Each
 *   invalid sequence is U+FFFD, and a byte order mark is a character like any
 *   other.
 * - Redaction rewrites the text, so its length says nothing about the
 *   window's: the offsets are positions in the file, not in `text`.
 */
export interface ExecutionTaskOutputResponse {
  sessionId: string;
  taskId: string;
  /** The task's status when the host read its output. */
  status: AgentRunStatus;
  /** Host-redacted, at most `EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH` long. */
  text: string;
  /** The byte the window starts at: 0 when it holds the file's start. */
  startOffset: number;
  /**
   * The byte after the window's last: `totalBytes`, unless a running task's
   * unfinished last line is held back.
   */
  endOffset: number;
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
 *   file is not directly inside the session's own task directory, is not a
 *   regular file, or is linked more than once; or it serves no output for
 *   tasks of this kind.
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
      `sessionId must be 1 to ${EXECUTION_TASK_OUTPUT_SESSION_ID_MAX_LENGTH} characters, with no '/', '\\', control character or lone surrogate, and not a dot segment, before or after NFKC normalization`,
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
 * Reads a task-output request target — its path and query, raw, as on the
 * request line (`/v0/execution/sessions/s/tasks/t/output?tail=4096`) — as a
 * host does. A host passes the target it received, not its framework's
 * decoded params, which may have been normalized on the way. Strict: the
 * query holds `tail` once or not at all, and nothing else — not even an
 * empty `?` — so a `path` or `file` parameter is refused rather than
 * ignored. An absent `tail` is the most, `EXECUTION_TASK_OUTPUT_MAX_BYTES`.
 */
export function decodeExecutionTaskOutputRequest(
  target: string,
): ExecutionDecodeResult<Required<ExecutionTaskOutputRequest>> {
  const invalid = { ok: false, reason: "invalid-payload" } as const;
  if (typeof target !== "string" || target.includes("#")) return invalid;
  const queryAt = target.indexOf("?");
  const path = queryAt === -1 ? target : target.slice(0, queryAt);
  const query = queryAt === -1 ? null : target.slice(queryAt + 1);
  const route = ROUTE.exec(path);
  if (!route) return invalid;
  const sessionId = decodedSegment(route[1]!);
  const taskId = decodedSegment(route[2]!);
  if (!isSessionId(sessionId) || !isTaskId(taskId)) return invalid;
  let tail: number = EXECUTION_TASK_OUTPUT_MAX_BYTES;
  if (query !== null) {
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
    endOffset: response.endOffset,
    totalBytes: response.totalBytes,
    truncated: response.truncated,
    readAt: response.readAt,
  });
  if (!decodeExecutionTaskOutputResponse(JSON.parse(body)).ok) {
    throw new TypeError(
      `A task's output is a window from startOffset to endOffset, no later than totalBytes, starting at most ${EXECUTION_TASK_OUTPUT_MAX_BYTES} bytes before totalBytes and ending there once the task has ended; truncated exactly when startOffset is past 0; text of at most ${EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH} characters with no lone surrogate, empty for an empty window; a known status; and readAt an RFC 3339 timestamp`,
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
    LONE_SURROGATE.test(raw.text) ||
    !isSafeNonNegativeInteger(raw.startOffset) ||
    !isSafeNonNegativeInteger(raw.endOffset) ||
    !isSafeNonNegativeInteger(raw.totalBytes) ||
    raw.startOffset > raw.endOffset ||
    raw.endOffset > raw.totalBytes ||
    raw.totalBytes - raw.startOffset > EXECUTION_TASK_OUTPUT_MAX_BYTES ||
    (FINAL_STATUSES.has(raw.status) && raw.endOffset !== raw.totalBytes) ||
    raw.truncated !== raw.startOffset > 0 ||
    (raw.startOffset === raw.endOffset && raw.text !== "") ||
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
      endOffset: raw.endOffset,
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
 * The bytes a host reads for a tail: one `pread` of `length` bytes at
 * `position`, sized from one `fstat` of the open file, so a file that grows
 * meanwhile cannot push the read past the tail. It starts one byte before the
 * tail reaches, so the window can tell whether its first byte begins a line.
 */
export function executionTaskOutputReadRange(
  size: number,
  tail: number,
): { position: number; length: number } {
  if (!isSafeNonNegativeInteger(size)) {
    throw new RangeError("size must be a whole number of bytes");
  }
  if (!isTail(tail)) {
    throw new RangeError(
      `tail must be a whole number of bytes from 1 to ${EXECUTION_TASK_OUTPUT_MAX_BYTES}`,
    );
  }
  const position = Math.max(0, size - tail - 1);
  return { position, length: size - position };
}

/** The part of an answer a host makes from the bytes it read. */
export interface ExecutionTaskOutputWindow {
  startOffset: number;
  endOffset: number;
  totalBytes: number;
  truncated: boolean;
  /** Not yet redacted: the host redacts it before it sends it. */
  text: string;
}

/**
 * A task's window, before redaction, as a host makes it. `bytes` are the
 * file's from `position` to its end (`totalBytes` is `position` plus their
 * length), as `executionTaskOutputReadRange` asked for: they reach at least
 * one byte before the tail, or the file's start.
 *
 * The window holds whole lines only, a line ending at `\n` (0x0A):
 *
 * - **Its start.** Within the tail, it starts at the first line start: the
 *   file's first byte, or a byte after `\n`. When the tail cuts a line, that
 *   line is left out whole; when no line starts within the tail, the window
 *   is empty at `totalBytes`.
 * - **Its end.** While the task may still write (`running`, `unknown`), a
 *   last line not yet ended by `\n` is held back: `endOffset` is the byte
 *   after the window's last `\n`, or `startOffset`. Once the task has ended
 *   the file is whole, and the window ends at `totalBytes`.
 *
 * Why lines: a host redacts exact secret values, and a value it cannot see
 * whole it cannot recognise. A window cut one byte into a secret, or a file
 * that ends mid-secret because a running command flushed half a line, would
 * show what the redaction missed. No credential holds a line break, so whole
 * lines hold every secret whole or not at all. A secret value that does hold
 * one (a PEM key) the host redacts line by line too.
 *
 * The bytes kept are decoded as UTF-8, each invalid sequence as U+FFFD, a
 * byte order mark kept. A character is never cut: no UTF-8 sequence holds
 * 0x0A, so a line boundary is always a character boundary.
 */
export function decodeExecutionTaskOutputWindow(
  bytes: Uint8Array,
  position: number,
  tail: number,
  status: AgentRunStatus,
): ExecutionTaskOutputWindow {
  if (!isSafeNonNegativeInteger(position)) {
    throw new RangeError("position must be a whole number of bytes");
  }
  if (!isTail(tail)) {
    throw new RangeError(
      `tail must be a whole number of bytes from 1 to ${EXECUTION_TASK_OUTPUT_MAX_BYTES}`,
    );
  }
  if (!STATUSES.has(status)) throw new RangeError(`unknown status ${status}`);
  const totalBytes = position + bytes.byteLength;
  const floor = Math.max(0, totalBytes - tail);
  if (floor === 0 ? position !== 0 : position >= floor) {
    throw new RangeError(
      "bytes must reach at least one byte before the tail, or the file's start",
    );
  }
  const LF = 0x0a;
  // The first line start at or after the floor, as an index into `bytes`.
  let start = floor - position;
  if (floor > 0 && bytes[start - 1] !== LF) {
    const breakAt = bytes.indexOf(LF, start);
    start = breakAt === -1 ? bytes.byteLength : breakAt + 1;
  }
  let end = bytes.byteLength;
  if (!FINAL_STATUSES.has(status) && end > start && bytes[end - 1] !== LF) {
    const breakAt = bytes.lastIndexOf(LF, end - 1);
    end = breakAt < start ? start : breakAt + 1;
  }
  return {
    startOffset: position + start,
    endOffset: position + end,
    totalBytes,
    truncated: position + start > 0,
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      bytes.subarray(start, end),
    ),
  };
}

/**
 * A session id that is a safe path segment, as agents-daemon's
 * `assertSafeStorageSegment` takes one, here and after NFKC normalization.
 */
function isSessionId(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > EXECUTION_TASK_OUTPUT_SESSION_ID_MAX_LENGTH ||
    CONTROL.test(value) ||
    LONE_SURROGATE.test(value)
  ) {
    return false;
  }
  return isSafeSegment(value) && isSafeSegment(nfkc(value));
}

function isSafeSegment(value: string): boolean {
  return (
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** NFKC, or the value as it is where a runtime cannot normalize. */
function nfkc(value: string): string {
  try {
    return value.normalize("NFKC");
  } catch {
    return value;
  }
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

/** A timestamp whose every field is in range: no `2026-02-30`, no `T24:00`. */
function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return (
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysInMonth &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    offsetHour! <= 23 &&
    offsetMinute! <= 59
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
