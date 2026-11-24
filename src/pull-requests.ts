import {
  isBoundedString,
  isHttpUrl,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isTimestamp,
  readShowableText,
} from "./guards.js";
import type { ExecutionDecodeResult, ExecutionDecodeWarning } from "./types.js";

/**
 * What a session did to a pull request (MAR-5696): it `opened` it, `pushed`
 * to its head, `merged` it, `edited` it, `reviewed` it, or only `mentioned`
 * it. `mentioned` shows in a session's list alone, never on a row or as its
 * primary.
 */
export const EXECUTION_PULL_REQUEST_ROLES = [
  "opened",
  "pushed",
  "merged",
  "edited",
  "reviewed",
  "mentioned",
] as const;
export type ExecutionPullRequestRole =
  (typeof EXECUTION_PULL_REQUEST_ROLES)[number];

/**
 * How the host knows: a `command` the agent ran (`gh pr …`), an `mcp-tool`
 * call (the GitHub MCP tools), a PR URL in a tool's `output-url`, or the
 * session's own `branch` being the PR's head, which is `pushed`.
 */
export const EXECUTION_PULL_REQUEST_SOURCES = [
  "command",
  "mcp-tool",
  "output-url",
  "branch",
] as const;
export type ExecutionPullRequestSource =
  (typeof EXECUTION_PULL_REQUEST_SOURCES)[number];

/** A pull request's state, as GitHub says it, a draft apart from open. */
export const EXECUTION_PULL_REQUEST_STATES = [
  "draft",
  "open",
  "merged",
  "closed",
] as const;
export type ExecutionPullRequestStatus =
  (typeof EXECUTION_PULL_REQUEST_STATES)[number];

/** GitHub's `reviewDecision`, in the protocol's spelling. */
export const EXECUTION_PULL_REQUEST_REVIEW_DECISIONS = [
  "approved",
  "changes-requested",
  "review-required",
] as const;
export type ExecutionPullRequestReviewDecision =
  (typeof EXECUTION_PULL_REQUEST_REVIEW_DECISIONS)[number];

/**
 * How many `mentioned` facts a session carries at most: the host keeps the
 * newest, and a reader keeps no more than this of a longer list. Every fact
 * of another role is kept, whatever their number: a cap that could drop one
 * would change the session's primary (MAR-5696 review).
 */
export const EXECUTION_PULL_REQUEST_MENTIONS_MAX = 100;

/** The bound on a fact's `itemId` and `agentRunId`. */
const ID_MAX_LENGTH = 256;
/** GitHub's own bound on a title. */
const TITLE_MAX_LENGTH = 256;
const URL_MAX_LENGTH = 2048;

/**
 * `owner/name` as GitHub allows them: an owner of up to 39 letters, digits
 * and inner hyphens; a name of up to 100 letters, digits, `.`, `_` and `-`,
 * never `.` or `..`.
 */
const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** A repository as the protocol names one: `owner/name`. */
export function isExecutionPullRequestRepository(
  value: unknown,
): value is string {
  return typeof value === "string" && REPOSITORY.test(value);
}

/**
 * What a host that reads GitHub itself (`sessions.pullRequests.state.v1`, the
 * personal profile on a Mac) last read of a pull request. Every fact about
 * one pull request carries the same state.
 */
export interface ExecutionPullRequestState {
  state: ExecutionPullRequestStatus;
  /** Its head's checks: how many passed, failed, and still run. */
  checks: { passed: number; failed: number; running: number };
  /** Absent: none yet, or GitHub did not say. */
  reviewDecision?: ExecutionPullRequestReviewDecision;
  /** False when it conflicts with its base. Absent: GitHub has not worked it out. */
  mergeable?: boolean;
  /** Cleaned of what reorders or breaks a line, and cut at 256. */
  title: string;
  url: string;
  /** When the host read it. */
  checkedAt: string;
}

/**
 * One thing a session did to one pull request (MAR-5696). A session's
 * `pullRequests` holds one per pull request and role, newest first: the
 * same role again moves its fact up, with the newer `at`.
 */
export interface ExecutionPullRequestFact {
  /** `owner/name`, any repository; compared without regard to case. */
  repository: string;
  number: number;
  role: ExecutionPullRequestRole;
  source: ExecutionPullRequestSource;
  /** The conversation item it was read from, when there was one. */
  itemId?: string;
  /** The subagent run that acted, when it was not the session's own agent. */
  agentRunId?: string;
  /** When the session did it, as the host heard it. */
  at: string;
  /** On a host advertising `sessions.pullRequests.state.v1` alone. */
  state?: ExecutionPullRequestState;
}

/** Which pull request a fact is about. */
export interface ExecutionPullRequestRef {
  repository: string;
  number: number;
}

/**
 * The one key of a pull request: `owner/name#number`, lowercased, since
 * GitHub's names ignore case. Two facts with the same key are about the
 * same pull request; the same number in another repository is another one.
 */
export function pullRequestKeyOf(ref: ExecutionPullRequestRef): string {
  return `${ref.repository.toLowerCase()}#${ref.number}`;
}

/** What `primaryPullRequestOf` reads of a fact; any wider shape will do. */
export interface ExecutionPullRequestPrimaryCandidate extends ExecutionPullRequestRef {
  role: ExecutionPullRequestRole;
  at: string;
  /** When there are several, the one read last counts (`checkedAt`). */
  state?: { state: ExecutionPullRequestStatus; checkedAt?: string };
}

/**
 * A session's primary pull request (MAR-5695, board 4): the newest it
 * opened; else the newest it pushed to; else the newest still open of those
 * it edited or reviewed; else the newest it merged; else none. The chip,
 * the after-chains and every one-PR reader follow it, so the server, the web
 * app and the daemon all take it from here.
 *
 * "Still open" is known: the pull request's state, the one read last of any
 * of its facts, is open or a draft, and the session did not merge it. One
 * whose state nobody read is not still open, so a host that reads no state
 * never makes an edit or a review primary. Mentions are never primary.
 *
 * Pure, and blind to order: "newest" is the latest `at`, then the higher
 * number, then the repository first in code-unit order (case aside, then as
 * spelt), then the role first in `EXECUTION_PULL_REQUEST_ROLES`, so the same
 * facts in any order give the same answer. It hands back the fact itself.
 */
export function primaryPullRequestOf<
  T extends ExecutionPullRequestPrimaryCandidate,
>(facts: readonly T[]): T | null {
  const opened = newestOf(facts.filter((fact) => fact.role === "opened"));
  if (opened) return opened;
  const pushed = newestOf(facts.filter((fact) => fact.role === "pushed"));
  if (pushed) return pushed;
  const states = new Map<string, { state: ExecutionPullRequestStatus }>();
  const merged = new Set<string>();
  for (const fact of facts) {
    const key = pullRequestKeyOf(fact);
    if (fact.role === "merged") merged.add(key);
    if (!fact.state) continue;
    const held = states.get(key);
    if (!held || fresherState(fact.state, held) < 0) {
      states.set(key, fact.state);
    }
  }
  const changed = newestOf(
    facts.filter((fact) => {
      if (fact.role !== "edited" && fact.role !== "reviewed") return false;
      const key = pullRequestKeyOf(fact);
      const state = states.get(key)?.state;
      return (state === "open" || state === "draft") && !merged.has(key);
    }),
  );
  if (changed) return changed;
  return newestOf(facts.filter((fact) => fact.role === "merged"));
}

function newestOf<T extends ExecutionPullRequestPrimaryCandidate>(
  facts: readonly T[],
): T | null {
  let newest: T | null = null;
  for (const fact of facts) {
    if (newest === null || newerFirst(fact, newest) < 0) newest = fact;
  }
  return newest;
}

function timeOf(at: string | undefined): number {
  const time = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Negative when `left` is the larger of two numbers `right` is not. */
function byLarger(left: number, right: number): number {
  return left > right ? -1 : left < right ? 1 : 0;
}

function byCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Negative when `left` is the newer: the order a session's list is in. */
function newerFirst(
  left: ExecutionPullRequestPrimaryCandidate,
  right: ExecutionPullRequestPrimaryCandidate,
): number {
  return (
    byLarger(timeOf(left.at), timeOf(right.at)) ||
    byLarger(left.number, right.number) ||
    byCodeUnits(
      left.repository.toLowerCase(),
      right.repository.toLowerCase(),
    ) ||
    byCodeUnits(left.repository, right.repository) ||
    EXECUTION_PULL_REQUEST_ROLES.indexOf(left.role) -
      EXECUTION_PULL_REQUEST_ROLES.indexOf(right.role)
  );
}

/** The more settled of two states read at once: an end outranks an open. */
const STATE_RANK: Record<ExecutionPullRequestStatus, number> = {
  merged: 0,
  closed: 1,
  open: 2,
  draft: 3,
};

/**
 * Negative when `left` is the state to keep: the one read last (a state
 * without `checkedAt` last of all), and of two read at once the more
 * settled, so the choice is blind to order too.
 */
function fresherState(
  left: { state: ExecutionPullRequestStatus; checkedAt?: string },
  right: { state: ExecutionPullRequestStatus; checkedAt?: string },
): number {
  return (
    byLarger(timeOf(left.checkedAt), timeOf(right.checkedAt)) ||
    STATE_RANK[left.state] - STATE_RANK[right.state]
  );
}

/**
 * Reads a session's `pullRequests`, wherever it sits: a snapshot, the list,
 * a `session.patch`. Anything but an array is refused. A fact this build
 * cannot read, as one of a role or source it does not know, is dropped and
 * named; so is a state it cannot read, the fact kept. What it keeps is the
 * contract's list whatever the host sent: one fact per pull request and
 * role, the newest; newest first; every fact but mentions, and at most
 * `EXECUTION_PULL_REQUEST_MENTIONS_MAX` of those, the newest; and one state
 * per pull request, the one read last of any fact the host sent, a fact
 * dropped as older included.
 *
 * Warnings' paths start at `pullRequests`; a caller puts its own place
 * before them.
 */
export function decodeExecutionPullRequests(
  raw: unknown,
): ExecutionDecodeResult<ExecutionPullRequestFact[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: "invalid-payload" };
  const warnings: ExecutionDecodeWarning[] = [];
  const byFact = new Map<string, ExecutionPullRequestFact>();
  // One state per pull request, the one read last, chosen before any fact
  // is dropped as older: an older action can carry the newer read.
  const states = new Map<string, ExecutionPullRequestState>();
  raw.forEach((entry, index) => {
    const path = `pullRequests.${index}`;
    const fact = readFact(entry, path, warnings);
    if (!fact) {
      warnings.push({ reason: "dropped-invalid-field", path });
      return;
    }
    const pullRequest = pullRequestKeyOf(fact);
    if (fact.state) {
      const held = states.get(pullRequest);
      if (!held || fresherState(fact.state, held) < 0) {
        states.set(pullRequest, fact.state);
      }
    }
    const key = `${pullRequest} ${fact.role}`;
    const held = byFact.get(key);
    if (!held || newerFirst(fact, held) < 0) byFact.set(key, fact);
  });

  let mentions = 0;
  let excess = false;
  const facts: ExecutionPullRequestFact[] = [];
  for (const fact of [...byFact.values()].sort(newerFirst)) {
    if (fact.role === "mentioned") {
      mentions += 1;
      if (mentions > EXECUTION_PULL_REQUEST_MENTIONS_MAX) {
        excess = true;
        continue;
      }
    }
    const { state: _, ...bare } = fact;
    const state = states.get(pullRequestKeyOf(fact));
    facts.push(state ? { ...bare, state } : bare);
  }
  if (excess) {
    warnings.push({ reason: "dropped-excess-entries", path: "pullRequests" });
  }
  return {
    ok: true,
    value: facts,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function readFact(
  raw: unknown,
  path: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionPullRequestFact | null {
  if (
    !isRecord(raw) ||
    !isExecutionPullRequestRepository(raw.repository) ||
    !isSafePositiveInteger(raw.number) ||
    !oneOf(EXECUTION_PULL_REQUEST_ROLES, raw.role) ||
    !oneOf(EXECUTION_PULL_REQUEST_SOURCES, raw.source) ||
    !isTimestamp(raw.at) ||
    (raw.itemId !== undefined && !isBoundedString(raw.itemId, ID_MAX_LENGTH)) ||
    (raw.agentRunId !== undefined &&
      !isBoundedString(raw.agentRunId, ID_MAX_LENGTH))
  ) {
    return null;
  }
  const state =
    raw.state === undefined
      ? undefined
      : readState(raw.state, `${path}.state`, warnings);
  if (raw.state !== undefined && state === undefined) {
    warnings.push({ reason: "dropped-invalid-field", path: `${path}.state` });
  }
  return {
    repository: raw.repository,
    number: raw.number as number,
    role: raw.role,
    source: raw.source,
    ...(raw.itemId === undefined ? {} : { itemId: raw.itemId as string }),
    ...(raw.agentRunId === undefined
      ? {}
      : { agentRunId: raw.agentRunId as string }),
    at: raw.at,
    ...(state === undefined ? {} : { state }),
  };
}

function readState(
  raw: unknown,
  path: string,
  warnings: ExecutionDecodeWarning[],
): ExecutionPullRequestState | undefined {
  if (!isRecord(raw) || !isRecord(raw.checks)) return undefined;
  const { passed, failed, running } = raw.checks;
  const title = readShowableText(raw.title, TITLE_MAX_LENGTH);
  if (
    !oneOf(EXECUTION_PULL_REQUEST_STATES, raw.state) ||
    !isSafeNonNegativeInteger(passed) ||
    !isSafeNonNegativeInteger(failed) ||
    !isSafeNonNegativeInteger(running) ||
    title === undefined ||
    !isBoundedString(raw.url, URL_MAX_LENGTH) ||
    !isHttpUrl(raw.url) ||
    !isTimestamp(raw.checkedAt)
  ) {
    return undefined;
  }
  // A decision or mergeability this build cannot read costs only itself.
  let reviewDecision: ExecutionPullRequestReviewDecision | undefined;
  if (raw.reviewDecision !== undefined) {
    if (oneOf(EXECUTION_PULL_REQUEST_REVIEW_DECISIONS, raw.reviewDecision)) {
      reviewDecision = raw.reviewDecision;
    } else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.reviewDecision`,
      });
    }
  }
  let mergeable: boolean | undefined;
  if (raw.mergeable !== undefined) {
    if (typeof raw.mergeable === "boolean") mergeable = raw.mergeable;
    else {
      warnings.push({
        reason: "dropped-invalid-field",
        path: `${path}.mergeable`,
      });
    }
  }
  return {
    state: raw.state,
    checks: { passed, failed, running },
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    ...(mergeable === undefined ? {} : { mergeable }),
    title,
    url: raw.url,
    checkedAt: raw.checkedAt,
  };
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (values as readonly unknown[]).includes(value);
}
