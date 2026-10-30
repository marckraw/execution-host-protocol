import { EventEmitter } from "node:events";
import type { MessagePort } from "node:worker_threads";

/**
 * Electron's `MessagePortMain` as its typings have it: an `EventEmitter` with
 * no `addEventListener`, whose `message` listener is handed `{ data, ports }`.
 */
export class MessagePortMainLike extends EventEmitter {
  constructor(private readonly inner: MessagePort) {
    super();
    inner.on("message", (data: unknown) =>
      this.emit("message", { data, ports: [] }),
    );
    inner.on("close", () => this.emit("close"));
  }
  postMessage(message: unknown): void {
    this.inner.postMessage(message);
  }
  start(): void {
    this.inner.start();
  }
  close(): void {
    this.inner.close();
  }
}
