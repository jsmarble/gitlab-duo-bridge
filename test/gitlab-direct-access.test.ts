/**
 * Tests for GitLab Direct Access Token Manager.
 *
 * Uses mock fetch to avoid real network calls.
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import {
  getDirectAccessToken,
  invalidateDirectAccessToken,
  _resetForTest,
  _getCachedForTest,
  GitLabPatMissingError,
} from "../src/gitlab-direct-access.ts";

// We need to mock the store module
const mockState = { gitlabPat: null as string | null, gitlabPatSetAt: null as string | null };

// Mock store module
mock.module("../src/store.ts", () => ({
  getState: () => mockState,
  loadState: async () => {},
  setGitlabPat: async (pat: string) => { mockState.gitlabPat = pat; },
  clearGitlabPat: async () => { mockState.gitlabPat = null; },
}));

// Mock config
mock.module("../src/config.ts", () => ({
  config: { version: "0.1.0-test", port: 3000, proxyApiKey: "test-key", dataDir: "/tmp", logLevel: "error" },
}));

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const FUTURE_EXPIRES = NOW_SECONDS + 3600; // 1 hour from now
const NEAR_EXPIRES = NOW_SECONDS + 60;     // 60 seconds from now (within 300s buffer)

function makeTokenResponse(expiresAt: number) {
  return {
    token: "test-direct-access-token",
    headers: { "x-gitlab-something": "value", "x-api-key": "should-be-stripped" },
    expires_at: expiresAt,
  };
}

describe("GitLab Direct Access Token Manager", () => {
  beforeEach(() => {
    _resetForTest();
    mockState.gitlabPat = "glpat-testtoken123";
  });

  afterEach(() => {
    _resetForTest();
  });

  it("throws GitLabPatMissingError when no PAT is configured", async () => {
    mockState.gitlabPat = null;
    await expect(getDirectAccessToken()).rejects.toBeInstanceOf(GitLabPatMissingError);
  });

  it("fetches a new token when cache is empty", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const token = await getDirectAccessToken();
    expect(token.token).toBe("test-direct-access-token");
    expect(token.expiresAt).toBe(FUTURE_EXPIRES);
    // x-api-key should be stripped
    expect(token.headers["x-api-key"]).toBeUndefined();
    expect(token.headers["x-gitlab-something"]).toBe("value");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached token on second call", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getDirectAccessToken();
    await getDirectAccessToken();
    // Should only fetch once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes token when within 5-minute buffer window", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // First fetch
    await getDirectAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Manually set cache to near-expiry (within 300s buffer)
    _resetForTest();
    // Inject a near-expiry token by fetching with a near-expiry response
    const fetchMock2 = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(NEAR_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock2 as unknown as typeof fetch;
    await getDirectAccessToken(); // fetches near-expiry token
    expect(fetchMock2).toHaveBeenCalledTimes(1);

    // Now the cached token is within the 300s buffer, so next call should refresh
    const fetchMock3 = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock3 as unknown as typeof fetch;
    await getDirectAccessToken();
    expect(fetchMock3).toHaveBeenCalledTimes(1);
  });

  it("single-flight: concurrent requests share one fetch", async () => {
    let resolveFirst!: (v: Response) => void;
    const firstFetchPromise = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });

    let fetchCallCount = 0;
    const fetchMock = mock(async () => {
      fetchCallCount++;
      return firstFetchPromise;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Start 5 concurrent requests
    const promises = Array.from({ length: 5 }, () => getDirectAccessToken());

    // Resolve the fetch
    resolveFirst(
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const results = await Promise.all(promises);
    // All should get the same token
    for (const r of results) {
      expect(r.token).toBe("test-direct-access-token");
    }
    // Only one fetch should have been made
    expect(fetchCallCount).toBe(1);
  });

  it("graceful degradation: uses stale token if refresh fails", async () => {
    // First, populate cache with a token that's past the buffer but not expired
    const staleExpiry = NOW_SECONDS + 60; // 60s left, within 300s buffer
    const fetchMock1 = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(staleExpiry)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock1 as unknown as typeof fetch;
    await getDirectAccessToken();

    // Now make refresh fail
    const fetchMock2 = mock(async () => {
      throw new Error("Network error");
    });
    globalThis.fetch = fetchMock2 as unknown as typeof fetch;

    // Should return stale token without throwing
    const warnSpy = mock(() => {});
    const origWarn = console.warn;
    console.warn = warnSpy;
    try {
      const token = await getDirectAccessToken();
      expect(token.token).toBe("test-direct-access-token");
    } finally {
      console.warn = origWarn;
    }
  });

  it("throws when refresh fails and no valid cached token", async () => {
    const fetchMock = mock(async () => {
      throw new Error("Network error");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getDirectAccessToken()).rejects.toThrow("Network error");
  });

  it("invalidate() clears cache so next call re-fetches", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify(makeTokenResponse(FUTURE_EXPIRES)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getDirectAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    invalidateDirectAccessToken();
    expect(_getCachedForTest()).toBeNull();

    await getDirectAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
