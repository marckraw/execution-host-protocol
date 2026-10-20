/** Bounded inventory names on a start; malformed selections must never be dropped. */
export function isExecutionSelectionNames(raw: unknown): raw is string[] {
  return (
    Array.isArray(raw) &&
    raw.length <= 1024 &&
    new Set(raw).size === raw.length &&
    raw.every(
      (name) =>
        typeof name === "string" &&
        name.trim().length > 0 &&
        name.length <= 256,
    )
  );
}

export type ExecutionStartSelectionRefusalCode =
  "unknown-mcp-server" | "unknown-skill" | "selection-unsupported-provider";
