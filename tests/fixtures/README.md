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

`agents-daemon-0.17-session.sse.txt` and `agents-daemon-0.17-snapshot.json`
(MAR-3823) are a host that predates 0.19, recorded on 8 Oct 2026: agents-daemon
`3d2dbe2` (master, built on protocol `^0.17.0`) ran a two-turn session in its
own route-test harness, with a scripted provider replaying its recorded
`claude-text-tool-text` events and then a short second answer. The `.sse.txt`
is the bytes its `GET /v0/execution/sessions/:id/events` wrote, replay frames
and `caught-up` included; the `.json` is its `GET /v0/execution/sessions/:id`.
Its turns carry no `origin`, and nothing carries `runningTasks`. Seqs 15 and 27
are missing because the host pruned settled increments, as it does live. Do not
edit them to fit a codec: they are what an older host sends.
