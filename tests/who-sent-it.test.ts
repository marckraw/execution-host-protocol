import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionCommandEnvelope,
  decodeExecutionEventEnvelope,
  decodeExecutionStartRequest,
  encodeExecutionCommandEnvelope,
  encodeExecutionEventEnvelope,
  encodeExecutionStartRequest,
  type ExecutionConversationItemPatch,
  type ExecutionHostEventEnvelope,
  type ExecutionStartRequest,
} from "../src/index.js";
import {
  agentActorFixture,
  attributedCommandFixtures,
  attributedUserMessageFixture,
  commandFixtures,
  personActorFixture,
} from "./fixtures/contract-fixtures.js";

/** Not every value is wrong in the same way; each must be refused alike. */
const UNREADABLE_ACTORS: Array<[string, unknown]> = [
  ["null", null],
  ["a bare name", "Piotr"],
  ["an unknown kind", { ...personActorFixture, kind: "robot" }],
  ["an empty id", { ...personActorFixture, id: "" }],
  ["a numeric id", { ...personActorFixture, id: 42 }],
  ["an id over 256 characters", { ...personActorFixture, id: "x".repeat(257) }],
  ["no display name", { kind: "person", id: "usr_piotr" }],
  ["an empty display name", { ...personActorFixture, displayName: "" }],
  [
    "a display name over 256 characters",
    { ...personActorFixture, displayName: "P".repeat(257) },
  ],
];

const UNREADABLE_COMMAND_IDS: Array<[string, unknown]> = [
  ["null", null],
  ["an empty string", ""],
  ["a number", 42],
  ["an object", { id: "command-1" }],
  ["over 256 characters", "c".repeat(257)],
];

const messageAdd = (item: unknown, seq = 3) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    seq,
    event: {
      kind: "delta",
      delta: { kind: "conversation.item.add", item },
    },
  });

describe("who sent a command (MAR-3633)", () => {
  it.each(Object.entries(attributedCommandFixtures))(
    "round-trips %s with its actor and command id",
    (_kind, envelope) => {
      expect(
        decodeExecutionCommandEnvelope(
          encodeExecutionCommandEnvelope(envelope),
        ),
      ).toEqual({ ok: true, value: envelope });
    },
  );

  it("carries a person or an agent", () => {
    for (const actor of [personActorFixture, agentActorFixture]) {
      const decoded = decodeExecutionCommandEnvelope(
        encodeExecutionCommandEnvelope({
          ...commandFixtures.stop,
          commandId: "command-stop",
          actor,
        }),
      );
      expect(decoded).toMatchObject({ ok: true, value: { actor } });
    }
  });

  it("decodes an envelope that names no sender byte-identically, as before", () => {
    for (const envelope of Object.values(commandFixtures)) {
      const raw = encodeExecutionCommandEnvelope(envelope);
      const decoded = decodeExecutionCommandEnvelope(raw);
      if (!decoded.ok) throw new Error(decoded.reason);

      expect("actor" in decoded.value).toBe(false);
      expect("commandId" in decoded.value).toBe(false);
      expect(encodeExecutionCommandEnvelope(decoded.value)).toBe(raw);
    }
  });

  it("leaves the command itself untouched for a reader that predates attribution", () => {
    const raw = encodeExecutionCommandEnvelope(
      attributedCommandFixtures["send-message"],
    );
    // A 0.14 host reads only the fields it knows; the new ones sit beside the
    // command, never inside it, so what it executes is unchanged.
    const legacy = JSON.parse(raw) as { sessionId: string; command: unknown };

    expect({ sessionId: legacy.sessionId, command: legacy.command }).toEqual({
      sessionId: commandFixtures["send-message"].sessionId,
      command: commandFixtures["send-message"].command,
    });
  });

  it.each(UNREADABLE_ACTORS)(
    "refuses an actor that is %s rather than recording the command as anonymous",
    (_case, actor) => {
      expect(
        decodeExecutionCommandEnvelope(
          JSON.stringify({ ...commandFixtures.interrupt, actor }),
        ),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    },
  );

  it.each(UNREADABLE_COMMAND_IDS)(
    "refuses a command id that is %s rather than dropping it",
    (_case, commandId) => {
      expect(
        decodeExecutionCommandEnvelope(
          JSON.stringify({ ...commandFixtures.approve, commandId }),
        ),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    },
  );

  it("ignores fields an actor does not define", () => {
    const decoded = decodeExecutionCommandEnvelope(
      JSON.stringify({
        ...commandFixtures.steer,
        actor: { ...personActorFixture, avatarUrl: "https://example.test/p" },
      }),
    );

    expect(decoded).toMatchObject({ ok: true });
    expect(decoded.ok && decoded.value.actor).toEqual(personActorFixture);
  });

  it("advertises attribution and its echo as capabilities", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toEqual(
      expect.arrayContaining([
        "commands.actor.v1",
        "items.author.v1",
        "deltas.append.v1",
      ]),
    );
  });
});

describe("who started a session (MAR-3633)", () => {
  const request: ExecutionStartRequest = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId: "claude",
    config: {
      sessionId: "session-1",
      initialMessage: "Ship the staging banner",
      model: null,
      effort: null,
      continuationToken: null,
    },
    commandId: "command-start",
    actor: personActorFixture,
  };

  it("round-trips the starter and the id its initial message echoes", () => {
    expect(
      decodeExecutionStartRequest(encodeExecutionStartRequest(request)),
    ).toEqual({ ok: true, value: request });
  });

  it("refuses an unreadable starter or start id", () => {
    for (const [, actor] of UNREADABLE_ACTORS) {
      expect(
        decodeExecutionStartRequest(JSON.stringify({ ...request, actor })),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
    for (const [, commandId] of UNREADABLE_COMMAND_IDS) {
      expect(
        decodeExecutionStartRequest(JSON.stringify({ ...request, commandId })),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });
});

describe("the author echo on a user message (MAR-3633)", () => {
  const envelope: ExecutionHostEventEnvelope = {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    seq: 3,
    event: {
      kind: "delta",
      delta: {
        kind: "conversation.item.add",
        item: attributedUserMessageFixture.value,
      },
    },
  };

  it("round-trips the author and the client message id", () => {
    expect(
      decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(envelope)),
    ).toEqual({ ok: true, value: envelope });
  });

  it("drops an unreadable author without losing the message", () => {
    const decoded = decodeExecutionEventEnvelope(
      messageAdd({
        ...attributedUserMessageFixture.value,
        author: { kind: "robot", id: "r2", displayName: "R2" },
      }),
    );
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.value.event).toMatchObject({
      delta: {
        item: {
          text: "Ship the staging banner",
          clientMessageId: "command-1",
        },
      },
    });
    expect(decoded.value.event).not.toMatchObject({
      delta: { item: { author: expect.anything() } },
    });
    expect(decoded.warnings).toEqual([
      { reason: "dropped-invalid-field", path: "event.delta.item.author" },
    ]);
  });

  it("drops an unreadable client message id without losing the message", () => {
    const decoded = decodeExecutionEventEnvelope(
      messageAdd({ ...attributedUserMessageFixture.value, clientMessageId: 7 }),
    );
    if (!decoded.ok) throw new Error(decoded.reason);

    expect(decoded.value.event).toMatchObject({
      delta: { item: { author: personActorFixture } },
    });
    expect(decoded.warnings).toEqual([
      {
        reason: "dropped-invalid-field",
        path: "event.delta.item.clientMessageId",
      },
    ]);
  });

  it("reads a message from a host that does not echo yet exactly as before", () => {
    const { author, clientMessageId, ...unattributed } =
      attributedUserMessageFixture.value;
    void author;
    void clientMessageId;

    expect(decodeExecutionEventEnvelope(messageAdd(unattributed))).toEqual({
      ok: true,
      value: {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "session-1",
        seq: 3,
        event: {
          kind: "delta",
          delta: { kind: "conversation.item.add", item: unattributed },
        },
      },
    });
  });

  it("never lets a patch rewrite who sent a message", () => {
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "session-1",
        seq: 4,
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: "message-from-piotr",
            patch: {
              author: agentActorFixture,
              clientMessageId: "command-forged",
              delivery: "delivered",
            },
          },
        },
      }),
    );

    expect(decoded).toMatchObject({
      ok: true,
      value: { event: { delta: { patch: { delivery: "delivered" } } } },
    });
    expect(
      decoded.ok &&
        decoded.value.event.kind === "delta" &&
        decoded.value.event.delta.kind === "conversation.item.patch"
        ? Object.keys(decoded.value.event.delta.patch)
        : null,
    ).toEqual(["delivery"]);

    // @ts-expect-error The author is fixed when the message is added.
    const authorPatch: ExecutionConversationItemPatch = { author: null };
    const idPatch: ExecutionConversationItemPatch = {
      // @ts-expect-error So is the id of the send that created it.
      clientMessageId: "command-forged",
    };
    void authorPatch;
    void idPatch;
  });
});
