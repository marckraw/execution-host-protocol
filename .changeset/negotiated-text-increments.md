---
"@mrck-labs/execution-host-protocol": minor
---

Patches may carry a negotiated text increment: `patch.textAppend`.

A `conversation.item.patch` normally carries `text` — the item's whole text as of that envelope. That is self-healing, since any single patch is enough to reach the right state, but it makes a stream cost the square of its own length: every envelope restates everything before it. One production session spent 1.51 GB of envelopes on a ~110 KB reply (MAR-2218).

`textAppend` is the text to append to the item's current text instead. It is an additive optional field, **not** a new envelope kind, and it is opt-in end to end: a host advertises `deltas.append.v1` and only sends increments to a subscriber that asked for them. Anything that does not ask sees byte-identical full-text patches, so adopting this is a no-op for every existing client.

The decoder validates it as a string and drops it with the usual `dropped-invalid-field` warning otherwise, alongside its siblings. It is a patch-only field: an item never _holds_ a `textAppend`, so it is deliberately not derived from the item shape the way every other patch field is.

The README gains the ordering and fallback rules a client must follow — appends apply strictly in `seq` order, a client that cannot be certain it has every append falls back to the snapshot or the next full-text patch rather than guessing, `text` wins when both are present, and a terminal patch always restates the whole text.
