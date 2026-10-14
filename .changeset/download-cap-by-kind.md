---
"@mrck-labs/execution-host-protocol": minor
---

`downloadAttachment` takes a `kind` that sets its ceiling: `"tool"` (the default) stays at 8 MiB, `"inline"` reads an upload up to the host's 10 MiB (MAR-3973).
