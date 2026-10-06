import { beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionInlineAttachmentsError,
  ExecutionStartRequirementsError,
  hostTakesInlineFiles,
} from "../../src/client/index.js";
import type {
  ExecutionHostCommand,
  ExecutionInlineAttachment,
  ExecutionStartRequest,
} from "../../src/index.js";
import {
  inlineAttachment,
  MiB,
} from "../fixtures/inline-attachment-fixtures.js";
import { createStubHost, HEALTH_BODY, type StubHost } from "./stub-host.js";

let host: StubHost;
beforeEach(() => {
  host = createStubHost();
});
const client = (fetch: typeof globalThis.fetch = host.fetch) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch,
  });

/** Every request the client made, as `METHOD /path`. */
function counted(stub: StubHost) {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    requests.push(
      `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
    );
    return stub.fetch(input, init);
  };
  return { requests, fetch };
}

/** A host that says it takes files, and does. */
function takingFiles(stub: StubHost, capabilities: string[] = []) {
  stub.healthBody = {
    ...HEALTH_BODY,
    executionProtocol: {
      version: 1,
      capabilities: [
        ...HEALTH_BODY.executionProtocol.capabilities,
        "attachments.inline-file.v1",
        ...capabilities,
      ],
    },
  };
  stub.takesFiles = true;
}

const image: ExecutionInlineAttachment = {
  kind: "image",
  name: "diagram.png",
  mimeType: "image/png",
  sizeBytes: 3,
  dataBase64: "AQID",
};
/** Bytes, base64 and a name no error may carry. */
const SECRET_NAME = "payroll-2026-Q3-salaries.xlsx";
const SECRET_BASE64 = Buffer.from("account 4242 4242 4242 4242").toString(
  "base64",
);
const file: ExecutionInlineAttachment = {
  kind: "file",
  name: SECRET_NAME,
  mimeType: "application/vnd.ms-excel",
  sizeBytes: Buffer.from(SECRET_BASE64, "base64").byteLength,
  dataBase64: SECRET_BASE64,
};
const sendMessage = (
  inlineAttachments?: ExecutionInlineAttachment[],
): ExecutionHostCommand => ({
  kind: "send-message",
  text: "Read these",
  ...(inlineAttachments ? { inlineAttachments } : {}),
});
const start = (
  inlineAttachments?: ExecutionInlineAttachment[],
  requires?: string[],
): ExecutionStartRequest => ({
  protocolVersion: 1,
  providerId: "claude",
  commandId: "start-1",
  ...(requires ? { requires } : {}),
  config: {
    sessionId: "session-new",
    initialMessage: "Read these",
    model: null,
    effort: null,
    continuationToken: null,
    ...(inlineAttachments ? { inlineAttachments } : {}),
  },
});

/** Everything an error shows: message, reason, stack, JSON, causes. */
function everythingSaid(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? "");
      parts.push(JSON.stringify(current, Object.getOwnPropertyNames(current)));
      current = current.cause;
    } else {
      parts.push(String(current));
      current = undefined;
    }
  }
  return parts.join("\n");
}
function expectNothingOfTheFile(error: unknown) {
  const said = everythingSaid(error);
  expect(said).not.toContain(SECRET_NAME);
  expect(said).not.toContain(SECRET_BASE64);
  expect(said).not.toContain(SECRET_BASE64.slice(0, 12));
  expect(said).not.toContain("4242");
  expect(said).not.toContain(host.token);
}

describe("a file beside an image (MAR-3783)", () => {
  it("arrives with the image as one command on a host that takes files", async () => {
    takingFiles(host);
    const { requests, fetch } = counted(host);
    const result = await client(fetch).command(
      "session-1",
      sendMessage([image, file]),
      { commandId: "c-1" },
    );
    expect(result).toEqual({ status: "accepted", commandId: "c-1" });
    expect(requests).toEqual([
      "GET /health",
      "POST /v0/execution/sessions/session-1/commands",
    ]);
    expect(host.commandRequests).toHaveLength(1);
    expect(host.commandRequests[0]!.body.command).toEqual(
      sendMessage([image, file]),
    );
    expect(host.files.get("session-1")).toEqual([file]);
  });

  it("is refused before any request but /health on a host without the id", async () => {
    host.takesFiles = true; // what the route would do is beside the point
    const { requests, fetch } = counted(host);
    const refusal = await client(fetch)
      .command("session-1", sendMessage([image, file]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionInlineAttachmentsError);
    expect(refusal).toMatchObject({
      code: "files-unsupported",
      operation: "command send-message",
      index: null,
    });
    expect((refusal as Error).message).toContain("attachments.inline-file.v1");
    expect((refusal as Error).message).toContain("nothing was sent");
    expect(requests).toEqual(["GET /health"]);
    expect(host.commandRequests).toEqual([]);
    expectNothingOfTheFile(refusal);
  });

  it.each([
    ["a near miss", ["attachments.inline-file.v2", "attachments.inline-file"]],
    ["images only", ["attachments.inline-image"]],
  ])("is refused on a host advertising %s", async (_label, capabilities) => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: { version: 1, capabilities },
    };
    await expect(
      client().command("session-1", sendMessage([file])),
    ).rejects.toMatchObject({ code: "files-unsupported" });
    expect(host.commandRequests).toEqual([]);
  });

  it("is refused on a host whose descriptor is unreadable", async () => {
    host.healthBody = {
      ...HEALTH_BODY,
      executionProtocol: {
        version: 99,
        capabilities: ["attachments.inline-file.v1"],
      },
    };
    const refusal = (await client()
      .command("session-1", sendMessage([file]))
      .catch((error: unknown) => error)) as ExecutionInlineAttachmentsError;
    expect(refusal.code).toBe("files-unsupported");
    expect(refusal.reason).toContain("descriptor is unreadable");
    expect(host.commandRequests).toEqual([]);
  });

  it("sends nothing when the probe fails, and says so as the probe", async () => {
    host.healthStatus = 503;
    await expect(
      client().command("session-1", sendMessage([file])),
    ).rejects.toMatchObject({ kind: "http", operation: "health" });
    expect(host.commandRequests).toEqual([]);
  });

  it("starts a session with a file, on one probe shared with requires", async () => {
    takingFiles(host, ["start.requires.v1"]);
    const { requests, fetch } = counted(host);
    expect(
      await client(fetch).start(start([image, file], ["ios.simulator"])),
    ).toMatchObject({ status: "started", sessionId: "session-new" });
    expect(requests).toEqual(["GET /health", "POST /v0/execution/sessions"]);
    expect(host.startRequests[0]!.config).toMatchObject({
      inlineAttachments: [image, file],
    });
    expect(host.files.get("session-new")).toEqual([file]);
  });

  it("refuses a start carrying a file, unsent, on a host without the id", async () => {
    const { requests, fetch } = counted(host);
    await expect(client(fetch).start(start([file]))).rejects.toMatchObject({
      code: "files-unsupported",
      operation: "start",
    });
    expect(requests).toEqual(["GET /health"]);
  });

  it("forgets a session's files when the session is torn down", async () => {
    takingFiles(host);
    const connection = client();
    await connection.command("session-1", sendMessage([file]));
    expect(host.files.has("session-1")).toBe(true);
    await connection.deleteSession("session-1");
    expect(host.files.has("session-1")).toBe(false);
  });

  it("tells hostTakesInlineFiles apart from images", () => {
    expect(
      hostTakesInlineFiles({ capabilities: ["attachments.inline-image"] }),
    ).toBe(false);
    expect(
      hostTakesInlineFiles({ capabilities: ["attachments.inline-file.v1"] }),
    ).toBe(true);
  });
});

/**
 * What the published 0.20.0 client put on the wire for these calls, recorded
 * from `@mrck-labs/execution-host-protocol@0.20.0`'s `/client` with a fetch
 * that kept each body.
 */
const PUBLISHED_0_20_0_BODIES = [
  '{"protocolVersion":1,"sessionId":"s1","commandId":"c1","actor":{"kind":"person","id":"u1","displayName":"Piotr"},"command":{"kind":"send-message","text":"hi"}}',
  '{"protocolVersion":1,"sessionId":"s1","commandId":"c2","command":{"kind":"send-message","text":"hi","inlineAttachments":[{"kind":"image","name":"diagram.png","mimeType":"image/png","sizeBytes":3,"dataBase64":"AQID"},{"kind":"image","name":"b.png","mimeType":"image/png","sizeBytes":3,"dataBase64":"AQID"}]}}',
  '{"protocolVersion":1,"sessionId":"s1","commandId":"c3","command":{"kind":"stop"}}',
  '{"protocolVersion":1,"providerId":"claude","commandId":"c4","config":{"sessionId":"s-new","initialMessage":"go","model":null,"effort":null,"continuationToken":null,"inlineAttachments":[{"kind":"image","name":"diagram.png","mimeType":"image/png","sizeBytes":3,"dataBase64":"AQID"}]}}',
  '{"protocolVersion":1,"providerId":"claude","commandId":"c5","config":{"sessionId":"s-new","initialMessage":"go","model":null,"effort":null,"continuationToken":null}}',
];

describe("calls without a file are as they were", () => {
  it("puts the bytes 0.20.0 put on the wire, one request each, no probe", async () => {
    const sent: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      sent.push(`${init?.method} ${new URL(String(input)).pathname}`);
      sent.push(String(init?.body));
      return new URL(String(input)).pathname === "/v0/execution/sessions"
        ? new Response(JSON.stringify({ sessionId: "s-new" }), { status: 201 })
        : new Response(JSON.stringify({ accepted: true }), { status: 202 });
    };
    const connection = client(fetch);
    await connection.command(
      "s1",
      { kind: "send-message", text: "hi" },
      {
        commandId: "c1",
        actor: { kind: "person", id: "u1", displayName: "Piotr" },
      },
    );
    await connection.command(
      "s1",
      {
        kind: "send-message",
        text: "hi",
        inlineAttachments: [image, { ...image, name: "b.png" }],
      },
      { commandId: "c2" },
    );
    await connection.command("s1", { kind: "stop" }, { commandId: "c3" });
    const config = {
      sessionId: "s-new",
      initialMessage: "go",
      model: null,
      effort: null,
      continuationToken: null,
    };
    await connection.start({
      protocolVersion: 1,
      providerId: "claude",
      commandId: "c4",
      config: { ...config, inlineAttachments: [image] },
    });
    await connection.start({
      protocolVersion: 1,
      providerId: "claude",
      commandId: "c5",
      config,
    });
    expect(sent).toEqual([
      "POST /v0/execution/sessions/s1/commands",
      PUBLISHED_0_20_0_BODIES[0],
      "POST /v0/execution/sessions/s1/commands",
      PUBLISHED_0_20_0_BODIES[1],
      "POST /v0/execution/sessions/s1/commands",
      PUBLISHED_0_20_0_BODIES[2],
      "POST /v0/execution/sessions",
      PUBLISHED_0_20_0_BODIES[3],
      "POST /v0/execution/sessions",
      PUBLISHED_0_20_0_BODIES[4],
    ]);
  });

  it("keeps the host's words in a refusal of a command without a file", async () => {
    host.commandStatus = 409;
    await expect(
      client().command("session-1", sendMessage([image])),
    ).rejects.toMatchObject({ reason: "Session has stopped" });
  });
});

describe("the limits, refused before anything is sent", () => {
  const sendsOrRefuses = async (
    attachments: ExecutionInlineAttachment[],
    expected: { code: string; index: number | null } | null,
  ) => {
    takingFiles(host);
    const { requests, fetch } = counted(host);
    const outcome = await client(fetch)
      .command("session-1", sendMessage(attachments))
      .catch((error: unknown) => error);
    if (expected === null) {
      expect(outcome).toMatchObject({ status: "accepted" });
      expect(host.commandRequests).toHaveLength(1);
      return;
    }
    expect(outcome).toBeInstanceOf(ExecutionInlineAttachmentsError);
    expect(outcome).toMatchObject({
      ...expected,
      operation: "command send-message",
    });
    expect((outcome as Error).message).toContain("nothing was sent");
    expect(requests).toEqual([]);
  };

  it.each([
    [3, null],
    [4, null],
    [5, { code: "too-many", index: null }],
  ])("%i attachments", async (count, expected) => {
    await sendsOrRefuses(
      Array.from({ length: count }, (_, index) =>
        inlineAttachment(index === 0 ? "file" : "image", 3),
      ),
      expected,
    );
  });

  it.each([
    [10 * MiB - 1, null],
    [10 * MiB, null],
    [10 * MiB + 1, { code: "too-large", index: 1 }],
  ])("a file of %i bytes", async (sizeBytes, expected) => {
    await sendsOrRefuses(
      [inlineAttachment("image", 3), inlineAttachment("file", sizeBytes)],
      expected,
    );
  });

  it.each([
    [20 * MiB - 1, null],
    [20 * MiB, null],
    [20 * MiB + 1, { code: "total-too-large", index: 2 }],
  ])("%i bytes together", async (total, expected) => {
    await sendsOrRefuses(
      [
        inlineAttachment("file", 10 * MiB),
        inlineAttachment("image", 10 * MiB - 1),
        inlineAttachment("file", total - (20 * MiB - 1)),
      ].filter((entry) => entry.sizeBytes > 0),
      expected,
    );
  });

  it("a sizeBytes that is not the decoded length", async () => {
    await sendsOrRefuses([image, { ...file, sizeBytes: file.sizeBytes + 1 }], {
      code: "size-mismatch",
      index: 1,
    });
  });

  it("a kind the protocol does not know", async () => {
    await sendsOrRefuses(
      [{ ...file, kind: "pdf" } as unknown as ExecutionInlineAttachment],
      { code: "invalid", index: 0 },
    );
  });

  it("images alone, past the limits, as a host would refuse them", async () => {
    await sendsOrRefuses(
      Array.from({ length: 5 }, () => image),
      { code: "too-many", index: null },
    );
    expect(host.healthRequests).toEqual([]);
  });

  it("a start past them", async () => {
    const { requests, fetch } = counted(host);
    await expect(
      client(fetch).start(start([inlineAttachment("file", 10 * MiB + 1)])),
    ).rejects.toMatchObject({
      code: "too-large",
      operation: "start",
      index: 0,
    });
    expect(requests).toEqual([]);
  });

  it("names the entry by index, never by name or bytes", async () => {
    const refusal = await client()
      .command(
        "session-1",
        sendMessage([{ ...file, sizeBytes: file.sizeBytes - 1 }]),
      )
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "size-mismatch", index: 0 });
    expectNothingOfTheFile(refusal);
  });
});

describe("no error carries a file's name or bytes", () => {
  it("withholds a host's refusal that quotes them", async () => {
    takingFiles(host);
    host.refusesAttachments = true;
    const refusal = await client()
      .command("session-1", sendMessage([file]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionHostError);
    expect(refusal).toMatchObject({
      kind: "http",
      status: 400,
      operation: "command send-message",
    });
    expect((refusal as Error).cause).toBeUndefined();
    expectNothingOfTheFile(refusal);
  });

  it("withholds a start's refusal that quotes them", async () => {
    takingFiles(host);
    host.refusesAttachments = true;
    const refusal = await client()
      .start(start([file]))
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ kind: "http", status: 400 });
    expectNothingOfTheFile(refusal);
  });

  it("withholds the refusal of a host that dropped the id after the probe", async () => {
    takingFiles(host);
    host.takesFiles = false; // rolled back between the probe and the send
    const refusal = await client()
      .command("session-1", sendMessage([image, file]))
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ kind: "http", status: 400 });
    expectNothingOfTheFile(refusal);
  });

  it("withholds an unmet start's reason when the host quotes the file", async () => {
    takingFiles(host, ["start.requires.v1"]);
    host.startStatus = 400;
    host.startRefusal = {
      error: `Missing ios.simulator for ${SECRET_NAME}`,
      code: "requirements-unmet",
      missingTraits: ["ios.simulator"],
    };
    const refusal = await client()
      .start(start([file], ["ios.simulator"]))
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ExecutionStartRequirementsError);
    expect(refusal).toMatchObject({
      code: "requirements-unmet",
      missingTraits: ["ios.simulator"],
    });
    expectNothingOfTheFile(refusal);
  });

  it("says a broken connection in its own words, whatever fetch quoted", async () => {
    takingFiles(host);
    const quoting: typeof globalThis.fetch = (input, init) => {
      if (String(input).endsWith("/health")) return host.fetch(input, init);
      const body = String(init?.body);
      return Promise.reject(
        new TypeError(`fetch failed sending ${body}`, {
          cause: new Error(`socket hang up after ${body}`),
        }),
      );
    };
    const refusal = await client(quoting)
      .command("session-1", sendMessage([file]))
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      kind: "network",
      reason: "the connection to the host failed",
    });
    expect((refusal as Error).cause).toBeUndefined();
    expectNothingOfTheFile(refusal);
  });

  it("hands a caller's own abort back as it came", async () => {
    takingFiles(host);
    const controller = new AbortController();
    const reason = new Error("the person closed the composer");
    const aborting: typeof globalThis.fetch = (input, init) => {
      if (String(input).endsWith("/health")) return host.fetch(input, init);
      controller.abort(reason);
      return Promise.reject(reason);
    };
    await expect(
      client(aborting).command("session-1", sendMessage([file]), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});
