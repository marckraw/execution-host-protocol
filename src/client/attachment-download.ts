import { EXECUTION_INLINE_ATTACHMENT_MAX_BYTES } from "../attachments.js";
import { EXECUTION_TOOL_ATTACHMENT_MAX_BYTES } from "../tool-attachments.js";
import { readOrAbort } from "./body-read.js";
import { ExecutionHostError, type ExecutionHostErrorKind } from "./http.js";

/**
 * What a download is of, which sets its ceiling (MAR-3973): `tool`, an image
 * on a tool result, at most `EXECUTION_TOOL_ATTACHMENT_MAX_BYTES` (8 MiB);
 * `inline`, an image or file sent with a message, at most
 * `EXECUTION_INLINE_ATTACHMENT_MAX_BYTES` (10 MiB), what a host takes.
 */
export type ExecutionAttachmentDownloadKind = "tool" | "inline";

const ceilingOfKind: Record<ExecutionAttachmentDownloadKind, number> = {
  tool: EXECUTION_TOOL_ATTACHMENT_MAX_BYTES,
  inline: EXECUTION_INLINE_ATTACHMENT_MAX_BYTES,
};

export interface ExecutionAttachmentDownloadResult {
  /** Fully consumed bytes, at most the requested ceiling. No stream escapes. */
  bytes: Uint8Array;
  /** Measured from the body, independent of Content-Length. */
  sizeBytes: number;
}

export function attachmentPathId(value: string): string {
  // URL parsers normalize dot segments even when their dots are percent encoded.
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value === ".."
  ) {
    throw new TypeError(
      "attachment and session IDs must be non-empty path IDs other than dot segments",
    );
  }
  return encodeURIComponent(value);
}

/** The kind's ceiling, or a smaller `maxBytes`; never more, never unbounded. */
export function attachmentByteLimit(
  kind: unknown,
  value: number | undefined,
): number {
  if (kind !== "tool" && kind !== "inline") {
    throw new TypeError('kind must be "tool" or "inline"');
  }
  const ceiling = ceilingOfKind[kind];
  const maxBytes = value ?? ceiling;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ceiling) {
    throw new RangeError(
      `maxBytes must be a whole number from 1 to ${ceiling} for a ${kind} attachment`,
    );
  }
  return maxBytes;
}

/** Download failures carry only fixed client words, never response diagnostics. */
export function attachmentDownloadFailure(
  kind: ExecutionHostErrorKind,
  status: number | null = null,
): ExecutionHostError {
  const reasons: Record<ExecutionHostErrorKind, string> = {
    auth: "the host refused the token",
    "not-found": "the host has no such attachment",
    http: "the host refused the attachment download",
    malformed: "the attachment body is missing or exceeds the byte limit",
    timeout: "the attachment download exceeded its deadline",
    network: "the connection to the host failed",
  };
  return new ExecutionHostError(kind, reasons[kind], {
    operation: "download attachment",
    status,
  });
}

/** Cleanup must not wait for a transport whose cancellation never settles. */
export function cancelAttachmentBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // A failed cleanup cannot replace the download's result.
  }
}

/**
 * Bounded reader: the existing request facade owns authentication and the
 * deadline; this function owns byte accounting and the reader's lifetime.
 */
export async function readAttachmentBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ExecutionAttachmentDownloadResult> {
  const length = response.headers.get("Content-Length");
  // Claimed lengths are an early refusal only; the actual bytes are counted.
  if (
    length !== null &&
    /^\d+$/.test(length.trim()) &&
    Number(length) > maxBytes
  ) {
    cancelAttachmentBody(response);
    throw attachmentDownloadFailure("malformed", response.status);
  }
  // Whole-body fallbacks cannot enforce a ceiling before buffering.
  if (response.body == null)
    throw attachmentDownloadFailure("malformed", response.status);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (error) {
    cancelAttachmentBody(response);
    throw error;
  }
  let complete = false;
  let total = 0;
  let bytes = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await readOrAbort(reader, signal);
      if (signal.aborted) throw signal.reason;
      if (done) break;
      if (value.byteLength > maxBytes - total) {
        throw attachmentDownloadFailure("malformed", response.status);
      }
      const needed = total + value.byteLength;
      if (needed > bytes.byteLength) {
        // Geometric growth bounds storage even for millions of tiny chunks.
        const grown = new Uint8Array(
          Math.min(maxBytes, Math.max(needed, bytes.byteLength * 2, 4096)),
        );
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(value, total);
      total = needed;
    }
    complete = true;
    return {
      bytes: bytes.byteLength === total ? bytes : bytes.slice(0, total),
      sizeBytes: total,
    };
  } finally {
    if (!complete) {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // Cleanup must preserve the original failure.
      }
    }
    reader.releaseLock();
  }
}
