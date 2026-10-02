# Execution Host Protocol

Public, transport-agnostic wire contract shared by agent execution runtimes and
clients. It contains TypeScript types plus dependency-free runtime codecs for
the versioned JSON envelopes used to start Sessions, send commands, and stream
events.

## Boundaries

Included: public request/envelope types, defensive validators, encoders, and
recorded contract fixtures. Excluded: HTTP/SSE clients, stream sequencing,
persistence snapshots, provider implementations, and daemon-only endpoints.

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
loads from Electron main processes and Node/Bun runtimes alike.

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
