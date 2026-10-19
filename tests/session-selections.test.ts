import { describe, expect, it } from "vitest";
import {
  decodeExecutionStartRequest,
  encodeExecutionStartRequest,
  type ExecutionStartRequest,
} from "../src/index.js";
import {
  createExecutionHostClient,
  ExecutionStartSelectionError,
} from "../src/client/index.js";
import { createStubHost, HEALTH_BODY } from "./client/stub-host.js";

const start = (picks: Record<string, unknown> = {}): ExecutionStartRequest => ({
  protocolVersion: 1,
  providerId: "claude",
  config: {
    sessionId: "session-new",
    initialMessage: "Work",
    model: null,
    effort: null,
    continuationToken: null,
    ...picks,
  },
});

describe("session selections (MAR-4365)", () => {
  it.each([
    {},
    { mcpServers: [], skills: [] },
    { mcpServers: ["linear"], skills: ["review"] },
  ])("round trips picks without turning absence into empty: %j", (picks) => {
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(start(picks))),
    ).toEqual({ ok: true, value: start(picks) });
  });
  for (const key of ["mcpServers", "skills"]) {
    it.each([
      null,
      "linear",
      [1],
      [""],
      [" "],
      ["x".repeat(257)],
      Array(1025).fill("x"),
    ])(`refuses malformed ${key}: %j`, (value) => {
      expect(
        decodeExecutionStartRequest(JSON.stringify(start({ [key]: value }))),
      ).toMatchObject({ ok: false });
    });
  }
  it("refuses even empty picks before posting to an old host", async () => {
    const host = createStubHost();
    const calls: string[] = [];
    const client = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: (url, init) => {
        calls.push(init?.method ?? "GET");
        return host.fetch(url, init);
      },
    });
    await expect(client.start(start({ skills: [] }))).rejects.toMatchObject({
      code: "selection-unsupported",
      status: null,
    });
    expect(calls).toEqual(["GET"]);
  });
  it("sends selected names and empty lists intact to a capable host", async () => {
    const host = createStubHost();
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities: ["start.selections.v1"] },
    };
    const client = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: host.fetch,
    });
    await client.start(start({ mcpServers: ["linear"], skills: [] }));
    expect(host.startRequests[0]).toMatchObject({
      config: { mcpServers: ["linear"], skills: [] },
    });
  });
  it("leaves an unpicked start unchanged, without a health probe", async () => {
    const host = createStubHost();
    const client = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: host.token,
      fetch: host.fetch,
    });
    await client.start(start());
    expect(host.healthRequests).toHaveLength(0);
  });
  it.each(["unknown-mcp-server", "unknown-skill", "selection-unsupported"])(
    "returns the host's coded 400: %s",
    async (code) => {
      const host = createStubHost();
      host.healthBody = {
        ...HEALTH_BODY,
        executionProtocol: {
          version: 1,
          capabilities: ["start.selections.v1"],
        },
      };
      const client = createExecutionHostClient({
        baseUrl: "https://host.test",
        token: host.token,
        fetch: (url, init) =>
          init?.method === "POST"
            ? Promise.resolve(
                Response.json({ code, error: "refused" }, { status: 400 }),
              )
            : host.fetch(url, init),
      });
      try {
        await client.start(start({ mcpServers: ["linear"] }));
        throw new Error("should refuse");
      } catch (error) {
        expect(error).toBeInstanceOf(ExecutionStartSelectionError);
        expect(error).toMatchObject({ code, status: 400 });
      }
    },
  );
  it("checks bad picks locally before any request", async () => {
    const client = createExecutionHostClient({
      baseUrl: "https://host.test",
      token: "test",
      fetch: () => {
        throw new Error("sent");
      },
    });
    await expect(client.start(start({ skills: null }))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});
