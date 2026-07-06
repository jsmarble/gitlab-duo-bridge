/**
 * Request shape translators between Anthropic Messages, OpenAI Chat Completions,
 * and upstream formats.
 *
 * Translators:
 * 1. anthropicToAnthropic: identity with model rewrite
 * 2. anthropicToOpenAIChat: Anthropic Messages -> OpenAI Chat Completions
 * 3. chatToOpenAIChat: OpenAI Chat Completions -> OpenAI Chat Completions (model rewrite passthrough)
 * 4. chatCompletionsToAnthropic: OpenAI Chat Completions -> Anthropic Messages
 */

// ---- Shared types ----

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicMessageContent;
}

export type AnthropicMessageContent =
  | string
  | AnthropicContentBlock[];

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[] };

export interface AnthropicImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  // Extended thinking fields — ignored but must not crash
  thinking?: unknown;
  betas?: string[];
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

// ---- OpenAI Chat Completions types ----

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatTool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
}

// ---- Helper: extract system text from Anthropic system field ----

function extractSystemText(
  system: AnthropicMessagesRequest["system"]
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

// ---- Helper: flatten OpenAI Chat message content to plain text ----

function chatContentToText(content: ChatMessage["content"]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((p) => p.text ?? "").join("");
}

// ---- Translator 1: Anthropic -> Anthropic (identity with model rewrite) ----

export function anthropicToAnthropic(
  req: AnthropicMessagesRequest,
  upstreamModel: string
): AnthropicMessagesRequest {
  return { ...req, model: upstreamModel };
}

// ---- Translator 2: Anthropic Messages -> OpenAI Chat Completions ----

function anthropicContentToChatContent(
  content: AnthropicMessageContent
): string | ChatContentPart[] {
  if (typeof content === "string") return content;

  // Filter out tool_use and tool_result blocks (handled separately)
  const textAndImageBlocks = content.filter(
    (b) => b.type !== "tool_use" && b.type !== "tool_result"
  );

  if (textAndImageBlocks.length === 0) return "";

  return textAndImageBlocks.map((block): ChatContentPart => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    } else if (block.type === "image") {
      const src = block.source;
      if (src.type === "base64") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${src.media_type ?? "image/jpeg"};base64,${src.data ?? ""}`,
          },
        };
      } else {
        return { type: "image_url", image_url: { url: src.url ?? "" } };
      }
    }
    // Fallback
    return { type: "text", text: "" };
  });
}

export function anthropicToOpenAIChat(
  req: AnthropicMessagesRequest,
  upstreamModel: string
): ChatCompletionsRequest {
  const messages: ChatMessage[] = [];

  // Add system message if present
  const systemText = extractSystemText(req.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  // Convert messages
  for (const msg of req.messages) {
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        // Check for tool_use blocks -> tool_calls on assistant message
        const toolUseBlocks = content.filter((b) => b.type === "tool_use");
        const otherBlocks = content.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");

        const chatMsg: ChatMessage = { role: "assistant", content: null };

        if (otherBlocks.length > 0) {
          const converted = anthropicContentToChatContent(otherBlocks);
          if (typeof converted === "string") {
            chatMsg.content = converted || null;
          } else {
            chatMsg.content = converted.length > 0 ? converted : null;
          }
        }

        if (toolUseBlocks.length > 0) {
          chatMsg.tool_calls = toolUseBlocks
            .filter((b) => b.type === "tool_use")
            .map((b) => {
              if (b.type !== "tool_use") throw new Error("unreachable");
              return {
                id: b.id,
                type: "function" as const,
                function: {
                  name: b.name,
                  arguments: JSON.stringify(b.input),
                },
              };
            });
        }

        messages.push(chatMsg);
      } else {
        messages.push({
          role: "assistant",
          content: anthropicContentToChatContent(content),
        });
      }
    } else if (msg.role === "user") {
      const content = msg.content;
      if (Array.isArray(content)) {
        // Check for tool_result blocks -> tool role messages
        const toolResultBlocks = content.filter((b) => b.type === "tool_result");
        const otherBlocks = content.filter((b) => b.type !== "tool_result");

        // Emit one tool message per tool_result block
        for (const tr of toolResultBlocks) {
          if (tr.type !== "tool_result") continue;
          const text =
            typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
              ? tr.content
                  .map((b) => (b.type === "text" ? b.text : ""))
                  .join("")
              : "";
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: text,
          });
        }

        // Emit remaining content as user message if any
        if (otherBlocks.length > 0) {
          messages.push({
            role: "user",
            content: anthropicContentToChatContent(otherBlocks),
          });
        }
      } else {
        messages.push({
          role: "user",
          content: anthropicContentToChatContent(content),
        });
      }
    }
  }

  // Convert tools
  const tools: ChatTool[] | undefined = req.tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  // Convert tool_choice
  let toolChoice: ChatCompletionsRequest["tool_choice"] | undefined;
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") {
      toolChoice = "auto";
    } else if (req.tool_choice.type === "any") {
      toolChoice = "required";
    } else if (req.tool_choice.type === "tool") {
      toolChoice = { type: "function", function: { name: req.tool_choice.name } };
    }
  }

  const stop = req.stop_sequences
    ? req.stop_sequences.length === 1
      ? req.stop_sequences[0]
      : req.stop_sequences
    : undefined;

  return {
    model: upstreamModel,
    messages,
    stream: req.stream,
    // Ask the OpenAI proxy to include usage on the final streamed chunk.
    stream_options: req.stream ? { include_usage: true } : undefined,
    // GitLab's OpenAI (GPT-5) proxy rejects the legacy `max_tokens` param and
    // requires `max_completion_tokens`.
    max_completion_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
  };
}

// ---- Translator 3: Chat Completions -> Chat Completions (model rewrite passthrough) ----

export function chatToOpenAIChat(
  req: ChatCompletionsRequest,
  upstreamModel: string
): ChatCompletionsRequest {
  return {
    model: upstreamModel,
    messages: req.messages,
    stream: req.stream,
    // Ask the OpenAI proxy to include usage on the final streamed chunk so the
    // client sees token counts / cost (OpenAI omits usage from streams otherwise).
    stream_options: req.stream
      ? { include_usage: true, ...req.stream_options }
      : req.stream_options,
    // Normalize to max_completion_tokens (GPT-5 models reject max_tokens).
    // Accept either field from the client.
    max_completion_tokens: req.max_completion_tokens ?? req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop,
    tools: req.tools,
    tool_choice: req.tool_choice,
  };
}

// ---- Translator 4: Chat Completions -> Anthropic Messages ----

function chatContentToAnthropicContent(
  content: ChatMessage["content"]
): AnthropicMessageContent {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part): AnthropicContentBlock => {
    if (part.type === "text") {
      return { type: "text", text: part.text ?? "" };
    } else if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      if (url.startsWith("data:")) {
        // base64 data URL
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: match[1],
              data: match[2],
            },
          };
        }
      }
      return {
        type: "image",
        source: { type: "url", url },
      };
    }
    return { type: "text", text: "" };
  });
}

export function chatCompletionsToAnthropic(
  req: ChatCompletionsRequest,
  upstreamModel: string
): AnthropicMessagesRequest {
  // Extract system message (content may be a string or an array of parts)
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const systemText = systemMessages
    .map((m) => chatContentToText(m.content))
    .filter(Boolean)
    .join("\n");

  // Convert non-system messages
  const messages: AnthropicMessage[] = [];
  for (const msg of req.messages) {
    if (msg.role === "system") continue;

    if (msg.role === "tool") {
      // Tool result -> tool_result block in user message
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: chatContentToText(msg.content),
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant with tool calls -> tool_use blocks
      const content: AnthropicContentBlock[] = [];
      const text = chatContentToText(msg.content);
      if (text) content.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {
          input = tc.function.arguments;
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "user" || msg.role === "assistant") {
      messages.push({
        role: msg.role,
        content: chatContentToAnthropicContent(msg.content),
      });
    }
  }

  // Convert tools
  let tools: AnthropicTool[] | undefined = req.tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));

  // Convert tool_choice
  let toolChoice: AnthropicToolChoice | undefined;
  if (req.tool_choice) {
    if (req.tool_choice === "auto") {
      toolChoice = { type: "auto" };
    } else if (req.tool_choice === "required" || req.tool_choice === "any") {
      toolChoice = { type: "any" };
    } else if (req.tool_choice === "none") {
      // Anthropic has no portable "none" tool_choice. Dropping the tools
      // entirely is the only cross-version-safe way to guarantee no tool use.
      toolChoice = undefined;
      tools = undefined;
    } else if (typeof req.tool_choice === "object") {
      toolChoice = { type: "tool", name: req.tool_choice.function.name };
    }
  }

  const stopSequences = req.stop
    ? Array.isArray(req.stop)
      ? req.stop
      : [req.stop]
    : undefined;

  return {
    model: upstreamModel,
    messages,
    system: systemText || undefined,
    max_tokens: req.max_tokens ?? 4096,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    stop_sequences: stopSequences,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
  };
}
