---
"@mrck-labs/execution-host-protocol": minor
---

A provider in the catalogue can say which account it is signed in as
(MAR-3821). `ExecutionProvider` gains an optional `account`:
`{ label, plan?, source: "sign-in" | "label", expiresOn? }`, with the new
types `ExecutionProviderAccount` and `ExecutionProviderAccountSource` and the
constants `EXECUTION_PROVIDER_ACCOUNT_SOURCES` and
`EXECUTION_PROVIDER_ACCOUNT_TEXT_MAX_LENGTH` (256).

It is the host's word, never verified: show it to owners as a label, never
use it to authorise anything.

Additive: no capability id, and nothing that read before reads differently.
A catalogue without `account` decodes exactly as in 0.21.0, and a 0.21.0
reader ignores the field. `decodeExecutionProviderListResponse` never fails a
catalogue over an `account`. One that is not an object, names a `source` this
build does not know, or has no label is left out. A `label` or `plan` is
cleaned of control and bidirectional-formatting characters, trimmed, and cut
at 256 UTF-16 units. A `plan` or an `expiresOn` that is not a real
`YYYY-MM-DD` day is left out on its own.
