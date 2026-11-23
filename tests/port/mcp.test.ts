import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionMcpError,
  type ExecutionHostApi,
  type ExecutionMcpErrorCode,
} from "../../src/client/index.js";
import {
  createPortClient,
  servePort,
  type ExecutionHostPort,
} from "../../src/port/index.js";
import type { ExecutionMcpProvider } from "../../src/index.js";
import { FakeHostModel, fakeApi } from "../conformance/fake-host.js";

const SECRET =
  "http://localhost:52009/callback?code=secret-code&state=secret-state";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A fake host's API behind a port, with `override` in place of its MCP
 * calls, and every message the client posted.
 */
function connect(
  override: (api: ExecutionHostApi) => Partial<ExecutionHostApi> = () => ({}),
) {
  const base = fakeApi(new FakeHostModel());
  const { port1, port2 } = new MessageChannel();
  const posted: unknown[] = [];
  const clientPort: ExecutionHostPort = {
    postMessage: (message) => {
      posted.push(message);
      port1.postMessage(message);
    },
    addEventListener: (type, listener) =>
      port1.addEventListener(type, listener),
    removeEventListener: (type, listener) =>
      port1.removeEventListener(type, listener),
    start: () => port1.start(),
    close: () => port1.close(),
  };
  const server = servePort(port2, { ...base, ...override(base) });
  const client = createPortClient(clientPort);
  cleanups.push(() => {
    client.close();
    server.close();
  });
  return { client, posted };
}

/** A host whose sign-in throws `thrown`. */
function throwing(thrown: unknown) {
  return connect(() => ({
    mcpSignIn: async () => {
      throw thrown;
    },
  })).client;
}

/** The parts of an error a caller sees. */
function seen(error: unknown) {
  const { name, message } = error as Error;
  const { code, status, reason, operation, provider, server, kind } =
    error as Record<string, unknown>;
  return {
    name,
    message,
    code,
    status,
    reason,
    operation,
    provider,
    server,
    kind,
  };
}

describe("MCP calls over a port (MAR-5668)", () => {
  it("refuses what the protocol would before posting anything", async () => {
    const { client, posted } = connect();
    const calls: Array<() => Promise<unknown>> = [
      () => client.mcpServers("gemini" as ExecutionMcpProvider),
      () => client.mcpSignIn("claude", ""),
      () => client.mcpSignInState("codex", "linear‮"),
      () => client.mcpCancelSignIn("claude", "x".repeat(257)),
      () => client.mcpSignOut("claude", null as unknown as string),
      () =>
        client.mcpFinishSignIn("claude", "atlassian", "javascript:alert(1)"),
      () => client.mcpFinishSignIn("claude", "atlassian", `accent://${SECRET}`),
    ];
    for (const call of calls) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain("secret");
    }
    expect(posted).toEqual([]);
    // A valid call still goes.
    await client.mcpServers("claude");
    expect(posted).toHaveLength(1);
  });

  it("withholds the host's words, whatever it threw", async () => {
    const cases: unknown[] = [
      new ExecutionMcpError("rejected", `bad callback ${SECRET}`, {
        operation: "mcp finish sign in",
        status: 400,
        provider: "claude",
        server: "atlassian",
      }),
      new ExecutionHostError("timeout", `no answer from ${SECRET}`, {
        operation: "mcp sign in",
        status: null,
      }),
      new TypeError(`refused ${SECRET}`),
      new RangeError(`refused ${SECRET}`),
      new Error(`the helper printed ${SECRET}`),
      `a string with ${SECRET}`,
    ];
    for (const thrown of cases) {
      const error = await throwing(thrown)
        .mcpSignIn("claude", "atlassian")
        .catch((caught: unknown) => caught);
      expect(JSON.stringify(seen(error))).not.toContain("secret");
      expect(String(error)).not.toContain("secret");
    }
    const timeout = await throwing(cases[1])
      .mcpSignIn("claude", "atlassian")
      .catch((caught: unknown) => caught);
    expect(timeout).toBeInstanceOf(ExecutionHostError);
    expect(timeout).toMatchObject({
      kind: "timeout",
      operation: "mcp sign in",
    });
    const typeError = await throwing(cases[2])
      .mcpSignIn("claude", "atlassian")
      .catch((caught: unknown) => caught);
    expect(typeError).toBeInstanceOf(TypeError);
  });

  it("holds a code to its status, and names what the caller asked", async () => {
    const cases: Array<[string, number, ExecutionMcpErrorCode]> = [
      ["unavailable-on-host", 403, "unavailable-on-host"],
      ["unknown-server", 404, "unknown-server"],
      ["not-offered", 409, "not-offered"],
      ["unsupported", 404, "unsupported"],
      // A code with a status the protocol does not give it is not that code.
      ["unavailable-on-host", 404, "rejected"],
      ["not-offered", 500, "rejected"],
      ["unsupported", 500, "rejected"],
      ["no-such-code", 404, "rejected"],
      // A 2xx is only ever an answer that could not be read.
      ["unknown-server", 200, "malformed"],
    ];
    for (const [claimed, status, code] of cases) {
      const error = await throwing(
        new ExecutionMcpError(claimed as ExecutionMcpErrorCode, "words", {
          operation: "something else",
          status,
          provider: "codex",
          server: "elsewhere",
        }),
      )
        .mcpSignIn("claude", "atlassian")
        .catch((caught: unknown) => caught);
      expect(error, `${claimed} ${status}`).toBeInstanceOf(ExecutionMcpError);
      expect(seen(error), `${claimed} ${status}`).toMatchObject({
        code,
        status,
        operation: "mcp sign in",
        provider: "claude",
        server: "atlassian",
      });
      expect((error as ExecutionMcpError).reason).not.toBe("words");
    }
  });

  it("makes a refusal the same error the HTTP client makes", async () => {
    const cases: Array<[ExecutionMcpErrorCode, number]> = [
      ["unavailable-on-host", 403],
      ["unknown-server", 404],
      ["no-sign-in", 404],
      ["not-offered", 409],
      ["provider-unavailable", 503],
      ["rejected", 400],
      ["rejected", 401],
      ["not-offered", 500],
    ];
    for (const [code, status] of cases) {
      const http = createExecutionHostClient({
        baseUrl: "http://daemon.test",
        token: "token",
        fetch: async () =>
          new Response(JSON.stringify({ code, error: `words ${SECRET}` }), {
            status,
          }),
      });
      const overHttp = await http
        .mcpSignInState("codex", "linear")
        .catch((caught: unknown) => caught);
      const { client } = connect(() => ({
        mcpSignInState: async () => {
          throw new ExecutionMcpError(code, `words ${SECRET}`, {
            operation: "mcp sign-in state",
            status,
            provider: "codex",
            server: "linear",
          });
        },
      }));
      const overPort = await client
        .mcpSignInState("codex", "linear")
        .catch((caught: unknown) => caught);
      expect(seen(overPort), `${code} ${status}`).toEqual(seen(overHttp));
    }
  });

  it("leaves the errors of every other call as they were", async () => {
    const { client } = connect(() => ({
      snapshot: async () => {
        throw new ExecutionHostError("http", "the host's words", {
          operation: "snapshot",
          status: 500,
        });
      },
    }));
    await expect(client.snapshot("s")).rejects.toMatchObject({
      reason: "the host's words",
    });
  });
});
