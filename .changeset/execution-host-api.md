---
"@mrck-labs/execution-host-protocol": minor
---

Add `ExecutionHostApi`, a transport-neutral interface for an execution host (MAR-4862): providers, projects, start, command, listSessions, snapshot, patchSession, followSession, taskOutput, sessionChanges and downloadAttachment. `ExecutionHostClient` extends it, and gains two reads agents-daemon already serves: `listSessions(query?)` (`GET /v0/execution/sessions`, one page of `ExecutionSessionSummary` with `nextCursor` and `warnings`) and `sessionChanges(sessionId)` (`GET .../changes?scope=combined`, answered as `changes`, `no-session` or `unavailable`).

New `./port` entry point: `servePort(port, api)` and `createPortClient(port)` carry an `ExecutionHostApi` over a `MessagePort` (Node's, a browser's, or Electron's `MessagePortMain`). Errors cross with their class, kind and code; a caller's abort cancels the call on the host; follows reuse the HTTP client's follow, so they resume after `afterSeq` with no gaps or duplicates, arrive in chunks of at most 256 frames with at most 4 unread, and end when stopped or when the session is gone.

New `./testing` entry point: `describeExecutionHostConformance(runner, name, setup)`, the conformance suite every carrier passes, registered with the caller's own `describe` and `it` so the package keeps no dependencies.

Additive: no wire change, nothing existing changes. agents-daemon, accent. and Convergence need no source change; accent.'s desktop app can replace its own `GET /v0/execution/sessions` read with `listSessions`, and agents-daemon's runtime facade (MAR-4865) runs the suite.
