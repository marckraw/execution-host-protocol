---
"@mrck-labs/execution-host-protocol": minor
---

Add optional persisted image references and bounded fixed-code omission counts to tool-result items under `items.toolAttachments.v1` (MAR-3926). Tolerant readers preserve required tool text when optional metadata is malformed, with the same behavior in events, replay and snapshots. Export image budget constants and document host persistence, immutability and compatibility obligations without changing the wire protocol version.
