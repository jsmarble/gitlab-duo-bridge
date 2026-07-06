/**
 * Decode upstream Anthropic SSE stream into internal events.
 * Also handles non-streaming JSON response -> internal events.
 *
 * Anthropic SSE event types we handle:
 * - message_start: {type, message: {id, model, usage}}
 * - content_block_start: {type, index, content_block: {type, id?, name?, text?}}
 * - content_block_delta: {type, index, delta: {type, text?, partial_json?}}
 * - content_block_stop: {type, index}
 * - message_delta: {type, delta: {stop_reason, stop_sequence}, usage}
 * - message_stop: {type}
 * - error: {type, error: {type, message}}
 */

import type { InternalEvent, StopReason } from "../events.ts";
import { readSseEvents } from "./sse-parse.ts";

function mapAnthropicStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ---- Streaming decoder ----

export async function* decodeAnthropicStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<InternalEvent> {
  for await (const evt of readSseEvents(body)) {
    yield* processAnthropicEvent(evt);
  }
}

export function* processAnthropicEvent(
  event: Record<string, unknown>
): Generator<InternalEvent> {
  const type = event.type as string;

  switch (type) {
    case "message_start": {
      const msg = event.message as Record<string, unknown> | undefined;
      if (msg) {
        yield {
          type: "start",
          model: (msg.model as string) ?? "",
          id: (msg.id as string) ?? "",
        };
        const usage = msg.usage as Record<string, number> | undefined;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
          };
        }
      }
      break;
    }

    case "content_block_start": {
      const block = event.content_block as Record<string, unknown> | undefined;
      const index = (event.index as number) ?? 0;
      if (block?.type === "tool_use") {
        yield {
          type: "tool_call_start",
          id: (block.id as string) ?? "",
          name: (block.name as string) ?? "",
          index,
        };
      }
      break;
    }

    case "content_block_delta": {
      const delta = event.delta as Record<string, unknown> | undefined;
      const index = (event.index as number) ?? 0;
      if (!delta) break;

      if (delta.type === "text_delta") {
        yield { type: "text_delta", text: (delta.text as string) ?? "" };
      } else if (delta.type === "input_json_delta") {
        yield {
          type: "tool_call_delta",
          id: "",
          argsDelta: (delta.partial_json as string) ?? "",
          index,
        };
      }
      break;
    }

    case "content_block_stop": {
      const index = (event.index as number) ?? 0;
      yield { type: "tool_call_end", id: "", index };
      break;
    }

    case "message_delta": {
      const delta = event.delta as Record<string, unknown> | undefined;
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: 0,
          outputTokens: usage.output_tokens ?? 0,
        };
      }
      if (delta?.stop_reason) {
        yield {
          type: "stop",
          reason: mapAnthropicStopReason(delta.stop_reason as string),
        };
      }
      break;
    }

    case "message_stop":
      // Already handled via message_delta; emit stop if not yet emitted
      break;

    case "error": {
      yield { type: "stop", reason: "error" };
      break;
    }
  }
}

// ---- Non-streaming JSON decoder ----

export function* decodeAnthropicJSON(
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

  const content = response.content as Array<Record<string, unknown>> | undefined;
  if (content) {
    let toolIndex = 0;
    for (const block of content) {
      if (block.type === "text") {
        yield { type: "text_delta", text: (block.text as string) ?? "" };
      } else if (block.type === "tool_use") {
        const idx = toolIndex++;
        yield {
          type: "tool_call_start",
          id: (block.id as string) ?? "",
          name: (block.name as string) ?? "",
          index: idx,
        };
        const input = block.input;
        if (input !== undefined) {
          yield {
            type: "tool_call_delta",
            id: (block.id as string) ?? "",
            argsDelta: JSON.stringify(input),
            index: idx,
          };
        }
        yield { type: "tool_call_end", id: (block.id as string) ?? "", index: idx };
      }
    }
  }

  const stopReason = response.stop_reason as string | undefined;
  yield {
    type: "stop",
    reason: mapAnthropicStopReason(stopReason),
  };
}
