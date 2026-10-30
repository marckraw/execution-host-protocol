import type { ExecutionHostHealth } from "./health.js";

/**
 * Whether a host sends each turn's usage and answers its usage history
 * (`turns.usage.v1`, MAR-4943). `listTurnUsage` does not read `/health`
 * first: a host without it answers 404, an `ExecutionHostError` of kind
 * `not-found`.
 */
export function hostRecordsTurnUsage(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("turns.usage.v1");
}
