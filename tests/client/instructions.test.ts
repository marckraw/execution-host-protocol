import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionStartInstructionsError,
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
const request = (instructions: unknown) =>
  ({
    ...startRequestWithEnvironmentFixture.value,
    config: {
      ...startRequestWithEnvironmentFixture.value.config,
      instructions,
    },
  }) as ExecutionStartRequest;
const advertise = (...capabilities: string[]) => {
  host.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: { version: 1, capabilities },
  };
};

describe("instructions capability gate (MAR-4364)", () => {
  it.each(["old", "other-capabilities", "unreadable"])(
    "refuses instructions-unsupported without sending to a %s host",
    async (kind) => {
      if (kind === "other-capabilities")
        advertise("start.requires.v1", "start.fileReach.v1");
      if (kind === "unreadable")
        host.healthBody = {
          ...HEALTH_BODY,
          executionProtocol: {
            version: 1,
            capabilities: "start.instructions.v1",
          },
        };
      const failure = await client()
        .start(request("persona-private-text"))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ExecutionStartInstructionsError);
      expect(failure).toMatchObject({
        code: "instructions-unsupported",
        operation: "start",
        status: null,
      });
      expect(String(failure)).not.toContain("persona-private-text");
      expect(host.startRequests).toEqual([]);
    },
  );

  it("requires capability even for empty instructions", async () => {
    await expect(client().start(request(""))).rejects.toMatchObject({
      code: "instructions-unsupported",
    });
    expect(host.startRequests).toEqual([]);
  });

  it.each([null, 1, {}, "é".repeat(16385)])(
    "rejects invalid instructions before probing (%#)",
    async (value) => {
      await expect(client().start(request(value))).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(host.healthRequests).toEqual([]);
      expect(host.startRequests).toEqual([]);
    },
  );

  it("sends exact instructions to an advertising host with one shared probe for requires and fileReach", async () => {
    advertise(
      "start.instructions.v1",
      "start.requires.v1",
      "start.fileReach.v1",
    );
    await client().start({
      ...request("Tutor\n☃"),
      requires: ["linux"],
      fileReach: { entries: [] },
    });
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests[0]?.config).toHaveProperty(
      "instructions",
      "Tutor\n☃",
    );
  });

  it("keeps an ordinary start unprobed and unchanged", async () => {
    await client().start(startRequestWithEnvironmentFixture.value);
    expect(host.healthRequests).toEqual([]);
    expect(host.startRequests[0]?.config).not.toHaveProperty("instructions");
  });
});

it("types the capable host's provider refusal separately from the missing host capability", async () => {
  advertise("start.instructions.v1");
  host.startStatus = 400;
  host.startRefusal = {
    code: "instructions-unsupported-provider",
    error: "Unsupported provider",
  };
  const error = await client()
    .start(request("private frame"))
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ExecutionStartInstructionsError);
  expect(error).toMatchObject({
    code: "instructions-unsupported-provider",
    status: 400,
    operation: "start",
  });
  expect(host.startRequests).toHaveLength(1);
  expect(String(error)).not.toContain("private frame");
});

it("a 409 exists neither confirms nor changes the instructions", async () => {
  advertise("start.instructions.v1");
  host.startStatus = 409;
  const result = await client().start(request("different frame"));
  expect(result.status).toBe("exists");
  expect(result).not.toHaveProperty("instructions");
  expect(host.deleteRequests).toEqual([]);
});
