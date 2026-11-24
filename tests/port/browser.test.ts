import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionHostError,
  ExecutionStartBrowserError,
  type ExecutionHostApi,
} from "../../src/client/index.js";
import type {
  ExecutionProvider,
  ExecutionStartRequest,
} from "../../src/index.js";
import { fromPortError } from "../../src/port/errors.js";
import { createPortClient, servePort } from "../../src/port/index.js";
import { FakeHostModel, fakeApi } from "../conformance/fake-host.js";
import { startRequestWithEnvironmentFixture } from "../fixtures/contract-fixtures.js";

/**
 * MAR-5726 review: a port has no `/health`, so a browser start goes only to
 * a host whose `providers()` say the provider drives Chrome. A legacy peer,
 * whose providers carry no `chrome`, never sees the start.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const provider = (
  id: string,
  chrome?: ExecutionProvider["chrome"],
): ExecutionProvider => ({
  id,
  label: id,
  effortLevels: [],
  models: [],
  ...(chrome ? { chrome } : {}),
});

/** A peer whose providers are as given, counting what reaches its start. */
function connect(providers: () => Promise<unknown>) {
  const base = fakeApi(new FakeHostModel());
  const starts: ExecutionStartRequest[] = [];
  const api: ExecutionHostApi = {
    ...base,
    providers: providers as ExecutionHostApi["providers"],
    start: async (request, options) => {
      starts.push(request);
      return base.start(request, options);
    },
  };
  const { port1, port2 } = new MessageChannel();
  const server = servePort(port2, api);
  const client = createPortClient(port1);
  cleanups.push(() => {
    client.close();
    server.close();
  });
  return { client, server, starts };
}

const request = (
  providerId: string,
  browser: unknown = "chrome",
): ExecutionStartRequest =>
  ({
    ...startRequestWithEnvironmentFixture.value,
    providerId,
    config: { ...startRequestWithEnvironmentFixture.value.config, browser },
  }) as ExecutionStartRequest;

const found = { nativeHost: true, extension: true };

describe("a browser start over a port", () => {
  it("never reaches a legacy peer, whose providers carry no chrome", async () => {
    const { client, starts } = connect(async () => [
      provider("claude"),
      provider("codex"),
    ]);
    const failure = await client
      .start(request("claude"))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExecutionStartBrowserError);
    expect(failure).toMatchObject({
      code: "browser-unsupported",
      status: null,
      operation: "start",
    });
    expect(starts).toEqual([]);
  });

  it("never reaches a peer whose providers can't be read", async () => {
    const { client, starts } = connect(async () => {
      throw new Error("the peer is gone");
    });
    await expect(client.start(request("claude"))).rejects.toMatchObject({
      name: "ExecutionStartBrowserError",
      code: "browser-unsupported",
    });
    expect(starts).toEqual([]);
  });

  it("refuses another provider, unsent, where one drives Chrome", async () => {
    const { client, starts } = connect(async () => [
      provider("claude", found),
      provider("codex"),
    ]);
    await expect(client.start(request("codex"))).rejects.toMatchObject({
      name: "ExecutionStartBrowserError",
      code: "browser-unsupported-provider",
      status: null,
    });
    expect(starts).toEqual([]);
  });

  it("goes to a provider that carries chrome, browser and all", async () => {
    const { client, starts } = connect(async () => [
      provider("claude", { nativeHost: false, extension: false }),
    ]);
    const result = await client.start(request("claude"));
    expect(result.status).toBe("started");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.config.browser).toBe("chrome");
  });

  it("refuses a browser outside the list before asking anything", async () => {
    let asked = 0;
    const { client, starts } = connect(async () => {
      asked += 1;
      return [provider("claude", found)];
    });
    await expect(client.start(request("claude", "firefox"))).rejects.toThrow(
      TypeError,
    );
    expect([asked, starts.length]).toEqual([0, 0]);
  });

  it("leaves a start without one as it was: no providers asked", async () => {
    let asked = 0;
    const { client, starts } = connect(async () => {
      asked += 1;
      return [];
    });
    await client.start(startRequestWithEnvironmentFixture.value);
    expect([asked, starts.length]).toEqual([0, 1]);
  });
});

describe("what a browser start over a port is never refused for (review 2)", () => {
  it.each([
    ["an empty chrome", [{ ...provider("claude"), chrome: {} }]],
    [
      "a chrome it can't read",
      [
        {
          ...provider("claude"),
          chrome: { nativeHost: "yes", extension: true },
        },
      ],
    ],
    [
      "a chrome that isn't an object",
      [{ ...provider("claude"), chrome: true }],
    ],
    [
      "a catalogue that is an object",
      { providers: [provider("claude", found)] },
    ],
    ["a catalogue that is text", "claude"],
    ["no catalogue", null],
    ["entries that aren't objects", [null, "claude", 7]],
  ])(
    "refuses %s as browser-unsupported, sending nothing",
    async (_name, reply) => {
      const { client, starts } = connect(async () => reply);
      const failure = await client
        .start(request("claude"))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExecutionStartBrowserError);
      expect(failure).toMatchObject({
        code: "browser-unsupported",
        status: null,
      });
      expect(starts).toEqual([]);
    },
  );

  it("keeps an already-aborted signal's own reason, asking nothing", async () => {
    let asked = 0;
    const { client, starts } = connect(async () => {
      asked += 1;
      return [provider("claude", found)];
    });
    const reason = new Error("the person went away");
    const failure = await client
      .start(request("claude"), { signal: AbortSignal.abort(reason) })
      .catch((error: unknown) => error);
    expect(failure).toBe(reason);
    expect([asked, starts.length]).toEqual([0, 0]);
  });

  it("keeps the reason of an abort while the providers are asked", async () => {
    let asked = () => {};
    const askedNow = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { client, starts } = connect(() => {
      asked();
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const reason = new Error("cancelled mid-probe");
    const pending = client
      .start(request("claude"), { signal: controller.signal })
      .catch((error: unknown) => error);
    await askedNow;
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(starts).toEqual([]);
  });

  it("is the port's network error when the port closes while the providers are asked", async () => {
    let asked = () => {};
    const askedNow = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { client, server, starts } = connect(() => {
      asked();
      return new Promise(() => {});
    });
    const pending = client
      .start(request("claude"))
      .catch((error: unknown) => error);
    await askedNow;
    server.close();
    const failure = await pending;
    expect(failure).toBeInstanceOf(ExecutionHostError);
    expect(failure).toMatchObject({ kind: "network", operation: "start" });
    expect(failure).not.toBeInstanceOf(ExecutionStartBrowserError);
    expect(starts).toEqual([]);
  });
});

describe("a browser error across a port", () => {
  it("keeps a code this build knows", () => {
    const error = fromPortError(
      {
        name: "ExecutionStartBrowserError",
        message: "start failed: browser-unavailable-on-host: off",
        fields: {
          code: "browser-unavailable-on-host",
          reason: "off",
          status: 400,
        },
      },
      "start",
    );
    expect(error).toBeInstanceOf(ExecutionStartBrowserError);
    expect(error).toMatchObject({
      code: "browser-unavailable-on-host",
      status: 400,
    });
  });

  it.each([
    ["an unknown code", "browser-made-up"],
    ["no code", undefined],
    ["a number", 7],
  ])(
    "takes %s to the generic error, never a browser refusal it can't name",
    (_name, code) => {
      const error = fromPortError(
        {
          name: "ExecutionStartBrowserError",
          message: "start failed: something",
          fields: { code, reason: "something", status: 400 },
        },
        "start",
      );
      expect(error).not.toBeInstanceOf(ExecutionStartBrowserError);
      expect(error).toBeInstanceOf(ExecutionHostError);
      expect(error).toMatchObject({ kind: "http", operation: "start" });
    },
  );
});
