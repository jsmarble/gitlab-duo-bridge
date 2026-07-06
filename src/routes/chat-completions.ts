/**
 * POST /v1/chat/completions — OpenAI Chat Completions API endpoint.
 *
 * Routes to anthropic or openai backend based on model registry.
 * Uses the normalized internal event pipeline for all paths.
 */

import { lookupModel } from "../models.ts";
import { callAnthropicProxy, callOpenAIProxy } from "../gitlab-gateway.ts";
import { GitLabPatMissingError } from "../gitlab-direct-access.ts";
import {
  decodeAnthropicStream,
  decodeAnthropicJSON,
} from "../codec/anthropic-decode.ts";
import {
  decodeOpenAIResponsesStream,
  decodeOpenAIResponsesJSON,
} from "../codec/openai-responses-decode.ts";
import {
  encodeOpenAIChatSSE,
  encodeOpenAIChatJSON,
} from "../codec/openai-chat-encode.ts";
import {
  chatCompletionsToOpenAIResponses,
  chatCompletionsToAnthropic,
  type ChatCompletionsRequest,
} from "../codec/request-translate.ts";
import { log } from "../logger.ts";

function openAIError(message: string, type: string, status: number): Response {
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status }
  );
}

export async function handleChatCompletions(req: Request): Promise<Response> {
  let body: ChatCompletionsRequest;
  try {
    body = (await req.json()) as ChatCompletionsRequest;
  } catch {
    return openAIError("Invalid JSON body", "invalid_request_error", 400);
  }

  const modelId = body.model;
  if (!modelId) {
    return openAIError(
      "Missing required field: model",
      "invalid_request_error",
      400
    );
  }

  const modelEntry = lookupModel(modelId);
  if (!modelEntry) {
    return openAIError(
      `Unknown model: ${modelId}`,
      "invalid_request_error",
      400
    );
  }

  const isStreaming = body.stream === true;

  try {
    if (modelEntry.backend === "openai") {
      const upstreamReq = chatCompletionsToOpenAIResponses(
        body,
        modelEntry.upstreamModel
      );
      const resp = await callOpenAIProxy(upstreamReq);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error");
        log("error", `[chat-completions] OpenAI upstream error: ${resp.status} — ${errText}`);
        return openAIError(
          `GitLab AI Gateway returned status ${resp.status}`,
          "api_error",
          resp.status >= 500 ? 502 : resp.status
        );
      }

      if (isStreaming) {
        if (!resp.body) {
          return openAIError("Empty response body", "api_error", 502);
        }
        const events = decodeOpenAIResponsesStream(resp.body);
        const stream = encodeOpenAIChatSSE(events);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        const json = (await resp.json()) as Record<string, unknown>;
        const events = (async function* () {
          yield* decodeOpenAIResponsesJSON(json);
        })();
        const result = await encodeOpenAIChatJSON(events);
        return Response.json(result);
      }
    } else {
      // anthropic backend — translate Chat Completions -> Anthropic Messages
      const upstreamReq = chatCompletionsToAnthropic(
        body,
        modelEntry.upstreamModel
      );
      const resp = await callAnthropicProxy(upstreamReq);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error");
        log("error", `[chat-completions] Anthropic upstream error: ${resp.status} — ${errText}`);
        return openAIError(
          `GitLab AI Gateway returned status ${resp.status}`,
          "api_error",
          resp.status >= 500 ? 502 : resp.status
        );
      }

      if (isStreaming) {
        if (!resp.body) {
          return openAIError("Empty response body", "api_error", 502);
        }
        const events = decodeAnthropicStream(resp.body);
        const stream = encodeOpenAIChatSSE(events);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } else {
        const json = (await resp.json()) as Record<string, unknown>;
        const events = (async function* () {
          yield* decodeAnthropicJSON(json);
        })();
        const result = await encodeOpenAIChatJSON(events);
        return Response.json(result);
      }
    }
  } catch (err) {
    if (err instanceof GitLabPatMissingError) {
      return openAIError(err.message, "authentication_error", 401);
    }
    log("error", "[chat-completions] Unhandled error:", err instanceof Error ? err.message : String(err));
    return openAIError("Internal server error", "api_error", 500);
  }
}
