/**
 * Tests for the shared SSE line parser.
 */

import { describe, it, expect } from "bun:test";
import { parseSseLines } from "../src/codec/sse-parse.ts";

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
