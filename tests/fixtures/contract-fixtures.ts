import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionActor,
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
  type HarnessEvidence,
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
  "stop-task": commandEnvelope({ kind: "stop-task", taskId: "task-b7x2" }),
} satisfies Record<ExecutionHostCommand["kind"], ExecutionHostCommandEnvelope>;

// ---------------------------------------------------------------------------
// MAR-3633: who sent it. Ids are placeholders in the sending client's own
// namespace; the host stores them as given.
// ---------------------------------------------------------------------------

export const personActorFixture = {
  kind: "person",
  id: "usr_piotr",
  displayName: "Piotr",
} satisfies ExecutionActor;

export const agentActorFixture = {
  kind: "agent",
  id: "kuba",
  displayName: "Kuba",
} satisfies ExecutionActor;

/**
 * Every command kind again, each carrying who sent it and the client's id for
 * it. Derived from `commandFixtures`, so a new command kind is attributed here
 * the moment it has a fixture there.
 */
export const attributedCommandFixtures = Object.fromEntries(
  Object.entries(commandFixtures).map(([kind, envelope], index) => [
    kind,
    {
      ...envelope,
      commandId: `command-${index + 1}`,
      actor: index % 2 === 0 ? personActorFixture : agentActorFixture,
    },
  ]),
) as Record<ExecutionHostCommand["kind"], ExecutionHostCommandEnvelope>;

/** A user message as a host advertising `items.author.v1` echoes it. */
export const attributedUserMessageFixture = {
  source: "hand-authored",
  value: {
    id: "message-from-piotr",
    kind: "message",
    state: "complete",
    createdAt: timestamp,
    updatedAt: timestamp,
    providerMeta: {
      providerId: "claude",
      providerItemId: null,
      providerEventType: "user",
    },
    actor: "user",
    text: "Ship the staging banner",
    delivery: "queued",
    author: personActorFixture,
    clientMessageId: "command-1",
  },
} satisfies Fixture<ExecutionConversationItem>;

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

// ---------------------------------------------------------------------------
// MAR-3679: the harness evidence an `evidence` delta carries — one fixture per
// member of Convergence's `HarnessEvidence` union, `harness.retry` once per
// phase. Each is `Complete`: every field its type names is present, optional
// ones and nested ones included, so a codec that drops any of them fails the
// round trip, and a field added to the type fails this file until a fixture
// carries it. Hand-authored from Convergence's types; no host sends them yet.
// ---------------------------------------------------------------------------

/** `T` with every optional field required, all the way down. */
export type Complete<T> = T extends readonly (infer Entry)[]
  ? Complete<Entry>[]
  : T extends object
    ? { [Key in keyof T]-?: Complete<T[Key]> }
    : T;

type RetryPhase = Extract<HarnessEvidence, { kind: "harness.retry" }>["phase"];
export type EvidenceFixtureKey =
  | Exclude<HarnessEvidence["kind"], "harness.retry">
  | `harness.retry:${RetryPhase}`;
type EvidenceOf<Key extends EvidenceFixtureKey> =
  Key extends `harness.retry:${infer Phase}`
    ? Extract<HarnessEvidence, { kind: "harness.retry"; phase: Phase }>
    : Extract<HarnessEvidence, { kind: Key }>;

const at = "2026-10-03T21:40:00.000Z";
const bounded = {
  truncated: true,
  fieldBounds: { output: { truncated: true, bytes: 70_000 } },
} as const;

export const evidenceFixtures: {
  [Key in EvidenceFixtureKey]: Complete<EvidenceOf<Key>>;
} = {
  "harness.hook": {
    kind: "harness.hook",
    at,
    ...bounded,
    hookId: "hook-1",
    hookName: "PostToolUse:Bash",
    hookEvent: "PostToolUse",
    phase: "response",
    status: "ok",
    output: { truncated: true, bytes: 70_000, preview: "lint: 0 problems" },
  },
  "harness.retry:attempt": {
    kind: "harness.retry",
    phase: "attempt",
    at,
    ...bounded,
    attempt: 2,
    maxRetries: 10,
    retryDelayMs: 1_200,
    errorStatus: 529,
    message: "Overloaded",
    noResponse: false,
  },
  "harness.retry:resolved": {
    kind: "harness.retry",
    phase: "resolved",
    at,
    ...bounded,
    outcome: "failed",
    reason: "tool-error-while-outstanding",
    attempts: 3,
    errorSubtype: "error_during_execution",
  },
  "harness.retry:unknown": {
    kind: "harness.retry",
    phase: "unknown",
    at,
    ...bounded,
  },
  "harness.compaction": {
    kind: "harness.compaction",
    at,
    ...bounded,
    trigger: "auto",
    preTokens: 180_000,
    postTokens: 42_000,
    durationMs: 9_400,
  },
  "harness.denial": {
    kind: "harness.denial",
    at,
    ...bounded,
    toolUseId: "toolu_01",
    toolName: "Bash",
    reasonType: "rule",
    reason: "rm -rf is denied",
  },
  "harness.rateLimit": {
    kind: "harness.rateLimit",
    at,
    ...bounded,
    status: "allowed_warning",
    type: "five_hour",
    utilization: 0.91,
    resetsAt: 1_791_000_000,
    overageStatus: "allowed",
    overageResetsAt: 1_791_500_000,
    overageDisabledReason: null,
    isUsingOverage: false,
    overageInUse: false,
    surpassedThreshold: 0.9,
  },
  "harness.init": {
    kind: "harness.init",
    at,
    ...bounded,
    claudeCodeVersion: "2.1.4",
    model: "claude-opus-5-5",
    permissionMode: "acceptEdits",
    mcpServers: {
      total: 3,
      connected: 2,
      connectedNames: ["linear", "github"],
      connectedOmitted: 0,
      others: [{ name: "figma", status: "needs-auth" }],
      omitted: 0,
      omittedAlerts: 0,
    },
    plugins: { count: 1, names: ["superpowers"], omitted: 0 },
    capabilities: { values: ["interrupt", "task-stop"], omitted: 0 },
    tools: { count: 24 },
    skills: { count: 6 },
    slashCommands: { count: 31 },
  },
  "harness.mcpStatus": {
    kind: "harness.mcpStatus",
    at,
    ...bounded,
    servers: [
      {
        name: "figma",
        status: "connected",
        scope: "claudeai",
        origin: "https://mcp.figma.com",
        nameTruncated: true,
      },
    ],
    connected: 1,
    omitted: 0,
    omittedAlerts: 0,
    pluginServers: [
      {
        plugin: "superpowers",
        server: "context7",
        origin: "https://mcp.context7.com",
        loaded: true,
      },
    ],
  },
  "agent.started": {
    kind: "agent.started",
    run: {
      endedSummary: null,
      stopReason: null,
      id: "run-explore-1",
      spawnedByItemId: "tool-call-agent-1",
      agentType: "Explore",
      description: "Find the session reducers",
      model: "claude-haiku-4-5-20251001",
      depth: 1,
      startedAt: at,
      transcriptPath: "/home/bun/.claude/projects/x/agent-1.jsonl",
    },
  },
  "agent.identified": {
    kind: "agent.identified",
    spawnedByItemId: "tool-call-agent-1",
    id: "agent-a1b2",
    agentType: "Explore",
    description: "Find the session reducers",
    depth: 1,
    transcriptPath: "/home/bun/.claude/projects/x/agent-a1b2.jsonl",
  },
  "agent.changed": {
    kind: "agent.changed",
    spawnedByItemId: "tool-call-agent-1",
    patch: {
      model: "claude-haiku-4-5-20251001",
      isBackgrounded: true,
      lastToolName: "Grep",
      usageJson: '{"input_tokens":1200}',
      updatedAt: at,
    },
  },
  "agent.ended": {
    kind: "agent.ended",
    stopReason: "stop",
    summary: "Found three reducers",
    spawnedByItemId: "tool-call-agent-1",
    status: "stopped",
    at,
  },
  "process.ended": {
    kind: "process.ended",
    unresolvedStatus: "unknown",
    at,
    reason: "idle",
  },
  "task.changed": {
    kind: "task.changed",
    taskId: "task-b7x2",
    at,
    patch: {
      stopReceiptAt: null,
      observedAt: at,
      endedSummary: "212 tests passed",
      stopReason: null,
      toolUseId: "toolu_02",
      taskType: "local_bash",
      description: "npm test",
      status: "completed",
      startedAt: at,
      endedAt: at,
      outputFile: "/tmp/tasks/b7x2.output",
    },
  },
  "turn.accounting": {
    kind: "turn.accounting",
    resultSubtype: "success",
    usage: { input_tokens: 5_000, output_tokens: 800 },
    costUsd: 0.42,
    permissionDenials: [],
    subagentStats: null,
  },
  "harness.unknown": {
    kind: "harness.unknown",
    type: "system",
    subtype: "plugin_reload",
    payload: { plugins: ["superpowers"] },
    at,
  },
};
