import {
  decodeExecutionOneShotRefusal,
  decodeExecutionOneShotRequest,
  decodeExecutionOneShotResponse,
  encodeExecutionOneShotRequest,
  EXECUTION_ONESHOT_CONTRACT,
  EXECUTION_ONESHOT_DEFAULT_TIMEOUT_MS,
  type ExecutionOneShotRefusalCode,
} from "../oneshot.js";
import { ExecutionHostError } from "./http.js";

export interface ExecutionOneShotOptions {
  /** The provider the host answers with: `claude`, `codex`, … */
  provider: string;
  /** The model it runs, as the host's catalogue names it. */
  model: string;
  effort?: string;
  /** Data, not instructions to the host: it runs no tools on its account. */
  prompt: string;
  /**
   * How long the provider may take, sent to the host, which bounds it at
   * 120 s. The client waits that long, or the host's 45 s default when
   * absent, plus 10 s for the host to say so.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecutionOneShotResult {
  text: string;
}

/**
 * `unsupported`: the host does not advertise `oneshot.v1`, or its descriptor
 * is unreadable, and nothing was sent; or it answered 404 with no code, as a
 * host without the route, or a proxy, does.
 * `provider-unknown`, `provider-unavailable`, `busy`, `failed`: the host's
 * refusal, by its code or else its status.
 * `timed-out`: the host's 504, or no answer before the client's deadline.
 * `rejected`: the host's 400 coded so — it will not take the body — or any
 * other refusal (an uncoded 400, a 401, …); `status` says which.
 * `malformed`: a 2xx that is not a one-shot's answer, or is over the cap.
 */
export type ExecutionOneShotErrorCode =
  "unsupported" | ExecutionOneShotRefusalCode | "malformed";

/**
 * A one-shot that gave no answer (MAR-3775), with a code a caller branches on.
 * Its `reason` is this client's own sentence, never the host's: a refusal may
 * quote the prompt, and an answer it could not read may be anything — so
 * neither the prompt, the answer, nor the token is ever in it. Not an
 * `ExecutionHostError`, which `oneShot()` throws only when the host could not
 * be reached at all, or its `/health` could not be read.
 */
export class ExecutionOneShotError extends Error {
  readonly code: ExecutionOneShotErrorCode;
  readonly operation = "oneshot";
  /** The host's status; null when it gave none, or nothing was sent. */
  readonly status: number | null;
  /** False when the client refused it before sending: the prompt never left. */
  readonly sent: boolean;
  readonly reason: string;

  constructor(
    code: ExecutionOneShotErrorCode,
    reason: string,
    details: { status?: number | null; sent: boolean },
  ) {
    const status = details.status ?? null;
    super(
      `oneshot failed: ${code}${status === null ? "" : ` (HTTP ${status})`}: ${reason}`,
    );
    this.name = "ExecutionOneShotError";
    this.code = code;
    this.status = status;
    this.sent = details.sent;
    this.reason = reason;
  }
}

/**
 * The most of an answer's body the client reads: the longest text the
 * protocol allows, every character escaped (`\uXXXX`), with room to spare.
 */
export const ONESHOT_ANSWER_MAX_BYTES = 512 * 1024;

/** The most of a refusal's body the client reads for its code. */
export const ONESHOT_REFUSAL_MAX_BYTES = 64 * 1024;

/** How long past the provider's timeout the client waits for the host. */
export const ONESHOT_GRACE_MS = 10_000;

const REASONS: Record<ExecutionOneShotErrorCode, string> = {
  unsupported: "the host has no one-shot route",
  "provider-unknown": "the host has no such provider",
  "provider-unavailable": "the provider cannot answer one-shots now",
  busy: "the host is answering as many one-shots as it will",
  "timed-out": "the provider did not answer in time",
  failed: "the provider failed to answer",
  rejected: "the host refused the one-shot",
  malformed: "the answer is not a one-shot's",
};

/**
 * What a refusal means: the host's code where it gave a known one, else its
 * status. A 401 or 403 is the token's, whatever the body says — it may be a
 * proxy's. A 404 with no code is no route, not an unknown provider: a host
 * with the route names its 404.
 */
export function oneShotRefusal(
  status: number,
  body: string,
): ExecutionOneShotError {
  let code: Exclude<ExecutionOneShotErrorCode, "malformed">;
  const coded =
    status === 401 || status === 403
      ? null
      : decodeExecutionOneShotRefusal(parseOrNull(body));
  if (coded?.ok) code = coded.value.code;
  else if (status === 404) code = "unsupported";
  else if (status === 422 || status === 503) code = "provider-unavailable";
  else if (status === 429) code = "busy";
  else if (status === 504) code = "timed-out";
  else if (status >= 500) code = "failed";
  else code = "rejected";
  return new ExecutionOneShotError(code, REASONS[code], {
    status,
    sent: true,
  });
}

/**
 * A one-shot that never reached the host, in the client's own words. Not the
 * transport's: a `fetch` may quote the request it failed to send, prompt and
 * all, so neither its message nor the error itself is carried.
 */
export function oneShotUnreachable(): ExecutionHostError {
  return new ExecutionHostError(
    "network",
    "the connection to the host failed",
    { operation: "oneshot" },
  );
}

export function oneShotFailure(
  code: "timed-out" | "malformed",
  status: number | null,
  detail?: string,
): ExecutionOneShotError {
  return new ExecutionOneShotError(
    code,
    detail === undefined ? REASONS[code] : `${REASONS[code]}: ${detail}`,
    { status, sent: true },
  );
}

/**
 * A body read up to `maxBytes` and no further, or null when it is longer: a
 * host cannot make the client hold more than that. A `fetch` with no body
 * stream (older React Native) is read whole and then measured.
 */
export async function readAtMost(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (response.body === null) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The answer in a 2xx body, or null when it is not one. */
export function readOneShotAnswer(text: string): ExecutionOneShotResult | null {
  const decoded = decodeExecutionOneShotResponse(parseOrNull(text));
  return decoded.ok ? decoded.value : null;
}

const ONESHOT_OPTIONS: ReadonlySet<string> = new Set([
  "provider",
  "model",
  "effort",
  "prompt",
  "timeoutMs",
  "signal",
]);

/** A one-shot as asked, read from the caller's options once. */
export interface PreparedOneShot {
  /** The body, always under `contract: "oneshot.v1"`. */
  body: string;
  /** How long the client waits: the provider's time, then the host's grace. */
  deadlineMs: number;
  signal: AbortSignal | undefined;
}

/**
 * Reads every option once, before anything is awaited, so the body, the
 * deadline and the signal are all the call's: a caller changing its options
 * object while `/health` is read changes nothing. A `TypeError` before
 * anything is sent for a value the protocol refuses, or an option it does not
 * know — refused, not dropped: a caller who passed `tools` must learn it asked
 * for nothing. No message repeats the prompt.
 */
export function prepareOneShot(
  options: ExecutionOneShotOptions,
): PreparedOneShot {
  const unknown = Object.keys(options).filter(
    (key) => !ONESHOT_OPTIONS.has(key),
  );
  if (unknown.length > 0) {
    throw new TypeError(
      `A one-shot takes provider, model, effort, prompt, timeoutMs and signal, and nothing else; it has no ${unknown.join(", ")}`,
    );
  }
  const { provider, model, effort, prompt, timeoutMs, signal } = options;
  const body = encodeExecutionOneShotRequest({
    contract: EXECUTION_ONESHOT_CONTRACT,
    providerId: provider,
    model,
    ...(effort === undefined ? {} : { effort }),
    prompt,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (!decodeExecutionOneShotRequest(body).ok) {
    throw new TypeError(
      "A one-shot names a provider and a model, each an id of 1 to 256 characters that is not blank, an effort only as such an id, a prompt that is not blank and at most 65536 characters, and a timeoutMs only as a whole number of milliseconds from 1 to 120000",
    );
  }
  return {
    body,
    deadlineMs:
      (timeoutMs ?? EXECUTION_ONESHOT_DEFAULT_TIMEOUT_MS) + ONESHOT_GRACE_MS,
    signal,
  };
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
