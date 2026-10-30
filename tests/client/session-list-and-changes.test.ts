import { describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  decodeExecutionSessionList,
  ExecutionHostError,
} from "../../src/client/index.js";

/**
 * One row of agents-daemon's `GET /v0/execution/sessions`, as its
 * `rowToSummary` writes it (`src/execution/execution-session-store.ts`),
 * `commandable` set by the session manager.
 */
const daemonRow = {
  protocolVersion: 1,
  sessionId: "accent_8f2c",
  name: "accent_8f2c",
  title: "Fix the login form",
  providerId: "claude",
  commandable: true,
  model: "claude-opus-5-5",
  effort: null,
  status: "idle",
  attention: "needs-input",
  activity: null,
  metadata: null,
  continuationToken: "provider-secret-ish",
  contextWindow: null,
  conversationItemCount: 12,
  lastSeq: 48,
  workspace: null,
  prUrl: null,
  roomId: null,
  createdAt: "2026-10-29T08:00:00.000Z",
  updatedAt: "2026-10-29T09:30:00.000Z",
  deletedAt: null,
};

const fileChange = {
  id: "change-1",
  sessionId: "accent_8f2c",
  turnId: "combined",
  filePath: "src/login.ts",
  oldPath: null,
  status: "modified",
  additions: 2,
  deletions: 1,
  diff: "@@ -1 +1,2 @@",
  truncated: false,
  binary: false,
  createdAt: "2026-10-29T09:31:00.000Z",
};

function clientAnswering(answer: (url: URL) => Response): {
  client: ReturnType<typeof createExecutionHostClient>;
  urls: URL[];
} {
  const urls: URL[] = [];
  const client = createExecutionHostClient({
    baseUrl: "http://daemon.test",
    token: "list-and-changes-token",
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return answer(url);
    },
  });
  return { client, urls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("listing sessions", () => {
  it("reads agents-daemon's page, leaving the continuation token behind", async () => {
    const { client, urls } = clientAnswering(() =>
      json({ protocolVersion: 1, sessions: [daemonRow], nextCursor: "abc" }),
    );
    const list = await client.listSessions({
      limit: 20,
      status: "idle",
      providerId: "claude",
      q: "login",
      roomId: "room-1",
      cursor: "prev",
      includeDeleted: true,
    });
    expect(urls[0]!.pathname).toBe("/v0/execution/sessions");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      cursor: "prev",
      limit: "20",
      status: "idle",
      providerId: "claude",
      q: "login",
      roomId: "room-1",
      includeDeleted: "true",
    });
    expect(list).toEqual({
      sessions: [
        {
          sessionId: "accent_8f2c",
          providerId: "claude",
          name: "accent_8f2c",
          title: "Fix the login form",
          model: "claude-opus-5-5",
          effort: null,
          commandable: true,
          status: "idle",
          attention: "needs-input",
          activity: null,
          metadata: null,
          contextWindow: null,
          conversationItemCount: 12,
          lastSeq: 48,
          workspace: null,
          prUrl: null,
          roomId: null,
          createdAt: "2026-10-29T08:00:00.000Z",
          updatedAt: "2026-10-29T09:30:00.000Z",
          deletedAt: null,
        },
      ],
      nextCursor: "abc",
      warnings: [],
    });
  });

  it("sends no query when asked for none", async () => {
    const { client, urls } = clientAnswering(() =>
      json({ protocolVersion: 1, sessions: [], nextCursor: null }),
    );
    expect(await client.listSessions()).toEqual({
      sessions: [],
      nextCursor: null,
      warnings: [],
    });
    expect(urls[0]!.search).toBe("");
  });

  it.each([
    [{ limit: 0 }, RangeError],
    [{ limit: 101 }, RangeError],
    [{ limit: 1.5 }, RangeError],
    [{ status: "sleeping" }, TypeError],
    [{ providerId: " claude" }, TypeError],
    [{ q: "x".repeat(257) }, TypeError],
    [{ cursor: "" }, TypeError],
    [{ roomId: "" }, TypeError],
    [{ includeDeleted: "yes" }, TypeError],
  ])("refuses %j unsent", async (query, type) => {
    const { client, urls } = clientAnswering(() => json({}));
    await expect(client.listSessions(query as never)).rejects.toBeInstanceOf(
      type,
    );
    expect(urls).toEqual([]);
  });

  it("drops what it cannot read, and says so", () => {
    const decoded = decodeExecutionSessionList({
      protocolVersion: 1,
      sessions: [
        { ...daemonRow, status: "dreaming", conversationItemCount: -1 },
        { ...daemonRow, sessionId: "" },
        { ...daemonRow, sessionId: "b", futureField: { anything: true } },
      ],
      nextCursor: 42,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.sessions.map((session) => session.sessionId)).toEqual([
      "accent_8f2c",
      "b",
    ]);
    expect(decoded.value.sessions[0]).toMatchObject({
      status: "idle",
      conversationItemCount: null,
    });
    expect(decoded.value.nextCursor).toBeNull();
    expect(decoded.value.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "sessions.0.status" },
      {
        reason: "dropped-invalid-field",
        path: "sessions.0.conversationItemCount",
      },
      { reason: "dropped-invalid-field", path: "sessions.1" },
      { reason: "dropped-invalid-field", path: "nextCursor" },
    ]);
  });

  it("refuses a page with no frame as malformed, and a refusal by its kind", async () => {
    const malformed = clientAnswering(() => json({ sessions: [] }));
    await expect(malformed.client.listSessions()).rejects.toMatchObject({
      name: "ExecutionHostError",
      kind: "malformed",
      operation: "list sessions",
    });
    const refused = clientAnswering(() =>
      json({ error: "Invalid session list query: cursor is malformed" }, 400),
    );
    const error = await refused.client
      .listSessions({ cursor: "x" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "http",
      status: 400,
      reason: "Invalid session list query: cursor is malformed",
    });
  });
});

describe("a session's combined changes", () => {
  it("reads them from the combined scope", async () => {
    const { client, urls } = clientAnswering(() =>
      json({
        protocolVersion: 1,
        scope: "combined",
        fileChanges: [fileChange, { ...fileChange, status: "renamed-ish" }],
      }),
    );
    expect(await client.sessionChanges("accent_8f2c")).toEqual({
      status: "changes",
      sessionId: "accent_8f2c",
      fileChanges: [fileChange],
      warnings: [{ reason: "dropped-invalid-field", path: "fileChanges.1" }],
    });
    expect(urls[0]!.pathname).toBe(
      "/v0/execution/sessions/accent_8f2c/changes",
    );
    expect(urls[0]!.searchParams.get("scope")).toBe("combined");
  });

  it.each([
    [404, { status: "no-session", sessionId: "s" }],
    [409, { status: "unavailable", sessionId: "s", reason: "not-recorded" }],
    [410, { status: "unavailable", sessionId: "s", reason: "pruned" }],
  ])("answers a %i as %j", async (status, expected) => {
    const { client } = clientAnswering(() => json({ error: "no" }, status));
    expect(await client.sessionChanges("s")).toEqual(expected);
  });

  it("refuses another session's changes, and any other refusal", async () => {
    const crossed = clientAnswering(() =>
      json({
        protocolVersion: 1,
        scope: "combined",
        fileChanges: [fileChange],
      }),
    );
    await expect(crossed.client.sessionChanges("other")).rejects.toMatchObject({
      kind: "malformed",
      operation: "session changes",
    });
    const failed = clientAnswering(() => json({ error: "git broke" }, 500));
    await expect(failed.client.sessionChanges("s")).rejects.toMatchObject({
      kind: "http",
      status: 500,
      reason: "git broke",
    });
  });
});
