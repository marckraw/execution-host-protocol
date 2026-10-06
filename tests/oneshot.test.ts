import { describe, expect, it } from "vitest";
import {
  decodeExecutionOneShotRefusal,
  decodeExecutionOneShotRequest,
  decodeExecutionOneShotResponse,
  encodeExecutionOneShotRequest,
  EXECUTION_ONESHOT_PROMPT_MAX_LENGTH,
  EXECUTION_ONESHOT_REFUSAL_CODES,
  EXECUTION_ONESHOT_TEXT_MAX_LENGTH,
  EXECUTION_ONESHOT_TIMEOUT_MAX_MS,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
} from "../src/index.js";

const REQUEST = {
  contract: "oneshot.v1" as const,
  providerId: "codex",
  model: "gpt-5.5",
  prompt: "Name this session",
};

describe("one-shot requests", () => {
  it("is a known capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("oneshot.v1");
  });

  it("encodes agents-daemon's route body, fields in one order whatever the caller's", () => {
    expect(
      encodeExecutionOneShotRequest({
        timeoutMs: 30_000,
        contract: "oneshot.v1",
        prompt: "Name this session",
        effort: "low",
        model: "gpt-5.5",
        providerId: "codex",
      }),
    ).toBe(
      '{"contract":"oneshot.v1","providerId":"codex","model":"gpt-5.5","effort":"low","prompt":"Name this session","timeoutMs":30000}',
    );
    expect(encodeExecutionOneShotRequest(REQUEST)).toBe(
      '{"contract":"oneshot.v1","providerId":"codex","model":"gpt-5.5","prompt":"Name this session"}',
    );
  });

  it("decodes what it encodes", () => {
    const full = { ...REQUEST, effort: "high", timeoutMs: 1 };
    expect(
      decodeExecutionOneShotRequest(encodeExecutionOneShotRequest(full)),
    ).toEqual({ ok: true, value: full });
  });

  it("takes the caps exactly", () => {
    const atCaps = {
      contract: "oneshot.v1",
      providerId: "p".repeat(256),
      model: "m".repeat(256),
      effort: "e".repeat(256),
      prompt: "x".repeat(EXECUTION_ONESHOT_PROMPT_MAX_LENGTH),
      timeoutMs: EXECUTION_ONESHOT_TIMEOUT_MAX_MS,
    };
    expect(decodeExecutionOneShotRequest(JSON.stringify(atCaps)).ok).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a field it does not know", { ...REQUEST, tools: ["Bash"] }],
    ["a session", { ...REQUEST, sessionId: "session-1" }],
    ["no provider", { contract: "oneshot.v1", model: "gpt-5.5", prompt: "hi" }],
    [
      "no prompt",
      { contract: "oneshot.v1", providerId: "codex", model: "gpt-5.5" },
    ],
    [
      "no contract: the route as released, not a oneshot.v1 request",
      { providerId: "codex", model: "gpt-5.5", prompt: "hi" },
    ],
    ["another contract", { ...REQUEST, contract: "oneshot.v2" }],
    ["a near-miss contract", { ...REQUEST, contract: "oneshot.v1 " }],
    ["a null contract", { ...REQUEST, contract: null }],
    ["a blank prompt", { ...REQUEST, prompt: "  \n" }],
    [
      "a prompt over the cap",
      {
        ...REQUEST,
        prompt: "x".repeat(EXECUTION_ONESHOT_PROMPT_MAX_LENGTH + 1),
      },
    ],
    ["a blank model", { ...REQUEST, model: " " }],
    ["an id over 256 characters", { ...REQUEST, model: "m".repeat(257) }],
    ["a null effort", { ...REQUEST, effort: null }],
    ["a timeout of zero", { ...REQUEST, timeoutMs: 0 }],
    ["a fractional timeout", { ...REQUEST, timeoutMs: 10.5 }],
    [
      "a timeout past the cap",
      { ...REQUEST, timeoutMs: EXECUTION_ONESHOT_TIMEOUT_MAX_MS + 1 },
    ],
  ])("refuses %s", (_case, body) => {
    expect(decodeExecutionOneShotRequest(JSON.stringify(body))).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("refuses a body that is not JSON, or not an object", () => {
    expect(decodeExecutionOneShotRequest("{")).toEqual({
      ok: false,
      reason: "malformed-json",
    });
    expect(decodeExecutionOneShotRequest("[]")).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("one-shot answers", () => {
  it("reads the text, ignoring fields it does not know", () => {
    expect(
      decodeExecutionOneShotResponse({ text: "Fix login", usage: {} }),
    ).toEqual({ ok: true, value: { text: "Fix login" } });
    expect(decodeExecutionOneShotResponse({ text: "" })).toEqual({
      ok: true,
      value: { text: "" },
    });
  });

  it("takes text at the cap, and refuses it past", () => {
    const atCap = "y".repeat(EXECUTION_ONESHOT_TEXT_MAX_LENGTH);
    expect(decodeExecutionOneShotResponse({ text: atCap }).ok).toBe(true);
    expect(decodeExecutionOneShotResponse({ text: `${atCap}y` }).ok).toBe(
      false,
    );
  });

  it.each([null, "Fix login", [], {}, { text: null }, { text: 7 }])(
    "refuses %j",
    (raw) => {
      expect(decodeExecutionOneShotResponse(raw)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    },
  );
});

describe("one-shot refusals", () => {
  it.each(EXECUTION_ONESHOT_REFUSAL_CODES)("reads code %s", (code) => {
    expect(
      decodeExecutionOneShotRefusal({ error: "No", code, retry: true }),
    ).toEqual({ ok: true, value: { error: "No", code } });
  });

  it("names exactly the codes a host may send", () => {
    expect([...EXECUTION_ONESHOT_REFUSAL_CODES]).toEqual([
      "provider-unknown",
      "provider-unavailable",
      "busy",
      "timed-out",
      "failed",
    ]);
  });

  it.each([
    { error: "No" },
    { error: "No", code: "melted" },
    { code: "busy" },
    { error: 5, code: "busy" },
    "busy",
    null,
  ])("refuses %j", (raw) => {
    expect(decodeExecutionOneShotRefusal(raw).ok).toBe(false);
  });
});
