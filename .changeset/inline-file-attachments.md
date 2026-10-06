---
"@mrck-labs/execution-host-protocol": minor
---

A file beside an image in a message's attachments (MAR-3783).

- **`attachments.inline-file.v1`**, a new capability id. `inlineAttachments`
  on a `send-message` and on a start's `config` now hold
  `ExecutionInlineAttachment`s: an `ExecutionInlineImageAttachment` as before,
  or an `ExecutionInlineFileAttachment`, `{ kind: "file", name, mimeType,
sizeBytes, dataBase64 }`. The decoders read both and still refuse a kind
  they do not know, the whole command with it. The README says what a host
  promises under the id: the file kept for that session only, never opened,
  run or rendered, `name` and `mimeType` trusted for nothing, gone at teardown.
- **The limits**, for any mix: `EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT` (4),
  `EXECUTION_INLINE_ATTACHMENT_MAX_BYTES` (10 MiB),
  `EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES` (20 MiB), padded base64 and
  `sizeBytes` equal to the decoded length, checked by
  `checkExecutionInlineAttachments`.
- **The client never sends a file to a host that does not take one.**
  `command()` and `start()` refuse attachments past the limits with an
  `ExecutionInlineAttachmentsError`, before anything is sent, images included:
  a host refused those whole anyway. A request carrying a file first reads
  `/health` and is refused, unsent, with code `files-unsupported` on a host
  without the id. Its failures carry the client's words only, never the
  host's, the transport's, or a file's name or bytes. Requests without a file
  send the same bytes as 0.20.0, with no probe. `hostTakesInlineFiles(health)`
  is exported.
- **The provider catalogue** gains optional `attachmentKinds`, from the
  daemon's `features.attachmentKinds`.

One type change for readers: `inlineAttachments` is now
`ExecutionInlineAttachment[]`, so code that hands a decoded command's
attachments to a function taking `ExecutionInlineImageAttachment[]` no longer
compiles until it handles, or refuses, `kind: "file"`. Code that builds
commands and starts compiles as before.
