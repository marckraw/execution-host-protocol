import { isRecord } from "./guards.js";
import type { ExecutionDecodeResult } from "./types.js";

/**
 * One-shots (`oneshot.v1`, MAR-3775): authenticated `POST /v0/oneshot`, one
 * answer to one prompt from one of the host's providers. No tools, no
 * workspace, no session, and nothing remembered afterwards. The prompt is data
 * the caller may not trust; the host runs it as nothing more.
 *
 * The body is agents-daemon's route as it already is — `{ providerId, model,
 * effort?, prompt, timeoutMs? }`, answered with `{ text }` — plus one required
 * field, `contract: "oneshot.v1"`. A daemon released before `oneshot.v1` reads
 * the body strictly and refuses a field it does not know, so it refuses the
 * request rather than run an untrusted prompt with its tools on, whatever its
 * `/health` said a moment before.
 */

/** The value of a one-shot request's `contract`: the promise it is asked under. */
export const EXECUTION_ONESHOT_CONTRACT = "oneshot.v1";

/** The longest prompt, in UTF-16 code units (JavaScript string length). */
export const EXECUTION_ONESHOT_PROMPT_MAX_LENGTH = 65_536;

/** The longest answer text, in UTF-16 code units (JavaScript string length). */
export const EXECUTION_ONESHOT_TEXT_MAX_LENGTH = 65_536;

/** The longest a host lets a provider take, and the most `timeoutMs` may ask for. */
export const EXECUTION_ONESHOT_TIMEOUT_MAX_MS = 120_000;

/** What a host lets a provider take when the request does not say. */
export const EXECUTION_ONESHOT_DEFAULT_TIMEOUT_MS = 45_000;

/** The bound on a provider, model or effort id. */
const ONESHOT_ID_MAX_LENGTH = 256;

export interface ExecutionOneShotRequest {
  /**
   * Always `oneshot.v1`. A host that accepts it keeps the `oneshot.v1` promise
   * for this call; a request without it is not a `oneshot.v1` request.
   */
  contract: typeof EXECUTION_ONESHOT_CONTRACT;
  /** The provider the host answers with: `claude`, `codex`, … */
  providerId: string;
  /** The model it runs, as the host's catalogue names it. */
  model: string;
  effort?: string;
  /** Not blank, and at most `EXECUTION_ONESHOT_PROMPT_MAX_LENGTH` long. */
  prompt: string;
  /**
   * How long the provider may take, a whole number of milliseconds up to
   * `EXECUTION_ONESHOT_TIMEOUT_MAX_MS`. Absent, the host's default applies.
   */
  timeoutMs?: number;
}

export interface ExecutionOneShotResponse {
  /** At most `EXECUTION_ONESHOT_TEXT_MAX_LENGTH` long. May be empty. */
  text: string;
}

/**
 * Why a host refused a one-shot, with the status it answers:
 *
 * - `provider-unknown` (404): it has no provider by that id.
 * - `provider-unavailable` (503): the provider is not installed, not signed
 *   in, or does not answer one-shots.
 * - `busy` (429): it is answering as many one-shots as it will.
 * - `timed-out` (504): the provider did not answer within `timeoutMs`.
 * - `failed` (502): the provider failed to answer.
 */
export const EXECUTION_ONESHOT_REFUSAL_CODES = [
  "provider-unknown",
  "provider-unavailable",
  "busy",
  "timed-out",
  "failed",
] as const;
export type ExecutionOneShotRefusalCode =
  (typeof EXECUTION_ONESHOT_REFUSAL_CODES)[number];

/** A host's refusal body: `{ error, code }`. Other fields are ignored. */
export interface ExecutionOneShotRefusal {
  error: string;
  code: ExecutionOneShotRefusalCode;
}

const ONESHOT_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "contract",
  "providerId",
  "model",
  "effort",
  "prompt",
  "timeoutMs",
]);

const REFUSAL_CODES: ReadonlySet<string> = new Set(
  EXECUTION_ONESHOT_REFUSAL_CODES,
);

/** The body of `POST /v0/oneshot`, its fields always in the same order. */
export function encodeExecutionOneShotRequest(
  request: ExecutionOneShotRequest,
): string {
  return JSON.stringify({
    contract: request.contract,
    providerId: request.providerId,
    model: request.model,
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    prompt: request.prompt,
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
  });
}

/**
 * Reads the body of `POST /v0/oneshot`, as a host does. Strict, unlike the
 * protocol's readers of answers: a field this build does not know is refused,
 * not ignored, because a one-shot that silently dropped what a newer caller
 * asked for would answer a different question. `contract` must be exactly
 * `oneshot.v1`.
 */
export function decodeExecutionOneShotRequest(
  raw: string,
): ExecutionDecodeResult<ExecutionOneShotRequest> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (
    !isRecord(value) ||
    !Object.keys(value).every((field) => ONESHOT_REQUEST_FIELDS.has(field)) ||
    value.contract !== EXECUTION_ONESHOT_CONTRACT ||
    !isOneShotId(value.providerId) ||
    !isOneShotId(value.model) ||
    !(value.effort === undefined || isOneShotId(value.effort)) ||
    !isOneShotPrompt(value.prompt) ||
    !(value.timeoutMs === undefined || isOneShotTimeout(value.timeoutMs))
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      contract: EXECUTION_ONESHOT_CONTRACT,
      providerId: value.providerId,
      model: value.model,
      ...(value.effort === undefined ? {} : { effort: value.effort }),
      prompt: value.prompt,
      ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    },
  };
}

/** Reads a host's answer to a one-shot. Fields it does not know are ignored. */
export function decodeExecutionOneShotResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionOneShotResponse> {
  if (
    !isRecord(raw) ||
    typeof raw.text !== "string" ||
    raw.text.length > EXECUTION_ONESHOT_TEXT_MAX_LENGTH
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return { ok: true, value: { text: raw.text } };
}

/**
 * Reads a host's refusal of a one-shot. A code this build does not know is
 * `invalid-payload`: the status is then all a reader has to go on.
 */
export function decodeExecutionOneShotRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionOneShotRefusal> {
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
      code: raw.code as ExecutionOneShotRefusalCode,
    },
  };
}

/** An id a host can look up: not blank, and at most 256 characters. */
function isOneShotId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= ONESHOT_ID_MAX_LENGTH
  );
}

function isOneShotPrompt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= EXECUTION_ONESHOT_PROMPT_MAX_LENGTH
  );
}

function isOneShotTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= EXECUTION_ONESHOT_TIMEOUT_MAX_MS
  );
}
