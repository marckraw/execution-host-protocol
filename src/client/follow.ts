import type {
  ExecutionDecodeFailureReason,
  ExecutionDecodeWarning,
  ExecutionHostEventEnvelope,
} from "../types.js";
import { ExecutionHostError } from "./http.js";
import {
  nextExecutionStreamPhase,
  readExecutionSeq,
  seqOfFrameId,
  type ExecutionStreamPhase,
} from "./sequence.js";
import type { ExecutionDeltaMode, ExecutionStreamFrame } from "./stream.js";

export interface ExecutionFollowEnvelopeInfo {
  /** The host named this frame as replayed history (hosts with `414f740`). */
  replay: boolean;
  /** Optional fields the decoder dropped from this envelope. */
  warnings: ExecutionDecodeWarning[];
}

/**
 * The follower's state may be missing something; refetching the snapshot is
 * how to be sure.
 *
 * `hole` — live frames were lost above `lastSeq`; `seq` arrived instead. The
 * follower has already closed the stream, and resumes from `lastSeq` so the
 * host replays what was lost.
 * `unreadable` — the frame at `seq` could not be read, so it was stepped over;
 * reading it again would fail the same way.
 *
 * Either way, a handler that refetches the snapshot can return its `lastSeq`,
 * and the follower carries on after it rather than delivering what the
 * snapshot already holds.
 */
export type ExecutionFollowGap =
  | { reason: "hole"; lastSeq: number; seq: number }
  | { reason: "unreadable"; lastSeq: number; seq: number };

/**
 * A frame the follower did not hand on. `unknown-kind` — a newer host's kind;
 * the cursor moved past it (MAR-3633). `unreadable` — not an envelope this
 * client can read; `seq` is null when the frame did not say where it sat.
 */
export type ExecutionFollowSkip =
  | { reason: "unknown-kind"; seq: number; path: string; kind: string }
  | {
      reason: "unreadable";
      seq: number | null;
      detail: ExecutionDecodeFailureReason;
    };

/**
 * `connecting` — opening the stream after `afterSeq`; `attempt` counts the
 * connections in a row that kept nothing. `open` — the host answered.
 * `live` — the host said its replay is complete (hosts that name it).
 * `waiting` — the stream ended; reconnecting in `delayMs`. `error` is why, or
 * null when the host simply closed it.
 */
export type ExecutionFollowStatus =
  | { state: "connecting"; afterSeq: number; attempt: number }
  | { state: "open"; afterSeq: number }
  | { state: "live"; lastSeq: number }
  | { state: "waiting"; attempt: number; delayMs: number; error: unknown };

/**
 * Why a follow ended. Only `stop()` (or the caller's signal) and the host's
 * own verdicts end one: `no-session` (the host does not have it — torn down,
 * or never started there) and `unauthorized` (it refused the token).
 * `gave-up` happens only when `maxAttempts` is set and ran out.
 */
export type ExecutionFollowEnd =
  | { reason: "stopped"; lastSeq: number }
  | { reason: "no-session"; lastSeq: number; error: ExecutionHostError }
  | { reason: "unauthorized"; lastSeq: number; error: ExecutionHostError }
  | { reason: "gave-up"; lastSeq: number; error: unknown };

export interface ExecutionFollowOptions {
  /** Follow from after this `seq` — the last one already applied; 0 for all. */
  afterSeq?: number;
  deltas?: ExecutionDeltaMode;
  /** Aborting it stops the follow, as `stop()` does. */
  signal?: AbortSignal;
  /**
   * Each envelope, in order, once. Awaited: the next frame is not read until
   * it settles, so a reader that writes each envelope down never runs ahead of
   * its own record. If it throws, the envelope was not kept: the follower
   * reconnects after the last one that was, and delivers it again.
   */
  onEnvelope(
    envelope: ExecutionHostEventEnvelope,
    info: ExecutionFollowEnvelopeInfo,
  ): void | Promise<void>;
  /** See `ExecutionFollowGap`. Return a snapshot's `lastSeq` to resume after it. */
  onGap?(gap: ExecutionFollowGap): void | number | Promise<void | number>;
  onSkip?(skip: ExecutionFollowSkip): void | Promise<void>;
  /**
   * Connection changes, for a log or a "reconnecting…" line. Never awaited.
   * The first report comes after `followSession` has returned, so a handler
   * may use the follow it belongs to — `stop()` included.
   */
  onStatus?(status: ExecutionFollowStatus): void;
  /** The wait before reconnect `attempt` (1, 2, …). Default 1 s doubling to 30 s. */
  retryDelayMs?(attempt: number): number;
  /**
   * Give up after this many unhealthy connections in a row: connections that
   * kept no frame and closed within `healthyAfterMs`. Default Infinity: a host
   * that cannot be reached is a fact about the network, not about the
   * session, so the follow keeps looking until it is stopped.
   */
  maxAttempts?: number;
  /**
   * A connection open at least this long was healthy even if it delivered
   * nothing — a quiet session between turns — so the wait before the next
   * one starts over. Default 30 s, past the host's 25 s keep-alive.
   */
  healthyAfterMs?: number;
  /**
   * Reconnect when a connection goes this long without a byte (hosts send a
   * keep-alive every 25 s). Default 90 s; null waits forever.
   */
  idleTimeoutMs?: number | null;
}

export interface ExecutionSessionFollow {
  readonly sessionId: string;
  /** The last `seq` handed on or stepped over — the cursor to persist. */
  readonly lastSeq: number;
  /** Settles when the follow ends; never rejects. */
  readonly done: Promise<ExecutionFollowEnd>;
  /** Ends the follow: closes the stream, cancels a pending reconnect. */
  stop(): Promise<ExecutionFollowEnd>;
}

export type OpenEventStream = (
  afterSeq: number,
  options: {
    deltas: ExecutionDeltaMode;
    signal: AbortSignal;
    idleTimeoutMs: number | null;
  },
) => AsyncIterable<ExecutionStreamFrame>;

/** 1 s, 2 s, 4 s … capped at 30 s. */
export function executionRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_HEALTHY_AFTER_MS = 30_000;

/**
 * Follows one session for as long as it is asked to.
 *
 * A finished turn never ends it: a shared session goes quiet between turns and
 * the next one may be anybody's, so `completed` is an envelope like any other.
 * A stream that ends or breaks is reopened after the last `seq` kept, sooner
 * when the connection was healthy — it kept a frame, or stayed open — and
 * later, up to the cap, when it was not. A `caught-up` alone is not health: a
 * host that answers the cursor and hangs up every time is failing politely. Replayed duplicates are dropped, a hole in the live stream is
 * reported and resumed, and only the host's verdicts — no such session, a
 * refused token — or `stop()` end the follow.
 */
export function followExecutionSession(
  open: OpenEventStream,
  sessionId: string,
  options: ExecutionFollowOptions,
): ExecutionSessionFollow {
  const afterSeq = options.afterSeq ?? 0;
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new RangeError(`afterSeq must be a whole number, got ${afterSeq}`);
  }
  // Without one, every envelope would fail and be retried forever.
  if (typeof options.onEnvelope !== "function") {
    throw new TypeError("followSession needs an onEnvelope handler");
  }
  const deltas = options.deltas ?? "full-text";
  const retryDelayMs = options.retryDelayMs ?? executionRetryDelayMs;
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
  const idleTimeoutMs =
    options.idleTimeoutMs === undefined
      ? DEFAULT_IDLE_TIMEOUT_MS
      : options.idleTimeoutMs;
  const healthyAfterMs = options.healthyAfterMs ?? DEFAULT_HEALTHY_AFTER_MS;

  const following = new AbortController();
  const stop = () => following.abort();
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });
  const stopped = () => following.signal.aborted;

  let lastSeq = afterSeq;
  const report = (status: ExecutionFollowStatus) => {
    try {
      options.onStatus?.(status);
    } catch {
      // A listener's mistake is not the stream's.
    }
  };
  /** A cursor a gap handler handed back, when it is one that moves forward. */
  const resumeAfter = (value: unknown, current: number) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > current
      ? value
      : current;

  const run = async (): Promise<ExecutionFollowEnd> => {
    let attempt = 0;
    while (!stopped()) {
      report({ state: "connecting", afterSeq: lastSeq, attempt });
      // A report's handler may have stopped the follow; nothing opens after.
      if (stopped()) break;
      const connection = new AbortController();
      const close = () => connection.abort();
      following.signal.addEventListener("abort", close, { once: true });
      let phase: ExecutionStreamPhase = "resumed";
      /** Kept a frame: delivered one, or stepped over one with a place. */
      let kept = false;
      let openedAt: number | null = null;
      let caughtUp = false;
      let hole: ExecutionFollowGap | null = null;
      /** Why the connection ended: the stream's own error, or a handler's. */
      let failure: unknown = null;
      let streamFailed = false;
      const frames = open(lastSeq, {
        deltas,
        signal: connection.signal,
        idleTimeoutMs,
      })[Symbol.asyncIterator]();

      try {
        for (;;) {
          let next: IteratorResult<ExecutionStreamFrame>;
          try {
            next = await frames.next();
          } catch (error) {
            streamFailed = true;
            throw error;
          }
          if (next.done || stopped()) break;
          const frame = next.value;
          if (frame.type === "open") {
            openedAt = Date.now();
            report({ state: "open", afterSeq: lastSeq });
            continue;
          }
          if (frame.type === "caught-up") {
            // Every hole below the boundary is history the host no longer
            // holds; from here on, the next number is the only number.
            phase = "live";
            caughtUp = true;
            lastSeq = resumeAfter(frame.throughSeq, lastSeq);
            report({ state: "live", lastSeq });
            continue;
          }
          // A replay ends at its boundary: past it, the name vouches for nothing.
          if (frame.replay && !caughtUp) phase = "replay";
          const seq =
            frame.type === "envelope"
              ? frame.envelope.seq
              : frame.type === "skipped"
                ? frame.skipped.seq
                : seqOfFrameId(frame.id);
          if (seq === null) {
            if (frame.type === "unreadable") {
              await options.onSkip?.({
                reason: "unreadable",
                seq: null,
                detail: frame.reason,
              });
            }
            continue;
          }
          const reading = readExecutionSeq(lastSeq, seq, phase);
          if (reading === "duplicate") continue;
          if (reading === "gap") {
            hole = { reason: "hole", lastSeq, seq };
            break;
          }

          let cursor = seq;
          if (frame.type === "envelope") {
            await options.onEnvelope(frame.envelope, {
              replay: frame.replay,
              warnings: frame.warnings,
            });
          } else if (frame.type === "skipped") {
            await options.onSkip?.({
              reason: "unknown-kind",
              seq,
              path: frame.skipped.path,
              kind: frame.skipped.kind,
            });
          } else {
            await options.onSkip?.({
              reason: "unreadable",
              seq,
              detail: frame.reason,
            });
            cursor = resumeAfter(
              await options.onGap?.({ reason: "unreadable", lastSeq, seq }),
              cursor,
            );
          }
          lastSeq = cursor;
          kept = true;
          phase = nextExecutionStreamPhase(phase, reading);
        }
        if (hole !== null && !stopped()) {
          // Let go of the stream before the reader reconciles: a snapshot can
          // take a while, and the host would go on writing to nobody.
          connection.abort();
          await frames.return?.().catch(() => {});
          lastSeq = resumeAfter(await options.onGap?.(hole), lastSeq);
        }
      } catch (error) {
        failure = error;
      } finally {
        following.signal.removeEventListener("abort", close);
        connection.abort();
        await frames.return?.().catch(() => {});
      }

      if (stopped()) break;
      if (streamFailed && failure instanceof ExecutionHostError) {
        if (failure.kind === "not-found") {
          return { reason: "no-session", lastSeq, error: failure };
        }
        if (failure.kind === "auth") {
          return { reason: "unauthorized", lastSeq, error: failure };
        }
      }
      const healthy =
        kept || (openedAt !== null && Date.now() - openedAt >= healthyAfterMs);
      if (healthy) attempt = 0;
      // A hole on a connection that was delivering is the stream's ordinary
      // repair, not a failure: resume at once, and the host replays it.
      if (hole !== null && failure === null && healthy) {
        await abortableWait(0, following.signal);
        continue;
      }
      attempt += 1;
      if (attempt > maxAttempts) {
        return {
          reason: "gave-up",
          lastSeq,
          error:
            failure ??
            new ExecutionHostError(
              "network",
              "the stream kept closing without delivering anything",
              { operation: "events" },
            ),
        };
      }
      const delayMs = Math.max(0, retryDelayMs(attempt));
      report({ state: "waiting", attempt, delayMs, error: failure });
      await abortableWait(delayMs, following.signal);
    }
    return { reason: "stopped", lastSeq };
  };

  // Started a turn later, so the caller holds the follow before any report.
  const done = Promise.resolve()
    .then(run)
    .catch((error: unknown): ExecutionFollowEnd => ({
      reason: "gave-up",
      lastSeq,
      error,
    }))
    .finally(() => options.signal?.removeEventListener("abort", stop));

  return {
    sessionId,
    get lastSeq() {
      return lastSeq;
    },
    done,
    stop: () => {
      stop();
      return done;
    },
  };
}

/**
 * Waits `ms`, or until the follow stops. Always at least one turn of the event
 * loop, even for 0: a reconnect loop that only ever awaits promises starves
 * every timer and socket in the process when a host answers instantly.
 */
function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
