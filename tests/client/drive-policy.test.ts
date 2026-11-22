import { describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  hostEnforcesDrivePolicy,
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

  it("answers the predicate from the advertised capabilities", () => {
    expect(
      hostEnforcesDrivePolicy({ capabilities: ["providers.drivePolicy.v1"] }),
    ).toBe(true);
    expect(
      hostEnforcesDrivePolicy({ capabilities: ["providers.usage.v1"] }),
    ).toBe(false);
  });
});
