import { describe, expect, it } from "vitest";
import {
  decodeExecutionEventEnvelope,
  decodeExecutionMcpRefusal,
  decodeExecutionMcpServerList,
  decodeExecutionMcpServerRequest,
  decodeExecutionMcpSignIn,
  decodeExecutionMcpSignInStatus,
  encodeExecutionMcpServerRequest,
  EXECUTION_MCP_REFUSAL_STATUSES,
  EXECUTION_MCP_SERVERS_MAX_COUNT,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  isExecutionMcpServerName,
  isExecutionMcpUrl,
} from "../src/index.js";

const atlassian = {
  name: "atlassian",
  source: "user",
  transport: "http",
  state: "needs-sign-in",
  urlHost: "mcp.atlassian.com",
};

const envelope = (event: unknown) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    seq: 9,
    event,
  });

describe("MCP connections (MAR-5668)", () => {
  it("names its capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("mcp.connections.v1");
  });

  describe("server names", () => {
    it("takes the names Claude Code and Codex use", () => {
      for (const name of [
        "atlassian",
        "plugin:figma:figma",
        "claude.ai Gmail",
        "x".repeat(256),
      ]) {
        expect(isExecutionMcpServerName(name), name).toBe(true);
      }
    });

    it("refuses a name no call can address or show as it is", () => {
      for (const name of [
        "",
        "   ",
        "x".repeat(257),
        "line\nbreak",
        "linear‮",
        "\ud800",
        42,
        null,
      ]) {
        expect(isExecutionMcpServerName(name), String(name)).toBe(false);
      }
    });
  });

  describe("URLs", () => {
    it("takes http and https", () => {
      expect(
        isExecutionMcpUrl("https://mcp.atlassian.com/v1/authorize?a=b"),
      ).toBe(true);
      expect(isExecutionMcpUrl("http://localhost:52009/callback?code=c")).toBe(
        true,
      );
    });

    it("refuses any other scheme, a URL without a host, and spaces", () => {
      for (const url of [
        "javascript:alert(1)",
        "file:///etc/passwd",
        "accent://sign-in",
        "https://",
        "https:///path",
        "https://host/a b",
        "https://host/\u0000",
        `https://host/${"a".repeat(8192)}`,
      ]) {
        expect(isExecutionMcpUrl(url), url.slice(0, 40)).toBe(false);
      }
    });
  });

  describe("requests", () => {
    it("encodes a server, and a callback URL only on a finish", () => {
      expect(encodeExecutionMcpServerRequest({ server: "atlassian" })).toBe(
        '{"server":"atlassian"}',
      );
      const finish = {
        server: "atlassian",
        callbackUrl: "http://localhost:52009/callback?code=c&state=s",
      };
      expect(
        decodeExecutionMcpServerRequest(
          JSON.parse(encodeExecutionMcpServerRequest(finish)),
        ),
      ).toEqual({ ok: true, value: finish });
    });

    it("refuses a bad server or callback as a TypeError that never quotes it", () => {
      expect(() => encodeExecutionMcpServerRequest({ server: "" })).toThrow(
        TypeError,
      );
      const secret = "javascript:steal('secret-code')";
      expect(() =>
        encodeExecutionMcpServerRequest({ server: "a", callbackUrl: secret }),
      ).toThrow(TypeError);
      try {
        encodeExecutionMcpServerRequest({ server: "a", callbackUrl: secret });
      } catch (error) {
        expect(String(error)).not.toContain("secret-code");
      }
    });

    it("lets a host refuse a body by the same rules, ignoring fields it does not know", () => {
      expect(decodeExecutionMcpServerRequest({ server: "" }).ok).toBe(false);
      expect(
        decodeExecutionMcpServerRequest({
          server: "a",
          callbackUrl: "file:///x",
        }).ok,
      ).toBe(false);
      expect(
        decodeExecutionMcpServerRequest({ server: "a", later: true }),
      ).toEqual({ ok: true, value: { server: "a" } });
    });
  });

  describe("the server list", () => {
    it("reads every server as the host sent it", () => {
      const servers = [
        atlassian,
        {
          name: "claude.ai Gmail",
          source: "claude.ai",
          transport: "http",
          state: "connected",
        },
        {
          name: "broken",
          source: "project",
          transport: "stdio",
          state: "failed",
          reason: "The command exited",
        },
        {
          name: "slow",
          source: "plugin",
          transport: "sse",
          state: "connecting",
        },
      ];
      expect(decodeExecutionMcpServerList({ servers, later: 1 })).toEqual({
        ok: true,
        value: { servers, warnings: [] },
      });
    });

    it("is unreadable without a list", () => {
      expect(decodeExecutionMcpServerList({}).ok).toBe(false);
      expect(decodeExecutionMcpServerList({ servers: {} }).ok).toBe(false);
      expect(decodeExecutionMcpServerList(null).ok).toBe(false);
    });

    it("drops a server it cannot read, and a second by the same name, out loud", () => {
      const decoded = decodeExecutionMcpServerList({
        servers: [
          atlassian,
          { ...atlassian, name: "newer", source: "enterprise" },
          { ...atlassian, name: "later", state: "disabled" },
          { ...atlassian, name: "no-transport", transport: "" },
          { ...atlassian, name: "linear‮" },
          { ...atlassian, state: "connected" },
          "atlassian",
        ],
      });
      expect(decoded).toMatchObject({
        ok: true,
        value: {
          servers: [atlassian],
          warnings: [1, 2, 3, 4, 5, 6].map((index) => ({
            reason: "dropped-invalid-field",
            path: `servers.${index}`,
          })),
        },
      });
    });

    it("drops a urlHost that is more than a host, and keeps the server", () => {
      for (const urlHost of [
        "https://mcp.atlassian.com",
        "mcp.atlassian.com/v1?key=secret",
        "user:pass@mcp.atlassian.com",
        "mcp atlassian",
      ]) {
        const decoded = decodeExecutionMcpServerList({
          servers: [{ ...atlassian, urlHost }],
        });
        expect(decoded, urlHost).toMatchObject({
          ok: true,
          value: {
            servers: [{ name: "atlassian" }],
            warnings: [
              { reason: "dropped-invalid-field", path: "servers.0.urlHost" },
            ],
          },
        });
        if (decoded.ok)
          expect(decoded.value.servers[0]!.urlHost).toBeUndefined();
      }
      for (const urlHost of [
        "localhost:3000",
        "[::1]:8080",
        "mcp.linear.app",
      ]) {
        const decoded = decodeExecutionMcpServerList({
          servers: [{ ...atlassian, urlHost }],
        });
        expect(decoded.ok && decoded.value.servers[0]!.urlHost, urlHost).toBe(
          urlHost,
        );
      }
    });

    it("cleans and cuts a reason, and drops one with nothing left", () => {
      const decoded = decodeExecutionMcpServerList({
        servers: [
          { ...atlassian, reason: "  Needs‮ a sign-in\n" },
          { ...atlassian, name: "long", reason: "x".repeat(600) },
          { ...atlassian, name: "empty", reason: "‎ " },
        ],
      });
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      const [cleaned, long, empty] = decoded.value.servers;
      expect(cleaned!.reason).toBe("Needs a sign-in");
      expect(long!.reason).toHaveLength(512);
      expect(empty!.reason).toBeUndefined();
      expect(decoded.value.warnings).toEqual([
        { reason: "dropped-invalid-field", path: "servers.2.reason" },
      ]);
    });

    it("reads a list to its cap, and says it cut it", () => {
      const servers = Array.from(
        { length: EXECUTION_MCP_SERVERS_MAX_COUNT + 2 },
        (_, index) => ({ ...atlassian, name: `server-${index}` }),
      );
      const decoded = decodeExecutionMcpServerList({ servers });
      expect(decoded.ok && decoded.value.servers).toHaveLength(
        EXECUTION_MCP_SERVERS_MAX_COUNT,
      );
      expect(decoded.ok && decoded.value.warnings).toEqual([
        { reason: "dropped-excess-entries", path: "servers" },
      ]);
    });
  });

  describe("a sign-in", () => {
    const signIn = {
      signInUrl: "https://mcp.atlassian.com/v1/authorize?state=s",
      callbackExpected: true,
      expiresAt: "2026-11-23T13:00:00.000Z",
    };

    it("reads the URL to open, whether a callback is expected, and when it expires", () => {
      expect(decodeExecutionMcpSignIn({ ...signIn, state: "s" })).toEqual({
        ok: true,
        value: signIn,
      });
    });

    it("is unreadable with a URL a browser should not open, or without a field", () => {
      for (const raw of [
        { ...signIn, signInUrl: "javascript:alert(1)" },
        { ...signIn, signInUrl: "file:///etc/passwd" },
        { ...signIn, callbackExpected: "yes" },
        { ...signIn, expiresAt: "in five minutes" },
        { signInUrl: signIn.signInUrl },
      ]) {
        expect(decodeExecutionMcpSignIn(raw).ok).toBe(false);
      }
    });

    it("reads a state, cleaning its reason, and refuses one it does not know", () => {
      expect(decodeExecutionMcpSignInStatus({ state: "pending" })).toEqual({
        ok: true,
        value: { state: "pending" },
      });
      expect(
        decodeExecutionMcpSignInStatus({
          state: "failed",
          reason: "The sign-in expired",
        }),
      ).toEqual({
        ok: true,
        value: { state: "failed", reason: "The sign-inexpired" },
      });
      expect(decodeExecutionMcpSignInStatus({ state: "expired" }).ok).toBe(
        false,
      );
    });
  });

  it("reads a refusal's code, and gives each its status", () => {
    expect(EXECUTION_MCP_REFUSAL_STATUSES).toEqual({
      "unavailable-on-host": 403,
      "unknown-server": 404,
      "no-sign-in": 404,
      "not-offered": 409,
      "provider-unavailable": 503,
      rejected: 400,
    });
    expect(
      decodeExecutionMcpRefusal({ code: "not-offered", error: "stdio" }),
    ).toEqual({ ok: true, value: { code: "not-offered", error: "stdio" } });
    expect(decodeExecutionMcpRefusal({ code: "toString" }).ok).toBe(false);
    expect(decodeExecutionMcpRefusal({ error: "no code" }).ok).toBe(false);
  });

  describe("mcp.needs-sign-in", () => {
    it("reads the provider and the server", () => {
      const event = {
        kind: "mcp.needs-sign-in",
        provider: "claude",
        server: "plugin:figma:figma",
      };
      expect(decodeExecutionEventEnvelope(envelope(event))).toEqual({
        ok: true,
        value: {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sessionId: "session-1",
          seq: 9,
          event,
        },
      });
    });

    it("skips one for a provider this build does not know, keeping its place", () => {
      expect(
        decodeExecutionEventEnvelope(
          envelope({
            kind: "mcp.needs-sign-in",
            provider: "gemini",
            server: "linear",
          }),
        ),
      ).toEqual({
        ok: false,
        reason: "unknown-kind",
        skipped: {
          sessionId: "session-1",
          seq: 9,
          path: "event.provider",
          kind: "gemini",
        },
      });
    });

    it("is invalid without a provider or with a server no call can address", () => {
      for (const event of [
        { kind: "mcp.needs-sign-in", server: "linear" },
        { kind: "mcp.needs-sign-in", provider: "codex", server: "" },
        { kind: "mcp.needs-sign-in", provider: "codex" },
      ]) {
        expect(decodeExecutionEventEnvelope(envelope(event))).toMatchObject({
          ok: false,
          reason: "invalid-payload",
        });
      }
    });
  });
});
