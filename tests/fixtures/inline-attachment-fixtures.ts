import type { ExecutionInlineAttachment } from "../../src/index.js";

export const MiB = 1024 * 1024;

const base64Of = new Map<number, string>();

/** An attachment that decodes to exactly `sizeBytes` bytes (MAR-3783). */
export function inlineAttachment(
  kind: "image" | "file",
  sizeBytes: number,
  name = kind === "file" ? "notes.pdf" : "diagram.png",
): ExecutionInlineAttachment {
  let dataBase64 = base64Of.get(sizeBytes);
  if (dataBase64 === undefined) {
    dataBase64 = Buffer.alloc(sizeBytes, 7).toString("base64");
    base64Of.set(sizeBytes, dataBase64);
  }
  return {
    kind,
    name,
    mimeType: kind === "file" ? "application/pdf" : "image/png",
    sizeBytes,
    dataBase64,
  };
}
