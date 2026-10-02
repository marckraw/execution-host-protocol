import { describe, expect, it } from "vitest";
import {
  decodeExecutionActivitySignal,
  decodeExecutionContextWindow,
  decodeExecutionConversationItem,
  decodeExecutionSessionMetadata,
  decodeExecutionTurn,
  decodeExecutionTurnFileChange,
} from "../src/index.js";
import {
  attributedUserMessageFixture,
  conversationItemFixtures,
} from "./fixtures/contract-fixtures.js";

describe("contract shapes read outside an envelope (MAR-3638)", () => {
  it.each(Object.entries(conversationItemFixtures))(
    "reads a %s item by the envelope's rules",
    (_kind, fixture) => {
      expect(decodeExecutionConversationItem(fixture.value)).toEqual({
        ok: true,
        value: fixture.value,
      });
    },
  );

  it("names an item's dropped fields relative to the item", () => {
    expect(
      decodeExecutionConversationItem({
        ...attributedUserMessageFixture.value,
        author: "Piotr",
        delivery: "lost",
      }),
    ).toMatchObject({
      ok: true,
      warnings: [
        { reason: "dropped-invalid-field", path: "item.delivery" },
        { reason: "dropped-invalid-field", path: "item.author" },
      ],
    });
  });

  it("calls a newer item kind unknown, for a list reader to drop", () => {
    expect(
      decodeExecutionConversationItem({
        ...conversationItemFixtures.note.value,
        kind: "image",
      }),
    ).toEqual({ ok: false, reason: "unknown-kind" });
    expect(decodeExecutionConversationItem({ kind: "image" })).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("reads turns, file changes, context windows, activity and metadata", () => {
    const turn = {
      id: "turn-1",
      sessionId: "session-1",
      sequence: 1,
      startedAt: "2026-10-02T10:00:00.000Z",
      endedAt: null,
      status: "running",
      summary: null,
    };
    expect(decodeExecutionTurn(turn)).toEqual({ ok: true, value: turn });
    expect(decodeExecutionTurn({ ...turn, sequence: 0 }).ok).toBe(false);

    const change = {
      id: "change-1",
      sessionId: "session-1",
      turnId: "turn-1",
      filePath: "README.md",
      oldPath: null,
      status: "added",
      additions: 1,
      deletions: 0,
      diff: "+hello",
      truncated: false,
      binary: false,
      createdAt: "2026-10-02T10:00:00.000Z",
    };
    expect(decodeExecutionTurnFileChange(change)).toEqual({
      ok: true,
      value: change,
    });
    expect(
      decodeExecutionTurnFileChange({ ...change, status: "renamed" }).ok,
    ).toBe(false);

    const contextWindow = {
      availability: "available",
      source: "provider",
      usedTokens: 100,
      windowTokens: 1_000,
      usedPercentage: 10,
      remainingPercentage: 90,
    };
    expect(decodeExecutionContextWindow(contextWindow)).toEqual({
      ok: true,
      value: contextWindow,
    });
    expect(decodeExecutionContextWindow({ availability: "maybe" }).ok).toBe(
      false,
    );

    expect(decodeExecutionActivitySignal(null)).toEqual({
      ok: true,
      value: null,
    });
    expect(decodeExecutionActivitySignal("tool:Bash")).toEqual({
      ok: true,
      value: "tool:Bash",
    });
    expect(decodeExecutionActivitySignal("napping").ok).toBe(false);

    expect(decodeExecutionSessionMetadata(undefined)).toEqual({
      ok: true,
      value: null,
    });
    expect(
      decodeExecutionSessionMetadata({ source: { surface: "accent" } }),
    ).toEqual({ ok: true, value: { source: { surface: "accent" } } });
    expect(decodeExecutionSessionMetadata({ user: { id: 7 } }).ok).toBe(false);
  });
});
