import type { ExecutionHostHealth } from "./health.js";

/** Host capability missing (unsent), or a capable host refusing this provider (400). */
export type ExecutionStartInstructionsErrorCode =
  "instructions-unsupported" | "instructions-unsupported-provider";

export class ExecutionStartInstructionsError extends Error {
  readonly operation = "start";
  constructor(
    readonly code: ExecutionStartInstructionsErrorCode,
    readonly reason: string,
    readonly status: number | null = null,
  ) {
    super(`start failed: ${code}: ${reason}`);
    this.name = "ExecutionStartInstructionsError";
  }
}

export function hostTakesInstructions(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("start.instructions.v1");
}
