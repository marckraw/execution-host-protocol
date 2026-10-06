import { describe, expect, it } from "vitest";
import {
  checkExecutionInlineAttachments,
  decodeExecutionCommandEnvelope,
  decodeExecutionProviderListResponse,
  decodeExecutionStartRequest,
  EXECUTION_INLINE_ATTACHMENT_MAX_BYTES,
  EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH,
  EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT,
  EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionInlineAttachment,
  type ExecutionInlineFileAttachment,
} from "../src/index.js";
import {
  inlineAttachment,
  MiB,
} from "./fixtures/inline-attachment-fixtures.js";

const file: ExecutionInlineFileAttachment = {
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
  dataBase64: "AQID",
};
const image: ExecutionInlineAttachment = { ...file, kind: "image" };

const command = (inlineAttachments: unknown) =>
  JSON.stringify({
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    sessionId: "session-1",
    command: { kind: "send-message", text: "hello", inlineAttachments },
  });

describe("a file beside an image (MAR-3783)", () => {
  it("names attachments.inline-file.v1", () => {
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "attachments.inline-file.v1",
    );
  });

  it("reads a command carrying both kinds, in order", () => {
    expect(decodeExecutionCommandEnvelope(command([image, file]))).toEqual({
      ok: true,
      value: {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        sessionId: "session-1",
        command: {
          kind: "send-message",
          text: "hello",
          inlineAttachments: [image, file],
        },
      },
    });
  });

  it("reads a start carrying a file", () => {
    const decoded = decodeExecutionStartRequest(
      JSON.stringify({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        providerId: "claude",
        config: {
          sessionId: "session-1",
          initialMessage: "hello",
          model: null,
          effort: null,
          continuationToken: null,
          inlineAttachments: [{ ...file, future: true }],
        },
      }),
    );
    expect(decoded.ok && decoded.value.config.inlineAttachments).toEqual([
      file,
    ]);
  });

  it.each(["pdf", "video", "", "File", null, undefined])(
    "refuses the whole command for a kind %j it does not know, rather than skip it",
    (kind) => {
      expect(
        decodeExecutionCommandEnvelope(command([image, { ...file, kind }])),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    },
  );

  it.each([
    ["name", ""],
    ["mimeType", undefined],
    ["sizeBytes", "3"],
    ["sizeBytes", -1],
    ["dataBase64", ""],
  ])("refuses a file whose %s is %j", (field, value) => {
    expect(
      decodeExecutionCommandEnvelope(command([{ ...file, [field]: value }])),
    ).toEqual({ ok: false, reason: "invalid-payload" });
  });
});

describe("the limits, for any mix", () => {
  it("are agents-daemon's image limits", () => {
    expect(EXECUTION_INLINE_ATTACHMENTS_MAX_COUNT).toBe(4);
    expect(EXECUTION_INLINE_ATTACHMENT_MAX_BYTES).toBe(10 * MiB);
    expect(EXECUTION_INLINE_ATTACHMENTS_MAX_TOTAL_BYTES).toBe(20 * MiB);
  });

  it("takes nothing, or an empty list", () => {
    expect(checkExecutionInlineAttachments(undefined)).toEqual({
      ok: true,
      files: 0,
      totalBytes: 0,
    });
    expect(checkExecutionInlineAttachments([])).toEqual({
      ok: true,
      files: 0,
      totalBytes: 0,
    });
  });

  it.each([
    [3, true],
    [4, true],
    [5, false],
  ])("%i attachments: ok %s", (count, ok) => {
    const list = Array.from({ length: count }, (_, index) =>
      inlineAttachment(index % 2 === 0 ? "image" : "file", 3),
    );
    expect(checkExecutionInlineAttachments(list)).toEqual(
      ok
        ? { ok: true, files: Math.floor(count / 2), totalBytes: 3 * count }
        : { ok: false, problem: "too-many", index: null },
    );
  });

  it.each([
    [10 * MiB - 1, true],
    [10 * MiB, true],
    [10 * MiB + 1, false],
  ])("a file of %i bytes: ok %s", (sizeBytes, ok) => {
    expect(
      checkExecutionInlineAttachments([
        inlineAttachment("image", 3),
        inlineAttachment("file", sizeBytes),
      ]),
    ).toEqual(
      ok
        ? { ok: true, files: 1, totalBytes: sizeBytes + 3 }
        : { ok: false, problem: "too-large", index: 1 },
    );
  });

  it.each([
    [20 * MiB - 1, true],
    [20 * MiB, true],
    [20 * MiB + 1, false],
  ])("%i bytes together: ok %s", (total) => {
    const list = [
      inlineAttachment("file", 10 * MiB),
      inlineAttachment("image", 10 * MiB - 1),
      inlineAttachment("file", total - (20 * MiB - 1)),
    ].filter((entry) => entry.sizeBytes > 0);
    const ok = total <= 20 * MiB;
    expect(checkExecutionInlineAttachments(list)).toEqual(
      ok
        ? { ok: true, files: list.length - 1, totalBytes: total }
        : { ok: false, problem: "total-too-large", index: 2 },
    );
  });

  it.each([2, 4])("refuses sizeBytes %i for data that decodes to 3", (size) => {
    expect(
      checkExecutionInlineAttachments([{ ...file, sizeBytes: size }]),
    ).toEqual({ ok: false, problem: "size-mismatch", index: 0 });
  });

  it.each([
    ["AQID", 3],
    ["AQI=", 2],
    ["AQ==", 1],
  ])("reads %s as %i bytes", (dataBase64, sizeBytes) => {
    expect(
      checkExecutionInlineAttachments([{ ...file, dataBase64, sizeBytes }]),
    ).toMatchObject({ ok: true, totalBytes: sizeBytes });
  });

  it.each(["AQI", "AQ=D", "AQ-_", "AQ ID", "A==="])(
    "refuses %j, which is not padded standard base64",
    (dataBase64) => {
      expect(
        checkExecutionInlineAttachments([image, { ...file, dataBase64 }]),
      ).toEqual({ ok: false, problem: "invalid", index: 1 });
    },
  );

  it("refuses data that decodes to fewer bytes than it claims, empty data too", () => {
    expect(
      checkExecutionInlineAttachments([{ ...file, dataBase64: "" }]),
    ).toEqual({ ok: false, problem: "size-mismatch", index: 0 });
  });

  it("does the arithmetic before it reads the pattern", () => {
    // Not base64 at all, and the wrong length for what it claims: the length
    // answers first, without the pattern scanning the string.
    expect(
      checkExecutionInlineAttachments([
        { ...file, dataBase64: "!!!!!!!!", sizeBytes: 5 },
      ]),
    ).toEqual({ ok: false, problem: "size-mismatch", index: 0 });
    const huge = "!".repeat(64 * MiB);
    expect(
      checkExecutionInlineAttachments([
        { ...file, dataBase64: huge, sizeBytes: 5 },
      ]),
    ).toEqual({ ok: false, problem: "size-mismatch", index: 0 });
  });

  it.each([
    ["not a list", { ...file }, null],
    ["an unknown kind", [{ ...file, kind: "pdf" }], 0],
    ["a nameless entry", [{ ...file, name: "" }], 0],
    ["a fractional size", [{ ...file, sizeBytes: 2.5 }], 0],
  ])("refuses %s", (_label, raw, index) => {
    expect(checkExecutionInlineAttachments(raw)).toEqual({
      ok: false,
      problem: "invalid",
      index,
    });
  });
});

describe("names, types and empty attachments", () => {
  it("are 255 characters at most, each", () => {
    expect(EXECUTION_INLINE_ATTACHMENT_NAME_MAX_LENGTH).toBe(255);
    expect(EXECUTION_INLINE_ATTACHMENT_MIME_TYPE_MAX_LENGTH).toBe(255);
  });

  it.each([
    ["name", 254, null],
    ["name", 255, null],
    ["name", 256, "name-too-long"],
    ["mimeType", 254, null],
    ["mimeType", 255, null],
    ["mimeType", 256, "mime-type-too-long"],
  ] as const)("a %s of %i characters: %s", (field, length, problem) => {
    for (const kind of ["image", "file"] as const) {
      const entry = { ...file, kind, [field]: "n".repeat(length) };
      expect(checkExecutionInlineAttachments([image, entry])).toEqual(
        problem === null
          ? { ok: true, files: kind === "file" ? 1 : 0, totalBytes: 6 }
          : { ok: false, problem, index: 1 },
      );
    }
  });

  it("counts a name's length in UTF-16 code units", () => {
    const emoji = "📎"; // two code units
    expect(
      checkExecutionInlineAttachments([
        { ...file, name: `${emoji.repeat(127)}a` },
      ]),
    ).toMatchObject({ ok: true });
    expect(
      checkExecutionInlineAttachments([{ ...file, name: emoji.repeat(128) }]),
    ).toEqual({ ok: false, problem: "name-too-long", index: 0 });
  });

  it("refuses a 3-byte attachment with an 8 MiB name, so the body stays bounded", () => {
    expect(
      checkExecutionInlineAttachments([
        { ...image, name: "n".repeat(8 * MiB) },
      ]),
    ).toEqual({ ok: false, problem: "name-too-long", index: 0 });
  });

  it.each(["image", "file"] as const)(
    "refuses an empty %s as empty",
    (kind) => {
      expect(
        checkExecutionInlineAttachments([
          image,
          { ...file, kind, sizeBytes: 0, dataBase64: "" },
        ]),
      ).toEqual({ ok: false, problem: "empty", index: 1 });
    },
  );

  it("refuses data claimed as empty that is not", () => {
    expect(
      checkExecutionInlineAttachments([{ ...file, sizeBytes: 0 }]),
    ).toEqual({ ok: false, problem: "size-mismatch", index: 0 });
  });
});

describe("which attachment kinds a provider takes", () => {
  const catalogue = (features: unknown) => ({
    providers: [{ id: "claude", features, models: [] }],
  });

  it("reads features.attachmentKinds as the host says them", () => {
    const decoded = decodeExecutionProviderListResponse(
      catalogue({ attachmentKinds: ["image", "pdf"], resume: true }),
    );
    expect(decoded.ok && decoded.value.providers[0]).toMatchObject({
      attachmentKinds: ["image", "pdf"],
    });
  });

  it("reads none as none", () => {
    const decoded = decodeExecutionProviderListResponse(
      catalogue({ attachmentKinds: [] }),
    );
    expect(decoded.ok && decoded.value.providers[0]?.attachmentKinds).toEqual(
      [],
    );
  });

  it.each([undefined, { effortLevels: ["low"] }, { attachmentKinds: "image" }])(
    "leaves them absent, unknown, for features %j, and reads the rest",
    (features) => {
      const decoded = decodeExecutionProviderListResponse(catalogue(features));
      expect(decoded.ok).toBe(true);
      expect(decoded.ok && decoded.value.providers[0]).not.toHaveProperty(
        "attachmentKinds",
      );
    },
  );
});
