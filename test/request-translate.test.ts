/**
 * Tests for request shape translators.
 */

import { describe, it, expect } from "bun:test";
import {
  anthropicToAnthropic,
  anthropicToOpenAIResponses,
  chatCompletionsToOpenAIResponses,
  chatCompletionsToAnthropic,
  type AnthropicMessagesRequest,
  type ChatCompletionsRequest,
} from "../src/codec/request-translate.ts";

// ---- Fixtures ----

const simpleAnthropicReq: AnthropicMessagesRequest = {
  model: "claude-sonnet-4-5",
  messages: [{ role: "user", content: "Hello, world!" }],
  max_tokens: 1024,
};

const multiTurnAnthropicReq: AnthropicMessagesRequest = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: "What is 2+2?" },
    { role: "assistant", content: "4" },
    { role: "user", content: "And 3+3?" },
  ],
  max_tokens: 512,
  system: "You are a helpful math assistant.",
};

const toolAnthropicReq: AnthropicMessagesRequest = {
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: "What's the weather in Paris?" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_123",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_123",
          content: "Sunny, 22°C",
        },
      ],
    },
  ],
  max_tokens: 512,
  tools: [
    {
      name: "get_weather",
      description: "Get weather for a city",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ],
  tool_choice: { type: "auto" },
};

const simpleChatReq: ChatCompletionsRequest = {
  model: "gpt-5.1",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello!" },
  ],
  max_tokens: 512,
};

const toolChatReq: ChatCompletionsRequest = {
  model: "gpt-5.1",
  messages: [
    { role: "user", content: "What's the weather?" },
    {
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
    {
      role: "tool",
      content: "Sunny, 22°C",
      tool_call_id: "call_abc",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    },
  ],
  tool_choice: "auto",
};

// ---- Tests ----

describe("anthropicToAnthropic (identity + model rewrite)", () => {
  it("rewrites model field", () => {
    const result = anthropicToAnthropic(simpleAnthropicReq, "claude-sonnet-4-5-20250929");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.messages).toEqual(simpleAnthropicReq.messages);
    expect(result.max_tokens).toBe(1024);
  });

  it("preserves all other fields", () => {
    const result = anthropicToAnthropic(multiTurnAnthropicReq, "claude-sonnet-4-5-20250929");
    expect(result.system).toBe("You are a helpful math assistant.");
    expect(result.messages).toHaveLength(3);
  });

  it("does not crash on extended thinking fields", () => {
    const withThinking = { ...simpleAnthropicReq, thinking: { type: "enabled" }, betas: ["thinking"] };
    expect(() => anthropicToAnthropic(withThinking, "upstream")).not.toThrow();
  });
});

describe("anthropicToOpenAIResponses", () => {
  it("converts simple message", () => {
    const result = anthropicToOpenAIResponses(simpleAnthropicReq, "gpt-5.1-2025-11-13");
    expect(result.model).toBe("gpt-5.1-2025-11-13");
    expect(result.max_output_tokens).toBe(1024);
    expect(Array.isArray(result.input)).toBe(true);
    const input = result.input as Array<{ type: string; role: string; content: unknown }>;
    expect(input[0].role).toBe("user");
  });

  it("includes system message when present", () => {
    const result = anthropicToOpenAIResponses(multiTurnAnthropicReq, "gpt-5.1");
    const input = result.input as Array<{ type: string; role: string }>;
    expect(input[0].role).toBe("system");
    expect(input).toHaveLength(4); // system + 3 messages
  });

  it("converts tool_choice auto -> 'auto'", () => {
    const result = anthropicToOpenAIResponses(toolAnthropicReq, "gpt-5.1");
    expect(result.tool_choice).toBe("auto");
  });

  it("converts tool_choice any -> 'required'", () => {
    const req = { ...toolAnthropicReq, tool_choice: { type: "any" as const } };
    const result = anthropicToOpenAIResponses(req, "gpt-5.1");
    expect(result.tool_choice).toBe("required");
  });

  it("converts tool_choice tool -> {type: function, name}", () => {
    const req = { ...toolAnthropicReq, tool_choice: { type: "tool" as const, name: "get_weather" } };
    const result = anthropicToOpenAIResponses(req, "gpt-5.1");
    expect(result.tool_choice).toEqual({ type: "function", name: "get_weather" });
  });

  it("converts tools correctly", () => {
    const result = anthropicToOpenAIResponses(toolAnthropicReq, "gpt-5.1");
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("get_weather");
    expect(result.tools![0].type).toBe("function");
  });

  it("converts tool_result to function_call_output", () => {
    const result = anthropicToOpenAIResponses(toolAnthropicReq, "gpt-5.1");
    const input = result.input as Array<{ type: string; call_id?: string; output?: string }>;
    const funcOutput = input.find((i) => i.type === "function_call_output");
    expect(funcOutput).toBeDefined();
    expect(funcOutput?.call_id).toBe("tool_123");
    expect(funcOutput?.output).toBe("Sunny, 22°C");
  });

  it("converts tool_use blocks to function_call items (not text placeholders)", () => {
    // Multi-turn: assistant previously made a tool call (tool_use block)
    const reqWithToolUse: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_abc",
              name: "get_weather",
              input: { city: "Paris" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_abc",
              content: "Sunny, 22°C",
            },
          ],
        },
      ],
      max_tokens: 512,
    };

    const result = anthropicToOpenAIResponses(reqWithToolUse, "gpt-5.1");
    const input = result.input as Array<{ type: string; call_id?: string; name?: string; arguments?: string; output?: string }>;

    // Should have a function_call item for the tool_use block
    const funcCall = input.find((i) => i.type === "function_call");
    expect(funcCall).toBeDefined();
    expect(funcCall?.call_id).toBe("tool_abc");
    expect(funcCall?.name).toBe("get_weather");
    // arguments should be a JSON string of the input
    expect(funcCall?.arguments).toBe(JSON.stringify({ city: "Paris" }));

    // Should NOT have any text placeholder like "[tool_use: get_weather]"
    const messageParts = input.filter((i) => i.type === "message");
    for (const part of messageParts) {
      const content = (part as { type: string; content?: unknown }).content;
      if (typeof content === "string") {
        expect(content).not.toContain("[tool_use:");
      } else if (Array.isArray(content)) {
        for (const c of content as Array<{ type: string; text?: string }>) {
          if (c.type === "output_text" || c.type === "input_text") {
            expect(c.text ?? "").not.toContain("[tool_use:");
          }
        }
      }
    }

    // Should also have function_call_output for the tool_result
    const funcOutput = input.find((i) => i.type === "function_call_output");
    expect(funcOutput).toBeDefined();
    expect(funcOutput?.call_id).toBe("tool_abc");
    expect(funcOutput?.output).toBe("Sunny, 22°C");
  });
});

describe("chatCompletionsToOpenAIResponses", () => {
  it("converts simple chat request", () => {
    const result = chatCompletionsToOpenAIResponses(simpleChatReq, "gpt-5.1-2025-11-13");
    expect(result.model).toBe("gpt-5.1-2025-11-13");
    const input = result.input as Array<{ type: string; role: string }>;
    expect(input[0].role).toBe("system");
    expect(input[1].role).toBe("user");
  });

  it("converts tool call result to function_call_output", () => {
    const result = chatCompletionsToOpenAIResponses(toolChatReq, "gpt-5.1");
    const input = result.input as Array<{ type: string; call_id?: string }>;
    const funcOutput = input.find((i) => i.type === "function_call_output");
    expect(funcOutput).toBeDefined();
    expect(funcOutput?.call_id).toBe("call_abc");
  });

  it("converts tools", () => {
    const result = chatCompletionsToOpenAIResponses(toolChatReq, "gpt-5.1");
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("get_weather");
  });

  it("converts tool_choice string", () => {
    const result = chatCompletionsToOpenAIResponses(toolChatReq, "gpt-5.1");
    expect(result.tool_choice).toBe("auto");
  });

  it("extracts assistant tool_calls into standalone function_call items, not a text placeholder", () => {
    const result = chatCompletionsToOpenAIResponses(toolChatReq, "gpt-5.1");
    const input = result.input as Array<{
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
      role?: string;
      content?: unknown;
    }>;

    const functionCall = input.find((i) => i.type === "function_call");
    expect(functionCall).toBeDefined();
    expect(functionCall?.call_id).toBe("call_abc");
    expect(functionCall?.name).toBe("get_weather");
    expect(functionCall?.arguments).toBe('{"city":"Paris"}');

    // The assistant message must NOT appear as a plain message item carrying
    // the tool call (that would mean the call_id/name/arguments were lost).
    const assistantMessageItems = input.filter(
      (i) => i.type === "message" && i.role === "assistant"
    );
    for (const item of assistantMessageItems) {
      const serialized = JSON.stringify(item.content ?? "");
      expect(serialized).not.toContain("get_weather");
      expect(serialized).not.toContain("tool_use");
    }

    // function_call must come before its corresponding function_call_output,
    // matching the actual conversation order.
    const callIndex = input.findIndex((i) => i.type === "function_call");
    const outputIndex = input.findIndex((i) => i.type === "function_call_output");
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThan(callIndex);
  });
});

describe("chatCompletionsToAnthropic", () => {
  it("converts simple chat request", () => {
    const result = chatCompletionsToAnthropic(simpleChatReq, "claude-sonnet-4-5-20250929");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
    expect(result.system).toBe("You are helpful.");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("converts tool calls in assistant message", () => {
    const result = chatCompletionsToAnthropic(toolChatReq, "claude-sonnet-4-5-20250929");
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const content = assistantMsg!.content as Array<{ type: string }>;
    expect(content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("converts tool result to tool_result block", () => {
    const result = chatCompletionsToAnthropic(toolChatReq, "claude-sonnet-4-5-20250929");
    const userMsgs = result.messages.filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    const content = lastUser.content as Array<{ type: string; tool_use_id?: string }>;
    expect(content.some((b) => b.type === "tool_result")).toBe(true);
    const tr = content.find((b) => b.type === "tool_result");
    expect(tr?.tool_use_id).toBe("call_abc");
  });

  it("converts tools to Anthropic format", () => {
    const result = chatCompletionsToAnthropic(toolChatReq, "claude-sonnet-4-5-20250929");
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].name).toBe("get_weather");
    expect(result.tools![0].input_schema).toBeDefined();
  });

  it("handles multi-turn conversation", () => {
    const multiTurn: ChatCompletionsRequest = {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
    };
    const result = chatCompletionsToAnthropic(multiTurn, "claude-sonnet-4-5-20250929");
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("user");
  });

  it("does not crash on null content", () => {
    const req: ChatCompletionsRequest = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "assistant", content: null }],
    };
    expect(() => chatCompletionsToAnthropic(req, "upstream")).not.toThrow();
  });
});
