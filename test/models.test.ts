/**
 * Tests for model registry.
 */

import { describe, it, expect } from "bun:test";
import { lookupModel, listModels } from "../src/models.ts";

describe("model registry", () => {
  it("looks up model by primary id", () => {
    const model = lookupModel("claude-sonnet-4-5");
    expect(model).toBeDefined();
    expect(model?.backend).toBe("anthropic");
    expect(model?.upstreamModel).toBe("claude-sonnet-4-5-20250929");
  });

  it("looks up model by alias (upstream id)", () => {
    const model = lookupModel("claude-sonnet-4-5-20250929");
    expect(model).toBeDefined();
    expect(model?.id).toBe("claude-sonnet-4-5");
    expect(model?.backend).toBe("anthropic");
  });

  it("looks up openai model by primary id", () => {
    const model = lookupModel("gpt-5.1");
    expect(model).toBeDefined();
    expect(model?.backend).toBe("openai");
    expect(model?.upstreamModel).toBe("gpt-5.1-2025-11-13");
  });

  it("looks up openai model by alias", () => {
    const model = lookupModel("gpt-5.1-2025-11-13");
    expect(model).toBeDefined();
    expect(model?.id).toBe("gpt-5.1");
  });

  it("returns undefined for unknown model (does not throw)", () => {
    const model = lookupModel("gpt-99-unknown");
    expect(model).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const model = lookupModel("");
    expect(model).toBeUndefined();
  });

  it("lists all models", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    // Should have both anthropic and openai models
    expect(models.some((m) => m.backend === "anthropic")).toBe(true);
    expect(models.some((m) => m.backend === "openai")).toBe(true);
  });

  it("all models have required fields", () => {
    const models = listModels();
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.backend).toMatch(/^(anthropic|openai)$/);
      expect(m.upstreamModel).toBeTruthy();
      expect(Array.isArray(m.aliases)).toBe(true);
    }
  });

  it("claude-opus-4-5 resolves correctly", () => {
    const m = lookupModel("claude-opus-4-5");
    expect(m?.upstreamModel).toBe("claude-opus-4-5-20251101");
  });

  it("claude-haiku-4-5 resolves correctly", () => {
    const m = lookupModel("claude-haiku-4-5");
    expect(m?.upstreamModel).toBe("claude-haiku-4-5-20251001");
  });

  it("gpt-5-mini resolves correctly", () => {
    const m = lookupModel("gpt-5-mini");
    expect(m?.upstreamModel).toBe("gpt-5-mini-2025-08-07");
  });

  it("gpt-5-codex resolves correctly", () => {
    const m = lookupModel("gpt-5-codex");
    expect(m?.upstreamModel).toBe("gpt-5-codex");
  });
});
