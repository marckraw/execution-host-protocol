import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionStartBrowserError,
  hostTakesChrome,
} from "../../src/client/index.js";
import type { ExecutionStartRequest } from "../../src/index.js";
import { startRequestWithEnvironmentFixture } from "../fixtures/contract-fixtures.js";
import { createStubHost, HEALTH_BODY, type StubHost } from "./stub-host.js";

let host: StubHost;
beforeEach(() => {
  host = createStubHost();
});
const client = () =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: host.fetch,
  });
const request = (browser: unknown) =>
  ({
    ...startRequestWithEnvironmentFixture.value,
    config: { ...startRequestWithEnvironmentFixture.value.config, browser },
  }) as ExecutionStartRequest;
const advertise = (...capabilities: string[]) => {
  host.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: { version: 1, capabilities },
  };
};

describe("a start's browser (MAR-5726)", () => {
  it.each(["old", "other-capabilities", "unreadable"])(
    "refuses chrome, unsent, on a %s host",
    async (kind) => {
      if (kind === "other-capabilities")
        advertise("start.worksIn.v1", "mcp.connections.v1");
      if (kind === "unreadable")
        host.healthBody = {
          ...HEALTH_BODY,
          executionProtocol: {
            version: 1,
            capabilities: "start.browser.chrome.v1",
          },
        };
      const failure = await client()
        .start(request("chrome"))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExecutionStartBrowserError);
      expect(failure).toMatchObject({
        code: "browser-unsupported",
        operation: "start",
        status: null,
      });
      expect(host.startRequests).toEqual([]);
    },
  );

  it.each([null, true, "Chrome", "firefox", {}])(
    "refuses a browser outside the list before probing (%#)",
    async (value) => {
      await expect(client().start(request(value))).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(host.healthRequests).toEqual([]);
      expect(host.startRequests).toEqual([]);
    },
  );

  it("sends chrome to a host that advertises it, after one probe", async () => {
    advertise("start.browser.chrome.v1");
    const result = await client().start(request("chrome"));
    expect(result.status).toBe("started");
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests[0]?.config).toHaveProperty("browser", "chrome");
  });

  it("keeps a start without one unprobed and unchanged", async () => {
    advertise("start.browser.chrome.v1");
    await client().start(startRequestWithEnvironmentFixture.value);
    expect(host.healthRequests).toEqual([]);
    expect(host.startRequests[0]?.config).not.toHaveProperty("browser");
  });

  it.each([
    "browser-unavailable-on-host",
    "browser-unsupported-provider",
    "browser-unsupported-with-skills",
  ] as const)(
    "types a capable host's 400 %s in its own words",
    async (code) => {
      advertise("start.browser.chrome.v1");
      host.startStatus = 400;
      host.startRefusal = { code, error: "host words /Users/person/secret" };
      const failure = await client()
        .start(request("chrome"))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExecutionStartBrowserError);
      expect(failure).toMatchObject({ code, status: 400, operation: "start" });
      expect(String(failure)).not.toContain("secret");
    },
  );

  it("leaves another 400 to the usual error", async () => {
    advertise("start.browser.chrome.v1");
    host.startStatus = 400;
    host.startRefusal = { code: "something-else", error: "no" };
    const failure = await client()
      .start(request("chrome"))
      .catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(ExecutionStartBrowserError);
  });

  it("answers whether a host takes chrome", () => {
    expect(hostTakesChrome({ capabilities: ["start.browser.chrome.v1"] })).toBe(
      true,
    );
    expect(hostTakesChrome({ capabilities: ["start.worksIn.v1"] })).toBe(false);
  });
});
