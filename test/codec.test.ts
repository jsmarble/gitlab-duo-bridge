/**
 * Tests for codec modules: decoders and encoders.
 */

import { describe, it, expect } from "bun:test";
import {
  decodeAnthropicStream,
  decodeAnthropicJSON,
} from "../src/codec/anthropic-decode.ts";
import {
  decodeOpenAIChatStream,
  decodeOpenAIChatJSON,
} from "../src/codec/openai-chat-decode.ts";
import {
  encodeAnthropicSSE,
  encodeAnthropicJSON,
} from "../src/codec/anthropic-encode.ts";
import {
  encodeOpenAIChatSSE,
  encodeOpenAIChatJSON,
} from "../src/codec/openai-chat-encode.ts";
import type { InternalEvent } from "../src/events.ts";

// ---- Helpers ----

function makeStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectEvents(
  gen: AsyncIterable<InternalEvent>
): Promise<InternalEvent[]> {
  const events: InternalEvent[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

// ---- Canned Anthropic SSE stream ----

const ANTHROPIC_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

`;

// ---- Canned OpenAI Chat Completions SSE stream (text) ----

const OPENAI_CHAT_SSE = `data: {"id":"chatcmpl-01","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-01","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-01","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"content":", world!"},"finish_reason":null}]}

data: {"id":"chatcmpl-01","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-01","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}

data: [DONE]

`;

// ---- Canned OpenAI Chat Completions SSE stream (tool calls) ----
// Note: JSON-encoded argument fragments use \\\" to produce \" in the string,
// which is then a valid JSON-escaped quote inside the outer JSON data payload.

const OPENAI_CHAT_TOOL_SSE = `data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_def","type":"function","function":{"name":"get_time","arguments":""}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Paris\\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"tz\\":\\"UTC\\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-02","object":"chat.completion.chunk","created":1700000000,"model":"gpt-5.1-2025-11-13","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

`;

// ---- Tests: Anthropic SSE decoder ----

describe("decodeAnthropicStream", () => {
  it("emits start event with model and id", async () => {
    const events = await collectEvents(
      decodeAnthropicStream(makeStream(ANTHROPIC_SSE))
    );
    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    if (start?.type === "start") {
      expect(start.model).toBe("claude-sonnet-4-5-20250929");
      expect(start.id).toBe("msg_01");
    }
  });

  it("emits text_delta events", async () => {
    const events = await collectEvents(
      decodeAnthropicStream(makeStream(ANTHROPIC_SSE))
    );
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    if (textDeltas[0].type === "text_delta") expect(textDeltas[0].text).toBe("Hello");
    if (textDeltas[1].type === "text_delta") expect(textDeltas[1].text).toBe(", world!");
  });

  it("emits stop event with reason 'stop'", async () => {
    const events = await collectEvents(
      decodeAnthropicStream(makeStream(ANTHROPIC_SSE))
    );
    const stop = events.find((e) => e.type === "stop");
    expect(stop).toBeDefined();
    if (stop?.type === "stop") expect(stop.reason).toBe("stop");
  });

  it("emits usage event", async () => {
    const events = await collectEvents(
      decodeAnthropicStream(makeStream(ANTHROPIC_SSE))
    );
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") expect(usage.inputTokens).toBe(10);
  });
});

// ---- Tests: OpenAI Chat Completions SSE decoder ----

describe("decodeOpenAIChatStream", () => {
  it("emits start event with model and id", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_SSE))
    );
    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    if (start?.type === "start") {
      expect(start.model).toBe("gpt-5.1-2025-11-13");
      expect(start.id).toBe("chatcmpl-01");
    }
  });

  it("emits text_delta events", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_SSE))
    );
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    if (textDeltas[0].type === "text_delta") expect(textDeltas[0].text).toBe("Hello");
    if (textDeltas[1].type === "text_delta") expect(textDeltas[1].text).toBe(", world!");
  });

  it("emits stop event with reason 'stop'", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_SSE))
    );
    const stop = events.find((e) => e.type === "stop");
    expect(stop).toBeDefined();
    if (stop?.type === "stop") expect(stop.reason).toBe("stop");
  });

  it("emits usage event from trailing usage chunk", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_SSE))
    );
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.inputTokens).toBe(8);
      expect(usage.outputTokens).toBe(4);
    }
  });

  it("emits tool_call_start with correct id and name for each distinct index", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_TOOL_SSE))
    );
    const toolStarts = events.filter((e) => e.type === "tool_call_start");
    expect(toolStarts).toHaveLength(2);

    const start0 = toolStarts.find(
      (e) => e.type === "tool_call_start" && e.index === 0
    );
    expect(start0).toBeDefined();
    if (start0?.type === "tool_call_start") {
      expect(start0.id).toBe("call_abc");
      expect(start0.name).toBe("get_weather");
    }

    const start1 = toolStarts.find(
      (e) => e.type === "tool_call_start" && e.index === 1
    );
    expect(start1).toBeDefined();
    if (start1?.type === "tool_call_start") {
      expect(start1.id).toBe("call_def");
      expect(start1.name).toBe("get_time");
    }
  });

  it("emits tool_call_delta events for argument fragments", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_TOOL_SSE))
    );
    const deltas = events.filter((e) => e.type === "tool_call_delta");
    expect(deltas.length).toBeGreaterThan(0);

    // Check index 0 deltas accumulate the weather args
    const deltas0 = deltas.filter(
      (e) => e.type === "tool_call_delta" && e.index === 0
    );
    const accumulated0 = deltas0
      .map((e) => (e.type === "tool_call_delta" ? e.argsDelta : ""))
      .join("");
    expect(accumulated0).toContain("Paris");

    // Check index 1 deltas
    const deltas1 = deltas.filter(
      (e) => e.type === "tool_call_delta" && e.index === 1
    );
    expect(deltas1.length).toBeGreaterThan(0);
  });

  it("synthesizes tool_call_end for each started tool call at finish_reason", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_TOOL_SSE))
    );
    const toolEnds = events.filter((e) => e.type === "tool_call_end");
    // Two tool calls started -> two ends synthesized
    expect(toolEnds).toHaveLength(2);
    const endIndices = toolEnds.map((e) =>
      e.type === "tool_call_end" ? e.index : -1
    );
    expect(endIndices).toContain(0);
    expect(endIndices).toContain(1);
  });

  it("emits stop event with reason 'tool_calls'", async () => {
    const events = await collectEvents(
      decodeOpenAIChatStream(makeStream(OPENAI_CHAT_TOOL_SSE))
    );
    const stop = events.find((e) => e.type === "stop");
    expect(stop).toBeDefined();
    if (stop?.type === "stop") expect(stop.reason).toBe("tool_calls");
  });
});

// ---- Tests: Anthropic JSON decoder ----

describe("decodeAnthropicJSON", () => {
  it("decodes text response", () => {
    const response = {
      id: "msg_01",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const events = Array.from(decodeAnthropicJSON(response));
    expect(events.some((e) => e.type === "start")).toBe(true);
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "stop")).toBe(true);
  });

  it("decodes tool_use response", () => {
    const response = {
      id: "msg_02",
      model: "claude-sonnet-4-5-20250929",
      content: [
        {
          type: "tool_use",
          id: "tool_123",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const events = Array.from(decodeAnthropicJSON(response));
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_end")).toBe(true);
    const stop = events.find((e) => e.type === "stop");
    if (stop?.type === "stop") expect(stop.reason).toBe("tool_calls");
  });
});

// ---- Tests: OpenAI Chat JSON decoder ----

describe("decodeOpenAIChatJSON", () => {
  it("decodes text response", () => {
    const response = {
      id: "chatcmpl-01",
      model: "gpt-5.1-2025-11-13",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };
    const events = Array.from(decodeOpenAIChatJSON(response));
    const start = events.find((e) => e.type === "start");
    expect(start).toBeDefined();
    if (start?.type === "start") {
      expect(start.id).toBe("chatcmpl-01");
      expect(start.model).toBe("gpt-5.1-2025-11-13");
    }
    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta).toBeDefined();
    if (textDelta?.type === "text_delta") expect(textDelta.text).toBe("Hello!");
    const stop = events.find((e) => e.type === "stop");
    expect(stop).toBeDefined();
    if (stop?.type === "stop") expect(stop.reason).toBe("stop");
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.inputTokens).toBe(5);
      expect(usage.outputTokens).toBe(3);
    }
  });

  it("decodes tool_calls response", () => {
    const response = {
      id: "chatcmpl-02",
      model: "gpt-5.1-2025-11-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const events = Array.from(decodeOpenAIChatJSON(response));
    const toolStart = events.find((e) => e.type === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.type === "tool_call_start") {
      expect(toolStart.id).toBe("call_abc");
      expect(toolStart.name).toBe("get_weather");
      expect(toolStart.index).toBe(0);
    }
    const toolDelta = events.find((e) => e.type === "tool_call_delta");
    expect(toolDelta).toBeDefined();
    if (toolDelta?.type === "tool_call_delta") {
      expect(toolDelta.argsDelta).toBe('{"city":"Paris"}');
    }
    const toolEnd = events.find((e) => e.type === "tool_call_end");
    expect(toolEnd).toBeDefined();
    const stop = events.find((e) => e.type === "stop");
    if (stop?.type === "stop") expect(stop.reason).toBe("tool_calls");
  });
});

// ---- Tests: Anthropic SSE encoder ----

describe("encodeAnthropicSSE", () => {
  it("produces valid SSE with message_start and message_stop", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "claude-sonnet-4-5-20250929", id: "msg_01" };
      yield { type: "text_delta", text: "Hello!" };
      yield { type: "stop", reason: "stop" };
    }

    const stream = encodeAnthropicSSE(events());
    const text = await readStream(stream);

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"text":"Hello!"');
  });

  it("includes stop_reason in message_delta", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "m", id: "id" };
      yield { type: "stop", reason: "length" };
    }
    const stream = encodeAnthropicSSE(events());
    const text = await readStream(stream);
    expect(text).toContain('"stop_reason":"max_tokens"');
  });

  it("assigns distinct monotonically-increasing content_block indices for text + two tool calls", async () => {
    // This is the case the old formula got wrong:
    // text block gets index 0, tool call 0 gets index 1, tool call 1 gets index 2
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "m", id: "id" };
      yield { type: "text_delta", text: "Thinking..." };
      yield { type: "tool_call_start", id: "call_1", name: "tool_one", index: 0 };
      yield { type: "tool_call_delta", id: "call_1", argsDelta: '{"a":1}', index: 0 };
      yield { type: "tool_call_end", id: "call_1", index: 0 };
      yield { type: "tool_call_start", id: "call_2", name: "tool_two", index: 1 };
      yield { type: "tool_call_delta", id: "call_2", argsDelta: '{"b":2}', index: 1 };
      yield { type: "tool_call_end", id: "call_2", index: 1 };
      yield { type: "stop", reason: "tool_calls" };
    }

    const stream = encodeAnthropicSSE(events());
    const text = await readStream(stream);

    // Extract all content_block_start events and their indices
    const sseLines = text.split("\n");
    const blockStartIndices: number[] = [];
    let currentEvent = "";
    for (const line of sseLines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEvent === "content_block_start") {
        const data = JSON.parse(line.slice(6)) as { index: number };
        blockStartIndices.push(data.index);
        currentEvent = "";
      }
    }

    // Should have 3 content_block_start events: text(0), tool_one(1), tool_two(2)
    expect(blockStartIndices).toHaveLength(3);
    expect(blockStartIndices[0]).toBe(0); // text block
    expect(blockStartIndices[1]).toBe(1); // first tool call
    expect(blockStartIndices[2]).toBe(2); // second tool call

    // Also verify the deltas use the correct indices
    const deltaIndices: number[] = [];
    let currentEventForDelta = "";
    for (const line of sseLines) {
      if (line.startsWith("event: ")) {
        currentEventForDelta = line.slice(7).trim();
      } else if (line.startsWith("data: ") && currentEventForDelta === "content_block_delta") {
        const data = JSON.parse(line.slice(6)) as { index: number };
        deltaIndices.push(data.index);
        currentEventForDelta = "";
      }
    }
    // text delta at 0, tool_one delta at 1, tool_two delta at 2
    expect(deltaIndices).toContain(0);
    expect(deltaIndices).toContain(1);
    expect(deltaIndices).toContain(2);
  });
});

// ---- Tests: Anthropic JSON encoder ----

describe("encodeAnthropicJSON", () => {
  it("produces correct response shape", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "claude-sonnet-4-5-20250929", id: "msg_01" };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
      yield { type: "text_delta", text: "Hello, world!" };
      yield { type: "stop", reason: "stop" };
    }

    const result = await encodeAnthropicJSON(events());
    expect(result.id).toBe("msg_01");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello, world!" });
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });
});

// ---- Tests: OpenAI Chat SSE encoder ----

describe("encodeOpenAIChatSSE", () => {
  it("produces valid SSE with [DONE] terminator", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-01" };
      yield { type: "text_delta", text: "Hello!" };
      yield { type: "stop", reason: "stop" };
    }

    const stream = encodeOpenAIChatSSE(events());
    const text = await readStream(stream);

    expect(text).toContain("data: {");
    expect(text).toContain("data: [DONE]");
    expect(text).toContain('"Hello!"');
    expect(text).toContain('"finish_reason":"stop"');
  });

  it("includes tool_calls in delta", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-02" };
      yield { type: "tool_call_start", id: "call_abc", name: "get_weather", index: 0 };
      yield { type: "tool_call_delta", id: "call_abc", argsDelta: '{"city":"Paris"}', index: 0 };
      yield { type: "tool_call_end", id: "call_abc", index: 0 };
      yield { type: "stop", reason: "tool_calls" };
    }

    const stream = encodeOpenAIChatSSE(events());
    const text = await readStream(stream);
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"get_weather"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it("does NOT emit [DONE] when the event iterable throws", async () => {
    async function* throwingEvents(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-err" };
      yield { type: "text_delta", text: "partial" };
      throw new Error("upstream exploded");
    }

    const stream = encodeOpenAIChatSSE(throwingEvents());
    const text = await readStream(stream);

    // Should contain an error event
    expect(text).toContain('"error"');
    expect(text).toContain("upstream exploded");
    // Must NOT contain [DONE] — client should not think stream completed successfully
    expect(text).not.toContain("data: [DONE]");
  });
});

// ---- Tests: OpenAI Chat JSON encoder ----

describe("encodeOpenAIChatJSON", () => {
  it("produces correct response shape", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-01" };
      yield { type: "usage", inputTokens: 8, outputTokens: 4 };
      yield { type: "text_delta", text: "Hello!" };
      yield { type: "stop", reason: "stop" };
    }

    const result = await encodeOpenAIChatJSON(events());
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gpt-5.1");
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].message.content).toBe("Hello!");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(8);
    expect(result.usage.completion_tokens).toBe(4);
  });

  it("produces tool_calls in message", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-02" };
      yield { type: "tool_call_start", id: "call_abc", name: "get_weather", index: 0 };
      yield { type: "tool_call_delta", id: "call_abc", argsDelta: '{"city":"Paris"}', index: 0 };
      yield { type: "tool_call_end", id: "call_abc", index: 0 };
      yield { type: "stop", reason: "tool_calls" };
    }

    const result = await encodeOpenAIChatJSON(events());
    expect(result.choices[0].message.content).toBeNull();
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].function.name).toBe("get_weather");
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves text content alongside tool calls (does not drop leading text)", async () => {
    async function* events(): AsyncGenerator<InternalEvent> {
      yield { type: "start", model: "gpt-5.1", id: "chatcmpl-03" };
      yield { type: "text_delta", text: "Let me check that for you." };
      yield { type: "tool_call_start", id: "call_xyz", name: "get_weather", index: 0 };
      yield { type: "tool_call_delta", id: "call_xyz", argsDelta: '{"city":"Paris"}', index: 0 };
      yield { type: "tool_call_end", id: "call_xyz", index: 0 };
      yield { type: "stop", reason: "tool_calls" };
    }

    const result = await encodeOpenAIChatJSON(events());
    // Text must survive when tool calls are also present.
    expect(result.choices[0].message.content).toBe("Let me check that for you.");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
  });
});
