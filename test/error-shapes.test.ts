/**
 * Tests for error response shapes produced by the route error helpers.
 *
 * Verifies that the existing helper functions produce the documented shapes:
 * - OpenAI-style: {error: {message, type, param, code}}
 * - Anthropic-style: {type: "error", error: {type, message}}
 */

import { describe, it, expect } from "bun:test";

// We test the error shapes by calling the route handlers with invalid inputs
// and checking the response body shape — this exercises the actual helpers.

describe("Anthropic-style error shape (/v1/messages)", () => {
  it("returns {type: 'error', error: {type, message}} for invalid JSON", async () => {
    const { handleMessages } = await import("../src/routes/messages.ts");
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleMessages(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
    expect(typeof (body.error as Record<string, unknown>)?.type).toBe("string");
    expect(typeof (body.error as Record<string, unknown>)?.message).toBe("string");
  });

  it("returns {type: 'error', error: {type, message}} for missing model", async () => {
    const { handleMessages } = await import("../src/routes/messages.ts");
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [], max_tokens: 100 }),
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleMessages(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("invalid_request_error");
    expect(typeof err.message).toBe("string");
  });

  it("returns {type: 'error', error: {type, message}} for unknown model", async () => {
    const { handleMessages } = await import("../src/routes/messages.ts");
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "nonexistent-model", messages: [], max_tokens: 100 }),
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleMessages(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("invalid_request_error");
  });
});

describe("OpenAI-style error shape (/v1/chat/completions)", () => {
  it("returns {error: {message, type}} for invalid JSON", async () => {
    const { handleChatCompletions } = await import("../src/routes/chat-completions.ts");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleChatCompletions(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof (body.error as Record<string, unknown>)?.message).toBe("string");
    expect(typeof (body.error as Record<string, unknown>)?.type).toBe("string");
    // OpenAI shape also has param and code
    const err = body.error as Record<string, unknown>;
    expect("param" in err).toBe(true);
    expect("code" in err).toBe(true);
  });

  it("returns {error: {message, type}} for missing model", async () => {
    const { handleChatCompletions } = await import("../src/routes/chat-completions.ts");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleChatCompletions(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("invalid_request_error");
    expect(typeof err.message).toBe("string");
  });

  it("returns {error: {message, type}} for unknown model", async () => {
    const { handleChatCompletions } = await import("../src/routes/chat-completions.ts");
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "nonexistent-model", messages: [] }),
      headers: { "Content-Type": "application/json" },
    });
    const { response } = await handleChatCompletions(req);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("invalid_request_error");
  });
});

describe("shared error helpers (src/errors.ts)", () => {
  it("anthropicError produces correct shape", async () => {
    const { anthropicError } = await import("../src/errors.ts");
    const resp = anthropicError(400, "invalid_request_error", "bad input");
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("invalid_request_error");
    expect(err.message).toBe("bad input");
  });

  it("openAIError produces correct shape", async () => {
    const { openAIError } = await import("../src/errors.ts");
    const resp = openAIError(401, "authentication_error", "unauthorized");
    expect(resp.status).toBe(401);
    const body = await resp.json() as Record<string, unknown>;
    const err = body.error as Record<string, unknown>;
    expect(err.message).toBe("unauthorized");
    expect(err.type).toBe("authentication_error");
    expect(err.param).toBeNull();
    expect(err.code).toBeNull();
  });
});
