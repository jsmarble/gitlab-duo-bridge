/**
 * Tests for the GitLab AI Gateway proxy calls.
 *
 * These assert on the OUTBOUND request to GitLab (URL, headers, and body) —
 * the contract that live-testing revealed unit tests were missing. Two real
 * regressions are guarded here:
 *   1. The Anthropic proxy requires an `anthropic-version` header (else 400).
 *   2. The OpenAI (GPT-5) proxy rejects `max_tokens` and requires
 *      `max_completion_tokens` (else 400).
 *
 * fetch is mocked and routed by URL: the direct-access token endpoint returns
 * a canned token; the proxy endpoints capture the request for assertions.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { callAnthropicProxy, callOpenAIProxy } from "../src/gitlab-gateway.ts";
import { _resetForTest } from "../src/gitlab-direct-access.ts";
import {
  anthropicToOpenAIChat,
  chatToOpenAIChat,
} from "../src/codec/request-translate.ts";

const mockState = {
  gitlabPat: "glpat-test" as string | null,
  gitlabPatSetAt: null as string | null,
};

mock.module("../src/store.ts", () => ({
  getState: () => mockState,
  loadState: async () => {},
  setGitlabPat: async (p: string) => {
    mockState.gitlabPat = p;
  },
  clearGitlabPat: async () => {
    mockState.gitlabPat = null;
  },
}));

mock.module("../src/config.ts", () => ({
  config: {
    version: "9.9.9-test",
    port: 3000,
    proxyApiKey: "k",
    dataDir: "/tmp",
    logLevel: "error",
  },
}));

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

let captured: CapturedRequest[] = [];
let tokenFetches = 0;
const origFetch = globalThis.fetch;

function installFetch(proxyStatus = 200): void {
  captured = [];
  tokenFetches = 0;
  const fetchMock = mock(
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : (input as { url: string }).url;

      if (url.includes("third_party_agents/direct_access")) {
        tokenFetches++;
        return new Response(
          JSON.stringify({
            token: "dat-token",
            headers: {
              "x-gitlab-something": "value",
              "x-api-key": "SHOULD-BE-STRIPPED",
            },
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      captured.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response("{}", {
        status: proxyStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

describe("GitLab AI Gateway proxy calls", () => {
  beforeEach(() => {
    _resetForTest();
    mockState.gitlabPat = "glpat-test";
  });

  afterEach(() => {
    _resetForTest();
    globalThis.fetch = origFetch;
  });

  describe("callAnthropicProxy", () => {
    it("sends the required anthropic-version header (regression guard)", async () => {
      installFetch();
      await callAnthropicProxy({ model: "claude", messages: [] });

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toContain("/ai/v1/proxy/anthropic/v1/messages");
      // The bug: GitLab's Anthropic proxy 400s without this header.
      expect(captured[0].headers["anthropic-version"]).toBe("2023-06-01");
    });

    it("attaches the direct-access bearer token, User-Agent, and forwarded headers", async () => {
      installFetch();
      await callAnthropicProxy({ model: "claude", messages: [] });

      const h = captured[0].headers;
      expect(h["Authorization"]).toBe("Bearer dat-token");
      expect(String(h["User-Agent"]).startsWith("gitlab-duo-bridge/")).toBe(true);
      // Forwarded from the direct-access response...
      expect(h["x-gitlab-something"]).toBe("value");
      // ...but x-api-key must be stripped (conflicts with our bearer).
      expect(h["x-api-key"]).toBeUndefined();
    });
  });

  describe("callOpenAIProxy", () => {
    it("targets the Chat Completions path, not Responses (API-shape guard)", async () => {
      installFetch();
      await callOpenAIProxy({ model: "gpt", messages: [] });

      expect(captured).toHaveLength(1);
      expect(captured[0].url).toContain("/ai/v1/proxy/openai/v1/chat/completions");
      expect(captured[0].url).not.toContain("/responses");
    });

    it("does not send anthropic-version on OpenAI calls", async () => {
      installFetch();
      await callOpenAIProxy({ model: "gpt", messages: [] });
      expect(captured[0].headers["anthropic-version"]).toBeUndefined();
      expect(captured[0].headers["Authorization"]).toBe("Bearer dat-token");
    });

    it("wire body uses max_completion_tokens, never max_tokens (regression guard, chat path)", async () => {
      installFetch();
      const upstream = chatToOpenAIChat(
        {
          model: "gpt-5-mini",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        },
        "gpt-5-mini-2025-08-07"
      );
      await callOpenAIProxy(upstream);

      const body = JSON.parse(captured[0].body ?? "{}");
      expect(body.model).toBe("gpt-5-mini-2025-08-07");
      // The bug: GPT-5 proxy 400s on max_tokens.
      expect(body.max_completion_tokens).toBe(100);
      expect(body.max_tokens).toBeUndefined();
    });

    it("wire body uses max_completion_tokens (regression guard, anthropic->chat path)", async () => {
      installFetch();
      const upstream = anthropicToOpenAIChat(
        {
          model: "claude-ish",
          max_tokens: 50,
          messages: [{ role: "user", content: "hi" }],
        },
        "gpt-5-mini-2025-08-07"
      );
      await callOpenAIProxy(upstream);

      const body = JSON.parse(captured[0].body ?? "{}");
      expect(body.max_completion_tokens).toBe(50);
      expect(body.max_tokens).toBeUndefined();
    });
  });

  describe("reactive 401 invalidation", () => {
    it("re-fetches a fresh direct-access token after a 401 from the gateway", async () => {
      installFetch(401);

      // Call 1: fetches a token, gets 401, invalidates it.
      await callAnthropicProxy({ model: "claude", messages: [] });
      expect(tokenFetches).toBe(1);

      // Call 2: cache was invalidated, so it must fetch a fresh token again.
      await callAnthropicProxy({ model: "claude", messages: [] });
      expect(tokenFetches).toBe(2);
    });

    it("reuses the cached token across successful calls (no needless re-fetch)", async () => {
      installFetch(200);

      await callAnthropicProxy({ model: "claude", messages: [] });
      await callAnthropicProxy({ model: "claude", messages: [] });
      // Token fetched once, reused for the second proxy call.
      expect(tokenFetches).toBe(1);
    });
  });
});
