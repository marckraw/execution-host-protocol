import { describe, expect, it } from "vitest";
import { decodeExecutionSessionSnapshot } from "../../src/client/index.js";
import {
  imageToolResult,
  textToolResult,
} from "../fixtures/tool-attachment-fixtures.js";

const snapshot = (item: unknown) => ({
  protocolVersion: 1,
  sessionId: "session-1",
  providerId: "claude",
  lastSeq: 1,
  conversation: [item],
});

describe("tool image metadata in snapshots", () => {
  it("reads the same references and omissions as a replayed item.add", () => {
    const decoded = decodeExecutionSessionSnapshot(snapshot(imageToolResult));
    expect(decoded.ok && decoded.value.conversation).toEqual([imageToolResult]);
    expect(decoded).not.toHaveProperty("warnings");
  });

  it("retains valid tool text and images, remapping metadata warnings to snapshot paths", () => {
    const decoded = decodeExecutionSessionSnapshot(
      snapshot({
        ...imageToolResult,
        attachments: [
          ...imageToolResult.attachments,
          { ...imageToolResult.attachments[0], id: "bad", width: 0 },
        ],
        attachmentOmissions: { "turn-limit": 0 },
      }),
    );
    expect(decoded.ok && decoded.value.conversation).toEqual([
      { ...imageToolResult, attachmentOmissions: {} },
    ]);
    expect(decoded).toHaveProperty("warnings", [
      { reason: "dropped-invalid-field", path: "conversation.0.attachments.1" },
      {
        reason: "dropped-invalid-field",
        path: "conversation.0.attachmentOmissions.turn-limit",
      },
    ]);
  });

  it("keeps older hosts' results free of invented image fields", () => {
    const decoded = decodeExecutionSessionSnapshot(snapshot(textToolResult));
    expect(decoded.ok && decoded.value.conversation).toEqual([textToolResult]);
    expect(decoded).not.toHaveProperty("warnings");
  });
});
