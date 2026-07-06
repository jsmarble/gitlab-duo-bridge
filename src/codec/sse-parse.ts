/**
 * Shared SSE line parser and event reader.
 *
 * parseSseLines: Parses a text chunk into SSE events (event + data pairs).
 * Per the SSE spec, multiple `data:` lines are joined with `\n`.
 * Comment lines (starting with `:`) are ignored.
 *
 * readSseEvents: Async generator that reads a ReadableStream<Uint8Array>,
 * buffers it, splits on double-newline SSE boundaries, parses each event's
 * data field as JSON, and yields the parsed objects. Skips empty data lines
 * and the `[DONE]` sentinel. Releases the reader lock in a finally block.
 */

export interface SseLine {
  event?: string;
  data?: string;
}

export function* parseSseLines(text: string): Generator<SseLine> {
  const lines = text.split("\n");
  let current: SseLine = {};
  for (const line of lines) {
    if (line === "") {
      if (current.data !== undefined || current.event !== undefined) {
        yield current;
        current = {};
      }
    } else if (line.startsWith(":")) {
      // Comment line — ignore per SSE spec
    } else if (line.startsWith("event:")) {
      // Per SSE spec, a single leading space after the colon is stripped.
      current.event = line.slice(6).replace(/^ /, "").trim();
    } else if (line.startsWith("data:")) {
      // Per SSE spec, a single leading space after the colon is stripped
      // (and only one — do not trim, remaining whitespace may be significant).
      const chunk = line.slice(5).replace(/^ /, "");
      // Per SSE spec, multiple data: lines are joined with \n
      if (current.data !== undefined) {
        current.data = current.data + "\n" + chunk;
      } else {
        current.data = chunk;
      }
    }
  }
  if (current.data !== undefined || current.event !== undefined) {
    yield current;
  }
}

/**
 * Read a ReadableStream<Uint8Array> as SSE events, yielding each parsed JSON
 * data payload as a Record<string, unknown>. Skips empty data and [DONE].
 * Releases the reader lock in a finally block.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE messages (separated by double newline)
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;
        for (const line of parseSseLines(part + "\n\n")) {
          if (!line.data || line.data === "[DONE]") continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          yield parsed;
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      for (const line of parseSseLines(buffer)) {
        if (!line.data || line.data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        yield parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
