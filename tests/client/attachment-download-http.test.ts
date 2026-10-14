import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionHostClient } from "../../src/client/index.js";
import {
  EXECUTION_INLINE_ATTACHMENT_MAX_BYTES,
  EXECUTION_TOOL_ATTACHMENT_MAX_BYTES,
} from "../../src/index.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe("attachment downloads over HTTP", () => {
  it("counts chunked bytes and refuses redirects without contacting their target", async () => {
    const requests: string[] = [];
    server = createServer((request, response) => {
      requests.push(request.url!);
      expect(request.headers.authorization).toBe("Bearer test-token");
      if (request.url!.endsWith("/redirect")) {
        response.writeHead(302, { Location: "/redirect-target" });
        response.end("private response diagnostics");
      } else {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.write(new Uint8Array([1, 2]));
        response.end(new Uint8Array([3, 4, 5]));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const client = createExecutionHostClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
    });
    expect(
      await client.downloadAttachment("session/a", "image?b", { maxBytes: 5 }),
    ).toEqual({ bytes: new Uint8Array([1, 2, 3, 4, 5]), sizeBytes: 5 });
    await expect(
      client.downloadAttachment("session/a", "image?b", { maxBytes: 4 }),
    ).rejects.toMatchObject({ kind: "malformed" });
    await expect(
      client.downloadAttachment("s", "redirect"),
    ).rejects.toMatchObject({ kind: "network" });
    expect(requests).toEqual([
      "/v0/execution/sessions/session%2Fa/attachments/image%3Fb",
      "/v0/execution/sessions/session%2Fa/attachments/image%3Fb",
      "/v0/execution/sessions/s/attachments/redirect",
    ]);
  });

  it("aborts a body that sent headers and a chunk then stalled", async () => {
    let started!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.write(new Uint8Array([1]));
      started();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const client = createExecutionHostClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
    });
    const caller = new AbortController();
    const reason = new Error("caller stopped");
    const result = client
      .downloadAttachment("s", "a", { signal: caller.signal })
      .catch((error: unknown) => error);
    await bodyStarted;
    caller.abort(reason);
    expect(await result).toBe(reason);
  });

  it("downloads an inline upload between 8 and 10 MiB, which a tool download refuses (MAR-3973)", async () => {
    // What a host stores: an upload past the tool image ceiling, within its own.
    const size = EXECUTION_TOOL_ATTACHMENT_MAX_BYTES + 1024 * 1024;
    expect(size).toBeLessThan(EXECUTION_INLINE_ATTACHMENT_MAX_BYTES);
    const upload = new Uint8Array(size).fill(42);
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.write(upload.subarray(0, 1024 * 1024));
      response.end(upload.subarray(1024 * 1024));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const client = createExecutionHostClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
    });
    const result = await client.downloadAttachment("s", "upload", {
      kind: "inline",
    });
    expect(result.sizeBytes).toBe(size);
    // Byte-for-byte, without a deep equality walk over millions of entries.
    expect(Buffer.compare(result.bytes, upload)).toBe(0);
    await expect(
      client.downloadAttachment("s", "upload"),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});
