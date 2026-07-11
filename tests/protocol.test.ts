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
  type ExecutionConversationItemPatch,
  type ExecutionStartRequest,
} from "../src/index.js";
import {
  commandFixtures,
  conversationItemFixtures,
  eventFixtures,
} from "./fixtures/contract-fixtures.js";

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

  it.each([
    ["state", 42],
    ["createdAt", 42],
    ["updatedAt", 42],
    ["providerMeta", { providerId: 42 }],
    ["actor", "system"],
    ["text", 42],
    ["toolName", 42],
    ["inputText", 42],
    ["relatedItemId", 42],
    ["outputText", 42],
    ["description", 42],
    ["prompt", 42],
    ["level", "debug"],
  ])(
    "drops an invalid %s patch value while retaining valid siblings",
    (field, invalidValue) => {
      const validSibling = field === "updatedAt" ? "description" : "updatedAt";
      const validValue =
        validSibling === "updatedAt" ? "2026-07-11T20:00:00.000Z" : "valid";
      const decoded = decodeExecutionEventEnvelope(
        JSON.stringify({
          protocolVersion: 1,
          sessionId: "session-1",
          seq: 1,
          event: {
            kind: "delta",
            delta: {
              kind: "conversation.item.patch",
              itemId: "item-1",
              patch: {
                [field]: invalidValue,
                [validSibling]: validValue,
                futureField: true,
              },
            },
          },
        }),
      );

      expect(decoded).toEqual({
        ok: true,
        value: {
          protocolVersion: 1,
          sessionId: "session-1",
          seq: 1,
          event: {
            kind: "delta",
            delta: {
              kind: "conversation.item.patch",
              itemId: "item-1",
              patch: { [validSibling]: validValue },
            },
          },
        },
        warnings: [
          {
            reason: "dropped-invalid-field",
            path: `event.delta.patch.${field}`,
          },
        ],
      });
    },
  );

  it("ignores immutable item fields while retaining mutable siblings", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 1,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: {
              id: "replacement-item",
              kind: "tool-call",
              text: "valid sibling",
            },
          },
        },
      }),
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 1,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { text: "valid sibling" },
          },
        },
      },
    });
  });

  it("excludes item identity fields from the public patch type", () => {
    const mutablePatch: ExecutionConversationItemPatch = { text: "updated" };
    // @ts-expect-error Item ids are immutable after conversation.item.add.
    const idPatch: ExecutionConversationItemPatch = { id: "replacement" };
    // @ts-expect-error Item kinds are immutable after conversation.item.add.
    const kindPatch: ExecutionConversationItemPatch = { kind: "tool-call" };

    expect(mutablePatch).toEqual({ text: "updated" });
    void idPatch;
    void kindPatch;
  });
});

describe("exhaustive contract fixtures", () => {
  it.each(Object.entries(conversationItemFixtures))(
    "round-trips the %s conversation item decoder",
    (_kind, fixture) => {
      const envelope = {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "fixture-session",
        seq: 1,
        event: {
          kind: "delta" as const,
          delta: {
            kind: "conversation.item.add" as const,
            item: fixture.value,
          },
        },
      };
      expect(
        decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(envelope)),
      ).toEqual({ ok: true, value: envelope });
      expect(["recorded", "hand-authored"]).toContain(fixture.source);
    },
  );

  it.each(Object.entries(eventFixtures))(
    "round-trips the %s event decoder",
    (_kind, envelope) => {
      expect(
        decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(envelope)),
      ).toEqual({ ok: true, value: envelope });
    },
  );

  it.each(Object.entries(commandFixtures))(
    "round-trips the %s command decoder",
    (_kind, envelope) => {
      expect(
        decodeExecutionCommandEnvelope(
          encodeExecutionCommandEnvelope(envelope),
        ),
      ).toEqual({ ok: true, value: envelope });
    },
  );

  it("classifies malformed and future event kinds without throwing", () => {
    expect(decodeExecutionEventEnvelope("{")).toEqual({
      ok: false,
      reason: "malformed-json",
    });
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          protocolVersion: 1,
          sessionId: "session-1",
          seq: 1,
          event: { kind: "future-event" },
        }),
      ),
    ).toEqual({ ok: false, reason: "unknown-kind" });
  });

  it("rejects bad sequence numbers and invalid conversation item states", () => {
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({ ...eventFixtures.heartbeat, seq: 0 }),
      ),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          ...eventFixtures.delta,
          event: {
            kind: "delta",
            delta: {
              kind: "conversation.item.add",
              item: {
                ...conversationItemFixtures.message.value,
                state: "future-state",
              },
            },
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("rejects invalid known command, start, and descriptor fields", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          ...commandFixtures.approve,
          command: { kind: "approve", providerApprovalId: 42 },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
    expect(
      decodeExecutionStartRequest(
        JSON.stringify({
          protocolVersion: 1,
          providerId: "codex",
          config: { initialMessage: "missing session id" },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
    expect(
      decodeExecutionProtocolDescriptor({ version: 1, capabilities: [42] }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
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
