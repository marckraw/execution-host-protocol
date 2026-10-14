import type { ExecutionHostHealth } from "./health.js";

/**
 * `interactions-unsupported`: the `send-message` carries an
 * `interactionResponse` and the host does not advertise
 * `interactions.structured`, or its descriptor is unreadable.
 */
export type ExecutionInteractionResponseErrorCode = "interactions-unsupported";

/**
 * A `send-message` answering an input request with `interactionResponse` that
 * this client will not send (MAR-4002). Nothing was sent: the answer is still
 * the caller's to send as text. Not an `ExecutionHostError`: a caller
 * converting errors checks for both.
 */
export class ExecutionInteractionResponseError extends Error {
  readonly code: ExecutionInteractionResponseErrorCode;
  /** `command send-message`. */
  readonly operation: string;
  /** Safe to show: the client's own words. */
  readonly reason: string;

  constructor(
    code: ExecutionInteractionResponseErrorCode,
    reason: string,
    details: { operation: string },
  ) {
    super(`${details.operation} failed: ${code}: ${reason}`);
    this.name = "ExecutionInteractionResponseError";
    this.code = code;
    this.operation = details.operation;
    this.reason = reason;
  }
}

/**
 * Whether the host fills structured input requests and takes structured
 * answers (`interactions.structured`). A host that does not may drop an
 * `interactionResponse` and read the answer's text alone, so `command()` will
 * not send one there.
 */
export function hostTakesStructuredInteractions(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("interactions.structured");
}

export function interactionResponseRefusal(
  operation: string,
  health: Pick<ExecutionHostHealth, "executionProtocolValid">,
): ExecutionInteractionResponseError {
  return new ExecutionInteractionResponseError(
    "interactions-unsupported",
    health.executionProtocolValid
      ? "the host does not advertise interactions.structured, so it could drop the answer's choices; nothing was sent"
      : "the host's protocol descriptor is unreadable, so it cannot be trusted with the answer's choices; nothing was sent",
    { operation },
  );
}
