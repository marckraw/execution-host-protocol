import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  decodeExecutionSessionList,
  decodeExecutionSessionSnapshot,
  type ExecutionWarningsNotice,
  ExecutionSessionPatchError,
  ExecutionStartWorksInError,
  hostTakesSettled,
  hostTakesWorksIn,
} from "../../src/client/index.js";
import {
  decodeExecutionSessionPatchRequest,
  decodeExecutionSessionWorkspace,
  decodeExecutionSessionPatchResponse,
  decodeExecutionStartRequest,
  encodeExecutionStartRequest,
  type ExecutionStartRequest,
  type ExecutionWorksIn,
  readExecutionCheckoutTakenRefusal,
  readExecutionWorksInEcho,
} from "../../src/index.js";
import { startRequestWithEnvironmentFixture } from "../fixtures/contract-fixtures.js";
import { createStubHost, HEALTH_BODY, type StubHost } from "./stub-host.js";

/** MAR-5673: where a start in a person's own checkout works, and settling. */

let host: StubHost;
let heard: ExecutionWarningsNotice[];
beforeEach(() => {
  host = createStubHost();
  heard = [];
});
const client = () =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: host.fetch,
    onWarnings: (notice) => heard.push(notice),
  });
const advertising = (...capabilities: string[]) => {
  host.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: { version: 1, capabilities },
  };
};
const base = startRequestWithEnvironmentFixture.value;
const sessionId = base.config.sessionId;
const placed = (worksIn: unknown): ExecutionStartRequest => ({
  ...base,
  config: { ...base.config, worksIn: worksIn as ExecutionWorksIn },
});

describe("a start's worksIn, as the protocol reads it", () => {
  it("keeps each choice, and leaves it out where absent", () => {
    for (const worksIn of ["auto", "checkout", "worktree"] as const) {
      const decoded = decodeExecutionStartRequest(
        encodeExecutionStartRequest(placed(worksIn)),
      );
      expect(decoded.ok && decoded.value.config.worksIn).toBe(worksIn);
    }
    const plain = decodeExecutionStartRequest(
      encodeExecutionStartRequest(base),
    );
    expect(plain.ok && "worksIn" in plain.value.config).toBe(false);
  });

  it("refuses one it doesn't know rather than drop it", () => {
    for (const worksIn of ["", "Worktree", "clone", null, true, ["worktree"]]) {
      expect(
        decodeExecutionStartRequest(
          encodeExecutionStartRequest(placed(worksIn)),
        ),
      ).toMatchObject({ ok: false, reason: "invalid-payload" });
    }
  });

  it("reads a 201's echo, and nothing it can't hold", () => {
    const echo = {
      place: "checkout",
      checkoutRoot: "/Users/person/code/shop",
      workingThere: ["session-2"],
    };
    expect(readExecutionWorksInEcho(echo)).toEqual(echo);
    expect(
      readExecutionWorksInEcho({ ...echo, place: "worktree", extra: 1 }),
    ).toEqual({ ...echo, place: "worktree" });
    for (const bad of [
      null,
      "checkout",
      { ...echo, place: "clone" },
      { ...echo, checkoutRoot: "" },
      { ...echo, workingThere: "session-2" },
      { ...echo, workingThere: [""] },
      { ...echo, workingThere: Array.from({ length: 33 }, (_, i) => `s${i}`) },
    ]) {
      expect(readExecutionWorksInEcho(bad)).toBeNull();
    }
  });
});

describe("a project session's place in its checkout (MAR-5673)", () => {
  const project = {
    mode: "project",
    projectId: "backpack",
    workingDirectory: "/Users/person/code/backpack",
    origin: null,
    originKey: null,
    branchName: "main",
    environment: null,
  };

  it("reads where it works, and leaves out what it can't read", () => {
    for (const place of ["checkout", "worktree"]) {
      expect(decodeExecutionSessionWorkspace({ ...project, place })).toEqual({
        ok: true,
        value: { ...project, place },
      });
    }
    for (const place of ["clone", 7, null]) {
      expect(decodeExecutionSessionWorkspace({ ...project, place })).toEqual({
        ok: true,
        value: project,
      });
    }
    expect(decodeExecutionSessionWorkspace(project)).toEqual({
      ok: true,
      value: project,
    });
  });
});

describe("starting with worksIn (MAR-5673)", () => {
  it("refuses checkout and worktree, unsent, on a host that would choose by itself", async () => {
    advertising("start.requires.v1");
    for (const worksIn of ["checkout", "worktree"] as const) {
      const refusal = await client()
        .start(placed(worksIn))
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ExecutionStartWorksInError);
      expect(refusal).toMatchObject({
        code: "works-in-unsupported",
        operation: "start",
      });
      expect((refusal as Error).message).toContain("start.worksIn.v1");
      expect((refusal as Error).message).toContain("nothing was sent");
    }
    expect(host.healthRequests).toHaveLength(2);
    expect(host.startRequests).toEqual([]);
  });

  it("refuses the same on a host whose descriptor is unreadable", async () => {
    host.healthBody = { ...HEALTH_BODY, executionProtocol: "v1" };
    const refusal = await client()
      .start(placed("worktree"))
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "works-in-unsupported" });
    expect((refusal as Error).message).toContain("unreadable");
    expect(host.startRequests).toEqual([]);
  });

  it("sends auto to any host, unprobed, as a start without it", async () => {
    advertising();
    const started = await client().start(placed("auto"));
    expect(started.status).toBe("started");
    expect(host.healthRequests).toEqual([]);
    expect(
      (host.startRequests[0]?.config as Record<string, unknown>).worksIn,
    ).toBe("auto");
  });

  it("refuses a choice the protocol doesn't know as a TypeError, unsent", async () => {
    advertising("start.worksIn.v1");
    await expect(client().start(placed("clone"))).rejects.toThrow(TypeError);
    expect(host.healthRequests).toEqual([]);
    expect(host.startRequests).toEqual([]);
  });

  it("sends it to a host that takes it, and answers where it works", async () => {
    advertising("start.worksIn.v1");
    const echo = {
      place: "checkout",
      checkoutRoot: "/srv/projects/new-blok",
      workingThere: ["session-2"],
    };
    host.startBody = () => ({ sessionId, worksIn: echo });
    expect(await client().start(placed("checkout"))).toEqual({
      status: "started",
      sessionId,
      commandId: expect.any(String),
      workspace: null,
      worksIn: echo,
    });
    expect(
      (host.startRequests[0]?.config as Record<string, unknown>).worksIn,
    ).toBe("checkout");
    expect(heard).toEqual([]);
  });

  it("starts all the same when the echo can't be read, and says so", async () => {
    advertising("start.worksIn.v1");
    host.startBody = () => ({ sessionId, worksIn: { place: "elsewhere" } });
    const started = await client().start(placed("worktree"));
    expect(started).toEqual({
      status: "started",
      sessionId,
      commandId: expect.any(String),
      workspace: null,
    });
    expect(heard).toEqual([
      {
        operation: "start",
        sessionId,
        warnings: [{ reason: "dropped-invalid-field", path: "worksIn" }],
      },
    ]);
  });

  it("refuses a checkout another session works in, never starting it there", async () => {
    advertising("start.worksIn.v1");
    host.startStatus = 409;
    host.startRefusal = {
      error:
        "session-2 is working in /srv/projects/new-blok: this one can't share its checkout",
      code: "checkout-taken",
      workingThere: ["session-2"],
    };
    const refusal = await client()
      .start(placed("checkout"))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartWorksInError);
    expect(refusal).toMatchObject({
      code: "checkout-taken",
      status: 409,
      workingThere: ["session-2"],
      reason: expect.stringContaining("can't share its checkout"),
    });
  });

  it("reads a 409 of a checkout start that says nothing of it as the session it has", async () => {
    advertising("start.worksIn.v1");
    host.startStatus = 409;
    host.startRefusal = { error: "Session already exists" };
    expect(await client().start(placed("checkout"))).toEqual({
      status: "exists",
      sessionId,
      commandId: expect.any(String),
    });
  });

  it("reads a checkout-taken refusal, and nothing that isn't one", () => {
    const refusal = {
      error: "taken",
      code: "checkout-taken",
      workingThere: ["session-2"],
    };
    expect(readExecutionCheckoutTakenRefusal(refusal)).toEqual(refusal);
    for (const bad of [
      null,
      { ...refusal, code: "turn-running" },
      { ...refusal, error: 7 },
      { ...refusal, workingThere: [] },
      { ...refusal, workingThere: [""] },
      { ...refusal, workingThere: "session-2" },
    ]) {
      expect(readExecutionCheckoutTakenRefusal(bad)).toBeNull();
    }
  });

  it("is told by the capability", () => {
    expect(hostTakesWorksIn({ capabilities: ["start.worksIn.v1"] })).toBe(true);
    expect(hostTakesWorksIn({ capabilities: ["sessions.settled.v1"] })).toBe(
      false,
    );
  });
});

describe("settling a session (MAR-5673)", () => {
  it("reads which sessions the host says are settled, in a snapshot and the list", () => {
    const snapshot = {
      protocolVersion: 1,
      sessionId: "session-1",
      providerId: "claude",
      lastSeq: 3,
      conversation: [],
    };
    const read = (raw: object) => {
      const decoded = decodeExecutionSessionSnapshot(raw);
      return decoded.ok ? decoded.value.settled : "unread";
    };
    expect(read({ ...snapshot, settled: true })).toBe(true);
    expect(read(snapshot)).toBeUndefined();
    expect(read({ ...snapshot, settled: "yes" })).toBeUndefined();

    const list = decodeExecutionSessionList({
      protocolVersion: 1,
      nextCursor: null,
      sessions: [
        { ...snapshot, settled: true },
        { ...snapshot, sessionId: "session-2" },
      ],
    });
    expect(list.ok && list.value.sessions.map((one) => one.settled)).toEqual([
      true,
      undefined,
    ]);
  });

  it("reads settled in a patch, and refuses one that isn't a boolean", () => {
    for (const settled of [true, false]) {
      expect(
        decodeExecutionSessionPatchRequest(JSON.stringify({ settled })),
      ).toEqual({ ok: true, value: { settled } });
    }
    for (const settled of ["true", 1, null]) {
      expect(
        decodeExecutionSessionPatchRequest(JSON.stringify({ settled })),
      ).toMatchObject({ ok: false, reason: "invalid-payload" });
    }
    expect(
      decodeExecutionSessionPatchResponse({ sessionId: "s", settled: true }),
    ).toEqual({ ok: true, value: { sessionId: "s", settled: true } });
    // An answer's settled in words it doesn't know is not said, never a failure.
    expect(
      decodeExecutionSessionPatchResponse({ sessionId: "s", settled: "yes" }),
    ).toEqual({ ok: true, value: { sessionId: "s" } });
  });

  it("refuses settled, unsent, on a host that predates it", async () => {
    advertising("sessions.permissionModes.v1");
    const refusal = await client()
      .patchSession("session-1", { settled: true })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionSessionPatchError);
    expect(refusal).toMatchObject({
      code: "unsupported-on-host",
      sessionId: "session-1",
      status: null,
    });
    expect((refusal as Error).message).toContain("sessions.settled.v1");
    expect(host.patchRequests).toEqual([]);
  });

  it("sends it to a host that takes it, and reads what it holds", async () => {
    advertising("sessions.settled.v1");
    host.patchBody = (id, patch) => ({
      protocolVersion: 1,
      sessionId: id,
      settled: patch.settled,
    });
    expect(
      await client().patchSession("session-1", { settled: false }),
    ).toEqual({ status: "patched", sessionId: "session-1", settled: false });
    expect(host.patchRequests).toEqual([
      { sessionId: "session-1", body: { settled: false } },
    ]);
  });

  it("asks both capabilities of a patch naming a mode and settled", async () => {
    advertising("sessions.settled.v1");
    await expect(
      client().patchSession("session-1", {
        settled: true,
        permissionConfig: { preset: "yolo" },
      }),
    ).rejects.toMatchObject({ code: "unsupported-on-host" });
    expect(host.patchRequests).toEqual([]);
    expect(host.healthRequests).toHaveLength(1);
    expect(hostTakesSettled({ capabilities: ["sessions.settled.v1"] })).toBe(
      true,
    );
  });
});
