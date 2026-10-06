---
"@mrck-labs/execution-host-protocol": minor
---

Fix the host profile shipped in 0.20.0 (MAR-3725). Nobody depends on that
profile yet: the daemon's half of MAR-3699 is unbuilt, and no client consumer
of `host()` was found.

What differs from 0.20.0, on the wire:

- **`requires` is enforced only where a host says so, and confirmed.** A new
  capability, `start.requires.v1`, means "this host checks `requires`,
  refuses a 400 coded `requirements-unmet` with `missingTraits`, and echoes
  the `requires` it checked on its 201". `host.profile.v1` now means only
  "this host serves `GET /v0/host`". In 0.20.0 it also stood for enforcement,
  which a host predating `requires` could not honour. A host built from
  0.20.0's README must also advertise `start.requires.v1` and send the echo.
  New: `ExecutionStartRequirementsRefusal`,
  `decodeExecutionStartRequirementsRefusal`,
  `EXECUTION_START_REQUIREMENTS_UNMET`, `ExecutionStartRequirementsEcho`,
  `confirmsExecutionStartRequirements`.
- **Android system images gain `apiMinor` and `codename`.** `apiLevel` stays
  the positive integer 0.20.0 published. A minor level goes in `apiMinor`
  (`36.1` is `36` + `1`), and a preview names its `codename`. New type name:
  `ExecutionHostAndroidSystemImage`. This is additive: a 0.20.0 reader reads a
  profile from a newer host and ignores the two fields (checked against the
  published 0.20.0). An earlier draft of this change made `apiLevel` a float,
  which a 0.20.0 reader would have refused.

In the decoder:

- **One bad inventory entry no longer costs the profile.**
  `decodeExecutionHostProfile` drops an unreadable trait, toolchain, runtime,
  device type, system image or AVD, or a whole device family, with a
  `dropped-invalid-field` warning at its path. Identity and platform stay
  strict. A refusal names the field in `ExecutionDecodeResult`'s new optional
  `path`. In 0.20.0 any bad entry refused the whole profile, with no path.
- **Bounded.** Strings are 1 to 256 characters, lists are read to their
  1024th entry, and at most 64 drops are named. 0.20.0 had no length bounds,
  so a profile with a longer id or label is now refused, and a longer entry
  is dropped.
- Slot counts must be safe integers (as 0.20.0 required). The shape checks
  are shared between `codecs.ts` and the profile in one internal module.
  Deliberately, the profile carries no `protocolVersion`; the README says why.

In the client (`./client`). These change behaviour, or break compilation for
a caller of the APIs named:

- **`host()` returns `{ profile, warnings }`** (`ExecutionHostProfileReading`),
  not the bare profile, so a drop is visible where the profile is read. The
  client's `onWarnings` also hears profile drops, as
  `{ operation: "host", sessionId: null, warnings }`. Its notice is now the
  union `ExecutionWarningsNotice`, so `sessionId` is `string | null`. Code
  that called `host()` against 0.20.0, or that treats a notice's `sessionId`
  as a `string`, must change.
- **A start with `requires` is checked first.** `start()` with a non-empty
  `requires` reads `/health` first, within the health timeout or the
  caller's `timeoutMs` when shorter. So such a start makes two requests, can
  take up to that much longer, and can fail with an `ExecutionHostError`
  whose `operation` is `health`. When the host lacks `start.requires.v1` (or
  its descriptor is unreadable), it throws `ExecutionStartRequirementsError`
  (`requirements-unenforced`) and sends nothing. In 0.20.0 the client sent
  the start and could get `started` on a host without the traits.
- **New error class.** The host's coded 400 is `ExecutionStartRequirementsError`
  (`requirements-unmet`). Its `missingTraits` is limited to the required
  traits, and its reason is scrubbed and cut. A 201 without the echo is the
  same error (`requirements-unconfirmed`), carrying the `sessionId` that
  did start. **`ExecutionStartRequirementsError` is not an
  `ExecutionHostError`**: a caller converting errors must check for both. An
  uncoded refusal, or a coded one on any status but 400, stays an
  `ExecutionHostError`.
- A `requires` that is not an array of non-empty strings is a `TypeError`
  before anything is sent. `hostEnforcesStartRequirements(health)` is new.
- A start without `requires` is unchanged: one request, the same bytes.

The wire protocol version stays 1. On the wire, every change is additive
except one semantic narrowing a 0.20.0 host implementer must act on:
`host.profile.v1` no longer implies enforcement.
