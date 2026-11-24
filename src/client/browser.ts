import {
  isExecutionStartBrowserRefusalCode,
  type ExecutionStartBrowserRefusalCode,
} from "../browser.js";
import { isRecord } from "../guards.js";
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

/** Whether `value` is an `ExecutionStartBrowserErrorCode`. */
export function isExecutionStartBrowserErrorCode(
  value: unknown,
): value is ExecutionStartBrowserErrorCode {
  return (
    value === "browser-unsupported" || isExecutionStartBrowserRefusalCode(value)
  );
}

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

/**
 * A browser start judged by what a host's `providers()` says, for a carrier
 * with no `/health` to read (the port, MAR-5726): a host that takes
 * `config.browser` puts `chrome` on each provider that can drive it, and one
 * that predates the field can't, its decoder dropping it. So the start goes
 * only to a provider that carries `chrome`; for one that doesn't, on a host
 * where another does, it is `browser-unsupported-provider`; otherwise, or
 * when the providers can't be read, `browser-unsupported`. Nothing is sent
 * either way (`status` null). Null: it may go.
 */
export function chromeStartRefusal(
  providers: ReadonlyArray<{ id: string; chrome?: unknown }> | null,
  providerId: string,
): ExecutionStartBrowserError | null {
  if (providers === null) {
    return new ExecutionStartBrowserError(
      "browser-unsupported",
      "the host's providers could not be read, so it cannot be trusted to start the session with Chrome; nothing was sent",
    );
  }
  const drives = (provider: { chrome?: unknown }) => isRecord(provider.chrome);
  if (
    providers.some((provider) => provider.id === providerId && drives(provider))
  )
    return null;
  return providers.some(drives)
    ? new ExecutionStartBrowserError(
        "browser-unsupported-provider",
        `${BROWSER_REFUSAL_REASONS["browser-unsupported-provider"]}; nothing was sent`,
      )
    : new ExecutionStartBrowserError(
        "browser-unsupported",
        "the host says of no provider that it can drive Chrome, so it would start the session without it; nothing was sent",
      );
}
