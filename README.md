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
