/**
 * Tests for the shared SSE line parser and event reader.
 */

import { describe, it, expect } from "bun:test";
import { parseSseLines, readSseEvents } from "../src/codec/sse-parse.ts";

describe("parseSseLines", () => {
  it("returns nothing for empty input", () => {
    const results = Array.from(parseSseLines(""));
    expect(results).toHaveLength(0);
  });

  it("parses a single event with no trailing blank line", () => {
    const input = "event: message\ndata: hello";
    const results = Array.from(parseSseLines(input));
    expect(results).toHaveLength(1);
    expect(results[0].event).toBe("message");
    expect(results[0].data).toBe("hello");
  });

  it("parses multiple events in one chunk", () => {
    const input =
      "event: first\ndata: one\n\nevent: second\ndata: two\n\n";
    const results = Array.from(parseSseLines(input));
    expect(results).toHaveLength(2);
    expect(results[0].event).toBe("first");
    expect(results[0].data).toBe("one");
    expect(results[1].event).toBe("second");
    expect(results[1].data).toBe("two");
  });

  it("joins multiple data: lines with newline per SSE spec", () => {
    const input = "data: line1\ndata: line2\ndata: line3\n\n";
    const results = Array.from(parseSseLines(input));
    expect(results).toHaveLength(1);
    expect(results[0].data).toBe("line1\nline2\nline3");
  });

  it("ignores comment lines starting with ':'", () => {
    const input = ": this is a comment\nevent: ping\ndata: {}\n\n";
    const results = Array.from(parseSseLines(input));
    expect(results).toHaveLength(1);
    expect(results[0].event).toBe("ping");
    expect(results[0].data).toBe("{}");
  });

  it("ignores comment-only blocks", () => {
    const input = ": comment only\n\nevent: real\ndata: value\n\n";
    const results = Array.from(parseSseLines(input));
    // The comment-only block yields nothing; only the real event is returned
    expect(results).toHaveLength(1);
    expect(results[0].event).toBe("real");
  });

  it("parses data-only event (no event field)", () => {
    const input = "data: just data\n\n";
    const results = Array.from(parseSseLines(input));
    expect(results).toHaveLength(1);
    expect(results[0].data).toBe("just data");
    expect(results[0].event).toBeUndefined();
  });
});

describe("readSseEvents", () => {
  function makeStream(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  it("yields parsed JSON objects for each data event", async () => {
    const input =
      'data: {"type":"event1","value":1}\n\ndata: {"type":"event2","value":2}\n\n';
    const results: Record<string, unknown>[] = [];
    for await (const evt of readSseEvents(makeStream(input))) {
      results.push(evt);
    }
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("event1");
    expect(results[0].value).toBe(1);
    expect(results[1].type).toBe("event2");
    expect(results[1].value).toBe(2);
  });

  it("skips [DONE] sentinel", async () => {
    const input =
      'data: {"type":"event1"}\n\ndata: [DONE]\n\n';
    const results: Record<string, unknown>[] = [];
    for await (const evt of readSseEvents(makeStream(input))) {
      results.push(evt);
    }
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("event1");
  });

  it("skips events with unparseable JSON data", async () => {
    const input =
      'data: {"type":"good"}\n\ndata: not-valid-json\n\ndata: {"type":"also-good"}\n\n';
    const results: Record<string, unknown>[] = [];
    for await (const evt of readSseEvents(makeStream(input))) {
      results.push(evt);
    }
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("good");
    expect(results[1].type).toBe("also-good");
  });

  it("handles stream split across multiple chunks", async () => {
    const encoder = new TextEncoder();
    const part1 = 'data: {"type":"ev1"}\n\n';
    const part2 = 'data: {"type":"ev2"}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });
    const results: Record<string, unknown>[] = [];
    for await (const evt of readSseEvents(stream)) {
      results.push(evt);
    }
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("ev1");
    expect(results[1].type).toBe("ev2");
  });

  it("releases reader lock in finally even on early break", async () => {
    const input =
      'data: {"type":"first"}\n\ndata: {"type":"second"}\n\n';
    const stream = makeStream(input);
    // Break after first event — should not throw on reader lock
    for await (const _evt of readSseEvents(stream)) {
      break;
    }
    // If reader lock was not released, getReader() would throw
    expect(() => stream.getReader()).not.toThrow();
  });
});
