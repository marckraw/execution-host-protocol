---
"@mrck-labs/execution-host-protocol": minor
---

Add task output (`tasks.output.v1`, MAR-3981). This is a bounded read of the
end of one task's output file, at
`GET /v0/execution/sessions/:sessionId/tasks/:taskId/output?tail=<bytes>`.

The request names a task, never a file. The task id is an opaque token that
cannot form a path. `tail` is 1 to 65,536 bytes, and the request decoder
refuses any other query parameter.

The answer carries `status`, the host-redacted UTF-8 `text`, `startOffset`,
`totalBytes`, `truncated` and `readAt`. Its window is at most 64 KiB, and its
text at most 65,536 characters. The codecs enforce both caps: the decoders
refuse anything past them, and the encoders throw on it. A tail that cuts a
character starts after that character.

The root gains:

- the request, answer and refusal codecs;
- the caps;
- the refusal codes `session-unknown`, `task-unknown`, `no-output`,
  `read-refused` and `rejected`, each with its status;
- `decodeExecutionTaskOutputWindow`, which turns the window's bytes into text
  before the host redacts it.

The client gains `taskOutput(sessionId, taskId, { tail?, signal?, timeoutMs? })`,
along with `ExecutionTaskOutputError` with a stable `code`, plus `unsupported`
for a host without the route, and `hostReadsTaskOutput(health)`.

The capability is additive. Existing calls are unchanged on the wire, and the
protocol version stays 1. A hand-written implementation of
`ExecutionHostClient` must add `taskOutput`.
