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
      // What is left of the buffer holds no line break: it was all searched
      // last time, so the search resumes where the new text begins. Searching
      // from the start every time made a long line, arriving in many pieces,
      // cost the square of its length.
      let searchFrom = buffer.length;
      buffer += chunk;
      if (!started && buffer.length > 0) {
        started = true;
        if (buffer.charCodeAt(0) === 0xfeff) {
          buffer = buffer.slice(1);
          searchFrom = Math.max(0, searchFrom - 1);
        }
      }
      const frames: SseFrame[] = [];
      let start = 0;
      let end = buffer.indexOf("\n", searchFrom);
      while (end !== -1) {
        const line = buffer.slice(start, end).replace(/\r$/, "");
        start = end + 1;
        end = buffer.indexOf("\n", start);

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
      buffer = buffer.slice(start);
      return frames;
    },
  };
}
