# @marckraw/execution-host-protocol

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
