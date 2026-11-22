import { describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  hostEnforcesDrivePolicy,
  type ExecutionWarningsNotice,
} from "../../src/client/index.js";

/**
 * MAR-5634: `providers()` carries each provider's drive policy, and a client
 * asks the host's capabilities whether it enforces it.
 */

const drivePolicy = {
  ownerId: "usr_marcin",
  allow: {
    tokenDriven: true,
    automations: false,
    waitForRoom: true,
    afterChains: false,
    anyHost: false,
    others: false,
  },
  maxConcurrentSessions: 2,
  liveSessions: 0,
};

describe("the drive policy through the client (MAR-5634)", () => {
  it("lists a provider with its drive policy", async () => {
    const client = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "policy-token",
      fetch: async () =>
        new Response(
          JSON.stringify({ providers: [{ id: "antigravity", drivePolicy }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    expect(await client.providers()).toEqual([
      {
        id: "antigravity",
        label: "antigravity",
        effortLevels: [],
        models: [],
        drivePolicy,
      },
    ]);
  });

  it("tells onWarnings of a drive policy it could not read, and lists the provider without it", async () => {
    const heard: ExecutionWarningsNotice[] = [];
    const client = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "policy-token",
      onWarnings: (notice) => heard.push(notice),
      fetch: async () =>
        new Response(
          JSON.stringify({
            providers: [
              { id: "claude" },
              {
                id: "antigravity",
                drivePolicy: { ...drivePolicy, liveSessions: -1 },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    expect(await client.providers()).toEqual([
      { id: "claude", label: "claude", effortLevels: [], models: [] },
      { id: "antigravity", label: "antigravity", effortLevels: [], models: [] },
    ]);
    expect(heard).toEqual([
      {
        operation: "providers",
        sessionId: null,
        warnings: [
          { reason: "dropped-invalid-field", path: "providers.1.drivePolicy" },
        ],
      },
    ]);
  });

  it("tells onWarnings nothing of a catalogue it read whole", async () => {
    const heard: ExecutionWarningsNotice[] = [];
    const client = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "policy-token",
      onWarnings: (notice) => heard.push(notice),
      fetch: async () =>
        new Response(
          JSON.stringify({ providers: [{ id: "antigravity", drivePolicy }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

    await client.providers();
    expect(heard).toEqual([]);
  });

  it("answers the predicate from the advertised capabilities", () => {
    expect(
      hostEnforcesDrivePolicy({ capabilities: ["providers.drivePolicy.v1"] }),
    ).toBe(true);
    expect(
      hostEnforcesDrivePolicy({ capabilities: ["providers.usage.v1"] }),
    ).toBe(false);
  });
});
