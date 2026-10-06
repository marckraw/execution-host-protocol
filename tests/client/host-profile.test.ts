import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionStartRequirementsError,
  hostEnforcesStartRequirements,
} from "../../src/client/index.js";
import { encodeExecutionStartRequest } from "../../src/index.js";
import { startRequestWithEnvironmentFixture } from "../fixtures/contract-fixtures.js";
import {
  linuxHostProfileFixture,
  macHostProfileFixture,
} from "../fixtures/host-profile-fixtures.js";
import { createStubHost, type StubHost, HEALTH_BODY } from "./stub-host.js";

let host: StubHost;
beforeEach(() => {
  host = createStubHost();
});
afterEach(() => {
  vi.useRealTimers();
});
const client = (token = host.token) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token,
    fetch: host.fetch,
  });

describe("authenticated host profiles", () => {
  it.each([linuxHostProfileFixture, macHostProfileFixture])(
    "reads $id with the token and refuses redirects",
    async (profile) => {
      host.hostBody = profile;
      expect(await client().host()).toEqual(profile);
      expect(host.hostRequests).toEqual([
        { authorization: `Bearer ${host.token}` },
      ]);
      expect(host.redirectModes).toEqual(["error"]);
    },
  );

  it("leaves health public and handshake compatible while preserving the new capability ids", async () => {
    const capabilities = [
      "host.profile.v1",
      "devices.iosSimulator.v1",
      "devices.androidEmulator.v1",
      "future.v1",
    ];
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities },
    };
    const connection = client();
    const health = await connection.health();
    expect(health.capabilities).toEqual(capabilities);
    expect(health.raw).not.toHaveProperty("devices");
    expect(await connection.handshake()).toMatchObject({
      status: "connected",
      health: { capabilities },
    });
    expect(
      host.healthRequests.every((request) => request.authorization === null),
    ).toBe(true);
    expect(host.hostRequests).toEqual([]);
  });

  it("keeps handshake working on a host predating profiles", async () => {
    host.hostStatus = 404;
    expect(await client().handshake()).toMatchObject({ status: "connected" });
    await expect(client().host()).rejects.toMatchObject({
      kind: "not-found",
      status: 404,
      operation: "host",
    });
  });

  it.each([401, 403])(
    "reports an authenticated endpoint's %i",
    async (status) => {
      host.hostStatus = status;
      await expect(client().host()).rejects.toMatchObject({
        kind: "auth",
        status,
        operation: "host",
      });
    },
  );

  it("sends a wrong token only in the header, and reports its refusal", async () => {
    await expect(client("wrong-token").host()).rejects.toMatchObject({
      kind: "auth",
      status: 401,
    });
    expect(host.hostRequests).toEqual([]);
  });

  it("keeps a host's failure readable and scrubs the token", async () => {
    host.hostStatus = 503;
    host.hostBody = { error: `Probe failed for ${host.token}` };
    await expect(client().host()).rejects.toMatchObject({
      kind: "http",
      status: 503,
      reason: "Probe failed for [token]",
      operation: "host",
    });
  });

  it.each([
    [{}, "invalid-payload at id"],
    [
      { ...macHostProfileFixture, platform: { os: "darwin", arch: "" } },
      "invalid-payload at platform.arch",
    ],
  ])(
    "refuses an unreadable identity %j, naming the field",
    async (body, reason) => {
      host.hostBody = body;
      await expect(client().host()).rejects.toMatchObject({
        kind: "malformed",
        operation: "host",
        reason,
      });
    },
  );

  it("keeps a profile with one bad entry, and says what it dropped", async () => {
    host.hostBody = {
      ...macHostProfileFixture,
      toolchains: [
        { id: "swift", version: "" },
        ...macHostProfileFixture.toolchains,
      ],
      devices: { ...macHostProfileFixture.devices, iosSimulator: null },
    };
    const heard: unknown[] = [];
    expect(
      await client().host({ onWarnings: (warnings) => heard.push(warnings) }),
    ).toEqual({
      ...macHostProfileFixture,
      devices: {
        androidEmulator: macHostProfileFixture.devices.androidEmulator,
      },
    });
    expect(heard).toEqual([
      [
        { reason: "dropped-invalid-field", path: "toolchains.0" },
        { reason: "dropped-invalid-field", path: "devices.iosSimulator" },
      ],
    ]);
  });

  it("keeps the profile when the warnings listener throws", async () => {
    host.hostBody = { ...linuxHostProfileFixture, traits: [""] };
    expect(
      await client().host({
        onWarnings: () => {
          throw new Error("listener broke");
        },
      }),
    ).toEqual(linuxHostProfileFixture);
  });

  it("reports a non-JSON answer", async () => {
    const connection = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: async () => new Response("not JSON"),
    });
    await expect(connection.host()).rejects.toMatchObject({
      kind: "malformed",
      operation: "host",
    });
  });

  it.each([undefined, 40])(
    "uses the health timeout, with override %j",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const connection = createExecutionHostClient({
        baseUrl: "https://host.test",
        token: host.token,
        requestTimeoutMs: 1,
        healthTimeoutMs: 20,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          ),
      });
      const refusal = expect(
        connection.host({ timeoutMs }),
      ).rejects.toMatchObject({ kind: "timeout", operation: "host" });
      await vi.advanceTimersByTimeAsync(timeoutMs ?? 20);
      await refusal;
    },
  );

  it("propagates the caller's abort", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    await expect(client().host({ signal: controller.signal })).rejects.toBe(
      reason,
    );
  });
});

describe("starting with trait requirements (MAR-3725)", () => {
  const enforcing = () => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: {
        version: 1,
        capabilities: ["host.profile.v1", "start.requires.v1"],
      },
    };
  };
  const requiring = (requires: string[]) => ({
    ...startRequestWithEnvironmentFixture.value,
    requires,
  });

  it("refuses a start with requirements, unsent, on a host that may ignore them", async () => {
    // Serving a profile is not enforcing requirements.
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities: ["host.profile.v1"] },
    };
    const refusal = await client()
      .start(requiring(["ios.simulator"]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartRequirementsError);
    expect(refusal).toMatchObject({
      code: "requirements-unenforced",
      operation: "start",
      requires: ["ios.simulator"],
      missingTraits: null,
      status: null,
    });
    expect((refusal as Error).message).toContain("start.requires.v1");
    expect((refusal as Error).message).toContain("nothing was sent");
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests).toEqual([]);
  });

  it("refuses the same on a host predating the descriptor", async () => {
    await expect(
      client().start(requiring(["ios.simulator"])),
    ).rejects.toMatchObject({ code: "requirements-unenforced" });
    expect(host.startRequests).toEqual([]);
  });

  it("sends traits at the top level to a host that enforces them", async () => {
    enforcing();
    const request = requiring(["ios.simulator", "future.trait"]);
    expect(await client().start(request)).toMatchObject({ status: "started" });
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests[0]).toMatchObject({
      requires: request.requires,
      config: request.config,
    });
    expect(host.startRequests[0]!.config).not.toHaveProperty("requires");
  });

  it.each([undefined, []])(
    "sends a start requiring %j as before: one request, no probe",
    async (requires) => {
      const request = {
        ...startRequestWithEnvironmentFixture.value,
        ...(requires === undefined ? {} : { requires }),
      };
      expect(await client().start(request)).toMatchObject({
        status: "started",
      });
      expect(host.healthRequests).toEqual([]);
      expect(host.startRequests).toHaveLength(1);
      expect(host.startRequests[0]).toEqual(
        JSON.parse(
          encodeExecutionStartRequest({
            ...request,
            commandId: host.startRequests[0]!.commandId as string,
          }),
        ),
      );
    },
  );

  it("surfaces the host's coded refusal of a missing trait", async () => {
    enforcing();
    host.startStatus = 400;
    host.startRefusal = {
      error: "Missing required host traits: ios.simulator",
      code: "requirements-unmet",
      missingTraits: ["ios.simulator"],
    };
    const refusal = await client()
      .start(requiring(["ios.simulator", "xcode"]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartRequirementsError);
    expect(refusal).toMatchObject({
      code: "requirements-unmet",
      status: 400,
      requires: ["ios.simulator", "xcode"],
      missingTraits: ["ios.simulator"],
      reason: "Missing required host traits: ios.simulator",
    });
  });

  it("keeps any other refusal an ExecutionHostError with the host's words", async () => {
    enforcing();
    host.startStatus = 400;
    host.startRefusal = { error: `Bad start for ${host.token}` };
    const refusal = await client()
      .start(requiring(["ios.simulator"]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({
      kind: "http",
      status: 400,
      operation: "start",
      reason: "Bad start for [token]",
    });
  });

  it("sends nothing when the probe cannot read the host", async () => {
    host.healthStatus = 503;
    await expect(
      client().start(requiring(["ios.simulator"])),
    ).rejects.toMatchObject({ kind: "http", status: 503, operation: "health" });
    expect(host.startRequests).toEqual([]);
  });

  it("propagates the caller's abort during the probe", async () => {
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    await expect(
      client().start(requiring(["ios.simulator"]), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(host.startRequests).toEqual([]);
  });

  it("answers the predicate from the advertised capabilities", () => {
    expect(hostEnforcesStartRequirements({ capabilities: [] })).toBe(false);
    expect(
      hostEnforcesStartRequirements({ capabilities: ["host.profile.v1"] }),
    ).toBe(false);
    expect(
      hostEnforcesStartRequirements({ capabilities: ["start.requires.v1"] }),
    ).toBe(true);
  });
});
