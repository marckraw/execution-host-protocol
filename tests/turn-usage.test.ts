import { describe, expect, it } from "vitest";
import {
  decodeExecutionEventEnvelope,
  decodeExecutionProviderListResponse,
  decodeExecutionTurn,
  decodeExecutionTurnUsage,
  decodeExecutionTurnUsagePage,
  decodeExecutionTurnUsageRecord,
  encodeExecutionTurnUsageQuery,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_TURN_USAGE_MODELS_MAX_COUNT,
  EXECUTION_TURN_USAGE_PAGE_MAX_LIMIT,
  type ExecutionDecodeWarning,
  type ExecutionTurnUsage,
} from "../src/index.js";
import { decodeExecutionSessionSnapshot } from "../src/client/index.js";

/** The warnings of a read that worked; none of one that did not. */
const warningsOf = (result: {
  ok: boolean;
  warnings?: ExecutionDecodeWarning[];
}) => (result.ok ? result.warnings : undefined);

/** An envelope as it arrives: JSON text. */
const decodeEnvelope = (envelope: unknown) =>
  decodeExecutionEventEnvelope(JSON.stringify(envelope));

/**
 * MAR-4943: what each turn cost, counted once — every kind of token apart,
 * a cost only with its basis, the model split whole or not at all — and the
 * history a host keeps of it.
 */

/** A Claude turn with a Haiku helper: its `modelUsage`, as a host reads it. */
const CLAUDE_TURN: ExecutionTurnUsage = {
  providerId: "claude",
  model: "claude-opus-5-5",
  accountId: null,
  tokens: {
    input: 14,
    cacheWrite5m: 5_621,
    cacheWrite1h: 0,
    cacheRead: 15_268,
    output: 912,
  },
  costUsdReported: 0.1342,
  costBasis: "list",
  models: [
    {
      model: "claude-opus-5-5",
      tokens: {
        input: 2,
        cacheWrite5m: 5_621,
        cacheWrite1h: 0,
        cacheRead: 15_268,
        output: 870,
      },
      costUsdReported: 0.1331,
    },
    {
      model: "claude-haiku-4-5-20251001",
      tokens: {
        input: 12,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 42,
      },
      costUsdReported: 0.0011,
    },
  ],
};

/** A Codex turn: no cost, no cache writes, reasoning inside its output. */
const CODEX_TURN: ExecutionTurnUsage = {
  providerId: "codex",
  model: "gpt-5.1-codex",
  accountId: "work",
  tokens: {
    input: 1_204,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 30_976,
    output: 2_310,
    reasoning: 1_536,
  },
};

const read = (raw: unknown) => decodeExecutionTurnUsage(raw);

describe("a turn's usage", () => {
  it("is a known capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("turns.usage.v1");
  });

  it("reads Claude's, priced at list and split by model", () => {
    expect(read(CLAUDE_TURN)).toEqual({ ok: true, value: CLAUDE_TURN });
  });

  it("reads Codex's, unpriced, with its reasoning", () => {
    expect(read(CODEX_TURN)).toEqual({ ok: true, value: CODEX_TURN });
  });

  it("ignores fields it does not know", () => {
    const result = read({
      ...CODEX_TURN,
      later: true,
      tokens: { ...CODEX_TURN.tokens, audio: 3 },
    });
    expect(result).toEqual({ ok: true, value: CODEX_TURN });
  });

  it.each([
    ["no provider", { ...CODEX_TURN, providerId: "" }],
    ["no model, not even null", { ...CODEX_TURN, model: undefined }],
    ["no account, not even null", { ...CODEX_TURN, accountId: undefined }],
    ["an email for an account", { ...CODEX_TURN, accountId: "me@ef.com" }],
    ["an account with spaces about it", { ...CODEX_TURN, accountId: " a " }],
    ["no tokens", { ...CODEX_TURN, tokens: undefined }],
    [
      "a count missing",
      {
        ...CODEX_TURN,
        tokens: { ...CODEX_TURN.tokens, cacheWrite1h: undefined },
      },
    ],
    [
      "a negative count",
      { ...CODEX_TURN, tokens: { ...CODEX_TURN.tokens, input: -1 } },
    ],
    [
      "a fraction of a token",
      { ...CODEX_TURN, tokens: { ...CODEX_TURN.tokens, output: 1.5 } },
    ],
    [
      "a count past 2^53",
      { ...CODEX_TURN, tokens: { ...CODEX_TURN.tokens, cacheRead: 2 ** 53 } },
    ],
    [
      "a reasoning count that is no count",
      { ...CODEX_TURN, tokens: { ...CODEX_TURN.tokens, reasoning: "many" } },
    ],
  ])("is unreadable with %s", (_, raw) => {
    expect(read(raw)).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("drops every cost without a basis, and keeps the tokens", () => {
    const { costBasis: _, costUsdReported: __, ...unpriced } = CLAUDE_TURN;
    const tokensOnly = {
      ...unpriced,
      models: CLAUDE_TURN.models!.map(({ model, tokens }) => ({
        model,
        tokens,
      })),
    };
    expect(read({ ...CLAUDE_TURN, costBasis: undefined })).toEqual({
      ok: true,
      value: tokensOnly,
      warnings: [{ reason: "dropped-invalid-field", path: "costBasis" }],
    });
  });

  it("drops every cost on a basis it does not know", () => {
    const result = read({ ...CLAUDE_TURN, costBasis: "billed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("costUsdReported" in result.value).toBe(false);
    expect("costBasis" in result.value).toBe(false);
    expect(
      result.value.models!.every((model) => !("costUsdReported" in model)),
    ).toBe(true);
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "costBasis" },
    ]);
  });

  it("drops a cost that is no amount on its own", () => {
    const result = read({
      ...CLAUDE_TURN,
      costUsdReported: -0.5,
      models: [
        { ...CLAUDE_TURN.models![0]!, costUsdReported: "0.13" },
        CLAUDE_TURN.models![1]!,
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.costUsdReported).toBeUndefined();
    expect(result.value.models![0]!.costUsdReported).toBeUndefined();
    // One model's cost is left, and its basis with it.
    expect(result.value.models![1]!.costUsdReported).toBe(0.0011);
    expect(result.value.costBasis).toBe("list");
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "costUsdReported" },
      { reason: "dropped-invalid-field", path: "models.0.costUsdReported" },
    ]);
  });

  it("keeps no basis when there is no cost to be on it", () => {
    expect(read({ ...CODEX_TURN, costBasis: "list" })).toEqual({
      ok: true,
      value: CODEX_TURN,
    });
  });

  it.each([
    ["is empty", []],
    ["names a model twice", [CLAUDE_TURN.models![0], CLAUDE_TURN.models![0]]],
    [
      "has an entry without tokens",
      [CLAUDE_TURN.models![0], { model: "claude-haiku-4-5" }],
    ],
    [
      "is too long",
      Array.from(
        { length: EXECUTION_TURN_USAGE_MODELS_MAX_COUNT + 1 },
        (_, index) => ({ ...CLAUDE_TURN.models![1]!, model: `m-${index}` }),
      ),
    ],
    ["is no list", { "claude-opus-5-5": CLAUDE_TURN.models![0] }],
  ])(
    "drops a model split that %s, whole, and keeps the totals",
    (_, models) => {
      const result = read({ ...CLAUDE_TURN, models });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.models).toBeUndefined();
      expect(result.value.tokens).toEqual(CLAUDE_TURN.tokens);
      expect(result.value.costUsdReported).toBe(CLAUDE_TURN.costUsdReported);
      expect(warningsOf(result)).toContainEqual({
        reason: "dropped-invalid-field",
        path: "models",
      });
    },
  );
});

describe("a turn's usage on the wire", () => {
  const envelope = (patch: unknown) => ({
    protocolVersion: 1,
    sessionId: "session-1",
    seq: 7,
    event: {
      kind: "delta",
      delta: { kind: "turn.patch", turnId: "turn-1", patch },
    },
  });
  const ENDED = {
    endedAt: "2026-10-30T21:00:00.000Z",
    status: "completed",
  };

  it("comes on the turn.patch that ends the turn", () => {
    const result = decodeEnvelope(envelope({ ...ENDED, usage: CLAUDE_TURN }));
    expect(result).toEqual({
      ok: true,
      value: envelope({ ...ENDED, usage: CLAUDE_TURN }),
    });
  });

  it("comes on a turn.patch of its own, after the end", () => {
    const result = decodeEnvelope(envelope({ usage: CODEX_TURN }));
    expect(result.ok && result.value.event).toEqual({
      kind: "delta",
      delta: {
        kind: "turn.patch",
        turnId: "turn-1",
        patch: { usage: CODEX_TURN },
      },
    });
  });

  it("never costs the turn its end when it cannot be read", () => {
    const result = decodeEnvelope(
      envelope({ ...ENDED, usage: { ...CODEX_TURN, accountId: "me@ef.com" } }),
    );
    expect(result).toEqual({
      ok: true,
      value: envelope(ENDED),
      warnings: [
        { reason: "dropped-invalid-field", path: "event.delta.patch.usage" },
      ],
    });
  });

  it("names what it dropped inside the usage where it sat", () => {
    const { costBasis: _, ...unbased } = CLAUDE_TURN;
    const result = decodeEnvelope(envelope({ ...ENDED, usage: unbased }));
    expect(warningsOf(result)).toEqual([
      {
        reason: "dropped-invalid-field",
        path: "event.delta.patch.usage.costBasis",
      },
    ]);
  });

  it("reads a turn.patch without usage as before", () => {
    expect(decodeEnvelope(envelope(ENDED))).toEqual({
      ok: true,
      value: envelope(ENDED),
    });
  });

  const TURN = {
    id: "turn-1",
    sessionId: "session-1",
    sequence: 1,
    startedAt: "2026-10-30T20:59:00.000Z",
    endedAt: "2026-10-30T21:00:00.000Z",
    status: "completed",
    summary: null,
    origin: "user",
  };

  it("is on the turn a snapshot carries", () => {
    const result = decodeExecutionSessionSnapshot({
      protocolVersion: 1,
      sessionId: "session-1",
      providerId: "claude",
      conversation: [],
      lastSeq: 7,
      turns: [
        { ...TURN, usage: CLAUDE_TURN, fileChanges: [] },
        {
          ...TURN,
          id: "turn-2",
          sequence: 2,
          usage: { ...CLAUDE_TURN, tokens: null },
          fileChanges: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns[0]!.usage).toEqual(CLAUDE_TURN);
    expect(result.value.turns[1]!.id).toBe("turn-2");
    expect(result.value.turns[1]!.usage).toBeUndefined();
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "turns.1.usage" },
    ]);
  });

  it("is read by decodeExecutionTurn, its warnings at usage", () => {
    expect(decodeExecutionTurn({ ...TURN, usage: CODEX_TURN })).toEqual({
      ok: true,
      value: { ...TURN, usage: CODEX_TURN },
    });
    expect(decodeExecutionTurn({ ...TURN, usage: "lots" })).toEqual({
      ok: true,
      value: TURN,
      warnings: [{ reason: "dropped-invalid-field", path: "usage" }],
    });
  });

  it("names an unreadable usage on a turn.add where it sat", () => {
    const result = decodeEnvelope({
      protocolVersion: 1,
      sessionId: "session-1",
      seq: 3,
      event: {
        kind: "delta",
        delta: { kind: "turn.add", turn: { ...TURN, usage: [] } },
      },
    });
    expect(result.ok && result.value.event).toEqual({
      kind: "delta",
      delta: { kind: "turn.add", turn: TURN },
    });
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "event.delta.turn.usage" },
    ]);
  });

  it("is absent from a turn that never had one", () => {
    const result = decodeExecutionTurn(TURN);
    expect(result.ok && "usage" in result.value).toBe(false);
  });
});

describe("the usage history", () => {
  const LIVE = {
    turnId: "turn-1",
    sessionId: "session-1",
    endedAt: "2026-10-30T21:00:00.000Z",
    source: "live",
    ...CLAUDE_TURN,
  };
  const BACKFILLED = {
    turnId: "backfill:claude:msg_01ABC:req_01XYZ",
    sessionId: null,
    endedAt: "2026-08-30T10:12:00.000Z",
    source: "backfill",
    ...CODEX_TURN,
  };
  const page = (records: unknown[], more: Record<string, unknown> = {}) => ({
    protocolVersion: 1,
    records,
    nextCursor: "c2",
    hasMore: false,
    ...more,
  });

  it("reads a page of live and backfilled records", () => {
    expect(decodeExecutionTurnUsagePage(page([LIVE, BACKFILLED]))).toEqual({
      ok: true,
      value: {
        records: [LIVE, BACKFILLED],
        nextCursor: "c2",
        hasMore: false,
        warnings: [],
      },
    });
  });

  it("reads an empty history's page, with nothing to resume after", () => {
    expect(
      decodeExecutionTurnUsagePage(page([], { nextCursor: null })),
    ).toEqual({
      ok: true,
      value: { records: [], nextCursor: null, hasMore: false, warnings: [] },
    });
  });

  it.each([
    [
      "no protocol version",
      { protocolVersion: undefined },
      "unsupported-protocol-version",
    ],
    [
      "another protocol version",
      { protocolVersion: 2 },
      "unsupported-protocol-version",
    ],
    ["no records", { records: undefined }, "invalid-payload"],
    ["no hasMore", { hasMore: undefined }, "invalid-payload"],
    ["a cursor that is none", { nextCursor: "" }, "invalid-payload"],
    ["no cursor, not even null", { nextCursor: undefined }, "invalid-payload"],
  ])("refuses a page with %s", (_, more, reason) => {
    expect(decodeExecutionTurnUsagePage(page([LIVE], more))).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    ["no turn id", { turnId: "" }],
    ["no session, not even null", { sessionId: undefined }],
    ["an end that is no timestamp", { endedAt: "yesterday" }],
    ["a source it does not know", { source: "guessed" }],
    ["usage it cannot read", { tokens: {} }],
  ])("drops a record with %s, and names it", (_, broken) => {
    const result = decodeExecutionTurnUsagePage(
      page([{ ...LIVE, ...broken }, BACKFILLED]),
    );
    expect(result.ok && result.value.records).toEqual([BACKFILLED]);
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "records.0" },
    ]);
  });

  it("names what a record dropped where it sat", () => {
    const result = decodeExecutionTurnUsagePage(
      page([BACKFILLED, { ...LIVE, models: [] }]),
    );
    expect(result.ok && result.value.records[1]!.models).toBeUndefined();
    expect(warningsOf(result)).toEqual([
      { reason: "dropped-invalid-field", path: "records.1.models" },
    ]);
  });

  it("reads one record on its own", () => {
    expect(decodeExecutionTurnUsageRecord(BACKFILLED)).toEqual({
      ok: true,
      value: BACKFILLED,
    });
    expect(
      decodeExecutionTurnUsageRecord({ ...BACKFILLED, accountId: "a@b" }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

describe("a usage history query", () => {
  it("encodes since, cursor and limit", () => {
    expect(encodeExecutionTurnUsageQuery({})).toBe("");
    expect(
      encodeExecutionTurnUsageQuery({
        since: "2026-10-01T00:00:00.000Z",
        limit: 500,
      }),
    ).toBe("since=2026-10-01T00%3A00%3A00.000Z&limit=500");
    expect(encodeExecutionTurnUsageQuery({ cursor: "c 2", limit: 1 })).toBe(
      "cursor=c+2&limit=1",
    );
  });

  it.each([
    [
      "since with a cursor",
      { since: "2026-10-01T00:00:00.000Z", cursor: "c" },
      TypeError,
    ],
    ["a since that is no timestamp", { since: "2026-10-01" }, TypeError],
    ["a since that is no day", { since: "2026-02-30T00:00:00Z" }, TypeError],
    ["an empty cursor", { cursor: "" }, TypeError],
    ["a cursor too long", { cursor: "c".repeat(1025) }, TypeError],
    ["a limit of 0", { limit: 0 }, RangeError],
    [
      "a limit past the page",
      { limit: EXECUTION_TURN_USAGE_PAGE_MAX_LIMIT + 1 },
      RangeError,
    ],
    ["a fractional limit", { limit: 1.5 }, RangeError],
  ])("refuses %s", (_, query, kind) => {
    expect(() => encodeExecutionTurnUsageQuery(query)).toThrow(kind);
  });

  it("refuses a query that is no object", () => {
    expect(() => encodeExecutionTurnUsageQuery(null as never)).toThrow(
      TypeError,
    );
  });
});

describe("an account-limit window's own observedAt", () => {
  const usage = (window: Record<string, unknown>) => {
    const result = decodeExecutionProviderListResponse({
      providers: [
        {
          id: "claude",
          models: [],
          usage: {
            observedAt: "2026-10-30T20:00:00.000Z",
            source: "turn",
            windows: [
              { id: "five_hour", span: "session", usedPercent: 12, ...window },
            ],
          },
        },
      ],
    });
    if (!result.ok) throw new Error(result.reason);
    return result.value.providers[0]!.usage!.windows[0]!;
  };

  it("is read when the host heard the window apart from the rest", () => {
    expect(usage({ observedAt: "2026-10-30T19:58:00.000Z" }).observedAt).toBe(
      "2026-10-30T19:58:00.000Z",
    );
  });

  it("is absent, and the usage's own applies, when the host does not say", () => {
    expect("observedAt" in usage({})).toBe(false);
  });

  it("is left out alone when it is no timestamp", () => {
    const window = usage({ observedAt: "a minute ago" });
    expect("observedAt" in window).toBe(false);
    expect(window.usedPercent).toBe(12);
  });
});
