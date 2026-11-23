---
"@mrck-labs/execution-host-protocol": minor
---

Add MCP connections (`mcp.connections.v1`, MAR-5668): a host's Claude Code and Codex MCP servers with their states, and signing in to them and out of them, for a host that runs as one person on their own machine.

- Six calls on `ExecutionHostApi`, on the HTTP client and over a `MessagePort`: `mcpServers`, `mcpSignIn`, `mcpSignInState`, `mcpFinishSignIn`, `mcpCancelSignIn` and `mcpSignOut`, at `/v0/mcp/:provider/…`. Every refusal is an `ExecutionMcpError` with a code; a shared host refuses them all `unavailable-on-host`, and one predating them is `unsupported`. `hostManagesMcpConnections(health)` gates them. Both carriers check what a call names before sending anything, and make its errors the same way: the code held to its status, the reason the client's own, never the host's words.
- The contract at the root: `ExecutionMcpServer`, `ExecutionMcpSignIn`, `ExecutionMcpSignInStatus`, their readers, the request codec a host reads bodies with, and the refusal codes with their statuses. A sign-in URL is `http:` or `https:` only, and it and a callback URL are secrets: never in a path, and never quoted by an error.
- A session event, `mcp.needs-sign-in` `{ provider, server }`, for when a running agent reports a server needing a sign-in. Older readers skip it.
- The conformance suite holds every carrier to the sign-in lifecycle through a new `mcp` hook — a callback not the sign-in's refused `rejected` with the sign-in left pending, and, with `expireSignIn`, a sign-in that runs out failing — or to refusing every MCP call when a host leaves it out.

Additive: nothing existing changes, and `protocolVersion` stays 1.
