import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionHostClient } from "../../src/client/index.js";
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

  it.each([{}, { ...macHostProfileFixture, devices: { iosSimulator: null } }])(
    "refuses unreadable profiles %j",
    async (body) => {
      host.hostBody = body;
      await expect(client().host()).rejects.toMatchObject({
        kind: "malformed",
        operation: "host",
      });
    },
  );

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

describe("starting with trait requirements", () => {
  it("sends traits at the top level without altering the session config", async () => {
    const request = {
      ...startRequestWithEnvironmentFixture.value,
      requires: ["ios.simulator", "future.trait"],
    };
    expect(await client().start(request)).toMatchObject({ status: "started" });
    expect(host.startRequests[0]).toMatchObject({
      requires: request.requires,
      config: request.config,
    });
    expect(host.startRequests[0]!.config).not.toHaveProperty("requires");
  });

  it("surfaces the host's missing-trait refusal as a readable error", async () => {
    const connection = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: "Missing required host traits: ios.simulator",
          }),
          { status: 400 },
        ),
    });
    await expect(
      connection.start({
        ...startRequestWithEnvironmentFixture.value,
        requires: ["ios.simulator"],
      }),
    ).rejects.toMatchObject({
      kind: "http",
      status: 400,
      operation: "start",
      reason: "Missing required host traits: ios.simulator",
    });
  });
});
