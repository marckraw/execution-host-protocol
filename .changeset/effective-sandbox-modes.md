---
"@mrck-labs/execution-host-protocol": minor
---

The provider listing says what a Codex sandbox really runs as on its host (MAR-4054). `ExecutionProvider.permissions.codex` gains an optional `effectiveSandboxModes`, which maps each requested sandbox to the one that runs, or to null when the host does not offer it. For example, `{ "workspace-write": "danger-full-access", "read-only": null }` on a container host, where Codex's `ask` runs with full access. It is read tolerantly: a map that is not an object is left out, and an entry with a sandbox this build does not know on either side is dropped on its own. A sandbox that is left out is unknown, not "as asked".
