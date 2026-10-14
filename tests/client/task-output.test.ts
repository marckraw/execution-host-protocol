import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionHostClient,
  ExecutionHostError,
  ExecutionTaskOutputError,
  hostReadsTaskOutput,
  type ExecutionTaskOutputErrorCode,
} from "../../src/client/index.js";
import {
  decodeExecutionTaskOutputRequest,
  encodeExecutionTaskOutputResponse,
  EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH,
} from "../../src/index.js";
import {
  createStubHost,
  HEALTH_BODY,
  STUB_READ_AT,
  STUB_SECRET,
  type StubHost,
} from "./stub-host.js";

const encoder = new TextEncoder();

/** 70 KiB of a `pnpm check`, a secret near the end. */
const LONG_OUTPUT = encoder.encode(
  `${"lint ok\n".repeat(8_960)}token ${STUB_SECRET} leaked\n✓ 212 tests passed\n`,
);

/** A small file, a secret on its first line. */
const SECRET_OUTPUT = `token ${STUB_SECRET} leaked\nend\n`;

let host: StubHost;
/** Every request the client made, in order. */
let requests: Array<{ method: string; target: string }>;
beforeEach(() => {
  host = createStubHost();
  host.tasks.set(
    "session-1",
    new Map([
      ["b7x2k9q1", { status: "running", output: LONG_OUTPUT }],
      ["t1", { status: "running", output: encoder.encode(SECRET_OUTPUT) }],
      [
        "flushing",
        {
          status: "running",
          output: encoder.encode(`ok\ntoken ${STUB_SECRET.slice(0, 10)}`),
        },
      ],
      ["short", { status: "completed", output: encoder.encode("done ✓\n") }],
      ["subagent", { status: "completed", output: null }],
      [
        "elsewhere",
        { status: "failed", output: encoder.encode("x"), outsidePolicy: true },
      ],
    ]),
  );
  requests = [];
});

const counting =
  (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    requests.push({
      method: init?.method ?? "GET",
      target: `${url.pathname}${url.search}`,
    });
    return fetch(input, init);
  };

const client = (fetch: typeof globalThis.fetch = host.fetch) =>
  createExecutionHostClient({
    baseUrl: "https://host.test/",
    token: host.token,
    fetch: counting(fetch),
  });

/** A fetch that answers the task-output route with `answer`, and the stub elsewhere. */
const answering =
  (answer: () => Response): typeof globalThis.fetch =>
  (input, init) =>
    String(input).includes("/tasks/")
      ? Promise.resolve(answer())
      : host.fetch(input, init);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** The error a call threw, for a test to read. */
async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("taskOutput", () => {
  it("reads the last 64 KiB of a task's output, with its status, in one request", async () => {
    const output = await client().taskOutput("session-1", "b7x2k9q1");

    expect(requests).toEqual([
      {
        method: "GET",
        target:
          "/v0/execution/sessions/session-1/tasks/b7x2k9q1/output?tail=65536",
      },
    ]);
    expect(host.taskOutputRequests).toEqual([
      {
        target:
          "/v0/execution/sessions/session-1/tasks/b7x2k9q1/output?tail=65536",
        authorization: `Bearer ${host.token}`,
      },
    ]);
    expect(host.redirectModes).toEqual(["error"]);
    expect(host.healthRequests).toEqual([]);
    expect(output).toMatchObject({
      sessionId: "session-1",
      taskId: "b7x2k9q1",
      status: "running",
      // The first line start within the tail: "lint ok\n" lines are 8 bytes.
      startOffset: Math.ceil((LONG_OUTPUT.byteLength - 65_536) / 8) * 8,
      endOffset: LONG_OUTPUT.byteLength,
      totalBytes: LONG_OUTPUT.byteLength,
      truncated: true,
      readAt: STUB_READ_AT,
    });
    expect(output.text.startsWith("lint ok\n")).toBe(true);
    expect(output.text.endsWith("✓ 212 tests passed\n")).toBe(true);
  });

  it("shows the host's redaction, not the file's bytes", async () => {
    const output = await client().taskOutput("session-1", "b7x2k9q1");

    expect(output.text).toContain("token [redacted] leaked");
    expect(output.text).not.toContain(STUB_SECRET);
  });

  it("never shows a fragment of a secret, whatever tail it asks for", async () => {
    const texts = new Set<string>();
    for (let tail = 1; tail <= SECRET_OUTPUT.length + 1; tail++) {
      texts.add((await client().taskOutput("session-1", "t1", { tail })).text);
    }

    // Byte by byte into the secret, the client sees whole lines or nothing.
    expect([...texts].sort()).toEqual([
      "",
      "end\n",
      "token [redacted] leaked\nend\n",
    ]);
    expect(await client().taskOutput("session-1", "t1", { tail: 28 })).toEqual({
      sessionId: "session-1",
      taskId: "t1",
      status: "running",
      text: "end\n",
      startOffset: 31,
      endOffset: 35,
      totalBytes: 35,
      truncated: true,
      readAt: STUB_READ_AT,
    });
  });

  it("holds back a running command's half-flushed last line", async () => {
    const output = await client().taskOutput("session-1", "flushing");

    expect(output).toMatchObject({
      text: "ok\n",
      startOffset: 0,
      endOffset: 3,
      totalBytes: 19,
      truncated: false,
    });
    expect(output.text).not.toContain("sk-live");
  });

  it("shows an ended task's last line, finished or not", async () => {
    host.tasks.get("session-1")!.set("ended", {
      status: "completed",
      output: encoder.encode("ok\nno line break"),
    });

    expect(await client().taskOutput("session-1", "ended")).toMatchObject({
      text: "ok\nno line break",
      endOffset: 16,
      totalBytes: 16,
    });
  });

  it("reads a whole short file as not truncated", async () => {
    expect(await client().taskOutput("session-1", "short")).toEqual({
      sessionId: "session-1",
      taskId: "short",
      status: "completed",
      text: "done ✓\n",
      startOffset: 0,
      endOffset: 9,
      totalBytes: 9,
      truncated: false,
      readAt: STUB_READ_AT,
    });
  });

  it("asks for the tail it is given, and gets the line it cut left out", async () => {
    // The last 3 bytes are "✓"'s final 2 and a newline: the line they end
    // starts before the tail, so no line starts within it.
    const output = await client().taskOutput("session-1", "short", {
      tail: 3,
    });

    expect(requests[0]?.target).toBe(
      "/v0/execution/sessions/session-1/tasks/short/output?tail=3",
    );
    expect(output).toMatchObject({
      text: "",
      startOffset: 9,
      endOffset: 9,
      totalBytes: 9,
      truncated: true,
    });
  });

  it("encodes the session id", async () => {
    host.sessions.add("accent 8f2c?");
    host.tasks.set("accent 8f2c?", host.tasks.get("session-1")!);

    await client().taskOutput("accent 8f2c?", "short");

    expect(requests[0]?.target).toBe(
      "/v0/execution/sessions/accent%208f2c%3F/tasks/short/output?tail=65536",
    );
  });

  it.each<[string, () => Promise<unknown>, ErrorConstructor]>([
    [
      "a task id that is a path",
      () => client().taskOutput("session-1", "../../etc/passwd"),
      TypeError,
    ],
    [
      "a task id holding a slash",
      () => client().taskOutput("session-1", "tasks/b7x2k9q1.output"),
      TypeError,
    ],
    ["an empty task id", () => client().taskOutput("session-1", ""), TypeError],
    [
      "a dot-segment session",
      () => client().taskOutput("..", "b7x2k9q1"),
      TypeError,
    ],
    [
      "a session id holding a path",
      () => client().taskOutput("../../etc", "b7x2k9q1"),
      TypeError,
    ],
    [
      "a session id of fullwidth dots",
      () => client().taskOutput("\uff0e\uff0e", "b7x2k9q1"),
      TypeError,
    ],
    [
      "a session id holding NUL",
      () => client().taskOutput("a\u0000b", "b7x2k9q1"),
      TypeError,
    ],
    [
      "a 100,000-character session id",
      () => client().taskOutput("s".repeat(100_000), "b7x2k9q1"),
      TypeError,
    ],
    [
      "a path option",
      () =>
        client().taskOutput("session-1", "b7x2k9q1", {
          path: "/etc/passwd",
        } as never),
      TypeError,
    ],
    [
      "a file option",
      () =>
        client().taskOutput("session-1", "b7x2k9q1", {
          file: "x.output",
        } as never),
      TypeError,
    ],
    [
      "a tail past the cap",
      () => client().taskOutput("session-1", "b7x2k9q1", { tail: 65_537 }),
      RangeError,
    ],
    [
      "a tail of nothing",
      () => client().taskOutput("session-1", "b7x2k9q1", { tail: 0 }),
      RangeError,
    ],
    [
      "an unbounded tail",
      () => client().taskOutput("session-1", "b7x2k9q1", { tail: Infinity }),
      RangeError,
    ],
  ])("refuses %s before sending anything", async (_name, call, type) => {
    expect(await failureOf(call())).toBeInstanceOf(type);
    expect(requests).toEqual([]);
  });

  it.each<[string, string, string, ExecutionTaskOutputErrorCode, number]>([
    [
      "a session it does not have",
      "session-2",
      "b7x2k9q1",
      "session-unknown",
      404,
    ],
    [
      "a task its record does not know",
      "session-1",
      "a1b2c3",
      "task-unknown",
      404,
    ],
    ["a task with no output file", "session-1", "subagent", "no-output", 404],
    [
      "a path outside its policy",
      "session-1",
      "elsewhere",
      "read-refused",
      403,
    ],
  ])(
    "throws the host's refusal of %s by its code",
    async (_name, sessionId, taskId, code, status) => {
      const error = await failureOf(client().taskOutput(sessionId, taskId));

      expect(error).toBeInstanceOf(ExecutionTaskOutputError);
      expect(error).toMatchObject({
        code,
        status,
        operation: "task output",
      });
      // The client's words: neither the path the host named nor the token.
      const said = JSON.stringify(error) + String(error);
      expect(said).not.toContain("/Users/piotr");
      expect(said).not.toContain(host.token);
    },
  );

  it("throws a host's 400 coded rejected as rejected", async () => {
    const error = await failureOf(
      client(
        answering(() =>
          json({ error: "tail out of bounds", code: "rejected" }, 400),
        ),
      ).taskOutput("session-1", "b7x2k9q1"),
    );

    expect(error).toMatchObject({ code: "rejected", status: 400 });
  });

  it("reads a host without the route as unsupported", async () => {
    host.servesTaskOutput = false;

    const error = await failureOf(client().taskOutput("session-1", "b7x2k9q1"));

    expect(error).toBeInstanceOf(ExecutionTaskOutputError);
    expect(error).toMatchObject({
      code: "unsupported",
      status: 404,
      sessionId: "session-1",
      taskId: "b7x2k9q1",
    });
  });

  it.each<[string, Response, ExecutionTaskOutputErrorCode, number]>([
    ["a 401", json({ error: "Unauthorized" }, 401), "rejected", 401],
    [
      "a 403 that is a proxy's, not the policy's",
      json({ error: "Forbidden" }, 403),
      "rejected",
      403,
    ],
    [
      "a code sent with a status the protocol does not give it",
      json({ error: "x", code: "read-refused" }, 500),
      "rejected",
      500,
    ],
    [
      "a 404 coded with a code this build does not know: a newer host's",
      json({ error: "x", code: "task-expired" }, 404),
      "rejected",
      404,
    ],
    [
      "a 404 coded with a code past its status",
      json({ error: "x", code: "read-refused" }, 404),
      "rejected",
      404,
    ],
    [
      "a 404 whose body is not JSON",
      new Response("Not Found", { status: 404 }),
      "unsupported",
      404,
    ],
    [
      "a 502 with no body",
      new Response(null, { status: 502 }),
      "rejected",
      502,
    ],
  ])("reads %s by its status", async (_name, answer, code, status) => {
    expect(
      await failureOf(
        client(answering(() => answer)).taskOutput("session-1", "b7x2k9q1"),
      ),
    ).toMatchObject({ code, status });
  });

  const ANSWER = {
    sessionId: "session-1",
    taskId: "b7x2k9q1",
    status: "running",
    text: "ok\n",
    startOffset: 0,
    endOffset: 3,
    totalBytes: 3,
    truncated: false,
    readAt: STUB_READ_AT,
  };

  it.each<[string, () => Response, number?]>([
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    [
      "an answer missing its window",
      () => json({ ...ANSWER, startOffset: undefined }),
    ],
    [
      "a window past the cap",
      () =>
        json({ ...ANSWER, endOffset: 65_537, totalBytes: 65_537, text: "x" }),
    ],
    [
      "an ended task's line held back",
      () => json({ ...ANSWER, status: "completed", endOffset: 2 }),
    ],
    [
      "text past its cap",
      () =>
        json({
          ...ANSWER,
          text: "x".repeat(EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH + 1),
        }),
    ],
    [
      "an answer about another task",
      () => json({ ...ANSWER, taskId: "a1b2c3" }),
    ],
    [
      "an answer about another session",
      () => json({ ...ANSWER, sessionId: "session-2" }),
    ],
    [
      "a window longer than the tail asked for",
      () =>
        json({
          ...ANSWER,
          text: "x",
          startOffset: 10,
          endOffset: 1_034,
          totalBytes: 1_034,
          truncated: true,
        }),
      1_000,
    ],
    [
      "a body past 512 KiB",
      () =>
        new Response(`{"text":"${"\\u0041".repeat(90_000)}"}`, { status: 200 }),
    ],
    [
      "a valid answer padded past 512 KiB with a field it does not know",
      () => json({ ...ANSWER, padding: "x".repeat(600_000) }),
    ],
  ])("refuses %s as malformed", async (_name, answer, tail) => {
    const error = await failureOf(
      client(answering(answer)).taskOutput(
        "session-1",
        "b7x2k9q1",
        tail === undefined ? {} : { tail },
      ),
    );

    expect(error).toBeInstanceOf(ExecutionTaskOutputError);
    expect(error).toMatchObject({ code: "malformed", status: 200 });
  });

  it("takes a window exactly as long as the tail asked for", async () => {
    const answer = {
      ...ANSWER,
      text: "x",
      startOffset: 10,
      endOffset: 1_010,
      totalBytes: 1_010,
      truncated: true,
    };
    expect(
      await client(
        answering(
          () =>
            new Response(encodeExecutionTaskOutputResponse(answer as never)),
        ),
      ).taskOutput("session-1", "b7x2k9q1", { tail: 1_000 }),
    ).toEqual(answer);
  });

  it("is an ExecutionHostError only when the host cannot be reached", async () => {
    const error = await failureOf(
      client(() => Promise.reject(new TypeError("fetch failed"))).taskOutput(
        "session-1",
        "b7x2k9q1",
      ),
    );

    expect(error).toBeInstanceOf(ExecutionHostError);
    expect(error).toMatchObject({ kind: "network", operation: "task output" });
  });

  it("rethrows the caller's abort as it came", async () => {
    const caller = new AbortController();
    const reason = new Error("panel closed");
    caller.abort(reason);

    expect(
      await failureOf(
        client().taskOutput("session-1", "b7x2k9q1", { signal: caller.signal }),
      ),
    ).toBe(reason);
  });
});

describe("hostReadsTaskOutput", () => {
  it("reads the capability exactly", () => {
    expect(hostReadsTaskOutput({ capabilities: ["tasks.output.v1"] })).toBe(
      true,
    );
    expect(
      hostReadsTaskOutput({
        capabilities: HEALTH_BODY.executionProtocol.capabilities,
      }),
    ).toBe(false);
    expect(hostReadsTaskOutput({ capabilities: ["tasks.output.v2"] })).toBe(
      false,
    );
  });
});

describe("taskOutput over HTTP", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("sends a target the host's own reader takes, and reads the answer", async () => {
    const targets: string[] = [];
    server = createServer((request, response) => {
      targets.push(request.url!);
      expect(request.headers.authorization).toBe("Bearer e2e-token");
      const asked = decodeExecutionTaskOutputRequest(request.url!);
      if (!asked.ok) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "bad", code: "rejected" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      // Written in two chunks, cut mid-character.
      const body = encoder.encode(
        encodeExecutionTaskOutputResponse({
          sessionId: asked.value.sessionId,
          taskId: asked.value.taskId,
          status: "completed",
          text: "212 tests ✓\n",
          startOffset: 0,
          endOffset: 14,
          totalBytes: 14,
          truncated: false,
          readAt: STUB_READ_AT,
        }),
      );
      const cut = body.indexOf(0xe2) + 1;
      response.write(body.subarray(0, cut));
      response.end(body.subarray(cut));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const http = createExecutionHostClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "e2e-token",
    });

    expect(
      await http.taskOutput("accent 8f2c?", "b7x2k9q1", { tail: 4_096 }),
    ).toEqual({
      sessionId: "accent 8f2c?",
      taskId: "b7x2k9q1",
      status: "completed",
      text: "212 tests ✓\n",
      startOffset: 0,
      endOffset: 14,
      totalBytes: 14,
      truncated: false,
      readAt: STUB_READ_AT,
    });
    expect(targets).toEqual([
      "/v0/execution/sessions/accent%208f2c%3F/tasks/b7x2k9q1/output?tail=4096",
    ]);
  });
});
