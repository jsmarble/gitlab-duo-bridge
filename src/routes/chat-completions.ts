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
  decodeOpenAIChatStream,
  decodeOpenAIChatJSON,
} from "../codec/openai-chat-decode.ts";
import {
  encodeOpenAIChatSSE,
  encodeOpenAIChatJSON,
} from "../codec/openai-chat-encode.ts";
import {
  chatToOpenAIChat,
  chatCompletionsToAnthropic,
  type ChatCompletionsRequest,
} from "../codec/request-translate.ts";
import { openAIError } from "../errors.ts";
import { log } from "../logger.ts";

export async function handleChatCompletions(
  req: Request
): Promise<{ response: Response; model?: string }> {
  let body: ChatCompletionsRequest;
  try {
    body = (await req.json()) as ChatCompletionsRequest;
  } catch {
    return {
      response: openAIError(400, "invalid_request_error", "Invalid JSON body"),
    };
  }

  const modelId = body.model;
  if (!modelId) {
    return {
      response: openAIError(
        400,
        "invalid_request_error",
        "Missing required field: model"
      ),
    };
  }

  const modelEntry = lookupModel(modelId);
  if (!modelEntry) {
    return {
      response: openAIError(
        400,
        "invalid_request_error",
        `Unknown model: ${modelId}`
      ),
    };
  }

  const isStreaming = body.stream === true;

  try {
    if (modelEntry.backend === "openai") {
      const upstreamReq = chatToOpenAIChat(body, modelEntry.upstreamModel);
      const resp = await callOpenAIProxy(upstreamReq);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error");
        log("error", `[chat-completions] OpenAI upstream error: ${resp.status} — ${errText}`);
        return {
          response: openAIError(
            resp.status >= 500 ? 502 : resp.status,
            "api_error",
            `GitLab AI Gateway returned status ${resp.status}`
          ),
          model: modelId,
        };
      }

      if (isStreaming) {
        if (!resp.body) {
          return {
            response: openAIError(502, "api_error", "Empty response body"),
            model: modelId,
          };
        }
        const events = decodeOpenAIChatStream(resp.body);
        const stream = encodeOpenAIChatSSE(events);
        return {
          response: new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          model: modelId,
        };
      } else {
        const json = (await resp.json()) as Record<string, unknown>;
        const events = (async function* () {
          yield* decodeOpenAIChatJSON(json);
        })();
        const result = await encodeOpenAIChatJSON(events);
        return { response: Response.json(result), model: modelId };
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
        return {
          response: openAIError(
            resp.status >= 500 ? 502 : resp.status,
            "api_error",
            `GitLab AI Gateway returned status ${resp.status}`
          ),
          model: modelId,
        };
      }

      if (isStreaming) {
        if (!resp.body) {
          return {
            response: openAIError(502, "api_error", "Empty response body"),
            model: modelId,
          };
        }
        const events = decodeAnthropicStream(resp.body);
        const stream = encodeOpenAIChatSSE(events);
        return {
          response: new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          }),
          model: modelId,
        };
      } else {
        const json = (await resp.json()) as Record<string, unknown>;
        const events = (async function* () {
          yield* decodeAnthropicJSON(json);
        })();
        const result = await encodeOpenAIChatJSON(events);
        return { response: Response.json(result), model: modelId };
      }
    }
  } catch (err) {
    if (err instanceof GitLabPatMissingError) {
      return {
        response: openAIError(401, "authentication_error", err.message),
        model: modelId,
      };
    }
    log("error", "[chat-completions] Unhandled error:", err instanceof Error ? err.message : String(err));
    return {
      response: openAIError(500, "api_error", "Internal server error"),
      model: modelId,
    };
  }
}
