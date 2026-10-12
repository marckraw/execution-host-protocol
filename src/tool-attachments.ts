import type { ExecutionConversationAttachment } from "./types.js";

/** Tool image admission limits (MAR-3926), independent of inline uploads. */
export const EXECUTION_TOOL_ATTACHMENT_MAX_BYTES = 8_388_608;
export const EXECUTION_TOOL_ATTACHMENT_MAX_PIXELS = 16_000_000;
export const EXECUTION_TOOL_ATTACHMENT_MAX_SIDE = 8_000;
export const EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT = 8;
export const EXECUTION_TOOL_ATTACHMENTS_MAX_TURN_BYTES = 67_108_864;
export const EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_COUNT = 100;
export const EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_BYTES = 335_544_320;
export const EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_PREVIEW_BYTES = 167_772_160;
export const EXECUTION_TOOL_ATTACHMENT_MAX_RENDITION_BYTES = 2_097_152;
/** String bounds are in UTF-16 code units. Ids are opaque tokens, never paths. */
export const EXECUTION_TOOL_ATTACHMENT_ID_MAX_LENGTH = 255;
export const EXECUTION_TOOL_ATTACHMENT_NAME_MAX_LENGTH = 255;
export const EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH = 255;

/** Fixed codes keep omissions bounded and free of provider/error text. */
export const EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES = [
  "unsupported-mime-type",
  "invalid-image",
  "image-too-large",
  "turn-limit",
  "session-limit",
  "storage-failed",
] as const;
export type ExecutionToolAttachmentOmissionCode =
  (typeof EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES)[number];
/** Counts saturate here; the maximum means at least this many were omitted. */
export const EXECUTION_TOOL_ATTACHMENT_OMISSION_MAX_COUNT = 65_535;
export type ExecutionToolAttachmentOmissions = Partial<
  Record<ExecutionToolAttachmentOmissionCode, number>
>;

/**
 * A persisted image reference using the message attachment metadata names.
 * `id` belongs to the item's session. The host persists before emission and
 * never changes the reference afterwards; no bytes, URLs or paths travel here.
 * `mimeType` is a bounded image media type, not a PNG-only discriminator.
 * Dimensions and size are positive integers within the limits above.
 */
export interface ExecutionToolAttachment extends ExecutionConversationAttachment {
  width: number;
  height: number;
}
