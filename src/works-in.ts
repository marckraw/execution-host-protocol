import { isBoundedString, isRecord } from "./guards.js";

/**
 * Where a session started in a person's own checkout works (MAR-5673): a
 * start's `config.worksIn`, on a host advertising `start.worksIn.v1`. It
 * applies to a start that names a `workingDirectory` in a git checkout and no
 * `workspace` to clone; a host ignores it anywhere else (a clone, scratch, a
 * folder that is no checkout).
 *
 * - `auto` (the default, as when absent): the checkout when no session is
 *   working in it, else a worktree of its own.
 * - `checkout`: the checkout, only while nobody else is working in it. A host
 *   never puts two sessions to work in one checkout: while another works
 *   there it refuses the start, with a 409 coded `checkout-taken` that names
 *   who (`ExecutionCheckoutTakenRefusal`), and starts nothing. Judged and
 *   claimed at once, so of two such starts at once one is refused.
 * - `worktree`: a worktree of its own, from the checkout's HEAD, always.
 *
 * A session holds its checkout from its start until it is deleted or fully
 * quiescent: no turn running, nothing queued for it, no task of its running,
 * and no turn of its provider's own still possible. The host takes the hold
 * once and drops it once; a session that let go of it takes it again before
 * any work of its begins, or is refused `checkout-taken`. A settle frees
 * nothing (0.41). A snapshot and the list say which are settled now
 * (`settled`), in the host's own word.
 */
export const EXECUTION_WORKS_IN = ["auto", "checkout", "worktree"] as const;
export type ExecutionWorksIn = (typeof EXECUTION_WORKS_IN)[number];

/** Whether `value` is one of `EXECUTION_WORKS_IN`. */
export function isExecutionWorksIn(value: unknown): value is ExecutionWorksIn {
  return (EXECUTION_WORKS_IN as readonly unknown[]).includes(value);
}

/** The places a start in a checkout can land: in it, or in a worktree of its own. */
export const EXECUTION_WORKS_IN_PLACES = ["checkout", "worktree"] as const;
export type ExecutionWorksInPlace = (typeof EXECUTION_WORKS_IN_PLACES)[number];

/** The most sessions an echo names as working in the checkout. */
export const EXECUTION_WORKS_IN_MAX_NAMED = 32;

const SESSION_ID_MAX_LENGTH = 256;
const PATH_MAX_LENGTH = 4096;

/**
 * Where a start in a checkout landed, as a `start.worksIn.v1` host's 201 says
 * it (`worksIn`): `checkout` or `worktree`, the checkout's top, and the
 * sessions that were working in it as it started, by id, at most
 * `EXECUTION_WORKS_IN_MAX_NAMED`: with `worktree` by `auto`, those that made
 * it take one. In the checkout, there are none.
 */
export interface ExecutionWorksInEcho {
  place: ExecutionWorksInPlace;
  checkoutRoot: string;
  workingThere: string[];
}

/**
 * Reads a 201's `worksIn` echo, or null where there is none or it doesn't
 * read: the session runs either way, so an echo this build can't read is
 * "not said", never a failed start.
 */
export function readExecutionWorksInEcho(
  raw: unknown,
): ExecutionWorksInEcho | null {
  if (!isRecord(raw)) return null;
  if (!(EXECUTION_WORKS_IN_PLACES as readonly unknown[]).includes(raw.place)) {
    return null;
  }
  if (!isBoundedString(raw.checkoutRoot, PATH_MAX_LENGTH)) return null;
  const working = raw.workingThere;
  if (
    !Array.isArray(working) ||
    working.length > EXECUTION_WORKS_IN_MAX_NAMED ||
    !working.every((id) => isBoundedString(id, SESSION_ID_MAX_LENGTH))
  ) {
    return null;
  }
  return {
    place: raw.place as ExecutionWorksInPlace,
    checkoutRoot: raw.checkoutRoot,
    workingThere: [...(working as string[])],
  };
}

/** The code of a `checkout` start refused because another session works there. */
export const EXECUTION_CHECKOUT_TAKEN = "checkout-taken";

/**
 * Why a host refused a start's `checkout` (MAR-5673), with a 409: another
 * session works in the checkout, `workingThere` by id (at most
 * `EXECUTION_WORKS_IN_MAX_NAMED`, never empty). Nothing was started; the same
 * start with `auto` or `worktree` works in a worktree of its own.
 */
export interface ExecutionCheckoutTakenRefusal {
  error: string;
  code: typeof EXECUTION_CHECKOUT_TAKEN;
  workingThere: string[];
}

/** Reads a 409's body as a `checkout-taken` refusal, or null where it is none. */
export function readExecutionCheckoutTakenRefusal(
  raw: unknown,
): ExecutionCheckoutTakenRefusal | null {
  if (!isRecord(raw) || raw.code !== EXECUTION_CHECKOUT_TAKEN) return null;
  if (typeof raw.error !== "string") return null;
  const working = raw.workingThere;
  if (
    !Array.isArray(working) ||
    working.length === 0 ||
    working.length > EXECUTION_WORKS_IN_MAX_NAMED ||
    !working.every((id) => isBoundedString(id, SESSION_ID_MAX_LENGTH))
  ) {
    return null;
  }
  return {
    error: raw.error,
    code: EXECUTION_CHECKOUT_TAKEN,
    workingThere: [...(working as string[])],
  };
}
