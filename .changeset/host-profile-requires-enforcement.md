---
"@mrck-labs/execution-host-protocol": minor
---

Fix the host profile shipped in 0.20.0 (MAR-3725). Nobody depends on that
profile yet: the daemon's half of MAR-3699 is unbuilt.

What differs from 0.20.0:

- **`requires` is enforced only where a host says so.** A new capability,
  `start.requires.v1`, means "this host checks `requires` before starting".
  `host.profile.v1` now means only "this host serves `GET /v0/host`". In 0.20.0
  it also stood for enforcement, which a host predating `requires` could not
  honor: it dropped the field and started anyway. A host implementing 0.20.0's
  README must advertise `start.requires.v1` as well.
- **The client refuses an unenforceable start itself.** `start()` with a
  non-empty `requires` reads `/health` first. When the host lacks
  `start.requires.v1`, it throws the new `ExecutionStartRequirementsError`
  (`code: "requirements-unenforced"`) and sends nothing. In 0.20.0 the client
  sent it and could get `started` on a host without the traits. A start
  without `requires` is unchanged: one request, no probe, the same bytes. New
  predicate: `hostEnforcesStartRequirements(health)`.
- **The host's refusal is machine-readable.** A refused start's 400 body
  carries `code: "requirements-unmet"` and `missingTraits`
  (`ExecutionStartRequirementsRefusal`, `decodeExecutionStartRequirementsRefusal`,
  `EXECUTION_START_REQUIREMENTS_UNMET`). The client surfaces it as
  `ExecutionStartRequirementsError` (`code: "requirements-unmet"`). A refusal
  without that code stays an `ExecutionHostError`, as in 0.20.0.
- **One bad inventory entry no longer costs the profile.**
  `decodeExecutionHostProfile` drops an unreadable trait, toolchain, runtime,
  device type, system image or AVD, or a whole device family, with a
  `dropped-invalid-field` warning at its path. `host({ onWarnings })` hears
  them. Identity and platform stay strict, and a refusal now names the field
  in the result's new optional `path` (`ExecutionDecodeResult`), which
  `host()`'s `malformed` reason repeats. In 0.20.0 any bad entry refused the
  whole profile, with no path.
- **Android API levels are what the SDK repository names.**
  `systemImages[].apiLevel` is any positive number (`36.1`, not only `36`),
  and an image may carry a preview `codename` (`CANARY`). The entry type is
  now named `ExecutionHostAndroidSystemImage`. 0.20.0 refused a minor level
  and with it the whole profile.
- The profile's slot counts use the integer rule the rest of the contract
  uses (`Number.isInteger`, shared from one module), so a count past
  `Number.MAX_SAFE_INTEGER` is no longer refused. Deliberately, the profile
  carries no `protocolVersion`; the README says why.

Additive on the wire, and the wire protocol version stays 1. One semantic
narrowing a 0.20.0 implementer must act on: `host.profile.v1` no longer
implies enforcement. The client also behaves differently for a start with
`requires` against a host without `start.requires.v1`: it refuses instead of
sending. Both changes are the fix itself. No released host implements either
0.20.0 behavior.
