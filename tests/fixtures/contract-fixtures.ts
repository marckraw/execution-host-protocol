import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionConversationItem,
  type ExecutionEnvironmentDeclaration,
  type ExecutionEnvironmentListResponse,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionProjectListResponse,
  type ExecutionRoomChristenResponse,
  type ExecutionSessionWorkspace,
  type ExecutionStartRequest,
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

// ---------------------------------------------------------------------------
// ADR-0011: the work address, the environments contract, project origin.
// Every fixture below carries variable NAMES only. The one payload with a
// `values` field carries an empty object on purpose: the codec rejects the
// field's presence, not its contents, so proving the rule needs no secret.
// ---------------------------------------------------------------------------

export const startRequestWithEnvironmentFixture = {
  source: "hand-authored",
  value: {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId: "claude",
    config: {
      sessionId: "session-env-1",
      workingDirectory: "/srv/projects/new-blok",
      initialMessage: "ship the staging banner",
      model: null,
      effort: null,
      continuationToken: null,
    },
    environment: "new-blok/staging",
  },
} satisfies Fixture<ExecutionStartRequest>;

export const sessionWorkspaceFixtures = {
  repository: {
    source: "hand-authored",
    value: {
      mode: "repository",
      repository: "marckraw/emergence",
      branchName: "agent/errand-1",
      baseRef: "master",
      workspacePath: "/srv/workspaces/errand-1",
      environment: null,
    },
  },
  project: {
    source: "hand-authored",
    value: {
      mode: "project",
      projectId: "new-blok",
      workingDirectory: "/srv/projects/new-blok",
      origin: "https://github.com/marckraw/new-blok.git",
      originKey: "github.com/marckraw/new-blok",
      branchName: "master",
      requestedBranchName: "feature/banner",
      environment: "new-blok/staging",
    },
  },
} satisfies Record<string, Fixture<ExecutionSessionWorkspace>>;

/** What a host echoed before ADR-0011 gave the address a discriminator. */
export const legacySessionWorkspaceFixture = {
  source: "recorded",
  value: {
    repository: "marckraw/emergence",
    branchName: "agent/errand-0",
    baseRef: "master",
  },
} satisfies Fixture<Record<string, unknown>>;

export const projectListFixture = {
  source: "hand-authored",
  value: {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    projects: [
      {
        id: "new-blok",
        name: "new-blok",
        workingDirectory: "/srv/projects/new-blok",
        origin: "https://github.com/marckraw/new-blok.git",
        originKey: "github.com/marckraw/new-blok",
        environments: [
          {
            name: "new-blok/local",
            default: true,
            provisioned: true,
            missing: [],
          },
          {
            name: "new-blok/staging",
            default: false,
            provisioned: false,
            missing: ["STORYBLOK_TOKEN"],
          },
        ],
      },
    ],
  },
} satisfies Fixture<ExecutionProjectListResponse>;

/** A host that predates `projects.v2` says only what it always said. */
export const legacyProjectListFixture = {
  source: "recorded",
  value: {
    projects: [
      {
        id: "new-blok",
        name: "new-blok",
        workingDirectory: "/srv/projects/new-blok",
      },
    ],
  },
} satisfies Fixture<Record<string, unknown>>;

export const environmentListFixture = {
  source: "hand-authored",
  value: {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    environments: [
      {
        name: "shared/storyblok",
        keys: ["STORYBLOK_OAUTH_TOKEN"],
        provisioned: true,
        missing: [],
      },
      {
        name: "new-blok/staging",
        keys: ["NEW_BLOK_API_URL", "STORYBLOK_TOKEN"],
        includes: ["shared/storyblok"],
        provisioned: false,
        missing: ["STORYBLOK_TOKEN"],
      },
    ],
  },
} satisfies Fixture<ExecutionEnvironmentListResponse>;

export const environmentDeclarationFixture = {
  source: "hand-authored",
  value: {
    keys: ["NEW_BLOK_API_URL", "STORYBLOK_TOKEN"],
    includes: ["shared/storyblok"],
  },
} satisfies Fixture<ExecutionEnvironmentDeclaration>;

/** The door that does not exist. Empty on purpose — presence is the offence. */
export const environmentDeclarationWithValuesFixture = {
  source: "hand-authored",
  value: {
    keys: ["STORYBLOK_TOKEN"],
    values: {},
  },
} satisfies Fixture<Record<string, unknown>>;
