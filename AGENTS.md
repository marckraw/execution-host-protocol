# Execution Host Protocol - agent instructions

This public package is the compiler-checked execution-host wire contract shared
by agents-daemon and its clients, and the one client for it. Cross-repository
operational questions belong in the canonical [agent ecosystem FAQ](https://github.com/ef-global/agents-daemon/blob/master/docs/ecosystem-faq.md).

- The package root is the contract only: types, pure codecs, validators, and recorded fixtures. It never imports `src/client`.
- `src/client` (the `./client` subpath) is the HTTP/SSE client for an execution host, and owns `ExecutionHostApi`, the transport-neutral interface it implements. `src/port` (`./port`) carries that API over a `MessagePort`; `src/testing` (`./testing`) is the conformance suite every carrier passes. These are the only sanctioned transports. `scripts/check-package-exports.mjs` enforces the split — the root exports none of them.
- Zero runtime dependencies, root, client, port and testing alike: the suite takes the runner's `describe` and `it`. No persistence, provider logic, or daemon-internal state anywhere.
- A new `ExecutionHostApi` method changes every carrier: the HTTP client, `src/port`'s method table, and a conformance case.
- Readers are tolerant of unknown fields and strict about required known fields.
- Package semver and wire `protocolVersion` are independent.
- Wire changes are additive unless an explicitly coordinated protocol-version change is approved.
- Every behavior change needs focused contract tests and a Changeset.
- An actor's `via` says how a command reached the host: `app` (a person in accent.), `token` (their AI app, through one of their tokens), `automation` (an Automation or a schedule, and any persona one starts), or `line` (a queued start the line fired). It is required on command envelopes and start requests since 0.38.0, a coordinated break (MAR-5634); a message's echoed `author` stays tolerant of its absence.
- A provider's drive policy is configuration on the host, which reports it and enforces it. `drivePolicyRefusalOf` in `src/drive-policy.ts` is the one implementation of the rule; change it there, never in a copy, and keep its decision table in `tests/drive-policy.test.ts` complete.
- An MCP sign-in URL and callback URL are secrets (MAR-5668): only ever in a body or an answer, never a path, a query, an error or a log line, and the client's MCP errors speak in their own words, never the host's.
- Planning lives in Linear project `emergence` (team `marckraw`).
