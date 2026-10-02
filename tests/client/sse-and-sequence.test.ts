import { describe, expect, it } from "vitest";
import {
  createSseParser,
  decodeExecutionCaughtUp,
  nextExecutionStreamPhase,
  readExecutionSeq,
} from "../../src/client/index.js";
import { seqOfFrameId } from "../../src/client/sequence.js";

describe("the SSE parser", () => {
  it("returns a frame only once its blank line has arrived, however the text is cut", () => {
    const text =
      'event: replay\nid: 7\ndata: {"a":1}\n\n: keep-alive\n\nid: 8\ndata: {"b":2}\n\n';
    for (let cut = 0; cut <= text.length; cut += 1) {
      const parser = createSseParser();
      const frames = [
        ...parser.feed(text.slice(0, cut)),
        ...parser.feed(text.slice(cut)),
      ];
      expect(frames).toEqual([
        { id: "7", event: "replay", data: '{"a":1}' },
        { id: "8", event: null, data: '{"b":2}' },
      ]);
    }
  });

  it("joins data lines, reads CRLF, and skips comments and unknown fields", () => {
    const parser = createSseParser();
    expect(
      parser.feed(
        "﻿retry: 10\r\n: comment\r\ndata: one\r\ndata:two\r\nfuture: x\r\n\r\n",
      ),
    ).toEqual([{ id: null, event: null, data: "one\ntwo" }]);
  });

  it("drops a frame without data and one the stream ended inside", () => {
    const parser = createSseParser();
    expect(parser.feed("event: ping\n\nid: 9\ndata: half")).toEqual([]);
  });

  it("does not carry one frame's id or name into the next", () => {
    const parser = createSseParser();
    expect(parser.feed("event: replay\nid: 3\ndata: a\n\ndata: b\n\n")).toEqual(
      [
        { id: "3", event: "replay", data: "a" },
        { id: null, event: null, data: "b" },
      ],
    );
  });
});

describe("reading a sequence number", () => {
  it("accepts the next number, drops what it holds, and calls a live hole a gap", () => {
    expect(readExecutionSeq(4, 5, "live")).toBe("accept");
    expect(readExecutionSeq(4, 4, "live")).toBe("duplicate");
    expect(readExecutionSeq(4, 2, "replay")).toBe("duplicate");
    expect(readExecutionSeq(4, 6, "live")).toBe("gap");
  });

  it("forgives a hole on the first frame of a resume, and inside a named replay", () => {
    expect(readExecutionSeq(4, 9, "resumed")).toBe("accept");
    expect(readExecutionSeq(4, 9, "replay")).toBe("accept");
  });

  it("forgives only the first frame of a resume", () => {
    const phase = nextExecutionStreamPhase("resumed", "accept");
    expect(phase).toBe("live");
    expect(readExecutionSeq(9, 12, phase)).toBe("gap");
    expect(nextExecutionStreamPhase("replay", "accept")).toBe("replay");
    expect(nextExecutionStreamPhase("resumed", "duplicate")).toBe("resumed");
  });

  it("reads a caught-up boundary, and leaves the cursor alone when it cannot", () => {
    expect(decodeExecutionCaughtUp('{"throughSeq":42}')).toBe(42);
    expect(decodeExecutionCaughtUp('{"throughSeq":0}')).toBe(0);
    for (const unreadable of [
      "",
      "{",
      "[]",
      '{"throughSeq":-1}',
      '{"throughSeq":1.5}',
      '{"throughSeq":"9"}',
    ]) {
      expect(decodeExecutionCaughtUp(unreadable)).toBeNull();
    }
  });

  it("takes a frame id as a sequence number only when it is one", () => {
    expect(seqOfFrameId("12")).toBe(12);
    for (const id of [null, "", "0", "-3", "1e3", "12a", "9007199254740993"]) {
      expect(seqOfFrameId(id)).toBeNull();
    }
  });
});
