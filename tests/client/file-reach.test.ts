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

  /** A host that fences on `/health`, then answers a start with `body`. */
  const answering =
    (
      status: number,
      body: string,
      deletes: string[],
    ): typeof globalThis.fetch =>
    async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return host.fetch(input, init);
      if (init?.method === "DELETE") {
        deletes.push(new URL(url).pathname);
        return new Response(null, { status: 200 });
      }
      return new Response(body, { status });
    };

  it.each([
    ["is not JSON", "<html>oops</html>", "its answer could not be read"],
    ["is empty", "", "its answer names no session"],
    ["is {}", "{}", "its answer names no session"],
    [
      "names no session",
      JSON.stringify({ protocolVersion: 1 }),
      "its answer names no session",
    ],
    [
      "names another session",
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "someone-elses",
        fileReach: { entries: fileReach.entries, abi: 6 },
      }),
      "its answer is about another session",
    ],
  ])(
    "deletes the requested session when a 201's answer %s, and refuses it",
    async (_, body, why) => {
      enforcing();
      const deletes: string[] = [];
      const connection = createExecutionHostClient({
        baseUrl: "https://host.test",
        token: host.token,
        fetch: answering(201, body, deletes),
      });
      const refusal = await connection
        .start(reaching())
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ExecutionStartFileReachError);
      expect(refusal).toMatchObject({
        code: "file-reach-unconfirmed",
        status: 201,
        sessionId,
        sessionDeleted: true,
      });
      expect((refusal as Error).message).toContain(why);
      expect((refusal as Error).message).not.toContain("someone-elses");
      // The session this request asked for, never the one the answer named.
      expect(deletes).toEqual([`/v0/execution/sessions/${sessionId}`]);
    },
  );

  it("keeps a malformed 201 for a start without a reach as before: malformed, nothing deleted", async () => {
    const deletes: string[] = [];
    const connection = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: answering(201, "{}", deletes),
    });
    await expect(
      connection.start(startRequestWithEnvironmentFixture.value),
    ).rejects.toMatchObject({ kind: "malformed", operation: "start" });
    expect(deletes).toEqual([]);
  });

  it("leaves an older session alone when a 409 to a start with a reach can't be read", async () => {
    enforcing();
    const deletes: string[] = [];
    const connection = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: answering(409, "not json", deletes),
    });
    await expect(connection.start(reaching())).rejects.toMatchObject({
      code: "file-reach-unconfirmed",
      status: 409,
      sessionDeleted: null,
    });
    expect(deletes).toEqual([]);
  });

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

describe("a reach beside a file (MAR-4352)", () => {
  const SECRET_NAME = "payroll-2026-Q3-salaries.xlsx";
  const SECRET_BASE64 = Buffer.from("account 4242 4242 4242 4242").toString(
    "base64",
  );
  const withFile = {
    ...startRequestWithEnvironmentFixture.value,
    config: {
      ...startRequestWithEnvironmentFixture.value.config,
      inlineAttachments: [
        {
          kind: "file" as const,
          name: SECRET_NAME,
          mimeType: "application/vnd.ms-excel",
          sizeBytes: Buffer.from(SECRET_BASE64, "base64").byteLength,
          dataBase64: SECRET_BASE64,
        },
      ],
    },
    fileReach,
  };
  const everythingSaid = (error: unknown): string =>
    error instanceof Error
      ? [
          error.message,
          error.stack ?? "",
          JSON.stringify(error, Object.getOwnPropertyNames(error)),
          everythingSaid(error.cause),
        ].join("\n")
      : String(error ?? "");

  it("carries the code and which entries, never the host's words, which may quote the file", async () => {
    enforcing("attachments.inline-file.v1");
    host.takesFiles = true;
    host.startStatus = 400;
    host.startRefusal = {
      error: `Refused ${SECRET_NAME} (${SECRET_BASE64}): "{worktree}/apps/server/src/**" isn't there`,
      code: "file-reach-refused",
      problems: [{ problem: "path-missing", entry: 1 }],
    };
    const refusal = await client()
      .start(withFile)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartFileReachError);
    expect(refusal).toMatchObject({
      code: "file-reach-refused",
      status: 400,
      problems: [{ problem: "path-missing", entry: 1 }],
      fileReach,
    });
    const said = everythingSaid(refusal);
    expect(said).not.toContain(SECRET_NAME);
    expect(said).not.toContain(SECRET_BASE64);
    expect(said).not.toContain("4242");
    expect((refusal as ExecutionStartFileReachError).reason).toContain(
      "its words are not carried",
    );
  });

  it("keeps the host's words for a reach without a file", async () => {
    enforcing();
    host.startStatus = 400;
    host.startRefusal = {
      error: `"{worktree}/x" isn't there`,
      code: "file-reach-refused",
      problems: [{ problem: "path-missing", entry: 0 }],
    };
    await expect(client().start(reaching())).rejects.toMatchObject({
      reason: `"{worktree}/x" isn't there`,
    });
  });
});
