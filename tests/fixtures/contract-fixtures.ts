import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionConversationItem,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionRoomChristenResponse,
} from "../../src/index.js";

type FixtureSource = "recorded" | "hand-authored";
interface Fixture<Value> {
  source: FixtureSource;
  value: Value;
}

const timestamp = "2026-07-10T19:46:56.584Z";
const providerMeta = {
  providerId: "claude",
  providerItemId: null,
  providerEventType: null,
};

// Captured from a v0.19.0 local daemon retry response on 2026-07-17.
export const roomChristenPendingFixture = {
  source: "recorded",
  value: {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    room: {
      id: "158235e5-9402-44f7-a2d2-fae1d1573ac2",
      name: "trail sweep repro",
      createdAt: "2026-07-17T13:23:40.475Z",
      lastActiveAt: "2026-07-17T13:23:40.475Z",
      founding: "pending",
      foundingMemoryEntryCount: null,
      foundingError: null,
      sessionCount: 1,
    },
    founding: "pending",
    foundingMemoryEntryCount: 0,
  },
} satisfies Fixture<ExecutionRoomChristenResponse>;

export const conversationItemFixtures = {
  message: {
    source: "recorded",
    value: {
      id: "message-1",
      kind: "message",
      state: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      actor: "assistant",
      text: "EMERGENCE PIPE OK",
      attachments: [
        {
          id: "attachment-1",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 1024,
        },
      ],
    },
  },
  thinking: {
    source: "hand-authored",
    value: {
      id: "thinking-1",
      kind: "thinking",
      state: "streaming",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      actor: "assistant",
      text: "Checking constraints",
    },
  },
  "tool-call": {
    source: "hand-authored",
    value: {
      id: "tool-call-1",
      kind: "tool-call",
      state: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      toolName: "Bash",
      inputText: "pwd",
    },
  },
  "tool-result": {
    source: "hand-authored",
    value: {
      id: "tool-result-1",
      kind: "tool-result",
      state: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      toolName: "Bash",
      relatedItemId: "tool-call-1",
      outputText: "/workspace",
    },
  },
  "approval-request": {
    source: "hand-authored",
    value: {
      id: "approval-1",
      kind: "approval-request",
      state: "streaming",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      description: "Run the command?",
    },
  },
  "input-request": {
    source: "hand-authored",
    value: {
      id: "input-1",
      kind: "input-request",
      state: "streaming",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      prompt: "Choose a target",
      request: {
        kind: "choice",
        questions: [
          {
            id: "target",
            question: "Which target?",
            header: "Target",
            options: [
              { label: "Local", description: "Run on this Mac." },
              { label: "Remote" },
            ],
            multiSelect: false,
          },
        ],
      },
    },
  },
  note: {
    source: "hand-authored",
    value: {
      id: "note-1",
      kind: "note",
      state: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
      providerMeta,
      level: "warning",
      text: "Provider recovered",
    },
  },
} satisfies Record<
  ExecutionConversationItem["kind"],
  Fixture<ExecutionConversationItem>
>;

const eventEnvelope = (
  seq: number,
  event: ExecutionHostEvent,
): ExecutionHostEventEnvelope => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sessionId: "fixture-session",
  seq,
  event,
});

export const eventFixtures = {
  delta: eventEnvelope(1, {
    kind: "delta",
    delta: {
      kind: "conversation.item.add",
      item: conversationItemFixtures.message.value,
    },
  }),
  status: eventEnvelope(2, { kind: "status", status: "running" }),
  attention: eventEnvelope(3, {
    kind: "attention",
    attention: "needs-input",
  }),
  "continuation-token": eventEnvelope(4, {
    kind: "continuation-token",
    token: "thread-1",
  }),
  "context-window": eventEnvelope(5, {
    kind: "context-window",
    contextWindow: {
      availability: "available",
      source: "provider",
      usedTokens: 100,
      windowTokens: 1_000,
      usedPercentage: 10,
      remainingPercentage: 90,
    },
  }),
  activity: eventEnvelope(6, { kind: "activity", activity: "thinking" }),
  heartbeat: eventEnvelope(7, { kind: "heartbeat" }),
} satisfies Record<ExecutionHostEvent["kind"], ExecutionHostEventEnvelope>;

const commandEnvelope = (
  command: ExecutionHostCommand,
): ExecutionHostCommandEnvelope => ({
  protocolVersion: EXECUTION_PROTOCOL_VERSION,
  sessionId: "fixture-session",
  command,
});

export const commandFixtures = {
  "send-message": commandEnvelope({
    kind: "send-message",
    text: "continue",
    options: {
      deliveryMode: "answer",
      queuedInputId: "input-1",
      interactionResponse: {
        kind: "choice",
        answers: [{ questionId: "target", values: ["Local"] }],
      },
    },
  }),
  approve: commandEnvelope({
    kind: "approve",
    providerApprovalId: "approval-1",
  }),
  deny: commandEnvelope({
    kind: "deny",
    providerApprovalId: "approval-1",
  }),
  stop: commandEnvelope({ kind: "stop" }),
  steer: commandEnvelope({
    kind: "steer",
    text: "Prioritize the migration",
    expectedProviderTurnId: "turn-1",
  }),
  interrupt: commandEnvelope({
    kind: "interrupt",
    expectedProviderTurnId: "turn-1",
  }),
  "cancel-queued": commandEnvelope({
    kind: "cancel-queued",
    itemId: "queued-message-1",
  }),
} satisfies Record<ExecutionHostCommand["kind"], ExecutionHostCommandEnvelope>;
