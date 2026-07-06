/**
 * GitLab Direct Access Token Manager.
 *
 * Implements the two-hop auth flow:
 * 1. Exchange PAT for a short-lived direct-access token
 * 2. Cache the token with 5-minute early-refresh buffer
 * 3. Single-flight: concurrent requests during refresh share one fetch
 * 4. Graceful degradation: if refresh fails but cached token still valid, keep using it
 * 5. Reactive invalidation: call invalidate() on 401 from downstream
 */

import { getState } from "./store.ts";
import { config } from "./config.ts";
import { log } from "./logger.ts";

const GITLAB_DIRECT_ACCESS_URL =
  "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";

const REFRESH_BUFFER_SECONDS = 300; // 5 minutes

export interface DirectAccessToken {
  token: string;
  /** Extra headers to forward (x-api-key already stripped) */
  headers: Record<string, string>;
  /** Unix timestamp (seconds) when this token expires */
  expiresAt: number;
}

interface RawDirectAccessResponse {
  token: string;
  headers: Record<string, string>;
  expires_at: number;
}

// In-memory cache
let _cached: DirectAccessToken | null = null;
// Single-flight: if a fetch is in progress, this promise resolves to the result
let _inflight: Promise<DirectAccessToken> | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isTokenValid(token: DirectAccessToken): boolean {
  return nowSeconds() < token.expiresAt - REFRESH_BUFFER_SECONDS;
}

async function fetchDirectAccessToken(pat: string): Promise<DirectAccessToken> {
  const resp = await fetch(GITLAB_DIRECT_ACCESS_URL, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": pat,
      "Content-Type": "application/json",
      "User-Agent": `gitlab-duo-bridge/${config.version}`,
    },
    body: JSON.stringify({
      feature_flags: {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "(unreadable)");
    log("error", `[direct-access] Token fetch failed: HTTP ${resp.status} — ${body}`);
    throw new Error(
      `GitLab direct-access token fetch failed: HTTP ${resp.status}`
    );
  }

  const data = (await resp.json()) as RawDirectAccessResponse;

  // Strip x-api-key from the returned headers — it conflicts with the
  // Authorization: Bearer we set ourselves for downstream proxy calls.
  const { "x-api-key": _stripped, ...safeHeaders } = data.headers ?? {};

  return {
    token: data.token,
    headers: safeHeaders as Record<string, string>,
    expiresAt: data.expires_at,
  };
}

/**
 * Get a valid direct-access token, refreshing if needed.
 * Throws if no PAT is configured or if refresh fails with no valid cached token.
 */
export async function getDirectAccessToken(): Promise<DirectAccessToken> {
  // Fast path: cached token still valid
  if (_cached && isTokenValid(_cached)) {
    return _cached;
  }

  // If a refresh is already in flight, wait for it
  if (_inflight) {
    try {
      return await _inflight;
    } catch {
      // If the inflight failed, fall through to try again or use stale cache
    }
  }

  const pat = getState().gitlabPat;
  if (!pat) {
    throw new GitLabPatMissingError(
      "No GitLab PAT configured. Visit the admin dashboard to set one."
    );
  }

  // Start a new refresh
  _inflight = fetchDirectAccessToken(pat).then(
    (token) => {
      _cached = token;
      _inflight = null;
      return token;
    },
    (err) => {
      _inflight = null;
      throw err;
    }
  );

  try {
    return await _inflight;
  } catch (err) {
    // Graceful degradation: if we have a stale-but-not-yet-expired token, keep using it
    if (_cached && nowSeconds() < _cached.expiresAt) {
      log(
        "warn",
        "[direct-access] Token refresh failed, using stale cached token:",
        err instanceof Error ? err.message : String(err)
      );
      return _cached;
    }
    throw err;
  }
}

/**
 * Invalidate the cached token (call on 401 from downstream).
 * The next call to getDirectAccessToken() will trigger a fresh fetch.
 */
export function invalidateDirectAccessToken(): void {
  _cached = null;
}

/** Reset all state (for testing). */
export function _resetForTest(): void {
  _cached = null;
  _inflight = null;
}

/** Expose cache state for testing. */
export function _getCachedForTest(): DirectAccessToken | null {
  return _cached;
}

export class GitLabPatMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitLabPatMissingError";
  }
}
