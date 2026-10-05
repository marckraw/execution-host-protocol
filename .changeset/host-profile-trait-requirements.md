---
"@mrck-labs/execution-host-protocol": minor
---

Add host profile types and a defensive decoder for authenticated `GET /v0/host`,
with `host.profile.v1`, `devices.iosSimulator.v1` and
`devices.androidEmulator.v1` capability ids. The shared client exposes `host()`
with its existing authentication, timeout and error handling.

Session starts accept optional `requires` trait ids, preserved and validated by
the start codec. Existing starts and health/handshake behavior stay compatible;
the wire protocol version remains 1. Part of MAR-3699 (protocol only).
