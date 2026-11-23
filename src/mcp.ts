import {
  isBoundedString,
  isRecord,
  isTimestamp,
  readShowableText,
  UNSHOWABLE_CHARACTERS,
} from "./guards.js";
import type { ExecutionDecodeResult, ExecutionDecodeWarning } from "./types.js";

/**
 * A host's MCP connections (`mcp.connections.v1`, MAR-5668): the MCP servers
 * the host's own Claude Code and Codex can use, whether each is signed in,
 * and signing in to one and out of it. For a host that runs as one person on
 * their own machine (agents-daemon's `personal` profile), whose providers
 * keep their sign-ins where they always do; the tokens never leave them.
 *
 * Routes, all authenticated, `:provider` one of `EXECUTION_MCP_PROVIDERS`:
 *
 * - `GET /v0/mcp/:provider/servers` → `ExecutionMcpServerList`'s `servers`.
 * - `POST /v0/mcp/:provider/sign-in` `{ server }` → `ExecutionMcpSignIn`.
 * - `GET /v0/mcp/:provider/sign-in?server=<name>` → `ExecutionMcpSignInStatus`.
 * - `POST /v0/mcp/:provider/sign-in/finish` `{ server, callbackUrl }` →
 *   `ExecutionMcpSignInStatus`.
 * - `POST /v0/mcp/:provider/sign-in/cancel` `{ server }` →
 *   `ExecutionMcpSignInStatus`.
 * - `POST /v0/mcp/:provider/sign-out` `{ server }` → 204.
 *
 * A server is named in the body or the query, never in the path: a name like
 * `plugin:figma:figma` or `claude.ai Gmail` is not a path segment. A callback
 * URL is only ever in a body: it carries the provider's authorization code,
 * and a URL is what proxies and access logs keep.
 *
 * A host that does not manage MCP connections — one shared by several people
 * — answers every route 403 coded `unavailable-on-host`, and does not
 * advertise `mcp.connections.v1`. A host predating them answers 404 with no
 * code.
 */

/** The providers whose MCP servers a host reports: their CLIs keep the sign-ins. */
export const EXECUTION_MCP_PROVIDERS = ["claude", "codex"] as const;
export type ExecutionMcpProvider = (typeof EXECUTION_MCP_PROVIDERS)[number];

/**
 * Where a server is configured. From Claude Code's scope: `user` is `user`,
 * `project` and `local` are `project`, `dynamic` (a plugin's) is `plugin`, and
 * a claude.ai connector is `claude.ai` — connected or not, it is managed on
 * claude.ai, and a host offers no sign-in for it.
 */
export const EXECUTION_MCP_SERVER_SOURCES = [
  "user",
  "project",
  "plugin",
  "claude.ai",
] as const;
export type ExecutionMcpServerSource =
  (typeof EXECUTION_MCP_SERVER_SOURCES)[number];

/**
 * A server's state. From Claude Code's `mcp_status`: `connected` is
 * `connected`, `needs-auth` is `needs-sign-in`, `failed` is `failed`, and
 * `pending` — still connecting when the host stopped waiting — is
 * `connecting`.
 */
export const EXECUTION_MCP_SERVER_STATES = [
  "connected",
  "needs-sign-in",
  "failed",
  "connecting",
] as const;
export type ExecutionMcpServerState =
  (typeof EXECUTION_MCP_SERVER_STATES)[number];

/**
 * Where a sign-in is. `pending` until the browser comes back or it expires;
 * then `connected`, or `failed` (expired included), or `cancelled`.
 */
export const EXECUTION_MCP_SIGN_IN_STATES = [
  "pending",
  "connected",
  "failed",
  "cancelled",
] as const;
export type ExecutionMcpSignInState =
  (typeof EXECUTION_MCP_SIGN_IN_STATES)[number];

/** The longest server name. */
export const EXECUTION_MCP_SERVER_NAME_MAX_LENGTH = 256;
/** The longest `transport`. */
export const EXECUTION_MCP_TRANSPORT_MAX_LENGTH = 64;
/** The longest `reason`: a reader cleans and cuts a longer one. */
export const EXECUTION_MCP_REASON_MAX_LENGTH = 512;
/** The longest `urlHost`: a host name of 253, a port of 5, and the colon. */
export const EXECUTION_MCP_URL_HOST_MAX_LENGTH = 259;
/** The longest sign-in or callback URL. */
export const EXECUTION_MCP_URL_MAX_LENGTH = 8192;
/** The most servers a list is read to; the rest are dropped, out loud. */
export const EXECUTION_MCP_SERVERS_MAX_COUNT = 1024;

/** One MCP server one of the host's providers can use. */
export interface ExecutionMcpServer {
  /**
   * What the provider calls it, and what a sign-in names: 1 to 256
   * characters, none of them a control or a bidi mark, not blank.
   */
  name: string;
  source: ExecutionMcpServerSource;
  /** The provider's word for how it reaches the server: `stdio`, `http`, `sse`, … */
  transport: string;
  state: ExecutionMcpServerState;
  /**
   * Why it is in that state, for a person, where the host can say: the
   * host's own words, never a URL, a token or a config value.
   */
  reason?: string;
  /**
   * The host name, and port if any, of a remote server's URL
   * (`mcp.atlassian.com`): never its path or query, which may hold a key.
   */
  urlHost?: string;
}

/** The host's servers for one provider, and what this reader dropped. */
export interface ExecutionMcpServerList {
  /** Each server once, in the host's order. */
  servers: ExecutionMcpServer[];
  /** A server this build cannot read is dropped and named here (`servers.3`). */
  warnings: ExecutionDecodeWarning[];
}

/**
 * A sign-in the host started, for a person to finish in their browser.
 *
 * **`signInUrl` is a secret.** It carries the sign-in's `state` and PKCE
 * challenge: whoever holds it can finish the sign-in as its owner. Open it,
 * and nothing else — never log it, record it, store it, or put it in an
 * error or a URL of your own.
 */
export interface ExecutionMcpSignIn {
  /** The provider's sign-in page: `https:` or `http:`, never another scheme. Secret. */
  signInUrl: string;
  /**
   * Whether the sign-in ends with the browser coming back to the provider's
   * own callback on the host's loopback (Claude Code listens there itself).
   * If that browser cannot reach the host's loopback, hand the URL it landed
   * on to `mcpFinishSignIn`.
   */
  callbackExpected: boolean;
  /** When the host stops waiting and the sign-in fails: an RFC 3339 timestamp. */
  expiresAt: string;
}

/** Where a server's latest sign-in is. */
export interface ExecutionMcpSignInStatus {
  state: ExecutionMcpSignInState;
  /** Why it failed, for a person, where the host can say. Never a URL or a token. */
  reason?: string;
}

/**
 * The body of a sign-in, finish, cancel or sign-out. `callbackUrl` only on a
 * finish, and **secret**: it carries the provider's authorization code.
 */
export interface ExecutionMcpServerRequest {
  server: string;
  callbackUrl?: string;
}

/**
 * Why a host refused an MCP call, with the status it answers:
 *
 * - `unavailable-on-host` (403): it manages no MCP connections, as a host
 *   shared by several people does not.
 * - `unknown-server` (404): the provider has no server by that name.
 * - `no-sign-in` (404): the server has no sign-in to report, finish or cancel.
 * - `not-offered` (409): the server has no sign-in here: it needs none
 *   (`stdio`), or it is managed elsewhere (a claude.ai connector).
 * - `provider-unavailable` (503): the provider could not be asked — its CLI
 *   is missing, would not start, or did not answer in time.
 * - `rejected` (400): it will not take the request, such as a callback URL
 *   that is not this sign-in's.
 */
export const EXECUTION_MCP_REFUSAL_STATUSES = {
  "unavailable-on-host": 403,
  "unknown-server": 404,
  "no-sign-in": 404,
  "not-offered": 409,
  "provider-unavailable": 503,
  rejected: 400,
} as const;
export type ExecutionMcpRefusalCode =
  keyof typeof EXECUTION_MCP_REFUSAL_STATUSES;

/** A refusal's body. `error` is the host's sentence; the shared client never shows it. */
export interface ExecutionMcpRefusal {
  code: ExecutionMcpRefusalCode;
  error?: string;
}

/** Characters no server name has: what `UNSHOWABLE_CHARACTERS` matches. */
const UNSHOWABLE = new RegExp(UNSHOWABLE_CHARACTERS.source);

/** A surrogate without its pair: not text, and not encodable as UTF-8. */
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** An `http:` or `https:` URL with a host, and no space or control in it. */
const WEB_URL =
  /^https?:\/\/[^\s/?#\u0000-\u001f\u007f-\u009f]+[^\s\u0000-\u001f\u007f-\u009f]*$/i;

/** A host name or a bracketed IPv6 address, with a port if any. */
const URL_HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

export function isExecutionMcpProvider(
  value: unknown,
): value is ExecutionMcpProvider {
  return (EXECUTION_MCP_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * A name a server can have: 1 to 256 characters, none a control, bidi mark
 * or line separator, no lone surrogate, not blank. Such a name is shown as
 * it is and addressed as it is.
 */
export function isExecutionMcpServerName(value: unknown): value is string {
  return (
    isBoundedString(value, EXECUTION_MCP_SERVER_NAME_MAX_LENGTH) &&
    value.trim().length > 0 &&
    !UNSHOWABLE.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

/**
 * A URL a sign-in may open or a finish may carry: `https:` or `http:` with a
 * host, at most 8192 characters, no space or control. Never `javascript:`,
 * `file:` or an app's own scheme: a client opens a sign-in URL as it is.
 */
export function isExecutionMcpUrl(value: unknown): value is string {
  return (
    isBoundedString(value, EXECUTION_MCP_URL_MAX_LENGTH) &&
    WEB_URL.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

/**
 * The body of a sign-in, finish, cancel or sign-out. Throws a `TypeError`
 * for a server name `isExecutionMcpServerName` refuses, or a `callbackUrl`
 * `isExecutionMcpUrl` refuses — saying which, and never what it was.
 */
export function encodeExecutionMcpServerRequest(
  request: ExecutionMcpServerRequest,
): string {
  if (!isRecord(request as unknown)) {
    throw new TypeError("An MCP request is an object");
  }
  checkExecutionMcpServerName(request.server);
  if (
    request.callbackUrl !== undefined &&
    !isExecutionMcpUrl(request.callbackUrl)
  ) {
    throw new TypeError(
      `callbackUrl must be an http or https URL of at most ${EXECUTION_MCP_URL_MAX_LENGTH} characters, with no space or control`,
    );
  }
  return JSON.stringify(
    request.callbackUrl === undefined
      ? { server: request.server }
      : { server: request.server, callbackUrl: request.callbackUrl },
  );
}

/** A host's reading of a request's body, by the same rules. Unknown fields are ignored. */
export function decodeExecutionMcpServerRequest(
  raw: unknown,
): ExecutionDecodeResult<ExecutionMcpServerRequest> {
  if (
    !isRecord(raw) ||
    !isExecutionMcpServerName(raw.server) ||
    !(raw.callbackUrl === undefined || isExecutionMcpUrl(raw.callbackUrl))
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value:
      raw.callbackUrl === undefined
        ? { server: raw.server }
        : { server: raw.server, callbackUrl: raw.callbackUrl as string },
  };
}

/** Throws the `TypeError` a server name `isExecutionMcpServerName` refuses earns. */
export function checkExecutionMcpServerName(
  server: unknown,
): asserts server is string {
  if (!isExecutionMcpServerName(server)) {
    throw new TypeError(
      `An MCP server name is 1 to ${EXECUTION_MCP_SERVER_NAME_MAX_LENGTH} characters, not blank, with no control, bidi mark or line separator`,
    );
  }
}

/**
 * Reads `GET /v0/mcp/:provider/servers`. An answer without a `servers` list
 * is unreadable. One server costs only itself: a server without a name this
 * build can address, a `source` or `state` it knows, or a `transport`, is
 * dropped and named (`servers.3`), as is a second server by the same name. A
 * `reason` is cleaned and cut; one with nothing left, or a `urlHost` that is
 * not a host, is dropped alone and named (`servers.3.urlHost`). The list is
 * read to its 1024th server.
 */
export function decodeExecutionMcpServerList(
  raw: unknown,
): ExecutionDecodeResult<ExecutionMcpServerList> {
  if (!isRecord(raw) || !Array.isArray(raw.servers)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const warnings: ExecutionDecodeWarning[] = [];
  const servers: ExecutionMcpServer[] = [];
  const names = new Set<string>();
  raw.servers
    .slice(0, EXECUTION_MCP_SERVERS_MAX_COUNT)
    .forEach((entry, index) => {
      const path = `servers.${index}`;
      const server = readServer(entry, path, warnings);
      if (server === null || names.has(server.name)) {
        warnings.push({ reason: "dropped-invalid-field", path });
        return;
      }
      names.add(server.name);
      servers.push(server);
    });
  if (raw.servers.length > EXECUTION_MCP_SERVERS_MAX_COUNT) {
    warnings.push({ reason: "dropped-excess-entries", path: "servers" });
  }
  return {
    ok: true,
    value: { servers, warnings },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function readServer(
  raw: unknown,
  path: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionMcpServer | null {
  if (
    !isRecord(raw) ||
    !isExecutionMcpServerName(raw.name) ||
    !(EXECUTION_MCP_SERVER_SOURCES as readonly unknown[]).includes(
      raw.source,
    ) ||
    !(EXECUTION_MCP_SERVER_STATES as readonly unknown[]).includes(raw.state) ||
    !isBoundedString(raw.transport, EXECUTION_MCP_TRANSPORT_MAX_LENGTH) ||
    UNSHOWABLE.test(raw.transport)
  ) {
    return null;
  }
  const server: ExecutionMcpServer = {
    name: raw.name,
    source: raw.source as ExecutionMcpServerSource,
    transport: raw.transport,
    state: raw.state as ExecutionMcpServerState,
  };
  if (raw.reason !== undefined) {
    const reason = readShowableText(
      raw.reason,
      EXECUTION_MCP_REASON_MAX_LENGTH,
    );
    if (reason === undefined) {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.reason`,
      });
    } else server.reason = reason;
  }
  if (raw.urlHost !== undefined) {
    if (
      isBoundedString(raw.urlHost, EXECUTION_MCP_URL_HOST_MAX_LENGTH) &&
      URL_HOST.test(raw.urlHost)
    ) {
      server.urlHost = raw.urlHost;
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.urlHost`,
      });
    }
  }
  return server;
}

/**
 * Reads `POST /v0/mcp/:provider/sign-in`'s answer: unreadable without a
 * `signInUrl` `isExecutionMcpUrl` takes, a boolean `callbackExpected`, and
 * an `expiresAt` timestamp. Nothing it says about one quotes the URL.
 */
export function decodeExecutionMcpSignIn(
  raw: unknown,
): ExecutionDecodeResult<ExecutionMcpSignIn> {
  if (
    !isRecord(raw) ||
    !isExecutionMcpUrl(raw.signInUrl) ||
    typeof raw.callbackExpected !== "boolean" ||
    !isTimestamp(raw.expiresAt)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      signInUrl: raw.signInUrl,
      callbackExpected: raw.callbackExpected,
      expiresAt: raw.expiresAt,
    },
  };
}

/**
 * Reads a sign-in's state: unreadable without a `state` this build knows. A
 * `reason` is cleaned and cut, and left out when nothing is left of it.
 */
export function decodeExecutionMcpSignInStatus(
  raw: unknown,
): ExecutionDecodeResult<ExecutionMcpSignInStatus> {
  if (
    !isRecord(raw) ||
    !(EXECUTION_MCP_SIGN_IN_STATES as readonly unknown[]).includes(raw.state)
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  const reason = readShowableText(raw.reason, EXECUTION_MCP_REASON_MAX_LENGTH);
  return {
    ok: true,
    value: {
      state: raw.state as ExecutionMcpSignInState,
      ...(reason === undefined ? {} : { reason }),
    },
  };
}

/** Reads a refusal's body for its code: one this build knows, or nothing. */
export function decodeExecutionMcpRefusal(
  raw: unknown,
): ExecutionDecodeResult<ExecutionMcpRefusal> {
  if (
    !isRecord(raw) ||
    typeof raw.code !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      EXECUTION_MCP_REFUSAL_STATUSES,
      raw.code,
    )
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  return {
    ok: true,
    value: {
      code: raw.code as ExecutionMcpRefusalCode,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    },
  };
}
