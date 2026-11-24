---
"@mrck-labs/execution-host-protocol": patch
---

The drive policy is deprecated (MAR-5692). No host reports or enforces one, nor advertises `providers.drivePolicy.v1`: a provider is offered where it is installed and signed in, and nothing refuses on who asks. A host's cap on a provider's live sessions is its own refusal, in its own words. `ExecutionDrivePolicy`, `ExecutionDriveAsk`, `drivePolicyRefusalOf`, the refusal's code and reasons, `decodeExecutionDrivePolicy`, `decodeExecutionDrivePolicyRefusal`, a provider's `drivePolicy`, the capability and the client's `hostEnforcesDrivePolicy` stay exported and behave as before, marked `@deprecated`, so nothing that reads them breaks. Nothing on the wire changes.
