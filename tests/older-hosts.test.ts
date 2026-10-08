import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionCommandEnvelope,
  decodeExecutionConversationItem,
  decodeExecutionEventEnvelope,
  decodeExecutionProviderListResponse,
  decodeExecutionStartRequest,
  decodeExecutionTurn,
  type ExecutionHostEventEnvelope,
} from "../src/index.js";
import { PROVIDERS_BODY } from "./client/stub-host.js";

/**
 * MAR-3823: what a host that predates 0.19 sends still reads. The recording is
 * agents-daemon `3d2dbe2` (built on 0.17.0) serving a two-turn session: no
 * `origin` on a turn, no `runningTasks`, no `answered`, no lineage on an item.
 * See `fixtures/README.md` for how it was made.
 */

const recordedSse = readFileSync(
  join(import.meta.dirname, "fixtures/agents-daemon-0.17-session.sse.txt"),
  "utf8",
);
/** Every `data:` the host wrote, the trailing `caught-up` frame left out. */
const recorded = recordedSse
  .split("\n\n")
  .filter((block) => !block.startsWith("event: caught-up"))
  .flatMap((block) =>
    block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length)),
  );
const recordedOf = (deltaKind: string) =>
  recorded
    .map((data) => JSON.parse(data) as ExecutionHostEventEnvelope)
    .filter(
      (envelope) =>
        envelope.event.kind === "delta" &&
        envelope.event.delta.kind === deltaKind,
    );

/** Reads a raw delta as an envelope would carry it. */
const decodeDelta = (delta: unknown) =>
  decodeExecutionEventEnvelope(
    JSON.stringify({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      seq: 1,
      event: { kind: "delta", delta },
    }),
  );

describe("a turn from a host that sends no origin", () => {
  const turnAdds = recordedOf("turn.add");
  // As the host sent it, so typed as the wire, not as the reader's turn.
  const rawTurn = (envelope: ExecutionHostEventEnvelope) =>
    (envelope.event as unknown as { delta: { turn: Record<string, unknown> } })
      .delta.turn;

  it("is what agents-daemon 0.17 sends: two turns, neither with an origin", () => {
    expect(turnAdds).toHaveLength(2);
    for (const envelope of turnAdds) {
      expect(rawTurn(envelope)).not.toHaveProperty("origin");
    }
  });

  it("reads as a person's, on turn.add and on its own", () => {
    for (const envelope of turnAdds) {
      const turn = { ...rawTurn(envelope), origin: "user" };
      expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
        ok: true,
        value: {
          ...envelope,
          event: { kind: "delta", delta: { kind: "turn.add", turn } },
        },
      });
      expect(decodeExecutionTurn(rawTurn(envelope))).toEqual({
        ok: true,
        value: turn,
      });
    }
  });

  it("keeps a resident host's harness origin, and a user one", () => {
    const [envelope] = turnAdds;
    for (const origin of ["harness", "user"]) {
      const turn = { ...rawTurn(envelope!), origin };
      expect(decodeExecutionTurn(turn)).toEqual({ ok: true, value: turn });
      expect(decodeDelta({ kind: "turn.add", turn })).toMatchObject({
        ok: true,
        value: { event: { delta: { turn: { origin } } } },
      });
    }
  });

  it("still refuses an origin it does not know: a newer host said something, not nothing", () => {
    const [envelope] = turnAdds;
    for (const origin of ["cron", "User", "", null, 0, false, {}, ["user"]]) {
      const turn = { ...rawTurn(envelope!), origin };
      expect(decodeDelta({ kind: "turn.add", turn })).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
      expect(decodeExecutionTurn(turn)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    }
  });
});

/**
 * Each thing 0.19 to 0.21 added to something a 0.18 host already sent, read as
 * a 0.18 host sends it. Listed in the pull request for MAR-3823.
 */
describe("what 0.19 to 0.21 added, read from a host that predates them", () => {
  it("every envelope of the recorded session reads, with nothing dropped", () => {
    expect(recorded).toHaveLength(30);
    for (const data of recorded) {
      const decoded = decodeExecutionEventEnvelope(data);
      expect(decoded).toMatchObject({ ok: true });
      expect(decoded).not.toHaveProperty("warnings");
    }
  });

  it("session.patch without runningTasks (0.19) reads with none", () => {
    expect(
      decodeDelta({
        kind: "session.patch",
        patch: { status: "running", attention: "none", updatedAt: "now" },
      }),
    ).toMatchObject({
      ok: true,
      value: {
        event: {
          delta: {
            patch: { status: "running", attention: "none", updatedAt: "now" },
          },
        },
      },
    });
    const decoded = decodeDelta({
      kind: "session.patch",
      patch: { status: "completed" },
    });
    expect(decoded.ok && decoded.value.event).toEqual({
      kind: "delta",
      delta: { kind: "session.patch", patch: { status: "completed" } },
    });
  });

  it("every status a 0.18 host sends still reads (0.19 added answered)", () => {
    for (const status of ["idle", "running", "completed", "failed"]) {
      expect(
        decodeExecutionEventEnvelope(
          JSON.stringify({
            protocolVersion: EXECUTION_PROTOCOL_VERSION,
            sessionId: "session-1",
            seq: 1,
            event: { kind: "status", status },
          }),
        ),
      ).toMatchObject({ ok: true, value: { event: { status } } });
    }
  });

  it("an item without agentRunId or taskId (0.19) reads as the main agent's, with no warning", () => {
    const adds = recordedOf("conversation.item.add");
    expect(adds.map((envelope) => envelope.event)).not.toHaveLength(0);
    for (const envelope of adds) {
      const raw = (envelope.event as { delta: { item: unknown } }).delta.item;
      const decoded = decodeExecutionConversationItem(raw);
      expect(decoded).toEqual({ ok: true, value: raw });
      expect(decoded.ok && decoded.value).not.toHaveProperty("agentRunId");
      expect(decoded.ok && decoded.value).not.toHaveProperty("taskId");
    }
  });

  it("an item patch without agentRunId or taskId (0.19) reads as sent", () => {
    for (const envelope of recordedOf("conversation.item.patch")) {
      expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
        ok: true,
        value: envelope,
      });
    }
  });

  it("turn.patch reads as sent", () => {
    for (const envelope of recordedOf("turn.patch")) {
      expect(decodeExecutionEventEnvelope(JSON.stringify(envelope))).toEqual({
        ok: true,
        value: envelope,
      });
    }
  });

  it("a start without requires (0.20) reads, and gains none", () => {
    const start = {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      providerId: "claude",
      config: {
        sessionId: "session-1",
        workingDirectory: "/workspace",
        initialMessage: "hello",
        model: null,
        effort: null,
        continuationToken: null,
      },
    };
    const decoded = decodeExecutionStartRequest(JSON.stringify(start));
    expect(decoded).toMatchObject({ ok: true, value: start });
    expect(decoded.ok && decoded.value).not.toHaveProperty("requires");
  });

  it("an image attachment as 0.18 sent it still reads (0.21 added files beside it)", () => {
    const image = {
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataBase64: "AAAA",
    };
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sessionId: "session-1",
          command: {
            kind: "send-message",
            text: "look",
            inlineAttachments: [image],
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: { command: { inlineAttachments: [image] } },
    });
  });

  it("a catalogue without attachmentKinds (0.21) or account reads, with neither", () => {
    const decoded = decodeExecutionProviderListResponse(
      structuredClone(PROVIDERS_BODY),
    );
    expect(decoded.ok).toBe(true);
    for (const provider of decoded.ok ? decoded.value.providers : []) {
      expect(provider).not.toHaveProperty("attachmentKinds");
      expect(provider).not.toHaveProperty("account");
    }
  });
});
