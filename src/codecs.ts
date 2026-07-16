import {
  EXECUTION_ATTENTION_STATES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_STATUSES,
  type ExecutionActivitySignal,
  type ExecutionAttentionState,
  type ExecutionAutomationConfig,
  type ExecutionCallbackConfig,
  type ExecutionContextWindow,
  type ExecutionConversationItem,
  type ExecutionConversationAttachment,
  type ExecutionConversationItemBase,
  type ExecutionConversationItemPatch,
  type ExecutionConversationItemState,
  type ExecutionDecodeFailureReason,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionInlineImageAttachment,
  type ExecutionMessageDelivery,
  type ExecutionMetadataAttributes,
  type ExecutionPermissionConfig,
  type ExecutionProtocolDescriptor,
  type ExecutionProviderMeta,
  type ExecutionSendMessageOptions,
  type ExecutionSessionDelta,
  type ExecutionSessionMetadata,
  type ExecutionSessionStatus,
  type ExecutionTurn,
  type ExecutionTurnFileChange,
  type ExecutionStartConfig,
  type ExecutionStartRequest,
  type ExecutionWorkspaceSource,
} from "./types.js";

const ITEM_KINDS = new Set([
  "message",
  "thinking",
  "tool-call",
  "tool-result",
  "approval-request",
  "input-request",
  "note",
]);
const CONVERSATION_ITEM_FIELD_VALIDATORS = {
  id: isNonEmptyString,
  kind: (value: unknown) => typeof value === "string" && ITEM_KINDS.has(value),
  state: isItemState,
  createdAt: (value: unknown) => typeof value === "string",
  updatedAt: (value: unknown) => typeof value === "string",
  providerMeta: isProviderMeta,
  actor: (value: unknown) => value === "user" || value === "assistant",
  text: (value: unknown) => typeof value === "string",
  toolName: isNullableString,
  inputText: (value: unknown) => typeof value === "string",
  relatedItemId: isNullableString,
  outputText: (value: unknown) => typeof value === "string",
  description: (value: unknown) => typeof value === "string",
  prompt: (value: unknown) => typeof value === "string",
  level: isNoteLevel,
  delivery: isMessageDelivery,
} satisfies Record<string, (value: unknown) => boolean>;
type ConversationItemField = keyof typeof CONVERSATION_ITEM_FIELD_VALIDATORS;

const PATCH_FIELDS = [
  "state",
  "createdAt",
  "updatedAt",
  "providerMeta",
  "actor",
  "text",
  "toolName",
  "inputText",
  "relatedItemId",
  "outputText",
  "description",
  "prompt",
  "level",
  "delivery",
] as const satisfies readonly ConversationItemField[];
type PatchField = (typeof PATCH_FIELDS)[number];
const PATCH_FIELD_SET = new Set<string>(PATCH_FIELDS);

export function encodeExecutionEventEnvelope(
  envelope: ExecutionHostEventEnvelope,
): string {
  return JSON.stringify(envelope);
}

export function encodeExecutionCommandEnvelope(
  envelope: ExecutionHostCommandEnvelope,
): string {
  return JSON.stringify(envelope);
}

export function encodeExecutionStartRequest(
  request: ExecutionStartRequest,
): string {
  return JSON.stringify(request);
}

export function decodeExecutionProtocolDescriptor(
  raw: unknown,
): ExecutionDecodeResult<ExecutionProtocolDescriptor> {
  if (!isRecord(raw)) return failure("invalid-envelope");
  if (raw.version !== EXECUTION_PROTOCOL_VERSION) {
    return failure("unsupported-protocol-version");
  }
  if (
    !Array.isArray(raw.capabilities) ||
    !raw.capabilities.every(isNonEmptyString)
  ) {
    return failure("invalid-payload");
  }
  return success({
    version: EXECUTION_PROTOCOL_VERSION,
    capabilities: [...new Set(raw.capabilities)],
  });
}

export function decodeExecutionEventEnvelope(
  raw: string,
): ExecutionDecodeResult<ExecutionHostEventEnvelope> {
  const base = parseBase(raw);
  if (!base.ok) return base;
  const { sessionId, seq, event: rawEvent } = base.value;
  if (!isNonEmptyString(sessionId) || !isPositiveInteger(seq)) {
    return failure("invalid-envelope");
  }
  const event = decodeEvent(rawEvent);
  if (!event.ok) return event;
  return success(
    {
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      sessionId,
      seq,
      event: event.value,
    },
    event.warnings,
  );
}

export function decodeExecutionCommandEnvelope(
  raw: string,
): ExecutionDecodeResult<ExecutionHostCommandEnvelope> {
  const base = parseBase(raw);
  if (!base.ok) return base;
  if (!isNonEmptyString(base.value.sessionId))
    return failure("invalid-envelope");
  const command = decodeCommand(base.value.command);
  if (!command.ok) return command;
  return success({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: base.value.sessionId,
    command: command.value,
  });
}

export function decodeExecutionStartRequest(
  raw: string,
): ExecutionDecodeResult<ExecutionStartRequest> {
  const base = parseBase(raw);
  if (!base.ok) return base;
  if (!isNonEmptyString(base.value.providerId))
    return failure("invalid-envelope");
  const config = decodeStartConfig(base.value.config);
  if (!config.ok) return config;
  const metadata = decodeOptionalMetadata(base.value.metadata);
  if (!metadata.ok) return metadata;
  const workspace = decodeOptionalWorkspace(base.value.workspace);
  if (!workspace.ok) return workspace;
  const callback = decodeOptionalCallback(base.value.callback);
  if (!callback.ok) return callback;
  const automation = decodeOptionalAutomation(base.value.automation);
  if (!automation.ok) return automation;

  return success({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId: base.value.providerId,
    config: config.value,
    ...optionalProperty("metadata", metadata.value),
    ...optionalProperty("workspace", workspace.value),
    ...optionalProperty("callback", callback.value),
    ...optionalProperty("automation", automation.value),
  });
}

function decodeEvent(raw: unknown): ExecutionDecodeResult<ExecutionHostEvent> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return failure("invalid-envelope");
  }
  switch (raw.kind) {
    case "delta": {
      const delta = decodeDelta(raw.delta);
      return delta.ok
        ? success({ kind: "delta", delta: delta.value }, delta.warnings)
        : delta;
    }
    case "status": {
      const status = decodeStatus(raw.status);
      return status
        ? success({ kind: "status", status })
        : failure("invalid-payload");
    }
    case "attention": {
      const attention = decodeAttention(raw.attention);
      return attention
        ? success({ kind: "attention", attention })
        : failure("invalid-payload");
    }
    case "continuation-token":
      return typeof raw.token === "string"
        ? success({ kind: "continuation-token", token: raw.token })
        : failure("invalid-payload");
    case "context-window": {
      const contextWindow = decodeContextWindow(raw.contextWindow);
      return contextWindow
        ? success({ kind: "context-window", contextWindow })
        : failure("invalid-payload");
    }
    case "activity": {
      const activity = decodeActivity(raw.activity);
      return activity.valid
        ? success({ kind: "activity", activity: activity.value })
        : failure("invalid-payload");
    }
    case "heartbeat":
      return success({ kind: "heartbeat" });
    default:
      return failure("unknown-kind");
  }
}

function decodeDelta(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionDelta> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return failure("invalid-payload");
  }
  switch (raw.kind) {
    case "session.patch": {
      if (!isRecord(raw.patch)) return failure("invalid-payload");
      const patch: Extract<
        ExecutionSessionDelta,
        { kind: "session.patch" }
      >["patch"] = {};
      if (raw.patch.status !== undefined) {
        const status = decodeStatus(raw.patch.status);
        if (!status) return failure("invalid-payload");
        patch.status = status;
      }
      if (raw.patch.attention !== undefined) {
        const attention = decodeAttention(raw.patch.attention);
        if (!attention) return failure("invalid-payload");
        patch.attention = attention;
      }
      if (raw.patch.activity !== undefined) {
        const activity = decodeActivity(raw.patch.activity);
        if (!activity.valid) return failure("invalid-payload");
        patch.activity = activity.value;
      }
      if (raw.patch.contextWindow !== undefined) {
        const contextWindow = decodeContextWindow(raw.patch.contextWindow);
        if (!contextWindow) return failure("invalid-payload");
        patch.contextWindow = contextWindow;
      }
      if (raw.patch.continuationToken !== undefined) {
        if (
          raw.patch.continuationToken !== null &&
          typeof raw.patch.continuationToken !== "string"
        ) {
          return failure("invalid-payload");
        }
        patch.continuationToken = raw.patch.continuationToken;
      }
      if (raw.patch.prUrl !== undefined) {
        if (raw.patch.prUrl !== null && !isHttpUrl(raw.patch.prUrl)) {
          return failure("invalid-payload");
        }
        patch.prUrl = raw.patch.prUrl;
      }
      if (raw.patch.updatedAt !== undefined) {
        if (typeof raw.patch.updatedAt !== "string")
          return failure("invalid-payload");
        patch.updatedAt = raw.patch.updatedAt;
      }
      return success({ kind: "session.patch", patch });
    }
    case "conversation.item.add": {
      const item = decodeConversationItem(raw.item);
      return item.ok
        ? success(
            { kind: "conversation.item.add", item: item.value },
            item.warnings,
          )
        : item;
    }
    case "conversation.item.patch": {
      if (!isNonEmptyString(raw.itemId) || !isRecord(raw.patch)) {
        return failure("invalid-payload");
      }
      const patch: Record<string, unknown> = {};
      const warnings: ExecutionDecodeWarning[] = [];
      for (const [key, value] of Object.entries(raw.patch)) {
        if (!PATCH_FIELD_SET.has(key)) continue;
        const field = key as PatchField;
        if (CONVERSATION_ITEM_FIELD_VALIDATORS[field](value)) {
          patch[field] = value;
        } else {
          warnings.push({
            reason: "dropped-invalid-field",
            path: `event.delta.patch.${field}`,
          });
        }
      }
      return success(
        {
          kind: "conversation.item.patch",
          itemId: raw.itemId,
          patch: patch as ExecutionConversationItemPatch,
        },
        warnings,
      );
    }
    case "turn.add": {
      const turn = decodeTurn(raw.turn);
      return turn
        ? success({ kind: "turn.add", turn })
        : failure("invalid-payload");
    }
    case "turn.patch": {
      if (!isNonEmptyString(raw.turnId) || !isRecord(raw.patch)) {
        return failure("invalid-payload");
      }
      const patch: Extract<
        ExecutionSessionDelta,
        { kind: "turn.patch" }
      >["patch"] = {};
      if (raw.patch.endedAt !== undefined) {
        if (raw.patch.endedAt !== null && typeof raw.patch.endedAt !== "string")
          return failure("invalid-payload");
        patch.endedAt = raw.patch.endedAt;
      }
      if (raw.patch.status !== undefined) {
        if (!isTurnStatus(raw.patch.status)) return failure("invalid-payload");
        patch.status = raw.patch.status;
      }
      if (raw.patch.summary !== undefined) {
        if (raw.patch.summary !== null && typeof raw.patch.summary !== "string")
          return failure("invalid-payload");
        patch.summary = raw.patch.summary;
      }
      return success({ kind: "turn.patch", turnId: raw.turnId, patch });
    }
    case "turn.fileChanges.add": {
      if (!isNonEmptyString(raw.turnId) || !Array.isArray(raw.fileChanges)) {
        return failure("invalid-payload");
      }
      const fileChanges = raw.fileChanges.map(decodeTurnFileChange);
      return fileChanges.every(
        (change): change is ExecutionTurnFileChange => change !== null,
      )
        ? success({
            kind: "turn.fileChanges.add",
            turnId: raw.turnId,
            fileChanges,
          })
        : failure("invalid-payload");
    }
    default:
      return failure("unknown-kind");
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeTurn(raw: unknown): ExecutionTurn | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.sessionId) ||
    !Number.isInteger(raw.sequence) ||
    (raw.sequence as number) < 1 ||
    typeof raw.startedAt !== "string" ||
    (raw.endedAt !== null && typeof raw.endedAt !== "string") ||
    !isTurnStatus(raw.status) ||
    (raw.summary !== null && typeof raw.summary !== "string")
  ) {
    return null;
  }
  return raw as unknown as ExecutionTurn;
}

function decodeTurnFileChange(raw: unknown): ExecutionTurnFileChange | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.sessionId) ||
    !isNonEmptyString(raw.turnId) ||
    !isNonEmptyString(raw.filePath) ||
    raw.oldPath !== null ||
    !isTurnFileChangeStatus(raw.status) ||
    !Number.isInteger(raw.additions) ||
    (raw.additions as number) < 0 ||
    !Number.isInteger(raw.deletions) ||
    (raw.deletions as number) < 0 ||
    typeof raw.diff !== "string" ||
    typeof raw.truncated !== "boolean" ||
    typeof raw.binary !== "boolean" ||
    typeof raw.createdAt !== "string"
  ) {
    return null;
  }
  return raw as unknown as ExecutionTurnFileChange;
}

function isTurnStatus(value: unknown): value is ExecutionTurn["status"] {
  return value === "running" || value === "completed" || value === "errored";
}

function isTurnFileChangeStatus(
  value: unknown,
): value is ExecutionTurnFileChange["status"] {
  return value === "added" || value === "modified" || value === "deleted";
}

function decodeConversationItem(
  raw: unknown,
): ExecutionDecodeResult<ExecutionConversationItem> {
  if (
    !isRecord(raw) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.id(raw.id) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.kind(raw.kind) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.state(raw.state) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.createdAt(raw.createdAt) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.updatedAt(raw.updatedAt) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.providerMeta(raw.providerMeta)
  ) {
    return failure("invalid-payload");
  }
  const base: ExecutionConversationItemBase = {
    id: raw.id as string,
    kind: raw.kind as string,
    state: raw.state as ExecutionConversationItemState,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
    providerMeta: raw.providerMeta as ExecutionProviderMeta,
  };
  switch (raw.kind) {
    case "message": {
      if (
        !CONVERSATION_ITEM_FIELD_VALIDATORS.actor(raw.actor) ||
        !CONVERSATION_ITEM_FIELD_VALIDATORS.text(raw.text)
      ) {
        return failure("invalid-payload");
      }
      const attachments = decodeConversationAttachments(raw.attachments);
      const delivery = decodeOptionalMessageDelivery(raw.delivery);
      return success(
        {
          ...base,
          kind: "message",
          actor: raw.actor as "user" | "assistant",
          text: raw.text as string,
          ...optionalProperty("attachments", attachments.value),
          ...optionalProperty("delivery", delivery.value),
        },
        [...attachments.warnings, ...delivery.warnings],
      );
    }
    case "thinking":
      return raw.actor === "assistant" &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.text(raw.text)
        ? success({
            ...base,
            kind: "thinking",
            actor: "assistant",
            text: raw.text as string,
          })
        : failure("invalid-payload");
    case "tool-call":
      return raw.toolName !== null &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.toolName(raw.toolName) &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.inputText(raw.inputText)
        ? success({
            ...base,
            kind: "tool-call",
            toolName: raw.toolName as string,
            inputText: raw.inputText as string,
          })
        : failure("invalid-payload");
    case "tool-result":
      return CONVERSATION_ITEM_FIELD_VALIDATORS.toolName(raw.toolName) &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.relatedItemId(raw.relatedItemId) &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.outputText(raw.outputText)
        ? success({
            ...base,
            kind: "tool-result",
            toolName: raw.toolName as string | null,
            relatedItemId: raw.relatedItemId as string | null,
            outputText: raw.outputText as string,
          })
        : failure("invalid-payload");
    case "approval-request":
      return CONVERSATION_ITEM_FIELD_VALIDATORS.description(raw.description)
        ? success({
            ...base,
            kind: "approval-request",
            description: raw.description as string,
          })
        : failure("invalid-payload");
    case "input-request":
      return CONVERSATION_ITEM_FIELD_VALIDATORS.prompt(raw.prompt)
        ? success({
            ...base,
            kind: "input-request",
            prompt: raw.prompt as string,
          })
        : failure("invalid-payload");
    case "note":
      return CONVERSATION_ITEM_FIELD_VALIDATORS.level(raw.level) &&
        CONVERSATION_ITEM_FIELD_VALIDATORS.text(raw.text)
        ? success({
            ...base,
            kind: "note",
            level: raw.level as "info" | "warning" | "error",
            text: raw.text as string,
          })
        : failure("invalid-payload");
    default:
      return failure("unknown-kind");
  }
}

function decodeConversationAttachments(raw: unknown): {
  value: ExecutionConversationAttachment[] | undefined;
  warnings: ExecutionDecodeWarning[];
} {
  if (raw === undefined) return { value: undefined, warnings: [] };
  if (!Array.isArray(raw)) {
    return {
      value: undefined,
      warnings: [
        {
          reason: "dropped-invalid-field",
          path: "event.delta.item.attachments",
        },
      ],
    };
  }

  const value: ExecutionConversationAttachment[] = [];
  const warnings: ExecutionDecodeWarning[] = [];
  for (const [index, attachment] of raw.entries()) {
    if (
      isRecord(attachment) &&
      isNonEmptyString(attachment.id) &&
      isNonEmptyString(attachment.name) &&
      isNonEmptyString(attachment.mimeType) &&
      typeof attachment.sizeBytes === "number" &&
      Number.isInteger(attachment.sizeBytes) &&
      attachment.sizeBytes >= 0
    ) {
      value.push({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      });
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `event.delta.item.attachments.${index}`,
      });
    }
  }
  return { value, warnings };
}

function decodeOptionalMessageDelivery(raw: unknown): {
  value: ExecutionMessageDelivery | undefined;
  warnings: ExecutionDecodeWarning[];
} {
  if (raw === undefined) return { value: undefined, warnings: [] };
  if (isMessageDelivery(raw)) return { value: raw, warnings: [] };
  return {
    value: undefined,
    warnings: [
      {
        reason: "dropped-invalid-field",
        path: "event.delta.item.delivery",
      },
    ],
  };
}

function decodeCommand(
  raw: unknown,
): ExecutionDecodeResult<ExecutionHostCommand> {
  if (!isRecord(raw) || typeof raw.kind !== "string")
    return failure("invalid-envelope");
  if (raw.kind === "stop") return success({ kind: "stop" });
  if (raw.kind === "approve" || raw.kind === "deny") {
    if (
      raw.providerApprovalId !== undefined &&
      typeof raw.providerApprovalId !== "string"
    ) {
      return failure("invalid-payload");
    }
    return success({
      kind: raw.kind,
      ...optionalProperty("providerApprovalId", raw.providerApprovalId),
    });
  }
  if (raw.kind === "steer") {
    if (
      typeof raw.text !== "string" ||
      (raw.expectedProviderTurnId !== undefined &&
        typeof raw.expectedProviderTurnId !== "string")
    ) {
      return failure("invalid-payload");
    }
    return success({
      kind: "steer",
      text: raw.text,
      ...optionalProperty("expectedProviderTurnId", raw.expectedProviderTurnId),
    });
  }
  if (raw.kind === "interrupt") {
    if (
      raw.expectedProviderTurnId !== undefined &&
      typeof raw.expectedProviderTurnId !== "string"
    ) {
      return failure("invalid-payload");
    }
    return success({
      kind: "interrupt",
      ...optionalProperty("expectedProviderTurnId", raw.expectedProviderTurnId),
    });
  }
  if (raw.kind === "cancel-queued") {
    if (!isNonEmptyString(raw.itemId)) return failure("invalid-payload");
    return success({ kind: "cancel-queued", itemId: raw.itemId });
  }
  if (raw.kind !== "send-message") return failure("unknown-kind");
  if (typeof raw.text !== "string") return failure("invalid-payload");
  if (raw.attachments !== undefined && !Array.isArray(raw.attachments))
    return failure("invalid-payload");
  const inlineAttachments = decodeOptionalInlineImageAttachments(
    raw.inlineAttachments,
  );
  if (!inlineAttachments.ok) return inlineAttachments;
  if (raw.skillSelections !== undefined && !Array.isArray(raw.skillSelections))
    return failure("invalid-payload");
  const options = decodeOptionalSendOptions(raw.options);
  if (!options.ok) return options;
  return success({
    kind: "send-message",
    text: raw.text,
    ...optionalProperty("attachments", raw.attachments),
    ...optionalProperty("inlineAttachments", inlineAttachments.value),
    ...optionalProperty("skillSelections", raw.skillSelections),
    ...optionalProperty("options", options.value),
  });
}

function decodeOptionalSendOptions(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSendMessageOptions | undefined> {
  if (raw === undefined) return success(undefined);
  if (!isRecord(raw)) return failure("invalid-payload");
  const metadata = decodeOptionalMetadata(raw.metadata);
  if (!metadata.ok) return metadata;
  if (raw.deliveryMode !== undefined && typeof raw.deliveryMode !== "string")
    return failure("invalid-payload");
  if (
    !isOptionalNullableString(raw.queuedInputId) ||
    !isOptionalNullableString(raw.expectedProviderTurnId)
  ) {
    return failure("invalid-payload");
  }
  return success({
    ...optionalProperty("deliveryMode", raw.deliveryMode),
    ...optionalProperty(
      "queuedInputId",
      raw.queuedInputId as string | null | undefined,
    ),
    ...optionalProperty(
      "expectedProviderTurnId",
      raw.expectedProviderTurnId as string | null | undefined,
    ),
    ...optionalProperty("interactionResponse", raw.interactionResponse),
    ...optionalProperty("metadata", metadata.value),
  });
}

function decodeStartConfig(
  raw: unknown,
): ExecutionDecodeResult<ExecutionStartConfig> {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.sessionId) ||
    typeof raw.initialMessage !== "string"
  ) {
    return failure("invalid-envelope");
  }
  if (
    raw.workingDirectory !== undefined &&
    typeof raw.workingDirectory !== "string"
  )
    return failure("invalid-payload");
  if (
    !isNullableString(raw.model) ||
    !isNullableString(raw.effort) ||
    !isNullableString(raw.continuationToken)
  ) {
    return failure("invalid-payload");
  }
  if (
    raw.automationMode !== undefined &&
    typeof raw.automationMode !== "boolean"
  )
    return failure("invalid-payload");
  const permissionConfig = decodeOptionalPermissionConfig(raw.permissionConfig);
  if (!permissionConfig.ok) return permissionConfig;
  const inlineAttachments = decodeOptionalInlineImageAttachments(
    raw.inlineAttachments,
  );
  if (!inlineAttachments.ok) return inlineAttachments;
  return success({
    sessionId: raw.sessionId,
    ...optionalProperty("workingDirectory", raw.workingDirectory),
    initialMessage: raw.initialMessage,
    model: raw.model,
    effort: raw.effort,
    continuationToken: raw.continuationToken,
    ...optionalProperty("permissionConfig", permissionConfig.value),
    ...optionalProperty("automationMode", raw.automationMode),
    ...optionalProperty("inlineAttachments", inlineAttachments.value),
  });
}

const PERMISSION_PRESETS = new Set(["ask", "yolo", "custom"]);
const CODEX_APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);
const CODEX_SANDBOX_MODES = new Set([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CLAUDE_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "plan",
  "bypassPermissions",
]);

function decodeOptionalPermissionConfig(
  raw: unknown,
): ExecutionDecodeResult<ExecutionStartConfig["permissionConfig"]> {
  if (raw === undefined) return success(undefined);
  if (!isRecord(raw) || !PERMISSION_PRESETS.has(String(raw.preset)))
    return failure("invalid-payload");

  let codex: ExecutionPermissionConfig["codex"] = undefined;
  if (raw.codex !== undefined) {
    if (
      !isRecord(raw.codex) ||
      !CODEX_APPROVAL_POLICIES.has(String(raw.codex.approvalPolicy)) ||
      !CODEX_SANDBOX_MODES.has(String(raw.codex.sandbox))
    )
      return failure("invalid-payload");
    codex = {
      approvalPolicy: raw.codex.approvalPolicy,
      sandbox: raw.codex.sandbox,
    } as ExecutionPermissionConfig["codex"];
  }

  let claudeCode: ExecutionPermissionConfig["claudeCode"] = undefined;
  if (raw.claudeCode !== undefined) {
    if (
      !isRecord(raw.claudeCode) ||
      !CLAUDE_PERMISSION_MODES.has(String(raw.claudeCode.permissionMode))
    )
      return failure("invalid-payload");
    claudeCode = {
      permissionMode: raw.claudeCode.permissionMode,
    } as ExecutionPermissionConfig["claudeCode"];
  }

  return success({
    preset: raw.preset as "ask" | "yolo" | "custom",
    ...optionalProperty("codex", codex),
    ...optionalProperty("claudeCode", claudeCode),
  });
}

function decodeOptionalInlineImageAttachments(
  raw: unknown,
): ExecutionDecodeResult<ExecutionInlineImageAttachment[] | undefined> {
  if (raw === undefined) return success(undefined);
  if (!Array.isArray(raw)) return failure("invalid-payload");

  const attachments: ExecutionInlineImageAttachment[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      item.kind !== "image" ||
      !isNonEmptyString(item.name) ||
      !isNonEmptyString(item.mimeType) ||
      !Number.isSafeInteger(item.sizeBytes) ||
      (item.sizeBytes as number) < 0 ||
      !isNonEmptyString(item.dataBase64)
    ) {
      return failure("invalid-payload");
    }
    attachments.push({
      kind: "image",
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes as number,
      dataBase64: item.dataBase64,
    });
  }
  return success(attachments);
}

function decodeOptionalMetadata(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionMetadata | null | undefined> {
  if (raw === undefined || raw === null) return success(raw);
  if (!isRecord(raw)) return failure("invalid-payload");
  const source = decodeOptionalMetadataPart(raw.source, "surface");
  const user = decodeOptionalMetadataPart(raw.user, "id");
  const thread = decodeOptionalMetadataPart(raw.thread, "id");
  const workspace = decodeOptionalMetadataPart(raw.workspace, "id");
  if (
    !source.ok ||
    !user.ok ||
    !thread.ok ||
    !workspace.ok ||
    !isOptionalRecord(raw.attributes)
  ) {
    return failure("invalid-payload");
  }
  return success({
    ...optionalProperty("source", source.value),
    ...optionalProperty("user", user.value),
    ...optionalProperty("thread", thread.value),
    ...optionalProperty("workspace", workspace.value),
    ...optionalProperty(
      "attributes",
      raw.attributes as ExecutionMetadataAttributes | undefined,
    ),
  } as ExecutionSessionMetadata);
}

function decodeOptionalMetadataPart(
  raw: unknown,
  required: "id" | "surface",
): ExecutionDecodeResult<Record<string, unknown> | undefined> {
  if (raw === undefined) return success(undefined);
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw[required]) ||
    !isOptionalRecord(raw.attributes)
  ) {
    return failure("invalid-payload");
  }
  const allowed =
    required === "surface"
      ? ["surface", "kind", "id", "url", "attributes"]
      : [
          "id",
          "displayName",
          "platformUserId",
          "username",
          "channelId",
          "conversationId",
          "messageId",
          "rootMessageId",
          "url",
          "branchName",
          "name",
          "organizationId",
          "pullRequestNumber",
          "ref",
          "repository",
          "tenantId",
          "attributes",
        ];
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) continue;
    if (key === "attributes" || key === "pullRequestNumber" || key === required)
      continue;
    if (!isOptionalNullableString(value)) return failure("invalid-payload");
  }
  if (
    raw.pullRequestNumber !== undefined &&
    raw.pullRequestNumber !== null &&
    typeof raw.pullRequestNumber !== "number"
  ) {
    return failure("invalid-payload");
  }
  return success(
    Object.fromEntries(
      Object.entries(raw).filter(([key]) => allowed.includes(key)),
    ),
  );
}

function decodeOptionalWorkspace(
  raw: unknown,
): ExecutionDecodeResult<ExecutionWorkspaceSource | undefined> {
  if (raw === undefined) return success(undefined);
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.repository) ||
    !isOptionalNullableString(raw.ref) ||
    !isOptionalNullableString(raw.branchName)
  ) {
    return failure("invalid-payload");
  }
  return success({
    repository: raw.repository,
    ...optionalProperty("ref", raw.ref as string | null | undefined),
    ...optionalProperty(
      "branchName",
      raw.branchName as string | null | undefined,
    ),
  });
}

function decodeOptionalCallback(
  raw: unknown,
): ExecutionDecodeResult<ExecutionCallbackConfig | undefined> {
  if (raw === undefined) return success(undefined);
  return isRecord(raw) &&
    isNonEmptyString(raw.url) &&
    isNonEmptyString(raw.secret)
    ? success({ url: raw.url, secret: raw.secret })
    : failure("invalid-payload");
}

function decodeOptionalAutomation(
  raw: unknown,
): ExecutionDecodeResult<ExecutionAutomationConfig | undefined> {
  if (raw === undefined) return success(undefined);
  if (
    !isRecord(raw) ||
    (raw.autoCreatePr !== undefined && typeof raw.autoCreatePr !== "boolean")
  )
    return failure("invalid-payload");
  return success({ ...optionalProperty("autoCreatePr", raw.autoCreatePr) });
}

function decodeContextWindow(raw: unknown): ExecutionContextWindow | null {
  if (
    !isRecord(raw) ||
    (raw.source !== "provider" && raw.source !== "estimated")
  )
    return null;
  if (raw.availability === "unavailable" && typeof raw.reason === "string") {
    return {
      availability: "unavailable",
      source: raw.source,
      reason: raw.reason,
    };
  }
  if (raw.availability !== "available") return null;
  const fields = [
    "usedTokens",
    "windowTokens",
    "usedPercentage",
    "remainingPercentage",
  ] as const;
  if (
    !fields.every(
      (field) => typeof raw[field] === "number" && Number.isFinite(raw[field]),
    )
  )
    return null;
  return {
    availability: "available",
    source: raw.source,
    usedTokens: raw.usedTokens as number,
    windowTokens: raw.windowTokens as number,
    usedPercentage: raw.usedPercentage as number,
    remainingPercentage: raw.remainingPercentage as number,
  };
}

function decodeActivity(
  raw: unknown,
): { valid: true; value: ExecutionActivitySignal } | { valid: false } {
  if (
    raw === null ||
    raw === "streaming" ||
    raw === "thinking" ||
    raw === "compacting" ||
    raw === "waiting-approval" ||
    (typeof raw === "string" && raw.startsWith("tool:"))
  ) {
    return { valid: true, value: raw as ExecutionActivitySignal };
  }
  return { valid: false };
}

function decodeStatus(raw: unknown): ExecutionSessionStatus | null {
  return (EXECUTION_SESSION_STATUSES as readonly unknown[]).includes(raw)
    ? (raw as ExecutionSessionStatus)
    : null;
}

function decodeAttention(raw: unknown): ExecutionAttentionState | null {
  return (EXECUTION_ATTENTION_STATES as readonly unknown[]).includes(raw)
    ? (raw as ExecutionAttentionState)
    : null;
}

function parseBase(
  raw: string,
): ExecutionDecodeResult<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failure("malformed-json");
  }
  if (!isRecord(parsed)) return failure("invalid-envelope");
  if (parsed.protocolVersion !== EXECUTION_PROTOCOL_VERSION)
    return failure("unsupported-protocol-version");
  return success(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || isNullableString(value);
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
function isItemState(
  value: unknown,
): value is "streaming" | "complete" | "error" {
  return value === "streaming" || value === "complete" || value === "error";
}
function isNoteLevel(value: unknown): boolean {
  return value === "info" || value === "warning" || value === "error";
}
function isMessageDelivery(value: unknown): value is ExecutionMessageDelivery {
  return (
    value === "queued" ||
    value === "delivered" ||
    value === "undelivered" ||
    value === "steered" ||
    value === "cancelled"
  );
}
function isProviderMeta(
  value: unknown,
): value is ExecutionConversationItem["providerMeta"] {
  return (
    isRecord(value) &&
    typeof value.providerId === "string" &&
    isNullableString(value.providerItemId) &&
    isNullableString(value.providerEventType)
  );
}
function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): {} | Record<Key, Value> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
function success<T>(
  value: T,
  warnings?: ExecutionDecodeWarning[],
): ExecutionDecodeResult<T> {
  return warnings?.length ? { ok: true, value, warnings } : { ok: true, value };
}
function failure(
  reason: ExecutionDecodeFailureReason,
): ExecutionDecodeResult<never> {
  return { ok: false, reason };
}
