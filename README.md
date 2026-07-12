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
npm install @marckraw/execution-host-protocol
```

Until the first npm release lands, consumers pin an immutable GitHub tag:

```json
"@marckraw/execution-host-protocol": "github:marckraw/execution-host-protocol#v0.2.4"
```

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

- **npm scope** — ensure the `@marckraw` scope exists and your npm account owns
  it (this is a scoped public package).
- **GitHub Actions permissions** — Settings → Actions → General → Workflow
  permissions → enable _Read and write permissions_ and _Allow GitHub Actions to
  create and approve pull requests_ (required for Changesets to open the Version
  PR).
- **`NPM_TOKEN` secret** — create an npm Granular Access Token with publish
  rights to `@marckraw/*` and add it as the Actions secret `NPM_TOKEN`.
