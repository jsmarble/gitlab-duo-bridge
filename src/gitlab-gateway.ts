/**
 * Thin fetch wrappers for GitLab AI Gateway proxy calls.
 *
 * Handles:
 * - Attaching Authorization: Bearer <direct-access-token>
 * - Forwarding extra headers from direct-access response (minus x-api-key)
 * - Reactive 401 invalidation
 * - User-Agent header
 */

import {
  getDirectAccessToken,
  invalidateDirectAccessToken,
} from "./gitlab-direct-access.ts";
import { config } from "./config.ts";

const ANTHROPIC_PROXY_URL =
  "https://cloud.gitlab.com/ai/v1/proxy/anthropic/v1/messages";
const OPENAI_PROXY_URL =
  "https://cloud.gitlab.com/ai/v1/proxy/openai/v1/chat/completions";

async function buildHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const token = await getDirectAccessToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token.token}`,
    "User-Agent": `gitlab-duo-bridge/${config.version}`,
    ...token.headers,
    ...extra,
  };
}

/**
 * Call the Anthropic proxy. Returns the raw Response for streaming.
 * Invalidates the direct-access token on 401.
 */
export async function callAnthropicProxy(
  requestBody: unknown
): Promise<Response> {
  // GitLab's Anthropic proxy forwards to the Anthropic Messages API, which
  // requires the anthropic-version header. Without it the gateway returns 400.
  const headers = await buildHeaders({ "anthropic-version": "2023-06-01" });
  const resp = await fetch(ANTHROPIC_PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (resp.status === 401) {
    invalidateDirectAccessToken();
  }

  return resp;
}

/**
 * Call the OpenAI Chat Completions proxy. Returns the raw Response for streaming.
 * Invalidates the direct-access token on 401.
 */
export async function callOpenAIProxy(
  requestBody: unknown
): Promise<Response> {
  const headers = await buildHeaders();
  const resp = await fetch(OPENAI_PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (resp.status === 401) {
    invalidateDirectAccessToken();
  }

  return resp;
}
