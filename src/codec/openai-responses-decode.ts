/**
 * Decode upstream OpenAI Responses API SSE stream into internal events.
 * Also handles non-streaming JSON response -> internal events.
 *
 * OpenAI Responses API SSE event types we handle:
 * - response.created: {type, response: {id, model}}
 * - response.output_item.added: {type, item: {type, id?, call_id?, name?}}
 * - response.content_part.added: {type, part: {type, text?}}
 * - response.output_text.delta: {type, delta: string}
 * - response.function_call_arguments.delta: {type, delta: string, item_id: string}
 * - response.output_item.done: {type, item: {type, id?, status}}
 * - response.completed: {type, response: {usage, status}}
 * - error: {type, message}
 */

import type { InternalEvent, StopReason } from "../events.ts";
import { parseSseLines } from "./sse-parse.ts";

function mapOpenAIStatus(status: string | undefined): StopReason {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    default:
      return "stop";
  }
}

export async function* decodeOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<InternalEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  // Track tool call items by item_id -> index
  const toolCallIndexMap = new Map<string, number>();
  let toolCallCounter = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

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
          yield* processOpenAIResponsesEvent(
            parsed,
            toolCallIndexMap,
            { counter: toolCallCounter }
          );
          toolCallCounter = toolCallIndexMap.size;
        }
      }
    }

    if (buffer.trim()) {
      for (const line of parseSseLines(buffer)) {
        if (!line.data || line.data === "[DONE]") continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        yield* processOpenAIResponsesEvent(
          parsed,
          toolCallIndexMap,
          { counter: toolCallCounter }
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function* processOpenAIResponsesEvent(
  event: Record<string, unknown>,
  toolCallIndexMap: Map<string, number>,
  counterRef: { counter: number }
): Generator<InternalEvent> {
  const type = event.type as string;

  switch (type) {
    case "response.created": {
      const resp = event.response as Record<string, unknown> | undefined;
      if (resp) {
        yield {
          type: "start",
          model: (resp.model as string) ?? "",
          id: (resp.id as string) ?? "",
        };
      }
      break;
    }

    case "response.output_item.added": {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const itemId = (item.call_id as string) ?? (item.id as string) ?? "";
        const idx = counterRef.counter++;
        toolCallIndexMap.set(itemId, idx);
        yield {
          type: "tool_call_start",
          id: itemId,
          name: (item.name as string) ?? "",
          index: idx,
        };
      }
      break;
    }

    case "response.output_text.delta": {
      yield { type: "text_delta", text: (event.delta as string) ?? "" };
      break;
    }

    case "response.function_call_arguments.delta": {
      const itemId = (event.item_id as string) ?? "";
      const idx = toolCallIndexMap.get(itemId) ?? 0;
      yield {
        type: "tool_call_delta",
        id: itemId,
        argsDelta: (event.delta as string) ?? "",
        index: idx,
      };
      break;
    }

    case "response.output_item.done": {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const itemId = (item.call_id as string) ?? (item.id as string) ?? "";
        const idx = toolCallIndexMap.get(itemId) ?? 0;
        yield { type: "tool_call_end", id: itemId, index: idx };
      }
      break;
    }

    case "response.completed": {
      const resp = event.response as Record<string, unknown> | undefined;
      if (resp) {
        const usage = resp.usage as Record<string, number> | undefined;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          };
        }
        yield {
          type: "stop",
          reason: mapOpenAIStatus(resp.status as string | undefined),
        };
      }
      break;
    }

    case "error": {
      yield { type: "stop", reason: "error" };
      break;
    }
  }
}

// ---- Non-streaming JSON decoder ----

export function* decodeOpenAIResponsesJSON(
  response: Record<string, unknown>
): Generator<InternalEvent> {
  yield {
    type: "start",
    model: (response.model as string) ?? "",
    id: (response.id as string) ?? "",
  };

  const usage = response.usage as Record<string, number> | undefined;
  if (usage) {
    yield {
      type: "usage",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };
  }

  const output = response.output as Array<Record<string, unknown>> | undefined;
  if (output) {
    let toolIndex = 0;
    for (const item of output) {
      if (item.type === "message") {
        const content = item.content as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const part of content) {
            if (part.type === "output_text" || part.type === "text") {
              yield { type: "text_delta", text: (part.text as string) ?? "" };
            }
          }
        }
      } else if (item.type === "function_call") {
        const idx = toolIndex++;
        const callId = (item.call_id as string) ?? (item.id as string) ?? "";
        yield {
          type: "tool_call_start",
          id: callId,
          name: (item.name as string) ?? "",
          index: idx,
        };
        const args = item.arguments as string | undefined;
        if (args) {
          yield {
            type: "tool_call_delta",
            id: callId,
            argsDelta: args,
            index: idx,
          };
        }
        yield { type: "tool_call_end", id: callId, index: idx };
      }
    }
  }

  const status = response.status as string | undefined;
  yield { type: "stop", reason: mapOpenAIStatus(status) };
}
