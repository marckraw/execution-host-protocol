import { describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionMcpError,
  hostManagesMcpConnections,
  type ExecutionMcpErrorCode,
} from "../../src/client/index.js";

interface Sent {
  method: string;
  url: string;
  body: string | null;
}

const SIGN_IN_URL =
  "https://mcp.atlassian.com/v1/authorize?client=accent&state=secret-state";
const CALLBACK_URL =
  "http://localhost:52009/callback?code=secret-code&state=secret-state";

/** A client whose host answers each request with `answer`, keeping what it was sent. */
function clientAnswering(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const client = createExecutionHostClient({
    baseUrl: "http://daemon.test",
    token: "token",
    fetch: async (input, init) => {
      const request: Sent = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? init.body : null,
      };
      sent.push(request);
      return answer(request);
    },
  });
  return { client, sent };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function mcpError(work: Promise<unknown>): Promise<ExecutionMcpError> {
  const error = await work.then(
    () => {
      throw new Error("resolved");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExecutionMcpError);
  return error as ExecutionMcpError;
}

describe("the client's MCP calls (MAR-5668)", () => {
  it("gates on mcp.connections.v1", () => {
    expect(
      hostManagesMcpConnections({ capabilities: ["mcp.connections.v1"] }),
    ).toBe(true);
    expect(hostManagesMcpConnections({ capabilities: ["oneshot.v1"] })).toBe(
      false,
    );
  });

  it("asks each route, with the server in the body or the query and never the path", async () => {
    const { client, sent } = clientAnswering(({ url }) => {
      if (url.endsWith("/servers")) {
        return json({
          servers: [
            {
              name: "plugin:figma:figma",
              source: "plugin",
              transport: "http",
              state: "needs-sign-in",
            },
          ],
        });
      }
      if (url.endsWith("/sign-out")) return new Response(null, { status: 204 });
      if (
        url.endsWith("/mcp/claude/sign-in") &&
        sent.at(-1)!.method === "POST"
      ) {
        return json({
          signInUrl: SIGN_IN_URL,
          callbackExpected: true,
          expiresAt: "2026-11-23T13:00:00.000Z",
        });
      }
      return json({ state: "pending" });
    });
    const server = "plugin:figma:figma";
    expect(await client.mcpServers("claude")).toEqual({
      servers: [
        {
          name: server,
          source: "plugin",
          transport: "http",
          state: "needs-sign-in",
        },
      ],
      warnings: [],
    });
    expect(await client.mcpSignIn("claude", server)).toEqual({
      signInUrl: SIGN_IN_URL,
      callbackExpected: true,
      expiresAt: "2026-11-23T13:00:00.000Z",
    });
    expect(await client.mcpSignInState("claude", server)).toEqual({
      state: "pending",
    });
    expect(
      await client.mcpFinishSignIn("claude", server, CALLBACK_URL),
    ).toEqual({ state: "pending" });
    expect(await client.mcpCancelSignIn("codex", server)).toEqual({
      state: "pending",
    });
    expect(await client.mcpSignOut("codex", server)).toBeUndefined();

    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET http://daemon.test/v0/mcp/claude/servers",
      "POST http://daemon.test/v0/mcp/claude/sign-in",
      "GET http://daemon.test/v0/mcp/claude/sign-in?server=plugin%3Afigma%3Afigma",
      "POST http://daemon.test/v0/mcp/claude/sign-in/finish",
      "POST http://daemon.test/v0/mcp/codex/sign-in/cancel",
      "POST http://daemon.test/v0/mcp/codex/sign-out",
    ]);
    expect(sent.map(({ body }) => body && JSON.parse(body))).toEqual([
      null,
      { server },
      null,
      { server, callbackUrl: CALLBACK_URL },
      { server },
      { server },
    ]);
    // The authorization code travels in a body alone.
    expect(sent.filter(({ url }) => url.includes("secret-code"))).toEqual([]);
  });

  it("refuses what the protocol would before anything is sent, never quoting a callback URL", async () => {
    const { client, sent } = clientAnswering(() => json({}));
    await expect(
      client.mcpServers("gemini" as "claude"),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(client.mcpSignIn("claude", "")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      client.mcpSignInState("claude", "linear‮"),
    ).rejects.toBeInstanceOf(TypeError);
    const error = await client
      .mcpFinishSignIn("claude", "atlassian", "accent://secret-code")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("secret-code");
    expect(sent).toEqual([]);
  });

  it("reads each refusal by its code and status, in its own words", async () => {
    const cases: Array<[number, unknown, ExecutionMcpErrorCode]> = [
      [403, { code: "unavailable-on-host" }, "unavailable-on-host"],
      [404, { code: "unknown-server" }, "unknown-server"],
      [404, { code: "no-sign-in" }, "no-sign-in"],
      [409, { code: "not-offered" }, "not-offered"],
      [503, { code: "provider-unavailable" }, "provider-unavailable"],
      [400, { code: "rejected" }, "rejected"],
      // A host predating the routes, or a proxy.
      [404, { error: "Route not found" }, "unsupported"],
      [404, "Not Found", "unsupported"],
      // A newer host's code is not a missing route.
      [404, { code: "server-gone" }, "rejected"],
      // A known code with another status is not that code.
      [500, { code: "unavailable-on-host" }, "rejected"],
      [401, { error: "Unauthorized" }, "rejected"],
    ];
    for (const [status, body, code] of cases) {
      const { client } = clientAnswering(() =>
        typeof body === "string"
          ? new Response(body, { status })
          : json(body, status),
      );
      const error = await mcpError(client.mcpSignIn("claude", "atlassian"));
      expect(error, `${status} ${JSON.stringify(body)}`).toMatchObject({
        code,
        status,
        operation: "mcp sign in",
        provider: "claude",
        server: "atlassian",
      });
    }
  });

  it("never carries the host's words, which may quote a URL", async () => {
    const { client } = clientAnswering(() =>
      json({ code: "rejected", error: `bad callback ${CALLBACK_URL}` }, 400),
    );
    const error = await mcpError(
      client.mcpFinishSignIn("claude", "atlassian", CALLBACK_URL),
    );
    expect(error.code).toBe("rejected");
    expect(`${error.message} ${error.reason}`).not.toContain("secret");
  });

  it("calls an answer it cannot read malformed, without quoting it", async () => {
    const answers: unknown[] = [
      { signInUrl: "javascript:alert('secret')", callbackExpected: true },
      {
        signInUrl: SIGN_IN_URL,
        callbackExpected: "yes",
        expiresAt: "2026-11-23T13:00:00.000Z",
      },
      "not json",
    ];
    for (const answer of answers) {
      const { client } = clientAnswering(() =>
        typeof answer === "string"
          ? new Response(answer, { status: 200 })
          : json(answer),
      );
      const error = await mcpError(client.mcpSignIn("claude", "atlassian"));
      expect(error.code).toBe("malformed");
      expect(error.message).not.toContain("secret");
    }
    const { client } = clientAnswering(() => json({ state: "expired" }));
    expect(
      (await mcpError(client.mcpSignInState("claude", "atlassian"))).code,
    ).toBe("malformed");
    const listless = clientAnswering(() => json({ mcpServers: [] }));
    expect((await mcpError(listless.client.mcpServers("codex"))).code).toBe(
      "malformed",
    );
  });

  it("reads past a server it cannot read, and names it", async () => {
    const { client } = clientAnswering(() =>
      json({
        servers: [
          { name: "a", source: "user", transport: "http", state: "connected" },
          {
            name: "b",
            source: "managed",
            transport: "http",
            state: "connected",
          },
        ],
      }),
    );
    expect(await client.mcpServers("claude")).toEqual({
      servers: [
        { name: "a", source: "user", transport: "http", state: "connected" },
      ],
      warnings: [{ reason: "dropped-invalid-field", path: "servers.1" }],
    });
  });

  it("is an ExecutionHostError only when the host cannot be reached or answer in time", async () => {
    const unreachable = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "token",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(unreachable.mcpServers("claude")).rejects.toMatchObject({
      name: "ExecutionHostError",
      kind: "network",
      operation: "mcp servers",
    });
    // As fetch does, it gives up when the client's deadline aborts it.
    const client = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "token",
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        }),
    });
    const late = await client
      .mcpSignIn("claude", "atlassian", { timeoutMs: 20 })
      .catch((caught: unknown) => caught);
    expect(late).toBeInstanceOf(ExecutionHostError);
    expect((late as ExecutionHostError).kind).toBe("timeout");
  });
});
