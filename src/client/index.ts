/**
 * `@mrck-labs/execution-host-protocol/client` — one client for an execution
 * host (MAR-3638).
 *
 * The package root is the wire contract and stays transport-free; this subpath
 * is the one place it meets HTTP and SSE. It is built to plain JavaScript with
 * explicit extensions and has no dependencies beyond the contract beside it,
 * so a consumer that cannot build — Node running TypeScript by type stripping
 * — loads it as it is.
 */

export {
  createExecutionHostClient,
  type ExecutionCommandOptions,
  type ExecutionCommandResult,
  type ExecutionDeleteSessionResult,
  type ExecutionHostClient,
  type ExecutionHostClientOptions,
  type ExecutionRequestOptions,
  type ExecutionSessionPatchResult,
  type ExecutionStartResult,
} from "./client.js";
export {
  executionRetryDelayMs,
  type ExecutionFollowEnd,
  type ExecutionFollowEnvelopeInfo,
  type ExecutionFollowGap,
  type ExecutionFollowOptions,
  type ExecutionFollowSkip,
  type ExecutionFollowStatus,
  type ExecutionSessionFollow,
} from "./follow.js";
export {
  parseExecutionHostHealth,
  SUPPORTED_EXECUTION_HOST_API_VERSIONS,
  type ExecutionHostConnectionStatus,
  type ExecutionHostHandshake,
  type ExecutionHostHealth,
  type ExecutionHostProviderReadiness,
} from "./health.js";
export { ExecutionHostError, type ExecutionHostErrorKind } from "./http.js";
export {
  ExecutionOneShotError,
  type ExecutionOneShotErrorCode,
  type ExecutionOneShotOptions,
  type ExecutionOneShotResult,
} from "./oneshot.js";
export {
  EXECUTION_CAUGHT_UP_EVENT,
  EXECUTION_REPLAY_EVENT,
  decodeExecutionCaughtUp,
  nextExecutionStreamPhase,
  readExecutionSeq,
  type ExecutionSeqReading,
  type ExecutionStreamPhase,
} from "./sequence.js";
export {
  decodeExecutionSessionSnapshot,
  type ExecutionSessionSnapshot,
  type ExecutionSessionSnapshotTurn,
} from "./snapshot.js";
export { createSseParser, type SseFrame } from "./sse.js";
export {
  type ExecutionDeltaMode,
  type ExecutionEventStreamOptions,
  type ExecutionStreamFrame,
} from "./stream.js";
