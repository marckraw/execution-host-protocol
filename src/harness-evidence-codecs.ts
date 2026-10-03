import type {
  AgentRunFact,
  HarnessEvidence,
  HarnessFact,
  HarnessOutput,
  McpServerFact,
  RecordedPluginMcpServerFact,
  TaskFact,
} from "./harness-evidence.js";
import type { ExecutionDecodeResult } from "./types.js";

type Evidence<Kind extends HarnessEvidence["kind"]> = Extract<
  HarnessEvidence,
  { kind: Kind }
>;
type Raw = Record<string, unknown>;

/**
 * Reads one fact of harness evidence, as an `evidence` delta carries it
 * (MAR-3679).
 *
 * Strict about every field the model names, required or optional: a fact is
 * applied to a projection — a task's status, a run's summary — and one applied
 * with a field quietly dropped is a projection that is wrong without saying
 * so. A field present with the wrong shape is `invalid-payload`; a field the
 * model does not name is ignored. The `unknown`-typed fields of
 * `turn.accounting` and `harness.unknown` are required keys whose value is the
 * harness's own (send null for none). A kind this build does not know is
 * `unknown-kind`, so a stream steps over a newer fact rather than losing its
 * place; `harness.unknown` is not that — it is a known kind, the harness's
 * event families Convergence keeps without modelling them.
 */
export function decodeHarnessEvidence(
  raw: unknown,
): ExecutionDecodeResult<HarnessEvidence> {
  if (!isRecord(raw) || !isNonEmptyString(raw.kind)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const read = EVIDENCE_READERS.get(raw.kind);
  if (!read) return { ok: false, reason: "unknown-kind" };
  const value = read(raw);
  return value ? { ok: true, value } : { ok: false, reason: "invalid-payload" };
}

const EVIDENCE_READERS = new Map<string, (raw: Raw) => HarnessEvidence | null>(
  Object.entries({
    "harness.hook": readHook,
    "harness.retry": readRetry,
    "harness.compaction": readCompaction,
    "harness.denial": readDenial,
    "harness.rateLimit": readRateLimit,
    "harness.init": readInit,
    "harness.mcpStatus": readMcpStatus,
    "agent.started": readAgentStarted,
    "agent.identified": readAgentIdentified,
    "agent.changed": readAgentChanged,
    "agent.ended": readAgentEnded,
    "process.ended": readProcessEnded,
    "task.changed": readTaskChanged,
    "turn.accounting": readTurnAccounting,
    "harness.unknown": readHarnessUnknown,
  } satisfies Record<HarnessEvidence["kind"], (raw: Raw) => unknown>),
);

const AGENT_RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const;
const STOP_REASONS = [
  "quit",
  "idle",
  "account",
  "maintenance",
  "stop",
  "exit",
] as const;

// ---------------------------------------------------------------------------
// Harness facts: every one carries `at`, and may say it was bounded.
// ---------------------------------------------------------------------------

type FactBase = Pick<HarnessFact, "at" | "truncated" | "fieldBounds">;

function readFactBase(raw: Raw): FactBase | null {
  if (typeof raw.at !== "string" || !isOptionalTrue(raw.truncated)) {
    return null;
  }
  let fieldBounds: FactBase["fieldBounds"];
  if (raw.fieldBounds !== undefined) {
    if (!isRecord(raw.fieldBounds)) return null;
    fieldBounds = {};
    for (const [field, bound] of Object.entries(raw.fieldBounds)) {
      if (
        !isRecord(bound) ||
        bound.truncated !== true ||
        !isFiniteNumber(bound.bytes)
      ) {
        return null;
      }
      fieldBounds[field] = { truncated: true, bytes: bound.bytes };
    }
  }
  return {
    at: raw.at,
    ...optional("truncated", raw.truncated as true | undefined),
    ...optional("fieldBounds", fieldBounds),
  };
}

function readHook(raw: Raw): Evidence<"harness.hook"> | null {
  const base = readFactBase(raw);
  const output = readOutput(raw.output);
  if (
    !base ||
    !isNullableString(raw.hookId) ||
    !isNullableString(raw.hookName) ||
    !isNullableString(raw.hookEvent) ||
    !oneOf(["started", "progress", "response", "unknown"], raw.phase) ||
    !(
      raw.status === null ||
      oneOf(["ok", "failed", "blocked", "cancelled"], raw.status)
    ) ||
    output === undefined
  ) {
    return null;
  }
  return {
    ...base,
    kind: "harness.hook",
    hookId: raw.hookId,
    hookName: raw.hookName,
    hookEvent: raw.hookEvent,
    phase: raw.phase,
    status: raw.status,
    output,
  };
}

/** A hook's output, or null; undefined when it is neither. */
function readOutput(raw: unknown): HarnessOutput | null | undefined {
  if (raw === null || typeof raw === "string") return raw;
  if (
    isRecord(raw) &&
    raw.truncated === true &&
    isFiniteNumber(raw.bytes) &&
    typeof raw.preview === "string"
  ) {
    return { truncated: true, bytes: raw.bytes, preview: raw.preview };
  }
  return undefined;
}

function readRetry(raw: Raw): Evidence<"harness.retry"> | null {
  const base = readFactBase(raw);
  if (!base) return null;
  switch (raw.phase) {
    case "attempt":
      if (
        !isNullableNumber(raw.attempt) ||
        !isNullableNumber(raw.maxRetries) ||
        !isNullableNumber(raw.retryDelayMs) ||
        !isNullableNumber(raw.errorStatus) ||
        !isNullableString(raw.message) ||
        !isNullableBoolean(raw.noResponse)
      ) {
        return null;
      }
      return {
        ...base,
        kind: "harness.retry",
        phase: "attempt",
        attempt: raw.attempt,
        maxRetries: raw.maxRetries,
        retryDelayMs: raw.retryDelayMs,
        errorStatus: raw.errorStatus,
        message: raw.message,
        noResponse: raw.noResponse,
      };
    case "resolved":
      if (
        !oneOf(["succeeded", "failed", "unknown"], raw.outcome) ||
        !(
          raw.reason === undefined ||
          raw.reason === "tool-error-while-outstanding"
        ) ||
        !isFiniteNumber(raw.attempts) ||
        !(raw.errorSubtype === undefined || isNullableString(raw.errorSubtype))
      ) {
        return null;
      }
      return {
        ...base,
        kind: "harness.retry",
        phase: "resolved",
        outcome: raw.outcome,
        ...optional(
          "reason",
          raw.reason as "tool-error-while-outstanding" | undefined,
        ),
        attempts: raw.attempts,
        ...optional("errorSubtype", raw.errorSubtype as string | null),
      };
    case "unknown":
      return { ...base, kind: "harness.retry", phase: "unknown" };
    default:
      return null;
  }
}

function readCompaction(raw: Raw): Evidence<"harness.compaction"> | null {
  const base = readFactBase(raw);
  if (
    !base ||
    !isNullableString(raw.trigger) ||
    !isNullableNumber(raw.preTokens) ||
    !isNullableNumber(raw.postTokens) ||
    !isNullableNumber(raw.durationMs)
  ) {
    return null;
  }
  return {
    ...base,
    kind: "harness.compaction",
    trigger: raw.trigger,
    preTokens: raw.preTokens,
    postTokens: raw.postTokens,
    durationMs: raw.durationMs,
  };
}

function readDenial(raw: Raw): Evidence<"harness.denial"> | null {
  const base = readFactBase(raw);
  if (
    !base ||
    !(raw.toolUseId === undefined || isNullableString(raw.toolUseId)) ||
    !isNullableString(raw.toolName) ||
    !isNullableString(raw.reasonType) ||
    !isNullableString(raw.reason)
  ) {
    return null;
  }
  return {
    ...base,
    kind: "harness.denial",
    ...optional("toolUseId", raw.toolUseId as string | null | undefined),
    toolName: raw.toolName,
    reasonType: raw.reasonType,
    reason: raw.reason,
  };
}

function readRateLimit(raw: Raw): Evidence<"harness.rateLimit"> | null {
  const base = readFactBase(raw);
  if (
    !base ||
    !isNullableString(raw.status) ||
    !isNullableString(raw.type) ||
    !isNullableNumber(raw.utilization) ||
    !isNullableNumber(raw.resetsAt) ||
    !isNullableString(raw.overageStatus) ||
    !isNullableNumber(raw.overageResetsAt) ||
    !isNullableString(raw.overageDisabledReason) ||
    !isNullableBoolean(raw.isUsingOverage) ||
    !isNullableBoolean(raw.overageInUse) ||
    !isNullableNumber(raw.surpassedThreshold)
  ) {
    return null;
  }
  return {
    ...base,
    kind: "harness.rateLimit",
    status: raw.status,
    type: raw.type,
    utilization: raw.utilization,
    resetsAt: raw.resetsAt,
    overageStatus: raw.overageStatus,
    overageResetsAt: raw.overageResetsAt,
    overageDisabledReason: raw.overageDisabledReason,
    isUsingOverage: raw.isUsingOverage,
    overageInUse: raw.overageInUse,
    surpassedThreshold: raw.surpassedThreshold,
  };
}

type Init = Evidence<"harness.init">;

function readInit(raw: Raw): Init | null {
  const base = readFactBase(raw);
  const mcpServers = nullableOr(raw.mcpServers, readInitMcpServers);
  const plugins = nullableOr(raw.plugins, (value) =>
    isFiniteNumber(value.count) &&
    isStrings(value.names) &&
    isFiniteNumber(value.omitted)
      ? { count: value.count, names: [...value.names], omitted: value.omitted }
      : undefined,
  );
  const capabilities = nullableOr(raw.capabilities, (value) =>
    isStrings(value.values) && isFiniteNumber(value.omitted)
      ? { values: [...value.values], omitted: value.omitted }
      : undefined,
  );
  const tools = nullableOr(raw.tools, readCount);
  const skills = nullableOr(raw.skills, readCount);
  const slashCommands = nullableOr(raw.slashCommands, readCount);
  if (
    !base ||
    !isNullableString(raw.claudeCodeVersion) ||
    !isNullableString(raw.model) ||
    !isNullableString(raw.permissionMode) ||
    mcpServers === undefined ||
    plugins === undefined ||
    capabilities === undefined ||
    tools === undefined ||
    skills === undefined ||
    slashCommands === undefined
  ) {
    return null;
  }
  return {
    ...base,
    kind: "harness.init",
    claudeCodeVersion: raw.claudeCodeVersion,
    model: raw.model,
    permissionMode: raw.permissionMode,
    mcpServers,
    plugins,
    capabilities,
    tools,
    skills,
    slashCommands,
  };
}

function readInitMcpServers(
  raw: Raw,
): NonNullable<Init["mcpServers"]> | undefined {
  if (
    !isFiniteNumber(raw.total) ||
    !isFiniteNumber(raw.connected) ||
    !(raw.connectedNames === undefined || isStrings(raw.connectedNames)) ||
    !(
      raw.connectedOmitted === undefined || isFiniteNumber(raw.connectedOmitted)
    ) ||
    !Array.isArray(raw.others) ||
    !isFiniteNumber(raw.omitted) ||
    !isFiniteNumber(raw.omittedAlerts)
  ) {
    return undefined;
  }
  const others: { name: string; status: string | null }[] = [];
  for (const other of raw.others) {
    if (
      !isRecord(other) ||
      typeof other.name !== "string" ||
      !isNullableString(other.status)
    ) {
      return undefined;
    }
    others.push({ name: other.name, status: other.status });
  }
  return {
    total: raw.total,
    connected: raw.connected,
    ...optional(
      "connectedNames",
      raw.connectedNames === undefined
        ? undefined
        : [...(raw.connectedNames as string[])],
    ),
    ...optional("connectedOmitted", raw.connectedOmitted as number | undefined),
    others,
    omitted: raw.omitted,
    omittedAlerts: raw.omittedAlerts,
  };
}

function readCount(raw: Raw): { count: number } | undefined {
  return isFiniteNumber(raw.count) ? { count: raw.count } : undefined;
}

function readMcpStatus(raw: Raw): Evidence<"harness.mcpStatus"> | null {
  const base = readFactBase(raw);
  if (
    !base ||
    !Array.isArray(raw.servers) ||
    !isFiniteNumber(raw.connected) ||
    !isFiniteNumber(raw.omitted) ||
    !isFiniteNumber(raw.omittedAlerts) ||
    !Array.isArray(raw.pluginServers)
  ) {
    return null;
  }
  const servers: McpServerFact[] = [];
  for (const server of raw.servers) {
    if (
      !isRecord(server) ||
      typeof server.name !== "string" ||
      !isNullableString(server.status) ||
      !isNullableString(server.scope) ||
      !isNullableString(server.origin) ||
      !isOptionalTrue(server.nameTruncated)
    ) {
      return null;
    }
    servers.push({
      name: server.name,
      status: server.status,
      scope: server.scope,
      origin: server.origin,
      ...optional("nameTruncated", server.nameTruncated as true | undefined),
    });
  }
  const pluginServers: RecordedPluginMcpServerFact[] = [];
  for (const server of raw.pluginServers) {
    if (
      !isRecord(server) ||
      typeof server.plugin !== "string" ||
      typeof server.server !== "string" ||
      typeof server.origin !== "string" ||
      typeof server.loaded !== "boolean"
    ) {
      return null;
    }
    pluginServers.push({
      plugin: server.plugin,
      server: server.server,
      origin: server.origin,
      loaded: server.loaded,
    });
  }
  return {
    ...base,
    kind: "harness.mcpStatus",
    servers,
    connected: raw.connected,
    omitted: raw.omitted,
    omittedAlerts: raw.omittedAlerts,
    pluginServers,
  };
}

// ---------------------------------------------------------------------------
// Agent runs, keyed by the item that spawned them.
// ---------------------------------------------------------------------------

type AgentStarted = Extract<AgentRunFact, { kind: "agent.started" }>;

function readAgentStarted(raw: Raw): AgentStarted | null {
  const run = raw.run;
  if (
    !isRecord(run) ||
    !isNonEmptyString(run.id) ||
    !isNonEmptyString(run.spawnedByItemId) ||
    !isNullableString(run.agentType) ||
    !isNullableString(run.description) ||
    !isNullableString(run.model) ||
    !isNullableNumber(run.depth) ||
    typeof run.startedAt !== "string" ||
    !isNullableString(run.transcriptPath) ||
    !(run.endedSummary === undefined || isNullableString(run.endedSummary)) ||
    !isOptionalNullableStopReason(run.stopReason)
  ) {
    return null;
  }
  return {
    kind: "agent.started",
    run: {
      ...optional("endedSummary", run.endedSummary as string | null),
      ...optional(
        "stopReason",
        run.stopReason as AgentStarted["run"]["stopReason"],
      ),
      id: run.id,
      spawnedByItemId: run.spawnedByItemId,
      agentType: run.agentType,
      description: run.description,
      model: run.model,
      depth: run.depth,
      startedAt: run.startedAt,
      transcriptPath: run.transcriptPath,
    },
  };
}

function readAgentIdentified(raw: Raw): Evidence<"agent.identified"> | null {
  if (
    !isNonEmptyString(raw.spawnedByItemId) ||
    !isNonEmptyString(raw.id) ||
    !isNullableString(raw.agentType) ||
    !isNullableString(raw.description) ||
    !isNullableNumber(raw.depth) ||
    !isNullableString(raw.transcriptPath)
  ) {
    return null;
  }
  return {
    kind: "agent.identified",
    spawnedByItemId: raw.spawnedByItemId,
    id: raw.id,
    agentType: raw.agentType,
    description: raw.description,
    depth: raw.depth,
    transcriptPath: raw.transcriptPath,
  };
}

type AgentChanged = Extract<AgentRunFact, { kind: "agent.changed" }>;

function readAgentChanged(raw: Raw): AgentChanged | null {
  const patch = raw.patch;
  if (
    !isNonEmptyString(raw.spawnedByItemId) ||
    !isRecord(patch) ||
    !(patch.model === undefined || isNullableString(patch.model)) ||
    !(
      patch.isBackgrounded === undefined ||
      isNullableBoolean(patch.isBackgrounded)
    ) ||
    !(
      patch.lastToolName === undefined || isNullableString(patch.lastToolName)
    ) ||
    !(patch.usageJson === undefined || isNullableString(patch.usageJson)) ||
    !(patch.updatedAt === undefined || isNullableString(patch.updatedAt))
  ) {
    return null;
  }
  return {
    kind: "agent.changed",
    spawnedByItemId: raw.spawnedByItemId,
    patch: {
      ...optional("model", patch.model as string | null | undefined),
      ...optional(
        "isBackgrounded",
        patch.isBackgrounded as boolean | null | undefined,
      ),
      ...optional(
        "lastToolName",
        patch.lastToolName as string | null | undefined,
      ),
      ...optional("usageJson", patch.usageJson as string | null | undefined),
      ...optional("updatedAt", patch.updatedAt as string | null | undefined),
    },
  };
}

function readAgentEnded(raw: Raw): Evidence<"agent.ended"> | null {
  if (
    !(raw.stopReason === undefined || raw.stopReason === "stop") ||
    !(raw.summary === undefined || isNullableString(raw.summary)) ||
    !isNonEmptyString(raw.spawnedByItemId) ||
    !oneOf(["completed", "failed", "stopped"], raw.status) ||
    typeof raw.at !== "string"
  ) {
    return null;
  }
  return {
    kind: "agent.ended",
    ...optional("stopReason", raw.stopReason as "stop" | undefined),
    ...optional("summary", raw.summary as string | null | undefined),
    spawnedByItemId: raw.spawnedByItemId,
    status: raw.status,
    at: raw.at,
  };
}

function readProcessEnded(raw: Raw): Evidence<"process.ended"> | null {
  if (
    !(
      raw.unresolvedStatus === undefined || raw.unresolvedStatus === "unknown"
    ) ||
    typeof raw.at !== "string" ||
    !(raw.reason === undefined || oneOf(STOP_REASONS, raw.reason))
  ) {
    return null;
  }
  return {
    kind: "process.ended",
    ...optional("unresolvedStatus", raw.unresolvedStatus as "unknown"),
    at: raw.at,
    ...optional(
      "reason",
      raw.reason as (typeof STOP_REASONS)[number] | undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tasks: start, progress and end are all one `task.changed`, patching the
// task's projection.
// ---------------------------------------------------------------------------

type TaskPatch = TaskFact["patch"];

/** Every field a task patch may carry, and what it must hold when it does. */
const TASK_PATCH_FIELDS = {
  stopReceiptAt: isNullableString,
  observedAt: isNullableString,
  endedSummary: isNullableString,
  stopReason: (value: unknown) => value === null || oneOf(STOP_REASONS, value),
  toolUseId: isNullableString,
  taskType: isNullableString,
  description: isNullableString,
  status: (value: unknown) => oneOf(AGENT_RUN_STATUSES, value),
  startedAt: isNullableString,
  endedAt: isNullableString,
  outputFile: isNullableString,
} satisfies Record<keyof TaskPatch, (value: unknown) => boolean>;

function readTaskChanged(raw: Raw): TaskFact | null {
  if (
    !isNonEmptyString(raw.taskId) ||
    typeof raw.at !== "string" ||
    !isRecord(raw.patch)
  ) {
    return null;
  }
  const patch: Record<string, unknown> = {};
  for (const [field, valid] of Object.entries(TASK_PATCH_FIELDS)) {
    const value = raw.patch[field];
    if (value === undefined) continue;
    if (!valid(value)) return null;
    patch[field] = value;
  }
  return {
    kind: "task.changed",
    taskId: raw.taskId,
    at: raw.at,
    patch: patch as TaskPatch,
  };
}

// ---------------------------------------------------------------------------
// What a turn cost, and what the harness said that nothing here models.
// ---------------------------------------------------------------------------

function readTurnAccounting(raw: Raw): Evidence<"turn.accounting"> | null {
  if (
    !isNullableString(raw.resultSubtype) ||
    raw.usage === undefined ||
    !isNullableNumber(raw.costUsd) ||
    raw.permissionDenials === undefined ||
    raw.subagentStats === undefined
  ) {
    return null;
  }
  return {
    kind: "turn.accounting",
    resultSubtype: raw.resultSubtype,
    usage: raw.usage,
    costUsd: raw.costUsd,
    permissionDenials: raw.permissionDenials,
    subagentStats: raw.subagentStats,
  };
}

function readHarnessUnknown(raw: Raw): Evidence<"harness.unknown"> | null {
  if (
    !isNonEmptyString(raw.type) ||
    !isNullableString(raw.subtype) ||
    raw.payload === undefined ||
    typeof raw.at !== "string"
  ) {
    return null;
  }
  return {
    kind: "harness.unknown",
    type: raw.type,
    subtype: raw.subtype,
    payload: raw.payload,
    at: raw.at,
  };
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}
function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}
function isOptionalTrue(value: unknown): boolean {
  return value === undefined || value === true;
}
function isOptionalNullableStopReason(value: unknown): boolean {
  return value === undefined || value === null || oneOf(STOP_REASONS, value);
}
function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
function oneOf<const T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (values as readonly unknown[]).includes(value);
}
/** Null, or an object `read` makes sense of; undefined when it is neither. */
function nullableOr<T>(
  raw: unknown,
  read: (value: Raw) => T | undefined,
): T | null | undefined {
  if (raw === null) return null;
  return isRecord(raw) ? read(raw) : undefined;
}
function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): {} | Record<Key, Value> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
