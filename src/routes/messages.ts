/**
 * POST /v1/messages — Anthropic Messages API endpoint.
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
  encodeAnthropicSSE,
  encodeAnthropicJSON,
} from "../codec/anthropic-encode.ts";
import {
  anthropicToAnthropic,
  anthropicToOpenAIResponses,
  type AnthropicMessagesRequest,
} from "../codec/request-translate.ts";
import { log } from "../logger.ts";

function anthropicError(
  type: string,
  message: string,
  status: number
): Response {
  return Response.json(
    { type: "error", error: { type, message } },
    { status }
  );
}

export async function handleMessages(req: Request): Promise<Response> {
  let body: AnthropicMessagesRequest;
  try {
    body = (await req.json()) as AnthropicMessagesRequest;
  } catch {
    return anthropicError(
      "invalid_request_error",
      "Invalid JSON body",
      400
    );
  }

  const modelId = body.model;
  if (!modelId) {
    return anthropicError(
      "invalid_request_error",
      "Missing required field: model",
      400
    );
  }

  const modelEntry = lookupModel(modelId);
  if (!modelEntry) {
    return anthropicError(
      "invalid_request_error",
      `Unknown model: ${modelId}`,
      400
    );
  }

  const isStreaming = body.stream === true;

  try {
    if (modelEntry.backend === "anthropic") {
      // Translate request (identity + model rewrite)
      const upstreamReq = anthropicToAnthropic(body, modelEntry.upstreamModel);
      const resp = await callAnthropicProxy(upstreamReq);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error");
        log("error", `[messages] Anthropic upstream error: ${resp.status} — ${errText}`);
        return anthropicError(
          "api_error",
          `GitLab AI Gateway returned status ${resp.status}`,
          resp.status >= 500 ? 502 : resp.status
        );
      }

      if (isStreaming) {
        if (!resp.body) {
          return anthropicError("api_error", "Empty response body", 502);
        }
        const events = decodeAnthropicStream(resp.body);
        const stream = encodeAnthropicSSE(events);
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
        const result = await encodeAnthropicJSON(events);
        return Response.json(result);
      }
    } else {
      // openai backend — translate Anthropic -> OpenAI Responses
      const upstreamReq = anthropicToOpenAIResponses(
        body,
        modelEntry.upstreamModel
      );
      const resp = await callOpenAIProxy(upstreamReq);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "Unknown error");
        log("error", `[messages] OpenAI upstream error: ${resp.status} — ${errText}`);
        return anthropicError(
          "api_error",
          `GitLab AI Gateway returned status ${resp.status}`,
          resp.status >= 500 ? 502 : resp.status
        );
      }

      if (isStreaming) {
        if (!resp.body) {
          return anthropicError("api_error", "Empty response body", 502);
        }
        const events = decodeOpenAIResponsesStream(resp.body);
        const stream = encodeAnthropicSSE(events);
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
        const result = await encodeAnthropicJSON(events);
        return Response.json(result);
      }
    }
  } catch (err) {
    if (err instanceof GitLabPatMissingError) {
      return anthropicError(
        "authentication_error",
        err.message,
        401
      );
    }
    log("error", "[messages] Unhandled error:", err instanceof Error ? err.message : String(err));
    return anthropicError(
      "api_error",
      "Internal server error",
      500
    );
  }
}
