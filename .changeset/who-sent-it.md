---
"@mrck-labs/execution-host-protocol": minor
---

Commands say who sent them, user messages say who wrote them, and an unknown kind is skipped instead of failing the envelope (MAR-3633).

Several people can now drive one session through one client, and the wire had no way to say which of them did what: a user message carried only its role, and approvals, stops and steers carried nothing at all. `protocolVersion` stays `1`; every field here is optional, and existing payloads decode and re-encode unchanged.

**Who sent it.** Every command envelope, and the start request, may carry an `actor` — `{ kind: "person" | "agent", id, displayName }`, in the sending client's own namespace — and a `commandId`, the client's own id for the command, unique within the session and reused on a retry. A host refuses either one present but unreadable (`invalid-payload`) rather than dropping it: a dropped actor records the command as anonymous and a dropped id breaks the sender's match with its echo, and both look like success. A host predating this ignores both, so sending them is safe everywhere.

**Who wrote it.** A user `message` item may carry `author` (an `ExecutionActor`) and `clientMessageId` — the `commandId` of the `send-message`, `steer` or start request that created it — so a client can match the transcript to its own sends. Both are fixed at creation: the patch type omits them and the patch decoder ignores them. A reader drops an unreadable one with a `dropped-invalid-field` warning and keeps the message.

**Unknown kinds are skipped, not fatal.** `decodeExecutionEventEnvelope` used to reject an envelope of an unknown event or delta kind as `unknown-kind`, and of an unknown item kind as `invalid-payload`. All three are now `unknown-kind` with `skipped: { sessionId, seq, path, kind }`, so a stream reader can step over the envelope and keep its cursor moving instead of reading a gap. An item of a newer kind must still carry the base fields every item shares, and command kinds stay strict: a host must not silently drop a command it cannot execute.

New capability ids: `commands.actor.v1` (the host reads and records `actor` and `commandId`), `items.author.v1` (the host echoes `author` and `clientMessageId` on user messages), and `deltas.append.v1`, which hosts already advertised for negotiated text increments and is now named here.
