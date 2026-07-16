# @mrck-labs/execution-host-protocol

## 0.8.0

### Minor Changes

- 0afe2d9: Add structured interaction request and response shapes, typed answer delivery, and capability identifiers for structured interactions and queued-message cancellation.

## 0.7.0

### Minor Changes

- dfec78d: Add a cancel-queued command and cancelled message-delivery state for queued follow-up cancellation.

## 0.6.2

### Patch Changes

- 9986b7a: Add validated live PR URL session patches and the combined turn-file-change capability identifier.

## 0.6.1

### Patch Changes

- 438d43f: Add optional queued, delivered, undelivered, and steered delivery state to message conversation items.

## 0.6.0

### Minor Changes

- 4f3d2c9: Add universal turn lifecycle deltas, per-turn file-change metadata, and the
  `turns.fileChanges` capability. Add native steer and interrupt commands with
  optional provider turn preconditions.

## 0.5.0

### Minor Changes

- 2f58fca: Add the optional provider permission configuration to Session start requests while retaining the legacy automation flag.

## 0.4.0

### Minor Changes

- 0965781: Add persisted attachment metadata to conversation message items.

## 0.3.0

### Minor Changes

- a427e2f: Add a typed, additive inline-image attachment payload and capability for execution start and send-message envelopes while preserving the legacy opaque attachment field.

## 0.2.5

### Patch Changes

- c41ec9b: Enable npm publishing: add `repository`, `homepage`, and `bugs` metadata (required for provenance), add a concurrency guard to the release workflow, and document the Changesets release flow plus the one-time `NPM_TOKEN` setup.

## 0.2.4

### Patch Changes

- Keep conversation item identifiers and kinds immutable when decoding item patches.

## 0.2.3

### Patch Changes

- Validate every known conversation item patch field and report dropped invalid values without interrupting the event stream.

## 0.2.2

### Patch Changes

- Build dual Node exports with the TypeScript compiler so git dependencies can run prepare under Bun without installing package-local development tools.

## 0.2.1

### Patch Changes

- Publish dual ESM and CommonJS entry points so Electron main and other CommonJS consumers can load the protocol contract.

## 0.2.0

### Minor Changes

- Add an extensible execution-protocol capability descriptor for additive health negotiation.

## 0.1.1

### Patch Changes

- Run package verification and Changesets against the repository's main branch.
