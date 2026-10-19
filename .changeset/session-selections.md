---
"@mrck-labs/execution-host-protocol": minor
---

Add config.mcpServers and config.skills as bounded inventory-name selections, and start.selections.v1. Omitted fields retain host defaults; empty lists disable all. The shared client refuses to send selections to older hosts and exposes coded unknown-name refusals.

Consumers: agents-daemon applies and persists selections; accent. will send persona picks in MAR-4342. Emergence, Convergence Remote Execution Host, Slack/Teams Anton and the Anton dashboard keep omitted-field behavior and need no source change. All consumers receive the new contract through this package's changesets release.
