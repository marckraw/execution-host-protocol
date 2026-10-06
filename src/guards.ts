/**
 * The shape checks every decoder shares, so "a positive integer" means one
 * thing across the contract (MAR-3725). Internal: the root does not export it.
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
