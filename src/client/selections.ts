import type { ExecutionStartSelectionRefusalCode } from "../selections.js";
import type { ExecutionHostHealth } from "./health.js";

/** Missing host capability (unsent), or a capable host's coded 400. */
export type ExecutionStartSelectionErrorCode =
  ExecutionStartSelectionRefusalCode | "selection-unsupported";

export class ExecutionStartSelectionError extends Error {
  readonly operation = "start";
  constructor(
    readonly code: ExecutionStartSelectionErrorCode,
    readonly reason: string,
    readonly status: number | null = null,
  ) {
    super(`start failed: ${code}: ${reason}`);
    this.name = "ExecutionStartSelectionError";
  }
}

export function hostTakesSelections(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("start.selections.v1");
}
