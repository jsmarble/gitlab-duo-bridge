/**
 * Request shape translators between Anthropic Messages, OpenAI Chat Completions,
 * and OpenAI Responses API formats.
 *
 * Translators:
 * 1. anthropicToAnthropic: identity with model rewrite
 * 2. anthropicToOpenAIResponses: Anthropic Messages -> OpenAI Responses
 * 3. chatCompletionsToOpenAIResponses: OpenAI Chat Completions -> OpenAI Responses
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
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: ChatTool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
}

// ---- OpenAI Responses API types ----

export interface OpenAIResponsesRequest {
  model: string;
  input: OpenAIResponsesInput;
  stream?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: OpenAIResponsesTool[];
  tool_choice?: string | { type: "function"; name: string };
  truncation?: string;
}

export type OpenAIResponsesInput =
  | string
  | OpenAIResponsesInputItem[];

export type OpenAIResponsesInputItem =
  | { type: "message"; role: "user" | "assistant" | "system"; content: OpenAIResponsesContent }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export type OpenAIResponsesContent =
  | string
  | OpenAIResponsesContentPart[];

export type OpenAIResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

export interface OpenAIResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

// ---- Helper: extract system text from Anthropic system field ----

function extractSystemText(
  system: AnthropicMessagesRequest["system"]
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

// ---- Helper: convert Anthropic content to OpenAI Responses content ----

function anthropicContentToResponsesContent(
  content: AnthropicMessageContent
): OpenAIResponsesContent {
  if (typeof content === "string") return content;

  return content
    .filter((block) => block.type !== "tool_use" && block.type !== "tool_result")
    .map((block): OpenAIResponsesContentPart => {
      if (block.type === "text") {
        return { type: "input_text", text: block.text };
      } else if (block.type === "image") {
        const src = block.source;
        if (src.type === "base64") {
          return {
            type: "input_image",
            image_url: `data:${src.media_type ?? "image/jpeg"};base64,${src.data ?? ""}`,
          };
        } else {
          return { type: "input_image", image_url: src.url ?? "" };
        }
      }
      // Fallback
      return { type: "input_text", text: "" };
    });
}

// ---- Helper: convert Chat message content to Responses content ----

function chatContentToResponsesContent(
  content: ChatMessage["content"]
): OpenAIResponsesContent {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content.map((part): OpenAIResponsesContentPart => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text ?? "" };
    } else if (part.type === "image_url") {
      return {
        type: "input_image",
        image_url: part.image_url?.url ?? "",
        detail: part.image_url?.detail,
      };
    }
    return { type: "input_text", text: "" };
  });
}

// ---- Translator 1: Anthropic -> Anthropic (identity with model rewrite) ----

export function anthropicToAnthropic(
  req: AnthropicMessagesRequest,
  upstreamModel: string
): AnthropicMessagesRequest {
  return { ...req, model: upstreamModel };
}

// ---- Translator 2: Anthropic Messages -> OpenAI Responses ----

export function anthropicToOpenAIResponses(
  req: AnthropicMessagesRequest,
  upstreamModel: string
): OpenAIResponsesRequest {
  const inputItems: OpenAIResponsesInputItem[] = [];

  // Add system message if present
  const systemText = extractSystemText(req.system);
  if (systemText) {
    inputItems.push({
      type: "message",
      role: "system",
      content: systemText,
    });
  }

  // Convert messages
  for (const msg of req.messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      // Check for tool_result blocks — those become function_call_output items
      const content = msg.content;
      if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === "tool_result");
        const toolUseBlocks = content.filter((b) => b.type === "tool_use");
        const otherBlocks = content.filter(
          (b) => b.type !== "tool_result" && b.type !== "tool_use"
        );

        for (const tr of toolResults) {
          if (tr.type === "tool_result") {
            const text =
              typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                ? tr.content
                    .map((b) => (b.type === "text" ? b.text : ""))
                    .join("")
                : "";
            inputItems.push({
              type: "function_call_output",
              call_id: tr.tool_use_id,
              output: text,
            });
          }
        }

        // Convert tool_use blocks to function_call items
        for (const tu of toolUseBlocks) {
          if (tu.type === "tool_use") {
            inputItems.push({
              type: "function_call",
              call_id: tu.id,
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            });
          }
        }

        if (otherBlocks.length > 0) {
          inputItems.push({
            type: "message",
            role: msg.role,
            content: anthropicContentToResponsesContent(otherBlocks),
          });
        }
      } else {
        inputItems.push({
          type: "message",
          role: msg.role,
          content: anthropicContentToResponsesContent(content),
        });
      }
    }
  }

  // Convert tools
  const tools: OpenAIResponsesTool[] | undefined = req.tools?.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));

  // Convert tool_choice
  let toolChoice: OpenAIResponsesRequest["tool_choice"] | undefined;
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") {
      toolChoice = "auto";
    } else if (req.tool_choice.type === "any") {
      toolChoice = "required";
    } else if (req.tool_choice.type === "tool") {
      toolChoice = { type: "function", name: req.tool_choice.name };
    }
  }

  return {
    model: upstreamModel,
    input: inputItems,
    stream: req.stream,
    max_output_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
  };
}

// ---- Translator 3: Chat Completions -> OpenAI Responses ----

export function chatCompletionsToOpenAIResponses(
  req: ChatCompletionsRequest,
  upstreamModel: string
): OpenAIResponsesRequest {
  const inputItems: OpenAIResponsesInputItem[] = [];

  for (const msg of req.messages) {
    if (msg.role === "tool") {
      // Tool result
      inputItems.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output:
          typeof msg.content === "string"
            ? msg.content
            : msg.content
            ? msg.content.map((p) => p.text ?? "").join("")
            : "",
      });
    } else if (msg.role === "assistant") {
      // Assistant messages may carry both prior tool calls and text content.
      // The Responses API expects prior tool calls as standalone `function_call`
      // items, not embedded inside a message item (mirrors chatCompletionsToAnthropic's
      // tool_use handling below).
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          inputItems.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        if (msg.content) {
          inputItems.push({
            type: "message",
            role: "assistant",
            content: chatContentToResponsesContent(msg.content),
          });
        }
      } else {
        inputItems.push({
          type: "message",
          role: "assistant",
          content: chatContentToResponsesContent(msg.content),
        });
      }
    } else if (msg.role === "system" || msg.role === "user") {
      inputItems.push({
        type: "message",
        role: msg.role,
        content: chatContentToResponsesContent(msg.content),
      });
    }
  }

  const tools: OpenAIResponsesTool[] | undefined = req.tools?.map((t) => ({
    type: "function" as const,
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));

  let toolChoice: OpenAIResponsesRequest["tool_choice"] | undefined;
  if (req.tool_choice) {
    if (typeof req.tool_choice === "string") {
      toolChoice = req.tool_choice;
    } else {
      toolChoice = {
        type: "function",
        name: req.tool_choice.function.name,
      };
    }
  }

  return {
    model: upstreamModel,
    input: inputItems,
    stream: req.stream,
    max_output_tokens: req.max_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
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
  // Extract system message
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const systemText = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
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
            content:
              typeof msg.content === "string"
                ? msg.content
                : msg.content
                ? msg.content.map((p) => p.text ?? "").join("")
                : "",
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant with tool calls -> tool_use blocks
      const content: AnthropicContentBlock[] = [];
      if (msg.content) {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((p) => p.text ?? "").join("");
        if (text) content.push({ type: "text", text });
      }
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
  const tools: AnthropicTool[] | undefined = req.tools?.map((t) => ({
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
      toolChoice = undefined;
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
