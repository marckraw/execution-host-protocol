---
"@mrck-labs/execution-host-protocol": minor
---

Add authenticated downloadAttachment() to the client subpath with encoded session/attachment IDs, an 8 MiB maximum (or smaller caller limit), body-wide deadlines and cancellation even when fetch leaves reads pending. Downloads return measured bytes and fixed client errors without host diagnostics (MAR-3928).
