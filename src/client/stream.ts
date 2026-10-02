import { decodeExecutionEventEnvelope } from "../codecs.js";
import type {
  ExecutionDecodeFailureReason,
  ExecutionDecodeWarning,
  ExecutionHostEventEnvelope,
  ExecutionSkippedEnvelope,
} from "../types.js";
import {
  ExecutionHostError,
  failureOf,
  joinUrl,
  kindOfStatus,
  reasonOf,
  seconds,
  startDeadline,
} from "./http.js";
import {
  EXECUTION_CAUGHT_UP_EVENT,
  EXECUTION_REPLAY_EVENT,
  decodeExecutionCaughtUp,
} from "./sequence.js";
import { createSseParser, type SseFrame } from "./sse.js";

/**
 * How streaming text should arrive (MAR-2218b). `full-text`, the default, is
 * always safe: every patch restates the item's whole text. `append` asks for
 * `patch.textAppend` increments instead. Asking is the whole negotiation — a
 * host that has never heard of increments ignores it and sends full text — so
 * a reader that asks must apply both forms (see the README's rules).
 */
export type ExecutionDeltaMode = "full-text" | "append";

export interface ExecutionEventStreamOptions {
  /** Resume after this `seq` (`Last-Event-ID`); 0 or absent reads from the start. */
  afterSeq?: number;
  deltas?: ExecutionDeltaMode;
  /** Ends the stream: iteration simply stops. */
  signal?: AbortSignal;
  /**
   * Fail the stream with a `timeout` error when not one byte arrives for this
   * long — a connection that died without closing. Hosts send a keep-alive
   * comment every 25 s, so a healthy stream never goes quiet that long. Null
   * (the default here) waits forever.
   */
  idleTimeoutMs?: number | null;
}

/**
 * One frame of a session's event stream, decoded.
 *
 * `open` — the host answered; frames follow. `envelope` — an envelope to
 * apply. `skipped` — a well-formed envelope of a
 * kind this build does not know: apply nothing, but its `seq` is certain
 * (MAR-3633). `unreadable` — a frame that is not an envelope this build can
 * read, or one about another session; `id` is its SSE id, which on a host's
 * frames is the `seq` it held. `caught-up` — the host's replay is complete
 * through `throughSeq` (null when the frame was unreadable).
 *
 * `replay` is true on a frame the host named as replayed history.
 */
export type ExecutionStreamFrame =
  | { type: "open" }
  | {
      type: "envelope";
      envelope: ExecutionHostEventEnvelope;
      replay: boolean;
      warnings: ExecutionDecodeWarning[];
    }
  | { type: "skipped"; skipped: ExecutionSkippedEnvelope; replay: boolean }
  | {
      type: "unreadable";
      reason: ExecutionDecodeFailureReason;
      id: string | null;
      replay: boolean;
    }
  | { type: "caught-up"; throughSeq: number | null };

export interface HostConnection {
  baseUrl: string;
  token: string;
  fetch: typeof globalThis.fetch;
}

/**
 * One connection to a session's event stream: the envelopes logged after
 * `afterSeq`, replayed, then each new one as it happens, until the host closes
 * the stream or the caller aborts. Frames are decoded but not sequenced —
 * `followSession` is the reader that keeps a cursor, resumes, and tells a hole
 * from a prune.
 *
 * Throws `ExecutionHostError` when the stream cannot be opened (`not-found` for
 * a session the host does not have, `auth` for a refused token) or breaks
 * (`network`, or `timeout` past `idleTimeoutMs`). An abort by the caller just
 * ends the iteration.
 */
export async function* streamSessionEvents(
  connection: HostConnection,
  sessionId: string,
  options: ExecutionEventStreamOptions = {},
): AsyncGenerator<ExecutionStreamFrame, void, undefined> {
  const operation = "events";
  const afterSeq = options.afterSeq ?? 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? null;
  const deadline = startDeadline(options.signal, idleTimeoutMs);
  const context = {
    operation,
    deadline,
    callerSignal: options.signal,
    timeoutReason: `no data for ${seconds(idleTimeoutMs ?? 0)}`,
  };
  const query = options.deltas === "append" ? "?deltas=append" : "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    let response: Response;
    try {
      response = await connection.fetch(
        joinUrl(
          connection.baseUrl,
          `/v0/execution/sessions/${encodeURIComponent(sessionId)}/events${query}`,
        ),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            Accept: "text/event-stream",
            ...(afterSeq > 0 ? { "Last-Event-ID": String(afterSeq) } : {}),
          },
          signal: deadline.signal,
        },
      );
    } catch (error) {
      if (options.signal?.aborted) return;
      throw failureOf(error, context);
    }

    if (!response.ok || response.body === null) {
      const reason = response.ok
        ? "the stream has no body"
        : await reasonOf(response);
      await response.body?.cancel().catch(() => {});
      throw new ExecutionHostError(
        response.ok ? "malformed" : kindOfStatus(response.status),
        reason,
        { operation, status: response.status },
      );
    }

    reader = response.body.getReader();
    // The clock runs only while this stream waits on the host: time the
    // consumer spends on a frame is not the host going quiet.
    deadline.pause();
    yield { type: "open" };
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      deadline.extend();
      try {
        read = await reader.read();
      } catch (error) {
        if (options.signal?.aborted) return;
        throw failureOf(error, context);
      }
      deadline.pause();
      if (read.done) return;
      for (const frame of parser.feed(
        decoder.decode(read.value, { stream: true }),
      )) {
        yield readFrame(frame, sessionId);
      }
    }
  } finally {
    deadline.dispose();
    // Releasing the connection when the reader is done with it — including a
    // consumer that stopped iterating early — rather than leaving the host
    // writing to a socket nobody reads.
    deadline.close();
    if (reader !== null) await reader.cancel().catch(() => {});
  }
}

function readFrame(frame: SseFrame, sessionId: string): ExecutionStreamFrame {
  if (frame.event === EXECUTION_CAUGHT_UP_EVENT) {
    return {
      type: "caught-up",
      throughSeq: decodeExecutionCaughtUp(frame.data),
    };
  }
  const replay = frame.event === EXECUTION_REPLAY_EVENT;
  const decoded = decodeExecutionEventEnvelope(frame.data);
  if (decoded.ok) {
    return decoded.value.sessionId === sessionId
      ? {
          type: "envelope",
          envelope: decoded.value,
          replay,
          warnings: decoded.warnings ?? [],
        }
      : {
          type: "unreadable",
          reason: "invalid-envelope",
          id: frame.id,
          replay,
        };
  }
  if (decoded.skipped) {
    return decoded.skipped.sessionId === sessionId
      ? { type: "skipped", skipped: decoded.skipped, replay }
      : {
          type: "unreadable",
          reason: "invalid-envelope",
          id: frame.id,
          replay,
        };
  }
  return { type: "unreadable", reason: decoded.reason, id: frame.id, replay };
}
