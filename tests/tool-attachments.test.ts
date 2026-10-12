import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeExecutionConversationItem,
  decodeExecutionEventEnvelope,
  decodeExecutionProtocolDescriptor,
  encodeExecutionEventEnvelope,
  EXECUTION_PROTOCOL_CAPABILITY_IDS,
  EXECUTION_PROTOCOL_VERSION,
  EXECUTION_TOOL_ATTACHMENT_MAX_BYTES,
  EXECUTION_TOOL_ATTACHMENT_MAX_PIXELS,
  EXECUTION_TOOL_ATTACHMENT_MAX_SIDE,
  EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT,
  EXECUTION_TOOL_ATTACHMENTS_MAX_TURN_BYTES,
  EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_COUNT,
  EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_BYTES,
  EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_PREVIEW_BYTES,
  EXECUTION_TOOL_ATTACHMENT_MAX_RENDITION_BYTES,
  EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES,
  EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH,
  type ExecutionConversationItemPatch,
} from "../src/index.js";
import {
  imageToolResult,
  textToolResult,
  toolAttachment,
  toolResultEnvelope,
} from "./fixtures/tool-attachment-fixtures.js";

const readAttachments = (attachments: unknown) =>
  decodeExecutionConversationItem({ ...textToolResult, attachments });
const warning = (path: string) => ({ reason: "dropped-invalid-field", path });

describe("tool image references (MAR-3926)", () => {
  it("adds a capability without changing the wire version or closing capability strings", () => {
    expect(EXECUTION_PROTOCOL_VERSION).toBe(1);
    expect(EXECUTION_PROTOCOL_CAPABILITY_IDS).toContain(
      "items.toolAttachments.v1",
    );
    expect(
      decodeExecutionProtocolDescriptor({
        version: 1,
        capabilities: ["items.toolAttachments.v1", "future.v1"],
      }),
    ).toMatchObject({ ok: true });
  });

  it("keeps absent fields absent and an empty list empty", () => {
    expect(decodeExecutionConversationItem(textToolResult)).toEqual({
      ok: true,
      value: textToolResult,
    });
    expect(readAttachments([])).toEqual({
      ok: true,
      value: { ...textToolResult, attachments: [] },
    });
    expect(
      decodeExecutionConversationItem({
        ...textToolResult,
        toolName: null,
        relatedItemId: null,
        outputText: "",
      }),
    ).toMatchObject({ ok: true });
  });

  it("projects known fields, accepts JPEG and future image MIME tokens, and never copies payloads", () => {
    for (const mimeType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/x-future+test",
      "IMAGE/PNG",
    ]) {
      const attachment = { ...toolAttachment, mimeType };
      expect(
        readAttachments([
          {
            ...attachment,
            url: "https://example.test/private",
            dataBase64: "secret",
            path: "/private/image",
            bytes: [1],
            future: true,
          },
        ]),
      ).toEqual({
        ok: true,
        value: { ...textToolResult, attachments: [attachment] },
      });
    }
  });

  it.each([null, {}, "image", 1, false])(
    "drops an invalid optional list %j and keeps every text field",
    (attachments) => {
      expect(readAttachments(attachments)).toEqual({
        ok: true,
        value: textToolResult,
        warnings: [warning("item.attachments")],
      });
    },
  );

  it("drops only bad entries in a bounded list", () => {
    const second = { ...toolAttachment, id: "image-2" };
    expect(
      readAttachments([null, toolAttachment, { ...second, width: 0 }, second]),
    ).toEqual({
      ok: true,
      value: { ...textToolResult, attachments: [toolAttachment, second] },
      warnings: [warning("item.attachments.0"), warning("item.attachments.2")],
    });
  });

  it.each([7, 8, 9])(
    "bounds a result with %i references before traversal",
    (count) => {
      const attachments = Array.from({ length: count }, (_, i) => ({
        ...toolAttachment,
        id: `image-${i}`,
      }));
      expect(readAttachments(attachments)).toEqual(
        count <= 8
          ? { ok: true, value: { ...textToolResult, attachments } }
          : {
              ok: true,
              value: textToolResult,
              warnings: [warning("item.attachments")],
            },
      );
    },
  );

  it.each([
    ["sizeBytes", 1, true],
    ["sizeBytes", 8_388_607, true],
    ["sizeBytes", 8_388_608, true],
    ["sizeBytes", 8_388_609, false],
    ["width", 1, true],
    ["width", 7_999, true],
    ["width", 8_000, true],
    ["width", 8_001, false],
    ["height", 1, true],
    ["height", 7_999, true],
    ["height", 8_000, true],
    ["height", 8_001, false],
  ] as const)("%s at %i: valid %s", (field, number, valid) => {
    const attachment = { ...toolAttachment, [field]: number };
    expect(readAttachments([attachment])).toEqual(
      valid
        ? { ok: true, value: { ...textToolResult, attachments: [attachment] } }
        : {
            ok: true,
            value: { ...textToolResult, attachments: [] },
            warnings: [warning("item.attachments.0")],
          },
    );
  });

  it.each([
    [3_999, 4_001, 15_999_999],
    [4_000, 4_000, 16_000_000],
    [4_001, 4_000, 16_004_000],
  ])(
    "bounds dimensions %i × %i (%i pixels) independently of sides",
    (width, height, pixels) => {
      expect(width * height).toBe(pixels);
      const decoded = readAttachments([{ ...toolAttachment, width, height }]);
      expect(decoded.ok && decoded.value).toMatchObject({
        ...textToolResult,
        attachments:
          pixels <= 16_000_000 ? [{ ...toolAttachment, width, height }] : [],
      });
    },
  );

  it.each(["sizeBytes", "width", "height"])(
    "requires a safe positive integer for %s",
    (field) => {
      for (const number of [
        undefined,
        null,
        "1",
        0,
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(
          readAttachments([{ ...toolAttachment, [field]: number }]),
        ).toEqual({
          ok: true,
          value: { ...textToolResult, attachments: [] },
          warnings: [warning("item.attachments.0")],
        });
      }
    },
  );

  it.each([254, 255, 256])(
    "reuses the existing MIME bound at %i code units",
    (length) => {
      const attachment = {
        ...toolAttachment,
        mimeType: `image/${"x".repeat(length - 6)}`,
      };
      const decoded = readAttachments([attachment]);
      expect(decoded.ok && decoded.value).toMatchObject({
        attachments:
          length <= EXECUTION_TOOL_ATTACHMENT_MIME_TYPE_MAX_LENGTH
            ? [attachment]
            : [],
      });
    },
  );

  it("does not impose new ID/name length caps or deduplicate references", () => {
    const attachment = {
      ...toolAttachment,
      id: "x".repeat(256),
      name: "n".repeat(256),
    };
    expect(readAttachments([attachment, attachment])).toEqual({
      ok: true,
      value: { ...textToolResult, attachments: [attachment, attachment] },
    });
  });

  it.each(["id", "name", "mimeType"])(
    "requires a non-empty string for %s",
    (field) => {
      for (const value of [undefined, null, "", 1, [], {}]) {
        expect(
          readAttachments([{ ...toolAttachment, [field]: value }]),
        ).toMatchObject({
          ok: true,
          value: { ...textToolResult, attachments: [] },
          warnings: [warning("item.attachments.0")],
        });
      }
    },
  );

  it.each([
    ["id", "https://host/image"],
    ["id", "/tmp/image"],
    ["id", "../image"],
    ["name", "/tmp/screen.png"],
    ["name", "C:\\images\\screen.png"],
    ["name", "screen\n.png"],
    ["mimeType", "text/plain"],
    ["mimeType", "image/"],
    ["mimeType", "image/png;base64"],
    ["mimeType", "image/png\n"],
  ])(
    "drops transport/path metadata or a non-image token in %s: %j",
    (field, value) => {
      expect(
        readAttachments([{ ...toolAttachment, [field]: value }]),
      ).toMatchObject({
        ok: true,
        value: { ...textToolResult, attachments: [] },
        warnings: [warning("item.attachments.0")],
      });
    },
  );

  it("keeps required fields strict even when the optional images are valid", () => {
    for (const field of ["toolName", "relatedItemId", "outputText"]) {
      expect(
        decodeExecutionConversationItem({
          ...imageToolResult,
          [field]: undefined,
        }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
      expect(
        decodeExecutionConversationItem({ ...imageToolResult, [field]: 42 }),
      ).toEqual({ ok: false, reason: "invalid-payload" });
    }
  });

  it("preserves all fields on item.add and replay encoding", () => {
    const envelope = toolResultEnvelope(imageToolResult);
    const decoded = decodeExecutionEventEnvelope(JSON.stringify(envelope));
    expect(decoded).toEqual({ ok: true, value: envelope });
    if (!decoded.ok) throw new Error("expected a decoded event");
    expect(
      decodeExecutionEventEnvelope(encodeExecutionEventEnvelope(decoded.value)),
    ).toEqual(decoded);
  });

  it("does not allow a patch to change image references or omission counts", () => {
    const references: ExecutionConversationItemPatch = {
      // @ts-expect-error References are immutable, excluded from the patch union.
      attachments: [toolAttachment],
    };
    const omissions: ExecutionConversationItemPatch = {
      // @ts-expect-error Omission metadata is fixed when the item is added too.
      attachmentOmissions: { "turn-limit": 1 },
    };
    expect(
      decodeExecutionEventEnvelope(
        JSON.stringify({
          ...toolResultEnvelope(textToolResult),
          event: {
            kind: "delta",
            delta: {
              kind: "conversation.item.patch",
              itemId: textToolResult.id,
              patch: {
                ...references,
                ...omissions,
                outputText: "[image]\nupdated",
              },
            },
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        event: { delta: { patch: { outputText: "[image]\nupdated" } } },
      },
    });
    const decoded = decodeExecutionEventEnvelope(
      JSON.stringify({
        ...toolResultEnvelope(textToolResult),
        event: {
          kind: "delta",
          delta: {
            kind: "conversation.item.patch",
            itemId: textToolResult.id,
            patch: { ...references, ...omissions },
          },
        },
      }),
    );
    expect(decoded.ok && decoded.value.event).toEqual({
      kind: "delta",
      delta: {
        kind: "conversation.item.patch",
        itemId: textToolResult.id,
        patch: {},
      },
    });
  });

  it("publishes the owner-approved budgets without enforcing host state", () => {
    expect([
      EXECUTION_TOOL_ATTACHMENT_MAX_BYTES,
      EXECUTION_TOOL_ATTACHMENT_MAX_PIXELS,
      EXECUTION_TOOL_ATTACHMENT_MAX_SIDE,
      EXECUTION_TOOL_ATTACHMENTS_MAX_COUNT,
      EXECUTION_TOOL_ATTACHMENTS_MAX_TURN_BYTES,
      EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_COUNT,
      EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_BYTES,
      EXECUTION_TOOL_ATTACHMENTS_MAX_SESSION_PREVIEW_BYTES,
      EXECUTION_TOOL_ATTACHMENT_MAX_RENDITION_BYTES,
    ]).toEqual([
      8_388_608, 16_000_000, 8_000, 8, 67_108_864, 100, 335_544_320,
      167_772_160, 2_097_152,
    ]);
  });
});

describe("bounded omission counts", () => {
  const read = (attachmentOmissions: unknown) =>
    decodeExecutionConversationItem({ ...textToolResult, attachmentOmissions });

  it("accepts each fixed code with a count representable exactly as a safe integer", () => {
    expect(read({})).toEqual({
      ok: true,
      value: { ...textToolResult, attachmentOmissions: {} },
    });
    for (const code of EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES) {
      for (const count of [
        0,
        1,
        65_536,
        Number.MAX_SAFE_INTEGER - 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        expect(read({ [code]: count })).toEqual({
          ok: true,
          value: { ...textToolResult, attachmentOmissions: { [code]: count } },
        });
      }
    }
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    null,
    "1",
    {},
    [],
  ])("drops bad count %j independently of images and other counts", (count) => {
    expect(
      decodeExecutionConversationItem({
        ...imageToolResult,
        attachmentOmissions: { "turn-limit": count, "storage-failed": 1 },
      }),
    ).toEqual({
      ok: true,
      value: {
        ...imageToolResult,
        attachmentOmissions: { "storage-failed": 1 },
      },
      warnings: [warning("item.attachmentOmissions.turn-limit")],
    });
  });

  it.each([null, [], "error", 1])(
    "drops an invalid map %j while keeping valid images",
    (attachmentOmissions) => {
      expect(
        decodeExecutionConversationItem({
          ...imageToolResult,
          attachmentOmissions,
        }),
      ).toEqual({
        ok: true,
        value: { ...textToolResult, attachments: [toolAttachment] },
        warnings: [warning("item.attachmentOmissions")],
      });
    },
  );

  it("ignores unknown codes and arbitrary error strings with bounded warnings", () => {
    const unknowns = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        `error-${index}`,
        "private provider failure",
      ]),
    );
    expect(read({ ...unknowns, "turn-limit": 1 })).toEqual({
      ok: true,
      value: { ...textToolResult, attachmentOmissions: { "turn-limit": 1 } },
    });
    const allBad = Object.fromEntries(
      EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES.map((code) => [code, "error"]),
    );
    expect(read(allBad)).toEqual({
      ok: true,
      value: { ...textToolResult, attachmentOmissions: {} },
      warnings: EXECUTION_TOOL_ATTACHMENT_OMISSION_CODES.map((code) =>
        warning(`item.attachmentOmissions.${code}`),
      ),
    });
  });
});

describe("published 0.17/0.22 reader compatibility recordings", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/tool-attachments-older-readers.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  it("old readers retain required text and ignore new optional fields", () => {
    expect(fixture.input.item).toEqual(imageToolResult);
    for (const version of ["0.17.0", "0.22.0"]) {
      expect(fixture.readers[version].item).toEqual({
        ok: true,
        value: textToolResult,
      });
      expect(fixture.readers[version].event).toEqual({
        ok: true,
        value: toolResultEnvelope(textToolResult),
      });
    }
  });

  it("new readers retain both metadata and text from the same inputs", () => {
    expect(decodeExecutionConversationItem(fixture.input.item)).toEqual({
      ok: true,
      value: imageToolResult,
    });
    expect(
      decodeExecutionEventEnvelope(JSON.stringify(fixture.input.event)),
    ).toEqual({ ok: true, value: toolResultEnvelope(imageToolResult) });
    expect(
      decodeExecutionConversationItem(fixture.readers["0.17.0"].item.value),
    ).toEqual({ ok: true, value: textToolResult });
    expect(
      decodeExecutionConversationItem(fixture.readers["0.22.0"].item.value),
    ).toEqual({ ok: true, value: textToolResult });
  });
});
