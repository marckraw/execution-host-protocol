---
"@mrck-labs/execution-host-protocol": minor
---

The client reads the providers' catalogue and tears a session down (MAR-3671).

accent.'s gateway on the shared client (MAR-3655) still sent two requests of its own, for want of a call. Both are on `ExecutionHostClient` now, and `protocolVersion` stays `1`; everything here is additive.

**`providers()`** reads `GET /v0/providers`: each provider with its `id`, `label`, `available` and `authenticated` (absent when the host does not say), the `effortLevels` it takes, and its models — `slug`, `label`, `defaultEffort`, and `efforts` (a model's own `effortOptions`, or else its provider's `effortLevels`). The root gains `decodeExecutionProviderListResponse` and the types `ExecutionProvider`, `ExecutionProviderModel` and `ExecutionProviderListResponse`. Unknown fields are ignored; a provider without an `id`, a model without a `slug`, or an effort without an `id` makes the catalogue `malformed`. It takes the client's health timeout, not the request one.

**`deleteSession(sessionId)`** sends `DELETE /v0/execution/sessions/:id` and answers `deleted`, or `no-session` (404) for a session the host does not have, so a retry after a lost answer is safe. Any other refusal is an `ExecutionHostError`. A follower of the session hears the host end its stream and then 404: `done` says `no-session`.

**Command ids stay always sent.** The protocol says sending one is always safe, so the client does not grow a `commandId: null` for hosts that "do not read one": the answer's `commandId` stays a string, and a caller that stripped the id (accent.'s adapter) can delete it. `null` is refused like any id the host would refuse.

**`events()` ends quietly when the caller aborts** — documented as the contract, as it is for `followSession`'s `stopped`. Check `signal.aborted` after the loop to tell an abort from the host closing the stream.
