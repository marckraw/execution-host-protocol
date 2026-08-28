import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  decodeExecutionCommandEnvelope,
  decodeExecutionEnvironmentDeclaration,
  decodeExecutionEnvironmentListResponse,
  decodeExecutionEventEnvelope,
  decodeExecutionProjectListResponse,
  decodeExecutionProtocolDescriptor,
  decodeExecutionSessionWorkspace,
  encodeExecutionSessionWorkspace,
  decodeExecutionRoomChristenRequest,
  decodeExecutionRoomChristenResponse,
  decodeExecutionRoomListResponse,
  decodeExecutionStartRequest,
  encodeExecutionCommandEnvelope,
  encodeExecutionEventEnvelope,
  encodeExecutionStartRequest,
  normalizeOriginKey,
  type ExecutionHostCommandEnvelope,
  type ExecutionConversationItemPatch,
  type ExecutionResearchEvidencePack,
  type ExecutionStartRequest,
} from "../src/index.js";
import {
  commandFixtures,
  conversationItemFixtures,
  environmentDeclarationFixture,
  environmentDeclarationWithValuesFixture,
  environmentListFixture,
  eventFixtures,
  legacyProjectListFixture,
  legacySessionWorkspaceFixture,
  projectListFixture,
  roomChristenPendingFixture,
  sessionWorkspaceFixtures,
  startRequestWithEnvironmentFixture,
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

const researchEvidence: ExecutionResearchEvidencePack = {
  capturedAt: "2026-07-20T20:00:00.000Z",
  question: "Where did we settle deployment?",
  coverage: {
    selectedEndpointCount: 3,
    searchedEndpointCount: 2,
    candidatePassageCount: 7,
    failedEndpointIds: ["offline"],
    indexingEndpointIds: [],
  },
  sources: [
    {
      sourceId: "S1",
      endpointId: "little-monster",
      endpointName: "little-monster",
      sessionId: "session-source",
      itemId: "item-source",
      sessionTitle: "Docker deployment",
      providerId: "claude",
      createdAt: "2026-07-19T18:00:00.000Z",
      text: "Remote daemons use the canonical Docker deployment.",
    },
  ],
};

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

  it("carries a negotiated text increment through decode (MAR-2218b)", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { textAppend: " and then some" },
          },
        },
      }),
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { textAppend: " and then some" },
          },
        },
      },
    });
  });

  it("drops a text increment that is not a string, keeping its siblings", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { textAppend: 42, state: "streaming" },
          },
        },
      }),
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { state: "streaming" },
          },
        },
      },
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "event.delta.patch.textAppend",
        },
      ],
    });
  });

  it("still accepts a full-text patch unchanged — increments are opt-in", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "item-1",
            patch: { text: "the whole reply so far", state: "streaming" },
          },
        },
      }),
    );

    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.value.event).toEqual({
      kind: "delta",
      delta: {
        kind: "conversation.item.patch",
        itemId: "item-1",
        patch: { text: "the whole reply so far", state: "streaming" },
      },
    });
  });

  it("accepts textAppend on the public patch type", () => {
    const appendPatch: ExecutionConversationItemPatch = {
      textAppend: " more",
    };
    // An item never *holds* a textAppend, so it must not become an item field.
    expect(appendPatch).toEqual({ textAppend: " more" });
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

  it("keeps the additive cancelled message delivery state", () => {
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
            delivery: "cancelled",
          },
        },
      },
    };

    expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
      ok: true,
      value: envelope,
    });
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
      repoRoot: "packages/worker",
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

  it("keeps multi-repo file changes compatible with the legacy known-fields reader", () => {
    const recordedEnvelope = JSON.stringify({
      protocolVersion: 1,
      sessionId: "session-multi-repo",
      seq: 12,
      event: {
        kind: "delta",
        delta: {
          kind: "turn.fileChanges.add",
          turnId: "turn-1",
          fileChanges: [
            {
              id: "change-1",
              sessionId: "session-multi-repo",
              turnId: "turn-1",
              repoRoot: "cloned-repo",
              filePath: "README.md",
              oldPath: null,
              status: "modified",
              additions: 1,
              deletions: 1,
              diff: "@@ -1 +1 @@\n-before\n+after",
              truncated: false,
              binary: false,
              createdAt: "2026-07-17T10:00:00.000Z",
            },
          ],
        },
      },
    });

    expect(decodeExecutionEventEnvelope(recordedEnvelope)).toMatchObject({
      ok: true,
      value: {
        event: {
          delta: {
            fileChanges: [{ repoRoot: "cloned-repo", filePath: "README.md" }],
          },
        },
      },
    });

    const legacyReader = JSON.parse(recordedEnvelope) as {
      event: { delta: { fileChanges: Array<Record<string, unknown>> } };
    };
    const legacyKnownFields = legacyReader.event.delta.fileChanges.map(
      ({
        id,
        sessionId,
        turnId,
        filePath,
        oldPath,
        status,
        additions,
        deletions,
        diff,
        truncated,
        binary,
        createdAt,
      }) => ({
        id,
        sessionId,
        turnId,
        filePath,
        oldPath,
        status,
        additions,
        deletions,
        diff,
        truncated,
        binary,
        createdAt,
      }),
    );
    expect(legacyKnownFields).toEqual([
      expect.objectContaining({ filePath: "README.md", status: "modified" }),
    ]);
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

  it("exports the structured-interaction and queued-cancellation capability ids", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "interactions.structured",
    );
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "commands.cancelQueued",
    );
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("rooms.v1");
  });
});

describe("Room v1", () => {
  it("decodes christening and room directory payloads defensively", () => {
    expect(
      decodeExecutionRoomChristenRequest(
        JSON.stringify({ name: "Project Hearth", sessionId: "session-1" }),
      ),
    ).toEqual({
      ok: true,
      value: { name: "Project Hearth", sessionId: "session-1" },
    });
    expect(
      decodeExecutionRoomListResponse({
        protocolVersion: 1,
        rooms: [
          {
            id: "room-1",
            name: "Project Hearth",
            createdAt: "2026-07-17T11:00:00.000Z",
            lastActiveAt: "2026-07-17T11:30:00.000Z",
            sessionCount: 2,
            futureField: true,
          },
        ],
        futureField: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        rooms: [
          {
            id: "room-1",
            name: "Project Hearth",
            createdAt: "2026-07-17T11:00:00.000Z",
            lastActiveAt: "2026-07-17T11:30:00.000Z",
            sessionCount: 2,
          },
        ],
      },
    });
    expect(
      decodeExecutionRoomChristenRequest(
        JSON.stringify({ name: "", sessionId: "session-1" }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
    expect(
      decodeExecutionRoomListResponse({
        protocolVersion: 1,
        rooms: [{ id: "room-1", name: "bad" }],
      }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("round-trips roomId while a legacy known-fields reader ignores it", () => {
    const request: ExecutionStartRequest = {
      protocolVersion: 1,
      providerId: "codex",
      config: {
        sessionId: "session-room",
        initialMessage: "Where were we?",
        model: "gpt-5.5",
        effort: "low",
        continuationToken: null,
        roomId: "room-1",
      },
    };
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(request)),
    ).toEqual({ ok: true, value: request });

    const rawPatch = JSON.stringify({
      protocolVersion: 1,
      sessionId: "session-room",
      seq: 3,
      event: {
        kind: "delta",
        delta: {
          kind: "session.patch",
          patch: { roomId: "room-1", updatedAt: "2026-07-17T11:30:00.000Z" },
        },
      },
    });
    expect(decodeExecutionEventEnvelope(rawPatch)).toMatchObject({
      ok: true,
      value: { event: { delta: { patch: { roomId: "room-1" } } } },
    });
    const legacyPatch = (
      JSON.parse(rawPatch) as {
        event: { delta: { patch: Record<string, unknown> } };
      }
    ).event.delta.patch;
    expect({ updatedAt: legacyPatch.updatedAt }).toEqual({
      updatedAt: "2026-07-17T11:30:00.000Z",
    });
  });

  it("decodes asynchronous Room founding while retaining synchronous responses", () => {
    const baseRoom = {
      id: "room-1",
      name: "Project Hearth",
      createdAt: "2026-07-17T13:00:00.000Z",
      lastActiveAt: "2026-07-17T13:00:00.000Z",
      sessionCount: 1,
    };
    expect(
      decodeExecutionRoomChristenResponse(roomChristenPendingFixture.value),
    ).toMatchObject({
      ok: true,
      value: { founding: "pending", room: { founding: "pending" } },
    });
    expect(
      decodeExecutionRoomChristenResponse({
        protocolVersion: 1,
        room: baseRoom,
        foundingMemoryEntryCount: 1,
      }),
    ).toMatchObject({ ok: true, value: { foundingMemoryEntryCount: 1 } });
  });

  it("rejects malformed Room founding fields without breaking legacy room lists", () => {
    const baseRoom = {
      id: "room-1",
      name: "Project Hearth",
      createdAt: "2026-07-17T13:00:00.000Z",
      lastActiveAt: "2026-07-17T13:00:00.000Z",
      sessionCount: 1,
    };
    expect(
      decodeExecutionRoomListResponse({
        protocolVersion: 1,
        rooms: [{ ...baseRoom, founding: "forgotten" }],
      }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
    expect(
      decodeExecutionRoomListResponse({
        protocolVersion: 1,
        rooms: [baseRoom],
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects invalid room identifiers", () => {
    expect(
      decodeExecutionStartRequest(
        JSON.stringify({
          protocolVersion: 1,
          providerId: "codex",
          config: {
            sessionId: "session-room",
            initialMessage: "hello",
            model: null,
            effort: null,
            continuationToken: null,
            roomId: "",
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

describe("structured interactions", () => {
  it("round-trips choice requests and responses", () => {
    const event = {
      ...eventFixtures.delta,
      event: {
        kind: "delta" as const,
        delta: {
          kind: "conversation.item.add" as const,
          item: conversationItemFixtures["input-request"].value,
        },
      },
    };
    expect(decodeExecutionEventEnvelope(JSON.stringify(event))).toEqual({
      ok: true,
      value: event,
    });
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify(commandFixtures["send-message"]),
      ),
    ).toEqual({ ok: true, value: commandFixtures["send-message"] });
  });

  it("decodes plan, text, form, and URL request shapes", () => {
    const requests = [
      { kind: "text", prompt: "Explain the constraint" },
      {
        kind: "plan",
        plan: "1. Inspect\n2. Change",
        allowedPrompts: ["Proceed"],
      },
      {
        kind: "form",
        title: "Deploy",
        message: "Configure the target",
        fields: [
          { id: "replicas", label: "Replicas", type: "number", required: true },
        ],
      },
      {
        kind: "url",
        title: "Authorize",
        message: "Open the provider",
        url: "https://example.test/authorize",
      },
    ];
    for (const request of requests) {
      const item = {
        ...conversationItemFixtures["input-request"].value,
        request,
      };
      const decoded = decodeExecutionEventEnvelope(
        JSON.stringify({
          ...eventFixtures.delta,
          event: {
            kind: "delta",
            delta: { kind: "conversation.item.add", item },
          },
        }),
      );
      expect(decoded).toMatchObject({ ok: true });
      if (decoded.ok) {
        expect(
          decoded.value.event.kind === "delta" &&
            decoded.value.event.delta.kind === "conversation.item.add"
            ? decoded.value.event.delta.item
            : null,
        ).toMatchObject({ request });
      }
    }
  });

  it("drops unknown or malformed request payloads without losing the prompt", () => {
    for (const request of [
      { kind: "future", payload: true },
      { kind: "choice", questions: [{ id: "missing-fields" }] },
    ]) {
      const decoded = decodeExecutionEventEnvelope(
        JSON.stringify({
          ...eventFixtures.delta,
          event: {
            kind: "delta",
            delta: {
              kind: "conversation.item.add",
              item: {
                ...conversationItemFixtures["input-request"].value,
                request,
              },
            },
          },
        }),
      );
      expect(decoded).toMatchObject({
        ok: true,
        warnings: [
          {
            reason: "dropped-invalid-field",
            path: "event.delta.item.request",
          },
        ],
      });
      if (decoded.ok && decoded.value.event.kind === "delta") {
        expect(decoded.value.event.delta).toMatchObject({
          item: { kind: "input-request", prompt: "Choose a target" },
        });
        expect(
          "item" in decoded.value.event.delta
            ? decoded.value.event.delta.item
            : {},
        ).not.toHaveProperty("request");
      }
    }
  });

  it("rejects malformed structured responses", () => {
    const malformed = {
      ...commandFixtures["send-message"],
      command: {
        ...commandFixtures["send-message"].command,
        options: {
          deliveryMode: "answer",
          interactionResponse: {
            kind: "choice",
            answers: [{ questionId: "target", values: "Local" }],
          },
        },
      },
    };
    expect(decodeExecutionCommandEnvelope(JSON.stringify(malformed))).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("session.patch PR URL", () => {
  it("accepts additive HTTP(S) PR URLs", () => {
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          protocolVersion: 1,
          sessionId: "session-1",
          seq: 7,
          event: {
            kind: "delta",
            delta: {
              kind: "session.patch",
              patch: { prUrl: "https://github.com/acme/repo/pull/7" },
            },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 7,
        event: {
          kind: "delta",
          delta: {
            kind: "session.patch",
            patch: { prUrl: "https://github.com/acme/repo/pull/7" },
          },
        },
      },
    });
  });

  it("accepts null and rejects non-HTTP(S) schemes", () => {
    const envelope = (prUrl: unknown) =>
      JSON.stringify({
        protocolVersion: 1,
        sessionId: "session-1",
        seq: 8,
        event: {
          kind: "delta",
          delta: { kind: "session.patch", patch: { prUrl } },
        },
      });

    expect(decodeExecutionEventEnvelope(envelope(null))).toMatchObject({
      ok: true,
    });
    expect(
      decodeExecutionEventEnvelope(envelope("javascript:alert(1)")),
    ).toEqual({ ok: false, reason: "invalid-payload" });
    expect(decodeExecutionEventEnvelope(envelope("not a URL"))).toEqual({
      ok: false,
      reason: "invalid-payload",
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
      researchEvidence,
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

  it("rejects a cancel-queued command without an item identity", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sessionId: "session-1",
          command: { kind: "cancel-queued", itemId: "" },
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
      researchEvidence,
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

  it("rejects oversized and duplicate research evidence", () => {
    const decode = (evidence: unknown) =>
      decodeExecutionStartRequest(
        JSON.stringify({
          ...request,
          config: { ...request.config, researchEvidence: evidence },
        }),
      );
    expect(
      decode({
        ...researchEvidence,
        sources: [researchEvidence.sources[0], researchEvidence.sources[0]],
      }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
    expect(
      decode({ ...researchEvidence, question: "q".repeat(4_001) }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
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

// ---------------------------------------------------------------------------
// ADR-0011 — the work address, the environments contract, project origin.
// ---------------------------------------------------------------------------

describe("the work address on a start request (ADR-0011 §2)", () => {
  it("carries an environment name", () => {
    const decoded = decodeExecutionStartRequest(
      encodeExecutionStartRequest(startRequestWithEnvironmentFixture.value),
    );

    expect(decoded).toMatchObject({
      ok: true,
      value: { environment: "new-blok/staging" },
    });
  });

  it("keeps a 0.13 request byte-identical through a round trip", () => {
    const raw = JSON.stringify({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      providerId: "claude",
      config: {
        sessionId: "session-1",
        initialMessage: "hello",
        model: null,
        effort: null,
        continuationToken: null,
      },
    });
    const decoded = decodeExecutionStartRequest(raw);
    if (!decoded.ok) throw new Error(decoded.reason);

    expect("environment" in decoded.value).toBe(false);
    expect(encodeExecutionStartRequest(decoded.value)).toBe(raw);
  });

  it("keeps an explicitly naked request", () => {
    const decoded = decodeExecutionStartRequest(
      JSON.stringify({
        ...startRequestWithEnvironmentFixture.value,
        environment: null,
      }),
    );

    expect(decoded).toMatchObject({ ok: true, value: { environment: null } });
  });

  it("refuses an environment it cannot read rather than running naked", () => {
    for (const environment of [42, "", {}, ["a"], true]) {
      expect(
        decodeExecutionStartRequest(
          JSON.stringify({
            ...startRequestWithEnvironmentFixture.value,
            environment,
          }),
        ),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });
});

describe("the echoed work address (ADR-0011 §2)", () => {
  it("round-trips both modes", () => {
    for (const fixture of Object.values(sessionWorkspaceFixtures)) {
      const decoded = decodeExecutionSessionWorkspace(
        JSON.parse(encodeExecutionSessionWorkspace(fixture.value)),
      );

      expect(decoded).toEqual({ ok: true, value: fixture.value });
    }
  });

  it("reads a pre-ADR-0011 echo as a repository address", () => {
    const decoded = decodeExecutionSessionWorkspace(
      legacySessionWorkspaceFixture.value,
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        mode: "repository",
        repository: "marckraw/emergence",
        branchName: "agent/errand-0",
        baseRef: "master",
        workspacePath: null,
        environment: null,
      },
    });
  });

  it("re-encodes a legacy echo with its mode made explicit", () => {
    const decoded = decodeExecutionSessionWorkspace(
      legacySessionWorkspaceFixture.value,
    );
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(
      JSON.parse(encodeExecutionSessionWorkspace(decoded.value)),
    ).toMatchObject({ mode: "repository" });
  });

  it("reports a project address whose HEAD is not what was asked for", () => {
    const decoded = decodeExecutionSessionWorkspace(
      sessionWorkspaceFixtures.project.value,
    );
    if (!decoded.ok) throw new Error(decoded.reason);
    if (decoded.value.mode !== "project") throw new Error("expected project");

    expect(decoded.value.branchName).toBe("master");
    expect(decoded.value.requestedBranchName).toBe("feature/banner");
  });

  it("refuses a mode it does not know", () => {
    expect(
      decodeExecutionSessionWorkspace({ mode: "sublet", repository: "a/b" }),
    ).toEqual({ ok: false, reason: "unknown-kind" });
  });
});

describe("projects carry their origin (ADR-0011 §4)", () => {
  it("decodes an enriched project list", () => {
    const decoded = decodeExecutionProjectListResponse(
      projectListFixture.value,
    );

    expect(decoded).toEqual({ ok: true, value: projectListFixture.value });
  });

  it("reads a pre-projects.v2 host as knowing nothing, never as claiming nothing exists wrongly", () => {
    const decoded = decodeExecutionProjectListResponse(
      legacyProjectListFixture.value,
    );

    expect(decoded).toEqual({
      ok: true,
      value: {
        projects: [
          {
            id: "new-blok",
            name: "new-blok",
            workingDirectory: "/srv/projects/new-blok",
            origin: null,
            originKey: null,
            environments: [],
          },
        ],
      },
    });
  });

  it("matches a local checkout to an advertised project by key", () => {
    const decoded = decodeExecutionProjectListResponse(
      projectListFixture.value,
    );
    if (!decoded.ok) throw new Error(decoded.reason);

    const localRemote = "git@github.com:MarcKraw/new-blok.git";
    const match = decoded.value.projects.find(
      (project) => project.originKey === normalizeOriginKey(localRemote),
    );

    expect(match?.id).toBe("new-blok");
  });

  it("refuses a project whose environment reference smuggles values", () => {
    expect(
      decodeExecutionProjectListResponse({
        projects: [
          {
            id: "new-blok",
            name: "new-blok",
            workingDirectory: "/srv/projects/new-blok",
            environments: [
              {
                name: "new-blok/staging",
                default: true,
                provisioned: true,
                missing: [],
                values: {},
              },
            ],
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

describe("the environments contract (ADR-0011 §5)", () => {
  it("decodes a catalog of declarations and their provisioned state", () => {
    const decoded = decodeExecutionEnvironmentListResponse(
      environmentListFixture.value,
    );

    expect(decoded).toEqual({ ok: true, value: environmentListFixture.value });
  });

  it("names what is missing without naming what is present", () => {
    const decoded = decodeExecutionEnvironmentListResponse(
      environmentListFixture.value,
    );
    if (!decoded.ok) throw new Error(decoded.reason);
    const staging = decoded.value.environments.find(
      (environment) => environment.name === "new-blok/staging",
    );

    expect(staging).toMatchObject({
      provisioned: false,
      missing: ["STORYBLOK_TOKEN"],
      includes: ["shared/storyblok"],
    });
  });

  it("decodes a declaration", () => {
    expect(
      decodeExecutionEnvironmentDeclaration(
        JSON.stringify(environmentDeclarationFixture.value),
      ),
    ).toEqual({ ok: true, value: environmentDeclarationFixture.value });
  });

  it("rejects a declaration carrying values, however empty", () => {
    expect(
      decodeExecutionEnvironmentDeclaration(
        JSON.stringify(environmentDeclarationWithValuesFixture.value),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("rejects a values field whatever it holds — presence is the offence", () => {
    for (const values of [null, {}, [], "", "anything"]) {
      expect(
        decodeExecutionEnvironmentDeclaration(
          JSON.stringify({ keys: ["A_NAME"], values }),
        ),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("rejects a listed environment carrying values", () => {
    expect(
      decodeExecutionEnvironmentListResponse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        environments: [
          {
            name: "new-blok/staging",
            keys: ["STORYBLOK_TOKEN"],
            provisioned: true,
            missing: [],
            values: {},
          },
        ],
      }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});
