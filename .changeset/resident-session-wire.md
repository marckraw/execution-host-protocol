---
"@mrck-labs/execution-host-protocol": minor
---

**BREAKING** — protocol 0.19, the resident-session wire (MAR-3679). One release
for the resident-sessions wave: agents-daemon keeps one Claude Code process per
session (R1, MAR-2881), and the wire says what that process is doing after it
answers.

Moving with it: **agents-daemon**, **accent.**, **Convergence** and
**backpack.automations**. There are no compatibility paths: a reader on 0.19
refuses a pre-0.19 host's turns, and a reader before 0.19 refuses an `answered`
status.

- **Breaking: session status `answered`**, between `running` and
  `completed`. The agent has answered, but tasks it started still run. Readers
  before 0.19 refuse it as `invalid-payload`.
- **Breaking: `origin: "user" | "harness"` is required on `ExecutionTurn`.**
  `harness` is a turn Claude Code opened by itself, after a background task
  finished. A `turn.add` without one is `invalid-payload`, and a snapshot drops
  that turn with a warning. `decodeExecutionTurn` now returns only a turn's own
  fields rather than whatever rode along with them.
- **`runningTasks` on `session.patch`**, and on the client's session snapshot
  (`runningTasks`, 0 when the host does not say).
- **The `evidence` delta** — `{ kind: "evidence", turnId, evidence }`, carrying
  Convergence's `HarnessEvidence` union unchanged and under its own names
  (`HarnessEvidence`, `HarnessFact`, `AgentRunFact`, `TaskFact`,
  `SessionAgentRun`, `SessionTask`, …): agent runs, tasks, harness hooks,
  retries, compaction, denials, rate limits, init and MCP status, unknown
  harness families, and turn accounting. `decodeHarnessEvidence` reads one
  fact on its own. An evidence kind this build does not know is skipped at
  `event.delta.evidence.kind`.
- **`agentRunId` and `taskId` on conversation items** (optional, patchable):
  which agent run or task produced the item; absent for the main agent.
- **The `stop-task` command** (`{ kind: "stop-task", taskId }`): stops one task
  without interrupting the session.
- **Capabilities** `sessions.resident.v1`, `evidence.v1` and
  `commands.stopTask.v1`.
- **The README** lists every event, delta and command, and defines _settled_:
  `completed` or `failed`, no running tasks, nothing queued — the only time
  attention becomes `finished`.

`EXECUTION_PROTOCOL_VERSION` stays 1.
