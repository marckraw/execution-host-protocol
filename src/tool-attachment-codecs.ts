import {
  isBoundedString,
  isNonEmptyString,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from "./guards.js";
import {
  EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  EXECUTION_TOOL_ATTACHMENT_MAX_BYTES,
  EXECUTION_TOOL_ATTACHMENT_MAX_PIXELS,
  EXECUTION_TOOL_ATTACHMENT_MAX_SIDE,
  EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT,
  EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES,
  type ExecutionToolAttachment,
  type ExecutionToolAttachmentOmissions,
} from "./tool-attachments.js";
import type { ExecutionDecodeWarning } from "./types.js";

type OptionalMetadata<T> = {
  value: T | undefined;
  warnings: ExecutionDecodeWarning[];
};

/**
 * Tolerant Reader pattern: bounded, pure projection of optional image metadata.
 * Invalid entries warn and drop; required tool text is decoded independently.
 */
export function decodeToolAttachments(
  raw: unknown,
  path: string,
): OptionalMetadata<ExecutionToolAttachment[]> {
  if (raw === undefined) return { value: undefined, warnings: [] };
  // Refuse an oversized list before traversal: warnings and work stay bounded.
  if (
    !Array.isArray(raw) ||
    raw.length > EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT
  ) {
    return dropped(path);
  }
  const value: ExecutionToolAttachment[] = [];
  const warnings: ExecutionDecodeWarning[] = [];
  for (const [index, entry] of raw.entries()) {
    const attachment = readToolAttachment(entry);
    if (attachment === null) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.${index}`,
      });
    } else {
      value.push(attachment);
    }
  }
  return { value, warnings };
}

function readToolAttachment(raw: unknown): ExecutionToolAttachment | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.id) ||
    !isNonEmptyString(raw.name) ||
    /[/\\\u0000-\u001f\u007f]/.test(raw.name) ||
    !isBoundedString(
      raw.mimeType,
      EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
    ) ||
    !/^image\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(raw.mimeType) ||
    !isSafePositiveInteger(raw.sizeBytes) ||
    raw.sizeBytes > EXECUTION_TOOL_ATTACHMENT_MAX_BYTES ||
    !isSafePositiveInteger(raw.width) ||
    !isSafePositiveInteger(raw.height) ||
    raw.width > EXECUTION_TOOL_ATTACHMENT_MAX_SIDE ||
    raw.height > EXECUTION_TOOL_ATTACHMENT_MAX_SIDE ||
    raw.width * raw.height > EXECUTION_TOOL_ATTACHMENT_MAX_PIXELS
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    sizeBytes: raw.sizeBytes,
    width: raw.width,
    height: raw.height,
  };
}

/** Only visit the fixed codes, ignoring unknown fields without copying them. */
export function decodeToolAttachmentOmissions(
  raw: unknown,
  path: string,
): OptionalMetadata<ExecutionToolAttachmentOmissions> {
  if (raw === undefined) return { value: undefined, warnings: [] };
  if (!isRecord(raw)) return dropped(path);
  const value: ExecutionToolAttachmentOmissions = {};
  const warnings: ExecutionDecodeWarning[] = [];
  for (const code of EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES) {
    if (!Object.hasOwn(raw, code)) continue;
    const count = raw[code];
    if (isSafeNonNegativeInteger(count)) {
      value[code] = count;
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.${code}`,
      });
    }
  }
  return { value, warnings };
}

function dropped(path: string): OptionalMetadata<never> {
  return {
    value: undefined,
    warnings: [{ reason: "dropped-invalid-field", path }],
  };
}
