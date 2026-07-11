import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionCommandEnvelope,
  decodeExecutionEventEnvelope,
  decodeExecutionProtocolDescriptor,
  decodeExecutionStartRequest,
  encodeExecutionCommandEnvelope,
  encodeExecutionEventEnvelope,
  encodeExecutionStartRequest,
  type ExecutionHostCommandEnvelope,
  type ExecutionStartRequest,
} from "../src/index.js";

const rawSse = readFileSync(
  join(import.meta.dirname, "fixtures/raw-sse-claude-session.txt"),
  "utf8",
);
const recordedEnvelopes = rawSse
  .replace(/\r\n/g, "\n")
  .split("\n\n")
  .flatMap((block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return data ? [data] : [];
  });

describe("recorded daemon event contract", () => {
  it("decodes all recorded Emergence envelopes verbatim", () => {
    expect(recordedEnvelopes).toHaveLength(17);
    for (const raw of recordedEnvelopes) {
      const decoded = decodeExecutionEventEnvelope(raw);
      expect(decoded).toMatchObject({ ok: true });
      if (!decoded.ok) continue;
      expect(
        decodeExecutionEventEnvelope(
          encodeExecutionEventEnvelope(decoded.value),
        ),
      ).toEqual(decoded);
    }
  });

  it("ignores additive unknown fields while preserving known data", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 1,
        futureEnvelopeField: true,
        event: { kind: "heartbeat", futureEventField: true },
      }),
    );
    expect(decoded).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 1,
        event: { kind: "heartbeat" },
      },
    });
  });

  it("rejects malformed, unsupported, and structurally invalid envelopes", () => {
    expect(decodeExecutionEventEnvelope("{")).toEqual({
      ok: false,
      reason: "malformed-json",
    });
    expect(
      decodeExecutionEventEnvelope(JSON.stringify({ protocolVersion: 99 })),
    ).toEqual({ ok: false, reason: "unsupported-protocol-version" });
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          protocolVersion: 1,
          sessionId: "s",
          seq: 0,
          event: { kind: "heartbeat" },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
  });
});

describe("capability negotiation", () => {
  it("accepts additive unknown capability ids without rejecting the descriptor", () => {
    expect(
      decodeExecutionProtocolDescriptor({
        version: 1,
        capabilities: ["events.replay", "future.capability"],
        futureField: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        version: 1,
        capabilities: ["events.replay", "future.capability"],
      },
    });
  });
});

describe("command contract", () => {
  const envelope: ExecutionHostCommandEnvelope = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    command: {
      kind: "send-message",
      text: "hello",
      attachments: [{ path: "image.png" }],
      options: {
        deliveryMode: "follow-up",
        metadata: { source: { surface: "emergence" } },
      },
    },
  };

  it("round-trips the current command shape", () => {
    expect(
      decodeExecutionCommandEnvelope(encodeExecutionCommandEnvelope(envelope)),
    ).toEqual({ ok: true, value: envelope });
  });

  it("ignores unknown fields and rejects invalid known fields", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({ ...envelope, future: true }),
      ),
    ).toEqual({ ok: true, value: envelope });
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          ...envelope,
          command: { kind: "send-message", text: 42 },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

describe("start request contract", () => {
  const request: ExecutionStartRequest = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId: "claude",
    config: {
      sessionId: "session-1",
      initialMessage: "hello",
      model: null,
      effort: null,
      continuationToken: null,
      automationMode: false,
    },
    metadata: { source: { surface: "slack", id: "event-1" } },
    workspace: { repository: "owner/repo", ref: "main" },
    callback: {
      url: "https://example.test/callback",
      secret: "fixture-secret",
    },
    automation: { autoCreatePr: true },
  };

  it("round-trips the current daemon-compatible request", () => {
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(request)),
    ).toEqual({ ok: true, value: request });
  });
});
