import type { ExecutionHostApi } from "../client/api.js";
import {
  followExecutionSession,
  type ExecutionFollowEnd,
  type ExecutionSessionFollow,
  type OpenEventStream,
} from "../client/follow.js";
import { ExecutionHostError } from "../client/http.js";
import type { ExecutionStreamFrame } from "../client/stream.js";
import { isRecord } from "../guards.js";
import type {
  ExecutionDecodeWarning,
  ExecutionHostEventEnvelope,
} from "../types.js";
import { fromPortError } from "./errors.js";
import {
  listen,
  PORT_CHANNEL,
  PORT_OPTIONS_INDEX,
  PORT_VERSION,
  readTagged,
  type ExecutionHostPort,
  type PortMethod,
  type PortRequest,
} from "./port.js";

/**
 * An `ExecutionHostApi` whose host is on the other end of a port, and the
 * means to let go of it.
 */
export interface ExecutionHostPortClient extends ExecutionHostApi {
  /**
   * Stops using the port: calls still waiting reject as `network` failures,
   * follows end `stopped`, and the port closes.
   */
  close(): void;
}

interface PendingCall {
  operation: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface OpenStream {
  frames(frames: unknown[]): void;
  end(error: unknown): void;
}

/**
 * An `ExecutionHostApi` over a `MessagePort` (MAR-4862), served on the other
 * end by `servePort`.
 *
 * A call is one message there and one back. Its result, or its error with its
 * class and fields — an `ExecutionHostError` keeps its `kind` — is what the
 * host's own `api` gave. A caller's `signal` rejects the call at once with the
 * signal's reason, and cancels it on the host. `timeoutMs` travels with the
 * call, for the host's `api` to honour.
 *
 * `followSession` is the HTTP client's follow over streams the host feeds
 * from its own `followSession`, one per connection of the host's: each
 * envelope once and in order, resumed after `afterSeq`, redelivered after a
 * handler throws, ended by `stop()` or the host saying the session is gone.
 * When the host's connection ends, the port stream ends with its error, and
 * this side waits and reconnects by the caller's `retryDelayMs`,
 * `maxAttempts` and `healthyAfterMs`, so the follow ends as a direct one
 * would. `idleTimeoutMs` and `maxFrameLength` travel for the host's own
 * connection.
 *
 * When the port closes from the other side, calls waiting reject, and every
 * follow ends `gave-up` with an `ExecutionHostError` of kind `network`: a
 * closed port does not reopen, and a new one is a new client. A port without
 * a `close` event (a browser's, before it had one) cannot say so.
 */
export function createPortClient(
  port: ExecutionHostPort,
): ExecutionHostPortClient {
  const calls = new Map<number, PendingCall>();
  const streams = new Map<number, OpenStream>();
  /** Each follow's way to end, by how: the caller's `close()` or the port's. */
  const follows = new Set<(by: "caller" | "port") => void>();
  let nextId = 1;
  let closed = false;

  const send = (request: DistributiveOmit<PortRequest, "channel" | "v">) => {
    port.postMessage({ channel: PORT_CHANNEL, v: PORT_VERSION, ...request });
  };

  const closedError = (operation: string) =>
    new ExecutionHostError("network", "the port is closed", { operation });

  const call = <T>(
    method: PortMethod,
    operation: string,
    args: unknown[],
  ): Promise<T> => {
    const index = PORT_OPTIONS_INDEX[method];
    const options = args[index] as { signal?: AbortSignal } | undefined;
    const { signal, ...rest } = options ?? {};
    const sent = [...args.slice(0, index), rest];
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (closed) return Promise.reject(closedError(operation));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!calls.delete(id)) return;
        reject(signal!.reason);
        if (!closed) send({ type: "cancel", id });
      };
      const done = () => signal?.removeEventListener("abort", onAbort);
      calls.set(id, {
        operation,
        resolve: (value) => {
          done();
          resolve(value as T);
        },
        reject: (error) => {
          done();
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        send({ type: "call", id, method, args: sent });
      } catch (error) {
        // An argument that does not clone never left.
        calls.delete(id);
        done();
        reject(error);
      }
    });
  };

  /**
   * One stream of the session's frames after `afterSeq`, as the HTTP client's
   * `events()` is one connection: it ends when the host ends it, throws what
   * the host ended it with, and just stops when `signal` aborts. Each chunk is
   * acknowledged once read, which lets the host send another.
   */
  async function* stream(
    sessionId: string,
    afterSeq: number,
    open: Parameters<OpenEventStream>[1],
  ): AsyncGenerator<ExecutionStreamFrame> {
    const { deltas, signal, idleTimeoutMs, maxFrameLength } = open;
    if (closed) throw closedError("events");
    if (signal.aborted) return;
    const id = nextId++;
    const chunks: unknown[][] = [];
    let ended: { error: unknown } | null = null;
    let wake: (() => void) | null = null;
    const nudge = () => {
      wake?.();
      wake = null;
    };
    streams.set(id, {
      frames: (frames) => {
        chunks.push(frames);
        nudge();
      },
      end: (error) => {
        ended = { error };
        nudge();
      },
    });
    signal.addEventListener("abort", nudge);
    try {
      send({
        type: "follow",
        id,
        sessionId,
        afterSeq,
        deltas,
        idleTimeoutMs,
        ...(maxFrameLength === undefined ? {} : { maxFrameLength }),
      });
      for (;;) {
        if (signal.aborted) return;
        const chunk = chunks.shift();
        if (chunk !== undefined) {
          for (const frame of chunk as unknown[]) {
            yield placed(frame, sessionId);
            if (signal.aborted) return;
          }
          if (!closed) send({ type: "ack", id });
          continue;
        }
        if (ended !== null) {
          const { error } = ended as { error: unknown };
          if (error !== null) throw error;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      signal.removeEventListener("abort", nudge);
      // A stream the host did not end is the client's to end.
      if (streams.delete(id) && !closed) send({ type: "cancel", id });
    }
  }

  const shutDown = (by: "caller" | "port") => {
    if (closed) return;
    closed = true;
    detach();
    for (const end of [...follows]) end(by);
    for (const [id, pending] of [...calls]) {
      calls.delete(id);
      pending.reject(closedError(pending.operation));
    }
    for (const [id, open] of [...streams]) {
      streams.delete(id);
      open.end(closedError("events"));
    }
  };

  const detach = listen(
    port,
    (data) => {
      const message = readTagged(data);
      if (message === null) return;
      const id = message.id as number;
      switch (message.type) {
        case "result": {
          const pending = calls.get(id);
          if (!pending) return;
          calls.delete(id);
          pending.resolve(message.value);
          return;
        }
        case "error": {
          const pending = calls.get(id);
          if (!pending) return;
          calls.delete(id);
          pending.reject(fromPortError(message.error, pending.operation));
          return;
        }
        case "frames": {
          if (Array.isArray(message.frames)) {
            streams.get(id)?.frames(message.frames);
          }
          return;
        }
        case "end": {
          const open = streams.get(id);
          if (!open) return;
          streams.delete(id);
          open.end(
            message.error === null || message.error === undefined
              ? null
              : fromPortError(message.error, "events"),
          );
          return;
        }
      }
    },
    () => shutDown("port"),
  );

  const followSession: ExecutionHostApi["followSession"] = (
    sessionId,
    options,
  ) => {
    const own = new AbortController();
    let endedBy: "caller" | "port" | null = null;
    const end = (by: "caller" | "port") => {
      endedBy ??= by;
      own.abort();
    };
    const inner = followExecutionSession(
      (afterSeq, open) => stream(sessionId, afterSeq, open),
      sessionId,
      { ...options, signal: own.signal },
    );
    const callerSignal = options.signal;
    const onCallerAbort = () => end("caller");
    if (callerSignal?.aborted) end("caller");
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (closed) end("port");
    else follows.add(end);
    const done = inner.done.then((ended): ExecutionFollowEnd => {
      follows.delete(end);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      return ended.reason === "stopped" && endedBy === "port"
        ? {
            reason: "gave-up",
            lastSeq: ended.lastSeq,
            error: closedError("events"),
          }
        : ended;
    });
    const follow: ExecutionSessionFollow = {
      sessionId,
      get lastSeq() {
        return inner.lastSeq;
      },
      done,
      stop: () => {
        end("caller");
        return done;
      },
    };
    return follow;
  };

  return {
    providers: (options) => call("providers", "providers", [options]),
    projects: (options) => call("projects", "projects", [options]),
    start: (request, options) => call("start", "start", [request, options]),
    command: (sessionId, command, options) =>
      call("command", `command ${String(command?.kind)}`, [
        sessionId,
        command,
        options,
      ]),
    listSessions: (query, options) =>
      call("listSessions", "list sessions", [query, options]),
    snapshot: (sessionId, options) =>
      call("snapshot", "snapshot", [sessionId, options]),
    patchSession: (sessionId, patch, options) =>
      call("patchSession", "patch session", [sessionId, patch, options]),
    taskOutput: (sessionId, taskId, options) =>
      call("taskOutput", "task output", [sessionId, taskId, options]),
    sessionChanges: (sessionId, options) =>
      call("sessionChanges", "session changes", [sessionId, options]),
    downloadAttachment: (sessionId, attachmentId, options) =>
      call("downloadAttachment", "download attachment", [
        sessionId,
        attachmentId,
        options,
      ]),
    followSession,
    close: () => {
      shutDown("caller");
      port.close?.();
    },
  };
}

/**
 * A frame as the follow may take it. The host built it from what its own
 * follow handed on, but the port is a boundary all the same: an envelope
 * about another session, or with no place, is unreadable and unplaced, as
 * the HTTP stream makes one, rather than filed under this session.
 */
function placed(frame: unknown, sessionId: string): ExecutionStreamFrame {
  if (!isRecord(frame) || typeof frame.type !== "string") {
    return {
      type: "unreadable",
      reason: "invalid-payload",
      id: null,
      replay: false,
    };
  }
  if (frame.type !== "envelope") return frame as ExecutionStreamFrame;
  const envelope = frame.envelope;
  if (
    !isRecord(envelope) ||
    envelope.sessionId !== sessionId ||
    !Number.isSafeInteger(envelope.seq) ||
    (envelope.seq as number) < 1 ||
    !isRecord(envelope.event)
  ) {
    return {
      type: "unreadable",
      reason: "invalid-envelope",
      id: null,
      replay: frame.replay === true,
    };
  }
  return {
    type: "envelope",
    envelope: envelope as unknown as ExecutionHostEventEnvelope,
    replay: frame.replay === true,
    warnings: Array.isArray(frame.warnings)
      ? (frame.warnings as ExecutionDecodeWarning[])
      : [],
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
