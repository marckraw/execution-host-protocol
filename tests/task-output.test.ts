import { describe, expect, it } from "vitest";
import {
  decodeExecutionTaskOutputRefusal,
  decodeExecutionTaskOutputRequest,
  decodeExecutionTaskOutputResponse,
  decodeExecutionTaskOutputWindow,
  encodeExecutionTaskOutputRequest,
  encodeExecutionTaskOutputResponse,
  executionTaskOutputReadRange,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_TASK_OUTPUT_MAX_BYTES,
  EXECUTION_TASK_OUTPUT_REFUSAL_CODES,
  EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES,
  EXECUTION_TASK_OUTPUT_STATUSES,
  EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH,
  type AgentRunStatus,
  type ExecutionTaskOutputResponse,
} from "../src/index.js";

const ROUTE = "/v0/execution/sessions/session-1/tasks/b7x2k9q1/output";

/** A running `pnpm check` 200 KiB in, its last 64 KiB read. */
const OUTPUT: ExecutionTaskOutputResponse = {
  sessionId: "session-1",
  taskId: "b7x2k9q1",
  status: "running",
  text: "✓ packages/protocol (212 tests)\n",
  startOffset: 139_264,
  endOffset: 204_800,
  totalBytes: 204_800,
  truncated: true,
  readAt: "2026-10-14T05:30:00.000Z",
};

const encoder = new TextEncoder();

describe("task-output capability", () => {
  it("is a known capability", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain("tasks.output.v1");
  });

  it("caps a read at 64 KiB, and its text at as many characters", () => {
    expect(EXECUTION_TASK_OUTPUT_MAX_BYTES).toBe(65_536);
    expect(EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH).toBe(65_536);
  });
});

describe("task-output requests", () => {
  it("names a session and a task, and the tail when given", () => {
    expect(
      encodeExecutionTaskOutputRequest({
        sessionId: "session-1",
        taskId: "b7x2k9q1",
        tail: 4_096,
      }),
    ).toBe(`${ROUTE}?tail=4096`);
    expect(
      encodeExecutionTaskOutputRequest({
        sessionId: "session-1",
        taskId: "b7x2k9q1",
      }),
    ).toBe(ROUTE);
  });

  it("encodes the session id as a path segment", () => {
    expect(
      encodeExecutionTaskOutputRequest({
        sessionId: "accent 8f2c?",
        taskId: "t.1_a-B",
        tail: 1,
      }),
    ).toBe(
      "/v0/execution/sessions/accent%208f2c%3F/tasks/t.1_a-B/output?tail=1",
    );
  });

  it("decodes what it encodes", () => {
    for (const request of [
      { sessionId: "session-1", taskId: "b7x2k9q1", tail: 1 },
      { sessionId: "accent 8f2c?", taskId: "t.1_a-B", tail: 65_536 },
      { sessionId: "é😀", taskId: "x".repeat(256), tail: 4_096 },
      { sessionId: "s".repeat(256), taskId: "b7x2k9q1", tail: 4_096 },
      { sessionId: "a..b", taskId: "b7x2k9q1", tail: 4_096 },
    ]) {
      expect(
        decodeExecutionTaskOutputRequest(
          encodeExecutionTaskOutputRequest(request),
        ),
      ).toEqual({ ok: true, value: request });
    }
  });

  it("reads an absent tail as the most", () => {
    expect(decodeExecutionTaskOutputRequest(ROUTE)).toEqual({
      ok: true,
      value: { sessionId: "session-1", taskId: "b7x2k9q1", tail: 65_536 },
    });
  });

  it.each<[string, string]>([
    ["an empty query", `${ROUTE}?`],
    ["a tail of nothing", `${ROUTE}?tail=0`],
    ["a tail past the cap", `${ROUTE}?tail=65537`],
    ["a far larger tail", `${ROUTE}?tail=99999999999`],
    ["an empty tail", `${ROUTE}?tail=`],
    ["a tail with leading zeros", `${ROUTE}?tail=01024`],
    ["a fractional tail", `${ROUTE}?tail=1.5`],
    ["a negative tail", `${ROUTE}?tail=-1`],
    ["a signed tail", `${ROUTE}?tail=+1`],
    ["a tail in exponent form", `${ROUTE}?tail=1e3`],
    ["a padded tail", `${ROUTE}?tail=%201`],
    ["a tail with no value", `${ROUTE}?tail`],
    ["two tails", `${ROUTE}?tail=1&tail=2`],
    ["a path beside the tail", `${ROUTE}?tail=1&path=/etc/passwd`],
    ["a path instead", `${ROUTE}?path=/etc/passwd`],
    ["a file instead", `${ROUTE}?file=x.output`],
    ["an encoded parameter name", `${ROUTE}?%74ail=1`],
    ["a trailing separator", `${ROUTE}?tail=1&`],
    ["a fragment", `${ROUTE}#tail`],
    ["another route", "/v0/sessions/session-1/tasks/b7x2k9q1/output"],
    ["no task", "/v0/execution/sessions/session-1/tasks//output"],
    ["a segment past the route", `${ROUTE}/more`],
    ["a trailing slash", `${ROUTE}/`],
    ["an absolute URL", `https://host.test${ROUTE}`],
    [
      "a task id holding a slash",
      "/v0/execution/sessions/session-1/tasks/a%2Fb/output",
    ],
    [
      "a task id that is a dot segment",
      "/v0/execution/sessions/session-1/tasks/%2E%2E/output",
    ],
    [
      "a task id that is a path",
      "/v0/execution/sessions/session-1/tasks/%2Fetc%2Fpasswd/output",
    ],
    [
      "a task id outside the grammar",
      "/v0/execution/sessions/session-1/tasks/task%201/output",
    ],
    [
      "a task id past its bound",
      `/v0/execution/sessions/session-1/tasks/${"x".repeat(257)}/output`,
    ],
    [
      "a session id that is a dot segment",
      "/v0/execution/sessions/%2E%2E/tasks/b7x2k9q1/output",
    ],
    [
      "a broken escape",
      "/v0/execution/sessions/session%E0%A4%A/tasks/b7x2k9q1/output",
    ],
    ...(
      [
        ["a session id climbing out", "..%2F..%2Fetc"],
        ["a session id that is a path", "%2Fetc%2Fpasswd"],
        ["a session id holding a slash", "accent%2F8f2c"],
        ["a session id holding a backslash", "..%5C.."],
        ["a session id holding NUL", "a%00b"],
        ["a session id holding a line break", "a%0Ab"],
        ["a session id holding DEL", "a%7Fb"],
        ["a session id holding a C1 control", "a%C2%85b"],
        ["a session id of fullwidth dots", "%EF%BC%8E%EF%BC%8E"],
        ["a session id of a two-dot leader", "%E2%80%A5"],
        ["a session id holding a fullwidth solidus", "a%EF%BC%8Fb"],
        ["a session id holding a fullwidth backslash", "a%EF%BC%BCb"],
        ["a session id holding a lone surrogate", "a%ED%A0%80b"],
        ["a session id past its bound", "s".repeat(257)],
        ["a 100,000-character session id", "s".repeat(100_000)],
      ] as const
    ).map(([name, segment]): [string, string] => [
      name,
      `/v0/execution/sessions/${segment}/tasks/b7x2k9q1/output`,
    ]),
  ])("refuses %s", (_name, target) => {
    expect(decodeExecutionTaskOutputRequest(target)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });

  it("refuses to write a request it would refuse to read", () => {
    const at = (overrides: Record<string, unknown>) => () =>
      encodeExecutionTaskOutputRequest({
        sessionId: "session-1",
        taskId: "b7x2k9q1",
        ...overrides,
      } as never);
    for (const tail of [0, 65_537, 1.5, -1, Number.NaN, Infinity, "64"]) {
      expect(at({ tail })).toThrow(RangeError);
    }
    for (const taskId of [
      "",
      ".",
      "..",
      "../etc/passwd",
      "/tmp/x.output",
      "a/b",
      "a\\b",
      "task 1",
      "x".repeat(257),
      42,
    ]) {
      expect(at({ taskId })).toThrow(TypeError);
    }
    for (const sessionId of [
      "",
      ".",
      "..",
      "../../etc",
      "/etc/passwd",
      "a/b",
      "..\\..",
      "a\u0000b",
      "a\nb",
      "a\u0085b",
      "\uff0e\uff0e",
      "a\uff0fb",
      "a\ud800b",
      "s".repeat(257),
      null,
    ]) {
      expect(at({ sessionId })).toThrow(TypeError);
    }
    expect(at({ tail: 65_536 })()).toBe(`${ROUTE}?tail=65536`);
  });
});

describe("task-output answers", () => {
  it("encodes its fields in one order, and decodes what it encodes", () => {
    const shuffled = {
      readAt: OUTPUT.readAt,
      truncated: OUTPUT.truncated,
      totalBytes: OUTPUT.totalBytes,
      endOffset: OUTPUT.endOffset,
      startOffset: OUTPUT.startOffset,
      text: OUTPUT.text,
      status: OUTPUT.status,
      taskId: OUTPUT.taskId,
      sessionId: OUTPUT.sessionId,
    };
    const body = encodeExecutionTaskOutputResponse(shuffled);
    expect(Object.keys(JSON.parse(body) as object)).toEqual([
      "sessionId",
      "taskId",
      "status",
      "text",
      "startOffset",
      "endOffset",
      "totalBytes",
      "truncated",
      "readAt",
    ]);
    expect(decodeExecutionTaskOutputResponse(JSON.parse(body))).toEqual({
      ok: true,
      value: OUTPUT,
    });
  });

  it("reads every status a task's evidence names", () => {
    for (const status of EXECUTION_TASK_OUTPUT_STATUSES) {
      expect(
        decodeExecutionTaskOutputResponse({ ...OUTPUT, status }),
      ).toMatchObject({ ok: true, value: { status } });
    }
  });

  it("takes the caps exactly", () => {
    const atCaps = {
      ...OUTPUT,
      text: "x".repeat(EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH),
      startOffset: 1_000,
      endOffset: 1_000 + EXECUTION_TASK_OUTPUT_MAX_BYTES,
      totalBytes: 1_000 + EXECUTION_TASK_OUTPUT_MAX_BYTES,
    };
    expect(decodeExecutionTaskOutputResponse(atCaps).ok).toBe(true);
    expect(() => encodeExecutionTaskOutputResponse(atCaps)).not.toThrow();
  });

  it("reads a whole file, an empty one, a held-back line, and one past 2^32 bytes", () => {
    for (const answer of [
      {
        ...OUTPUT,
        startOffset: 0,
        endOffset: 31,
        totalBytes: 31,
        truncated: false,
      },
      {
        ...OUTPUT,
        text: "",
        startOffset: 0,
        endOffset: 0,
        totalBytes: 0,
        truncated: false,
      },
      // A running task's unfinished last line, held back.
      { ...OUTPUT, endOffset: 204_000 },
      { ...OUTPUT, status: "unknown", endOffset: 204_000 },
      // No line starts within the tail: an empty window at the end.
      {
        ...OUTPUT,
        text: "",
        startOffset: 204_800,
        endOffset: 204_800,
      },
      {
        ...OUTPUT,
        startOffset: 2 ** 32,
        endOffset: 2 ** 32 + 65_536,
        totalBytes: 2 ** 32 + 65_536,
        truncated: true,
      },
      { ...OUTPUT, readAt: "2026-10-14T07:30:00+02:00" },
      { ...OUTPUT, readAt: "2026-10-14T05:30:00Z" },
      { ...OUTPUT, readAt: "2028-02-29T23:59:59.999999999-12:00" },
      { ...OUTPUT, text: "😀 ok" },
    ]) {
      expect(decodeExecutionTaskOutputResponse(answer)).toEqual({
        ok: true,
        value: answer,
      });
    }
  });

  it("ignores fields it does not know", () => {
    expect(
      decodeExecutionTaskOutputResponse({
        ...OUTPUT,
        path: "/Users/piotr/.claude/tasks/b7x2k9q1.output",
        encoding: "utf-8",
      }),
    ).toEqual({ ok: true, value: OUTPUT });
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a window past the cap",
      {
        startOffset: 0,
        endOffset: 65_537,
        totalBytes: 65_537,
        truncated: false,
      },
    ],
    [
      "a window past the cap, its end held back inside it",
      { startOffset: 0, endOffset: 10, totalBytes: 65_537, truncated: false },
    ],
    [
      "a far larger window",
      {
        startOffset: 1,
        endOffset: 10_000_000,
        totalBytes: 10_000_000,
        truncated: true,
      },
    ],
    ["no end", { endOffset: undefined }],
    ["a window ending past the file's end", { endOffset: 204_801 }],
    ["a window ending before it starts", { endOffset: 139_263 }],
    ["an end as a string", { endOffset: "204800" }],
    [
      "a completed task's line held back",
      { status: "completed", endOffset: 204_000 },
    ],
    [
      "a failed task's line held back",
      { status: "failed", endOffset: 204_000 },
    ],
    [
      "a stopped task's line held back",
      { status: "stopped", endOffset: 204_000 },
    ],
    ["a lone high surrogate in the text", { text: "a\ud800b" }],
    ["a lone low surrogate in the text", { text: "a\udc00b" }],
    [
      "text past its cap",
      { text: "x".repeat(EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH + 1) },
    ],
    ["a window starting past the file's end", { startOffset: 204_801 }],
    ["a negative offset", { startOffset: -1, truncated: false }],
    ["a fractional offset", { startOffset: 1.5 }],
    [
      "an offset past 2^53",
      { startOffset: 2 ** 53, endOffset: 2 ** 53 + 1, totalBytes: 2 ** 53 + 1 },
    ],
    ["a size as a string", { totalBytes: "204800" }],
    [
      "truncated with the file's start in view",
      { truncated: true, startOffset: 0, endOffset: 10, totalBytes: 10 },
    ],
    ["not truncated with the start out of view", { truncated: false }],
    ["truncated as a string", { truncated: "true" }],
    ["text in an empty window", { startOffset: 204_800 }],
    ["text in a window emptied by a held-back line", { endOffset: 139_264 }],
    ["a status this build does not know", { status: "paused" }],
    ["no status", { status: undefined }],
    ["text that is not a string", { text: null }],
    ["no text", { text: undefined }],
    ["another session's id that is a dot segment", { sessionId: ".." }],
    ["a task id holding a path", { taskId: "../b7x2k9q1" }],
    ["a time that is no timestamp", { readAt: "yesterday" }],
    ["a date without a time", { readAt: "2026-10-14" }],
    ["a time without a zone", { readAt: "2026-10-14T05:30:00" }],
    ["an impossible time", { readAt: "2026-13-45T05:30:00Z" }],
    ["a day the month does not have", { readAt: "2026-02-30T05:30:00Z" }],
    ["a leap day in a common year", { readAt: "2026-02-29T05:30:00Z" }],
    ["hour 24", { readAt: "2026-10-14T24:00:00Z" }],
    ["minute 60", { readAt: "2026-10-14T05:60:00Z" }],
    ["a leap second", { readAt: "2026-12-31T23:59:60Z" }],
    ["month 0", { readAt: "2026-00-14T05:30:00Z" }],
    ["day 0", { readAt: "2026-10-00T05:30:00Z" }],
    ["an offset of 24 hours", { readAt: "2026-10-14T05:30:00+24:00" }],
    ["a lowercase separator", { readAt: "2026-10-14t05:30:00z" }],
    ["a time as a number", { readAt: 1_791_955_800_000 }],
  ])("refuses %s", (_name, overrides) => {
    const answer = { ...OUTPUT, ...overrides };
    expect(decodeExecutionTaskOutputResponse(answer)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
    expect(() =>
      encodeExecutionTaskOutputResponse(answer as ExecutionTaskOutputResponse),
    ).toThrow(TypeError);
  });

  it.each([null, [], "text", 42])("refuses %j", (raw) => {
    expect(decodeExecutionTaskOutputResponse(raw).ok).toBe(false);
  });
});

describe("task-output refusals", () => {
  it("has a status for every code", () => {
    expect(EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES).toEqual({
      "session-unknown": 404,
      "task-unknown": 404,
      "no-output": 404,
      "read-refused": 403,
      rejected: 400,
    });
    expect(Object.keys(EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES).sort()).toEqual(
      [...EXECUTION_TASK_OUTPUT_REFUSAL_CODES].sort(),
    );
  });

  it.each(EXECUTION_TASK_OUTPUT_REFUSAL_CODES)("reads %s", (code) => {
    expect(
      decodeExecutionTaskOutputRefusal({
        error: "Not readable",
        code,
        detail: "ignored",
      }),
    ).toEqual({ ok: true, value: { error: "Not readable", code } });
  });

  it.each<[string, unknown]>([
    ["a code this build does not know", { error: "x", code: "too-big" }],
    ["no code", { error: "Not found" }],
    ["no error", { code: "task-unknown" }],
    ["a body that is not an object", "task-unknown"],
  ])("refuses %s", (_name, raw) => {
    expect(decodeExecutionTaskOutputRefusal(raw)).toEqual({
      ok: false,
      reason: "invalid-payload",
    });
  });
});

describe("task-output read ranges", () => {
  it.each<[number, number, number, number]>([
    // [size, tail, position, length]
    [0, 10, 0, 0],
    [5, 10, 0, 5],
    [10, 10, 0, 10],
    [11, 10, 0, 11],
    [100, 10, 89, 11],
    [2 ** 40, 65_536, 2 ** 40 - 65_537, 65_537],
  ])(
    "reads a file of %i bytes for a tail of %i from %i, %i bytes",
    (size, tail, position, length) => {
      expect(executionTaskOutputReadRange(size, tail)).toEqual({
        position,
        length,
      });
    },
  );

  it("refuses a size or a tail out of bounds", () => {
    expect(() => executionTaskOutputReadRange(-1, 10)).toThrow(RangeError);
    expect(() => executionTaskOutputReadRange(10, 0)).toThrow(RangeError);
    expect(() => executionTaskOutputReadRange(10, 65_537)).toThrow(RangeError);
  });
});

describe("task-output windows", () => {
  /** A file's window, read as a host reads it. */
  const windowOf = (
    file: string | Uint8Array,
    tail: number,
    status: AgentRunStatus = "running",
  ) => {
    const bytes = typeof file === "string" ? encoder.encode(file) : file;
    const { position, length } = executionTaskOutputReadRange(
      bytes.byteLength,
      tail,
    );
    return decodeExecutionTaskOutputWindow(
      bytes.slice(position, position + length),
      position,
      tail,
      status,
    );
  };

  it("holds a whole file the tail covers", () => {
    expect(windowOf("ok ✓\nnext\n", 64)).toEqual({
      startOffset: 0,
      endOffset: 12,
      totalBytes: 12,
      truncated: false,
      text: "ok ✓\nnext\n",
    });
  });

  it("leaves out a line the tail cut, whole", () => {
    expect(windowOf("first\nsecond\n", 10)).toEqual({
      startOffset: 6,
      endOffset: 13,
      totalBytes: 13,
      truncated: true,
      text: "second\n",
    });
  });

  it("keeps a line the tail reaches exactly", () => {
    expect(windowOf("first\nsecond\n", 7)).toMatchObject({
      startOffset: 6,
      text: "second\n",
    });
  });

  it("starts at the file's start when the tail covers one byte more than the file", () => {
    expect(windowOf("ab\ncd\n", 5)).toMatchObject({
      startOffset: 3,
      truncated: true,
      text: "cd\n",
    });
  });

  it("never shows a fragment of a secret the tail cut, at any tail", () => {
    const file = "token sk-live-abc123XYZ leaked\nend\n";
    const seen = new Set<string>();
    for (let tail = 1; tail <= file.length + 1; tail++) {
      // Redacted by exact value, as agents-daemon's `redactCredentials` does.
      const { text } = windowOf(file, tail);
      seen.add(text.split("sk-live-abc123XYZ").join("[redacted]"));
    }
    expect([...seen].sort()).toEqual([
      "",
      "end\n",
      "token [redacted] leaked\nend\n",
    ]);
  });

  it("holds back a running task's last line until it ends", () => {
    const file = "done\npartial sk-li";
    for (const status of ["running", "unknown"] as const) {
      expect(windowOf(file, 64, status)).toEqual({
        startOffset: 0,
        endOffset: 5,
        totalBytes: 18,
        truncated: false,
        text: "done\n",
      });
    }
  });

  it("shows an ended task's last line, the file being whole", () => {
    for (const status of ["completed", "failed", "stopped"] as const) {
      expect(windowOf("done\nlast", 64, status)).toMatchObject({
        endOffset: 9,
        totalBytes: 9,
        text: "done\nlast",
      });
    }
  });

  it("is empty when no line starts within the tail", () => {
    expect(windowOf("x".repeat(100), 10)).toEqual({
      startOffset: 100,
      endOffset: 100,
      totalBytes: 100,
      truncated: true,
      text: "",
    });
  });

  it("is empty while a running task's only line is unfinished", () => {
    expect(windowOf("compiling", 64)).toMatchObject({
      startOffset: 0,
      endOffset: 0,
      text: "",
    });
  });

  it("never cuts a character: a line boundary is one", () => {
    // Every tail into "é" or "😀" leaves the cut line out whole.
    const file = "aé\n😀 b\nend\n";
    for (let tail = 1; tail <= encoder.encode(file).byteLength; tail++) {
      expect(windowOf(file, tail).text).not.toContain("\ufffd");
    }
  });

  it("decodes invalid bytes, and an ended task's unfinished character, as U+FFFD", () => {
    expect(
      windowOf(
        new Uint8Array([0x41, 0xff, 0x42, 0x0a, 0x43, 0xe2, 0x9c]),
        64,
        "completed",
      ),
    ).toMatchObject({ text: "A\ufffdB\nC\ufffd" });
  });

  it("holds back a running task's unfinished character with its line", () => {
    expect(
      windowOf(new Uint8Array([0x41, 0x0a, 0x43, 0xe2, 0x9c]), 64),
    ).toMatchObject({ endOffset: 2, totalBytes: 5, text: "A\n" });
  });

  it("keeps a byte order mark", () => {
    expect(windowOf("\ufeffok\n", 64).text).toBe("\ufeffok\n");
  });

  it("never makes a window past the tail, or text past its cap", () => {
    let seed = 7;
    const random = new Uint8Array(EXECUTION_TASK_OUTPUT_MAX_BYTES + 100);
    for (let i = 0; i < random.length; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      random[i] = seed & 0xff;
    }
    for (const bytes of [
      random,
      new Uint8Array(EXECUTION_TASK_OUTPUT_MAX_BYTES + 1).fill(0x0a),
      new Uint8Array(EXECUTION_TASK_OUTPUT_MAX_BYTES).fill(0xff),
      encoder.encode("😀\n".repeat(EXECUTION_TASK_OUTPUT_MAX_BYTES / 5)),
    ]) {
      for (const status of ["running", "completed"] as const) {
        const window = windowOf(bytes, EXECUTION_TASK_OUTPUT_MAX_BYTES, status);
        expect(window.totalBytes - window.startOffset).toBeLessThanOrEqual(
          EXECUTION_TASK_OUTPUT_MAX_BYTES,
        );
        expect(window.text.length).toBeLessThanOrEqual(
          EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH,
        );
        expect(
          encodeExecutionTaskOutputResponse({ ...OUTPUT, ...window, status }),
        ).toBeTypeOf("string");
      }
    }
  });

  it("refuses bytes that do not reach before the tail, or the file's start", () => {
    const bytes = encoder.encode("abcdef\n");
    // A file of 107 bytes, a tail of 7: the read must start by byte 99.
    expect(() =>
      decodeExecutionTaskOutputWindow(bytes, 100, 7, "running"),
    ).toThrow(RangeError);
    // A file of 9 bytes, all within the tail: the read must start at 0.
    expect(() =>
      decodeExecutionTaskOutputWindow(bytes, 2, 64, "running"),
    ).toThrow(RangeError);
    expect(() =>
      decodeExecutionTaskOutputWindow(bytes, -1, 64, "running"),
    ).toThrow(RangeError);
    expect(() =>
      decodeExecutionTaskOutputWindow(bytes, 0, 0, "running"),
    ).toThrow(RangeError);
    expect(() =>
      decodeExecutionTaskOutputWindow(bytes, 0, 64, "paused" as never),
    ).toThrow(RangeError);
  });
});
