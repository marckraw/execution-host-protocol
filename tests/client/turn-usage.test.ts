import { describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  hostRecordsTurnUsage,
} from "../../src/client/index.js";

/**
 * MAR-4943: `listTurnUsage` is `GET /v0/usage/turns`, read as a page of the
 * host's usage history; a host without the route is `not-found`.
 */

const RECORD = {
  turnId: "turn-1",
  sessionId: "session-1",
  endedAt: "2026-10-30T21:00:00.000Z",
  source: "live",
  providerId: "codex",
  model: "gpt-5.1-codex",
  accountId: null,
  tokens: {
    input: 1_204,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 30_976,
    output: 2_310,
    reasoning: 1_536,
  },
};

function clientAnswering(answer: (url: URL) => Response) {
  const asked: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const client = createExecutionHostClient({
    baseUrl: "http://daemon.test",
    token: "usage-token",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      asked.push({ url, init });
      return answer(url);
    },
  });
  return { client, asked };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("listing turn usage", () => {
  it("reads a page of the host's history, with the token", async () => {
    const { client, asked } = clientAnswering(() =>
      json({
        protocolVersion: 1,
        records: [RECORD],
        nextCursor: "c1",
        hasMore: true,
      }),
    );
    const page = await client.listTurnUsage({
      since: "2026-10-01T00:00:00.000Z",
      limit: 1,
    });
    expect(page).toEqual({
      records: [RECORD],
      nextCursor: "c1",
      hasMore: true,
      warnings: [],
    });
    expect(asked).toHaveLength(1);
    const [{ url, init }] = asked as [(typeof asked)[number]];
    expect(url.pathname).toBe("/v0/usage/turns");
    expect(url.searchParams.get("since")).toBe("2026-10-01T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("1");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer usage-token",
    );
  });

  it("asks with no query for the history from its start", async () => {
    const { client, asked } = clientAnswering(() =>
      json({
        protocolVersion: 1,
        records: [],
        nextCursor: null,
        hasMore: false,
      }),
    );
    await client.listTurnUsage();
    expect(asked[0]!.url.search).toBe("");
  });

  it("carries a read on from its cursor", async () => {
    const { client, asked } = clientAnswering(() =>
      json({
        protocolVersion: 1,
        records: [],
        nextCursor: "c2",
        hasMore: false,
      }),
    );
    await client.listTurnUsage({ cursor: "c1" });
    expect(asked[0]!.url.searchParams.get("cursor")).toBe("c1");
  });

  it("refuses a query the protocol would refuse, unsent", async () => {
    const { client, asked } = clientAnswering(() => json({}));
    await expect(
      client.listTurnUsage({ since: "2026-10-01T00:00:00Z", cursor: "c1" }),
    ).rejects.toThrow(TypeError);
    await expect(client.listTurnUsage({ limit: 501 })).rejects.toThrow(
      RangeError,
    );
    expect(asked).toHaveLength(0);
  });

  it("names a record it could not read", async () => {
    const { client } = clientAnswering(() =>
      json({
        protocolVersion: 1,
        records: [{ ...RECORD, accountId: "me@ef.com" }, RECORD],
        nextCursor: "c1",
        hasMore: false,
      }),
    );
    const page = await client.listTurnUsage();
    expect(page.records).toEqual([RECORD]);
    expect(page.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "records.0" },
    ]);
  });

  it("is not-found on a host predating turns.usage.v1", async () => {
    const { client } = clientAnswering(() =>
      json({ error: "Route not found" }, 404),
    );
    const error = await client.listTurnUsage().catch((failure) => failure);
    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({
      kind: "not-found",
      status: 404,
      operation: "list turn usage",
    });
  });

  it("is malformed when the page cannot be read", async () => {
    const { client } = clientAnswering(() =>
      json({ protocolVersion: 1, records: [], nextCursor: null }),
    );
    await expect(client.listTurnUsage()).rejects.toMatchObject({
      kind: "malformed",
      operation: "list turn usage",
    });
  });

  it("is gated by turns.usage.v1", () => {
    expect(hostRecordsTurnUsage({ capabilities: ["turns.usage.v1"] })).toBe(
      true,
    );
    expect(hostRecordsTurnUsage({ capabilities: ["providers.usage.v1"] })).toBe(
      false,
    );
  });
});
