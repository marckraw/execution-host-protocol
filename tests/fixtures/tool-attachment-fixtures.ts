import type {
  ExecutionConversationItem,
  ExecutionToolAttachment,
} from "../../src/index.js";
import { conversationItemFixtures } from "./contract-fixtures.js";

/** Hand-authored metadata only: no image payload or host storage involved. */
export const toolAttachment = {
  id: "image-1",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 1024,
  width: 800,
  height: 600,
} satisfies ExecutionToolAttachment;

export const textToolResult = {
  ...conversationItemFixtures["tool-result"].value,
  outputText: "before\n[image]\nafter\n",
} satisfies Extract<ExecutionConversationItem, { kind: "tool-result" }>;

export const imageToolResult = {
  ...textToolResult,
  attachments: [toolAttachment],
  attachmentOmissions: { "turn-limit": 2 },
} satisfies Extract<ExecutionConversationItem, { kind: "tool-result" }>;

export const toolResultEnvelope = (item: unknown) => ({
  protocolVersion: 1,
  sessionId: "session-1",
  seq: 1,
  event: { kind: "delta", delta: { kind: "conversation.item.add", item } },
});
