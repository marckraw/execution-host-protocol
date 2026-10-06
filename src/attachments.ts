import { isNonEmptyString, isRecord } from "./guards.js";

/**
 * What one command, or one start, may carry in `inlineAttachments` (MAR-3783):
 * images and files together. They are agents-daemon's image limits, now for
 * any mix, and a host refuses the whole command past them.
 */
export const EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT = 4;
/** The most one attachment may decode to: 10 MiB. */
export const EXECUTION_INLINE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** The most a command's attachments may decode to together: 20 MiB. */
export const EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * The longest `name`, in UTF-16 code units (JavaScript string length): what a
 * file system gives a file name. Bounds the body as the bytes are bounded.
 */
export const EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH = 255;
/** The longest `mimeType`, in UTF-16 code units: a type and subtype of 127 each. */
export const EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH = 255;

/**
 * Why `inlineAttachments` cannot be sent. `invalid`: not an array, or an entry
 * that is not an image or a file with a non-empty `name` and `mimeType`, an
 * integer `sizeBytes`, and padded standard base64. `name-too-long`,
 * `mime-type-too-long`: past `EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH` or
 * `EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH`. `empty`: no bytes at
 * all, which a host does not take. `too-many`: more than
 * `EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT`. `too-large`: one entry past
 * `EXECUTION_INLINE_ATTACHMENT_MAX_BYTES`. `size-mismatch`: `sizeBytes` is not
 * what `dataBase64` decodes to. `total-too-large`: together past
 * `EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES`.
 */
export type ExecutionInlineAttachmentsProblem =
  | "invalid"
  | "name-too-long"
  | "mime-type-too-long"
  | "empty"
  | "too-many"
  | "too-large"
  | "size-mismatch"
  | "total-too-large";

/**
 * `files` counts the `kind: "file"` entries: a command carrying any is for a
 * host advertising `attachments.inline-file.v1` only. A problem names the
 * entry by its `index`, never by its name; null when it is the whole list's.
 */
export type ExecutionInlineAttachmentsCheck =
  | { ok: true; files: number; totalBytes: number }
  | {
      ok: false;
      problem: ExecutionInlineAttachmentsProblem;
      index: number | null;
    };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks `inlineAttachments` against the limits without decoding a byte, as a
 * host checks it after decoding: absent or empty is fine. The shared client
 * refuses, unsent, what this refuses. Lengths and arithmetic come first and
 * the base64 pattern last, so a huge string is refused for its length without
 * being scanned.
 */
export function checkExecutionInlineAttachments(
  raw: unknown,
): ExecutionInlineAttachmentsCheck {
  if (raw === undefined) return { ok: true, files: 0, totalBytes: 0 };
  if (!Array.isArray(raw)) return refused("invalid", null);
  if (raw.length > EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT) {
    return refused("too-many", null);
  }
  let files = 0;
  let totalBytes = 0;
  for (const [index, entry] of raw.entries()) {
    if (
      !isRecord(entry) ||
      (entry.kind !== "image" && entry.kind !== "file") ||
      !isNonEmptyString(entry.name) ||
      !isNonEmptyString(entry.mimeType) ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      typeof entry.dataBase64 !== "string"
    ) {
      return refused("invalid", index);
    }
    if (entry.name.length > EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH) {
      return refused("name-too-long", index);
    }
    if (
      entry.mimeType.length > EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH
    ) {
      return refused("mime-type-too-long", index);
    }
    const sizeBytes = entry.sizeBytes as number;
    const data = entry.dataBase64;
    // agents-daemon refuses `sizeBytes <= 0` for images; nothing to read.
    if (sizeBytes === 0 && data === "") return refused("empty", index);
    if (sizeBytes > EXECUTION_INLINE_ATTACHMENT_MAX_BYTES) {
      return refused("too-large", index);
    }
    const padding = trailingPadding(data);
    if (data.length % 4 !== 0 || padding > 2) {
      return refused("invalid", index);
    }
    if ((data.length / 4) * 3 - padding !== sizeBytes) {
      return refused("size-mismatch", index);
    }
    totalBytes += sizeBytes;
    if (totalBytes > EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES) {
      return refused("total-too-large", index);
    }
    // Last: by now the string is at most what 10 MiB encodes to.
    if (!BASE64.test(data)) return refused("invalid", index);
    if (entry.kind === "file") files += 1;
  }
  return { ok: true, files, totalBytes };
}

/** How many `=` end the string, looking no further than three. */
function trailingPadding(data: string): number {
  let count = 0;
  while (count < 3 && data[data.length - 1 - count] === "=") count += 1;
  return count;
}

function refused(
  problem: ExecutionInlineAttachmentsProblem,
  index: number | null,
): ExecutionInlineAttachmentsCheck {
  return { ok: false, problem, index };
}
