/** Maximum UTF-8 bytes in a start's session instructions (MAR-4364). */
export const EXECUTION_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/** Empty instructions are valid; absent instructions preserve the host default. */
export function isExecutionInstructions(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= EXECUTION_INSTRUCTIONS_MAX_BYTES &&
    new TextEncoder().encode(value).byteLength <=
      EXECUTION_INSTRUCTIONS_MAX_BYTES
  );
}
