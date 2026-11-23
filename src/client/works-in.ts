import type { ExecutionHostHealth } from "./health.js";

/**
 * `works-in-unsupported`: the host does not advertise `start.worksIn.v1`, or
 * its descriptor is unreadable, so it would decide by itself where a start
 * in a checkout works (MAR-5673). Nothing was sent.
 */
export type ExecutionStartWorksInErrorCode = "works-in-unsupported";

/** A start whose `config.worksIn` this host can't be trusted with, refused unsent. */
export class ExecutionStartWorksInError extends Error {
  readonly operation = "start";
  constructor(
    readonly code: ExecutionStartWorksInErrorCode,
    readonly reason: string,
  ) {
    super(`start failed: ${code}: ${reason}`);
    this.name = "ExecutionStartWorksInError";
  }
}

/**
 * Whether the host works a start in a checkout where its `config.worksIn`
 * says (`start.worksIn.v1`, MAR-5673). A host that does not drops it, so
 * `start()` sends it no `checkout` or `worktree`, and a client can hide its
 * choice.
 */
export function hostTakesWorksIn(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("start.worksIn.v1");
}

export function worksInRefusal(
  health: Pick<ExecutionHostHealth, "executionProtocolValid">,
): ExecutionStartWorksInError {
  return new ExecutionStartWorksInError(
    "works-in-unsupported",
    health.executionProtocolValid
      ? "the host does not advertise start.worksIn.v1, so it would choose by itself where the session works; nothing was sent"
      : "the host's protocol descriptor is unreadable, so it cannot be trusted to work the session where it was asked; nothing was sent",
  );
}
