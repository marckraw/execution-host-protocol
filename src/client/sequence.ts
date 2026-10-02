/**
 * What an envelope's `seq` means, given the last one a reader kept.
 *
 * A host numbers each session's envelopes from 1, one at a time, and a reader
 * resumes with `Last-Event-ID: <last kept seq>`. Two things make holes in that
 * numbering, and a reader must tell them apart:
 *
 * - **Loss.** Frames went missing on the way. The host still holds them, so
 *   the reader resumes from its last contiguous `seq` and the host replays
 *   them. Applying the frame above the hole instead would put an event on the
 *   record with a hole under it, and move the cursor past frames nobody would
 *   ever ask for again.
 * - **Pruning.** A host deletes superseded streaming patches from its own log
 *   once an item settles (MAR-2218a), so its replay has holes that nothing can
 *   fill: the next frame restates the same text.
 *
 * The phase of the stream is what separates them (MAR-3051, Convergence). The
 * first frame of a connection answers the cursor, so a hole under it is the
 * host's own pruned history. A host that names its replay (`event: replay`, up
 * to an `event: caught-up` frame) vouches for every hole inside it. After
 * that, on a live stream, a hole is loss.
 */

/**
 * `accept` — keep it and move the cursor. `duplicate` — at or below the
 * cursor: a replay re-delivering what the reader holds. `gap` — frames above
 * the cursor were lost; resume rather than apply.
 */
export type ExecutionSeqReading = "accept" | "duplicate" | "gap";

/**
 * `resumed` — before the first kept frame of a connection. `replay` — inside a
 * replay the host has named, until it says it caught up. `live` — everything
 * else, where the next number is the only number.
 */
export type ExecutionStreamPhase = "resumed" | "replay" | "live";

export function readExecutionSeq(
  lastSeq: number,
  seq: number,
  phase: ExecutionStreamPhase,
): ExecutionSeqReading {
  if (seq <= lastSeq) return "duplicate";
  if (seq > lastSeq + 1 && phase === "live") return "gap";
  return "accept";
}

/**
 * The phase after one frame was read. Only the first kept frame of a resume is
 * forgiven a hole: the host answered the cursor once, and a second hole on the
 * same connection is loss like any other. A named replay keeps its phase until
 * its `caught-up` frame.
 */
export function nextExecutionStreamPhase(
  phase: ExecutionStreamPhase,
  reading: ExecutionSeqReading,
): ExecutionStreamPhase {
  return phase === "resumed" && reading === "accept" ? "live" : phase;
}

/**
 * The SSE names a host puts on its replay boundary (agents-daemon `414f740`,
 * MAR-3053). `replay` is the name ON a replayed envelope frame, which is read
 * like any other; `caught-up` is the one frame that carries no envelope, only
 * `{"throughSeq": N}`. A host that names neither leaves the `resumed` phase to
 * carry the whole rule, and a reader reads its stream exactly as before.
 */
export const EXECUTION_REPLAY_EVENT = "replay";
export const EXECUTION_CAUGHT_UP_EVENT = "caught-up";

/**
 * The `throughSeq` of a `caught-up` frame, or null when the frame says
 * something unreadable. Null is not zero: an unreadable boundary leaves the
 * cursor where it was rather than moving it to the start of the log.
 */
export function decodeExecutionCaughtUp(data: string): number | null {
  try {
    const parsed: unknown = JSON.parse(data);
    const throughSeq =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { throughSeq?: unknown }).throughSeq
        : undefined;
    return typeof throughSeq === "number" &&
      Number.isInteger(throughSeq) &&
      throughSeq >= 0
      ? throughSeq
      : null;
  } catch {
    return null;
  }
}

/** A frame's `id:` as a sequence number, when it is one. */
export function seqOfFrameId(id: string | null): number | null {
  if (id === null || !/^\d+$/.test(id)) return null;
  const seq = Number(id);
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : null;
}
