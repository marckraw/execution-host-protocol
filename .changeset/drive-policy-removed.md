---
"@mrck-labs/execution-host-protocol": minor
---

**Breaking:** the drive policy is removed (MAR-5692). `ExecutionDrivePolicy`, `ExecutionDriveAsk`, `drivePolicyRefusalOf`, `EXECUTION_DRIVE_POLICY_REFUSED` and its reasons, `ExecutionDrivePolicyRefusal`, `decodeExecutionDrivePolicy`, `decodeExecutionDrivePolicyRefusal`, a provider's `drivePolicy`, the `providers.drivePolicy.v1` capability and the client's `hostEnforcesDrivePolicy` are gone: a provider is offered where it is installed and signed in, and nothing refuses on who asks. A listing that still carries `drivePolicy` has it ignored.

In its place, a provider may carry `sessionCap` on `GET /v0/providers` (`ExecutionProviderSessionCap`): the host's cap on its live sessions, `maxConcurrentSessions`, and how many are live now, `liveSessions`. It is read strictly; one this build cannot read is left out with a `dropped-invalid-field` warning (`providers.N.sessionCap`), and `decodeExecutionProviderSessionCap` reads one on its own.
