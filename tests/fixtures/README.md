# Contract fixtures

`contract-fixtures.ts` is the coverage gate for the public discriminated unions.
Its `satisfies Record<...>` declarations must contain every conversation item,
event, and command kind, so TypeScript CI fails when a kind is added without a
fixture. Runtime tests then encode and decode every entry.

`recorded` fixtures came from the daemon SSE capture in
`raw-sse-claude-session.txt`. `hand-authored` fixtures cover branches that were
not present in that recording and are labelled explicitly in the fixture map.

`evidenceFixtures` (MAR-3679) holds one fixture per member of the
`HarnessEvidence` union, `harness.retry` once per phase. Each is typed
`Complete<…>`, which makes every optional field, nested ones included,
required: a fixture missing a field is a type error, and a codec that drops one
fails its round trip.
