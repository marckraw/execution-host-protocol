import { describe, expect, it } from "vitest";
import {
  decodeExecutionTaskOutputRefusal,
  decodeExecutionTaskOutputRequest,
  decodeExecutionTaskOutputResponse,
  decodeExecutionTaskOutputWindow,
  encodeExecutionTaskOutputRequest,
  encodeExecutionTaskOutputResponse,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_TASK_OUTPUT_MAX_BYTES,
  EXECUTION_TASK_OUTPUT_REFUSAL_CODES,
  EXECUTION_TASK_OUTPUT_REFUSAL_STATUSES,
  EXECUTION_TASK_OUTPUT_STATUSES,
  EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH,
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
        sessionId: "accent/8f 2c?",
        taskId: "t.1_a-B",
        tail: 1,
      }),
    ).toBe(
      "/v0/execution/sessions/accent%2F8f%202c%3F/tasks/t.1_a-B/output?tail=1",
    );
  });

  it("decodes what it encodes", () => {
    for (const request of [
      { sessionId: "session-1", taskId: "b7x2k9q1", tail: 1 },
      { sessionId: "accent/8f 2c?", taskId: "t.1_a-B", tail: 65_536 },
      { sessionId: "é", taskId: "x".repeat(256), tail: 4_096 },
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
    expect(decodeExecutionTaskOutputRequest(`${ROUTE}?`)).toMatchObject({
      ok: true,
      value: { tail: 65_536 },
    });
  });

  it.each<[string, string]>([
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
    for (const sessionId of ["", ".", "..", null]) {
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
      totalBytes: 1_000 + EXECUTION_TASK_OUTPUT_MAX_BYTES,
    };
    expect(decodeExecutionTaskOutputResponse(atCaps).ok).toBe(true);
    expect(() => encodeExecutionTaskOutputResponse(atCaps)).not.toThrow();
  });

  it("reads a whole file, an empty one, and one past 2^32 bytes", () => {
    for (const answer of [
      { ...OUTPUT, startOffset: 0, totalBytes: 31, truncated: false },
      { ...OUTPUT, text: "", startOffset: 0, totalBytes: 0, truncated: false },
      {
        ...OUTPUT,
        startOffset: 2 ** 32,
        totalBytes: 2 ** 32 + 65_536,
        truncated: true,
      },
      { ...OUTPUT, readAt: "2026-10-14T07:30:00+02:00" },
      { ...OUTPUT, readAt: "2026-10-14T05:30:00Z" },
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
      { startOffset: 0, totalBytes: 65_537, truncated: false },
    ],
    [
      "a far larger window",
      { startOffset: 1, totalBytes: 10_000_000, truncated: true },
    ],
    [
      "text past its cap",
      { text: "x".repeat(EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH + 1) },
    ],
    ["a window starting past the file's end", { startOffset: 204_801 }],
    ["a negative offset", { startOffset: -1, truncated: false }],
    ["a fractional offset", { startOffset: 1.5 }],
    ["an offset past 2^53", { startOffset: 2 ** 53, totalBytes: 2 ** 53 + 1 }],
    ["a size as a string", { totalBytes: "204800" }],
    [
      "truncated with the file's start in view",
      { truncated: true, startOffset: 0, totalBytes: 10 },
    ],
    ["not truncated with the start out of view", { truncated: false }],
    ["truncated as a string", { truncated: "true" }],
    ["text in an empty window", { startOffset: 204_800 }],
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

describe("task-output windows", () => {
  const window = (text: string, from: number) => {
    const bytes = encoder.encode(text);
    return decodeExecutionTaskOutputWindow(bytes.subarray(from), from);
  };

  it("decodes a whole file as it is", () => {
    expect(window("ok ✓\n", 0)).toEqual({ startOffset: 0, text: "ok ✓\n" });
  });

  it.each<[string, string, number, number]>([
    // [text, what is left, where the tail reached, where the window starts]
    ["aé b", " b", 2, 3], // 2 bytes: cut after the first
    ["a✓ b", " b", 2, 4], // 3 bytes: cut after the first
    ["a✓ b", " b", 3, 4], // 3 bytes: cut after the second
    ["a😀 b", " b", 2, 5], // 4 bytes: cut after the first
    ["a😀 b", " b", 4, 5], // 4 bytes: cut after the third
  ])(
    "repairs a tail that cut a character: %j from %i",
    (text, rest, from, startOffset) => {
      expect(window(text, from)).toEqual({ startOffset, text: rest });
    },
  );

  it("starts on a character the tail did not cut", () => {
    expect(window("a✓ b", 1)).toEqual({ startOffset: 1, text: "✓ b" });
  });

  it("skips at most 3 continuation bytes, the rest are invalid", () => {
    const bytes = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x41]);
    expect(decodeExecutionTaskOutputWindow(bytes, 10)).toEqual({
      startOffset: 13,
      text: "�A",
    });
  });

  it("skips nothing at the file's start: a continuation byte there is invalid", () => {
    expect(
      decodeExecutionTaskOutputWindow(new Uint8Array([0x80, 0x41]), 0),
    ).toEqual({ startOffset: 0, text: "�A" });
  });

  it("decodes invalid bytes, and a character still being written, as U+FFFD", () => {
    const bytes = new Uint8Array([0x41, 0xff, 0x42, 0xe2, 0x9c]);
    expect(decodeExecutionTaskOutputWindow(bytes, 0)).toEqual({
      startOffset: 0,
      text: "A�B�",
    });
  });

  it("keeps a byte order mark", () => {
    expect(window("﻿ok", 0)).toEqual({ startOffset: 0, text: "﻿ok" });
  });

  it("never decodes a window past the cap into text past its cap", () => {
    let seed = 7;
    const random = new Uint8Array(EXECUTION_TASK_OUTPUT_MAX_BYTES);
    for (let i = 0; i < random.length; i++) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      random[i] = seed & 0xff;
    }
    for (const bytes of [
      random,
      new Uint8Array(EXECUTION_TASK_OUTPUT_MAX_BYTES).fill(0xff),
      encoder.encode("😀".repeat(EXECUTION_TASK_OUTPUT_MAX_BYTES / 4)),
    ]) {
      const decoded = decodeExecutionTaskOutputWindow(bytes, 100);
      expect(decoded.text.length).toBeLessThanOrEqual(
        EXECUTION_TASK_OUTPUT_TEXT_MAX_LENGTH,
      );
      expect(
        encodeExecutionTaskOutputResponse({
          ...OUTPUT,
          text: decoded.text,
          startOffset: decoded.startOffset,
          totalBytes: 100 + bytes.byteLength,
          truncated: true,
        }),
      ).toBeTypeOf("string");
    }
  });

  it("refuses an offset that is not a whole number of bytes", () => {
    expect(() => decodeExecutionTaskOutputWindow(new Uint8Array(), -1)).toThrow(
      RangeError,
    );
  });
});
