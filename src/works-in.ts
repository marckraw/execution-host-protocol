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
 * - `checkout`: the checkout, whoever else is working in it. The host starts
 *   it there all the same, and its 201 says who (`ExecutionWorksInEcho`).
 * - `worktree`: a worktree of its own, from the checkout's HEAD, always.
 *
 * A session is working in a checkout while its turn runs, a task of its runs,
 * or something is queued for it, and nobody has settled it
 * (`ExecutionSessionPatchRequest.settled`). One that finished, failed or was
 * settled leaves the checkout to the next.
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
 * `EXECUTION_WORKS_IN_MAX_NAMED`. With `checkout`, those it shares the
 * checkout with; with `worktree` by `auto`, those that made it take one.
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
