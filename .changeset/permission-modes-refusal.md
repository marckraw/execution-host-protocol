---
"@mrck-labs/execution-host-protocol": minor
---

Permission modes, what the daemon and accent. need (MAR-4052).

- New capability `sessions.permissionModes.v1`. `patchSession()` with a `permissionConfig` asks `/health` first, and on a host without the capability throws `ExecutionSessionPatchError` coded `unsupported-on-host` without sending anything (`hostTakesPermissionModes` from `./client`).
- Coded refusals of a session patch: `ExecutionSessionPatchRefusal` `{ error, code }`, read by `decodeExecutionSessionPatchRefusal`. The codes are `turn-running` (409), `unsupported-on-host` (400) and `unsupported-for-provider` (400), each honoured only with its status (`EXECUTION_SESSION_PATCH_REFUSAL_STATUS`). The client throws them as `ExecutionSessionPatchError`; any other refusal stays an `ExecutionHostError`.
- The patch answer's `appliesFrom` (`now` | `next-turn`) is read now. One in words this build does not know is left out, never failing the answer.
- `ExecutionPermissionConfig` says what a provider part means: it applies only under `custom`, `custom` without the session's provider part runs as `ask`, and under `ask` and `yolo` the parts are read but change nothing.
- The snapshot reads `permissionConfig: null` as absent (unknown) without a warning.
