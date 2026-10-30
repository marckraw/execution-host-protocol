import {
  isBoundedString,
  isRecord,
  isSafeNonNegativeInteger,
  isTimestamp,
} from "./guards.js";
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionDecodeResult,
  type ExecutionDecodeWarning,
} from "./types.js";

/**
 * What one turn cost, in tokens and, where the provider says, in dollars
 * (`turns.usage.v1`, MAR-4943). A host sends it once the turn ends: on the
 * turn as a snapshot carries it, and on followers' `turn.patch`. It keeps
 * every record in a history, `GET /v0/usage/turns`.
 *
 * Counted once. Each kind of token is apart from every other, so each is
 * priced once at its own rate and none is inside another, but `reasoning`,
 * which is a part of `output`. A turn is counted by itself, never as the
 * running total of the process it ran in. Two providers report otherwise,
 * and a host turns their words into these:
 *
 * - **Codex** counts its cached tokens inside its input (`input_tokens`
 *   includes `cached_input_tokens`), so a host sends `input` without them and
 *   `cacheRead` as them. Its `last` usage is the turn's own; `total` is the
 *   thread's.
 * - **Claude**'s `total_cost_usd` is the total of its process so far, and a
 *   resident session's process outlives many turns: a host sends the
 *   difference from the turn before. Its `usage` leaves out subagents and
 *   helper models (Haiku); `modelUsage` has every model, once, and is what
 *   `models` and the turn's `tokens` are read from.
 *
 * Unknown stays unknown: a turn without `usage` cost what nobody heard, not
 * nothing.
 */
export interface ExecutionTurnUsage {
  /** The provider the turn ran on, as `GET /v0/providers` names it. */
  providerId: string;
  /**
   * The model the turn ran on, as the provider named it; null when it did
   * not say. With `models`, the main one of them.
   */
  model: string | null;
  /**
   * Which of the provider's accounts the turn ran on: the host's opaque id
   * for it, never an email or anything else that names a person. Null is
   * the provider's own account on the host, the one `GET /v0/providers`
   * describes, which is all a host has today.
   */
  accountId: string | null;
  /** The turn's tokens, every model's together: with `models`, their sum. */
  tokens: ExecutionTurnTokens;
  /**
   * What the provider said the turn cost, in US dollars, as `costBasis`
   * says (Claude's, for the turn; Codex reports none). Absent when it said
   * nothing: then a reader prices the tokens itself, with its own dated
   * prices. A number, as the provider reports it.
   */
  costUsdReported?: number;
  /**
   * What `costUsdReported` and each model's are: `list`, the provider's list
   * price for the tokens — what they would cost through its API, never what
   * the account was billed. Present whenever a cost is.
   */
  costBasis?: ExecutionTurnUsageCostBasis;
  /**
   * The turn's tokens model by model, when it ran on more than one (Claude's
   * `modelUsage`: a subagent, a Haiku helper), each model once. A reader that
   * prices by model prices these and not `tokens`, which are their sum, kind
   * by kind: a split that does not add up is dropped on read. Absent when
   * the turn ran on `model` alone, or the host could not tell.
   */
  models?: ExecutionTurnModelUsage[];
}

/**
 * One turn's tokens, each kind apart. A kind the provider has none of is 0
 * (Codex writes no cache); a count it does not report at all is absent
 * (`reasoning`, from Claude).
 */
export interface ExecutionTurnTokens {
  /**
   * Input read at the full rate: never a cache read or a cache write. Codex
   * reports its cached tokens inside its input; a host takes them out.
   */
  input: number;
  /**
   * Input written to the provider's cache for five minutes (Claude's
   * `cache_creation.ephemeral_5m_input_tokens`; all of
   * `cache_creation_input_tokens` when it does not split them).
   */
  cacheWrite5m: number;
  /** Input written to the cache for an hour (`ephemeral_1h_input_tokens`). */
  cacheWrite1h: number;
  /** Input read from the cache (`cache_read_input_tokens`, `cached_input_tokens`). */
  cacheRead: number;
  /** Output, reasoning included. */
  output: number;
  /**
   * Of `output`, the tokens spent reasoning (Codex's
   * `reasoning_output_tokens`): already in `output`, never added to it.
   * Absent when the provider does not say.
   */
  reasoning?: number;
}

/** One model's part of a turn (Claude's `modelUsage[model]`). */
export interface ExecutionTurnModelUsage {
  /** As the provider named it: `claude-haiku-4-5-20251001`. */
  model: string;
  tokens: ExecutionTurnTokens;
  /**
   * What the provider said this model's part cost, in US dollars, on the
   * usage's `costBasis` (Claude's `costUSD`). Absent when it said nothing.
   */
  costUsdReported?: number;
}

/** `list`: the provider's list price, what the tokens would cost on its API. */
export const EXECUTION_TURN_USAGE_COST_BASES = ["list"] as const;
export type ExecutionTurnUsageCostBasis =
  (typeof EXECUTION_TURN_USAGE_COST_BASES)[number];

/**
 * `live` — recorded as the turn ended. `backfill` — read afterwards from the
 * history a host keeps on disk (a provider's transcripts, its own traces),
 * for what ran before the host recorded usage.
 */
export const EXECUTION_TURN_USAGE_SOURCES = ["live", "backfill"] as const;
export type ExecutionTurnUsageSource =
  (typeof EXECUTION_TURN_USAGE_SOURCES)[number];

/**
 * One turn's usage in a host's history (`GET /v0/usage/turns`): the usage,
 * and which turn it was.
 */
export interface ExecutionTurnUsageRecord extends ExecutionTurnUsage {
  /**
   * The turn's id, or for backfilled history one the host makes from what
   * it read, the same on every read. Unique on the host: a reader stores a
   * record by it, and a record that comes again — the host re-read its
   * history, or revised a turn — replaces the one before.
   */
  turnId: string;
  /**
   * The session it ran in; null for backfilled history no session of the
   * host's owns.
   */
  sessionId: string | null;
  /** When the turn ended (ISO 8601). */
  endedAt: string;
  source: ExecutionTurnUsageSource;
}

/**
 * Which records to read (`GET /v0/usage/turns`). `since` starts a read;
 * `cursor` carries one on, with the `since` it started with, so a query
 * names one or the other. Neither reads from the first record the host has.
 */
export interface ExecutionTurnUsageQuery {
  /** Only turns that ended at or after this (ISO 8601). */
  since?: string;
  /** A page's `nextCursor`: what the host recorded after that page. */
  cursor?: string;
  /** A whole number from 1 to 500. The host's default when absent. */
  limit?: number;
}

/**
 * One page of a host's usage history, in the order the host recorded the
 * records, oldest first: a turn backfilled today comes after yesterday's
 * live ones, whatever its `endedAt`.
 *
 * `nextCursor` is where the page ends. Passed back as `cursor`, it reads what
 * comes after: the rest at once while `hasMore`, and later, whatever the host
 * has recorded since — so a reader that keeps its last cursor catches up
 * from it. Null only on an empty page with nothing more (an empty history,
 * or nothing new since the cursor given): keep the cursor you had. A page
 * with records, or with `hasMore`, always has one; one without is unreadable.
 */
export interface ExecutionTurnUsagePage {
  records: ExecutionTurnUsageRecord[];
  nextCursor: string | null;
  /** More records were already there past this page: read again now. */
  hasMore: boolean;
  /** Records and fields this build could not read, dropped and named. */
  warnings: ExecutionDecodeWarning[];
}

/** The longest provider id a usage names, as a session list's. */
export const EXECUTION_TURN_USAGE_PROVIDER_ID_MAX_LENGTH = 100;
/** The longest model id, account id, turn or session id a usage names. */
export const EXECUTION_TURN_USAGE_ID_MAX_LENGTH = 256;
/** The most models one turn's usage names. */
export const EXECUTION_TURN_USAGE_MODELS_MAX_COUNT = 32;
/** The most records one page of usage history holds. */
export const EXECUTION_TURN_USAGE_PAGE_MAX_LIMIT = 500;
/** The longest cursor a page of usage history gives. */
export const EXECUTION_TURN_USAGE_CURSOR_MAX_LENGTH = 1024;

/**
 * The query string for a read of the usage history, or a `TypeError` /
 * `RangeError` for a query the protocol refuses: checked where the mistake
 * is. A host in the same process checks its caller's query with it too.
 */
export function encodeExecutionTurnUsageQuery(
  query: ExecutionTurnUsageQuery,
): string {
  if (!isRecord(query as unknown)) {
    throw new TypeError("A turn usage query is an object");
  }
  const { since, cursor, limit } = query;
  const params = new URLSearchParams();
  if (since !== undefined && cursor !== undefined) {
    throw new TypeError(
      "since starts a read and cursor carries one on: name one of them",
    );
  }
  if (since !== undefined) {
    if (!isTimestamp(since)) {
      throw new TypeError("since must be an ISO 8601 timestamp");
    }
    params.set("since", since);
  }
  if (cursor !== undefined) {
    if (!isBoundedString(cursor, EXECUTION_TURN_USAGE_CURSOR_MAX_LENGTH)) {
      throw new TypeError(
        `cursor must be a nextCursor: 1 to ${EXECUTION_TURN_USAGE_CURSOR_MAX_LENGTH} characters`,
      );
    }
    params.set("cursor", cursor);
  }
  if (limit !== undefined) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > EXECUTION_TURN_USAGE_PAGE_MAX_LIMIT
    ) {
      throw new RangeError(
        `limit must be a whole number from 1 to ${EXECUTION_TURN_USAGE_PAGE_MAX_LIMIT}`,
      );
    }
    params.set("limit", String(limit));
  }
  return params.toString();
}

/**
 * Reads one turn's usage. Its frame is required — a provider, every token
 * count, a model and an account that are an id or null — and an account id
 * that looks like an email is refused, never shown. A cost without a basis
 * this build knows is dropped, every cost with it, and so is a `models` list
 * that cannot be read whole or whose tokens do not add up to the turn's; each
 * is named in `warnings`, and the turn's totals stay.
 */
export function decodeExecutionTurnUsage(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTurnUsage> {
  const warnings: ExecutionDecodeWarning[] = [];
  const usage = readUsage(raw, "", warnings);
  return usage === null
    ? { ok: false, reason: "invalid-payload" }
    : {
        ok: true,
        value: usage,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
}

/** Reads one record of a host's usage history, as a page carries it. */
export function decodeExecutionTurnUsageRecord(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTurnUsageRecord> {
  const warnings: ExecutionDecodeWarning[] = [];
  const record = readRecord(raw, "", warnings);
  return record === null
    ? { ok: false, reason: "invalid-payload" }
    : {
        ok: true,
        value: record,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
}

/**
 * Reads a page of usage history. The frame is required — protocol version, a
 * `records` list, `hasMore`, and a `nextCursor` that is one or null — and the
 * page must be one a reader can resume after: a null `nextCursor` only on an
 * empty page with nothing more. A record this build cannot read is dropped
 * and named in `warnings`, so a short page is never silently short.
 */
export function decodeExecutionTurnUsagePage(
  raw: unknown,
): ExecutionDecodeResult<ExecutionTurnUsagePage> {
  if (!isRecord(raw)) return { ok: false, reason: "invalid-payload" };
  if (raw.protocolVersion !== EXECUTION_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported-protocol-version" };
  }
  if (
    !Array.isArray(raw.records) ||
    typeof raw.hasMore !== "boolean" ||
    !(
      raw.nextCursor === null ||
      isBoundedString(raw.nextCursor, EXECUTION_TURN_USAGE_CURSOR_MAX_LENGTH)
    )
  ) {
    return { ok: false, reason: "invalid-payload" };
  }
  // A page that cannot be resumed: one with more after it, or with records
  // (whether this build can read them or not), says where it ends. Without
  // that, a reader would ask for the same page for ever.
  if (raw.nextCursor === null && (raw.hasMore || raw.records.length > 0)) {
    return { ok: false, reason: "invalid-payload" };
  }
  const warnings: ExecutionDecodeWarning[] = [];
  const records: ExecutionTurnUsageRecord[] = [];
  raw.records.forEach((entry, index) => {
    const path = `records.${index}`;
    const record = readRecord(entry, `${path}.`, warnings);
    if (record === null) {
      warnings.push({ reason: "dropped-invalid-field", path });
    } else records.push(record);
  });
  return {
    ok: true,
    value: {
      records,
      nextCursor: raw.nextCursor as string | null,
      hasMore: raw.hasMore,
      warnings,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function readRecord(
  raw: unknown,
  prefix: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionTurnUsageRecord | null {
  if (
    !isRecord(raw) ||
    !isBoundedString(raw.turnId, EXECUTION_TURN_USAGE_ID_MAX_LENGTH) ||
    !(
      raw.sessionId === null ||
      isBoundedString(raw.sessionId, EXECUTION_TURN_USAGE_ID_MAX_LENGTH)
    ) ||
    !isTimestamp(raw.endedAt) ||
    !(EXECUTION_TURN_USAGE_SOURCES as readonly unknown[]).includes(raw.source)
  ) {
    return null;
  }
  const usage = readUsage(raw, prefix, warnings);
  if (usage === null) return null;
  return {
    turnId: raw.turnId,
    sessionId: raw.sessionId as string | null,
    endedAt: raw.endedAt,
    source: raw.source as ExecutionTurnUsageSource,
    ...usage,
  };
}

/**
 * Null when the usage cannot be read at all. `prefix` is where it sits, for
 * the warnings about what it had to drop.
 */
function readUsage(
  raw: unknown,
  prefix: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionTurnUsage | null {
  if (
    !isRecord(raw) ||
    !isBoundedString(
      raw.providerId,
      EXECUTION_TURN_USAGE_PROVIDER_ID_MAX_LENGTH,
    ) ||
    !(
      raw.model === null ||
      isBoundedString(raw.model, EXECUTION_TURN_USAGE_ID_MAX_LENGTH)
    ) ||
    !(raw.accountId === null || isAccountId(raw.accountId))
  ) {
    return null;
  }
  const tokens = readTokens(raw.tokens);
  if (tokens === null) return null;

  const drop = (path: string) =>
    warnings.push({
      reason: "dropped-invalid-field",
      path: `${prefix}${path}`,
    });

  // A cost is only worth what its basis says it is: without one this build
  // knows, every cost goes, the models' too, and the tokens stay.
  const basis = (
    EXECUTION_TURN_USAGE_COST_BASES as readonly unknown[]
  ).includes(raw.costBasis)
    ? (raw.costBasis as ExecutionTurnUsageCostBasis)
    : undefined;
  const cost = (value: unknown, path: string): number | undefined => {
    if (value === undefined || basis === undefined) return undefined;
    if (isCost(value)) return value;
    drop(path);
    return undefined;
  };

  const costUsdReported = cost(raw.costUsdReported, "costUsdReported");
  let models: ExecutionTurnModelUsage[] | undefined;
  if (raw.models !== undefined) {
    models = readModels(raw.models, tokens, cost) ?? undefined;
    if (models === undefined) drop("models");
  }
  const anyCost =
    raw.costUsdReported !== undefined ||
    (Array.isArray(raw.models) &&
      raw.models.some(
        (entry) => isRecord(entry) && entry.costUsdReported !== undefined,
      ));
  if (anyCost && basis === undefined) drop("costBasis");
  const priced =
    costUsdReported !== undefined ||
    (models?.some((entry) => entry.costUsdReported !== undefined) ?? false);

  return {
    providerId: raw.providerId,
    model: raw.model as string | null,
    accountId: raw.accountId as string | null,
    tokens,
    ...(costUsdReported === undefined ? {} : { costUsdReported }),
    ...(priced ? { costBasis: basis } : {}),
    ...(models === undefined ? {} : { models }),
  };
}

/**
 * Null when it is not a list of 1 to `EXECUTION_TURN_USAGE_MODELS_MAX_COUNT`
 * entries, an entry cannot be read, a model comes twice, or the models'
 * tokens do not add up to the turn's (`addsUp`): a part of the split, or a
 * split that counts some tokens twice, is no split. Its costs are read only
 * once it stands, and a model's unreadable cost is left out on its own.
 */
function readModels(
  raw: unknown,
  total: ExecutionTurnTokens,
  cost: (value: unknown, path: string) => number | undefined,
): ExecutionTurnModelUsage[] | null {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > EXECUTION_TURN_USAGE_MODELS_MAX_COUNT
  ) {
    return null;
  }
  const split: Array<{ model: string; tokens: ExecutionTurnTokens }> = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !isBoundedString(entry.model, EXECUTION_TURN_USAGE_ID_MAX_LENGTH) ||
      split.some((kept) => kept.model === entry.model)
    ) {
      return null;
    }
    const tokens = readTokens(entry.tokens);
    if (tokens === null) return null;
    split.push({ model: entry.model, tokens });
  }
  if (
    !addsUp(
      split.map((entry) => entry.tokens),
      total,
    )
  ) {
    return null;
  }
  return split.map((entry, index) => {
    const costUsdReported = cost(
      (raw[index] as Record<string, unknown>).costUsdReported,
      `models.${index}.costUsdReported`,
    );
    return {
      ...entry,
      ...(costUsdReported === undefined ? {} : { costUsdReported }),
    };
  });
}

/**
 * Whether the models' tokens are the turn's, kind by kind: each count the sum
 * of the models'. `reasoning` too: a turn that says none has no model saying
 * any, and one that says it has every model saying its part. Costs are not
 * checked: they are amounts in floating point, and a reader that prices by
 * model prices the tokens.
 */
function addsUp(
  parts: ExecutionTurnTokens[],
  total: ExecutionTurnTokens,
): boolean {
  const sum = (count: (tokens: ExecutionTurnTokens) => number) =>
    parts.reduce((running, part) => running + count(part), 0);
  if (!TOKEN_KINDS.every((kind) => sum((part) => part[kind]) === total[kind])) {
    return false;
  }
  if (total.reasoning === undefined) {
    return parts.every((part) => part.reasoning === undefined);
  }
  return (
    parts.every((part) => part.reasoning !== undefined) &&
    sum((part) => part.reasoning!) === total.reasoning
  );
}

const TOKEN_KINDS = [
  "input",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
  "output",
] as const;

function readTokens(raw: unknown): ExecutionTurnTokens | null {
  if (!isRecord(raw)) return null;
  if (!TOKEN_KINDS.every((kind) => isSafeNonNegativeInteger(raw[kind]))) {
    return null;
  }
  if (raw.reasoning !== undefined && !isSafeNonNegativeInteger(raw.reasoning)) {
    return null;
  }
  return {
    input: raw.input as number,
    cacheWrite5m: raw.cacheWrite5m as number,
    cacheWrite1h: raw.cacheWrite1h as number,
    cacheRead: raw.cacheRead as number,
    output: raw.output as number,
    ...(raw.reasoning === undefined
      ? {}
      : { reasoning: raw.reasoning as number }),
  };
}

function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** An opaque id: never an email, nor anything with an `@` that could be one. */
function isAccountId(value: unknown): value is string {
  return (
    isBoundedString(value, EXECUTION_TURN_USAGE_ID_MAX_LENGTH) &&
    !value.includes("@") &&
    value.trim() === value
  );
}
