import {
  EXECUTION_ACTOR_KINDS,
  EXECUTION_ATTENTION_STATES,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_SESSION_STATUSES,
  type ExecutionActivitySignal,
  type ExecutionActor,
  type ExecutionActorKind,
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
  type ExecutionEnvironment,
  type ExecutionEnvironmentDeclaration,
  type ExecutionEnvironmentListResponse,
  type ExecutionHostCommand,
  type ExecutionHostCommandEnvelope,
  type ExecutionHostEvent,
  type ExecutionHostEventEnvelope,
  type ExecutionInlineImageAttachment,
  type ExecutionInteractionFormField,
  type ExecutionInteractionQuestion,
  type ExecutionInteractionRequest,
  type ExecutionInteractionResponse,
  type ExecutionMessageDelivery,
  type ExecutionMetadataAttributes,
  type ExecutionPermissionConfig,
  type ExecutionProject,
  type ExecutionProjectEnvironmentRef,
  type ExecutionProjectListResponse,
  type ExecutionProtocolDescriptor,
  type ExecutionResearchEvidencePack,
  type ExecutionResearchEvidenceSource,
  type ExecutionRoom,
  type ExecutionRoomChristenRequest,
  type ExecutionRoomChristenResponse,
  type ExecutionRoomListResponse,
  type ExecutionProviderMeta,
  type ExecutionSendMessageOptions,
  type ExecutionSessionDelta,
  type ExecutionSessionMetadata,
  type ExecutionSessionPatchRequest,
  type ExecutionSessionPatchResponse,
  type ExecutionSessionStatus,
  type ExecutionSessionWorkspace,
  type ExecutionSkippedEnvelope,
  type ExecutionTurn,
  type ExecutionTurnFileChange,
  type ExecutionStartConfig,
  type ExecutionStartRequest,
  type ExecutionWorkspaceSource,
} from "./types.js";

const CONVERSATION_ITEM_FIELD_VALIDATORS = {
  id: isNonEmptyString,
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

/**
 * Patch fields that are not item fields. `textAppend` describes a change TO
 * the text rather than a value the item holds, so it cannot be derived from
 * the item shape the way every other patch field is (MAR-2218b).
 */
const PATCH_ONLY_FIELD_VALIDATORS = {
  textAppend: (value: unknown) => typeof value === "string",
} satisfies Record<string, (value: unknown) => boolean>;

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

const PATCH_ONLY_FIELDS = [
  "textAppend",
] as const satisfies readonly (keyof typeof PATCH_ONLY_FIELD_VALIDATORS)[];
type PatchOnlyField = (typeof PATCH_ONLY_FIELDS)[number];
const PATCH_ONLY_FIELD_SET = new Set<string>(PATCH_ONLY_FIELDS);

/** The bound on actor ids, display names, and command ids (MAR-3633). */
const ATTRIBUTION_MAX_LENGTH = 256;

/** The bound on a model or effort id a session patch names (MAR-3662). */
const MODEL_SELECTION_MAX_LENGTH = 256;

/** Every field a session patch may name (MAR-3662). */
const SESSION_PATCH_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "model",
  "effort",
]);

/**
 * A discriminant this reader does not know, carried up from wherever it sat to
 * the envelope decoder, which alone knows the envelope's place in the stream
 * and turns it into `skipped` (MAR-3633).
 */
interface UnknownKind {
  path: string;
  kind: string;
}

type KindAwareResult<T> =
  | ExecutionDecodeResult<T>
  | { ok: false; reason: "unknown-kind"; unknownKind: UnknownKind };

function unknownKind(path: string, kind: string): KindAwareResult<never> {
  return { ok: false, reason: "unknown-kind", unknownKind: { path, kind } };
}

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

/**
 * Reads one event envelope.
 *
 * An envelope of an event, delta, or item kind this build does not know is
 * not applied — there is nothing to apply it to — but it is not a broken frame
 * either: the result is `unknown-kind` with `skipped` saying where it sat, so a
 * stream reader steps over it and keeps its cursor moving (MAR-3633).
 */
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
  if (!event.ok) {
    if ("unknownKind" in event) {
      const skipped: ExecutionSkippedEnvelope = {
        sessionId,
        seq,
        ...event.unknownKind,
      };
      return { ok: false, reason: "unknown-kind", skipped };
    }
    return event;
  }
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
  const attribution = decodeAttribution(base.value);
  if (!attribution.ok) return attribution;
  return success({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: base.value.sessionId,
    ...optionalProperty("commandId", attribution.value.commandId),
    ...optionalProperty("actor", attribution.value.actor),
    command: command.value,
  });
}

/**
 * Who sent a command or a start request, and the client's id for it
 * (MAR-3633). Both are optional; either one present and unreadable refuses the
 * request rather than dropping it. A dropped actor would record the command as
 * anonymous and a dropped id would break the sender's match with its own echo —
 * both look like success, and both are the outcome the sender did not ask for.
 */
function decodeAttribution(
  raw: Record<string, unknown>,
): ExecutionDecodeResult<{ commandId?: string; actor?: ExecutionActor }> {
  if (
    raw.commandId !== undefined &&
    !isBoundedString(raw.commandId, ATTRIBUTION_MAX_LENGTH)
  ) {
    return failure("invalid-payload");
  }
  let actor: ExecutionActor | undefined;
  if (raw.actor !== undefined) {
    const decoded = decodeActor(raw.actor);
    if (!decoded) return failure("invalid-payload");
    actor = decoded;
  }
  return success({
    ...optionalProperty("commandId", raw.commandId as string | undefined),
    ...optionalProperty("actor", actor),
  });
}

function decodeActor(raw: unknown): ExecutionActor | null {
  if (
    !isRecord(raw) ||
    !(EXECUTION_ACTOR_KINDS as readonly unknown[]).includes(raw.kind) ||
    !isBoundedString(raw.id, ATTRIBUTION_MAX_LENGTH) ||
    !isBoundedString(raw.displayName, ATTRIBUTION_MAX_LENGTH)
  ) {
    return null;
  }
  return {
    kind: raw.kind as ExecutionActorKind,
    id: raw.id,
    displayName: raw.displayName,
  };
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
  // A misspelled environment is refused rather than dropped: dropping it runs
  // the session on the base set alone, which looks like success and is the one
  // outcome the caller did not ask for.
  if (!isOptionalNullableNonEmptyString(base.value.environment)) {
    return failure("invalid-payload");
  }
  const attribution = decodeAttribution(base.value);
  if (!attribution.ok) return attribution;

  return success({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    providerId: base.value.providerId,
    config: config.value,
    ...optionalProperty("metadata", metadata.value),
    ...optionalProperty("workspace", workspace.value),
    ...optionalProperty("callback", callback.value),
    ...optionalProperty("automation", automation.value),
    ...optionalProperty(
      "environment",
      base.value.environment as string | null | undefined,
    ),
    ...optionalProperty("commandId", attribution.value.commandId),
    ...optionalProperty("actor", attribution.value.actor),
  });
}

export function encodeExecutionSessionPatchRequest(
  request: ExecutionSessionPatchRequest,
): string {
  return JSON.stringify(request);
}

/**
 * Reads a session patch (MAR-3662), as strictly as a request into a host is
 * read: a body naming no field, a field this build does not know, or a value
 * of the wrong shape is `invalid-payload`. Refused, never dropped — a dropped
 * field reads as a change that was made.
 *
 * `model` and `effort` are null (the default) or a non-empty id of at most 256
 * characters; whether the provider offers it is the host's question, answered
 * from its catalog. `title` is null or a string, and what the host keeps of it
 * is the host's rule.
 */
export function decodeExecutionSessionPatchRequest(
  raw: string,
): ExecutionDecodeResult<ExecutionSessionPatchRequest> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure("malformed-json");
  }
  if (!isRecord(value)) return failure("invalid-payload");
  const fields = Object.keys(value);
  if (
    fields.length === 0 ||
    !fields.every((field) => SESSION_PATCH_FIELDS.has(field))
  ) {
    return failure("invalid-payload");
  }
  if (
    !isOptionalNullableString(value.title) ||
    !isOptionalSelectionId(value.model) ||
    !isOptionalSelectionId(value.effort)
  ) {
    return failure("invalid-payload");
  }
  return success({
    ...optionalProperty("title", value.title as string | null | undefined),
    ...optionalProperty("model", value.model as string | null | undefined),
    ...optionalProperty("effort", value.effort as string | null | undefined),
  });
}

/**
 * Reads a host's answer to a session patch (MAR-3662): the title-only answer
 * every host gives, `{ sessionId, title }`, or a selection answer, which adds
 * `protocolVersion`, `model` and `effort`. Fields it does not know are ignored.
 */
export function decodeExecutionSessionPatchResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionPatchResponse> {
  if (!isRecord(raw) || !isNonEmptyString(raw.sessionId)) {
    return failure("invalid-payload");
  }
  if (
    raw.protocolVersion !== undefined &&
    raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION
  ) {
    return failure("unsupported-protocol-version");
  }
  if (
    !isOptionalNullableString(raw.title) ||
    !isOptionalNullableNonEmptyString(raw.model) ||
    !isOptionalNullableNonEmptyString(raw.effort)
  ) {
    return failure("invalid-payload");
  }
  return success({
    ...optionalProperty(
      "protocolVersion",
      raw.protocolVersion as typeof EXECUTION_PROTOCOL_VERSION | undefined,
    ),
    sessionId: raw.sessionId,
    ...optionalProperty("title", raw.title as string | null | undefined),
    ...optionalProperty("model", raw.model as string | null | undefined),
    ...optionalProperty("effort", raw.effort as string | null | undefined),
  });
}

function decodeEvent(raw: unknown): KindAwareResult<ExecutionHostEvent> {
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
      return unknownKind("event.kind", raw.kind);
  }
}

function decodeDelta(raw: unknown): KindAwareResult<ExecutionSessionDelta> {
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
      if (raw.patch.roomId !== undefined) {
        if (raw.patch.roomId !== null && !isNonEmptyString(raw.patch.roomId)) {
          return failure("invalid-payload");
        }
        patch.roomId = raw.patch.roomId;
      }
      // The selection a session's next turn runs on (MAR-3662): null is the
      // default, and an id is never empty.
      if (raw.patch.model !== undefined) {
        if (raw.patch.model !== null && !isNonEmptyString(raw.patch.model)) {
          return failure("invalid-payload");
        }
        patch.model = raw.patch.model;
      }
      if (raw.patch.effort !== undefined) {
        if (raw.patch.effort !== null && !isNonEmptyString(raw.patch.effort)) {
          return failure("invalid-payload");
        }
        patch.effort = raw.patch.effort;
      }
      if (raw.patch.updatedAt !== undefined) {
        if (typeof raw.patch.updatedAt !== "string")
          return failure("invalid-payload");
        patch.updatedAt = raw.patch.updatedAt;
      }
      return success({ kind: "session.patch", patch });
    }
    case "conversation.item.add": {
      const item = decodeConversationItem(raw.item, "event.delta.item");
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
        const validate = PATCH_FIELD_SET.has(key)
          ? CONVERSATION_ITEM_FIELD_VALIDATORS[key as PatchField]
          : PATCH_ONLY_FIELD_SET.has(key)
            ? PATCH_ONLY_FIELD_VALIDATORS[key as PatchOnlyField]
            : undefined;
        if (!validate) continue;
        if (validate(value)) {
          patch[key] = value;
        } else {
          warnings.push({
            reason: "dropped-invalid-field",
            path: `event.delta.patch.${key}`,
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
      return unknownKind("event.delta.kind", raw.kind);
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
    (raw.repoRoot !== undefined && !isNonEmptyString(raw.repoRoot)) ||
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

/**
 * Reads one conversation item. `path` names where it sits, for the warnings
 * about optional fields it had to drop and for an unknown kind, which is
 * reported rather than rejected: the base fields every item shares are still
 * required, so only a well-formed item of a newer kind is skippable.
 */
function decodeConversationItem(
  raw: unknown,
  path: string,
): KindAwareResult<ExecutionConversationItem> {
  if (
    !isRecord(raw) ||
    !CONVERSATION_ITEM_FIELD_VALIDATORS.id(raw.id) ||
    !isNonEmptyString(raw.kind) ||
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
      const attachments = decodeConversationAttachments(
        raw.attachments,
        `${path}.attachments`,
      );
      const delivery = decodeOptionalMessageDelivery(
        raw.delivery,
        `${path}.delivery`,
      );
      const author = decodeOptionalField(
        raw.author,
        `${path}.author`,
        decodeActor,
      );
      const clientMessageId = decodeOptionalField(
        raw.clientMessageId,
        `${path}.clientMessageId`,
        (value) =>
          isBoundedString(value, ATTRIBUTION_MAX_LENGTH) ? value : null,
      );
      return success(
        {
          ...base,
          kind: "message",
          actor: raw.actor as "user" | "assistant",
          text: raw.text as string,
          ...optionalProperty("attachments", attachments.value),
          ...optionalProperty("delivery", delivery.value),
          ...optionalProperty("author", author.value),
          ...optionalProperty("clientMessageId", clientMessageId.value),
        },
        [
          ...attachments.warnings,
          ...delivery.warnings,
          ...author.warnings,
          ...clientMessageId.warnings,
        ],
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
      if (!CONVERSATION_ITEM_FIELD_VALIDATORS.prompt(raw.prompt)) {
        return failure("invalid-payload");
      }
      const request = decodeOptionalInteractionRequest(
        raw.request,
        `${path}.request`,
      );
      return success(
        {
          ...base,
          kind: "input-request",
          prompt: raw.prompt as string,
          ...optionalProperty("request", request.value),
        },
        request.warnings,
      );
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
      return unknownKind(`${path}.kind`, raw.kind);
  }
}

/**
 * An optional field read tolerantly: absent stays absent, and a value `read`
 * cannot make sense of is dropped with a warning naming `path` rather than
 * costing the item it sits on.
 */
function decodeOptionalField<T>(
  raw: unknown,
  path: string,
  read: (value: unknown) => T | null,
): { value: T | undefined; warnings: ExecutionDecodeWarning[] } {
  if (raw === undefined) return { value: undefined, warnings: [] };
  const value = read(raw);
  return value === null
    ? {
        value: undefined,
        warnings: [{ reason: "dropped-invalid-field", path }],
      }
    : { value, warnings: [] };
}

function decodeConversationAttachments(
  raw: unknown,
  path: string,
): {
  value: ExecutionConversationAttachment[] | undefined;
  warnings: ExecutionDecodeWarning[];
} {
  if (raw === undefined) return { value: undefined, warnings: [] };
  if (!Array.isArray(raw)) {
    return {
      value: undefined,
      warnings: [{ reason: "dropped-invalid-field", path }],
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
        path: `${path}.${index}`,
      });
    }
  }
  return { value, warnings };
}

function decodeOptionalMessageDelivery(
  raw: unknown,
  path: string,
): {
  value: ExecutionMessageDelivery | undefined;
  warnings: ExecutionDecodeWarning[];
} {
  return decodeOptionalField(raw, path, (value) =>
    isMessageDelivery(value) ? value : null,
  );
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
  const researchEvidence = decodeOptionalResearchEvidence(raw.researchEvidence);
  if (!researchEvidence.ok) return researchEvidence;
  return success({
    kind: "send-message",
    text: raw.text,
    ...optionalProperty("attachments", raw.attachments),
    ...optionalProperty("inlineAttachments", inlineAttachments.value),
    ...optionalProperty("skillSelections", raw.skillSelections),
    ...optionalProperty("options", options.value),
    ...optionalProperty("researchEvidence", researchEvidence.value),
  });
}

function decodeOptionalResearchEvidence(
  raw: unknown,
): ExecutionDecodeResult<ExecutionResearchEvidencePack | undefined> {
  if (raw === undefined) return success(undefined);
  if (
    !isRecord(raw) ||
    !isBoundedString(raw.capturedAt, 64) ||
    !isBoundedString(raw.question, 4_000) ||
    !isRecord(raw.coverage) ||
    !isBoundedInteger(raw.coverage.selectedEndpointCount, 0, 32) ||
    !isBoundedInteger(raw.coverage.searchedEndpointCount, 0, 32) ||
    !isBoundedInteger(raw.coverage.candidatePassageCount, 0, 10_000) ||
    !isBoundedStringArray(raw.coverage.failedEndpointIds, 32, 256) ||
    !isBoundedStringArray(raw.coverage.indexingEndpointIds, 32, 256) ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > 24
  ) {
    return failure("invalid-payload");
  }
  const sources = raw.sources.map(decodeResearchEvidenceSource);
  if (sources.some((source) => source === null)) {
    return failure("invalid-payload");
  }
  const sourceIds = sources.map((source) => source?.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    return failure("invalid-payload");
  }
  return success(raw as unknown as ExecutionResearchEvidencePack);
}

function decodeResearchEvidenceSource(
  raw: unknown,
): ExecutionResearchEvidenceSource | null {
  if (
    !isRecord(raw) ||
    !isBoundedString(raw.sourceId, 16) ||
    !isBoundedString(raw.endpointId, 256) ||
    !isBoundedString(raw.endpointName, 200) ||
    !isBoundedString(raw.sessionId, 256) ||
    !isBoundedString(raw.itemId, 256) ||
    (raw.sessionTitle !== null && !isBoundedString(raw.sessionTitle, 200)) ||
    !isBoundedString(raw.providerId, 64) ||
    !isBoundedString(raw.createdAt, 64) ||
    !isBoundedString(raw.text, 2_000)
  ) {
    return null;
  }
  return raw as unknown as ExecutionResearchEvidenceSource;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isBoundedStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isBoundedString(item, maxLength))
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function decodeOptionalSendOptions(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSendMessageOptions | undefined> {
  if (raw === undefined) return success(undefined);
  if (!isRecord(raw)) return failure("invalid-payload");
  const metadata = decodeOptionalMetadata(raw.metadata);
  if (!metadata.ok) return metadata;
  const interactionResponse = decodeOptionalInteractionResponse(
    raw.interactionResponse,
  );
  if (!interactionResponse.ok) return interactionResponse;
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
    ...optionalProperty("interactionResponse", interactionResponse.value),
    ...optionalProperty("metadata", metadata.value),
  });
}

function decodeOptionalInteractionRequest(
  raw: unknown,
  path: string,
): {
  value: ExecutionInteractionRequest | undefined;
  warnings: ExecutionDecodeWarning[];
} {
  return decodeOptionalField(raw, path, decodeInteractionRequest);
}

function decodeInteractionRequest(
  raw: unknown,
): ExecutionInteractionRequest | null {
  if (!isRecord(raw) || !isNonEmptyString(raw.kind)) return null;
  if (raw.kind === "text") {
    return isNonEmptyString(raw.prompt)
      ? { kind: "text", prompt: raw.prompt }
      : null;
  }
  if (raw.kind === "choice") {
    const questions = decodeInteractionQuestions(raw.questions);
    return questions ? { kind: "choice", questions } : null;
  }
  if (raw.kind === "plan") {
    if (!isNonEmptyString(raw.plan)) return null;
    if (!isOptionalString(raw.planPath)) return null;
    if (
      raw.allowedPrompts !== undefined &&
      (!Array.isArray(raw.allowedPrompts) ||
        !raw.allowedPrompts.every(isNonEmptyString))
    ) {
      return null;
    }
    return {
      kind: "plan",
      plan: raw.plan,
      ...optionalProperty("planPath", raw.planPath as string | undefined),
      ...optionalProperty(
        "allowedPrompts",
        raw.allowedPrompts as string[] | undefined,
      ),
    };
  }
  if (raw.kind === "form") {
    const fields = decodeInteractionFormFields(raw.fields);
    return isNonEmptyString(raw.title) &&
      typeof raw.message === "string" &&
      fields
      ? { kind: "form", title: raw.title, message: raw.message, fields }
      : null;
  }
  if (raw.kind === "url") {
    return isNonEmptyString(raw.title) &&
      typeof raw.message === "string" &&
      isHttpUrl(raw.url)
      ? { kind: "url", title: raw.title, message: raw.message, url: raw.url }
      : null;
  }
  return null;
}

function decodeInteractionQuestions(
  raw: unknown,
): ExecutionInteractionQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: ExecutionInteractionQuestion[] = [];
  for (const question of raw) {
    if (
      !isRecord(question) ||
      !isNonEmptyString(question.id) ||
      !isNonEmptyString(question.question) ||
      !isNonEmptyString(question.header) ||
      typeof question.multiSelect !== "boolean" ||
      !Array.isArray(question.options)
    ) {
      return null;
    }
    const options = question.options.flatMap((option) => {
      if (!isRecord(option) || !isNonEmptyString(option.label)) return [];
      if (
        !isOptionalString(option.description) ||
        !isOptionalString(option.preview)
      ) {
        return [];
      }
      return [
        {
          label: option.label,
          ...optionalProperty(
            "description",
            option.description as string | undefined,
          ),
          ...optionalProperty("preview", option.preview as string | undefined),
        },
      ];
    });
    if (options.length !== question.options.length) return null;
    questions.push({
      id: question.id,
      question: question.question,
      header: question.header,
      options,
      multiSelect: question.multiSelect,
    });
  }
  return questions;
}

function decodeInteractionFormFields(
  raw: unknown,
): ExecutionInteractionFormField[] | null {
  if (!Array.isArray(raw)) return null;
  const fields: ExecutionInteractionFormField[] = [];
  for (const field of raw) {
    if (
      !isRecord(field) ||
      !isNonEmptyString(field.id) ||
      !isNonEmptyString(field.label) ||
      (field.type !== "string" &&
        field.type !== "number" &&
        field.type !== "boolean") ||
      typeof field.required !== "boolean" ||
      !isOptionalString(field.description) ||
      (field.defaultValue !== undefined &&
        typeof field.defaultValue !== "string" &&
        typeof field.defaultValue !== "number" &&
        typeof field.defaultValue !== "boolean") ||
      (field.multiline !== undefined && typeof field.multiline !== "boolean")
    ) {
      return null;
    }
    fields.push({
      id: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      ...optionalProperty(
        "description",
        field.description as string | undefined,
      ),
      ...optionalProperty(
        "defaultValue",
        field.defaultValue as string | number | boolean | undefined,
      ),
      ...optionalProperty("multiline", field.multiline as boolean | undefined),
    });
  }
  return fields;
}

function decodeOptionalInteractionResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionInteractionResponse | undefined> {
  if (raw === undefined) return success(undefined);
  if (!isRecord(raw) || !isNonEmptyString(raw.kind)) {
    return failure("invalid-payload");
  }
  if (raw.kind === "choice") {
    if (!Array.isArray(raw.answers)) return failure("invalid-payload");
    const answers = raw.answers.flatMap((answer) =>
      isRecord(answer) &&
      isNonEmptyString(answer.questionId) &&
      Array.isArray(answer.values) &&
      answer.values.every((value) => typeof value === "string")
        ? [{ questionId: answer.questionId, values: answer.values as string[] }]
        : [],
    );
    return answers.length === raw.answers.length
      ? success({ kind: "choice", answers })
      : failure("invalid-payload");
  }
  if (raw.kind === "plan") {
    if (raw.decision !== "approve" && raw.decision !== "reject") {
      return failure("invalid-payload");
    }
    if (!isOptionalString(raw.message)) return failure("invalid-payload");
    return success({
      kind: "plan",
      decision: raw.decision,
      ...optionalProperty("message", raw.message as string | undefined),
    });
  }
  if (raw.kind === "form") {
    if (
      (raw.action !== "accept" && raw.action !== "decline") ||
      !isRecord(raw.values) ||
      !Object.values(raw.values).every(
        (value) =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean",
      )
    ) {
      return failure("invalid-payload");
    }
    return success({
      kind: "form",
      action: raw.action,
      values: raw.values as Record<string, string | number | boolean>,
    });
  }
  if (raw.kind === "url") {
    return raw.action === "accept" || raw.action === "decline"
      ? success({ kind: "url", action: raw.action })
      : failure("invalid-payload");
  }
  return failure("invalid-payload");
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
  if (raw.roomId !== undefined && !isNonEmptyString(raw.roomId)) {
    return failure("invalid-payload");
  }
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
  const researchEvidence = decodeOptionalResearchEvidence(raw.researchEvidence);
  if (!researchEvidence.ok) return researchEvidence;
  return success({
    sessionId: raw.sessionId,
    ...optionalProperty("workingDirectory", raw.workingDirectory),
    initialMessage: raw.initialMessage,
    model: raw.model,
    effort: raw.effort,
    continuationToken: raw.continuationToken,
    ...optionalProperty("roomId", raw.roomId),
    ...optionalProperty("permissionConfig", permissionConfig.value),
    ...optionalProperty("automationMode", raw.automationMode),
    ...optionalProperty("inlineAttachments", inlineAttachments.value),
    ...optionalProperty("researchEvidence", researchEvidence.value),
  });
}

// ---------------------------------------------------------------------------
// Contract shapes read on their own (MAR-3638): a session snapshot carries
// items, turns and session state outside any envelope, and a reader of one
// should hold it to the same rules as the stream that built it. A second
// decoder for the same wire shape is how the two drift apart.
// ---------------------------------------------------------------------------

/**
 * Reads one conversation item outside an envelope — from a snapshot's
 * `conversation`, say — by the same rules as `conversation.item.add`.
 * Warnings name paths relative to the item (`item.author`). An item of a kind
 * this build does not know is `unknown-kind`: a list reader drops it and keeps
 * the rest, which is the list form of skipping an envelope (MAR-3633).
 */
export function decodeExecutionConversationItem(
  raw: unknown,
): ExecutionDecodeResult<ExecutionConversationItem> {
  const item = decodeConversationItem(raw, "item");
  if (!item.ok && "unknownKind" in item) return failure("unknown-kind");
  return item;
}

/** Reads one turn record, as `turn.add` carries it. */
export function decodeExecutionTurn(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTurn> {
  const turn = decodeTurn(raw);
  return turn ? success(turn) : failure("invalid-payload");
}

/** Reads one turn file change, as `turn.fileChanges.add` carries it. */
export function decodeExecutionTurnFileChange(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTurnFileChange> {
  const change = decodeTurnFileChange(raw);
  return change ? success(change) : failure("invalid-payload");
}

/** Reads a context-window reading, as the `context-window` event carries it. */
export function decodeExecutionContextWindow(
  raw: unknown,
): ExecutionDecodeResult<ExecutionContextWindow> {
  const contextWindow = decodeContextWindow(raw);
  return contextWindow ? success(contextWindow) : failure("invalid-payload");
}

/** Reads an activity signal, as the `activity` event carries it; null is one. */
export function decodeExecutionActivitySignal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionActivitySignal> {
  const activity = decodeActivity(raw);
  return activity.valid ? success(activity.value) : failure("invalid-payload");
}

/**
 * Reads session metadata, as a start request carries it. Absent and null both
 * read as null: no metadata.
 */
export function decodeExecutionSessionMetadata(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionMetadata | null> {
  const metadata = decodeOptionalMetadata(raw);
  return metadata.ok ? success(metadata.value ?? null) : metadata;
}

export function encodeExecutionSessionWorkspace(
  workspace: ExecutionSessionWorkspace,
): string {
  return JSON.stringify(workspace);
}

/**
 * Reads the work address a host echoed. Hosts predating ADR-0011 sent a bare
 * `{ repository, branchName, baseRef }` with no discriminator; that shape is
 * still read, as a repository-mode address whose path and environment are
 * simply unknown. Encoding always writes `mode`, so a record that makes a
 * round trip comes back explicit.
 */
export function decodeExecutionSessionWorkspace(
  raw: unknown,
): ExecutionDecodeResult<ExecutionSessionWorkspace> {
  if (!isRecord(raw)) return failure("invalid-payload");

  if (raw.mode === "project") {
    if (
      !isNonEmptyString(raw.projectId) ||
      !isNonEmptyString(raw.workingDirectory) ||
      !isNullableString(raw.origin) ||
      !isNullableString(raw.originKey) ||
      !isNullableString(raw.branchName) ||
      !isOptionalNullableString(raw.requestedBranchName) ||
      !isNullableString(raw.environment)
    ) {
      return failure("invalid-payload");
    }
    return success({
      mode: "project",
      projectId: raw.projectId,
      workingDirectory: raw.workingDirectory,
      origin: raw.origin,
      originKey: raw.originKey,
      branchName: raw.branchName,
      ...optionalProperty(
        "requestedBranchName",
        raw.requestedBranchName as string | null | undefined,
      ),
      environment: raw.environment,
    });
  }

  if (raw.mode !== undefined && raw.mode !== "repository") {
    return failure("unknown-kind");
  }
  if (
    !isNonEmptyString(raw.repository) ||
    typeof raw.branchName !== "string" ||
    typeof raw.baseRef !== "string"
  ) {
    return failure("invalid-payload");
  }
  if (
    !isOptionalNullableString(raw.workspacePath) ||
    !isOptionalNullableString(raw.environment)
  ) {
    return failure("invalid-payload");
  }
  return success({
    mode: "repository",
    repository: raw.repository,
    branchName: raw.branchName,
    baseRef: raw.baseRef,
    workspacePath: (raw.workspacePath as string | null | undefined) ?? null,
    environment: (raw.environment as string | null | undefined) ?? null,
  });
}

/**
 * Reads a host's advertised Projects. `origin`, `originKey` and `environments`
 * are absent on hosts predating `projects.v2`, and read as unknown rather than
 * as a claim: no origin, no key, no environments — never a guess.
 */
export function decodeExecutionProjectListResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionProjectListResponse> {
  if (!isRecord(raw) || !Array.isArray(raw.projects)) {
    return failure("invalid-payload");
  }
  if (
    raw.protocolVersion !== undefined &&
    raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION
  ) {
    return failure("unsupported-protocol-version");
  }

  const projects: ExecutionProject[] = [];
  for (const entry of raw.projects) {
    const project = decodeExecutionProject(entry);
    if (!project) return failure("invalid-payload");
    projects.push(project);
  }

  return success({
    ...optionalProperty(
      "protocolVersion",
      raw.protocolVersion as typeof EXECUTION_PROTOCOL_VERSION | undefined,
    ),
    projects,
  });
}

function decodeExecutionProject(raw: unknown): ExecutionProject | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.name) ||
    !isNonEmptyString(raw.workingDirectory) ||
    !isOptionalNullableString(raw.origin) ||
    !isOptionalNullableString(raw.originKey)
  ) {
    return null;
  }

  const environments: ExecutionProjectEnvironmentRef[] = [];
  if (raw.environments !== undefined) {
    if (!Array.isArray(raw.environments)) return null;
    for (const entry of raw.environments) {
      if (
        !isRecord(entry) ||
        !isNonEmptyString(entry.name) ||
        typeof entry.default !== "boolean" ||
        typeof entry.provisioned !== "boolean" ||
        !isStringArray(entry.missing)
      ) {
        return null;
      }
      // Names are the whole contract here; a host that attached values to a
      // reference is refused the same way the catalog refuses one.
      if (carriesValues(entry)) return null;
      environments.push({
        name: entry.name,
        default: entry.default,
        provisioned: entry.provisioned,
        missing: [...entry.missing],
      });
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    workingDirectory: raw.workingDirectory,
    origin: (raw.origin as string | null | undefined) ?? null,
    originKey: (raw.originKey as string | null | undefined) ?? null,
    environments,
  };
}

export function decodeExecutionEnvironmentListResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionEnvironmentListResponse> {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !Array.isArray(raw.environments)
  ) {
    return failure("invalid-payload");
  }

  const environments: ExecutionEnvironment[] = [];
  for (const entry of raw.environments) {
    const environment = decodeExecutionEnvironment(entry);
    if (!environment) return failure("invalid-payload");
    environments.push(environment);
  }

  return success({ protocolVersion: EXECUTION_PROTOCOL_VERSION, environments });
}

function decodeExecutionEnvironment(raw: unknown): ExecutionEnvironment | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.name) ||
    !isStringArray(raw.keys) ||
    typeof raw.provisioned !== "boolean" ||
    !isStringArray(raw.missing)
  ) {
    return null;
  }
  if (raw.includes !== undefined && !isStringArray(raw.includes)) return null;
  if (carriesValues(raw)) return null;

  return {
    name: raw.name,
    keys: [...raw.keys],
    ...optionalProperty(
      "includes",
      raw.includes === undefined ? undefined : [...(raw.includes as string[])],
    ),
    provisioned: raw.provisioned,
    missing: [...raw.missing],
  };
}

/**
 * Reads a declaration — the shape of an environment, never its contents.
 *
 * A body carrying `values` is rejected outright rather than stripped. Stripping
 * would accept the request, answer 200, and teach the caller that sending
 * secrets over this wire works; refusing it says the only true thing, which is
 * that this door does not exist (ADR-0011 §5).
 */
export function decodeExecutionEnvironmentDeclaration(
  raw: string,
): ExecutionDecodeResult<ExecutionEnvironmentDeclaration> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure("malformed-json");
  }
  if (!isRecord(value)) return failure("invalid-payload");
  if (carriesValues(value)) return failure("invalid-payload");
  if (!isStringArray(value.keys)) return failure("invalid-payload");
  if (value.includes !== undefined && !isStringArray(value.includes)) {
    return failure("invalid-payload");
  }
  if (value.name !== undefined && !isNonEmptyString(value.name)) {
    return failure("invalid-payload");
  }

  return success({
    ...optionalProperty("name", value.name as string | undefined),
    keys: [...value.keys],
    ...optionalProperty(
      "includes",
      value.includes === undefined
        ? undefined
        : [...(value.includes as string[])],
    ),
  });
}

/**
 * The one rule this contract will not bend: a value never crosses this wire.
 * Presence of the field is enough — a `values` that is null, empty, or an
 * innocent-looking string still means the sender believed values belong here.
 */
function carriesValues(raw: Record<string, unknown>): boolean {
  return "values" in raw;
}

export function decodeExecutionRoomChristenRequest(
  raw: string,
): ExecutionDecodeResult<ExecutionRoomChristenRequest> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure("malformed-json");
  }
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.name) ||
    !isNonEmptyString(value.sessionId)
  ) {
    return failure("invalid-payload");
  }
  return success({ name: value.name, sessionId: value.sessionId });
}

export function decodeExecutionRoomChristenResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionRoomChristenResponse> {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !Number.isSafeInteger(raw.foundingMemoryEntryCount) ||
    (raw.foundingMemoryEntryCount as number) < 0
  ) {
    return failure("invalid-payload");
  }
  const room = decodeExecutionRoom(raw.room);
  if (!room) return failure("invalid-payload");
  const founding = decodeOptionalRoomFounding(raw.founding);
  if (!founding.ok) return failure("invalid-payload");
  return success({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    room,
    ...optionalProperty("founding", founding.value),
    foundingMemoryEntryCount: raw.foundingMemoryEntryCount as number,
  });
}

export function decodeExecutionRoomListResponse(
  raw: unknown,
): ExecutionDecodeResult<ExecutionRoomListResponse> {
  if (
    !isRecord(raw) ||
    raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION ||
    !Array.isArray(raw.rooms)
  ) {
    return failure("invalid-payload");
  }
  const rooms = raw.rooms.map(decodeExecutionRoom);
  return rooms.every((room): room is ExecutionRoom => room !== null)
    ? success({ protocolVersion: EXECUTION_PROTOCOL_VERSION, rooms })
    : failure("invalid-payload");
}

function decodeExecutionRoom(raw: unknown): ExecutionRoom | null {
  if (
    !isRecord(raw) ||
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.name) ||
    typeof raw.createdAt !== "string" ||
    typeof raw.lastActiveAt !== "string" ||
    !Number.isSafeInteger(raw.sessionCount) ||
    (raw.sessionCount as number) < 0
  ) {
    return null;
  }
  const founding = decodeOptionalRoomFounding(raw.founding);
  if (!founding.ok) return null;
  if (
    raw.foundingMemoryEntryCount !== undefined &&
    raw.foundingMemoryEntryCount !== null &&
    (!Number.isSafeInteger(raw.foundingMemoryEntryCount) ||
      (raw.foundingMemoryEntryCount as number) < 0)
  ) {
    return null;
  }
  if (
    raw.foundingError !== undefined &&
    raw.foundingError !== null &&
    typeof raw.foundingError !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    lastActiveAt: raw.lastActiveAt,
    sessionCount: raw.sessionCount as number,
    ...optionalProperty("founding", founding.value),
    ...optionalProperty(
      "foundingMemoryEntryCount",
      raw.foundingMemoryEntryCount as number | null | undefined,
    ),
    ...optionalProperty(
      "foundingError",
      raw.foundingError as string | null | undefined,
    ),
  };
}

function decodeOptionalRoomFounding(
  raw: unknown,
): ExecutionDecodeResult<ExecutionRoom["founding"]> {
  if (raw === undefined) return success(undefined);
  return raw === "pending" || raw === "furnished" || raw === "failed"
    ? success(raw)
    : failure("invalid-payload");
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
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}
function isOptionalNullableNonEmptyString(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value);
}
function isOptionalSelectionId(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    isBoundedString(value, MODEL_SELECTION_MAX_LENGTH)
  );
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
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
