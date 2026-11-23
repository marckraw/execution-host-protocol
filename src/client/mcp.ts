import {
  checkExecutionMcpServerName,
  decodeExecutionMcpRefusal,
  decodeExecutionMcpServerList,
  decodeExecutionMcpSignIn,
  decodeExecutionMcpSignInStatus,
  EXECUTION_MCP_REFUSAL_STATUSES,
  EXECUTION_MCP_URL_MAX_LENGTH,
  isExecutionMcpProvider,
  isExecutionMcpUrl,
  type ExecutionMcpProvider,
  type ExecutionMcpRefusalCode,
  type ExecutionMcpServerList,
  type ExecutionMcpSignIn,
  type ExecutionMcpSignInStatus,
} from "../mcp.js";
import type { ExecutionHostHealth } from "./health.js";

/**
 * `unsupported`: the host answered 404 with no code, as a host predating
 * `mcp.connections.v1`, or a proxy, does. A 404 coded with a code this build
 * does not know is `rejected`.
 * `unavailable-on-host`, `unknown-server`, `no-sign-in`, `not-offered`,
 * `provider-unavailable`, `rejected`: the host's refusal, by its code,
 * honoured only with the status the protocol gives it. `rejected` is also any
 * other refusal (an uncoded 400, a 401, a 5xx, …); `status` says which.
 * `malformed`: a 2xx this build cannot read.
 */
export type ExecutionMcpErrorCode =
  "unsupported" | ExecutionMcpRefusalCode | "malformed";

/**
 * An MCP call the host did not answer (MAR-5668), with a code a caller
 * branches on: `unavailable-on-host` and `unsupported` both mean "not on this
 * host". Its `reason` is this client's own sentence, never the host's, so it
 * cannot carry a sign-in or callback URL the host quoted. Not an
 * `ExecutionHostError`, which an MCP call throws only when the host could not
 * be reached or did not answer in time.
 */
export class ExecutionMcpError extends Error {
  readonly code: ExecutionMcpErrorCode;
  /** `mcp servers`, `mcp sign in`, `mcp sign-in state`, … */
  readonly operation: string;
  /** The host's status. */
  readonly status: number;
  readonly provider: ExecutionMcpProvider;
  /** The server the call named; null for `mcpServers`. */
  readonly server: string | null;
  readonly reason: string;

  constructor(
    code: ExecutionMcpErrorCode,
    reason: string,
    details: {
      operation: string;
      status: number;
      provider: ExecutionMcpProvider;
      server?: string | null;
    },
  ) {
    super(
      `${details.operation} failed: ${code} (HTTP ${details.status}): ${reason}`,
    );
    this.name = "ExecutionMcpError";
    this.code = code;
    this.operation = details.operation;
    this.status = details.status;
    this.provider = details.provider;
    this.server = details.server ?? null;
    this.reason = reason;
  }
}

/** Whether the host advertises `mcp.connections.v1` (MAR-5668). */
export function hostManagesMcpConnections(
  health: Pick<ExecutionHostHealth, "capabilities">,
): boolean {
  return health.capabilities.includes("mcp.connections.v1");
}

/** What one MCP call is about, for its error. */
export interface McpAsked {
  operation: string;
  provider: ExecutionMcpProvider;
  server: string | null;
}

/** The most of an answer's body the client reads: a thousand servers, with room. */
export const MCP_ANSWER_MAX_BYTES = 1024 * 1024;

/** The most of a refusal's body the client reads for its code. */
export const MCP_REFUSAL_MAX_BYTES = 64 * 1024;

const REASONS: Record<ExecutionMcpErrorCode, string> = {
  unsupported: "the host does not serve MCP connections",
  "unavailable-on-host": "MCP connections are not available on this host",
  "unknown-server": "the provider has no MCP server by that name",
  "no-sign-in": "the server has no sign-in to answer for",
  "not-offered": "the server offers no sign-in here",
  "provider-unavailable": "the provider could not be asked",
  rejected: "the host refused the request",
  malformed: "the answer could not be read",
};

/**
 * What an MCP call names, checked before anything is sent, on every carrier
 * (the HTTP client, a port's client, a runtime in the same process): a
 * `TypeError` for a provider the protocol does not know or a server name
 * `isExecutionMcpServerName` refuses. Says what the call is about, for its
 * error. `mcpServers` names no server: `mcpProviderAsked`.
 */
export function mcpAsked(
  operation: string,
  provider: unknown,
  server: unknown,
): McpAsked {
  const asked = mcpProviderAsked(operation, provider);
  checkExecutionMcpServerName(server);
  return { ...asked, server };
}

/** `mcpAsked` for a call that names only a provider. */
export function mcpProviderAsked(
  operation: string,
  provider: unknown,
): McpAsked {
  if (!isExecutionMcpProvider(provider)) {
    throw new TypeError("An MCP provider is claude or codex");
  }
  return { operation, provider, server: null };
}

/**
 * A finish's callback URL, checked before anything is sent: a `TypeError`,
 * which never quotes it, for one `isExecutionMcpUrl` refuses.
 */
export function checkMcpCallbackUrl(
  callbackUrl: unknown,
): asserts callbackUrl is string {
  if (!isExecutionMcpUrl(callbackUrl)) {
    throw new TypeError(
      `callbackUrl must be an http or https URL of at most ${EXECUTION_MCP_URL_MAX_LENGTH} characters, with no space or control`,
    );
  }
}

/** What `malformed` may add to its reason: this client's words, never the answer's. */
const MALFORMED_DETAILS: readonly string[] = [
  `it is longer than ${MCP_ANSWER_MAX_BYTES} bytes`,
  "it is not a list of servers",
  "it is not a sign-in",
  "it is not a sign-in's state",
];

/**
 * The one way an `ExecutionMcpError` is made, whatever carried the answer
 * (MAR-5668), so both transports say the same thing about it:
 *
 * - The code is the claimed one only where the status agrees: a 2xx is only
 *   ever `malformed`, `unsupported` only a 404, a refusal code only with the
 *   status `EXECUTION_MCP_REFUSAL_STATUSES` gives it. Anything else is
 *   `rejected`.
 * - The reason is this client's own sentence for that code. A claimed reason
 *   is kept only when it is one of those sentences, so a host's words, which
 *   may quote a sign-in or callback URL, never reach the caller.
 * - The operation, provider and server are what the caller asked, never what
 *   the host said they were.
 */
export function mcpError(
  claimed: unknown,
  status: number,
  asked: McpAsked,
  reason?: unknown,
): ExecutionMcpError {
  let code: ExecutionMcpErrorCode;
  if (status >= 200 && status <= 299) code = "malformed";
  else if (
    typeof claimed === "string" &&
    Object.prototype.hasOwnProperty.call(
      EXECUTION_MCP_REFUSAL_STATUSES,
      claimed,
    ) &&
    EXECUTION_MCP_REFUSAL_STATUSES[claimed as ExecutionMcpRefusalCode] ===
      status
  ) {
    code = claimed as ExecutionMcpRefusalCode;
  } else if (claimed === "unsupported" && status === 404) code = "unsupported";
  else code = "rejected";
  const own =
    reason === REASONS[code] ||
    (code === "malformed" &&
      MALFORMED_DETAILS.some(
        (detail) => reason === `${REASONS.malformed}: ${detail}`,
      ));
  return new ExecutionMcpError(code, own ? (reason as string) : REASONS[code], {
    ...asked,
    status,
  });
}

/**
 * What a refusal means: the host's code where it gave a known one with the
 * status the protocol gives it, else its status. Only a 404 with no code at
 * all is no route: a host with the routes codes every 404, so one coded with
 * a code this build does not know is `rejected`, never `unsupported`.
 */
export function mcpRefusal(
  status: number,
  body: string,
  asked: McpAsked,
): ExecutionMcpError {
  const parsed = parseOrNull(body);
  const coded = decodeExecutionMcpRefusal(parsed);
  const hasCode =
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { code?: unknown }).code === "string";
  const claimed = coded.ok
    ? coded.value.code
    : status === 404 && !hasCode
      ? "unsupported"
      : "rejected";
  return mcpError(claimed, status, asked);
}

/** A 2xx this build cannot read. Says what it lacks, never what it held. */
export function mcpMalformed(
  status: number,
  asked: McpAsked,
  detail: string,
): ExecutionMcpError {
  return mcpError(
    "malformed",
    status,
    asked,
    `${REASONS.malformed}: ${detail}`,
  );
}

/** Reads a 2xx's body by `decode`, or throws it `malformed`. */
function readAnswer<T>(
  status: number,
  body: string | null,
  asked: McpAsked,
  decode: (raw: unknown) => { ok: true; value: T } | { ok: false },
  what: string,
): T {
  if (body === null) {
    throw mcpMalformed(
      status,
      asked,
      `it is longer than ${MCP_ANSWER_MAX_BYTES} bytes`,
    );
  }
  const decoded = decode(parseOrNull(body));
  if (!decoded.ok) throw mcpMalformed(status, asked, `it is not ${what}`);
  return decoded.value;
}

export const readMcpServerList = (
  status: number,
  body: string | null,
  asked: McpAsked,
): ExecutionMcpServerList =>
  readAnswer(
    status,
    body,
    asked,
    decodeExecutionMcpServerList,
    "a list of servers",
  );

export const readMcpSignIn = (
  status: number,
  body: string | null,
  asked: McpAsked,
): ExecutionMcpSignIn =>
  readAnswer(status, body, asked, decodeExecutionMcpSignIn, "a sign-in");

export const readMcpSignInStatus = (
  status: number,
  body: string | null,
  asked: McpAsked,
): ExecutionMcpSignInStatus =>
  readAnswer(
    status,
    body,
    asked,
    decodeExecutionMcpSignInStatus,
    "a sign-in's state",
  );

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
