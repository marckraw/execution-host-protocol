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
`endOffset`, `totalBytes`, `truncated` and `readAt`. It covers at most 64 KiB
of the file, and its text is at most 65,536 characters. The codecs enforce
both caps: the decoders refuse anything past them, and the encoders throw on
it.

The window holds whole lines only, so a host that redacts exact secret values
never shows a fragment of one. A line the tail cuts is left out, and while a
task runs its unfinished last line is held back (`endOffset` before
`totalBytes`).

Session ids are safe path segments: 1 to 256 characters, with no `/`, `\`,
control character or dot segment, before or after NFKC normalization.

The README spells out where a host may read from: the path from the
provider's structured event, or derived inside the session's own task
directory, never parsed from tool-result text. It also covers how the host
checks the file: `O_NOFOLLOW`, `fstat`, a regular file with one link, and one
`pread`.

The root gains:

- the request, answer and refusal codecs;
- the caps;
- the refusal codes `session-unknown`, `task-unknown`, `no-output`,
  `read-refused` and `rejected`, each with its status;
- `executionTaskOutputReadRange` and `decodeExecutionTaskOutputWindow`, which
  size the host's one read and turn the bytes read into a line-aligned window
  before the host redacts it.

The client gains `taskOutput(sessionId, taskId, { tail?, signal?, timeoutMs? })`,
along with `ExecutionTaskOutputError` with a stable `code`, plus `unsupported`
for a host without the route, and `hostReadsTaskOutput(health)`.

The capability is additive. Existing calls are unchanged on the wire, and the
protocol version stays 1. A hand-written implementation of
`ExecutionHostClient` must add `taskOutput`.
