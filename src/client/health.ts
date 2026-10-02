import { decodeExecutionProtocolDescriptor } from "../codecs.js";
import type {
  ExecutionProtocolCapability,
  ExecutionProtocolDescriptor,
} from "../types.js";

/**
 * The host API versions this client speaks. A host predating the
 * `executionProtocol` descriptor still negotiates through this coarse version.
 */
export const SUPPORTED_EXECUTION_HOST_API_VERSIONS: readonly string[] = ["v0"];

/** Both halves behind a provider's readiness boolean (agents-daemon 0.24.10+). */
export interface ExecutionHostProviderReadiness {
  installed: boolean;
  authenticated: boolean;
}

/** What a host's public `GET /health` says about it, read defensively. */
export interface ExecutionHostHealth {
  version: string | null;
  gitSha: string | null;
  buildTime: string | null;
  apiVersion: string | null;
  uptimeSeconds: number | null;
  /** Whether each provider can serve a turn now. */
  providers: Record<string, boolean>;
  /**
   * Installed and authenticated, per provider. Empty on a host that does not
   * say, never guessed from `providers`; an entry it cannot read is left out.
   */
  providerReadiness: Record<string, ExecutionHostProviderReadiness>;
  /** Null when the host predates the descriptor, or sent one this build cannot read. */
  executionProtocol: ExecutionProtocolDescriptor | null;
  /** False only when the host sent a descriptor this build cannot read. */
  executionProtocolValid: boolean;
  /** What the host advertises (`commands.actor.v1`, …); empty when it says nothing. */
  capabilities: ExecutionProtocolCapability[];
  /** The whole body, for the fields this client does not read. */
  raw: Record<string, unknown>;
}

/** Reads a `/health` body. Null when it does not look like a host's at all. */
export function parseExecutionHostHealth(
  raw: unknown,
): ExecutionHostHealth | null {
  if (!isRecord(raw) || raw.status !== "ok") return null;
  const descriptor =
    raw.executionProtocol === undefined
      ? null
      : decodeExecutionProtocolDescriptor(raw.executionProtocol);
  const executionProtocol = descriptor?.ok ? descriptor.value : null;
  return {
    version: stringOrNull(raw.version),
    gitSha: stringOrNull(raw.gitSha),
    buildTime: stringOrNull(raw.buildTime),
    apiVersion: stringOrNull(raw.apiVersion),
    uptimeSeconds:
      typeof raw.uptime === "number" && Number.isFinite(raw.uptime)
        ? raw.uptime
        : null,
    providers: isRecord(raw.providers)
      ? Object.fromEntries(
          Object.entries(raw.providers).filter(
            (entry): entry is [string, boolean] =>
              typeof entry[1] === "boolean",
          ),
        )
      : {},
    providerReadiness: readProviderReadiness(raw.providerReadiness),
    executionProtocol,
    executionProtocolValid: descriptor === null || descriptor.ok,
    capabilities: executionProtocol ? [...executionProtocol.capabilities] : [],
    raw,
  };
}

/**
 * `connected` — the host answered, speaks a protocol this client knows, and
 * accepted the token. `unauthorized` — it answered and refused the token, or
 * there is none. `incompatible` — it answered in a version this client does
 * not speak. `unreachable` — anything else.
 */
export type ExecutionHostConnectionStatus =
  "connected" | "unreachable" | "unauthorized" | "incompatible";

export interface ExecutionHostHandshake {
  status: ExecutionHostConnectionStatus;
  /** What `/health` said; null when it said nothing readable. */
  health: ExecutionHostHealth | null;
  /** Why the status is not `connected`, for a person; null when it is. */
  detail: string | null;
}

/** The authenticated probe's outcome (`GET /v0/meta` with the token). */
export type ExecutionHostMetaProbe =
  | { kind: "ok" }
  | { kind: "http"; status: number }
  | { kind: "network-error"; message: string }
  | { kind: "no-token" };

/**
 * Judges `/health` and the authenticated probe together. Both are needed:
 * `/health` is public and says whether the host is there and speaks this
 * protocol; only an authenticated call says whether the token is any good.
 */
export function evaluateExecutionHostHandshake(
  health: ExecutionHostHealth | null,
  healthFailure: string | null,
  meta: ExecutionHostMetaProbe,
): ExecutionHostHandshake {
  if (health === null) {
    return {
      status: "unreachable",
      health: null,
      detail: healthFailure ?? "The host did not answer /health",
    };
  }
  if (!health.executionProtocolValid) {
    return {
      status: "incompatible",
      health,
      detail: "The host's execution protocol is not one this client speaks",
    };
  }
  if (
    health.apiVersion === null ||
    !SUPPORTED_EXECUTION_HOST_API_VERSIONS.includes(health.apiVersion)
  ) {
    return {
      status: "incompatible",
      health,
      detail: `The host's apiVersion ${health.apiVersion ?? "(none)"} is not one of ${SUPPORTED_EXECUTION_HOST_API_VERSIONS.join(", ")}`,
    };
  }
  switch (meta.kind) {
    case "ok":
      return { status: "connected", health, detail: null };
    case "no-token":
      return {
        status: "unauthorized",
        health,
        detail: "No token is configured for this host",
      };
    case "http":
      return meta.status === 401 || meta.status === 403
        ? {
            status: "unauthorized",
            health,
            detail: "The host refused the token",
          }
        : {
            status: "unreachable",
            health,
            detail: `The authenticated probe failed with HTTP ${meta.status}`,
          };
    case "network-error":
      return {
        status: "unreachable",
        health,
        detail: `The authenticated probe failed: ${meta.message}`,
      };
  }
}

function readProviderReadiness(
  raw: unknown,
): Record<string, ExecutionHostProviderReadiness> {
  if (!isRecord(raw)) return {};
  const entries: Array<[string, ExecutionHostProviderReadiness]> = [];
  for (const [providerId, value] of Object.entries(raw)) {
    if (
      isRecord(value) &&
      typeof value.installed === "boolean" &&
      typeof value.authenticated === "boolean"
    ) {
      entries.push([
        providerId,
        { installed: value.installed, authenticated: value.authenticated },
      ]);
    }
  }
  return Object.fromEntries(entries);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
