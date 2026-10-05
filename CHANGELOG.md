# @mrck-labs/execution-host-protocol

## 0.20.0

### Minor Changes

- 787112f: Add host profile types and a defensive decoder for authenticated `GET /v0/host`,
  with `host.profile.v1`, `devices.iosSimulator.v1` and
  `devices.androidEmulator.v1` capability ids. The shared client exposes `host()`
  with its existing authentication, timeout and error handling.

  Session starts accept optional `requires` trait ids, preserved and validated by
  the start codec. Existing starts and health/handshake behavior stay compatible;
  the wire protocol version remains 1. Part of MAR-3699 (protocol only).

## 0.19.0

### Minor Changes

- 02d13c0: **BREAKING** — protocol 0.19, the resident-session wire (MAR-3679). One release
  for the resident-sessions wave: agents-daemon keeps one Claude Code process per
  session (R1, MAR-2881), and the wire says what that process is doing after it
  answers.

  Moving with it: **agents-daemon**, **accent.**, **Convergence** and
  **backpack.automations**. There are no compatibility paths: a reader on 0.19
  refuses a pre-0.19 host's turns, and a reader before 0.19 refuses an `answered`
  status.

  - **Breaking: session status `answered`**, between `running` and
    `completed`. The agent has answered, but tasks it started still run. Readers
    before 0.19 refuse it as `invalid-payload`.
  - **Breaking: `origin: "user" | "harness"` is required on `ExecutionTurn`.**
    `harness` is a turn Claude Code opened by itself, after a background task
    finished. A `turn.add` without one is `invalid-payload`, and a snapshot drops
    that turn with a warning. `decodeExecutionTurn` now returns only a turn's own
    fields rather than whatever rode along with them.
  - **`runningTasks` on `session.patch`**, and on the client's session snapshot
    (`runningTasks`, 0 when the host does not say).
  - **The `evidence` delta** — `{ kind: "evidence", turnId, evidence }`, carrying
    Convergence's `HarnessEvidence` union unchanged and under its own names
    (`HarnessEvidence`, `HarnessFact`, `AgentRunFact`, `TaskFact`,
    `SessionAgentRun`, `SessionTask`, …): agent runs, tasks, harness hooks,
    retries, compaction, denials, rate limits, init and MCP status, unknown
    harness families, and turn accounting. `decodeHarnessEvidence` reads one
    fact on its own. An evidence kind this build does not know is skipped at
    `event.delta.evidence.kind`.
  - **`agentRunId` and `taskId` on conversation items** (optional, patchable):
    which agent run or task produced the item; absent for the main agent.
  - **The `stop-task` command** (`{ kind: "stop-task", taskId }`): stops one task
    without interrupting the session.
  - **Capabilities** `sessions.resident.v1`, `evidence.v1` and
    `commands.stopTask.v1`.
  - **The README** lists every event, delta and command, and defines _settled_:
    `completed` or `failed`, no running tasks, nothing queued — the only time
    attention becomes `finished`.

  `EXECUTION_PROTOCOL_VERSION` stays 1.

## 0.18.0

### Minor Changes

- c373b01: The client reads the providers' catalogue and tears a session down (MAR-3671).

  accent.'s gateway on the shared client (MAR-3655) still sent two requests of its own, for want of a call. Both are on `ExecutionHostClient` now, and `protocolVersion` stays `1`; everything here is additive.

  **`providers()`** reads `GET /v0/providers`: each provider with its `id`, `label`, `available` and `authenticated` (absent when the host does not say), the `effortLevels` it takes, and its models — `slug`, `label`, `defaultEffort`, and `efforts` (a model's own `effortOptions`, or else its provider's `effortLevels`). The root gains `decodeExecutionProviderListResponse` and the types `ExecutionProvider`, `ExecutionProviderModel` and `ExecutionProviderListResponse`. Unknown fields are ignored; a provider without an `id`, a model without a `slug`, or an effort without an `id` makes the catalogue `malformed`. It takes the client's health timeout, not the request one.

  **`deleteSession(sessionId)`** sends `DELETE /v0/execution/sessions/:id` and answers `deleted`, or `no-session` (404) for a session the host does not have, so a retry after a lost answer is safe. Any other refusal is an `ExecutionHostError`. A follower of the session hears the host end its stream and then 404: `done` says `no-session`.

  **Command ids stay always sent.** The protocol says sending one is always safe, so the client does not grow a `commandId: null` for hosts that "do not read one": the answer's `commandId` stays a string, and a caller that stripped the id (accent.'s adapter) can delete it. `null` is refused like any id the host would refuse.

  **`events()` ends quietly when the caller aborts** — documented as the contract, as it is for `followSession`'s `stopped`. Check `signal.aborted` after the loop to tell an abort from the host closing the stream.

## 0.17.0

### Minor Changes

- 1b22961: A session's model and effort change between turns (MAR-3662).

  They were fixed when a session started: `send-message` had no model or effort, and nothing else could change them. People writing to one session together want to move it from Sonnet to Opus, or think harder, between one message and the next. `protocolVersion` stays `1`; everything here is additive.

  **Asking.** `ExecutionSessionPatchRequest` is the body of `PATCH /v0/execution/sessions/:id`: `{ title?, model?, effort? }`, with `encodeExecutionSessionPatchRequest` and `decodeExecutionSessionPatchRequest`. Strict, as requests into a host are: a patch naming no field, a field this build does not know, or a value of the wrong shape is `invalid-payload`, never dropped. `model` and `effort` are null (the default) or a non-empty id of at most 256 characters; `title` is null or a string. A patch naming only a title is the title patch hosts already took.

  **The answer.** `ExecutionSessionPatchResponse` and `decodeExecutionSessionPatchResponse` read both answers a host gives: the title-only `{ sessionId, title }` every host has sent, and a selection answer adding `protocolVersion`, `model` and `effort` — the selection the session's next turn runs on.

  **The capability.** `sessions.modelSelection.v1`: the host takes the change at any time, leaves a turn already running on what it started with, runs every turn that starts afterwards on the new selection (a turn runs on the selection in force when its `turn.add` was sent), checks the selection against its provider's catalog, and refuses one the catalog does not offer.

  **Followers.** `session.patch` may carry `model` and `effort` (null or a non-empty id; anything else makes the envelope `invalid-payload`, as for its other fields). A reader older than this one decodes such a patch as empty. The client's session snapshot carries `model` and `effort`, absent when the host does not report them — which is not the same as reporting the defaults — and dropped with a `dropped-invalid-field` warning when unreadable.

  **The client.** `patchSession(sessionId, patch)` sends the patch, refusing one the protocol would refuse before anything is sent, and answers `patched` with what the host holds now or `no-session` (404); a selection the host's catalog does not offer is its 400, thrown as an `ExecutionHostError` with the host's reason.

## 0.16.0

### Minor Changes

- 68b2526: One client for an execution host, at `@mrck-labs/execution-host-protocol/client`, with `followSession` (MAR-3638).

  Three clients spoke this protocol — Emergence's never-released one, Convergence's package with Backpack Studio's follow loop beside it, and accent.'s gateway — and none of them loaded where accent. runs: Node executing TypeScript by type stripping, which needs plain JavaScript with explicit extensions from its dependencies. This subpath is built like the root, to ESM and CommonJS JavaScript, and depends on nothing but the contract beside it. The root stays the contract and never imports it; the export check enforces that.

  `createExecutionHostClient({ baseUrl, token })` covers `health()` (the public `/health` with its capabilities, read without the token), `handshake()` (with the token probe: connected, unauthorized, incompatible, or unreachable — never thrown), `projects()`, `start()` (started or exists; a crossed echo is refused, an unreadable workspace echo degrades out loud), `command()` (every envelope carries `actor` and a minted or given `commandId`, checked before sending; accepted or no-session), `snapshot()` (null for a session the host does not have; its parts read by the contract's own decoders, unknown and unreadable entries dropped with warnings), and `events()`, one connection decoded into frames — envelopes, skipped newer kinds, unreadable frames, and the host's `replay` / `caught-up` boundary; frames under other names are ignored, as EventSource does, and a frame past `maxFrameLength` (16 MiB) fails the connection.

  Failures are `ExecutionHostError`s with a `kind` to branch on. The token never leaves the `Authorization` header: one no header could carry is refused when the client is made, without being repeated, and every message built from a failure, or from a host's refusal, has it scrubbed. Requests refuse redirects, timeouts must be positive and are clamped to what a timer holds, and a listener's throw or rejection never reaches the request or the process.

  `followSession(sessionId, { afterSeq, deltas, onEnvelope, onGap, onSkip, onStatus })` follows a session for as long as it is asked to. A finished turn never ends it. It reconnects with `Last-Event-ID` after 1 s doubling to 30 s, indefinitely unless `maxAttempts` is set; a connection that kept a frame or stayed open `healthyAfterMs` (30 s) starts the count over, and one that only answered `caught-up` does not. A connection silent for 90 s is replaced. Handlers are awaited; an envelope whose handler threw is delivered again; `info.cursor` is the cursor to persist in the same write. It drops replayed duplicates, forgives holes the host vouches for (the first frame of a connection, or anything inside a named replay before its `caught-up`), and treats a live hole as loss: `onGap` hears it, may return a refetched snapshot's `lastSeq`, and the stream resumes. Unknown kinds and unreadable frames are stepped over with `onSkip`, the latter with `onGap` too; an envelope about another session never moves the cursor. `stop()` ends it at once — safe to await inside a handler, which is abandoned and sees `info.signal` abort — and `done` resolves with `stopped`, `no-session` (404), `unauthorized` (401/403), `gave-up` or `crashed`, never rejecting.

  The root gains decoders for contract shapes read outside an envelope, which the snapshot reader uses rather than a second copy of the rules: `decodeExecutionConversationItem` (an unknown kind is `unknown-kind`, for a list reader to drop), `decodeExecutionTurn`, `decodeExecutionTurnFileChange`, `decodeExecutionContextWindow`, `decodeExecutionActivitySignal`, and `decodeExecutionSessionMetadata`.

## 0.15.0

### Minor Changes

- 24d228e: Commands say who sent them, user messages say who wrote them, and an unknown kind is skipped instead of failing the envelope (MAR-3633).

  Several people can now drive one session through one client, and the wire had no way to say which of them did what: a user message carried only its role, and approvals, stops and steers carried nothing at all. `protocolVersion` stays `1`; every field here is optional, and existing payloads decode and re-encode unchanged.

  **Who sent it.** Every command envelope, and the start request, may carry an `actor` — `{ kind: "person" | "agent", id, displayName }`, in the sending client's own namespace — and a `commandId`, the client's own id for the command, unique within the session and reused on a retry. A host refuses either one present but unreadable (`invalid-payload`) rather than dropping it: a dropped actor records the command as anonymous and a dropped id breaks the sender's match with its echo, and both look like success. A host predating this ignores both, so sending them is safe everywhere.

  **Who wrote it.** A user `message` item may carry `author` (an `ExecutionActor`) and `clientMessageId` — the `commandId` of the `send-message`, `steer` or start request that created it — so a client can match the transcript to its own sends. Both are fixed at creation: the patch type omits them and the patch decoder ignores them. A reader drops an unreadable one with a `dropped-invalid-field` warning and keeps the message.

  **Unknown kinds are skipped, not fatal.** `decodeExecutionEventEnvelope` used to reject an envelope of an unknown event or delta kind as `unknown-kind`, and of an unknown item kind as `invalid-payload`. All three are now `unknown-kind` with `skipped: { sessionId, seq, path, kind }`, so a stream reader can step over the envelope and keep its cursor moving instead of reading a gap. An item of a newer kind must still carry the base fields every item shares, and command kinds stay strict: a host must not silently drop a command it cannot execute.

  New capability ids: `commands.actor.v1` (the host reads and records `actor` and `commandId`), `items.author.v1` (the host echoes `author` and `clientMessageId` on user messages), and `deltas.append.v1`, which hosts already advertised for negotiated text increments and is now named here.

## 0.14.0

### Minor Changes

- Environments are a third organ, and a session's work address is explicit (ADR-0011, MAR-2696).

  A remote run had no environment: the wire carried no way to say which variables a session should be prepared with, so a host could only hand the child its own whole environment — every session on a box seeing every secret on that box, because nobody had a way to say otherwise. This adds the contract that lets a host say otherwise. `protocolVersion` stays `1`; every field here is optional or new, and existing payloads decode and re-encode unchanged.

  **The work address.** `ExecutionStartRequest.environment` names a template on the host. A residency (Project) naming none gets the Project's default; an errand naming none runs naked, on the base set alone. A malformed name is refused rather than dropped — dropping it would run the session on the base set, which looks like success and is the one outcome the caller did not ask for.

  **The echo.** `ExecutionSessionWorkspace` is a discriminated union a host fills in both modes: `mode: "repository"` for an errand's clone, `mode: "project"` for a residency, each carrying the `environment` that was actually prepared. Project mode reports `origin`, `originKey`, the checkout's actual `branchName` at start, and `requestedBranchName` when the two differ, so a mismatch is visible instead of quietly reconciled. `decodeExecutionSessionWorkspace` reads a pre-ADR-0011 echo — a bare `{ repository, branchName, baseRef }` with no discriminator — as a repository address; encoding always writes `mode`.

  **Project origin.** `ExecutionProject` gains `origin` (credential-redacted) and `originKey`, so "is this advertised Project my local checkout?" is an equality test rather than an exercise in URL normalization that every client gets subtly differently. `normalizeOriginKey` is the shared answer: it collapses ssh, scp-like, https and credentialed spellings, ports, trailing slashes, `.git` and case onto one `host/owner/repo` key, and is total over its own output. Hosts predating `projects.v2` decode to `origin: null`, `originKey: null`, `environments: []` — unknown, never guessed.

  **The environments contract, read and declare only.** `ExecutionEnvironment` lists a template's key **names**, its `includes`, and whether the host actually has every value (`provisioned`, `missing`). `decodeExecutionEnvironmentDeclaration` reads the declarable half — the shape, never the contents.

  **No value crosses this wire.** Every environment-shaped decoder rejects a payload carrying a `values` field, whatever it holds and however empty. Presence is the offence: stripping the field would answer 200 and teach the caller that sending secrets here works, and this door does not exist.

  New capabilities: `projects.v1` (now named, having always been advertised), `projects.v2`, `environments.v1`.

## 0.13.0

### Minor Changes

- db56179: Patches may carry a negotiated text increment: `patch.textAppend`.

  A `conversation.item.patch` normally carries `text` — the item's whole text as of that envelope. That is self-healing, since any single patch is enough to reach the right state, but it makes a stream cost the square of its own length: every envelope restates everything before it. One production session spent 1.51 GB of envelopes on a ~110 KB reply (MAR-2218).

  `textAppend` is the text to append to the item's current text instead. It is an additive optional field, **not** a new envelope kind, and it is opt-in end to end: a host advertises `deltas.append.v1` and only sends increments to a subscriber that asked for them. Anything that does not ask sees byte-identical full-text patches, so adopting this is a no-op for every existing client.

  The decoder validates it as a string and drops it with the usual `dropped-invalid-field` warning otherwise, alongside its siblings. It is a patch-only field: an item never _holds_ a `textAppend`, so it is deliberately not derived from the item shape the way every other patch field is.

  The README gains the ordering and fallback rules a client must follow — appends apply strictly in `seq` order, a client that cannot be certain it has every append falls back to the snapshot or the next full-text patch rather than guessing, `text` wins when both are present, and a terminal patch always restates the whole text.

## 0.12.0

### Minor Changes

- 527daf0: Add bounded research evidence packs to session starts and follow-up messages.

## 0.11.0

### Minor Changes

- d44481d: Expose the additive asynchronous Room founding lifecycle while preserving legacy Room and christening responses.

## 0.10.0

### Minor Changes

- 867b449: Add Room v1 capability negotiation, optional Session room identity, and defensive Room API contracts.

## 0.9.0

### Minor Changes

- 78031a2: Add optional repository roots to turn file changes and advertise multi-repository capture capability.

## 0.8.0

### Minor Changes

- 0afe2d9: Add structured interaction request and response shapes, typed answer delivery, and capability identifiers for structured interactions and queued-message cancellation.

## 0.7.0

### Minor Changes

- dfec78d: Add a cancel-queued command and cancelled message-delivery state for queued follow-up cancellation.

## 0.6.2

### Patch Changes

- 9986b7a: Add validated live PR URL session patches and the combined turn-file-change capability identifier.

## 0.6.1

### Patch Changes

- 438d43f: Add optional queued, delivered, undelivered, and steered delivery state to message conversation items.

## 0.6.0

### Minor Changes

- 4f3d2c9: Add universal turn lifecycle deltas, per-turn file-change metadata, and the
  `turns.fileChanges` capability. Add native steer and interrupt commands with
  optional provider turn preconditions.

## 0.5.0

### Minor Changes

- 2f58fca: Add the optional provider permission configuration to Session start requests while retaining the legacy automation flag.

## 0.4.0

### Minor Changes

- 0965781: Add persisted attachment metadata to conversation message items.

## 0.3.0

### Minor Changes

- a427e2f: Add a typed, additive inline-image attachment payload and capability for execution start and send-message envelopes while preserving the legacy opaque attachment field.

## 0.2.5

### Patch Changes

- c41ec9b: Enable npm publishing: add `repository`, `homepage`, and `bugs` metadata (required for provenance), add a concurrency guard to the release workflow, and document the Changesets release flow plus the one-time `NPM_TOKEN` setup.

## 0.2.4

### Patch Changes

- Keep conversation item identifiers and kinds immutable when decoding item patches.

## 0.2.3

### Patch Changes

- Validate every known conversation item patch field and report dropped invalid values without interrupting the event stream.

## 0.2.2

### Patch Changes

- Build dual Node exports with the TypeScript compiler so git dependencies can run prepare under Bun without installing package-local development tools.

## 0.2.1

### Patch Changes

- Publish dual ESM and CommonJS entry points so Electron main and other CommonJS consumers can load the protocol contract.

## 0.2.0

### Minor Changes

- Add an extensible execution-protocol capability descriptor for additive health negotiation.

## 0.1.1

### Patch Changes

- Run package verification and Changesets against the repository's main branch.
