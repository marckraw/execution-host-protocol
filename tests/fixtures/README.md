# Contract fixtures

`contract-fixtures.ts` is the coverage gate for the public discriminated unions.
Its `satisfies Record<...>` declarations must contain every conversation item,
event, and command kind, so TypeScript CI fails when a kind is added without a
fixture. Runtime tests then encode and decode every entry.

`recorded` fixtures came from the daemon SSE capture in
`raw-sse-claude-session.txt`. `hand-authored` fixtures cover branches that were
not present in that recording and are labelled explicitly in the fixture map.
