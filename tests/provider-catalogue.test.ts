import { describe, expect, it } from "vitest";
import { decodeExecutionProviderListResponse } from "../src/index.js";
import { PROVIDERS_BODY } from "./client/stub-host.js";

/** MAR-3671: the catalogue a host serves at `GET /v0/providers`. */

const decoded = (raw: unknown) => decodeExecutionProviderListResponse(raw);

describe("decodeExecutionProviderListResponse", () => {
  it("reads agents-daemon's catalogue, ignoring the fields it does not name", () => {
    expect(decoded(PROVIDERS_BODY)).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "claude",
            label: "Claude",
            available: true,
            authenticated: true,
            effortLevels: ["low", "medium", "high"],
            models: [
              {
                slug: "claude-opus-5-5",
                label: "Opus 5.5",
                defaultEffort: "medium",
                efforts: ["low", "medium", "high"],
              },
              {
                // No effortOptions of its own: it takes what its provider does.
                slug: "claude-haiku-4-5-20251001",
                label: "Haiku 4.5",
                defaultEffort: null,
                efforts: ["low", "medium", "high"],
              },
            ],
          },
          {
            id: "codex",
            label: "Codex",
            available: true,
            authenticated: false,
            effortLevels: [],
            models: [],
          },
        ],
      },
    });
  });

  it("gives a model its own efforts before its provider's, even none", () => {
    const result = decoded({
      providers: [
        {
          id: "claude",
          features: { effortLevels: ["low", "high"] },
          models: [{ slug: "plain", effortOptions: [] }],
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { providers: [{ models: [{ slug: "plain", efforts: [] }] }] },
    });
  });

  it("falls back to the id for a label, and leaves unsaid readiness unsaid", () => {
    const result = decoded({
      providers: [{ id: "gemini", models: [{ slug: "gemini-3" }] }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        providers: [
          {
            id: "gemini",
            label: "gemini",
            effortLevels: [],
            models: [
              {
                slug: "gemini-3",
                label: "gemini-3",
                defaultEffort: null,
                efforts: [],
              },
            ],
          },
        ],
      },
    });
    expect(result.ok && "available" in result.value.providers[0]!).toBe(false);
    expect(result.ok && "authenticated" in result.value.providers[0]!).toBe(
      false,
    );
  });

  it("reads an empty catalogue", () => {
    expect(decoded({ providers: [] })).toEqual({
      ok: true,
      value: { providers: [] },
    });
  });

  it("refuses what a session's selection could not rest on", () => {
    const refused: Array<[string, unknown]> = [
      ["not an object", []],
      ["no providers", {}],
      ["providers not a list", { providers: {} }],
      ["a provider without an id", { providers: [{ models: [] }] }],
      ["a provider with an empty id", { providers: [{ id: "" }] }],
      [
        "a non-boolean available",
        { providers: [{ id: "a", available: "yes" }] },
      ],
      [
        "a model without a slug",
        { providers: [{ id: "a", models: [{ label: "x" }] }] },
      ],
      [
        "an effort option without an id",
        {
          providers: [
            {
              id: "a",
              models: [{ slug: "m", effortOptions: [{ label: "x" }] }],
            },
          ],
        },
      ],
      [
        "effort levels that are not strings",
        { providers: [{ id: "a", features: { effortLevels: [1] } }] },
      ],
      [
        "a default effort that is a number",
        { providers: [{ id: "a", models: [{ slug: "m", defaultEffort: 3 }] }] },
      ],
      [
        "a protocol version it does not speak",
        { protocolVersion: 2, providers: [] },
      ],
    ];
    for (const [, raw] of refused) {
      expect(decoded(raw).ok).toBe(false);
    }
    expect(decoded({ protocolVersion: 2, providers: [] })).toEqual({
      ok: false,
      reason: "unsupported-protocol-version",
    });
    expect(decoded({ providers: [{ models: [] }] })).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});
