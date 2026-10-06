import {
  decodeExecutionOneShotRefusal,
  type ExecutionOneShotRefusalCode,
} from "../oneshot.js";

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
 * is unreadable; nothing was sent.
 * `provider-unknown`, `provider-unavailable`, `busy`, `failed`: the host's
 * refusal, by its code or else its status.
 * `timed-out`: the host's 504, or no answer before the client's deadline.
 * `rejected`: any other refusal (a 400, a 401, …); `status` says which.
 * `malformed`: a 2xx that is not a one-shot's answer, or is over the cap.
 */
export type ExecutionOneShotErrorCode =
  "unsupported" | ExecutionOneShotRefusalCode | "rejected" | "malformed";

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
  /** False only for `unsupported`: the prompt never left the client. */
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

const REASONS: Record<
  Exclude<ExecutionOneShotErrorCode, "unsupported">,
  string
> = {
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
 * proxy's.
 */
export function oneShotRefusal(
  status: number,
  body: string,
): ExecutionOneShotError {
  let code: Exclude<ExecutionOneShotErrorCode, "unsupported" | "malformed">;
  const coded =
    status === 401 || status === 403
      ? null
      : decodeExecutionOneShotRefusal(parseOrNull(body));
  if (coded?.ok) code = coded.value.code;
  else if (status === 404) code = "provider-unknown";
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

export function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
