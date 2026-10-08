import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_STATUSES,
  EXECUTION_TURN_ORIGINS,
  decodeExecutionCommandEnvelope,
  decodeExecutionConversationItem,
  decodeExecutionEventEnvelope,
  decodeExecutionTurn,
  decodeHarnessEvidence,
  encodeExecutionCommandEnvelope,
  encodeExecutionEventEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionSessionDelta,
  type ExecutionTurn,
  type HarnessEvidence,
} from "../src/index.js";
import {
  commandFixtures,
  conversationItemFixtures,
  evidenceFixtures,
  type EvidenceFixtureKey,
} from "./fixtures/contract-fixtures.js";

/**
 * MAR-3679, protocol 0.19: the resident-session wire. A session that answered
 * while its tasks still run, how many run, who opened each turn, the harness's
 * evidence, which run or task produced an item, and stopping one task.
 *
 * Every round trip here compares with `toEqual` against a value carrying every
 * field: a codec that drops one fails.
 */

const envelope = (
  seq: number,
  event: ExecutionHostEvent,
): ExecutionHostEventEnvelope => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sessionId: "session-1",
  seq,
  event,
});
const deltaEnvelope = (seq: number, delta: ExecutionSessionDelta) =>
  envelope(seq, { kind: "delta", delta });

/** Encodes, decodes, and expects exactly what went in. */
function expectRoundTrip(value: ExecutionHostEventEnvelope) {
  expect(
    decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(value)),
  ).toEqual({ ok: true, value });
}
/** Reads a raw delta as an envelope would carry it. */
const decodeDelta = (delta: unknown, seq = 1) =>
  decodeExecutionEventEnvelope(
    JSON.stringify({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId: "session-1",
      seq,
      event: { kind: "delta", delta },
    }),
  );

describe("answered: the agent has answered, its tasks still run", () => {
  it("sits between running and completed", () => {
    expect(EXECUTION_SESSION_STATUSES).toEqual([
      "idle",
      "running",
      "answered",
      "completed",
      "failed",
    ]);
  });

  it("round-trips as a status event and on a session patch with runningTasks", () => {
    expectRoundTrip(envelope(1, { kind: "status", status: "answered" }));
    expectRoundTrip(
      deltaEnvelope(2, {
        kind: "session.patch",
        patch: { status: "answered", runningTasks: 2, updatedAt: "now" },
      }),
    );
  });

  it("carries runningTasks on its own, 0 included — the count reaching 0 is the news", () => {
    for (const runningTasks of [0, 1, 17]) {
      expectRoundTrip(
        deltaEnvelope(1, { kind: "session.patch", patch: { runningTasks } }),
      );
    }
  });

  it("refuses a count that is not one", () => {
    for (const runningTasks of [-1, 1.5, "2", null, Number.NaN]) {
      expect(
        decodeDelta({ kind: "session.patch", patch: { runningTasks } }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("refuses a status it does not know rather than guessing one", () => {
    expect(
      decodeDelta({ kind: "session.patch", patch: { status: "settled" } }),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });

  it("is announced by its capability, with the evidence and stop-task ones", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toEqual(
      expect.arrayContaining([
        "sessions.resident.v1",
        "evidence.v1",
        "commands.stopTask.v1",
      ]),
    );
  });
});

describe("a turn's origin", () => {
  const turn = (origin: ExecutionTurn["origin"]): ExecutionTurn => ({
    id: `turn-${origin}`,
    sessionId: "session-1",
    sequence: 2,
    startedAt: "2026-10-03T21:40:00.000Z",
    endedAt: null,
    status: "running",
    summary: null,
    origin,
  });

  it("is a person's message, or the harness opening a turn by itself", () => {
    expect(EXECUTION_TURN_ORIGINS).toEqual(["user", "harness"]);
    for (const origin of EXECUTION_TURN_ORIGINS) {
      expectRoundTrip(
        deltaEnvelope(1, { kind: "turn.add", turn: turn(origin) }),
      );
      expect(decodeExecutionTurn(turn(origin))).toEqual({
        ok: true,
        value: turn(origin),
      });
    }
  });

  // MAR-3823: a turn without one came from a host that predates 0.19, and was
  // a person's. This test said it was refused, which dropped every turn of
  // every such host; tests/older-hosts.test.ts reads one as agents-daemon
  // sends it.
  it("reads a turn without one as a person's", () => {
    const { origin: _origin, ...withoutOrigin } = turn("harness");
    void _origin;
    expect(decodeDelta({ kind: "turn.add", turn: withoutOrigin })).toEqual({
      ok: true,
      value: deltaEnvelope(1, {
        kind: "turn.add",
        turn: { ...withoutOrigin, origin: "user" },
      }),
    });
    expect(decodeExecutionTurn(withoutOrigin)).toEqual({
      ok: true,
      value: { ...withoutOrigin, origin: "user" },
    });
  });

  it("refuses a turn with one it does not know", () => {
    const raw = { ...turn("user"), origin: "cron" };
    expect(decodeDelta({ kind: "turn.add", turn: raw })).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(decodeExecutionTurn(raw).ok).toBe(false);
  });

  it("reads only the turn's own fields, not whatever rode along", () => {
    expect(
      decodeExecutionTurn({
        ...turn("user"),
        futureField: true,
        fileChanges: [],
      }),
    ).toEqual({ ok: true, value: turn("user") });
  });

  it("is fixed when the turn is added: a patch naming it does not carry it", () => {
    expect(
      decodeDelta({
        kind: "turn.patch",
        turnId: "turn-1",
        patch: { status: "completed", origin: "harness" },
      }),
    ).toEqual({
      ok: true,
      value: deltaEnvelope(1, {
        kind: "turn.patch",
        turnId: "turn-1",
        patch: { status: "completed" },
      }),
    });
  });
});

/** Every top-level field each member may leave out; every other one it must carry. */
const OPTIONAL_EVIDENCE_FIELDS: Record<EvidenceFixtureKey, string[]> = {
  "harness.hook": ["truncated", "fieldBounds"],
  "harness.retry:attempt": ["truncated", "fieldBounds"],
  "harness.retry:resolved": [
    "truncated",
    "fieldBounds",
    "reason",
    "errorSubtype",
  ],
  "harness.retry:unknown": ["truncated", "fieldBounds"],
  "harness.compaction": ["truncated", "fieldBounds"],
  "harness.denial": ["truncated", "fieldBounds", "toolUseId"],
  "harness.rateLimit": ["truncated", "fieldBounds"],
  "harness.init": ["truncated", "fieldBounds"],
  "harness.mcpStatus": ["truncated", "fieldBounds"],
  "agent.started": [],
  "agent.identified": [],
  "agent.changed": [],
  "agent.ended": ["stopReason", "summary"],
  "process.ended": ["unresolvedStatus", "reason"],
  "task.changed": [],
  "turn.accounting": [],
  "harness.unknown": [],
};

const evidenceEntries = Object.entries(evidenceFixtures) as Array<
  [EvidenceFixtureKey, HarnessEvidence]
>;
const evidenceEnvelope = (evidence: HarnessEvidence, turnId = "turn-1") =>
  deltaEnvelope(9, { kind: "evidence", turnId, evidence });

describe("the evidence delta: Convergence's HarnessEvidence on the wire", () => {
  it.each(evidenceEntries)(
    "round-trips %s with every field",
    (_key, evidence) => {
      expectRoundTrip(evidenceEnvelope(evidence));
      expect(decodeHarnessEvidence(structuredClone(evidence))).toEqual({
        ok: true,
        value: evidence,
      });
    },
  );

  it.each(evidenceEntries)(
    "%s: a required field missing is refused, an optional one stays absent",
    (key, evidence) => {
      const optional = new Set(OPTIONAL_EVIDENCE_FIELDS[key]);
      for (const field of Object.keys(evidence)) {
        if (field === "kind") continue;
        const { [field]: _dropped, ...without } = evidence as Record<
          string,
          unknown
        >;
        void _dropped;
        const decoded = decodeDelta(
          { kind: "evidence", turnId: "turn-1", evidence: without },
          9,
        );
        if (optional.has(field)) {
          expect(decoded, field).toEqual({
            ok: true,
            value: evidenceEnvelope(without as HarnessEvidence),
          });
        } else {
          expect(decoded, field).toEqual({
            ok: false,
            reason: "invalid-payload",
          });
        }
      }
    },
  );

  it("carries a fact that belongs to no turn", () => {
    expectRoundTrip(
      deltaEnvelope(1, {
        kind: "evidence",
        turnId: null,
        evidence: evidenceFixtures["process.ended"],
      }),
    );
  });

  it("refuses a delta without its turn or its evidence", () => {
    const evidence = evidenceFixtures["task.changed"];
    for (const delta of [
      { kind: "evidence", evidence },
      { kind: "evidence", turnId: "", evidence },
      { kind: "evidence", turnId: "turn-1" },
      { kind: "evidence", turnId: "turn-1", evidence: "task.changed" },
      { kind: "evidence", turnId: "turn-1", evidence: { at: "now" } },
    ]) {
      expect(decodeDelta(delta)).toEqual({
        ok: false,
        reason: "invalid-payload",
      });
    }
  });

  it("skips an evidence kind it does not know, and says where it sat", () => {
    expect(
      decodeDelta(
        {
          kind: "evidence",
          turnId: "turn-1",
          evidence: { kind: "agent.paused", at: "now" },
        },
        12,
      ),
    ).toEqual({
      ok: false,
      reason: "unknown-kind",
      skipped: {
        sessionId: "session-1",
        seq: 12,
        path: "event.delta.evidence.kind",
        kind: "agent.paused",
      },
    });
    expect(decodeHarnessEvidence({ kind: "agent.paused" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
  });

  it("ignores fields the model does not name, keeping the ones it does", () => {
    const fact = evidenceFixtures["agent.ended"];
    expect(
      decodeHarnessEvidence({ ...fact, future: 1, spawnedByItemId: "item-9" }),
    ).toEqual({ ok: true, value: { ...fact, spawnedByItemId: "item-9" } });
  });

  it("refuses values the model does not take", () => {
    const broken: Array<[EvidenceFixtureKey, Record<string, unknown>]> = [
      ["harness.hook", { phase: "finished" }],
      ["harness.hook", { status: "maybe" }],
      ["harness.hook", { output: { truncated: false, bytes: 1, preview: "" } }],
      ["harness.hook", { truncated: false }],
      ["harness.hook", { fieldBounds: { output: { bytes: 1 } } }],
      ["harness.retry:attempt", { phase: "waiting" }],
      ["harness.retry:attempt", { attempt: "2" }],
      ["harness.retry:resolved", { reason: "because" }],
      ["harness.rateLimit", { utilization: Number.POSITIVE_INFINITY }],
      ["harness.init", { tools: 24 }],
      ["harness.init", { mcpServers: { total: 1 } }],
      ["harness.mcpStatus", { servers: [{ name: "figma" }] }],
      ["harness.mcpStatus", { pluginServers: [{ plugin: "p" }] }],
      ["agent.started", { run: { id: "run-1" } }],
      ["agent.changed", { patch: { isBackgrounded: "yes" } }],
      ["agent.ended", { status: "running" }],
      ["agent.ended", { stopReason: "quit" }],
      ["process.ended", { reason: "crashed" }],
      ["task.changed", { patch: { status: "done" } }],
      ["task.changed", { patch: { stopReason: "crashed" } }],
      ["task.changed", { taskId: "" }],
      ["turn.accounting", { costUsd: "0.42" }],
      ["harness.unknown", { type: "" }],
    ];
    for (const [key, change] of broken) {
      expect(
        decodeHarnessEvidence({ ...evidenceFixtures[key], ...change }),
        `${key} ${JSON.stringify(change)}`,
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("reads a task's start, progress and end as patches of the fields each names", () => {
    const at = "2026-10-03T21:40:00.000Z";
    const steps: HarnessEvidence[] = [
      {
        kind: "task.changed",
        taskId: "task-1",
        at,
        patch: {
          status: "running",
          toolUseId: "toolu_1",
          taskType: "local_bash",
          description: "npm test",
          startedAt: at,
          observedAt: at,
        },
      },
      {
        kind: "task.changed",
        taskId: "task-1",
        at,
        patch: { outputFile: "/tmp/task-1.output" },
      },
      { kind: "task.changed", taskId: "task-1", at, patch: {} },
      {
        kind: "task.changed",
        taskId: "task-1",
        at,
        patch: {
          status: "stopped",
          endedAt: at,
          endedSummary: "stopped by Marcin",
          stopReason: "stop",
          stopReceiptAt: at,
        },
      },
    ];
    for (const step of steps) expectRoundTrip(evidenceEnvelope(step));
  });

  it("keeps a run's optional fields absent when they are, and a subagent's patch as narrow as it was", () => {
    const {
      endedSummary: _summary,
      stopReason: _reason,
      ...run
    } = evidenceFixtures["agent.started"].run;
    void [_summary, _reason];
    expectRoundTrip(evidenceEnvelope({ kind: "agent.started", run }));
    expectRoundTrip(
      evidenceEnvelope({
        kind: "agent.changed",
        spawnedByItemId: "tool-call-agent-1",
        patch: { lastToolName: "Read" },
      }),
    );
    const {
      connectedNames: _names,
      connectedOmitted: _omitted,
      ...servers
    } = evidenceFixtures["harness.init"].mcpServers!;
    void [_names, _omitted];
    expectRoundTrip(
      evidenceEnvelope({
        ...evidenceFixtures["harness.init"],
        mcpServers: servers,
        plugins: null,
        capabilities: null,
        tools: null,
        skills: null,
        slashCommands: null,
      }),
    );
  });

  it("carries the harness's own payloads as they were, null included", () => {
    expectRoundTrip(
      evidenceEnvelope({
        kind: "turn.accounting",
        resultSubtype: null,
        usage: null,
        costUsd: null,
        permissionDenials: [{ tool_name: "Bash", tool_use_id: "toolu_3" }],
        subagentStats: { count: 2, nested: { deep: [1, "two", false] } },
      }),
    );
    expectRoundTrip(
      evidenceEnvelope({
        kind: "harness.unknown",
        type: "stream_event",
        subtype: null,
        payload: "a string is a payload too",
        at: "now",
      }),
    );
  });
});

describe("which agent run or task produced an item", () => {
  const lineage = { agentRunId: "run-explore-1", taskId: "task-b7x2" };

  it.each(Object.entries(conversationItemFixtures))(
    "rides on a %s item",
    (_kind, fixture) => {
      const item = { ...fixture.value, ...lineage };
      expectRoundTrip(
        deltaEnvelope(1, { kind: "conversation.item.add", item }),
      );
      expect(decodeExecutionConversationItem(structuredClone(item))).toEqual({
        ok: true,
        value: item,
      });
    },
  );

  it("is absent for the main agent's own items", () => {
    const decoded = decodeExecutionConversationItem(
      conversationItemFixtures["tool-call"].value,
    );
    expect(decoded.ok && decoded.value).not.toHaveProperty("agentRunId");
    expect(decoded.ok && decoded.value).not.toHaveProperty("taskId");
  });

  it("drops an unreadable one with a warning and keeps the item", () => {
    const item = conversationItemFixtures["tool-result"].value;
    expect(
      decodeDelta({
        kind: "conversation.item.add",
        item: { ...item, agentRunId: "", taskId: 7 },
      }),
    ).toEqual({
      ok: true,
      value: deltaEnvelope(1, { kind: "conversation.item.add", item }),
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "event.delta.item.agentRunId",
        },
        { reason: "dropped-invalid-field", path: "event.delta.item.taskId" },
      ],
    });
  });

  it("is patched in when the host learns it after the item, or a run is renamed", () => {
    expectRoundTrip(
      deltaEnvelope(1, {
        kind: "conversation.item.patch",
        itemId: "tool-call-1",
        patch: { agentRunId: "agent-a1b2", taskId: "task-b7x2" },
      }),
    );
    expect(
      decodeDelta({
        kind: "conversation.item.patch",
        itemId: "tool-call-1",
        patch: { taskId: "", state: "complete" },
      }),
    ).toEqual({
      ok: true,
      value: deltaEnvelope(1, {
        kind: "conversation.item.patch",
        itemId: "tool-call-1",
        patch: { state: "complete" },
      }),
      warnings: [
        { reason: "dropped-invalid-field", path: "event.delta.patch.taskId" },
      ],
    });
  });
});

describe("stop-task: one task stopped, the session left running", () => {
  it("round-trips", () => {
    const value = commandFixtures["stop-task"];
    expect(
      decodeExecutionCommandEnvelope(encodeExecutionCommandEnvelope(value)),
    ).toEqual({ ok: true, value });
  });

  it("refuses one that names no task", () => {
    for (const command of [
      { kind: "stop-task" },
      { kind: "stop-task", taskId: "" },
      { kind: "stop-task", taskId: 7 },
    ]) {
      expect(
        decodeExecutionCommandEnvelope(
          JSON.stringify({ ...commandFixtures["stop-task"], command }),
        ),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("ignores fields it does not know", () => {
    expect(
      decodeExecutionCommandEnvelope(
        JSON.stringify({
          ...commandFixtures["stop-task"],
          command: { kind: "stop-task", taskId: "task-b7x2", force: true },
        }),
      ),
    ).toEqual({ ok: true, value: commandFixtures["stop-task"] });
  });
});
