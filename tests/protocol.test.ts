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
    const mutablePatch: ExecutionConversationItemPatch = {
      text: "updated",
      delivery: "delivered",
    };
    // @ts-expect-error Item ids are immutable after conversation.item.add.
    const idPatch: ExecutionConversationItemPatch = { id: "replacement" };
    // @ts-expect-error Item kinds are immutable after conversation.item.add.
    const kindPatch: ExecutionConversationItemPatch = { kind: "tool-call" };
    const attachmentsPatch: ExecutionConversationItemPatch = {
      // @ts-expect-error Attachment identity is immutable after item creation.
      attachments: [],
    };

    expect(mutablePatch).toEqual({
      text: "updated",
      delivery: "delivered",
    });
    void idPatch;
    void kindPatch;
    void attachmentsPatch;
  });

  it("keeps valid message delivery state and drops invalid optional values", () => {
    const envelope = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      seq: 1,
      event: {
        kind: "delta",
        delta: {
          kind: "conversation.item.add",
          item: {
            ...conversationItemFixtures.message.value,
            actor: "user",
            delivery: "queued",
          },
        },
      },
    };

    expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
      ok: true,
      value: envelope,
    });

    const invalid = structuredClone(envelope);
    invalid.event.delta.item.delivery = "lost";
    const decoded = decodeExecutionEventEnvelope(JSON.stringify(invalid));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.event).toMatchObject({
      kind: "delta",
      delta: {
        kind: "conversation.item.add",
        item: expect.not.objectContaining({ delivery: expect.anything() }),
      },
    });
    expect(decoded.warnings).toEqual([
      {
        reason: "dropped-invalid-field",
        path: "event.delta.item.delivery",
      },
    ]);
  });

  it("keeps valid attachment metadata and drops malformed optional entries", () => {
    const envelope = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      seq: 1,
      event: {
        kind: "delta",
        delta: {
          kind: "conversation.item.add",
          item: {
            ...conversationItemFixtures.message.value,
            attachments: [
              conversationItemFixtures.message.value.attachments[0],
              { id: "bad", name: "broken.png", mimeType: "image/png" },
            ],
          },
        },
      },
    };

    expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
      ok: true,
      value: {
        ...envelope,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.add",
            item: conversationItemFixtures.message.value,
          },
        },
      },
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "event.delta.item.attachments.1",
        },
      ],
    });
  });

  it("decodes additive turn lifecycle and file-change deltas", () => {
    const turn = {
      id: "turn-1",
      sessionId: "session-1",
      sequence: 1,
      startedAt: "2026-07-15T19:00:00.000Z",
      endedAt: null,
      status: "running",
      summary: null,
    } as const;
    const fileChange = {
      id: "change-1",
      sessionId: "session-1",
      turnId: "turn-1",
      filePath: "src/index.ts",
      oldPath: null,
      status: "modified",
      additions: 2,
      deletions: 1,
      diff: "@@ -1 +1,2 @@",
      truncated: false,
      binary: false,
      createdAt: "2026-07-15T19:01:00.000Z",
    } as const;
    const deltas = [
      { kind: "turn.add", turn },
      {
        kind: "turn.patch",
        turnId: "turn-1",
        patch: {
          endedAt: "2026-07-15T19:01:00.000Z",
          status: "completed",
          summary: "Updated the entry point",
        },
      },
      {
        kind: "turn.fileChanges.add",
        turnId: "turn-1",
        fileChanges: [fileChange],
      },
    ];

    for (const [index, delta] of deltas.entries()) {
      expect(
        decodeExecutionEventEnvelope(
          JSON.stringify({
            protocolVersion: 1,
            sessionId: "session-1",
            seq: index + 1,
            event: { kind: "delta", delta },
          }),
        ),
      ).toMatchObject({ ok: true, value: { event: { delta } } });
    }
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
      inlineAttachments: [
        {
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataBase64: "AQID",
        },
      ],
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

  it("rejects malformed inline image attachments", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          ...envelope,
          command: {
            kind: "send-message",
            text: "hello",
            inlineAttachments: [
              {
                kind: "image",
                name: "diagram.png",
                mimeType: "image/png",
                sizeBytes: "3",
                dataBase64: "AQID",
              },
            ],
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
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
      permissionConfig: { preset: "yolo" },
      automationMode: false,
      inlineAttachments: [
        {
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataBase64: "AQID",
        },
      ],
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

  it("rejects malformed permission policies without weakening legacy requests", () => {
    expect(
      decodeExecutionStartRequest(
        JSON.stringify({
          ...request,
          config: {
            ...request.config,
            permissionConfig: {
              preset: "custom",
              codex: {
                approvalPolicy: "always",
                sandbox: "danger-full-access",
              },
            },
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });

    const legacy = {
      ...request,
      config: { ...request.config, permissionConfig: undefined },
    };
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(legacy)),
    ).toEqual({ ok: true, value: legacy });
  });
});
