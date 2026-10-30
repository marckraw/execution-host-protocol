/**
 * `@mrck-labs/execution-host-protocol/testing` — the conformance suite every
 * `ExecutionHostApi` passes (MAR-4862): the HTTP client, a port, a runtime in
 * the same process. It takes the test runner's `describe` and `it` rather
 * than importing one, so the package keeps no dependencies.
 */

export {
  describeExecutionHostConformance,
  executionHostConformanceCases,
  ExecutionHostConformanceError,
  type ExecutionHostConformanceCase,
  type ExecutionHostConformanceHost,
  type ExecutionHostConformanceOptions,
  type ExecutionHostConformanceRunner,
} from "./conformance.js";
