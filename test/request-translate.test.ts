/**
 * Tests for request shape translators.
 */

import { describe, it, expect } from "bun:test";
import {
  anthropicToAnthropic,
  anthropicToOpenAIChat,
  chatToOpenAIChat,
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

describe("anthropicToOpenAIChat", () => {
  it("converts simple message — user content becomes user message", () => {
    const result = anthropicToOpenAIChat(simpleAnthropicReq, "gpt-5.1-2025-11-13");
    expect(result.model).toBe("gpt-5.1-2025-11-13");
    // Anthropic max_tokens maps to OpenAI max_completion_tokens for GPT-5.
    expect(result.max_completion_tokens).toBe(1024);
    expect(result.max_tokens).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("Hello, world!");
  });

  it("extracts system field as leading system message", () => {
    const result = anthropicToOpenAIChat(multiTurnAnthropicReq, "gpt-5.1");
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are a helpful math assistant.");
    // system + 3 conversation messages
    expect(result.messages).toHaveLength(4);
  });

  it("multi-turn conversation preserves order", () => {
    const result = anthropicToOpenAIChat(multiTurnAnthropicReq, "gpt-5.1");
    // messages[0] = system, [1] = user, [2] = assistant, [3] = user
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[2].role).toBe("assistant");
    expect(result.messages[3].role).toBe("user");
  });

  it("converts tool_use blocks to tool_calls on assistant message", () => {
    const result = anthropicToOpenAIChat(toolAnthropicReq, "gpt-5.1");
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.tool_calls).toHaveLength(1);
    expect(assistantMsg!.tool_calls![0].id).toBe("tool_123");
    expect(assistantMsg!.tool_calls![0].function.name).toBe("get_weather");
    expect(assistantMsg!.tool_calls![0].function.arguments).toBe(
      JSON.stringify({ city: "Paris" })
    );
  });

  it("converts tool_result blocks to tool role messages", () => {
    const result = anthropicToOpenAIChat(toolAnthropicReq, "gpt-5.1");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("tool_123");
    expect(toolMsg!.content).toBe("Sunny, 22°C");
  });

  it("converts tools to OpenAI function format", () => {
    const result = anthropicToOpenAIChat(toolAnthropicReq, "gpt-5.1");
    expect(result.tools).toHaveLength(1);
    expect(result.tools![0].type).toBe("function");
    expect(result.tools![0].function.name).toBe("get_weather");
    expect(result.tools![0].function.parameters).toEqual(
      toolAnthropicReq.tools![0].input_schema
    );
  });

  it("converts tool_choice auto -> 'auto'", () => {
    const result = anthropicToOpenAIChat(toolAnthropicReq, "gpt-5.1");
    expect(result.tool_choice).toBe("auto");
  });

  it("converts tool_choice any -> 'required'", () => {
    const req = { ...toolAnthropicReq, tool_choice: { type: "any" as const } };
    const result = anthropicToOpenAIChat(req, "gpt-5.1");
    expect(result.tool_choice).toBe("required");
  });

  it("converts tool_choice tool -> {type: function, function: {name}}", () => {
    const req = {
      ...toolAnthropicReq,
      tool_choice: { type: "tool" as const, name: "get_weather" },
    };
    const result = anthropicToOpenAIChat(req, "gpt-5.1");
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("maps stop_sequences to stop", () => {
    const req: AnthropicMessagesRequest = {
      ...simpleAnthropicReq,
      stop_sequences: ["STOP", "END"],
    };
    const result = anthropicToOpenAIChat(req, "gpt-5.1");
    expect(result.stop).toEqual(["STOP", "END"]);
  });

  it("maps single stop_sequence to string stop", () => {
    const req: AnthropicMessagesRequest = {
      ...simpleAnthropicReq,
      stop_sequences: ["STOP"],
    };
    const result = anthropicToOpenAIChat(req, "gpt-5.1");
    expect(result.stop).toBe("STOP");
  });

  it("converts image blocks to image_url content parts", () => {
    const req: AnthropicMessagesRequest = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image:" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abc123",
              },
            },
          ],
        },
      ],
      max_tokens: 512,
    };
    const result = anthropicToOpenAIChat(req, "gpt-5.1");
    const userMsg = result.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string; image_url?: { url: string } }>;
    const imgPart = parts.find((p) => p.type === "image_url");
    expect(imgPart).toBeDefined();
    expect(imgPart!.image_url!.url).toBe("data:image/png;base64,abc123");
  });
});

describe("chatToOpenAIChat (model rewrite passthrough)", () => {
  it("rewrites model and passes through messages", () => {
    const result = chatToOpenAIChat(simpleChatReq, "gpt-5.1-2025-11-13");
    expect(result.model).toBe("gpt-5.1-2025-11-13");
    expect(result.messages).toEqual(simpleChatReq.messages);
  });

  it("passes through tools and tool_choice", () => {
    const result = chatToOpenAIChat(toolChatReq, "gpt-5.1-2025-11-13");
    expect(result.tools).toEqual(toolChatReq.tools);
    expect(result.tool_choice).toBe("auto");
  });

  it("maps token limit to max_completion_tokens and passes through temperature, top_p, stop, stream", () => {
    const req: ChatCompletionsRequest = {
      model: "gpt-5.1",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 256,
      stop: ["END"],
      stream: true,
    };
    const result = chatToOpenAIChat(req, "gpt-5.1-upstream");
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    // GPT-5 models reject max_tokens; must be sent as max_completion_tokens.
    expect(result.max_completion_tokens).toBe(256);
    expect(result.max_tokens).toBeUndefined();
    expect(result.stop).toEqual(["END"]);
    expect(result.stream).toBe(true);
  });

  it("prefers an explicit max_completion_tokens from the client", () => {
    const req: ChatCompletionsRequest = {
      model: "gpt-5.1",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 128,
    };
    const result = chatToOpenAIChat(req, "gpt-5.1-upstream");
    expect(result.max_completion_tokens).toBe(128);
    expect(result.max_tokens).toBeUndefined();
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

  it("extracts system prompt when system content is an array of parts", () => {
    const req: ChatCompletionsRequest = {
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "You are " },
            { type: "text", text: "helpful." },
          ],
        },
        { role: "user", content: "Hi" },
      ],
    };
    const result = chatCompletionsToAnthropic(req, "upstream");
    expect(result.system).toBe("You are helpful.");
  });

  it("drops tools entirely when tool_choice is 'none'", () => {
    const req: ChatCompletionsRequest = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", parameters: { type: "object" } },
        },
      ],
      tool_choice: "none",
    };
    const result = chatCompletionsToAnthropic(req, "upstream");
    // Anthropic has no portable "none"; the only safe mapping is to drop tools.
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });
});
