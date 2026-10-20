---
"@mrck-labs/execution-host-protocol": minor
---

Add config.mcpServers and config.skills as bounded, unique inventory-name selections, and start.selections.v1. Omitted fields retain host defaults; empty lists disable all. The shared client refuses to send selections to older hosts and exposes coded unknown-name and unsupported-provider refusals through a dedicated selection error module with a reason. Providers advertise features.sessionSelections, decoded as ExecutionProvider.sessionSelections. selection-unsupported is the missing-host-capability error; selection-unsupported-provider is a host 400. See the Session MCP servers and skills README section for the contract and a pointer to provider enforcement details.

Consumers: agents-daemon applies and persists selections; accent. will send persona picks in MAR-4342. Emergence, Convergence Remote Execution Host, Slack/Teams Anton and the Anton dashboard keep omitted-field behavior and need no source change. All consumers receive the new contract through this package's changesets release.

Provider selection discovery reports MCP and skill support independently as `{ mcpServers: boolean, skills: boolean }`. Coded refusals identify the field in `reason`.
