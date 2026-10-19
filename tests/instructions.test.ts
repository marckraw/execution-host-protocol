import { describe, expect, it } from "vitest";
import {
  decodeExecutionStartRequest,
  encodeExecutionStartRequest,
  EXECUTION_INSTRUCTIONS_MAX_BYTES,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
} from "../src/index.js";
import { startRequestWithEnvironmentFixture } from "./fixtures/contract-fixtures.js";

const base = startRequestWithEnvironmentFixture.value;
const request = (instructions: unknown) => ({
  ...base,
  config: { ...base.config, instructions },
});

describe("session instructions (MAR-4364)", () => {
  it("advertises the capability id and round-trips exact text, including an empty frame", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "start.instructions.v1",
    );
    for (const instructions of [
      "",
      "You are a patient tutor.\nKeep user messages verbatim.",
      "é".repeat(EXECUTION_INSTRUCTIONS_MAX_BYTES / 2),
    ]) {
      const value = request(instructions) as typeof base;
      expect(
        decodeExecutionStartRequest(encodeExecutionStartRequest(value)),
      ).toMatchObject({ ok: true, value });
    }
  });

  it.each([
    null,
    42,
    {},
    [],
    "a".repeat(EXECUTION_INSTRUCTIONS_MAX_BYTES + 1),
    "é".repeat(EXECUTION_INSTRUCTIONS_MAX_BYTES / 2 + 1),
  ])(
    "refuses malformed or oversized instructions without dropping them (%#)",
    (instructions) => {
      expect(
        decodeExecutionStartRequest(JSON.stringify(request(instructions))),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    },
  );

  it("leaves a start with no instructions unchanged", () => {
    const decoded = decodeExecutionStartRequest(JSON.stringify(base));
    expect(decoded).toMatchObject({ ok: true, value: base });
    expect(decoded.ok && decoded.value.config).not.toHaveProperty(
      "instructions",
    );
  });
});
