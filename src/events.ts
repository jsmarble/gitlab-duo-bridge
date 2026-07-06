/**
 * Internal normalized streaming event model.
 *
 * All upstream SSE streams (Anthropic and OpenAI Chat Completions) are decoded into
 * this union before being re-encoded into the client-facing wire format.
 * This keeps translation logic to one place and makes the codec testable
 * in isolation.
 */

export type StopReason = "stop" | "length" | "tool_calls" | "error";

export type InternalEvent =
  | { type: "start"; model: string; id: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string; index: number }
  | { type: "tool_call_delta"; id: string; argsDelta: string; index: number }
  | { type: "tool_call_end"; id: string; index: number }
  | { type: "stop"; reason: StopReason }
  | { type: "usage"; inputTokens: number; outputTokens: number };
