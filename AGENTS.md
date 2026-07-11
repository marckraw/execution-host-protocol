# Execution Host Protocol - agent instructions

This public package is the compiler-checked execution-host wire contract shared
by agents-daemon and its clients. Cross-repository operational questions belong
in the canonical [agent ecosystem FAQ](https://github.com/ef-global/agents-daemon/blob/master/docs/ecosystem-faq.md).

- Contract only: types, pure codecs, validators, and recorded fixtures.
- Zero runtime dependencies. Do not add transports, clients, persistence, provider logic, or daemon-internal state.
- Readers are tolerant of unknown fields and strict about required known fields.
- Package semver and wire `protocolVersion` are independent.
- Wire changes are additive unless an explicitly coordinated protocol-version change is approved.
- Every behavior change needs focused contract tests and a Changeset.
- Planning lives in Linear project `emergence` (team `marckraw`).
