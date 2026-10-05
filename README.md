# Execution Host Protocol

Public, transport-agnostic wire contract shared by agent execution runtimes and
clients. It contains TypeScript types plus dependency-free runtime codecs for
the versioned JSON envelopes used to start Sessions, send commands, and stream
events — and, under its `client` subpath, one client that speaks them to a
host over HTTP and SSE.

## Boundaries

The package root is the contract: public request/envelope types, defensive
validators, encoders, and recorded contract fixtures. It has no transport and
never imports the client, so a consumer of the contract loads none.

`@mrck-labs/execution-host-protocol/client` is the one place the contract meets
HTTP: a host's routes, its event stream, stream sequencing, and the session
snapshot it serves. It has no dependencies beyond the contract beside it.

Excluded from both: persistence, provider implementations, and daemon-internal
state.

Readers ignore unknown object fields so additive producers remain compatible.
Required known fields and discriminants are still validated. Package semver
tracks library releases; `EXECUTION_PROTOCOL_VERSION` tracks wire compatibility.

## Streaming text: full patches and negotiated increments

A `conversation.item.patch` normally carries `text`: the item's **whole** text
as of that envelope. That is simple and self-healing — any single patch is
enough to reach the right state — but it makes a stream cost the square of its
own length, because every envelope restates everything before it. One
production session spent 1.51 GB of envelopes on a ~110 KB reply (MAR-2218).

A host may therefore offer `patch.textAppend`: the text to **append** to the
item's current text. It is an additive field, not a new envelope kind, and it
is **opt-in**. A host advertises `deltas.append.v1` among its capabilities, and
a subscriber that wants increments asks for them when it subscribes. A
subscriber that does not ask receives full-text patches exactly as before —
adopting this changes nothing for a client that ignores it.

Rules a client must follow:

- **Order matters.** Appends apply strictly in `seq` order onto the item's
  current text. Applying them out of order, or twice, corrupts the item;
  `text` has neither property, which is why it stays the default.
- **Never guess after a gap.** A client that cannot be certain it has every
  append in order — after a resume, after a dropped connection, or when it
  joined mid-item — must not try to reconstruct. It falls back to the session
  snapshot or to the item's next full-text patch, both of which always carry
  the complete text.
- **`text` wins.** The two are alternatives, not a pair to merge. When a patch
  carries both, `text` is authoritative and `textAppend` is redundant.
- **A terminal patch always carries `text`.** An item leaving `streaming`
  restates its whole text, so every stream ends on a self-contained value no
  matter what happened in the middle.

## Who sent it: actors and command ids

Several people may drive one session through one client, so a command says who
sent it. Every command envelope, and the start request, may carry an `actor` —
a person or an agent, by the sending client's own id for them and the name it
showed — and a `commandId`, the client's own id for that command: unique within
the session, reused when the same command is retried.

```json
{
  "protocolVersion": 1,
  "sessionId": "accent_8f2c",
  "commandId": "4b7e1a52-6f0e-4d0b-9a57-0c3f5d2e8a11",
  "actor": { "kind": "person", "id": "usr_piotr", "displayName": "Piotr" },
  "command": { "kind": "send-message", "text": "Ship the staging banner" }
}
```

A host advertising `items.author.v1` echoes both on the user `message` item the
command created — `author`, and the command id as `clientMessageId` — so a
client can match the transcript to its own sends. A `send-message` or `steer`
creates such an item; so does the start request, for the initial message.
Beside the fields every item carries, it reads:

```json
{
  "kind": "message",
  "actor": "user",
  "text": "Ship the staging banner",
  "delivery": "queued",
  "author": { "kind": "person", "id": "usr_piotr", "displayName": "Piotr" },
  "clientMessageId": "4b7e1a52-6f0e-4d0b-9a57-0c3f5d2e8a11"
}
```

(The item's `actor` stays what it was, the role. The person is the `author`.)

- **Optional, everywhere.** An envelope without either decodes exactly as
  before, and a host predating them (0.14 and older) ignores both, so sending
  them is always safe. A host advertising `commands.actor.v1` reads and records
  them.
- **Strict coming in, tolerant going out.** A host refuses, as
  `invalid-payload`, a command or start request whose `actor` or `commandId` is
  present but unreadable — an unknown actor kind, `null`, an empty id or name,
  or one over 256 characters — because dropping either would look like success.
  A reader drops an unreadable `author` or `clientMessageId` from an item with a
  `dropped-invalid-field` warning and keeps the message.
- **Fixed at creation.** A patch never carries `author` or `clientMessageId`,
  and a reader ignores them if one does.
- **The host records; the client vouches.** `actor` is the sending client's
  word. A host has no users of its own, so authorizing who may act stays with
  the client that knows them.

## Changing the model between turns

A session's model and effort are set when it starts (`config.model`,
`config.effort`). On a host advertising `sessions.modelSelection.v1` they
change between turns, by patching the session:

```http
PATCH /v0/execution/sessions/accent_8f2c
Content-Type: application/json

{ "model": "claude-opus-5-5", "effort": "high" }
```

The host answers with the selection the next turn will run on:

```json
{
  "protocolVersion": 1,
  "sessionId": "accent_8f2c",
  "model": "claude-opus-5-5",
  "effort": "high"
}
```

- **Any time; from the next turn.** The host takes a change whether the
  session is idle or mid-turn. A turn already running keeps what it started
  with, and every turn that starts afterwards runs on the new selection — a
  message queued behind the running turn included — resuming the same
  conversation. Exactly: a turn runs on the selection in force when its
  `turn.add` was sent, so a follower can tell what each turn ran on from the
  stream alone.
- **Checked against the catalog.** The model must be one the session's
  provider offers, and the effort one that model takes — or, with the
  provider's default model, one the provider takes. Anything else is a `400`
  that says which. null asks for the default. A field left out keeps its
  value, and it is the selection that results which is checked. The provider
  itself never changes: continuation tokens belong to it.
- **Strict coming in.** `ExecutionSessionPatchRequest` is
  `{ title?, model?, effort? }`; a patch naming none of them, or anything else,
  is `invalid-payload` (`decodeExecutionSessionPatchRequest`). One naming only a
  title is the title patch hosts have always taken, answered as always with
  `{ sessionId, title }`.
- **Followers hear it.** The change is a `session.patch` delta carrying
  `model` and `effort` together. A reader older than 0.17 decodes it as an
  empty patch and carries on. The session's snapshot carries its current
  `model` and `effort`; a host that does not report them leaves both absent,
  which is not the same as reporting the defaults.

## New kinds without breaking old readers

Readers have always ignored unknown _fields_; an unknown _kind_ used to fail the
whole envelope. `decodeExecutionEventEnvelope` now reports an event, delta, or
item kind it does not know as `unknown-kind` **with** `skipped`: where the
envelope sat in the stream.

```json
{
  "ok": false,
  "reason": "unknown-kind",
  "skipped": {
    "sessionId": "accent_8f2c",
    "seq": 42,
    "path": "event.delta.item.kind",
    "kind": "image"
  }
}
```

A stream reader steps over it: it applies nothing, moves its cursor to `seq`,
and reads on, without mistaking the frame for a gap. That is what lets a host
add a kind without breaking the readers that predate it.

- **Only well-formed envelopes are skippable.** A newer item still carries the
  fields every item shares (`id`, `state`, timestamps, `providerMeta`); without
  them it is `invalid-payload`. A later patch for an item you skipped names an
  id you do not hold: skip it too.
- **Commands are not.** A host refuses a command kind it does not know, since a
  silently dropped command is worse than a refused one. A client checks a
  capability before sending a newer command.
- **Every new kind comes with a capability id** on `/health`, so a client knows
  it can arrive. Readers older than 0.15 still reject unknown kinds, so until
  they are gone a host sends a new kind only to a subscriber that asked for it,
  the way increments wait for `?deltas=append`.

## The events

An event envelope carries one event; a `delta` carries one change to the
session's record.

| Event                | Carries                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `delta`              | one of the deltas below                                                                                        |
| `status`             | the session's status: `idle`, `running`, `answered`, `completed` or `failed`                                   |
| `attention`          | what the session needs: `none`, `needs-input`, `needs-approval`, `finished` or `failed`                        |
| `continuation-token` | the provider's token for resuming the conversation                                                             |
| `context-window`     | how full the context window is, or why that is unknown                                                         |
| `activity`           | what the agent is doing now: `streaming`, `thinking`, `compacting`, `waiting-approval`, `tool:<name>`, or null |
| `heartbeat`          | nothing; the host is there                                                                                     |

| Delta                     | Carries                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.patch`           | `status`, `attention`, `activity`, `contextWindow`, `continuationToken`, `prUrl`, `roomId`, `model`, `effort`, `runningTasks`, `updatedAt` — whichever changed |
| `conversation.item.add`   | a new item, with `agentRunId` and `taskId` when a subagent or a task produced it                                                                               |
| `conversation.item.patch` | an item's changed fields, or `textAppend`                                                                                                                      |
| `turn.add`                | a new turn, with its `origin`                                                                                                                                  |
| `turn.patch`              | a turn's `endedAt`, `status` or `summary`                                                                                                                      |
| `turn.fileChanges.add`    | the files a turn changed                                                                                                                                       |
| `evidence`                | one fact of the harness's record — `turnId` and `evidence`                                                                                                     |

Commands: `send-message`, `approve`, `deny`, `steer`, `interrupt`,
`cancel-queued`, `stop-task` and `stop`.

## Resident sessions: answered, settled, and the agent's own work

On a host advertising `sessions.resident.v1` (protocol 0.19, MAR-3679) a
session keeps one provider process for its whole life, so the agent's work can
outlive its answer: a test run it backgrounded, a subagent it sent off.

- **`answered`** sits between `running` and `completed`. The agent has
  answered, but tasks it started still run. `session.patch` carries
  `runningTasks`, how many; the host sends it whenever the count changes, 0
  included. A session's snapshot carries it too (0 when the host does not
  say).
- **A turn has an `origin`.** `user` — a person's message opened it. `harness`
  — the provider opened it by itself, as Claude Code does when a background
  task finishes and it reports back. It is required on every turn, and fixed
  when the turn is added.
- **Settled** is `completed` or `failed`, with `runningTasks` at 0 and nothing
  queued. Attention `finished` comes only then: an answer with work still
  running is not the end of it, and neither is one with a message waiting
  behind it.
- **`stop-task`** (`{ kind: "stop-task", taskId }`, `commands.stopTask.v1`)
  stops one task, by the `taskId` its evidence named, and leaves the session
  and its turn running.

### Evidence

On a host advertising `evidence.v1`, an `evidence` delta carries one fact of
the harness's record of the session:

```json
{
  "kind": "evidence",
  "turnId": "turn-3",
  "evidence": {
    "kind": "task.changed",
    "taskId": "task-b7x2",
    "at": "2026-10-03T21:40:00.000Z",
    "patch": { "status": "completed", "endedSummary": "212 tests passed" }
  }
}
```

`evidence` is Convergence's `HarnessEvidence`, unchanged and under its own
names (`marckraw/convergence`, `harness-evidence.types.ts`; MAR-2869), so
Convergence applies a remote session's evidence as it applies its own:
`HarnessEvidenceService.apply(sessionId, delta.turnId, delta.evidence)`.
`turnId` is null for a fact that belongs to no turn, such as a process ending
between turns. The members:

- **Agent runs** — `agent.started`, `agent.identified`, `agent.changed`,
  `agent.ended`, keyed by `spawnedByItemId`, the item that spawned the run; and
  `process.ended`, which settles every run and task still open.
- **Tasks** — `task.changed`: one patch per change, start, progress and end
  alike, carrying `status`, `description`, `endedSummary` and the rest of what
  changed.
- **The harness** — `harness.hook`, `harness.retry`, `harness.compaction`,
  `harness.denial`, `harness.rateLimit`, `harness.init`, `harness.mcpStatus`;
  and `harness.unknown`, an event family the model keeps without modelling.
- **Turn accounting** — `turn.accounting`: the result subtype, usage, cost,
  permission denials and subagent stats of the turn named by `turnId`.

An item a subagent or a task produced says so: `agentRunId` names the run (its
`agent.started` id, or the id `agent.identified` renamed it to), `taskId` the
task. Both are absent for the main agent's own items, and a host patches either
in when it learns it after the item was added.

- **Strict about the model.** Every field `HarnessEvidence` names is checked,
  optional ones included, because a fact applied with a field dropped is a
  projection wrong without saying so: one present with the wrong shape is
  `invalid-payload`. The `unknown`-typed fields (`usage`, `payload`, …) are
  required keys whose value is the harness's own; send null for none. Fields
  the model does not name are ignored.
- **A newer fact is skipped.** An evidence kind this build does not know is
  `unknown-kind`, at `event.delta.evidence.kind`, and a follower steps over it.

## Host identity, devices, and start requirements

On a host advertising `host.profile.v1`, authenticated `GET /v0/host` returns
an `ExecutionHostProfile` directly (no envelope). `decodeExecutionHostProfile`
in the package root reads it; the shared client's `host()` fetches and decodes
it with the bearer token and the health timeout.

The profile names the host (`id`, `label`), its `platform` (`os`, `arch`,
`osVersion`), probed `traits` and `toolchains`, and when those facts were
checked (`checkedAt`). OS, architecture and trait ids are open strings. A host
with no device tools reports empty traits and toolchains and may omit
`devices`; the reader never infers tools from the OS. A toolchain has an `id`,
`version`, and optional `build`.

Device capabilities advertise probed inventories:

- `devices.iosSimulator.v1`: `devices.iosSimulator` has `runtimes` (each an
  `id`, `name`, `version`), `deviceTypes` (ids), and `slots`.
- `devices.androidEmulator.v1`: `devices.androidEmulator` has `systemImages`
  (each an `id`, positive integer `apiLevel`, `abi`), `avds` (names), and
  `slots`.

Each `slots` contains non-negative integer `inUse` and `max` (a non-negative
integer, or null when no limit is reported). These are a snapshot, not a
reservation. Absent inventories are unknown, not fabricated empty inventories.
Unknown fields are ignored; malformed known fields, even in optional device
inventories or toolchain builds, make the profile unreadable.

**Authenticated only.** `/health` advertises the capability ids, never the
profile or device inventory. `health()` and `handshake()` keep their existing
requests; callers fetch a profile explicitly with `host()`. An older host's
404 is `ExecutionHostError` of kind `not-found`, never an empty profile.

**A start says what it needs.** `ExecutionStartRequest.requires?: string[]`
names traits at the top level, for example `requires: ["ios.simulator"]`.
Absent or empty requires none. Present requirements must be an array of
non-empty strings; an invalid one is `invalid-payload`, never dropped.
Unknown trait ids remain intact for the host to decide.

A host advertising `host.profile.v1` checks every required trait against its
profile before preparing a workspace or starting a provider, and refuses a
missing trait with a readable `400`, for example
`Missing required host traits: ios.simulator`. The client surfaces its reason
as an `ExecutionHostError`. The host is authoritative: a cached profile may
be stale. A client must check `host.profile.v1` before relying on `requires`,
since hosts predating this addition may ignore it. Device allocation and
probing are the host implementation's work, outside this package.

## The client

Three clients spoke this protocol, each with what the others lacked (MAR-3638):
Emergence's, Convergence's, and accent.'s gateway. This is the one that replaces
them. It is built to plain JavaScript with explicit extensions — ESM and
CommonJS, like the root — so it loads where TypeScript is never compiled: Node
running `.ts` by type stripping, Bun, Electron, browsers, and React Native with
a `fetch` passed in.

```ts
import { createExecutionHostClient } from "@mrck-labs/execution-host-protocol/client";

const host = createExecutionHostClient({ baseUrl, token });

await host.handshake(); // { status: "connected" | "unauthorized" | "incompatible" | "unreachable", health, detail }
await host.start(startRequest); // { status: "started" | "exists", sessionId, commandId, workspace }
await host.command(
  sessionId,
  { kind: "send-message", text: "Ship it" },
  { actor: { kind: "person", id: "usr_piotr", displayName: "Piotr" } },
); // { status: "accepted" | "no-session", commandId }
await host.patchSession(sessionId, {
  model: "claude-opus-5-5",
  effort: "high",
}); // { status: "patched" | "no-session", sessionId, model, effort }

const follow = host.followSession(sessionId, {
  afterSeq: savedCursor, // what was persisted with the last envelope applied
  deltas: "append",
  onEnvelope: async (envelope, { cursor, signal }) => {
    // One write: the envelope and the cursor to resume after it.
    await applyAndSaveCursor(envelope, cursor, { signal });
  },
  onGap: async (_gap, { signal }) => {
    const snapshot = await host.snapshot(sessionId, { signal });
    if (snapshot) await resetFromSnapshot(snapshot); // saves snapshot.lastSeq
    return snapshot?.lastSeq; // carry on after it
  },
});
// …
await follow.stop();
```

`health()` reads the public `/health` (capabilities included) without the
token; `handshake()` adds the token probe and never throws. `projects()`,
`providers()` (the catalogue: each provider, its models and the efforts each
takes), `snapshot()` (null for a session the host does not have),
`patchSession()` (a session's title, or the model and effort its next turn runs
on), `deleteSession()` (teardown) and `events()` — one connection, decoded but
not sequenced — cover the rest. A refusal is an
`ExecutionHostError` with a `kind` to branch on (`network`, `timeout`, `auth`,
`not-found`, `http`, `malformed`), the status, and the host's own words.

**The token** goes in the `Authorization` header and nowhere else. One no
header could carry — a line break, a control character, anything outside ASCII
— is refused when the client is made, without being repeated; surrounding
whitespace is dropped, as `fetch` drops it. Every message built from a failure,
and a host's refusal, has the token replaced by `[token]`, and the `cause` an
error carries is a scrubbed copy, never the original.

**Requests** refuse redirects (`redirect: "error"`): a redirect would carry the
token to wherever it points, and a 302 turns a POST into a GET. Timeouts must
be positive, and one past what a timer holds (about 24.8 days) waits that long
rather than firing at once. A command id is checked before anything is sent.
Listeners — `onWarnings`, `onStatus` — never break what they listen to: a throw
or a rejected promise from one is swallowed.

**What `followSession` promises.**

- **It keeps following.** A finished turn is an envelope like any other: a
  shared session goes quiet between turns, and the next one may be anybody's.
  `done` resolves with why it ended and never rejects:
  - `stopped` — `stop()`, or the caller's `signal`.
  - `no-session` — the stream answered 404: the host does not have the session,
    or a proxy answered for it. Final for this follow; check the snapshot, and
    follow again if the session is back.
  - `unauthorized` — the stream answered 401 or 403, the host's or a proxy's or
    WAF's. The same token will not do better.
  - `gave-up` — `maxAttempts` was set and ran out.
  - `crashed` — the follow's own machinery threw (a bug, or a callback it does
    not guard, such as `retryDelayMs`).
- **It reconnects.** A stream that ends or breaks is reopened with
  `Last-Event-ID: <last kept seq>`, after 1 s doubling to 30 s, for as long as
  it takes unless `maxAttempts` says otherwise. A healthy connection — one that
  kept a frame, or stayed open `healthyAfterMs` (30 s) — starts the count over;
  a host that answers `caught-up` and hangs up is not healthy. A connection
  that goes 90 s without a byte, headers included (hosts send a keep-alive
  every 25 s), is replaced; time a handler takes does not count.
- **Each envelope once, in order.** `onEnvelope` is awaited before the next
  frame is read. If it throws, the envelope was not kept: the follow reconnects
  after the last one that was, and delivers it again — so does `onSkip` or
  `onGap` throwing. Replayed duplicates are dropped.
- **Persist `info.cursor` in the same write as the envelope.** `follow.lastSeq`
  moves only once a handler has returned, so inside one it still names the
  envelope before; `info.cursor` is the `afterSeq` to resume from.
- **`stop()` ends it at once.** It closes the stream, cancels a pending
  reconnect, and abandons a handler still running — that envelope does not
  count as kept, and its `info.signal` aborts so it can give up too. It is safe
  to call, and to await, from inside a handler.
- **It tells a gap from a prune.** A host deletes superseded streaming patches
  from its log, so its replay has holes nothing can fill. A hole under the
  first frame of a connection, or inside a replay the host named, is that
  history. A hole on a live stream is loss: the frame above it is not
  delivered, `onGap` hears `{ reason: "hole" }`, and the follow resumes so the
  host replays what was lost. Return a refetched snapshot's `lastSeq` from
  `onGap` to resume after it instead.
- **It steps over what it cannot apply.** A kind it does not know goes to
  `onSkip` and the cursor moves on (MAR-3633). A frame it cannot read goes to
  `onSkip` and `onGap` (`{ reason: "unreadable" }`): reading it again would fail
  the same way, so the snapshot is how to be sure. An envelope about another
  session has no place in this one's stream and never moves the cursor.

**The replay boundary.** A host may name its replay (agents-daemon `414f740`):
each replayed envelope frame carries `event: replay`; the envelopes that
arrived while the replay was read follow it unnamed; and one frame with no
envelope, `event: caught-up` with `data: {"throughSeq": N}`, ends it — even an
empty one. Below `N`, holes are pruned history and the cursor may stand at `N`;
after it, the next number is the only number, whatever a frame is named. A host
that names neither is read as before, with the first frame of each connection
carrying the rule alone. Frames under any other name are not read at all, as
EventSource ignores the names nobody listens for, and a frame longer than
`maxFrameLength` (16 MiB) fails the connection rather than grow without end.

**The catalogue** is `GET /v0/providers`, read by `providers()` into
`ExecutionProvider[]` (`decodeExecutionProviderListResponse` in the root reads
the body). It is what a session's `model` and `effort` are checked against, so a
picker can offer only what the host will take. A provider has an `id`, a
`label`, `available` and `authenticated` (absent when the host does not say,
which is not `false`), the `effortLevels` it takes as a whole, and its
`models`: each a `slug` (what `config.model` and a patch's `model` name), a
`label`, a `defaultEffort` and its `efforts` — the model's own `effortOptions`,
or else its provider's `effortLevels`, which is also what a provider's default
model takes. A provider or model with no `id` or `slug`, or an effort without an
`id`, makes the catalogue `malformed` rather than a picker offering a guess.

**Teardown** is `deleteSession(sessionId)`, `DELETE /v0/execution/sessions/:id`:
the host stops the provider, drops the workspace and the log, and ends the
streams following the session, so a follower that reconnects hears 404 and
`done` says `no-session`. It answers `deleted`, or `no-session` for a session the
host does not have — torn down already, or never there — so retrying after a
lost answer is safe. Anything else is an `ExecutionHostError`.

**Command ids are always sent.** `start()` and `command()` mint one when the
caller gives none, and the answer names it. The protocol calls sending one
always safe — a host that predates them ignores it — so there is no
`commandId: null` to ask for none: a caller that wanted a request without an id
would be guarding against a host the contract says does not exist, and the
answer's `commandId` would have to become `string | null` for everyone. `null`
is refused, as any id the host would refuse is. A caller that keeps its own ids
passes them, and reuses one to retry.

**Aborting `events()` ends it quietly.** When the caller's `signal` aborts, the
iteration finishes; it does not throw. That is the intended contract, and it
matches `followSession`, whose `done` says `stopped` for the same abort. Check
`signal.aborted` after the loop to tell an abort from the host closing the
stream — a stream the host closes, breaks or leaves idle past `idleTimeoutMs`
ends as it always did, and is not an abort. (Requests such as `snapshot()` are
different: they are one answer awaited, and a caller's abort rejects them with
the abort, as `fetch` does.)

## The work address and environments

A host owns **Environments**: named templates, each a declared set of variable
**names** whose values live on the box and never travel (ADR-0011). A session
says where it works and the host echoes what it actually prepared.

- **Asking.** `ExecutionStartRequest.environment` names one. A residency — a
  session in a standing Project — that names none gets the Project's default;
  an errand that names none runs naked, on the host's base set alone. The host
  never infers it.
- **Echoing.** `ExecutionSessionWorkspace` is a discriminated union filled in
  both modes. `mode: "repository"` describes an errand's clone; `mode:
"project"` describes a residency and carries `origin`, `originKey`, and the
  checkout's **actual** HEAD at start, plus `requestedBranchName` when the
  dispatcher asked for a different one. Nothing is derived: the branch is
  whatever was there, and a mismatch is reported rather than reconciled.
- **Reading the catalog.** `ExecutionEnvironment` lists a template's key names,
  its `includes`, and whether the host has every value (`provisioned`,
  `missing`). `missing` names keys; it never names their contents.
- **Matching a checkout to a Project.** Compare `originKey`, not URLs.
  `normalizeOriginKey` collapses every spelling of a remote — ssh, scp-like,
  https, credentialed, ported, trailing-slashed, `.git`-suffixed, any case —
  onto one `host/owner/repo` key, and returns null for anything that names no
  remote.

**No value ever crosses this wire.** Every environment-shaped decoder rejects a
payload carrying a `values` field, whatever it holds and however empty —
presence is the offence. A value-writing door needs its own decision, made
after a host has real secret storage and an audit trail; until then, a client
shows a name and a copy-ready instruction, and a human places the value on the
host.

Legacy readers stay compatible: a pre-ADR-0011 `workspace` echo with no `mode`
decodes as a repository address, and a host predating `projects.v2` decodes to
`origin: null`, `originKey: null`, `environments: []` — unknown, never guessed.

## Development

```bash
npm install
npm run format
npm run typecheck
npm test
npm run build
npm run test:exports
```

## Consuming

Once published, consumers install from npm with a normal semver range:

```bash
npm install @mrck-labs/execution-host-protocol
```

Before the first npm release the package was consumed via immutable GitHub tags
(`github:marckraw/execution-host-protocol#vX.Y.Z`, under the old `@marckraw`
scope); npm under `@mrck-labs` is now the canonical channel.

The package ships both ESM (`import`) and CommonJS (`require`) builds, so it
loads from Electron main processes and Node/Bun runtimes alike. The client is a
subpath export, `@mrck-labs/execution-host-protocol/client`, resolved through
`exports`: Node 20+, and TypeScript with `moduleResolution` `node16`,
`nodenext` or `bundler`.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). The flow:

1. Branch from `main`, make your change.
2. Add a changeset describing it: `npm run changeset` (commit the generated
   `.changeset/*.md`). PRs that change published behavior must include one.
3. Open a PR and merge it into `main`.
4. The **Release** workflow (`.github/workflows/release.yml`) runs on `main`.
   Changesets opens/updates a **"Version Packages"** PR that bumps the version
   and rewrites the changelog.
5. Merge the Version PR. With `NPM_TOKEN` present, the workflow publishes the
   new version to npm with provenance and tags `vX.Y.Z`. Without the token it
   only manages the Version PR (no publish), so the pipeline is safe to run
   before npm is enabled.

Package semver tracks library releases; `EXECUTION_PROTOCOL_VERSION` tracks wire
compatibility — the two are deliberately independent.

### One-time human setup (repository administrator)

Agents never request, create, print, or store the npm credential.

- **npm scope** — ensure the `@mrck-labs` org/scope exists and your npm account
  can publish to it (this is a scoped public package).
- **GitHub Actions permissions** — Settings → Actions → General → Workflow
  permissions → enable _Read and write permissions_ and _Allow GitHub Actions to
  create and approve pull requests_ (required for Changesets to open the Version
  PR).
- **`NPM_TOKEN` secret** — create an npm Granular Access Token with publish
  rights to `@mrck-labs/*` and add it as the Actions secret `NPM_TOKEN`.
