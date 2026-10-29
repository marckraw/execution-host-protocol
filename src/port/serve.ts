import type { ExecutionHostApi } from "../client/api.js";
import type { ExecutionSessionFollow } from "../client/follow.js";
import type {
  ExecutionDeltaMode,
  ExecutionStreamFrame,
} from "../client/stream.js";
import { isNonEmptyString } from "../guards.js";
import { toPortError } from "./errors.js";
import {
  listen,
  PORT_CHANNEL,
  PORT_METHODS,
  PORT_OPTIONS_INDEX,
  PORT_VERSION,
  readTagged,
  type ExecutionHostPort,
  type PortAnswer,
  type PortMethod,
} from "./port.js";

/** The most frames one message of a stream holds. */
export const PORT_FRAMES_PER_CHUNK = 256;
/** The most chunks of one stream sent and not yet read. */
export const PORT_CHUNKS_IN_FLIGHT = 4;

export interface ExecutionHostPortServer {
  /**
   * Stops serving: aborts the calls still running, stops every follow, stops
   * listening and closes the port, which the client hears as the port closing.
   */
  close(): void;
}

interface Stream {
  follow: ExecutionSessionFollow | null;
  chunk: ExecutionStreamFrame[];
  inFlight: number;
  /** Envelope handlers waiting for the client to read a chunk. */
  waiting: Array<() => void>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Cancelled by the client, or the server closing: send nothing more. */
  over: boolean;
}

/**
 * Serves `api` on one end of a `MessagePort` (MAR-4862), for
 * `createPortClient` on the other.
 *
 * Each call runs `api`'s method with the client's arguments and a signal the
 * client's cancel aborts, and answers with its value or its error, which
 * crosses with its class and fields. A follow runs `api.followSession` and
 * sends what it hands on as stream frames, batched into chunks of at most
 * `PORT_FRAMES_PER_CHUNK`, with at most `PORT_CHUNKS_IN_FLIGHT` unread: a
 * long replay is sent in pieces, and the follow waits for the client rather
 * than queueing the whole log. The stream ends when the client cancels it, or
 * with the error that ended the follow — `not-found` once the session is gone.
 */
export function servePort(
  port: ExecutionHostPort,
  api: ExecutionHostApi,
): ExecutionHostPortServer {
  const calls = new Map<number, AbortController>();
  const streams = new Map<number, Stream>();
  let closed = false;

  const post = (answer: DistributiveOmit<PortAnswer, "channel" | "v">) => {
    if (closed) return;
    port.postMessage({ channel: PORT_CHANNEL, v: PORT_VERSION, ...answer });
  };

  const call = (id: number, method: unknown, args: unknown) => {
    if (calls.has(id) || streams.has(id)) return;
    const controller = new AbortController();
    calls.set(id, controller);
    void Promise.resolve()
      .then(() => invoke(api, method, args, controller.signal))
      .then(
        (value) => {
          if (controller.signal.aborted) return;
          try {
            post({ type: "result", id, value });
          } catch (error) {
            // A value that does not clone is the implementation's mistake.
            post({ type: "error", id, error: toPortError(error) });
          }
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          post({ type: "error", id, error: toPortError(error) });
        },
      )
      .finally(() => calls.delete(id));
  };

  const flush = (id: number, stream: Stream) => {
    if (stream.flushTimer !== null) {
      clearTimeout(stream.flushTimer);
      stream.flushTimer = null;
    }
    if (stream.over || stream.chunk.length === 0) return;
    const frames = stream.chunk;
    stream.chunk = [];
    stream.inFlight += 1;
    try {
      post({ type: "frames", id, frames });
    } catch (error) {
      // A frame that does not clone ends the stream, out loud: thrown from a
      // timer, it would end the process instead.
      post({ type: "end", id, error: toPortError(error) });
      endStream(id, stream);
      void stream.follow?.stop();
    }
  };

  const release = (stream: Stream) => {
    for (const resume of stream.waiting.splice(0)) resume();
  };

  /**
   * Queues a frame. Returns a promise, for the follow to await, while the
   * client has as many chunks unread as it may.
   */
  const push = (
    id: number,
    stream: Stream,
    frame: ExecutionStreamFrame,
  ): void | Promise<void> => {
    if (stream.over) return;
    stream.chunk.push(frame);
    if (stream.chunk.length >= PORT_FRAMES_PER_CHUNK) flush(id, stream);
    else if (stream.flushTimer === null) {
      // What arrives in the same turn travels together: a replay read from
      // a log in one go is a few messages, not one per envelope.
      stream.flushTimer = setTimeout(() => flush(id, stream), 0);
    }
    if (stream.inFlight < PORT_CHUNKS_IN_FLIGHT) return;
    return new Promise((resolve) => stream.waiting.push(resolve));
  };

  const endStream = (id: number, stream: Stream) => {
    stream.over = true;
    if (stream.flushTimer !== null) clearTimeout(stream.flushTimer);
    stream.flushTimer = null;
    stream.chunk = [];
    release(stream);
    streams.delete(id);
  };

  const follow = (
    id: number,
    sessionId: unknown,
    afterSeq: unknown,
    deltas: unknown,
  ) => {
    if (calls.has(id) || streams.has(id)) return;
    const stream: Stream = {
      follow: null,
      chunk: [],
      inFlight: 0,
      waiting: [],
      flushTimer: null,
      over: false,
    };
    streams.set(id, stream);
    const finish = (error: unknown) => {
      if (stream.over) return;
      flush(id, stream);
      post({
        type: "end",
        id,
        error: error === null ? null : toPortError(error),
      });
      endStream(id, stream);
    };
    if (!isNonEmptyString(sessionId)) {
      finish(new TypeError("A follow names a session"));
      return;
    }
    // The host has the request: the stream is open, as a 200 opens one.
    void push(id, stream, { type: "open" });
    try {
      const following = api.followSession(sessionId, {
        afterSeq: afterSeq as number,
        deltas:
          deltas === "append" ? "append" : ("full-text" as ExecutionDeltaMode),
        onEnvelope: (envelope, info) =>
          push(id, stream, {
            type: "envelope",
            envelope,
            replay: info.replay,
            warnings: info.warnings,
          }),
        onSkip: (skip) =>
          push(
            id,
            stream,
            skip.reason === "unknown-kind"
              ? {
                  type: "skipped",
                  skipped: {
                    sessionId,
                    seq: skip.seq,
                    path: skip.path,
                    kind: skip.kind,
                  },
                  replay: false,
                }
              : {
                  type: "unreadable",
                  reason: skip.detail,
                  id: skip.seq === null ? null : String(skip.seq),
                  replay: false,
                },
          ),
        onStatus: (status) => {
          // The client resequences: where the replay ends is all it needs.
          if (status.state === "live") {
            void push(id, stream, {
              type: "caught-up",
              throughSeq: status.lastSeq,
            });
          }
        },
      });
      stream.follow = following;
      void following.done.then((end) =>
        finish(end.reason === "stopped" ? null : end.error),
      );
    } catch (error) {
      finish(error);
    }
  };

  const cancel = (id: number) => {
    calls.get(id)?.abort();
    const stream = streams.get(id);
    if (stream) {
      endStream(id, stream);
      void stream.follow?.stop();
    }
  };

  const ack = (id: number) => {
    const stream = streams.get(id);
    if (!stream) return;
    stream.inFlight = Math.max(0, stream.inFlight - 1);
    if (stream.inFlight < PORT_CHUNKS_IN_FLIGHT) release(stream);
  };

  const shutDown = () => {
    if (closed) return;
    closed = true;
    detach();
    for (const controller of calls.values()) controller.abort();
    calls.clear();
    for (const [id, stream] of [...streams]) {
      endStream(id, stream);
      void stream.follow?.stop();
    }
  };

  const detach = listen(
    port,
    (data) => {
      const message = readTagged(data);
      if (message === null || closed) return;
      const id = message.id as number;
      switch (message.type) {
        case "call":
          return call(id, message.method, message.args);
        case "follow":
          return follow(
            id,
            message.sessionId,
            message.afterSeq,
            message.deltas,
          );
        case "cancel":
          return cancel(id);
        case "ack":
          return ack(id);
      }
    },
    shutDown,
  );

  return {
    close: () => {
      shutDown();
      port.close?.();
    },
  };
}

/**
 * Runs one of `api`'s methods by name, with the caller's arguments and, in
 * place of the caller's signal, this side's. Only the port's methods: a name
 * the port does not serve is refused, as a host refuses a route it lacks.
 */
function invoke(
  api: ExecutionHostApi,
  method: unknown,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!(PORT_METHODS as readonly unknown[]).includes(method)) {
    throw new TypeError(`The port does not serve ${String(method)}`);
  }
  const name = method as PortMethod;
  if (!Array.isArray(args))
    throw new TypeError(`${name} takes an argument list`);
  const index = PORT_OPTIONS_INDEX[name];
  const given = args.slice(0, index);
  const options: unknown = args[index];
  given[index] = {
    ...(typeof options === "object" && options !== null ? options : {}),
    signal,
  };
  const run = api[name] as (...args: unknown[]) => Promise<unknown>;
  return run.apply(api, given);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
