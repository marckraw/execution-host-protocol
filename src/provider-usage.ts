import type { ExecutionProviderUsageWindow } from "./types.js";

/**
 * Whether a usage window still limits a model at `at` (MAR-4198): what
 * accent.'s pickers and its tests share, so they agree on which windows count
 * before asking how much of each is used.
 *
 * A window limits a model only while its `resetsAt` is ahead of `at`: one at
 * or past its reset limits nothing, whatever it said. One without a
 * `resetsAt` still limits, since nothing says it has started again; how old
 * it is, is `usage.observedAt`'s to say.
 *
 * It limits every model when it has no `modelFamily`. Otherwise only a model
 * whose `slug` or `label` is that family, ignoring case, or, for a one-word
 * family (`opus`), names it as a whole word: `claude-opus-5-5` and `Opus 5.5`
 * are `opus`, `claude-opusx` is not. A family of more than one word (a Codex
 * slug such as `gpt-5.1-codex`) must be the whole slug or label, so it never
 * limits `gpt-5.1-codex-max`.
 */
export function executionProviderUsageWindowLimits(
  window: Pick<ExecutionProviderUsageWindow, "resetsAt" | "modelFamily">,
  model: { slug: string; label?: string },
  at: Date | number,
): boolean {
  if (window.resetsAt !== undefined) {
    const resetsAt = Date.parse(window.resetsAt);
    if (resetsAt <= new Date(at).getTime()) return false;
  }
  if (window.modelFamily === undefined) return true;
  const family = window.modelFamily.toLowerCase();
  const oneWord = /^[a-z0-9]+$/.test(family);
  return [model.slug, model.label].some((name) => {
    if (name === undefined) return false;
    const lower = name.toLowerCase();
    return (
      lower === family ||
      (oneWord && lower.split(/[^a-z0-9]+/).includes(family))
    );
  });
}
