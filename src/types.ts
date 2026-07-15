export const EXECUTION_PROTOCOL_VERSION = 1 as const;

export const EXECUTION_PROTOCOL_CAPABILITY_IDS = [
  "commands.approval",
  "events.replay",
  "sessions.metadata",
  "workspaces.materialize",
  "callbacks.status",
  "automation.create-pr",
  "attachments.inline-image",
  "turns.fileChanges",
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
  "queued" | "delivered" | "undelivered" | "steered";

export type ExecutionConversationItem =
  | (ExecutionConversationItemBase & {
      kind: "message";
      actor: "user" | "assistant";
      text: string;
      attachments?: ExecutionConversationAttachment[];
      delivery?: ExecutionMessageDelivery;
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
    })
  | (ExecutionConversationItemBase & {
      kind: "note";
      level: "info" | "warning" | "error";
      text: string;
    });

type MutableConversationItemPatch<
  Item extends ExecutionConversationItem = ExecutionConversationItem,
> = Item extends unknown
  ? Partial<Omit<Item, "id" | "kind" | "attachments">>
  : never;

export type ExecutionConversationItemPatch = MutableConversationItemPatch;

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
  interactionResponse?: unknown;
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

export type ExecutionHostCommand =
  | {
      kind: "send-message";
      text: string;
      attachments?: unknown[];
      inlineAttachments?: ExecutionInlineImageAttachment[];
      skillSelections?: unknown[];
      options?: ExecutionSendMessageOptions;
    }
  | { kind: "approve"; providerApprovalId?: string }
  | { kind: "deny"; providerApprovalId?: string }
  | {
      kind: "steer";
      text: string;
      expectedProviderTurnId?: string;
    }
  | { kind: "interrupt"; expectedProviderTurnId?: string }
  | { kind: "stop" };

export interface ExecutionHostCommandEnvelope {
  protocolVersion: typeof EXECUTION_PROTOCOL_VERSION;
  sessionId: string;
  command: ExecutionHostCommand;
}

export interface ExecutionStartConfig {
  sessionId: string;
  workingDirectory?: string;
  initialMessage: string;
  model: string | null;
  effort: string | null;
  continuationToken: string | null;
  permissionConfig?: ExecutionPermissionConfig;
  /** @deprecated Use permissionConfig. Retained for existing clients. */
  automationMode?: boolean;
  inlineAttachments?: ExecutionInlineImageAttachment[];
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

export type ExecutionDecodeResult<T> =
  | { ok: true; value: T; warnings?: ExecutionDecodeWarning[] }
  | {
      ok: false;
      reason: ExecutionDecodeFailureReason;
    };
