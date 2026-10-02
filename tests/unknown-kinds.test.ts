import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_VERSION,
  decodeExecutionCommandEnvelope,
  decodeExecutionEventEnvelope,
  type ExecutionHostEventEnvelope,
} from "../src/index.js";
import {
  conversationItemFixtures,
  eventFixtures,
} from "./fixtures/contract-fixtures.js";

const envelope = (seq: number, event: unknown) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    seq,
    event,
  });

const { id, state, createdAt, updatedAt, providerMeta } =
  conversationItemFixtures.message.value;
/** The fields every item shares, which a newer kind still has to carry. */
const itemBase = { id, state, createdAt, updatedAt, providerMeta };

describe("unknown kinds are skipped, not fatal (MAR-3633)", () => {
  it("skips an event kind it does not know and says where it sat", () => {
    expect(
      decodeExecutionEventEnvelope(
        envelope(5, { kind: "presence", who: "piotr" }),
      ),
    ).toEqual({
      ok: false,
      reason: "unknown-kind",
      skipped: {
        sessionId: "session-1",
        seq: 5,
        path: "event.kind",
        kind: "presence",
      },
    });
  });

  it("skips a delta kind it does not know", () => {
    expect(
      decodeExecutionEventEnvelope(
        envelope(6, {
          kind: "delta",
          delta: { kind: "item.reaction", itemId: "message-1", emoji: "+1" },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "unknown-kind",
      skipped: {
        sessionId: "session-1",
        seq: 6,
        path: "event.delta.kind",
        kind: "item.reaction",
      },
    });
  });

  it("skips an item kind it does not know instead of calling it invalid", () => {
    expect(
      decodeExecutionEventEnvelope(
        envelope(7, {
          kind: "delta",
          delta: {
            kind: "conversation.item.add",
            item: { ...itemBase, kind: "image", url: "https://example.test" },
          },
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "unknown-kind",
      skipped: {
        sessionId: "session-1",
        seq: 7,
        path: "event.delta.item.kind",
        kind: "image",
      },
    });
  });

  it("still refuses a newer item that lacks the fields every item shares", () => {
    const { id: _id, ...withoutId } = itemBase;
    void _id;

    expect(
      decodeExecutionEventEnvelope(
        envelope(8, {
          kind: "delta",
          delta: {
            kind: "conversation.item.add",
            item: { ...withoutId, kind: "image" },
          },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("still refuses an unknown kind whose place in the stream is unreadable", () => {
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sessionId: "session-1",
          seq: 0,
          event: { kind: "presence" },
        }),
      ),
    ).toEqual({ ok: false, reason: "invalid-envelope" });
  });

  it("still refuses a command kind it does not know: a host must not drop a command", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          sessionId: "session-1",
          command: { kind: "set-model", model: "opus" },
        }),
      ),
    ).toEqual({ ok: false, reason: "unknown-kind" });
  });

  it("lets a reader step over a newer kind and keep its place", () => {
    const frames = [
      JSON.stringify({ ...eventFixtures.status, sessionId: "session-1" }),
      envelope(3, { kind: "presence", who: "piotr" }),
      envelope(4, {
        kind: "delta",
        delta: {
          kind: "conversation.item.add",
          item: { ...itemBase, kind: "image" },
        },
      }),
      envelope(5, { kind: "activity", activity: null }),
    ];
    // The status fixture sits at seq 2; the reader resumed after seq 1.
    let cursor = 1;
    const applied: ExecutionHostEventEnvelope[] = [];
    const skipped: string[] = [];
    const gaps: number[] = [];

    for (const raw of frames) {
      const decoded = decodeExecutionEventEnvelope(raw);
      const seq = decoded.ok ? decoded.value.seq : decoded.skipped?.seq;
      if (seq === undefined) throw new Error("unplaceable frame");
      if (seq !== cursor + 1) gaps.push(seq);
      if (decoded.ok) applied.push(decoded.value);
      else skipped.push(decoded.skipped!.kind);
      cursor = seq;
    }

    expect(gaps).toEqual([]);
    expect(cursor).toBe(5);
    expect(skipped).toEqual(["presence", "image"]);
    expect(applied.map((applied) => applied.event.kind)).toEqual([
      "status",
      "activity",
    ]);
  });
});
