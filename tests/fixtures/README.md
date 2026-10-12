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

`tool-attachment-fixtures.ts` contains hand-authored MAR-3926 references and
tool results, preserving the `[image]` placeholder and surrounding text.
`tool-attachments-older-readers.json` records actual standalone item and
`conversation.item.add` decoder outputs from the published npm packages
`@mrck-labs/execution-host-protocol@0.17.0` and `@0.22.0`, executed on 12 Oct
2026 with the included input. The tarball SHA-512 digests identify the readers;
both ignore optional image metadata and keep all required text fields unchanged.
To reproduce, `npm pack` those exact versions into a temporary directory,
extract each tarball, import its `package/dist/index.js`, then call
`decodeExecutionConversationItem(input.item)` and
`decodeExecutionEventEnvelope(JSON.stringify(input.event))`. Do not add these
packages as dependencies or modify the outputs to fit the new reader.

Current pins rechecked on 12 Oct 2026: agents-daemon's `bun.lock` resolves 0.17.0
from `^0.17.0`; accentdot's `pnpm-lock.yaml` resolves 0.22.0 from `^0.22.0`.
