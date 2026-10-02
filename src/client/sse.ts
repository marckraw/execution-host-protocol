/** One Server-Sent Events frame: its `id:`, its `event:` name, and its data. */
export interface SseFrame {
  /** The frame's `id:` — on an envelope frame, the envelope's `seq`. */
  id: string | null;
  /** The frame's name; null for the default, unnamed one. */
  event: string | null;
  data: string;
}

/**
 * An incremental text/event-stream parser. Feed it decoded text in arrival
 * order, cut anywhere, and it returns each frame once the blank line that ends
 * it has arrived. Comments (a host's `: keep-alive`) and fields it does not
 * know are skipped; several `data:` lines join with newlines; a line may end
 * in LF or CRLF. A frame without data is no frame, and a frame the stream
 * ended in the middle of is never returned — per the specification, it was
 * never finished.
 */
export function createSseParser(): { feed(chunk: string): SseFrame[] } {
  let buffer = "";
  let data: string[] = [];
  let id: string | null = null;
  let event: string | null = null;
  let started = false;

  return {
    feed(chunk) {
      buffer += chunk;
      if (!started && buffer.length > 0) {
        started = true;
        if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      }
      const frames: SseFrame[] = [];
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");

        if (line === "") {
          if (data.length > 0)
            frames.push({ id, event, data: data.join("\n") });
          data = [];
          id = null;
          event = null;
          continue;
        }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "data") data.push(value);
        else if (field === "id") id = value;
        else if (field === "event") event = value;
      }
      return frames;
    },
  };
}
