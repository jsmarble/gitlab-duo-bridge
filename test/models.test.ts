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

  it("looks up model by alias (dated upstream id)", () => {
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

  it("includes current Claude models (opus/sonnet 4.6, sonnet 5)", () => {
    expect(lookupModel("claude-opus-4-6")?.upstreamModel).toBe("claude-opus-4-6");
    expect(lookupModel("claude-sonnet-4-6")?.upstreamModel).toBe("claude-sonnet-4-6");
    expect(lookupModel("claude-sonnet-5")?.backend).toBe("anthropic");
  });

  it("includes current GPT models (5.2, 5.4, 5.5, 5.4-mini)", () => {
    expect(lookupModel("gpt-5.4")?.upstreamModel).toBe("gpt-5.4-2026-03-05");
    expect(lookupModel("gpt-5.5")?.upstreamModel).toBe("gpt-5.5-2026-04-23");
    expect(lookupModel("gpt-5.2")?.upstreamModel).toBe("gpt-5.2-2025-12-11");
    expect(lookupModel("gpt-5.4-mini")?.backend).toBe("openai");
  });

  it("falls back to prefix inference for unlisted Claude models (pass-through)", () => {
    // Not in the curated list, but claude* -> anthropic, id sent as-is.
    const m = lookupModel("claude-opus-4-99");
    expect(m).toBeDefined();
    expect(m?.backend).toBe("anthropic");
    expect(m?.upstreamModel).toBe("claude-opus-4-99");
  });

  it("falls back to prefix inference for unlisted GPT models (pass-through)", () => {
    const m = lookupModel("gpt-6-turbo");
    expect(m).toBeDefined();
    expect(m?.backend).toBe("openai");
    expect(m?.upstreamModel).toBe("gpt-6-turbo");
  });

  it("returns undefined when the provider family can't be inferred", () => {
    expect(lookupModel("mystery-model-x")).toBeUndefined();
    expect(lookupModel("llama-3")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(lookupModel("")).toBeUndefined();
  });

  it("listModels returns only the curated set (not fallback-resolved ids)", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.backend === "anthropic")).toBe(true);
    expect(models.some((m) => m.backend === "openai")).toBe(true);
    // Fallback-only ids must not leak into the discovery list.
    expect(models.some((m) => m.id === "gpt-6-turbo")).toBe(false);
    expect(models.some((m) => m.id === "claude-opus-4-99")).toBe(false);
  });

  it("all listed models have required fields", () => {
    for (const m of listModels()) {
      expect(m.id).toBeTruthy();
      expect(m.backend).toMatch(/^(anthropic|openai)$/);
      expect(m.upstreamModel).toBeTruthy();
      expect(Array.isArray(m.aliases)).toBe(true);
    }
  });

  it("claude-opus-4-5 / haiku-4-5 keep their dated upstream ids", () => {
    expect(lookupModel("claude-opus-4-5")?.upstreamModel).toBe("claude-opus-4-5-20251101");
    expect(lookupModel("claude-haiku-4-5")?.upstreamModel).toBe("claude-haiku-4-5-20251001");
  });
});
