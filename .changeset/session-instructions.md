---
"@mrck-labs/execution-host-protocol": minor
---

Add config.instructions (at most 32 KiB UTF-8) and start.instructions.v1 for session-level provider instructions. The shared client refuses instructions-unsupported before sending to an older or unreadable host, and rejects invalid instructions before probing. Starts without instructions keep their existing behavior.

Advertise support per provider through features.sessionInstructions (decoded as ExecutionProvider.sessionInstructions), and type the host-side 400 instructions-unsupported-provider separately from a missing capability. Document that instructions are fixed at first start and unconfirmed on 409 / exists.

Coordinated consumers: agents-daemon (provider wiring and persistence), Emergence, Convergence Remote Execution Host, Slack/Teams Anton, and the Anton dashboard. All use the shared client contract; this additive change needs no wire-version migration or compatibility shim. Release this package through Changesets before enabling persona instructions in a client.
