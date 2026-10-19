import type { ExecutionHostHealth } from "./health.js";

/** Nothing was sent: this host may silently drop session instructions. */
export class ExecutionStartInstructionsError extends Error {
  readonly code = "instructions-unsupported";
  readonly operation = "start";
  readonly status = null;
  readonly reason: string;

  constructor(health: Pick<ExecutionHostHealth, "executionProtocolValid">) {
    const reason = health.executionProtocolValid
      ? "the host does not advertise start.instructions.v1; nothing was sent"
      : "the host's protocol descriptor is unreadable; nothing was sent";
    super(`start failed: instructions-unsupported: ${reason}`);
    this.name = "ExecutionStartInstructionsError";
    this.reason = reason;
  }
}

export function hostTakesInstructions(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("start.instructions.v1");
}
