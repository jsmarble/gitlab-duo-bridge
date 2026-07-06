/**
 * Shared SSE line parser.
 *
 * Parses a text chunk into SSE events (event + data pairs).
 * Per the SSE spec, multiple `data:` lines are joined with `\n`.
 * Comment lines (starting with `:`) are ignored.
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
    } else if (line.startsWith("event: ")) {
      current.event = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      const chunk = line.slice(6);
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
