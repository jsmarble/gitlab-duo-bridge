/**
 * Encode internal events into OpenAI Chat Completions API wire format.
 *
 * - encodeOpenAIChatSSE: produces a ReadableStream of SSE bytes (chat completions streaming)
 * - encodeOpenAIChatJSON: collects events into a single Chat Completions response object
 */

import type { InternalEvent, StopReason } from "../events.ts";

const encoder = new TextEncoder();

function sseData(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function mapStopReasonToOpenAI(reason: StopReason): string {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "error":
      return "stop";
  }
}

export function encodeOpenAIChatSSE(
  events: AsyncIterable<InternalEvent>
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let id = `chatcmpl-${Date.now()}`;
      let model = "";
      let created = Math.floor(Date.now() / 1000);
      // Track tool calls by index
      const toolCallsStarted = new Set<number>();

      try {
        for await (const event of events) {
          switch (event.type) {
            case "start": {
              id = event.id || id;
              model = event.model;
              created = Math.floor(Date.now() / 1000);
              // Send role chunk
              controller.enqueue(
                sseData({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "" },
                      finish_reason: null,
                    },
                  ],
                })
              );
              break;
            }

            case "text_delta": {
              controller.enqueue(
                sseData({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: event.text },
                      finish_reason: null,
                    },
                  ],
                })
              );
              break;
            }

            case "tool_call_start": {
              toolCallsStarted.add(event.index);
              controller.enqueue(
                sseData({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: event.index,
                            id: event.id,
                            type: "function",
                            function: { name: event.name, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })
              );
              break;
            }

            case "tool_call_delta": {
              controller.enqueue(
                sseData({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: event.index,
                            function: { arguments: event.argsDelta },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })
              );
              break;
            }

            case "tool_call_end":
              // No explicit end chunk needed in Chat Completions streaming
              break;

            case "stop": {
              controller.enqueue(
                sseData({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: mapStopReasonToOpenAI(event.reason),
                    },
                  ],
                })
              );
              break;
            }

            case "usage":
              // Usage in streaming is sent as a final chunk by some providers
              // but not required by the spec; skip for now
              break;
          }
        }
        // Only send [DONE] on the success path (normal loop completion)
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        controller.enqueue(
          sseData({
            error: {
              message:
                err instanceof Error ? err.message : "Internal server error",
              type: "server_error",
            },
          })
        );
        // Do NOT send [DONE] after an error — client should not think stream completed successfully
      } finally {
        controller.close();
      }
    },
  });
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export async function encodeOpenAIChatJSON(
  events: AsyncIterable<InternalEvent>
): Promise<OpenAIChatCompletionResponse> {
  let id = `chatcmpl-${Date.now()}`;
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
        id = event.id || id;
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

  const message: OpenAIChatCompletionResponse["choices"][0]["message"] = {
    role: "assistant",
    content: textAccum || null,
  };

  if (toolCalls.size > 0) {
    message.content = null;
    message.tool_calls = Array.from(toolCalls.entries()).map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.argsAccum },
    }));
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReasonToOpenAI(stopReason),
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
