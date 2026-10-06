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

/**
 * `requirements-unenforced`: the host does not advertise `start.requires.v1`,
 * or its descriptor is unreadable, so it might ignore `requires` and start
 * anyway; nothing was sent.
 * `requirements-unmet`: the host refused the start because it lacks traits.
 * `requirements-unconfirmed`: the host started the session but its answer
 * does not echo the traits it checked, so it may be running without them.
 */
export type ExecutionStartRequirementsErrorCode =
  "requirements-unenforced" | "requirements-unmet" | "requirements-unconfirmed";

/**
 * A start whose `requires` this host cannot be trusted with (MAR-3725): one a
 * caller can branch on to say "this host can't run iOS work", without reading
 * the host's prose. Not an `ExecutionHostError`: a caller converting errors
 * checks for both. Unenforced or unmet, no session started; unconfirmed, one
 * did, and `sessionId` names it for the caller to delete or keep.
 */
export class ExecutionStartRequirementsError extends Error {
  readonly code: ExecutionStartRequirementsErrorCode;
  readonly operation = "start";
  /** What the start required. */
  readonly requires: string[];
  /**
   * The required traits the host said it lacks: only ones in `requires`,
   * never the host's own words. Null when it was not asked, or named none.
   */
  readonly missingTraits: string[] | null;
  /** The host's status for its answer; null when nothing was sent. */
  readonly status: number | null;
  /** The session the host started without confirming; null otherwise. */
  readonly sessionId: string | null;
  /** Safe to show: the host's words, or why nothing was sent. */
  readonly reason: string;

  constructor(
    code: ExecutionStartRequirementsErrorCode,
    reason: string,
    details: {
      requires: string[];
      missingTraits?: string[] | null;
      status?: number | null;
      sessionId?: string | null;
    },
  ) {
    const status = details.status ?? null;
    super(
      `start failed: ${status === null ? code : `HTTP ${status}`}: ${reason}`,
    );
    this.name = "ExecutionStartRequirementsError";
    this.code = code;
    this.requires = [...details.requires];
    this.missingTraits = details.missingTraits
      ? [...details.missingTraits]
      : null;
    this.status = status;
    this.sessionId = details.sessionId ?? null;
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

/** Takes the token out of a sentence before anyone can read it. */
export type Scrub = (text: string) => string;

/**
 * Replaces every spelling of the token a message could carry — as sent, and
 * URL-encoded — with `[token]`. An error message is the one place a token can
 * escape the header it was given to: a runtime quoting the header it refused,
 * or a proxy quoting the request it rejected.
 */
export function scrubberFor(token: string): Scrub {
  const spellings = [...new Set([token, encodeURIComponent(token)])].filter(
    (spelling) => spelling.length > 0,
  );
  return (text) =>
    spellings.reduce(
      (scrubbed, spelling) => scrubbed.split(spelling).join("[token]"),
      text,
    );
}

/**
 * The token as a header can carry it, or a `TypeError` that never repeats it.
 * Surrounding whitespace is dropped, as `fetch` drops it from a header value —
 * a token read from a file keeps working with its trailing newline. Anything
 * else outside printable ASCII is refused here, because `fetch` would refuse
 * it later in an error that quotes the whole header.
 */
export function usableToken(raw: unknown): string {
  if (typeof raw !== "string") throw new TypeError("token must be a string");
  const token = raw.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  if (!/^[\t\x20-\x7e]*$/.test(token)) {
    throw new TypeError(
      "token cannot be sent in an Authorization header: it holds a line break, a control character, or a character outside ASCII",
    );
  }
  return token;
}

/**
 * What a refusing host said: its JSON `error` or `message`, else its text,
 * else the status — with the token taken out. Reading the body is best
 * effort; a broken one still has a status.
 */
export async function reasonOf(
  response: Response,
  scrub: Scrub,
): Promise<string> {
  return reasonOfText(await refusalText(response), response.status, scrub);
}

/** A refusal's body, or nothing when it cannot be read. */
export async function refusalText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    // Unreadable: the status speaks for it.
    return "";
  }
}

/** `reasonOf`, for a body already read. */
export function reasonOfText(
  body: string,
  status: number,
  scrub: Scrub,
): string {
  return boundedReason(rawReasonOf(body, status), scrub);
}

/** A host's words made safe to carry: the token out, then cut to length. */
export function boundedReason(text: string, scrub: Scrub): string {
  // Scrubbed before it is cut, so a cut never leaves the start of a token.
  const reason = scrub(text);
  return reason.length > MAX_REASON_LENGTH
    ? `${reason.slice(0, MAX_REASON_LENGTH)}…`
    : reason;
}

function rawReasonOf(body: string, status: number): string {
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
  return text === "" ? `HTTP ${status}` : text;
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

/**
 * The longest delay a timer holds. Past it, Node and browsers fire at once,
 * so "thirty days" would mean "now" — every wait here is clamped to it, which
 * is as good as forever for a deadline.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/** A positive duration in milliseconds, or a `RangeError` naming `name`. */
export function positiveMs(value: number, name: string): number {
  if (!(value > 0)) {
    throw new RangeError(`${name} must be a positive number of milliseconds`);
  }
  return value;
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
    timer = setTimeout(
      () => {
        expired = true;
        controller.abort();
      },
      Math.min(timeoutMs, MAX_TIMER_MS),
    );
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
    scrub: Scrub;
  },
): unknown {
  if (context.callerSignal?.aborted) return error;
  if (error instanceof ExecutionHostError) return error;
  const cause = scrubbedCopy(error, context.scrub);
  if (context.deadline.expired) {
    return new ExecutionHostError("timeout", context.timeoutReason, {
      operation: context.operation,
      cause,
    });
  }
  return new ExecutionHostError(
    "network",
    `the connection failed (${cause.message})`,
    { operation: context.operation, cause },
  );
}

/**
 * A copy of a failure that is safe to hand on: its name, its message with the
 * token taken out, and the system code underneath it (`ECONNREFUSED`), which
 * is the useful half of a `fetch failed`. Never the original, whose message
 * — and whose causes' messages — may quote the header.
 */
function scrubbedCopy(error: unknown, scrub: Scrub): Error {
  const message = error instanceof Error ? error.message : String(error);
  const nested = error instanceof Error ? error.cause : undefined;
  const code =
    codeOf(error) ??
    (typeof nested === "object" && nested !== null ? codeOf(nested) : null);
  const copy = new Error(scrub(code ? `${message}: ${code}` : message));
  copy.name = error instanceof Error ? error.name : "Error";
  if (code) (copy as Error & { code?: string }).code = code;
  return copy;
}

function codeOf(value: unknown): string | null {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** A duration for a person: `90 s`, `1.5 s`, `250 ms`. */
export function seconds(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}
