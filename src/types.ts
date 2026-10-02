export const EXECUTION_PROTOCOL_VERSION = 1 as const;

export const EXECUTION_PROTOCOL_CAPABILITY_IDS = [
  "commands.approval",
  "events.replay",
  "sessions.metadata",
  "workspaces.materialize",
  "callbacks.status",
  "automation.create-pr",
  "attachments.inline-image",
  "commands.cancelQueued",
  "interactions.structured",
  "turns.fileChanges",
  "turns.fileChanges.combined",
  "turns.fileChanges.multiRepo",
  "rooms.v1",
  "research.evidence",
  "projects.v1",
  "projects.v2",
  "environments.v1",
  /**
   * The host can send streaming text as `patch.textAppend` increments to a
   * subscriber that asks with `?deltas=append` (MAR-2218b). Hosts advertised it
   * before it was named here.
   */
  "deltas.append.v1",
  /**
   * The host reads `actor` and `commandId` on every command envelope and on the
   * start request, and records who sent each one (MAR-3633).
   */
  "commands.actor.v1",
  /**
   * The host echoes `author` and `clientMessageId` on the user `message` items
   * its commands create, so a client can match its own sends (MAR-3633).
   */
  "items.author.v1",
  /**
   * A session's model and effort change between turns (MAR-3662): the host
   * takes them on a session patch at any time, runs every turn that starts
   * after the change on them, reports the current ones on the session's
   * snapshot, and tells followers with a `session.patch` carrying both.
   */
  "sessions.modelSelection.v1",
] as const;
export type KnownExecutionProtocolCapability =
  (typeof EXECUTION_PROTOCOL_CAPABILITY_IDS)[number];
export type ExecutionProtocolCapability =
  KnownExecutionProtocolCapability | (string & {});

export interface ExecutionProtocolDescriptor {
  version: typeof EXECUTION_PROTOCOL_VERSION;
  capabilities: ExecutionProtocolCapability[];
}

export const EXECUTION_SESSION_STATUSES = [
  "idle",
  "running",
  "completed",
  "failed",
] as const;
export type ExecutionSessionStatus =
  (typeof EXECUTION_SESSION_STATUSES)[number];

export const EXECUTION_ATTENTION_STATES = [
  "none",
  "needs-input",
  "needs-approval",
  "finished",
  "failed",
] as const;
export type ExecutionAttentionState =
  (typeof EXECUTION_ATTENTION_STATES)[number];

export type ExecutionActivitySignal =
  | null
  | "streaming"
  | "thinking"
  | "compacting"
  | "waiting-approval"
  | `tool:${string}`;

export type ExecutionContextWindow =
  | {
      availability: "available";
      source: "provider" | "estimated";
      usedTokens: number;
      windowTokens: number;
      usedPercentage: number;
      remainingPercentage: number;
    }
  | {
      availability: "unavailable";
      source: "provider" | "estimated";
      reason: string;
    };

export type ExecutionMetadataAttributes = Record<string, unknown>;

export interface ExecutionSourceMetadata {
  surface: string;
  kind?: string | null;
  id?: string | null;
  url?: string | null;
  attributes?: ExecutionMetadataAttributes;
}

export interface ExecutionUserMetadata {
  id: string;
  displayName?: string | null;
  platformUserId?: string | null;
  username?: string | null;
  attributes?: ExecutionMetadataAttributes;
}

export interface ExecutionThreadMetadata {
  id: string;
  channelId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  rootMessageId?: string | null;
  url?: string | null;
  attributes?: ExecutionMetadataAttributes;
}

export interface ExecutionWorkspaceMetadata {
  id: string;
  branchName?: string | null;
  name?: string | null;
  organizationId?: string | null;
  pullRequestNumber?: number | null;
  ref?: string | null;
  repository?: string | null;
  tenantId?: string | null;
  attributes?: ExecutionMetadataAttributes;
}

export interface ExecutionSessionMetadata {
  source?: ExecutionSourceMetadata;
  user?: ExecutionUserMetadata;
  thread?: ExecutionThreadMetadata;
  workspace?: ExecutionWorkspaceMetadata;
  attributes?: ExecutionMetadataAttributes;
}

export const EXECUTION_ACTOR_KINDS = ["person", "agent"] as const;
export type ExecutionActorKind = (typeof EXECUTION_ACTOR_KINDS)[number];

/**
 * Who sent a command (MAR-3633): a person, or an agent acting on its own.
 *
 * `id` is the sending client's own id for them — accent.'s user id, an agent's
 * handle — and `displayName` the name that client showed when it sent the
 * command. A host stores both as given and never resolves either: with several
 * people driving one session through one client, the client is the only party
 * that knows who they are.
 *
 * Not to be confused with a message item's `actor`, which is its role
 * (`user` or `assistant`); the person behind a user message is its `author`.
 */
export interface ExecutionActor {
  kind: ExecutionActorKind;
  /** Non-empty, at most 256 characters. */
  id: string;
  /** Non-empty, at most 256 characters. */
  displayName: string;
}

export type ExecutionConversationItemState = "streaming" | "complete" | "error";

export interface ExecutionProviderMeta {
  providerId: string;
  providerItemId: string | null;
  providerEventType: string | null;
}

export interface ExecutionConversationItemBase {
  id: string;
  kind: string;
  state: ExecutionConversationItemState;
  createdAt: string;
  updatedAt: string;
  providerMeta: ExecutionProviderMeta;
}

/** Persisted attachment metadata. Bytes are fetched from the owning host. */
export interface ExecutionConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ExecutionMessageDelivery =
  "queued" | "delivered" | "undelivered" | "steered" | "cancelled";

export interface ExecutionInteractionChoiceOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ExecutionInteractionQuestion {
  id: string;
  question: string;
  header: string;
  options: ExecutionInteractionChoiceOption[];
  multiSelect: boolean;
}

export type ExecutionInteractionFormFieldType = "string" | "number" | "boolean";

export interface ExecutionInteractionFormField {
  id: string;
  label: string;
  description?: string;
  type: ExecutionInteractionFormFieldType;
  required: boolean;
  defaultValue?: string | number | boolean;
  multiline?: boolean;
}

/** Structured human input requested by a provider. Unknown future kinds are dropped by tolerant readers. */
export type ExecutionInteractionRequest =
  | { kind: "text"; prompt: string }
  | { kind: "choice"; questions: ExecutionInteractionQuestion[] }
  | {
      kind: "plan";
      plan: string;
      planPath?: string;
      allowedPrompts?: string[];
    }
  | {
      kind: "form";
      title: string;
      message: string;
      fields: ExecutionInteractionFormField[];
    }
  | { kind: "url"; title: string; message: string; url: string };

export type ExecutionInteractionResponse =
  | {
      kind: "choice";
      answers: Array<{ questionId: string; values: string[] }>;
    }
  | { kind: "plan"; decision: "approve" | "reject"; message?: string }
  | {
      kind: "form";
      action: "accept" | "decline";
      values: Record<string, string | number | boolean>;
    }
  | { kind: "url"; action: "accept" | "decline" };

export type ExecutionConversationItem =
  | (ExecutionConversationItemBase & {
      kind: "message";
      /** The message's role. Who wrote a user message is its `author`. */
      actor: "user" | "assistant";
      text: string;
      attachments?: ExecutionConversationAttachment[];
      delivery?: ExecutionMessageDelivery;
      /**
       * Who sent the command that created this user message, echoed from the
       * envelope's `actor` by a host advertising `items.author.v1`. Absent on
       * assistant messages, and on any message whose sender did not say.
       */
      author?: ExecutionActor;
      /**
       * The `commandId` of the request that created this user message — a
       * `send-message` or `steer` envelope, or the start request for the
       * initial message — echoed so a client can match the item to its own
       * send (`items.author.v1`).
       */
      clientMessageId?: string;
    })
  | (ExecutionConversationItemBase & {
      kind: "thinking";
      actor: "assistant";
      text: string;
    })
  | (ExecutionConversationItemBase & {
      kind: "tool-call";
      toolName: string;
      inputText: string;
    })
  | (ExecutionConversationItemBase & {
      kind: "tool-result";
      toolName: string | null;
      relatedItemId: string | null;
      outputText: string;
    })
  | (ExecutionConversationItemBase & {
      kind: "approval-request";
      description: string;
    })
  | (ExecutionConversationItemBase & {
      kind: "input-request";
      prompt: string;
      request?: ExecutionInteractionRequest;
    })
  | (ExecutionConversationItemBase & {
      kind: "note";
      level: "info" | "warning" | "error";
      text: string;
    });

/**
 * Fields fixed when an item is added. A patch never carries them, and a reader
 * ignores them if one does: who sent a message, and which send it answers, do
 * not change after the fact.
 */
type ImmutableConversationItemField =
  "id" | "kind" | "attachments" | "author" | "clientMessageId";

type MutableConversationItemPatch<
  Item extends ExecutionConversationItem = ExecutionConversationItem,
> = Item extends unknown
  ? Partial<Omit<Item, ImmutableConversationItemField>>
  : never;

export type ExecutionConversationItemPatch = MutableConversationItemPatch & {
  /**
   * Text to append to the item's current text, instead of `text` restating the
   * whole thing.
   *
   * A host sends this only to a subscriber that asked for it (see the
   * `deltas.append.v1` capability); every other subscriber keeps receiving
   * full-text patches unchanged. It exists because a patch carrying the whole
   * accumulated reply makes a stream cost the square of its own length: one
   * production session spent 1.51 GB of envelopes on a ~110 KB reply
   * (MAR-2218).
   *
   * Appends apply strictly in `seq` order onto the item's current text. A
   * client that cannot be sure it has every append in order — after a resume,
   * or when it joined mid-item — must not guess: it falls back to the session
   * snapshot, or to the item's next full-text patch, both of which always
   * carry the complete text.
   *
   * `text` and `textAppend` are alternatives, never a pair to merge: when both
   * are present, `text` is authoritative and `textAppend` is redundant.
   */
  textAppend?: string;
};

export type ExecutionTurnStatus = "running" | "completed" | "errored";
export type ExecutionTurnFileChangeStatus = "added" | "modified" | "deleted";

export interface ExecutionTurn {
  id: string;
  sessionId: string;
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  status: ExecutionTurnStatus;
  summary: string | null;
}

export interface ExecutionTurnFileChange {
  id: string;
  sessionId: string;
  turnId: string;
  /** Workspace-relative repository root. Absent means the workingDirectory root repository. */
  repoRoot?: string;
  filePath: string;
  oldPath: null;
  status: ExecutionTurnFileChangeStatus;
  additions: number;
  deletions: number;
  diff: string;
  truncated: boolean;
  binary: boolean;
  createdAt: string;
}

export type ExecutionSessionDelta =
  | {
      kind: "session.patch";
      patch: {
        status?: ExecutionSessionStatus;
        attention?: ExecutionAttentionState;
        activity?: ExecutionActivitySignal;
        contextWindow?: ExecutionContextWindow;
        continuationToken?: string | null;
        prUrl?: string | null;
        roomId?: string | null;
        /**
         * The model the session's turns run on from the next one, after a
         * change between turns (`sessions.modelSelection.v1`); null is the
         * provider's default. A host sends `effort` with it: the two are one
         * selection.
         *
         * A turn runs on the selection in force when its `turn.add` was sent.
         * One already running when this arrives keeps what it started with.
         */
        model?: string | null;
        /** The reasoning effort those turns run with; null is the model's default. */
        effort?: string | null;
        updatedAt?: string;
      };
    }
  | { kind: "conversation.item.add"; item: ExecutionConversationItem }
  | {
      kind: "conversation.item.patch";
      itemId: string;
      patch: ExecutionConversationItemPatch;
    }
  | { kind: "turn.add"; turn: ExecutionTurn }
  | {
      kind: "turn.patch";
      turnId: string;
      patch: Partial<Pick<ExecutionTurn, "endedAt" | "status" | "summary">>;
    }
  | {
      kind: "turn.fileChanges.add";
      turnId: string;
      fileChanges: ExecutionTurnFileChange[];
    };

export type ExecutionHostEvent =
  | { kind: "delta"; delta: ExecutionSessionDelta }
  | { kind: "status"; status: ExecutionSessionStatus }
  | { kind: "attention"; attention: ExecutionAttentionState }
  | { kind: "continuation-token"; token: string }
  | { kind: "context-window"; contextWindow: ExecutionContextWindow }
  | { kind: "activity"; activity: ExecutionActivitySignal }
  | { kind: "heartbeat" };

export interface ExecutionHostEventEnvelope {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  seq: number;
  event: ExecutionHostEvent;
}

export interface ExecutionSendMessageOptions {
  deliveryMode?: string;
  queuedInputId?: string | null;
  expectedProviderTurnId?: string | null;
  interactionResponse?: ExecutionInteractionResponse;
  metadata?: ExecutionSessionMetadata | null;
}

/**
 * Small image transported inline with a start or command envelope. The daemon
 * owns byte decoding, limits, staging, and cleanup. The legacy `attachments`
 * command field remains opaque for compatibility with existing consumers.
 */
export interface ExecutionInlineImageAttachment {
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

export type ExecutionPermissionPreset = "ask" | "yolo" | "custom";
export type ExecutionCodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type ExecutionCodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access";
export type ExecutionClaudePermissionMode =
  "default" | "acceptEdits" | "auto" | "dontAsk" | "plan" | "bypassPermissions";

/** Provider permission policy selected for a Session. */
export interface ExecutionPermissionConfig {
  preset: ExecutionPermissionPreset;
  codex?: {
    approvalPolicy: ExecutionCodexApprovalPolicy;
    sandbox: ExecutionCodexSandboxMode;
  };
  claudeCode?: {
    permissionMode: ExecutionClaudePermissionMode;
  };
}

/** A bounded retained-message passage supplied as untrusted research evidence. */
export interface ExecutionResearchEvidenceSource {
  sourceId: string;
  endpointId: string;
  endpointName: string;
  sessionId: string;
  itemId: string;
  sessionTitle: string | null;
  providerId: string;
  createdAt: string;
  text: string;
}

/** Point-in-time evidence gathered by a client before one research turn. */
export interface ExecutionResearchEvidencePack {
  capturedAt: string;
  question: string;
  coverage: {
    selectedEndpointCount: number;
    searchedEndpointCount: number;
    candidatePassageCount: number;
    failedEndpointIds: string[];
    indexingEndpointIds: string[];
  };
  sources: ExecutionResearchEvidenceSource[];
}

export type ExecutionHostCommand =
  | {
      kind: "send-message";
      text: string;
      attachments?: unknown[];
      inlineAttachments?: ExecutionInlineImageAttachment[];
      skillSelections?: unknown[];
      options?: ExecutionSendMessageOptions;
      researchEvidence?: ExecutionResearchEvidencePack;
    }
  | { kind: "approve"; providerApprovalId?: string }
  | { kind: "deny"; providerApprovalId?: string }
  | {
      kind: "steer";
      text: string;
      expectedProviderTurnId?: string;
    }
  | { kind: "interrupt"; expectedProviderTurnId?: string }
  | { kind: "cancel-queued"; itemId: string }
  | { kind: "stop" };

export interface ExecutionHostCommandEnvelope {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  /**
   * The client's own id for this command: non-empty, at most 256 characters,
   * unique within the session (a UUID will do). A retry of the same command
   * carries the same id. The user message a `send-message` or `steer` creates
   * echoes it as `clientMessageId` (MAR-3633).
   */
  commandId?: string;
  /** Who sent the command (MAR-3633). Absent means the sender did not say. */
  actor?: ExecutionActor;
  command: ExecutionHostCommand;
}

export interface ExecutionStartConfig {
  sessionId: string;
  workingDirectory?: string;
  initialMessage: string;
  model: string | null;
  effort: string | null;
  continuationToken: string | null;
  /** Named Room whose memory should orient this Session. */
  roomId?: string;
  permissionConfig?: ExecutionPermissionConfig;
  /** @deprecated Use permissionConfig. Retained for existing clients. */
  automationMode?: boolean;
  inlineAttachments?: ExecutionInlineImageAttachment[];
  researchEvidence?: ExecutionResearchEvidencePack;
}

export interface ExecutionRoom {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  sessionCount: number;
  /** Absent on hosts predating the asynchronous founding lifecycle. */
  founding?: "pending" | "furnished" | "failed";
  foundingMemoryEntryCount?: number | null;
  foundingError?: string | null;
}

export interface ExecutionRoomListResponse {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  rooms: ExecutionRoom[];
}

export interface ExecutionRoomChristenRequest {
  name: string;
  sessionId: string;
}

export interface ExecutionRoomChristenResponse {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  room: ExecutionRoom;
  /** New daemons return pending immediately; retained clients can ignore it. */
  founding?: "pending" | "furnished" | "failed";
  /** Retained for clients from the synchronous christening era. */
  foundingMemoryEntryCount: number;
}

export interface ExecutionWorkspaceSource {
  repository: string;
  ref?: string | null;
  branchName?: string | null;
}

export interface ExecutionCallbackConfig {
  url: string;
  secret: string;
}

export interface ExecutionAutomationConfig {
  autoCreatePr?: boolean;
}

export interface ExecutionStartRequest {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  providerId: string;
  config: ExecutionStartConfig;
  metadata?: ExecutionSessionMetadata | null;
  workspace?: ExecutionWorkspaceSource;
  callback?: ExecutionCallbackConfig;
  automation?: ExecutionAutomationConfig;
  /**
   * The named Environment on the host whose declared variables this session
   * should be prepared with (ADR-0011). A residency (Project) that names none
   * gets the Project's default; an errand that names none runs naked, on the
   * base set alone. The host never infers it, and a value never travels here —
   * this is a name, and the host holds what it stands for.
   */
  environment?: string | null;
  /**
   * The client's id for this start, as on a command envelope. The session's
   * initial user message echoes it as `clientMessageId` (MAR-3633).
   */
  commandId?: string;
  /** Who started the session, and so wrote its initial message (MAR-3633). */
  actor?: ExecutionActor;
}

/**
 * A change to a session's settings: the body of
 * `PATCH /v0/execution/sessions/:sessionId` (MAR-3662).
 *
 * Every field is optional, and one left out keeps its value; but a patch names
 * at least one, and a field the host does not know is refused rather than
 * dropped — a misspelt field that was dropped would read as a change made.
 *
 * `model` and `effort` are what the session's turns run on. On a host
 * advertising `sessions.modelSelection.v1` they change between turns: the host
 * takes the change at any time, leaves a turn already running on what it
 * started with, and runs every turn that starts afterwards on the new
 * selection, resuming the same conversation. It checks the selection against
 * its provider's catalog of models and the efforts each takes, and refuses one
 * the catalog does not offer.
 */
export interface ExecutionSessionPatchRequest {
  /** The session's display title; null clears it. The host may shorten it, and refuses a blank one. */
  title?: string | null;
  /** The model the session's turns run on from the next one; null is the provider's default. */
  model?: string | null;
  /** The reasoning effort they run with; null is the model's default. */
  effort?: string | null;
}

/**
 * A host's answer to a session patch (MAR-3662). A patch naming a model or an
 * effort is answered with the selection the session's next turn will run on —
 * `model` and `effort` both, whichever one it named — and with the title as
 * the host stored it, when it named one too. A patch naming only a title is
 * answered as hosts have always answered one: `{ sessionId, title }`.
 */
export interface ExecutionSessionPatchResponse {
  /** Absent from a title-only answer, which predates the contract. */
  protocolVersion?: typeof EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  title?: string | null;
  model?: string | null;
  effort?: string | null;
}

/**
 * Where a session actually worked, as the host prepared it — not as the client
 * asked. The two modes are the daemon's own vocabulary (ADR-0011 §2): an
 * **errand** clones a repository and disposes of it, a **residency** runs in a
 * standing Project on the host's shelf.
 *
 * `environment` is the name the host resolved, `null` when the session ran on
 * the base set alone. Nothing here is inferred: in project mode `branchName` is
 * the checkout's actual HEAD at start, and when the dispatcher asked for a
 * different one `requestedBranchName` reports what was asked so the two can be
 * compared instead of silently reconciled.
 */
export type ExecutionSessionWorkspace =
  | {
      mode: "repository";
      repository: string;
      branchName: string;
      baseRef: string;
      /** Absent on hosts that did not report the clone's path. */
      workspacePath: string | null;
      environment: string | null;
    }
  | {
      mode: "project";
      projectId: string;
      workingDirectory: string;
      /** Remote URL of the checkout, credential-redacted; null for non-git. */
      origin: string | null;
      /** `normalizeOriginKey(origin)` — the join key clients compare on. */
      originKey: string | null;
      /** Actual HEAD at start; null when detached or not a git checkout. */
      branchName: string | null;
      requestedBranchName?: string | null;
      environment: string | null;
    };

/** One Environment a Project may be started with, and whether it is ready. */
export interface ExecutionProjectEnvironmentRef {
  name: string;
  /** True for the Project's default — the one a session gets by naming none. */
  default: boolean;
  /** Every declared key of this environment is present on the host. */
  provisioned: boolean;
  /** Declared keys the host does not have. NAMES ONLY — never values. */
  missing: string[];
}

/**
 * A standing anchored workspace this host advertises. `origin`/`originKey` and
 * `environments` are derived facts the host computes at catalog load; they are
 * read-only and absent on hosts predating `projects.v2`.
 */
export interface ExecutionProject {
  id: string;
  name: string;
  workingDirectory: string;
  origin: string | null;
  originKey: string | null;
  environments: ExecutionProjectEnvironmentRef[];
}

export interface ExecutionProjectListResponse {
  /** Absent on hosts that served projects before the payload was contracted. */
  protocolVersion?: typeof EXECUTION_PROTOCOL_VERSION;
  projects: ExecutionProject[];
}

/**
 * A named template on a host: declared variable NAMES, never their values.
 * Values live in one file per environment on the box and never cross this wire
 * — a payload carrying a `values` field is rejected outright, not sanitised,
 * because a host that offered one has misunderstood the contract (ADR-0011 §5).
 */
export interface ExecutionEnvironment {
  name: string;
  keys: string[];
  /** Composition: this environment's bundle unions its includes'; own keys win. */
  includes?: string[];
  provisioned: boolean;
  missing: string[];
}

export interface ExecutionEnvironmentListResponse {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  environments: ExecutionEnvironment[];
}

/** The declarable half of an Environment: its shape, never its contents. */
export interface ExecutionEnvironmentDeclaration {
  /** Optional in a PUT body; the URL names the environment. */
  name?: string;
  keys: string[];
  includes?: string[];
}

export type ExecutionDecodeFailureReason =
  | "malformed-json"
  | "unsupported-protocol-version"
  | "invalid-envelope"
  | "unknown-kind"
  | "invalid-payload";

export interface ExecutionDecodeWarning {
  reason: "dropped-invalid-field";
  path: string;
}

/**
 * A well-formed event envelope of a kind this reader does not know (MAR-3633).
 *
 * Not a broken frame: a host newer than this build sent something it predates.
 * The envelope cannot be applied, but its place in the stream is certain, so a
 * reader steps over it — advances its cursor to `seq` — instead of treating it
 * as lost. That is what lets a host add an event, delta or item kind without
 * breaking the readers that do not know it.
 */
export interface ExecutionSkippedEnvelope {
  sessionId: string;
  seq: number;
  /**
   * The discriminant that was not recognised: `event.kind`,
   * `event.delta.kind`, or `event.delta.item.kind`.
   */
  path: string;
  /** Its value, for a log line. */
  kind: string;
}

export type ExecutionDecodeResult<T> =
  | { ok: true; value: T; warnings?: ExecutionDecodeWarning[] }
  | {
      ok: false;
      reason: ExecutionDecodeFailureReason;
      /**
       * Present only from `decodeExecutionEventEnvelope`, with reason
       * `unknown-kind`: where the unknown envelope sat, so a stream reader can
       * skip it and keep its place.
       */
      skipped?: ExecutionSkippedEnvelope;
    };
