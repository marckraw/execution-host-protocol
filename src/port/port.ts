import type {
  ExecutionDeltaMode,
  ExecutionStreamFrame,
} from "../client/stream.js";
import { isRecord } from "../guards.js";
import type { PortError } from "./errors.js";

/**
 * The least of a message port that `/port` uses (MAR-4862), so one type takes
 * Node's `MessagePort` (`worker_threads`, `MessageChannel`), a browser's, and
 * Electron's `MessagePortMain`. A port with `addEventListener` is listened to
 * that way and hands over `event.data`; one with only `on` (Electron's) hands
 * its listener an event with `data` too. `start()` is called when there is one.
 * A `close` event, where the port has one, is how either side learns the other
 * is gone.
 *
 * Nothing is transferred: messages are plain data, structured-cloned.
 */
export interface ExecutionHostPort {
  postMessage(message: unknown): void;
  start?(): void;
  close?(): void;
  addEventListener?(
    type: "message" | "close",
    listener: (event: any) => void,
  ): void;
  removeEventListener?(
    type: "message" | "close",
    listener: (event: any) => void,
  ): void;
  on?(type: "message" | "close", listener: (event: any) => void): unknown;
  off?(type: "message" | "close", listener: (event: any) => void): unknown;
  removeListener?(
    type: "message" | "close",
    listener: (event: any) => void,
  ): unknown;
}

/**
 * Listens to a port's messages and its closing, starts it, and returns what
 * undoes the listening.
 */
export function listen(
  port: ExecutionHostPort,
  onMessage: (data: unknown) => void,
  onClose: () => void,
): () => void {
  const message = (event: unknown) =>
    onMessage(isRecord(event) ? event.data : undefined);
  const close = () => onClose();
  let detach: () => void;
  if (typeof port.addEventListener === "function") {
    port.addEventListener("message", message);
    port.addEventListener("close", close);
    detach = () => {
      port.removeEventListener?.("message", message);
      port.removeEventListener?.("close", close);
    };
  } else if (typeof port.on === "function") {
    port.on("message", message);
    port.on("close", close);
    detach = () => {
      const off = (port.off ?? port.removeListener)?.bind(port);
      off?.("message", message);
      off?.("close", close);
    };
  } else {
    throw new TypeError(
      "The port has neither addEventListener nor on: pass a MessagePort or Electron's MessagePortMain",
    );
  }
  port.start?.();
  return detach;
}

/**
 * Every message carries this, so a port shared with other traffic is read for
 * these messages alone, and a later shape can be told from this one.
 */
export const PORT_CHANNEL = "execution-host-port";
export const PORT_VERSION = 1;

/** The operations a port serves: an `ExecutionHostApi`'s, but the follow. */
export const PORT_METHODS = [
  "providers",
  "projects",
  "start",
  "command",
  "listSessions",
  "snapshot",
  "patchSession",
  "taskOutput",
  "sessionChanges",
  "downloadAttachment",
] as const;

export type PortMethod = (typeof PORT_METHODS)[number];

/** Where each method takes its options, which carry the caller's signal. */
export const PORT_OPTIONS_INDEX: Record<PortMethod, number> = {
  providers: 0,
  projects: 0,
  start: 1,
  command: 2,
  listSessions: 1,
  snapshot: 1,
  patchSession: 2,
  taskOutput: 2,
  sessionChanges: 1,
  downloadAttachment: 2,
};

interface Tagged {
  channel: typeof PORT_CHANNEL;
  v: typeof PORT_VERSION;
}

/**
 * Client to host. `call` asks for one operation; `follow` opens one event
 * stream of a session after `afterSeq`; `cancel` ends either; `ack` says one
 * chunk of a stream was read, so the host may send another.
 */
export type PortRequest = Tagged &
  (
    | { type: "call"; id: number; method: PortMethod; args: unknown[] }
    | {
        type: "follow";
        id: number;
        sessionId: string;
        afterSeq: number;
        deltas: ExecutionDeltaMode;
        /** The caller's, for the host's own connection. */
        idleTimeoutMs: number | null;
        maxFrameLength?: number;
      }
    | { type: "cancel"; id: number }
    | { type: "ack"; id: number }
  );

/**
 * Host to client. `result` and `error` answer a call; `frames` is one chunk
 * of a stream, in order; `end` closes a stream, with the error that ended it
 * or null when it simply ended.
 */
export type PortAnswer = Tagged &
  (
    | { type: "result"; id: number; value: unknown }
    | { type: "error"; id: number; error: PortError }
    | { type: "frames"; id: number; frames: ExecutionStreamFrame[] }
    | { type: "end"; id: number; error: PortError | null }
  );

/** A message of this channel and version, or null for anything else. */
export function readTagged(data: unknown): Record<string, unknown> | null {
  return isRecord(data) &&
    data.channel === PORT_CHANNEL &&
    data.v === PORT_VERSION &&
    typeof data.type === "string" &&
    Number.isSafeInteger(data.id)
    ? data
    : null;
}
