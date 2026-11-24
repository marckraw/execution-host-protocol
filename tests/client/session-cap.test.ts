import { describe, expect, it } from "vitest";
import * as client from "../../src/client/index.js";
import {
  createExecutionHostClient,
  type ExecutionWarningsNotice,
} from "../../src/client/index.js";

/** MAR-5692: `providers()` carries each provider's session cap, and a bad one is said. */

const sessionCap = { maxConcurrentSessions: 2, liveSessions: 0 };

const listing = (providers: unknown[]) => async () =>
  new Response(JSON.stringify({ providers }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("a provider's session cap through the client (MAR-5692)", () => {
  it("lists a provider with its cap and live count", async () => {
    const host = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "cap-token",
      fetch: listing([{ id: "antigravity", sessionCap }]),
    });

    expect(await host.providers()).toEqual([
      {
        id: "antigravity",
        label: "antigravity",
        effortLevels: [],
        models: [],
        sessionCap,
      },
    ]);
  });

  it("tells onWarnings of a cap it could not read, and lists the provider without it", async () => {
    const heard: ExecutionWarningsNotice[] = [];
    const host = createExecutionHostClient({
      baseUrl: "http://daemon.test",
      token: "cap-token",
      onWarnings: (notice) => heard.push(notice),
      fetch: listing([
        { id: "claude" },
        { id: "antigravity", sessionCap: { ...sessionCap, liveSessions: -1 } },
      ]),
    });

    expect(await host.providers()).toEqual([
      { id: "claude", label: "claude", effortLevels: [], models: [] },
      { id: "antigravity", label: "antigravity", effortLevels: [], models: [] },
    ]);
    expect(heard).toEqual([
      {
        operation: "providers",
        sessionId: null,
        warnings: [
          { reason: "dropped-invalid-field", path: "providers.1.sessionCap" },
        ],
      },
    ]);
  });

  it("has no drive-policy helper any more", () => {
    expect(
      (client as Record<string, unknown>).hostEnforcesDrivePolicy,
    ).toBeUndefined();
  });
});
