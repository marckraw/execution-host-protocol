import type { ExecutionHostHealth } from "./health.js";

/**
 * `works-in-unsupported`: the host does not advertise `start.worksIn.v1`, or
 * its descriptor is unreadable, so it would decide by itself where a start
 * in a checkout works (MAR-5673). Nothing was sent. `checkout-taken`: the
 * host refused a `checkout` start (409), another session working there,
 * `workingThere`; nothing was started.
 */
export type ExecutionStartWorksInErrorCode =
  "works-in-unsupported" | "checkout-taken";

/** A start's `config.worksIn` refused: unsent, or by the host. */
export class ExecutionStartWorksInError extends Error {
  readonly operation = "start";
  /** The host's status for its refusal; null when nothing was sent. */
  readonly status: number | null;
  /** Who works in the checkout, by id, for `checkout-taken`; else empty. */
  readonly workingThere: string[];
  constructor(
    readonly code: ExecutionStartWorksInErrorCode,
    readonly reason: string,
    details: { status?: number | null; workingThere?: string[] } = {},
  ) {
    super(`start failed: ${code}: ${reason}`);
    this.name = "ExecutionStartWorksInError";
    this.status = details.status ?? null;
    this.workingThere = [...(details.workingThere ?? [])];
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
