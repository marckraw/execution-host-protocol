import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionStartFileReachError,
  ExecutionStartRequirementsError,
  hostEnforcesFileReach,
} from "../../src/client/index.js";
import type { ExecutionFileReach } from "../../src/index.js";
import { startRequestWithEnvironmentFixture } from "../fixtures/contract-fixtures.js";
import { fencingHostProfileFixture } from "../fixtures/host-profile-fixtures.js";
import { createStubHost, type StubHost, HEALTH_BODY } from "./stub-host.js";

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
const enforcing = (...more: string[]) => {
  host.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: {
      version: 1,
      capabilities: ["host.profile.v1", "start.fileReach.v1", ...more],
    },
  };
};
const sessionId = startRequestWithEnvironmentFixture.value.config.sessionId;
const fileReach: ExecutionFileReach = {
  entries: [
    { path: "{worktree}", access: "read" },
    { path: "{worktree}/apps/server/src/**", access: "write" },
    { path: "{tmp}", access: "write" },
  ],
};
const reaching = (reach: unknown = fileReach) => ({
  ...startRequestWithEnvironmentFixture.value,
  fileReach: reach as ExecutionFileReach,
});

describe("starting with a file reach (MAR-4352)", () => {
  it("refuses a reach, unsent, on a host that may ignore it", async () => {
    // Serving a profile, or checking requirements, is not fencing.
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: {
        version: 1,
        capabilities: ["host.profile.v1", "start.requires.v1"],
      },
    };
    const refusal = await client()
      .start(reaching())
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartFileReachError);
    expect(refusal).toMatchObject({
      code: "file-reach-unenforced",
      operation: "start",
      fileReach,
      problems: null,
      status: null,
      sessionId: null,
    });
    expect((refusal as Error).message).toContain("start.fileReach.v1");
    expect((refusal as Error).message).toContain("nothing was sent");
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests).toEqual([]);
  });

  it("refuses the same on a host predating the descriptor, and an empty reach too", async () => {
    await expect(client().start(reaching())).rejects.toMatchObject({
      code: "file-reach-unenforced",
    });
    await expect(
      client().start(reaching({ entries: [] })),
    ).rejects.toMatchObject({ code: "file-reach-unenforced" });
    expect(host.startRequests).toEqual([]);
  });

  it("says an unreadable descriptor is unreadable, not unadvertised", async () => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities: "start.fileReach.v1" },
    };
    const refusal = (await client()
      .start(reaching())
      .catch((error: unknown) => error)) as ExecutionStartFileReachError;
    expect(refusal.code).toBe("file-reach-unenforced");
    expect(refusal.reason).toContain("unreadable");
    expect(host.startRequests).toEqual([]);
  });

  it.each([
    ["not an object", "{worktree}"],
    ["an unknown access", { entries: [{ path: "{worktree}", access: "x" }] }],
    ["entries not a list", { entries: "{worktree}" }],
  ])(
    "throws a TypeError, unsent and unprobed, for a reach that is %s",
    async (_, reach) => {
      enforcing();
      await expect(client().start(reaching(reach))).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(host.healthRequests).toEqual([]);
      expect(host.startRequests).toEqual([]);
    },
  );

  it("sends the reach at the top level to a host that enforces it, and returns its echo", async () => {
    enforcing();
    const answer = await client().start(reaching());
    expect(answer).toEqual({
      status: "started",
      sessionId,
      commandId: expect.any(String),
      workspace: null,
      fileReach: { entries: fileReach.entries, abi: 6 },
    });
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests[0]).toMatchObject({ fileReach });
    expect(host.startRequests[0]!.config).not.toHaveProperty("fileReach");
  });

  it("sends a start without a reach as before: one request, no probe, no echo", async () => {
    const answer = await client().start(
      startRequestWithEnvironmentFixture.value,
    );
    expect(answer).toMatchObject({ status: "started" });
    expect(answer).not.toHaveProperty("fileReach");
    expect(host.healthRequests).toEqual([]);
    expect(host.startRequests[0]).not.toHaveProperty("fileReach");
  });

  it("probes once for a start with both requires and a reach", async () => {
    enforcing("start.requires.v1");
    await client().start({ ...reaching(), requires: ["linux"] });
    expect(host.healthRequests).toHaveLength(1);
    expect(host.startRequests[0]).toMatchObject({
      requires: ["linux"],
      fileReach,
    });
  });

  it.each([
    ["unknown-place", 1],
    ["escapes-place", 0],
    ["past-ceiling", 2],
    ["path-missing", 1],
    ["cannot-fence", null],
  ] as const)(
    "surfaces the host's refusal coded %s, naming the entry",
    async (problem, entry) => {
      enforcing();
      host.startStatus = 400;
      host.startRefusal = {
        error: `This session's file reach can't be held: ${problem}`,
        code: "file-reach-refused",
        problems: [{ problem, entry }],
      };
      const refusal = await client()
        .start(reaching())
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ExecutionStartFileReachError);
      expect(refusal).toMatchObject({
        code: "file-reach-refused",
        status: 400,
        fileReach,
        problems: [{ problem, entry }],
        sessionId: null,
        reason: `This session's file reach can't be held: ${problem}`,
      });
      expect(host.deleteRequests).toEqual([]);
    },
  );

  it("keeps only problems about this reach, and bounds and scrubs the host's words", async () => {
    enforcing();
    host.startStatus = 400;
    host.startRefusal = {
      error: `refused for ${host.token} ${"x".repeat(10_000)}`,
      code: "file-reach-refused",
      problems: [
        { problem: "path-missing", entry: 3 },
        { problem: "path-missing", entry: 99 },
      ],
    };
    const refusal = (await client()
      .start(reaching())
      .catch((error: unknown) => error)) as ExecutionStartFileReachError;
    expect(refusal).toMatchObject({
      code: "file-reach-refused",
      problems: null,
    });
    expect(refusal.reason.length).toBeLessThanOrEqual(501);
    expect(refusal.message).not.toContain(host.token);
  });

  it("honours the code only on a 400, and only for a start that carried a reach", async () => {
    const body = {
      error: "refused",
      code: "file-reach-refused",
      problems: [{ problem: "cannot-fence", entry: null }],
    };
    enforcing();
    host.startStatus = 503;
    host.startRefusal = body;
    await expect(client().start(reaching())).rejects.toBeInstanceOf(
      ExecutionHostError,
    );
    host.startStatus = 400;
    await expect(
      client().start(startRequestWithEnvironmentFixture.value),
    ).rejects.toBeInstanceOf(ExecutionHostError);
  });

  it("keeps any other refusal an ExecutionHostError", async () => {
    enforcing();
    host.startStatus = 400;
    host.startRefusal = { error: "Invalid start request: invalid-payload" };
    const refusal = await client()
      .start(reaching())
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({ status: 400, operation: "start" });
  });

  it.each([
    ["no echo", undefined],
    ["an echo of none", null],
    ["an echo of less", { entries: fileReach.entries.slice(1), abi: 6 }],
    [
      "an echo of more",
      {
        entries: [...fileReach.entries, { path: "{clone}", access: "read" }],
        abi: 6,
      },
    ],
    ["an echo without an ABI", { entries: fileReach.entries }],
  ])(
    "deletes the session a 201 with %s made, and refuses it",
    async (_, echoed) => {
      // `/health` says it fences; the process behind it dropped the reach.
      enforcing();
      host.startBody = (body) => ({
        protocolVersion: 1,
        sessionId: (body.config as { sessionId: string }).sessionId,
        ...(echoed === undefined ? {} : { fileReach: echoed }),
      });
      const refusal = await client()
        .start(reaching())
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ExecutionStartFileReachError);
      expect(refusal).toMatchObject({
        code: "file-reach-unconfirmed",
        status: 201,
        sessionId,
        fileReach,
        sessionDeleted: true,
      });
      expect((refusal as Error).message).toContain("it was deleted");
      expect(host.deleteRequests).toEqual([sessionId]);
      expect(host.sessions.has(sessionId)).toBe(false);
    },
  );

  it("says so when deleting the unconfirmed session fails", async () => {
    enforcing();
    host.startBody = (body) => ({
      protocolVersion: 1,
      sessionId: (body.config as { sessionId: string }).sessionId,
    });
    host.deleteStatus = 500;
    const refusal = await client()
      .start(reaching())
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "file-reach-unconfirmed",
      sessionDeleted: false,
    });
    expect((refusal as Error).message).toContain("may still be running");
    // The retry hears 409, whose echo says the session is held to none.
    const retry = await client()
      .start(reaching())
      .catch((error: unknown) => error);
    expect(retry).toMatchObject({
      code: "file-reach-unconfirmed",
      status: 409,
      sessionId,
      sessionDeleted: null,
    });
    expect(host.deleteRequests).toEqual([sessionId]);
  });

  it("names requires first when a 201 echoes neither", async () => {
    enforcing("start.requires.v1");
    host.startBody = (body) => ({
      protocolVersion: 1,
      sessionId: (body.config as { sessionId: string }).sessionId,
    });
    const refusal = await client()
      .start({ ...reaching(), requires: ["linux"] })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartRequirementsError);
    expect(refusal).toMatchObject({
      code: "requirements-unconfirmed",
      sessionDeleted: true,
    });
  });

  it("refuses a 201 that echoes requires but not the reach", async () => {
    enforcing("start.requires.v1");
    host.startBody = (body) => ({
      protocolVersion: 1,
      sessionId: (body.config as { sessionId: string }).sessionId,
      requires: body.requires,
    });
    await expect(
      client().start({ ...reaching(), requires: ["linux"] }),
    ).rejects.toMatchObject({
      code: "file-reach-unconfirmed",
      sessionDeleted: true,
    });
  });

  it.each([
    [
      "the same reach",
      { entries: [...fileReach.entries].reverse(), abi: 4 },
      "exists",
    ],
    ["none", null, "file-reach-unconfirmed"],
    [
      "another reach",
      { entries: fileReach.entries.slice(0, 1), abi: 4 },
      "file-reach-unconfirmed",
    ],
  ])(
    "reads a 409 for a session held to %s as %s, and leaves it alone",
    async (_, existing, outcome) => {
      enforcing();
      host.sessions.add(sessionId);
      host.existingFileReach = existing;
      const answer = await client()
        .start(reaching())
        .catch((error: unknown) => error);
      if (outcome === "exists") {
        expect(answer).toEqual({
          status: "exists",
          sessionId,
          commandId: expect.any(String),
          fileReach: existing,
        });
      } else {
        expect(answer).toBeInstanceOf(ExecutionStartFileReachError);
        expect(answer).toMatchObject({
          code: outcome,
          status: 409,
          sessionDeleted: null,
        });
      }
      expect(host.deleteRequests).toEqual([]);
      expect(host.sessions.has(sessionId)).toBe(true);
    },
  );

  it("keeps a 409 without a reach as before: exists, no probe", async () => {
    host.sessions.add(sessionId);
    const answer = await client().start(
      startRequestWithEnvironmentFixture.value,
    );
    expect(answer).toEqual({
      status: "exists",
      sessionId,
      commandId: expect.any(String),
    });
    expect(host.healthRequests).toEqual([]);
  });

  it("reads the host's fence from its profile", async () => {
    host.hostBody = fencingHostProfileFixture;
    expect(await client().host()).toEqual({
      profile: fencingHostProfileFixture,
      warnings: [],
    });
  });

  it("answers the predicate from the advertised capabilities", () => {
    expect(
      hostEnforcesFileReach({ capabilities: ["start.fileReach.v1"] }),
    ).toBe(true);
    expect(hostEnforcesFileReach({ capabilities: ["start.requires.v1"] })).toBe(
      false,
    );
  });
});
