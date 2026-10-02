/**
 * The HTTP plumbing every call shares: one error type a caller can branch on,
 * deadlines that cover the body as well as the headers, and the host's own
 * words when it refuses. The token goes into an `Authorization` header and
 * nowhere else — never into a URL, an error, or a log line.
 */

/**
 * `network`: the host could not be reached, or the connection broke.
 * `timeout`: no answer — or, on an event stream, no bytes at all — in time.
 * `auth`: the host refused the token (401, 403).
 * `not-found`: the host has no such session (404).
 * `http`: any other refusal.
 * `malformed`: a successful answer this client could not read.
 */
export type ExecutionHostErrorKind =
  "network" | "timeout" | "auth" | "not-found" | "http" | "malformed";

export class ExecutionHostError extends Error {
  readonly kind: ExecutionHostErrorKind;
  /** What was being asked: `start`, `command stop`, `events`, … */
  readonly operation: string;
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /**
   * What the host said went wrong — its JSON `error` or `message`, or its text
   * — or what went wrong on the way. Safe to show: it never carries the token.
   */
  readonly reason: string;

  constructor(
    kind: ExecutionHostErrorKind,
    reason: string,
    details: { operation: string; status?: number | null; cause?: unknown },
  ) {
    const status = details.status ?? null;
    super(
      `${details.operation} failed: ${status === null ? kind : `HTTP ${status}`}: ${reason}`,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "ExecutionHostError";
    this.kind = kind;
    this.operation = details.operation;
    this.status = status;
    this.reason = reason;
  }
}

export function kindOfStatus(status: number): ExecutionHostErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  return "http";
}

/** The longest stretch of a refusal's body worth carrying into an error. */
const MAX_REASON_LENGTH = 500;

/**
 * What a refusing host said: its JSON `error` or `message`, else its text,
 * else the status. Reading the body is best effort; a broken one still has a
 * status.
 */
export async function reasonOf(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // Unreadable: the status speaks for it.
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const { error, message } = parsed as {
        error?: unknown;
        message?: unknown;
      };
      if (typeof error === "string" && error.trim() !== "") return error.trim();
      if (typeof message === "string" && message.trim() !== "") {
        return message.trim();
      }
    }
  } catch {
    // Not JSON: its text says it.
  }
  const text = body.trim();
  if (text === "") return `HTTP ${response.status}`;
  return text.length > MAX_REASON_LENGTH
    ? `${text.slice(0, MAX_REASON_LENGTH)}…`
    : text;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/**
 * One abort signal for a request that the caller may cancel and a deadline
 * may cut off, and which of the two did it. Composed by hand rather than with
 * `AbortSignal.any` / `AbortSignal.timeout`, which older Node 20 releases and
 * React Native's Hermes do not all have.
 */
export interface Deadline {
  signal: AbortSignal;
  /** True once the deadline, not the caller, cut the request off. */
  readonly expired: boolean;
  /** Restarts the clock: the request is waiting on the host again. */
  extend(): void;
  /** Stops the clock without ending anything: the caller is busy, not the host. */
  pause(): void;
  /** Stops the clock and lets go of the caller's signal. */
  dispose(): void;
  /** Tears the request down, whatever state it is in. */
  close(): void;
}

export function startDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | null,
): Deadline {
  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  const arm = () => {
    if (timeoutMs === null || !Number.isFinite(timeoutMs)) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
  };

  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  arm();

  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    extend: () => {
      if (!controller.signal.aborted) arm();
    },
    pause: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
    close: () => {
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

/**
 * The error a failed `fetch` or body read becomes. A caller's own abort is
 * handed back as it came — the caller asked for it — and everything else is an
 * `ExecutionHostError` the caller can branch on.
 */
export function failureOf(
  error: unknown,
  context: {
    operation: string;
    deadline: Deadline;
    callerSignal: AbortSignal | undefined;
    /** What to say when the deadline, not the network, ended it. */
    timeoutReason: string;
  },
): unknown {
  if (context.callerSignal?.aborted) return error;
  if (error instanceof ExecutionHostError) return error;
  if (context.deadline.expired) {
    return new ExecutionHostError("timeout", context.timeoutReason, {
      operation: context.operation,
      cause: error,
    });
  }
  return new ExecutionHostError(
    "network",
    `the connection failed (${error instanceof Error ? error.message : String(error)})`,
    { operation: context.operation, cause: error },
  );
}

/** A duration for a person: `90 s`, `1.5 s`, `250 ms`. */
export function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}
