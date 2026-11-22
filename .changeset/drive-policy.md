---
"@mrck-labs/execution-host-protocol": minor
---

Add who drove it (`actor.via`), a provider's drive policy, and Antigravity's permission part (MAR-5634).

**Breaking: `ExecutionActor.via` is required.** It is `"app" | "token" | "automation" | "line"` (`EXECUTION_ACTOR_VIAS`): a person in accent.; their AI app, through one of their tokens; an Automation or a schedule, and any persona one starts; or a queued start that the line fired. A command envelope or a start request whose actor has no `via`, or one this build does not know, is refused as `invalid-payload`. A user message's echoed `author` stays tolerant: it is now `ExecutionMessageAuthor`, whose `via` is absent when a host recorded it before `via`, or when this build does not know it. This is a break under 0.x, so it is a minor version.

**The rollout order:**

1. accent. sends `via` first. Daemons on older versions drop it, because their `decodeActor` ignores fields it does not define.
2. Daemons that require it deploy after that.
3. Convergence pins `^0.14.0` and isn't affected.

**The drive policy.** `ExecutionProvider.drivePolicy?` (`ExecutionDrivePolicy`) is who may drive a provider on a host, and how many of its sessions run at once: `ownerId` (the accent. person whose sign-in it is, or null), `allow` (`tokenDriven`, `automations`, `waitForRoom`, `afterChains`, `anyHost`, `others`), `maxConcurrentSessions` and `liveSessions`. It is configuration on the host. `decodeExecutionDrivePolicy` reads one strictly. The provider listing reads one it cannot read as absent, and names it in `warnings` (`providers.N.drivePolicy`) without costing the catalogue.

Queueing is two switches, as MAR-5633 decided:

- `waitForRoom` lets a single start wait in its host's line for a free turn. It is on by default.
- `afterChains` lets a start chain `after` another session. It is off by default.

There is no `queued` switch. An `after` chain needs `afterChains` alone, never `waitForRoom` as well: whether the line fires it or it may also wait for room.

**One rule.** `drivePolicyRefusalOf(policy, ask)` in `src/drive-policy.ts` is the one implementation, for the daemon, the in-app runtime, accent.'s server and its UI. The ask is `{ providerId, actor?, act: "start" | "input" | "control", waitForRoom?, afterChain?, anyHost?, needsNewProcess }`. It returns null, or `{ code: "drive-policy-refused", reason, flag?, message }`.

- The reasons are `no-owner`, `no-actor`, `not-owner`, `token-driven-off`, `automation`, `wait-for-room`, `after-chain`, `any-host` and `at-capacity`.
- The flag names the host's switch as `<providerId>.<flag>`: `antigravity.allowTokenDriven`, `allowAutomations`, `allowWaitForRoom`, `allowAfterChains`, `allowAnyHost`, `allowOthers` or `maxConcurrentSessions`.
- `control` (interrupt, stop, stop-task, cancel-queued) is never refused.

`decodeExecutionDrivePolicyRefusal` reads a host's refusal. The client's `providers()` passes the catalogue's decode warnings, such as an unreadable `drivePolicy`, to `onWarnings` as `{ operation: "providers", sessionId: null, warnings }`.

**Capability `providers.drivePolicy.v1`.** A host advertising it enforces the policy it reports on every start and every command. A client never sends a start for a provider whose policy it can't read to a host without it. `hostEnforcesDrivePolicy(health)` is on the client.

**Antigravity's permission part.** `ExecutionPermissionConfig.antigravity?: { mode }` and `ExecutionProviderPermissions.antigravity?: { modes }` are new, with `mode` one of `default`, `accept-edits`, `auto` or `plan` (`ExecutionAntigravityPermissionMode`). They are read like the Claude Code and Codex parts: strictly on a start and a patch, and tolerantly in the listing. The provider id stays a free string.

**Fix: every permission value is a string from the known set.** A preset, mode, policy, sandbox, reviewer or collaboration mode was matched after `String()`, so an array that printed as a known value (`["plan"]`) was accepted, and an object that cannot print (`{ "toString": null }`) threw instead of being refused. Both are now `invalid-payload`, in every provider's part.
