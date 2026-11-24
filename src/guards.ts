/**
 * Shape checks shared by `codecs.ts`, `host-profile.ts`, `task-output.ts` and
 * `mcp.ts` (MAR-3725). Other decoders keep their own. Internal: the package
 * root does not export them.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** A count a reader can hold exactly: past 2^53 a number is not what was sent. */
export function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
export function isBoundedString(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

/** An absolute `http:` or `https:` URL. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** RFC 3339 in UTC or with an offset, as `Date.prototype.toISOString` writes it. */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** A timestamp whose every field is in range: no `2026-02-30`, no `T24:00`. */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = TIMESTAMP.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    parts.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return (
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysInMonth &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    offsetHour! <= 23 &&
    offsetMinute! <= 59
  );
}

/**
 * C0 and C1 controls, and what reorders or breaks a line on screen: bidi
 * marks, embeddings, overrides and isolates, line and paragraph separators.
 * They let one label pass for another, or for more than one line.
 */
export const UNSHOWABLE_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * Cleaned, trimmed, then cut, rather than refused: the host cuts and cleans a
 * label too (MAR-3820), so a reader agrees with it whatever length it chose,
 * and a cut never lands inside a real email (at most 254 units). A usage
 * window's text is read the same way (MAR-4198).
 */
export function readShowableText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.replace(UNSHOWABLE_CHARACTERS, "").trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
    // Never end on half a surrogate pair.
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text.length > 0 ? text : undefined;
}
