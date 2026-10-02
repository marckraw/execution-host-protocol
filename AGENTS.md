# Execution Host Protocol - agent instructions

This public package is the compiler-checked execution-host wire contract shared
by agents-daemon and its clients, and the one client for it. Cross-repository
operational questions belong in the canonical [agent ecosystem FAQ](https://github.com/ef-global/agents-daemon/blob/master/docs/ecosystem-faq.md).

- The package root is the contract only: types, pure codecs, validators, and recorded fixtures. It never imports `src/client`.
- `src/client` (the `./client` subpath) is the one sanctioned transport: the HTTP/SSE client for an execution host. `scripts/check-package-exports.mjs` enforces the split — the root exports no client.
- Zero runtime dependencies, root and client alike. No persistence, provider logic, or daemon-internal state anywhere.
- Readers are tolerant of unknown fields and strict about required known fields.
- Package semver and wire `protocolVersion` are independent.
- Wire changes are additive unless an explicitly coordinated protocol-version change is approved.
- Every behavior change needs focused contract tests and a Changeset.
- Planning lives in Linear project `emergence` (team `marckraw`).
