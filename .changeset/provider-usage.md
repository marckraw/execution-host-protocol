---
"@mrck-labs/execution-host-protocol": minor
---

A provider in the catalogue can say how much of its account's limits are used
(MAR-4198). `ExecutionProvider` gains an optional `usage`:
`{ observedAt, source: "turn" | "read", status?: "ok" | "warning" | "limited", windows }`,
each window `{ id, span: "session" | "week" | "other", label, usedPercent, resetsAt?, modelFamily? }`.
New types `ExecutionProviderUsage`, `ExecutionProviderUsageWindow`,
`ExecutionProviderUsageSource`, `ExecutionProviderUsageStatus` and
`ExecutionProviderUsageWindowSpan`, the constants
`EXECUTION_PROVIDER_USAGE_SOURCES`, `EXECUTION_PROVIDER_USAGE_STATUSES`,
`EXECUTION_PROVIDER_USAGE_WINDOW_SPANS` and
`EXECUTION_PROVIDER_USAGE_TEXT_MAX_LENGTH` (128), and the capability
`providers.usage.v1`, which a host that reports it advertises.

`executionProviderUsageWindowLimits(window, model, at)` says whether a window
still limits a model: only while its `resetsAt` is ahead, and only when it
names no `modelFamily` or the model's slug or label is of that family.

Additive: a catalogue without `usage` decodes exactly as in 0.29.0, and a
0.29.0 reader ignores the field. `decodeExecutionProviderListResponse` never
fails a catalogue over a `usage`. One that is not an object, has no ISO 8601
`observedAt`, names a `source` this build does not know, or has no `windows`
list is left out: unknown, never "0%" and never "limited". A window with no
`id`, `span` or numeric `usedPercent` is left out alone, and so is a later
window repeating an id. Text is cleaned of control and bidirectional-formatting
characters and cut at 128 UTF-16 units; `usedPercent` is clamped to 0–100; an
unknown `span` reads as `other`; a missing `label` is the `id`; a `status`,
`resetsAt` or `modelFamily` that cannot be read is left out on its own.
