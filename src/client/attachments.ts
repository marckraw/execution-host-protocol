import {
  EXECUTION_INLINE_ATTACHMENT_MAX_BYTES,
  EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT,
  EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES,
  type ExecutionInlineAttachmentsCheck,
  type ExecutionInlineAttachmentsProblem,
} from "../attachments.js";
import type { ExecutionHostHealth } from "./health.js";
import { ExecutionHostError, ExecutionStartRequirementsError } from "./http.js";

/**
 * `files-unsupported`: the request carries a `kind: "file"` entry and the host
 * does not advertise `attachments.inline-file.v1`, or its descriptor is
 * unreadable. The rest are `checkExecutionInlineAttachments`' problems.
 */
export type ExecutionInlineAttachmentsErrorCode =
  ExecutionInlineAttachmentsProblem | "files-unsupported";

/**
 * A start or a `send-message` whose `inlineAttachments` this client will not
 * send (MAR-3783). Nothing was sent: the text is still the caller's to send
 * without them. It names an attachment by `index`, never by its name or
 * bytes. Not an `ExecutionHostError`: a caller converting errors checks for
 * both.
 */
export class ExecutionInlineAttachmentsError extends Error {
  readonly code: ExecutionInlineAttachmentsErrorCode;
  /** `start`, or `command send-message`. */
  readonly operation: string;
  /** The entry at fault; null when it is the whole list, or the host. */
  readonly index: number | null;
  /** Safe to show: the client's own words. */
  readonly reason: string;

  constructor(
    code: ExecutionInlineAttachmentsErrorCode,
    reason: string,
    details: { operation: string; index?: number | null },
  ) {
    super(`${details.operation} failed: ${code}: ${reason}`);
    this.name = "ExecutionInlineAttachmentsError";
    this.code = code;
    this.operation = details.operation;
    this.index = details.index ?? null;
    this.reason = reason;
  }
}

/** Whether the host takes files beside images (`attachments.inline-file.v1`). */
export function hostTakesInlineFiles(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("attachments.inline-file.v1");
}

export function inlineAttachmentsRefusal(
  operation: string,
  check: Extract<ExecutionInlineAttachmentsCheck, { ok: false }>,
): ExecutionInlineAttachmentsError {
  const entry = `attachment ${check.index}`;
  const reason = {
    invalid:
      check.index === null
        ? "inlineAttachments is not an array"
        : `${entry} is not an image or a file with a name, a mimeType, an integer sizeBytes and padded base64`,
    "too-many": `more than ${EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT} attachments`,
    "too-large": `${entry} is over ${mebibytes(EXECUTION_INLINE_ATTACHMENT_MAX_BYTES)}`,
    "size-mismatch": `${entry}'s sizeBytes is not the length its data decodes to`,
    "total-too-large": `the attachments are over ${mebibytes(EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES)} together`,
  }[check.problem];
  return new ExecutionInlineAttachmentsError(
    check.problem,
    `${reason}; nothing was sent`,
    { operation, index: check.index },
  );
}

export function inlineFilesRefusal(
  operation: string,
  health: Pick<ExecutionHostHealth, "executionProtocolValid">,
): ExecutionInlineAttachmentsError {
  return new ExecutionInlineAttachmentsError(
    "files-unsupported",
    health.executionProtocolValid
      ? "the host does not advertise attachments.inline-file.v1, so it would refuse the whole request; nothing was sent"
      : "the host's protocol descriptor is unreadable, so it cannot be trusted with a file; nothing was sent",
    { operation },
  );
}

/**
 * A failure of a request that carried a file, in the client's words only. A
 * host's refusal may quote a file's name (agents-daemon's does), and a
 * transport's error the body it was sending, so neither is carried, and no
 * `cause` is. A caller's own abort, and anything that is not one of this
 * client's errors, is handed back as it came.
 */
export function withoutHostWords(error: unknown): unknown {
  if (error instanceof ExecutionHostError) {
    const reason =
      error.kind === "timeout"
        ? error.reason
        : error.kind === "network"
          ? "the connection to the host failed"
          : error.kind === "malformed"
            ? "the host's answer could not be read"
            : "the host refused it; its words are not carried, since the request held a file";
    return new ExecutionHostError(error.kind, reason, {
      operation: error.operation,
      status: error.status,
    });
  }
  if (
    error instanceof ExecutionStartRequirementsError &&
    error.code === "requirements-unmet"
  ) {
    return new ExecutionStartRequirementsError(
      error.code,
      "the host lacks a trait this start requires",
      {
        requires: error.requires,
        missingTraits: error.missingTraits,
        status: error.status,
      },
    );
  }
  return error;
}

function mebibytes(bytes: number): string {
  return `${bytes / 1024 / 1024} MiB`;
}
