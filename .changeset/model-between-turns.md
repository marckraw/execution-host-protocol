---
"@mrck-labs/execution-host-protocol": minor
---

A session's model and effort change between turns (MAR-3662).

They were fixed when a session started: `send-message` had no model or effort, and nothing else could change them. People writing to one session together want to move it from Sonnet to Opus, or think harder, between one message and the next. `protocolVersion` stays `1`; everything here is additive.

**Asking.** `ExecutionSessionPatchRequest` is the body of `PATCH /v0/execution/sessions/:id`: `{ title?, model?, effort? }`, with `encodeExecutionSessionPatchRequest` and `decodeExecutionSessionPatchRequest`. Strict, as requests into a host are: a patch naming no field, a field this build does not know, or a value of the wrong shape is `invalid-payload`, never dropped. `model` and `effort` are null (the default) or a non-empty id of at most 256 characters; `title` is null or a string. A patch naming only a title is the title patch hosts already took.

**The answer.** `ExecutionSessionPatchResponse` and `decodeExecutionSessionPatchResponse` read both answers a host gives: the title-only `{ sessionId, title }` every host has sent, and a selection answer adding `protocolVersion`, `model` and `effort` — the selection the session's next turn runs on.

**The capability.** `sessions.modelSelection.v1`: the host takes the change at any time, leaves a turn already running on what it started with, runs every turn that starts afterwards on the new selection (a turn runs on the selection in force when its `turn.add` was sent), checks the selection against its provider's catalog, and refuses one the catalog does not offer.

**Followers.** `session.patch` may carry `model` and `effort` (null or a non-empty id; anything else makes the envelope `invalid-payload`, as for its other fields). A reader older than this one decodes such a patch as empty. The client's session snapshot carries `model` and `effort`, absent when the host does not report them — which is not the same as reporting the defaults — and dropped with a `dropped-invalid-field` warning when unreadable.

**The client.** `patchSession(sessionId, patch)` sends the patch, refusing one the protocol would refuse before anything is sent, and answers `patched` with what the host holds now or `no-session` (404); a selection the host's catalog does not offer is its 400, thrown as an `ExecutionHostError` with the host's reason.
