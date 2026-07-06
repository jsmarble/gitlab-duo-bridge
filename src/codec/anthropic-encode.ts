/**
 * Encode internal events into Anthropic Messages API wire format.
 *
 * - encodeAnthropicSSE: produces a ReadableStream of SSE bytes
 * - encodeAnthropicJSON: collects events into a single Messages response object
 */

import type { InternalEvent, StopReason } from "../events.ts";

const encoder = new TextEncoder();

function sseEvent(eventType: string, data: unknown): Uint8Array {
  return encoder.encode(
    `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

function mapStopReasonToAnthropic(reason: StopReason): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "error":
      return "end_turn";
  }
}

// Track per-stream state for encoding
interface EncodeState {
  model: string;
  id: string;
  textBlockIndex: number;
  toolBlocks: Map<number, { id: string; name: string; blockIndex: number }>;
  inputTokens: number;
  outputTokens: number;
  stopReason: StopReason;
  hasEmittedStart: boolean;
  hasEmittedTextBlock: boolean;
}

function makeState(): EncodeState {
  return {
    model: "",
    id: "",
    textBlockIndex: -1,
    toolBlocks: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    stopReason: "stop",
    hasEmittedStart: false,
    hasEmittedTextBlock: false,
  };
}

export function encodeAnthropicSSE(
  events: AsyncIterable<InternalEvent>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state = makeState();
      let contentBlockCount = 0;
      let stopped = false;

      try {
        for await (const event of events) {
          switch (event.type) {
            case "start": {
              state.model = event.model;
              state.id = event.id;
              state.hasEmittedStart = true;
              controller.enqueue(
                sseEvent("message_start", {
                  type: "message_start",
                  message: {
                    id: event.id,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: event.model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                })
              );
              controller.enqueue(
                sseEvent("ping", { type: "ping" })
              );
              break;
            }

            case "text_delta": {
              if (!state.hasEmittedTextBlock) {
                state.hasEmittedTextBlock = true;
                state.textBlockIndex = contentBlockCount++;
                controller.enqueue(
                  sseEvent("content_block_start", {
                    type: "content_block_start",
                    index: state.textBlockIndex,
                    content_block: { type: "text", text: "" },
                  })
                );
              }
              controller.enqueue(
                sseEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: state.textBlockIndex,
                  delta: { type: "text_delta", text: event.text },
                })
              );
              break;
            }

            case "tool_call_start": {
              const blockIndex = contentBlockCount++;
              state.toolBlocks.set(event.index, {
                id: event.id,
                name: event.name,
                blockIndex,
              });
              controller.enqueue(
                sseEvent("content_block_start", {
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: {
                    type: "tool_use",
                    id: event.id,
                    name: event.name,
                    input: {},
                  },
                })
              );
              break;
            }

            case "tool_call_delta": {
              // Use the stored blockIndex from when this tool call started
              const toolInfo = state.toolBlocks.get(event.index);
              if (toolInfo) {
                controller.enqueue(
                  sseEvent("content_block_delta", {
                    type: "content_block_delta",
                    index: toolInfo.blockIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: event.argsDelta,
                    },
                  })
                );
              }
              break;
            }

            case "tool_call_end": {
              const toolInfo = state.toolBlocks.get(event.index);
              const blockIdx = toolInfo ? toolInfo.blockIndex : event.index;
              controller.enqueue(
                sseEvent("content_block_stop", {
                  type: "content_block_stop",
                  index: blockIdx,
                })
              );
              break;
            }

            case "stop": {
              state.stopReason = event.reason;
              // Close text block if open
              if (state.hasEmittedTextBlock) {
                controller.enqueue(
                  sseEvent("content_block_stop", {
                    type: "content_block_stop",
                    index: state.textBlockIndex,
                  })
                );
              }
              controller.enqueue(
                sseEvent("message_delta", {
                  type: "message_delta",
                  delta: {
                    stop_reason: mapStopReasonToAnthropic(event.reason),
                    stop_sequence: null,
                  },
                  usage: { output_tokens: state.outputTokens },
                })
              );
              controller.enqueue(
                sseEvent("message_stop", { type: "message_stop" })
              );
              stopped = true;
              break;
            }

            case "usage": {
              if (event.inputTokens > 0) state.inputTokens = event.inputTokens;
              if (event.outputTokens > 0)
                state.outputTokens = event.outputTokens;
              break;
            }
          }
        }
      } catch (err) {
        // Don't emit an error event if the stream already completed cleanly
        // (would produce a malformed message_stop-then-error sequence).
        if (!stopped) {
          controller.enqueue(
            sseEvent("error", {
              type: "error",
              error: {
                type: "api_error",
                message:
                  err instanceof Error ? err.message : "Internal server error",
              },
            })
          );
        }
      } finally {
        controller.close();
      }
    },
  });
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export async function encodeAnthropicJSON(
  events: AsyncIterable<InternalEvent>
): Promise<AnthropicMessagesResponse> {
  let id = "";
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "stop";
  let textAccum = "";
  const toolCalls: Map<
    number,
    { id: string; name: string; argsAccum: string }
  > = new Map();

  for await (const event of events) {
    switch (event.type) {
      case "start":
        id = event.id;
        model = event.model;
        break;
      case "text_delta":
        textAccum += event.text;
        break;
      case "tool_call_start":
        toolCalls.set(event.index, {
          id: event.id,
          name: event.name,
          argsAccum: "",
        });
        break;
      case "tool_call_delta": {
        const tc = toolCalls.get(event.index);
        if (tc) tc.argsAccum += event.argsDelta;
        break;
      }
      case "stop":
        stopReason = event.reason;
        break;
      case "usage":
        if (event.inputTokens > 0) inputTokens = event.inputTokens;
        if (event.outputTokens > 0) outputTokens = event.outputTokens;
        break;
    }
  }

  const content: AnthropicContentBlock[] = [];
  if (textAccum) {
    content.push({ type: "text", text: textAccum });
  }
  for (const [, tc] of toolCalls) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.argsAccum);
    } catch {
      input = tc.argsAccum;
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: mapStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
