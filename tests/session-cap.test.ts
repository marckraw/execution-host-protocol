import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  decodeExecutionProviderListResponse,
  decodeExecutionProviderSessionCap,
} from "../src/index.js";

/**
 * MAR-5692: a provider's own cap on its live sessions on a host, and how many
 * are live now. The drive policy it replaces (MAR-5634) is gone.
 */

const cap = { maxConcurrentSessions: 2, liveSessions: 1 };

describe("decodeExecutionProviderSessionCap", () => {
  it("reads both counts, and nothing beyond them", () => {
    expect(
      decodeExecutionProviderSessionCap({ ...cap, ownerId: "usr_marcin" }),
    ).toEqual({ ok: true, value: cap });
    expect(
      decodeExecutionProviderSessionCap({
        maxConcurrentSessions: 0,
        liveSessions: 0,
      }),
    ).toEqual({
      ok: true,
      value: { maxConcurrentSessions: 0, liveSessions: 0 },
    });
  });

  it.each([
    ["not an object", 2],
    ["a negative cap", { ...cap, maxConcurrentSessions: -1 }],
    ["a fractional count", { ...cap, liveSessions: 1.5 }],
    ["a count as a string", { ...cap, liveSessions: "1" }],
    ["a missing count", { maxConcurrentSessions: 2 }],
  ])("refuses %s", (_name, raw) => {
    expect(decodeExecutionProviderSessionCap(raw)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("a provider's session cap in the listing", () => {
  it("reads it beside the rest of the provider", () => {
    expect(
      decodeExecutionProviderListResponse({
        providers: [
          { id: "antigravity", label: "Antigravity", sessionCap: cap },
          { id: "claude" },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "antigravity",
            label: "Antigravity",
            effortLevels: [],
            models: [],
            sessionCap: cap,
          },
          { id: "claude", label: "claude", effortLevels: [], models: [] },
        ],
      },
    });
  });

  it("reads one it cannot read as absent, with a warning, and keeps the catalogue", () => {
    const decoded = decodeExecutionProviderListResponse({
      providers: [
        { id: "claude" },
        { id: "antigravity", sessionCap: { ...cap, liveSessions: -1 } },
      ],
    });
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.value.providers[1]).toEqual({
      id: "antigravity",
      label: "antigravity",
      effortLevels: [],
      models: [],
    });
    expect(decoded.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "providers.1.sessionCap" },
    ]);
  });

  it("drops a drive policy an older host still reports, saying nothing of it", () => {
    const decoded = decodeExecutionProviderListResponse({
      providers: [
        {
          id: "antigravity",
          drivePolicy: { ownerId: "usr_marcin", ...cap },
        },
      ],
    });
    expect(decoded).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "antigravity",
            label: "antigravity",
            effortLevels: [],
            models: [],
          },
        ],
      },
    });
  });
});

describe("the drive policy is gone (MAR-5692)", () => {
  it("has no rule, reader or capability left", () => {
    const exported = contract as Record<string, unknown>;
    expect(exported.drivePolicyRefusalOf).toBeUndefined();
    expect(exported.decodeExecutionDrivePolicy).toBeUndefined();
    expect(exported.decodeExecutionDrivePolicyRefusal).toBeUndefined();
    expect(exported.EXECUTION_DRIVE_POLICY_REFUSED).toBeUndefined();
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).not.toContain(
      "providers.drivePolicy.v1",
    );
  });
});
