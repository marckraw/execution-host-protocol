---
"@mrck-labs/execution-host-protocol": patch
---

End aborted event streams even when fetch leaves a body read or cancellation pending. Followers can stop and reconnect after an idle timeout on affected runtimes, including Node 24.13.0 (MAR-3751).
