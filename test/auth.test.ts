/**
 * Tests for bearer key authentication.
 */

import { describe, it, expect, mock } from "bun:test";

// We need to control the config for these tests
let mockProxyApiKey = "test-secret-key-12345";

mock.module("../src/config.ts", () => ({
  config: {
    get proxyApiKey() { return mockProxyApiKey; },
    port: 3000,
    dataDir: "/tmp",
    logLevel: "error",
    version: "0.1.0-test",
  },
}));

// Import after mock is set up
const { checkBearerAuth } = await import("../src/auth.ts");

describe("checkBearerAuth", () => {
  it("returns ok=true for valid key", () => {
    const result = checkBearerAuth("Bearer test-secret-key-12345");
    expect(result.ok).toBe(true);
  });

  it("returns ok=false for wrong key", () => {
    const result = checkBearerAuth("Bearer wrong-key");
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for missing header", () => {
    const result = checkBearerAuth(null);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for empty header", () => {
    const result = checkBearerAuth("");
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for malformed header (no Bearer prefix)", () => {
    const result = checkBearerAuth("test-secret-key-12345");
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for partial key match", () => {
    const result = checkBearerAuth("Bearer test-secret-key");
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for key with extra characters", () => {
    const result = checkBearerAuth("Bearer test-secret-key-12345-extra");
    expect(result.ok).toBe(false);
  });

  it("FAIL-CLOSED: empty PROXY_API_KEY rejects all requests", () => {
    // This is the critical fail-closed behavior test
    const savedKey = mockProxyApiKey;
    mockProxyApiKey = "";
    try {
      // Even a request with the "correct" empty key should be rejected
      const result1 = checkBearerAuth("Bearer ");
      expect(result1.ok).toBe(false);

      // Any key should be rejected
      const result2 = checkBearerAuth("Bearer some-key");
      expect(result2.ok).toBe(false);

      // Null header should be rejected
      const result3 = checkBearerAuth(null);
      expect(result3.ok).toBe(false);
    } finally {
      mockProxyApiKey = savedKey;
    }
  });

  it("does not leak key information in error messages", () => {
    const result = checkBearerAuth("Bearer wrong-key");
    expect(result.ok).toBe(false);
    // Error message should not contain the actual key
    if (result.error) {
      expect(result.error).not.toContain("test-secret-key-12345");
      expect(result.error).not.toContain("wrong-key");
    }
  });

  // ---- x-api-key (Anthropic-style) support ----

  it("returns ok=true for valid key via x-api-key header", () => {
    const result = checkBearerAuth(null, "test-secret-key-12345");
    expect(result.ok).toBe(true);
  });

  it("returns ok=false for wrong key via x-api-key header", () => {
    const result = checkBearerAuth(null, "wrong-key");
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when both headers are absent", () => {
    const result = checkBearerAuth(null, null);
    expect(result.ok).toBe(false);
  });

  it("prefers a valid Authorization: Bearer over x-api-key", () => {
    const result = checkBearerAuth("Bearer test-secret-key-12345", "wrong-key");
    expect(result.ok).toBe(true);
  });

  it("falls back to x-api-key when Authorization is not a Bearer token", () => {
    // Bare (non-Bearer) Authorization value is ignored; x-api-key carries the key.
    const result = checkBearerAuth("test-secret-key-12345", "test-secret-key-12345");
    expect(result.ok).toBe(true);
  });

  it("FAIL-CLOSED: empty PROXY_API_KEY rejects x-api-key too", () => {
    const savedKey = mockProxyApiKey;
    mockProxyApiKey = "";
    try {
      expect(checkBearerAuth(null, "some-key").ok).toBe(false);
      expect(checkBearerAuth(null, "").ok).toBe(false);
    } finally {
      mockProxyApiKey = savedKey;
    }
  });
});
