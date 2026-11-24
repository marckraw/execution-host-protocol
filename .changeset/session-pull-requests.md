---
"@mrck-labs/execution-host-protocol": minor
---

Add a session's pull requests: a list of facts, each one's state, and the one primary rule (MAR-5696, slice P1 of MAR-5695).

- **`ExecutionPullRequestFact`**: `{ repository: "owner/name", number, role, source, itemId?, agentRunId?, at, state? }`. `role` is `opened | pushed | merged | edited | reviewed | mentioned` (`EXECUTION_PULL_REQUEST_ROLES`). `source` is `command | mcp-tool | output-url | branch` (`EXECUTION_PULL_REQUEST_SOURCES`).
- **Where it travels.** A snapshot and the list carry `pullRequests` whole, and a `session.patch` carries it whole each time it changes, behind `sessions.pullRequests.v1`. It holds one fact per pull request and role, newest first. Only mentions are capped, at the newest 100 (`EXECUTION_PULL_REQUEST_MENTIONS_MAX`); every other fact is kept, so mentions can never push out the one that makes the primary. A host without the capability leaves it out.
- **`state`**, behind `sessions.pullRequests.state.v1`, for a host that reads GitHub itself: `{ state: draft | open | merged | closed, checks: { passed, failed, running }, reviewDecision?, mergeable?, title, url, checkedAt }`.
- **`primaryPullRequestOf(facts)`**: the newest PR it opened; else the newest it pushed to; else the newest still-open one it edited or reviewed; else the newest it merged; else null. "Still open" needs a state read as open or draft (the one read last of any of the PR's facts): an unread state never makes an edit or a review primary. It is pure and gives the same answer in any order, ties broken by time, number, repository and role. It takes any wider shape, so the server's rows work too.
- **`pullRequestKeyOf`** gives one key per PR, ignoring the repository's case.
- **`decodeExecutionPullRequests`** is the reader. A fact it cannot read is dropped and named in `warnings`, so is an unreadable state. Whatever the host sends, it hands back the contract's list.
- **The conformance suite** gains `pullRequests.record(sessionId, facts)` and a case that holds a host to all of this, over HTTP and over a `MessagePort`. What the host advertises drives the case: one that advertises the capability must give the hook, and one that doesn't must say no `pullRequests` anywhere, `session.patch` included.

**Breaking: the `prUrl` / `autoCreatePr` path is removed.** `prUrl` is gone from `session.patch`, `ExecutionSessionSnapshot` and `ExecutionSessionSummary`. `ExecutionStartRequest.automation` and `ExecutionAutomationConfig` are gone too, and so is the capability id `automation.create-pr`. An older host's `prUrl`, or an older client's `automation`, is read past like any unknown field. This is a break under 0.x, so it is a minor version.
