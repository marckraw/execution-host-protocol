---
"@mrck-labs/execution-host-protocol": minor
---

Add where a start in a checkout works, `config.worksIn`, and settling a session, a patch's `settled` (MAR-5673). Both are additive.

**`config.worksIn`** is `"auto" | "checkout" | "worktree"` (`EXECUTION_WORKS_IN`), for a start whose `workingDirectory` is in a person's own git checkout. `auto`, the default, is the checkout when no session is working in it, else a worktree of its own. `checkout` is the checkout even when another session works there. `worktree` is always a worktree. A session is working in a checkout while its turn runs, a task of its runs or something is queued for it, unless it was settled.

- A host advertising `start.worksIn.v1` takes it, and its 201 says where the session works: `worksIn: { place, checkoutRoot, workingThere }` (`ExecutionWorksInEcho`, read with `readExecutionWorksInEcho`), `workingThere` being the ids of the sessions working in the checkout as it started.
- A value outside the three is refused as `invalid-payload`.
- The client refuses `checkout` and `worktree`, unsent, on a host without the capability: `ExecutionStartWorksInError`, coded `works-in-unsupported` (`hostTakesWorksIn`). `auto` goes to any host. `ExecutionStartResult`'s `started` carries `worksIn` when the host said it; an echo it can't read is named in `warnings`. The error crosses a `MessagePort` as its class. A project session's workspace echo says where it works, `place` (`checkout` or `worktree`), in snapshots and lists; one this build can't read is left out.

**`settled`** on `ExecutionSessionPatchRequest` is a boolean: the person settled the session, or took that back. On a host advertising `sessions.settled.v1`, a settled session works in no checkout until a turn of its starts again. The answer echoes it. The client refuses it, unsent, on a host without the capability: `ExecutionSessionPatchError` coded `unsupported-on-host` (`hostTakesSettled`).
