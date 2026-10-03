/**
 * What the harness reports beside the conversation — agent runs, tasks, hooks,
 * retries, turn accounting — as Convergence models it (MAR-2869, CC2-1), put on
 * the wire as the `evidence` delta (MAR-3679).
 *
 * Copied unchanged from `marckraw/convergence`:
 * `electron/backend/session/harness-evidence.types.ts` and the shared types it
 * imports (`src/shared/types/harness-facts.types.ts`,
 * `src/shared/types/harness-evidence.types.ts`). The names are Convergence's on
 * purpose: its `HarnessEvidenceService.apply(sessionId, turnId, evidence)`
 * applies a remote session's evidence as it applies its own. A change here is
 * a change there first.
 */

export type HarnessOutput =
  string | { truncated: true; bytes: number; preview: string };

export type HarnessFact = {
  at: string;
  truncated?: true;
  fieldBounds?: Record<string, { truncated: true; bytes: number }>;
} & (
  | {
      kind: "harness.hook";
      hookId: string | null;
      hookName: string | null;
      hookEvent: string | null;
      phase: "started" | "progress" | "response" | "unknown";
      status: "ok" | "failed" | "blocked" | "cancelled" | null;
      output: HarnessOutput | null;
    }
  | {
      kind: "harness.retry";
      phase: "attempt";
      attempt: number | null;
      maxRetries: number | null;
      retryDelayMs: number | null;
      errorStatus: number | null;
      message: string | null;
      noResponse: boolean | null;
    }
  | {
      kind: "harness.retry";
      phase: "resolved";
      outcome: "succeeded" | "failed" | "unknown";
      reason?: "tool-error-while-outstanding";
      attempts: number;
      errorSubtype?: string | null;
    }
  | { kind: "harness.retry"; phase: "unknown" }
  | {
      kind: "harness.compaction";
      trigger: string | null;
      preTokens: number | null;
      postTokens: number | null;
      durationMs: number | null;
    }
  | {
      kind: "harness.denial";
      toolUseId?: string | null;
      toolName: string | null;
      reasonType: string | null;
      reason: string | null;
    }
  | {
      kind: "harness.rateLimit";
      status: string | null;
      type: string | null;
      utilization: number | null;
      resetsAt: number | null;
      overageStatus: string | null;
      overageResetsAt: number | null;
      overageDisabledReason: string | null;
      isUsingOverage: boolean | null;
      overageInUse: boolean | null;
      surpassedThreshold: number | null;
    }
  | {
      kind: "harness.init";
      claudeCodeVersion: string | null;
      model: string | null;
      permissionMode: string | null;
      mcpServers: {
        total: number;
        connected: number;
        /** The connected servers by name (MAR-3213); absent on facts written before it. */
        connectedNames?: string[];
        /** Connected servers beyond the 16 named above. */
        connectedOmitted?: number;
        others: { name: string; status: string | null }[];
        omitted: number;
        omittedAlerts: number;
      } | null;
      plugins: { count: number; names: string[]; omitted: number } | null;
      capabilities: { values: string[]; omitted: number } | null;
      tools: { count: number } | null;
      skills: { count: number } | null;
      slashCommands: { count: number } | null;
    }
  | {
      /**
       * The running process's own MCP status, read from the resident query
       * after its start record and on demand (MAR-3206 R1). Unlike the start
       * record it names each server's scope and address; an address is its
       * origin only -- never a path, a query or credentials.
       */
      kind: "harness.mcpStatus";
      servers: McpServerFact[];
      /**
       * Connected servers counted over the whole status, before the bound
       * lists some of them (MAR-3206 R7): a count over `servers` undercounts
       * whenever `omitted` is not zero.
       */
      connected: number;
      /** Servers beyond the ones listed above. */
      omitted: number;
      /** Of those, the ones that failed or need sign-in (listed first, so rarely any). */
      omittedAlerts: number;
      /**
       * The servers the loaded plugins declare, read from their manifests:
       * a plugin server the harness drops for a duplicate address is absent
       * from `servers`, and only this says where it would have pointed.
       */
      pluginServers: RecordedPluginMcpServerFact[];
    }
);

export interface McpServerFact {
  name: string;
  status: string | null;
  /** e.g. `claudeai`, `user`, `project`, `local`, `dynamic`; null when not reported. */
  scope: string | null;
  /** `https://mcp.figma.com`; null for a server with no URL (stdio, sdk). */
  origin: string | null;
  /**
   * The name was too long to record whole, so `name` is a prefix: Details
   * cannot reconnect it by that name (MAR-3206 R10). Absent when whole.
   */
  nameTruncated?: true;
}

/** A server a loaded plugin's manifest declares (names and origin only). */
export interface PluginMcpServerFact {
  plugin: string;
  server: string;
  origin: string;
}

/**
 * A plugin's declared server as recorded: whether the running process loaded
 * it is decided on the whole, unbounded status (MAR-3206 R10) -- never on the
 * recorded names, which a bound may have cut or dropped.
 */
export interface RecordedPluginMcpServerFact extends PluginMcpServerFact {
  loaded: boolean;
}

export type AgentRunStatus =
  "running" | "completed" | "failed" | "stopped" | "unknown";

export interface SessionAgentRun {
  /** Linked local-agent task, resolved by the backend read. */
  taskId?: string | null;
  /**
   * The run whose work spawned this one — the spawning item's own run —
   * resolved by the backend read (MAR-3310 O0b R4). Null for a run spawned
   * from the main conversation.
   */
  parentRunId?: string | null;
  endedSummary?: string | null;
  stopReason?:
    "quit" | "idle" | "account" | "maintenance" | "stop" | "exit" | null;
  id: string;
  sessionId: string;
  spawnedByItemId: string;
  agentType: string | null;
  description: string | null;
  model: string | null;
  status: AgentRunStatus;
  depth: number | null;
  startedAt: string;
  endedAt: string | null;
  transcriptPath: string | null;
  isBackgrounded: boolean | null;
  lastToolName: string | null;
  usageJson: string | null;
  updatedAt: string | null;
}

export interface SessionTask {
  /** Our successful task-stop control receipt, never a guess from terminal status. */
  stopReceiptAt?: string | null;
  /** First recorded sighting; null for legacy tasks with no known time. */
  observedAt?: string | null;
  endedSummary?: string | null;
  stopReason?:
    "quit" | "idle" | "account" | "maintenance" | "stop" | "exit" | null;
  taskId: string;
  sessionId: string;
  toolUseId: string | null;
  taskType: string | null;
  description: string | null;
  status: AgentRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  outputFile: string | null;
}

export type AgentRunFact =
  | {
      kind: "agent.started";
      run: Omit<
        SessionAgentRun,
        | "taskId"
        | "parentRunId"
        | "sessionId"
        | "status"
        | "endedAt"
        | "isBackgrounded"
        | "lastToolName"
        | "usageJson"
        | "updatedAt"
      >;
    }
  | {
      kind: "agent.identified";
      spawnedByItemId: string;
      id: string;
      agentType: string | null;
      description: string | null;
      depth: number | null;
      transcriptPath: string | null;
    }
  | {
      kind: "agent.changed";
      spawnedByItemId: string;
      patch: Partial<
        Pick<
          SessionAgentRun,
          | "model"
          | "isBackgrounded"
          | "lastToolName"
          | "usageJson"
          | "updatedAt"
        >
      >;
    }
  | {
      kind: "agent.ended";
      stopReason?: "stop";
      summary?: string | null;
      spawnedByItemId: string;
      status: Exclude<AgentRunStatus, "running" | "unknown">;
      at: string;
    }
  | {
      kind: "process.ended";
      unresolvedStatus?: "unknown";
      at: string;
      reason?: "quit" | "idle" | "account" | "maintenance" | "stop" | "exit";
    };

export type TaskFact = {
  kind: "task.changed";
  taskId: string;
  at: string;
  patch: Partial<Omit<SessionTask, "sessionId" | "taskId">>;
};

export type HarnessEvidence =
  | HarnessFact
  | AgentRunFact
  | TaskFact
  | {
      kind: "turn.accounting";
      resultSubtype: string | null;
      usage: unknown;
      costUsd: number | null;
      permissionDenials: unknown;
      subagentStats: unknown;
    }
  | {
      kind: "harness.unknown";
      type: string;
      subtype: string | null;
      payload: unknown;
      at: string;
    };
