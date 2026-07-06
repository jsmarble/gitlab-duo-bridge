/**
 * Bearer key authentication for proxy endpoints.
 *
 * Uses constant-time comparison to prevent timing attacks.
 * Fail-closed: empty PROXY_API_KEY rejects all requests.
 */

import { timingSafeEqual as nodeTSE } from "node:crypto";
import { config } from "./config.ts";

const encoder = new TextEncoder();

/**
 * Constant-time string comparison.
 * Pads both sides to the same length before comparing to avoid
 * length-based timing leaks.
 */
function timingSafeEqualSync(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);

  // Pad both to same length so the main compare is constant-time
  const aPadded = new Uint8Array(maxLen);
  const bPadded = new Uint8Array(maxLen);
  aPadded.set(aBytes);
  bPadded.set(bBytes);

  // Compare padded buffers (constant time for same-length buffers)
  const paddedEqual = nodeTSE(
    Buffer.from(aPadded),
    Buffer.from(bPadded)
  );
  // Also check original lengths match (not constant-time, but padding already
  // ensures the main comparison doesn't short-circuit on length)
  return paddedEqual && aBytes.length === bBytes.length;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/**
 * Check incoming credentials against PROXY_API_KEY.
 *
 * Accepts either authentication style, since the bridge exposes both an
 * OpenAI-compatible surface (which uses `Authorization: Bearer <key>`) and an
 * Anthropic-compatible surface (which uses the `x-api-key: <key>` header):
 *   - `Authorization: Bearer <key>`  (preferred when present)
 *   - `x-api-key: <key>`
 *
 * Returns {ok: false} if the key is missing, empty, or doesn't match.
 * Never reveals whether the key exists or what it is.
 */
export function checkBearerAuth(
  authHeader: string | null,
  apiKeyHeader?: string | null
): AuthResult {
  const expectedKey = config.proxyApiKey;

  // Fail-closed: if no key is configured, reject everything
  if (!expectedKey) {
    return { ok: false, error: "Proxy API key not configured" };
  }

  // Extract the presented key from whichever supported header carries it.
  let providedKey: string | null = null;
  const prefix = "Bearer ";
  if (authHeader && authHeader.startsWith(prefix)) {
    providedKey = authHeader.slice(prefix.length);
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader;
  }

  if (!providedKey) {
    return { ok: false, error: "Missing or malformed credentials" };
  }

  if (!timingSafeEqualSync(providedKey, expectedKey)) {
    return { ok: false, error: "Invalid API key" };
  }

  return { ok: true };
}
