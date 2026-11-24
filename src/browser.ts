import { isRecord } from "./guards.js";

/**
 * The browser a session's agent may drive (MAR-5726): a start's
 * `config.browser`, on a host advertising `start.browser.chrome.v1`.
 *
 * - `chrome`: the person's own Chrome, on the machine the host runs on,
 *   through Claude Code's Claude in Chrome (the CLI's `--chrome`). Its tools
 *   reach the Chrome extension through Chrome's native-messaging host on the
 *   same machine and as the same user, so only a host on a person's own
 *   machine offers it; a remote host has no Chrome of the person's.
 *
 * Absent is no browser, as before. A host keeps it for the session's whole
 * life, every resume included. It is fixed at the first start: a 409 /
 * exists neither changes nor confirms it.
 */
export const EXECUTION_START_BROWSERS = ["chrome"] as const;
export type ExecutionStartBrowser = (typeof EXECUTION_START_BROWSERS)[number];

/** Whether `value` is one of `EXECUTION_START_BROWSERS`. */
export function isExecutionStartBrowser(
  value: unknown,
): value is ExecutionStartBrowser {
  return (EXECUTION_START_BROWSERS as readonly unknown[]).includes(value);
}

/**
 * How a host advertising `start.browser.chrome.v1` refuses a start's
 * `browser`, with a 400 and this `code` (MAR-5726). It starts nothing.
 *
 * - `browser-unavailable-on-host`: the host doesn't offer the person's Chrome
 *   (its setting is off). A host without it never advertises the capability.
 * - `browser-unsupported-provider`: the session's provider can't drive it;
 *   only Claude Code can.
 * - `browser-unsupported-with-skills`: the start also picks skills
 *   (`config.skills`). A picked session's Claude Code runs on a config
 *   folder of its own, and Claude in Chrome would point the person's Chrome
 *   at a helper inside it, which goes when the session does.
 */
export const EXECUTION_START_BROWSER_REFUSAL_CODES = [
  "browser-unavailable-on-host",
  "browser-unsupported-provider",
  "browser-unsupported-with-skills",
] as const;
export type ExecutionStartBrowserRefusalCode =
  (typeof EXECUTION_START_BROWSER_REFUSAL_CODES)[number];

/** Whether `value` is one of `EXECUTION_START_BROWSER_REFUSAL_CODES`. */
export function isExecutionStartBrowserRefusalCode(
  value: unknown,
): value is ExecutionStartBrowserRefusalCode {
  return (EXECUTION_START_BROWSER_REFUSAL_CODES as readonly unknown[]).includes(
    value,
  );
}

/**
 * What a host found of the person's Chrome for a provider that can drive it
 * (`chrome` on a provider in `GET /v0/providers`, MAR-5726), looked at when
 * it answers:
 *
 * - `nativeHost`: Chrome's native-messaging host for Claude Code is
 *   installed: the `com.anthropic.claude_code_browser_extension` manifest is
 *   in Chrome's `NativeMessagingHosts`, and the helper it names is there.
 *   Claude Code installs it itself the first time it runs with Chrome on
 *   (`claude --chrome`), and Chrome then has to reconnect the extension.
 * - `extension`: the Claude extension is installed in one of Chrome's
 *   profiles.
 *
 * A host advertising `start.browser.chrome.v1` says it for the providers
 * that can; absent is unknown, or a provider that can't.
 */
export interface ExecutionProviderChrome {
  nativeHost: boolean;
  extension: boolean;
}

/**
 * Reads a provider's `chrome`. Null when it is absent or in a shape this
 * build can't read: unknown, never "not installed".
 */
export function readExecutionProviderChrome(
  raw: unknown,
): ExecutionProviderChrome | null {
  if (
    !isRecord(raw) ||
    typeof raw.nativeHost !== "boolean" ||
    typeof raw.extension !== "boolean"
  ) {
    return null;
  }
  return { nativeHost: raw.nativeHost, extension: raw.extension };
}
