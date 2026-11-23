import type {
  ExecutionFileReach,
  ExecutionFileReachProblem,
} from "../file-reach.js";
import {
  ExecutionInlineAttachmentsError,
  type ExecutionInlineAttachmentsErrorCode,
} from "../client/attachments.js";
import {
  ExecutionHostError,
  ExecutionStartFileReachError,
  ExecutionStartRequirementsError,
  type ExecutionHostErrorKind,
  type ExecutionStartFileReachErrorCode,
  type ExecutionStartRequirementsErrorCode,
} from "../client/http.js";
import {
  ExecutionStartInstructionsError,
  type ExecutionStartInstructionsErrorCode,
} from "../client/instructions.js";
import {
  ExecutionInteractionResponseError,
  type ExecutionInteractionResponseErrorCode,
} from "../client/interactions.js";
import {
  ExecutionStartSelectionError,
  type ExecutionStartSelectionErrorCode,
} from "../client/selections.js";
import { mcpError, type McpAsked } from "../client/mcp.js";
import {
  ExecutionSessionPatchError,
  type ExecutionSessionPatchErrorCode,
} from "../client/session-patch.js";
import {
  ExecutionTaskOutputError,
  type ExecutionTaskOutputErrorCode,
} from "../client/task-output.js";
import {
  ExecutionStartWorksInError,
  type ExecutionStartWorksInErrorCode,
} from "../client/works-in.js";
import { isRecord } from "../guards.js";

/**
 * An error as it crosses a port: a structured clone keeps an `Error`'s
 * message and loses its class and fields, so the fields travel by name and
 * the class is rebuilt on the other side.
 */
export interface PortError {
  name: string;
  message: string;
  fields: Record<string, unknown>;
}

/** The fields the client's errors carry, all of them plain data. */
const FIELDS = [
  "kind",
  "code",
  "operation",
  "status",
  "reason",
  "requires",
  "missingTraits",
  "fileReach",
  "problems",
  "sessionId",
  "sessionDeleted",
  "taskId",
  "index",
  "workingThere",
] as const;

/** The longest message a reason may carry across, as the HTTP client bounds a host's. */
const MESSAGE_MAX_LENGTH = 2048;

const HOST_ERROR_KINDS: readonly ExecutionHostErrorKind[] = [
  "network",
  "timeout",
  "auth",
  "not-found",
  "http",
  "malformed",
];

export function toPortError(error: unknown): PortError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: bounded(String(error)), fields: {} };
  }
  const fields: Record<string, unknown> = {};
  for (const name of FIELDS) {
    const value = (error as unknown as Record<string, unknown>)[name];
    // Through JSON: a field is data, and anything else would fail the clone.
    const json = value === undefined ? undefined : asJson(value);
    if (json !== undefined) fields[name] = JSON.parse(json);
  }
  return { name: error.name, message: bounded(error.message), fields };
}

/**
 * The error a `PortError` was. Any of the client's own errors comes back as
 * its class with its fields, and a `TypeError` or `RangeError` as one; any
 * other failure of the host is an `ExecutionHostError` of kind `http`, as an
 * HTTP host's 500 is, so a caller that handles those handles this.
 */
export function fromPortError(
  raw: unknown,
  operation: string,
  mcp?: McpAsked,
): Error {
  if (mcp) return fromMcpPortError(raw, mcp);
  if (!isRecord(raw) || typeof raw.message !== "string") {
    return new ExecutionHostError(
      "malformed",
      "the host's error is unreadable",
      {
        operation,
      },
    );
  }
  const message = bounded(raw.message);
  const fields = isRecord(raw.fields) ? raw.fields : {};
  const text = (name: string) =>
    typeof fields[name] === "string" ? (fields[name] as string) : null;
  const integer = (name: string) => {
    const value = fields[name];
    return Number.isSafeInteger(value) ? (value as number) : null;
  };
  const status = () => integer("status");
  const strings = (name: string) => {
    const value = fields[name];
    return Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
      ? (value as string[])
      : null;
  };
  const flag = (name: string) =>
    typeof fields[name] === "boolean" ? (fields[name] as boolean) : null;
  const code = text("code");
  const reason = text("reason") ?? message;

  switch (raw.name) {
    case "ExecutionHostError": {
      const kind = text("kind");
      if (kind === null || !(HOST_ERROR_KINDS as string[]).includes(kind)) {
        break;
      }
      return new ExecutionHostError(kind as ExecutionHostErrorKind, reason, {
        operation: text("operation") ?? operation,
        status: status(),
      });
    }
    case "ExecutionStartRequirementsError":
      if (code === null) break;
      return new ExecutionStartRequirementsError(
        code as ExecutionStartRequirementsErrorCode,
        reason,
        {
          requires: strings("requires") ?? [],
          missingTraits: strings("missingTraits"),
          status: status(),
          sessionId: text("sessionId"),
          sessionDeleted: flag("sessionDeleted"),
        },
      );
    case "ExecutionStartFileReachError": {
      const fileReach = fields.fileReach;
      if (
        code === null ||
        !isRecord(fileReach) ||
        !Array.isArray(fileReach.entries)
      ) {
        break;
      }
      return new ExecutionStartFileReachError(
        code as ExecutionStartFileReachErrorCode,
        reason,
        {
          fileReach: fileReach as unknown as ExecutionFileReach,
          problems: Array.isArray(fields.problems)
            ? (fields.problems as ExecutionFileReachProblem[])
            : null,
          status: status(),
          sessionId: text("sessionId"),
          sessionDeleted: flag("sessionDeleted"),
        },
      );
    }
    case "ExecutionStartInstructionsError":
      if (code === null) break;
      return new ExecutionStartInstructionsError(
        code as ExecutionStartInstructionsErrorCode,
        reason,
        status(),
      );
    case "ExecutionStartSelectionError":
      if (code === null) break;
      return new ExecutionStartSelectionError(
        code as ExecutionStartSelectionErrorCode,
        reason,
        status(),
      );
    case "ExecutionStartWorksInError":
      if (code === null) break;
      return new ExecutionStartWorksInError(
        code as ExecutionStartWorksInErrorCode,
        reason,
        { status: status(), workingThere: strings("workingThere") ?? [] },
      );
    case "ExecutionInlineAttachmentsError":
      if (code === null) break;
      return new ExecutionInlineAttachmentsError(
        code as ExecutionInlineAttachmentsErrorCode,
        reason,
        { operation: text("operation") ?? operation, index: integer("index") },
      );
    case "ExecutionInteractionResponseError":
      if (code === null) break;
      return new ExecutionInteractionResponseError(
        code as ExecutionInteractionResponseErrorCode,
        reason,
        { operation: text("operation") ?? operation },
      );
    case "ExecutionSessionPatchError": {
      const sessionId = text("sessionId");
      if (code === null || sessionId === null) break;
      return new ExecutionSessionPatchError(
        code as ExecutionSessionPatchErrorCode,
        reason,
        { sessionId, status: status() },
      );
    }
    case "ExecutionTaskOutputError": {
      const sessionId = text("sessionId");
      const taskId = text("taskId");
      const answered = status();
      if (
        code === null ||
        sessionId === null ||
        taskId === null ||
        answered === null
      ) {
        break;
      }
      return new ExecutionTaskOutputError(
        code as ExecutionTaskOutputErrorCode,
        reason,
        { status: answered, sessionId, taskId },
      );
    }
    case "TypeError":
      return new TypeError(message);
    case "RangeError":
      return new RangeError(message);
  }
  return new ExecutionHostError("http", message, { operation });
}

/** What an MCP call's error says when the host's words are withheld. */
const MCP_HOST_FAILURE = "the host failed the MCP call; its words are withheld";

/**
 * An MCP call's error (MAR-5668), made as the HTTP client makes one: an
 * `ExecutionMcpError` through `mcpError`, its code held to its status and
 * its reason this client's own; an `ExecutionHostError` with its kind and
 * status but none of the host's words; a `TypeError` or `RangeError` in
 * this client's words. Nothing the host wrote reaches the caller, since a
 * host's sentence may quote a sign-in or callback URL.
 */
function fromMcpPortError(raw: unknown, asked: McpAsked): Error {
  const fields = isRecord(raw) && isRecord(raw.fields) ? raw.fields : {};
  const status = Number.isSafeInteger(fields.status)
    ? (fields.status as number)
    : null;
  switch (isRecord(raw) ? raw.name : undefined) {
    case "ExecutionMcpError":
      if (status === null) break;
      return mcpError(fields.code, status, asked, fields.reason);
    case "ExecutionHostError": {
      const kind = fields.kind;
      if (!(HOST_ERROR_KINDS as unknown[]).includes(kind)) break;
      return new ExecutionHostError(
        kind as ExecutionHostErrorKind,
        MCP_HOST_FAILURE,
        { operation: asked.operation, status },
      );
    }
    case "TypeError":
      return new TypeError(
        `The host refused ${asked.operation} as a request the protocol would refuse`,
      );
    case "RangeError":
      return new RangeError(
        `The host refused ${asked.operation} as out of range`,
      );
  }
  return new ExecutionHostError("http", MCP_HOST_FAILURE, {
    operation: asked.operation,
  });
}

function asJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function bounded(text: string): string {
  return text.length > MESSAGE_MAX_LENGTH
    ? `${text.slice(0, MESSAGE_MAX_LENGTH)}…`
    : text;
}
