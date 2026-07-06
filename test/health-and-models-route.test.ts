/**
 * Tests for /health and /v1/models route handlers.
 */

import { describe, it, expect } from "bun:test";
import { handleHealth } from "../src/routes/health.ts";
import { handleModels } from "../src/routes/models.ts";

describe("handleHealth", () => {
  it("returns 200 with status ok", async () => {
    const response = handleHealth();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("includes gitlabPatConfigured field", async () => {
    const response = handleHealth();
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.gitlabPatConfigured).toBe("boolean");
  });

  it("includes timestamp field", async () => {
    const response = handleHealth();
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.timestamp).toBe("string");
    // Should be a valid ISO date
    expect(new Date(body.timestamp as string).getTime()).not.toBeNaN();
  });
});

describe("handleModels", () => {
  it("returns 200 with object list shape", async () => {
    const response = handleModels();
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("each model has required fields", async () => {
    const response = handleModels();
    const body = await response.json() as { object: string; data: Array<Record<string, unknown>> };
    for (const model of body.data) {
      expect(typeof model.id).toBe("string");
      expect(model.object).toBe("model");
      expect(typeof model.created).toBe("number");
      expect(typeof model.owned_by).toBe("string");
    }
  });

  it("returns at least one model", async () => {
    const response = handleModels();
    const body = await response.json() as { object: string; data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// Test /v1/models 401 without auth — simulate the auth check logic
describe("/v1/models auth behavior", () => {
  it("checkBearerAuth rejects missing Authorization header", async () => {
    const { checkBearerAuth } = await import("../src/auth.ts");
    const result = checkBearerAuth(null);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("checkBearerAuth rejects wrong key", async () => {
    const { checkBearerAuth } = await import("../src/auth.ts");
    const result = checkBearerAuth("Bearer wrong-key");
    expect(result.ok).toBe(false);
  });
});
