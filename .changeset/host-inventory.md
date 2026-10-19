---
"@mrck-labs/execution-host-protocol": minor
---

Add a host's inventory (MAR-4363). Authenticated `GET /v0/host` gains
`inventory: { mcpServers: { name, label? }[], skills: { name, providers }[] }`:
the MCP servers the host has configured and the skills it has installed, each
skill with the providers (`"claude"`, `"codex"`) whose sessions get it.
`decodeExecutionHostProfile`, and so the shared client's `host()`, reads it
with `ExecutionHostInventory`, `ExecutionHostMcpServer`, `ExecutionHostSkill`
and `EXECUTION_HOST_SKILL_PROVIDERS`. An unreadable entry, list or
`inventory` is dropped and named; a provider the reader doesn't know is
skipped. A host predating it sends no `inventory`, and lists nothing.

Additive. The clients of 0.32: agents-daemon serves it (ef-global/agents-daemon,
MAR-4363). accent. is to read it for its persona editor (MAR-4342), and needs
no change until then. Emergence, Convergence's Remote Execution Host,
Slack/Teams Anton and the Anton dashboard need no change: a profile without it
reads as before.
