import type { ExecutionStartBrowserRefusalCode } from "../browser.js";
import type { ExecutionHostHealth } from "./health.js";

/**
 * `browser-unsupported`: the host does not advertise
 * `start.browser.chrome.v1`, or its descriptor is unreadable, so it would
 * start the session without Chrome (MAR-5726). Nothing was sent. The others
 * are a capable host's 400 (`EXECUTION_START_BROWSER_REFUSAL_CODES`);
 * nothing was started.
 */
export type ExecutionStartBrowserErrorCode =
  "browser-unsupported" | ExecutionStartBrowserRefusalCode;

/** A start's `config.browser` refused: unsent, or by the host. */
export class ExecutionStartBrowserError extends Error {
  readonly operation = "start";
  constructor(
    readonly code: ExecutionStartBrowserErrorCode,
    readonly reason: string,
    /** The host's status for its refusal; null when nothing was sent. */
    readonly status: number | null = null,
  ) {
    super(`start failed: ${code}: ${reason}`);
    this.name = "ExecutionStartBrowserError";
  }
}

/**
 * Whether the host lets a session drive the person's own Chrome
 * (`start.browser.chrome.v1`, MAR-5726). A host that does not drops
 * `config.browser`, so `start()` sends it none, and a client can hide its
 * toggle.
 */
export function hostTakesChrome(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("start.browser.chrome.v1");
}

export function browserRefusal(
  health: Pick<ExecutionHostHealth, "executionProtocolValid">,
): ExecutionStartBrowserError {
  return new ExecutionStartBrowserError(
    "browser-unsupported",
    health.executionProtocolValid
      ? "the host does not advertise start.browser.chrome.v1, so it would start the session without Chrome; nothing was sent"
      : "the host's protocol descriptor is unreadable, so it cannot be trusted to start the session with Chrome; nothing was sent",
  );
}

/** The client's own words for a capable host's refusal: never the host's. */
export const BROWSER_REFUSAL_REASONS: Record<
  ExecutionStartBrowserRefusalCode,
  string
> = {
  "browser-unavailable-on-host": "the host does not offer the person's Chrome",
  "browser-unsupported-provider": "this provider cannot drive Chrome",
  "browser-unsupported-with-skills":
    "a session that picks skills cannot drive Chrome",
};
