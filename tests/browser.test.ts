import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_START_BROWSER_REFUSAL_CODES,
  EXECUTION_START_BROWSERS,
  decodeExecutionProviderListResponse,
  decodeExecutionStartRequest,
  isExecutionStartBrowser,
  readExecutionProviderChrome,
} from "../src/index.js";
import { startRequestWithEnvironmentFixture } from "./fixtures/contract-fixtures.js";

/** MAR-5726: a session that drives the person's own Chrome. */

const start = (browser: unknown) =>
  JSON.stringify({
    ...startRequestWithEnvironmentFixture.value,
    config: { ...startRequestWithEnvironmentFixture.value.config, browser },
  });

describe("a start's browser", () => {
  it("is chrome alone, behind its capability", () => {
    expect(EXECUTION_START_BROWSERS).toEqual(["chrome"]);
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "start.browser.chrome.v1",
    );
    expect(EXECUTION_START_BROWSER_REFUSAL_CODES).toEqual([
      "browser-unavailable-on-host",
      "browser-unsupported-provider",
      "browser-unsupported-with-skills",
    ]);
    expect(isExecutionStartBrowser("chrome")).toBe(true);
    expect(isExecutionStartBrowser("Chrome")).toBe(false);
  });

  it("is read on a start, and left out when absent", () => {
    const read = decodeExecutionStartRequest(start("chrome"));
    expect(read.ok && read.value.config.browser).toBe("chrome");
    const without = decodeExecutionStartRequest(
      JSON.stringify(startRequestWithEnvironmentFixture.value),
    );
    expect(without.ok && "browser" in without.value.config).toBe(false);
  });

  it.each([null, true, "firefox", { kind: "chrome" }])(
    "refuses a browser outside the list rather than drop it (%#)",
    (browser) => {
      expect(decodeExecutionStartRequest(start(browser))).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    },
  );
});

describe("a provider's chrome", () => {
  it("reads both facts, and nothing beyond them", () => {
    expect(
      readExecutionProviderChrome({
        nativeHost: true,
        extension: false,
        path: "/Users/person",
      }),
    ).toEqual({ nativeHost: true, extension: false });
  });

  it.each([
    ["not an object", true],
    ["a missing fact", { nativeHost: true }],
    ["a fact as a string", { nativeHost: "yes", extension: true }],
  ])("reads %s as unknown", (_name, raw) => {
    expect(readExecutionProviderChrome(raw)).toBeNull();
  });

  it("reads it beside the rest of the provider, and drops one it can't read with a warning", () => {
    expect(
      decodeExecutionProviderListResponse({
        providers: [
          {
            id: "claude",
            label: "Claude Code",
            chrome: { nativeHost: false, extension: true },
          },
          { id: "codex", chrome: { nativeHost: "maybe" } },
          { id: "antigravity" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "claude",
            label: "Claude Code",
            effortLevels: [],
            models: [],
            chrome: { nativeHost: false, extension: true },
          },
          { id: "codex", label: "codex", effortLevels: [], models: [] },
          {
            id: "antigravity",
            label: "antigravity",
            effortLevels: [],
            models: [],
          },
        ],
      },
      warnings: [
        { reason: "dropped-invalid-field", path: "providers.1.chrome" },
      ],
    });
  });
});
