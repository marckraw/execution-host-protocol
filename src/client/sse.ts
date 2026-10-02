/** One Server-Sent Events frame: its `id:`, its `event:` name, and its data. */
export interface SseFrame {
  /** The frame's `id:` — on an envelope frame, the envelope's `seq`. */
  id: string | null;
  /** The frame's name; null for the default, unnamed one. */
  event: string | null;
  data: string;
}

/** The default cap on one frame: 16 MiB of text, data lines and all. */
export const DEFAULT_MAX_SSE_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * An incremental text/event-stream parser. Feed it decoded text in arrival
 * order, cut anywhere, and it returns each frame once the blank line that ends
 * it has arrived. Comments (a host's `: keep-alive`) and fields it does not
 * know are skipped; several `data:` lines join with newlines; a line may end
 * in LF or CRLF. A frame without data is no frame, and a frame the stream
 * ended in the middle of is never returned — per the specification, it was
 * never finished.
 */
export function createSseParser(
  options: {
    /**
     * The most text one frame may hold, data lines and the line still
     * arriving included. Past it, `feed` throws a `RangeError` rather than
     * buffer a host that never ends its line. Default 16 MiB.
     */
    maxFrameLength?: number;
  } = {},
): { feed(chunk: string): SseFrame[] } {
  const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_SSE_FRAME_LENGTH;
  /**
   * The line still arriving, kept as the pieces it came in. Joined only when
   * its line break comes: appending to one string and searching it on every
   * chunk made a long line cost the square of its length, because each
   * search flattened everything appended so far.
   */
  let pending: string[] = [];
  let pendingLength = 0;
  let data: string[] = [];
  /** The length of the data lines the current frame holds so far. */
  let dataLength = 0;
  let id: string | null = null;
  let event: string | null = null;
  let started = false;

  const takeLine = (line: string, frames: SseFrame[]) => {
    if (line === "") {
      if (data.length > 0) frames.push({ id, event, data: data.join("\n") });
      data = [];
      dataLength = 0;
      id = null;
      event = null;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "data") {
      data.push(value);
      dataLength += value.length + 1;
    } else if (field === "id") id = value;
    else if (field === "event") event = value;
  };

  return {
    feed(text) {
      let chunk = text;
      if (!started && chunk.length > 0) {
        started = true;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      const frames: SseFrame[] = [];
      let end = chunk.indexOf("\n");
      if (end === -1) {
        if (chunk.length > 0) {
          pending.push(chunk);
          pendingLength += chunk.length;
        }
      } else {
        // The unfinished line ends in this chunk: join it once, here.
        const first = pending.join("") + chunk.slice(0, end);
        pending = [];
        pendingLength = 0;
        takeLine(first.replace(/\r$/, ""), frames);
        let start = end + 1;
        end = chunk.indexOf("\n", start);
        while (end !== -1) {
          takeLine(chunk.slice(start, end).replace(/\r$/, ""), frames);
          start = end + 1;
          end = chunk.indexOf("\n", start);
        }
        if (start < chunk.length) {
          pending.push(chunk.slice(start));
          pendingLength = chunk.length - start;
        }
      }
      // Checked once per chunk: what one chunk brings is already in memory,
      // and the frame it belongs to — finished lines and the unfinished one
      // alike — may not grow past the cap across chunks.
      if (dataLength + pendingLength > maxFrameLength) {
        throw tooLong(maxFrameLength);
      }
      return frames;
    },
  };
}

function tooLong(maxFrameLength: number): RangeError {
  return new RangeError(
    `an event-stream frame grew past ${maxFrameLength} characters`,
  );
}
