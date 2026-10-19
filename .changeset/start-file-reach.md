---
"@mrck-labs/execution-host-protocol": minor
---

Add a session's file reach (MAR-4352). A host advertising
`start.fileReach.v1` reports its fence, places, ceiling and floor as
`fileReach` in `GET /v0/host`, takes an optional top-level `fileReach` on a
start that can only narrow what the host would give the session, refuses one
it can't hold with a `400` coded `file-reach-refused` naming each entry's
problem (`unknown-place`, `escapes-place`, `past-ceiling`, `path-missing`,
`cannot-fence`), and echoes the reach on its `201` and `409`. The shared
client refuses to send a reach to a host without the capability, and deletes
a session whose `201` does not echo it, through `ExecutionStartFileReachError`.
