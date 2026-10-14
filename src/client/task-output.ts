import {
  decodeExecutionTaskOutputRefusal,
  decodeExecutionTaskOutputResponse,
  encodeExecutionTaskOutputRequest,
  EXECUTION_TASK_OUTPUT_MAX_BYTES,
  EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES,
  type ExecutionTaskOutputRefusalCode,
  type ExecutionTaskOutputResponse,
} from "../task-output.js";
import type { ExecutionHostHealth } from "./health.js";

export interface ExecutionTaskOutputOptions {
  /**
   * How many bytes from the end of the output to read: a whole number from 1
   * to 65536. Default 65536.
   */
  tail?: number;
  signal?: AbortSignal;
  /** Overrides the client's health timeout for this read. */
  timeoutMs?: number;
}

/** The host's answer, checked against what was asked. */
export type ExecutionTaskOutputResult = ExecutionTaskOutputResponse;

/**
 * `unsupported`: the host answered 404 with no code, as a host without the
 * route — one that does not advertise `tasks.output.v1` — or a proxy does. A
 * 404 coded with a code this build does not know is `rejected`.
 * `session-unknown`, `task-unknown`, `no-output`, `read-refused`, `rejected`:
 * the host's refusal, by its code, honoured only with the status the protocol
 * gives it. `rejected` is also any other refusal (an uncoded 400, a 401, a
 * 5xx, …); `status` says which.
 * `malformed`: a 2xx that is not a task's output, is about another session or
 * task, holds a window longer than the tail asked for, or is over the cap.
 */
export type ExecutionTaskOutputErrorCode =
  "unsupported" | ExecutionTaskOutputRefusalCode | "malformed";

/**
 * A task-output read the host did not answer with output (MAR-3981), with a
 * code a caller branches on. Its `reason` is this client's own sentence,
 * never the host's: a refusal is no place for the host to name a path, and
 * the client does not carry one if it does. Not an `ExecutionHostError`, which
 * `taskOutput()` throws only when the host could not be reached or did not
 * answer in time.
 */
export class ExecutionTaskOutputError extends Error {
  readonly code: ExecutionTaskOutputErrorCode;
  readonly operation = "task output";
  /** The host's status. */
  readonly status: number;
  readonly sessionId: string;
  readonly taskId: string;
  readonly reason: string;

  constructor(
    code: ExecutionTaskOutputErrorCode,
    reason: string,
    details: { status: number; sessionId: string; taskId: string },
  ) {
    super(`task output failed: ${code} (HTTP ${details.status}): ${reason}`);
    this.name = "ExecutionTaskOutputError";
    this.code = code;
    this.status = details.status;
    this.sessionId = details.sessionId;
    this.taskId = details.taskId;
    this.reason = reason;
  }
}

/**
 * The most of an answer's body the client reads: the longest text the
 * protocol allows, every character escaped (`\uXXXX`), with room to spare.
 */
export const TASK_OUTPUT_ANSWER_MAX_BYTES = 512 * 1024;

/** The most of a refusal's body the client reads for its code. */
export const TASK_OUTPUT_REFUSAL_MAX_BYTES = 64 * 1024;

const REASONS: Record<ExecutionTaskOutputErrorCode, string> = {
  unsupported: "the host does not serve task output",
  "session-unknown": "the host has no such session",
  "task-unknown": "the session has no such task",
  "no-output": "the task has no output file",
  "read-refused": "the host's policy refused to read the task's output",
  rejected: "the host refused the read",
  malformed: "the answer is not the task's output",
};

/** Whether the host advertises `tasks.output.v1` (MAR-3981). */
export function hostReadsTaskOutput(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("tasks.output.v1");
}

const OPTIONS: ReadonlySet<string> = new Set(["tail", "signal", "timeoutMs"]);

/**
 * The request target, read from the caller's options once. A `TypeError`
 * before anything is sent for an id the route cannot name or an option it
 * does not take — refused, not dropped: a caller who passed `path` or `file`
 * must learn the read names a task and nothing else. A `RangeError` for a
 * `tail` out of bounds.
 */
export function prepareTaskOutput(
  sessionId: string,
  taskId: string,
  options: ExecutionTaskOutputOptions,
): { target: string; tail: number } {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(
      `A task-output read takes tail, signal and timeoutMs, and nothing else; it names a task, never a file, and has no ${unknown.join(", ")}`,
    );
  }
  const tail = options.tail ?? EXECUTION_TASK_OUTPUT_MAX_BYTES;
  return {
    target: encodeExecutionTaskOutputRequest({ sessionId, taskId, tail }),
    tail,
  };
}

/**
 * What a refusal means: the host's code where it gave a known one with the
 * status the protocol gives it, else its status. Only a 404 with no code at
 * all is no route: a host with the route codes every 404, so one coded with
 * a code this build does not know (a newer host's) is `rejected`, never
 * `unsupported`, and a caller does not hide the read for good.
 */
export function taskOutputRefusal(
  status: number,
  body: string,
  asked: { sessionId: string; taskId: string },
): ExecutionTaskOutputError {
  const parsed = parseOrNull(body);
  const coded = decodeExecutionTaskOutputRefusal(parsed);
  const hasCode =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { code?: unknown }).code === "string";
  let code: Exclude<ExecutionTaskOutputErrorCode, "malformed">;
  if (
    coded.ok &&
    EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES[coded.value.code] === status
  ) {
    code = coded.value.code;
  } else if (status === 404 && !hasCode) code = "unsupported";
  else code = "rejected";
  return new ExecutionTaskOutputError(code, REASONS[code], {
    status,
    ...asked,
  });
}

/**
 * The task's output in a 2xx body, or an `ExecutionTaskOutputError` coded
 * `malformed`: one that does not decode, names another session or task, or
 * holds more than the tail asked for.
 */
export function readTaskOutputAnswer(
  status: number,
  body: string | null,
  asked: { sessionId: string; taskId: string; tail: number },
): ExecutionTaskOutputResult {
  const failure = (detail: string) =>
    new ExecutionTaskOutputError(
      "malformed",
      `${REASONS.malformed}: ${detail}`,
      { status, sessionId: asked.sessionId, taskId: asked.taskId },
    );
  if (body === null) {
    throw failure(`it is longer than ${TASK_OUTPUT_ANSWER_MAX_BYTES} bytes`);
  }
  const decoded = decodeExecutionTaskOutputResponse(parseOrNull(body));
  if (!decoded.ok) throw failure("it does not decode");
  const output = decoded.value;
  if (output.sessionId !== asked.sessionId || output.taskId !== asked.taskId) {
    throw failure("it is about another task");
  }
  if (output.totalBytes - output.startOffset > asked.tail) {
    throw failure(
      `its window is longer than the ${asked.tail} bytes asked for`,
    );
  }
  return output;
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
