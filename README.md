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
```

Consumers pin immutable GitHub tags:

```json
"@marckraw/execution-host-protocol": "github:marckraw/execution-host-protocol#v0.1.0"
```

Releases use Changesets and immutable `vX.Y.Z` Git tags. npm publishing is not
configured; Git tags are the supported distribution channel.
