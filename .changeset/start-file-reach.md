---
"@mrck-labs/execution-host-protocol": minor
---

Add a session's file reach (MAR-4352). A host advertising
`start.fileReach.v1` reports its fence, places, ceiling and floor as
`fileReach` in `GET /v0/host`, takes an optional top-level `fileReach` on a
start that can only narrow what the host would give the session, refuses one
it can't hold with a `400` coded `file-reach-refused` naming each entry's
problem (`unknown-place`, `escapes-place`, `past-ceiling`, `path-missing`,
`cannot-fence`), and echoes the reach on its `201` and `409`. A fence is
Landlock ABI 4 or newer: an advertisement or echo naming an older ABI is read
as none. The shared client refuses to send a reach to a host without the
capability, deletes the session a start asked for when its `201` does not
confirm the reach (no echo, another reach, an unreadable answer, or one about
another session), and keeps a file's words out of the error, through
`ExecutionStartFileReachError`.

Additive: every client of 0.32 (agents-daemon, accent., Emergence,
Convergence's Remote Execution Host, Slack/Teams Anton and the Anton
dashboard) that sends no `fileReach` needs no change, and a start without it
is the same request as before.
