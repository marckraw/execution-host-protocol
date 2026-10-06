---
"@mrck-labs/execution-host-protocol": minor
---

Add one-shots (`oneshot.v1`, MAR-3775): one tool-less answer to one prompt from
a host's provider, over agents-daemon's existing `POST /v0/oneshot`. Its body
gains one required field, `contract: "oneshot.v1"`. A daemon released before
the id refuses that field, so it never runs the prompt, even if its `/health`
changed after the client read it. The root
gains the request, answer and refusal types, their codecs, the caps (65,536
characters of prompt and of answer, 120 s of provider time) and the refusal
codes `provider-unknown`, `provider-unavailable`, `busy`, `timed-out` and
`failed`.

The client gains `oneShot({ provider, model, effort?, prompt, timeoutMs?, signal? })`,
which resolves `{ text }`. It reads `/health` first and refuses a host that does
not advertise `oneshot.v1` before the prompt is sent. Every refusal is an
`ExecutionOneShotError` with a stable `code`. A network failure is an
`ExecutionHostError` in the client's own words, with no `cause`. No error carries
the prompt, the answer or the token. An option it does not take is a
`TypeError`, and nothing is sent. It reads at most 512 KiB of an answer and
64 KiB of a refusal.

The capability is additive. Existing calls are unchanged on the wire, and the
protocol version stays 1. A hand-written implementation of `ExecutionHostClient`
must add `oneShot`.
