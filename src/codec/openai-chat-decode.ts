/**
 * Decode upstream OpenAI Chat Completions API SSE stream into internal events.
 * Also handles non-streaming JSON response -> internal events.
 *
 * OpenAI Chat Completions SSE chunks have the shape:
 * {
 *   id: string,
 *   model: string,
 *   choices: [{
 *     index: number,
 *     delta: {
 *       role?: string,
 *       content?: string,
 *       tool_calls?: [{
 *         index: number,
 *         id?: string,
 *         type?: "function",
 *         function?: { name?: string, arguments?: string }
 *       }]
 *     },
 *     finish_reason: string | null
 *   }],
 *   usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
 * }
 */

import type { InternalEvent, StopReason } from "../events.ts";
import { readSseEvents } from "./sse-parse.ts";

function mapChatFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ---- Streaming decoder ----

export async function* decodeOpenAIChatStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<InternalEvent> {
  let startEmitted = false;
  // Track which tool-call indices have been started: index -> id
  const startedToolCalls = new Map<number, string>();

  for await (const chunk of readSseEvents(body)) {
    // Emit start event once (first chunk with id/model)
    if (!startEmitted) {
      const id = chunk.id as string | undefined;
      const model = chunk.model as string | undefined;
      if (id || model) {
        yield {
          type: "start",
          id: id ?? "",
          model: model ?? "",
        };
        startEmitted = true;
      }
    }

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      // May be a usage-only chunk
      const usage = chunk.usage as Record<string, number> | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }
      continue;
    }

    const choice = choices[0] as Record<string, unknown>;
    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | null | undefined;

    if (delta) {
      // Text content delta
      const content = delta.content as string | undefined;
      if (content) {
        yield { type: "text_delta", text: content };
      }

      // Tool call deltas
      const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const tcIndex = tc.index as number;
          const tcId = tc.id as string | undefined;
          const tcFunction = tc.function as Record<string, unknown> | undefined;
          const tcName = tcFunction?.name as string | undefined;
          const tcArgsDelta = tcFunction?.arguments as string | undefined;

          // Emit tool_call_start on first sighting of this index
          if (!startedToolCalls.has(tcIndex)) {
            const resolvedId = tcId ?? "";
            startedToolCalls.set(tcIndex, resolvedId);
            yield {
              type: "tool_call_start",
              id: resolvedId,
              name: tcName ?? "",
              index: tcIndex,
            };
          }

          // Emit argument delta if present
          if (tcArgsDelta) {
            yield {
              type: "tool_call_delta",
              id: startedToolCalls.get(tcIndex) ?? tcId ?? "",
              argsDelta: tcArgsDelta,
              index: tcIndex,
            };
          }
        }
      }
    }

    // Handle finish_reason
    if (finishReason != null) {
      // Synthesize tool_call_end for all started tool calls
      for (const [idx, id] of startedToolCalls) {
        yield { type: "tool_call_end", id, index: idx };
      }

      // Usage may appear on the finish chunk
      const usage = chunk.usage as Record<string, number> | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }

      yield {
        type: "stop",
        reason: mapChatFinishReason(finishReason),
      };
    }
  }
}

// ---- Non-streaming JSON decoder ----

export function* decodeOpenAIChatJSON(
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
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
    };
  }

  const choices = response.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | undefined;

    if (message) {
      // Text content
      const content = message.content as string | undefined;
      if (content) {
        yield { type: "text_delta", text: content };
      }

      // Tool calls
      const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
      if (toolCalls) {
        let toolIndex = 0;
        for (const tc of toolCalls) {
          const idx = toolIndex++;
          const tcId = (tc.id as string) ?? "";
          const tcFunction = tc.function as Record<string, unknown> | undefined;
          const tcName = (tcFunction?.name as string) ?? "";
          const tcArgs = (tcFunction?.arguments as string) ?? "";

          yield {
            type: "tool_call_start",
            id: tcId,
            name: tcName,
            index: idx,
          };
          if (tcArgs) {
            yield {
              type: "tool_call_delta",
              id: tcId,
              argsDelta: tcArgs,
              index: idx,
            };
          }
          yield { type: "tool_call_end", id: tcId, index: idx };
        }
      }
    }

    yield {
      type: "stop",
      reason: mapChatFinishReason(finishReason),
    };
  }
}
