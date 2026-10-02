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
  type Scrub,
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
 * read; `id` is its SSE id, which on a host's frames is the `seq` it held, or
 * null for an envelope about another session, which has no place in this
 * one's stream. `caught-up` — the host's replay is complete through
 * `throughSeq` (null when the frame was unreadable).
 *
 * `replay` is true on a frame the host named as replayed history. Frames under
 * any other name than `replay`, `caught-up` or `message` are not read at all.
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
  /** Takes the token out of any message built from a failure. */
  scrub: Scrub;
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
    scrub: connection.scrub,
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

    // `== null`: React Native's fetch leaves a missing body undefined.
    if (!response.ok || response.body == null) {
      const reason = response.ok
        ? "the stream has no body"
        : await reasonOf(response, connection.scrub);
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
        const decoded = readFrame(frame, sessionId);
        if (decoded !== null) yield decoded;
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

/** The SSE default name: a frame named `message` is an unnamed one. */
const DEFAULT_EVENT = "message";

/**
 * One SSE frame as a stream frame, or null for a frame this reader does not
 * listen to. Only unnamed (or `message`) frames and `replay` frames carry
 * envelopes, and `caught-up` carries the boundary; any other name is a frame
 * for some other listener and is ignored unread, as EventSource ignores the
 * names nobody listens for.
 */
function readFrame(
  frame: SseFrame,
  sessionId: string,
): ExecutionStreamFrame | null {
  if (frame.event === EXECUTION_CAUGHT_UP_EVENT) {
    return {
      type: "caught-up",
      throughSeq: decodeExecutionCaughtUp(frame.data),
    };
  }
  if (
    frame.event !== null &&
    frame.event !== DEFAULT_EVENT &&
    frame.event !== EXECUTION_REPLAY_EVENT
  ) {
    return null;
  }
  const replay = frame.event === EXECUTION_REPLAY_EVENT;
  const decoded = decodeExecutionEventEnvelope(frame.data);
  const about = decoded.ok
    ? decoded.value.sessionId
    : decoded.skipped?.sessionId;
  if (about !== undefined && about !== sessionId) {
    // An envelope about another session says nothing about where this one
    // is, so its id is no place in this stream: unreadable, and unplaced.
    return { type: "unreadable", reason: "invalid-envelope", id: null, replay };
  }
  if (decoded.ok) {
    return {
      type: "envelope",
      envelope: decoded.value,
      replay,
      warnings: decoded.warnings ?? [],
    };
  }
  if (decoded.skipped) {
    return { type: "skipped", skipped: decoded.skipped, replay };
  }
  return { type: "unreadable", reason: decoded.reason, id: frame.id, replay };
}
