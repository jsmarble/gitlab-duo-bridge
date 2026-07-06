/**
 * Model registry.
 *
 * Each entry has a primary `id` (client-facing), optional `aliases` (also
 * accepted as the `model` field), a `backend`, and the `upstreamModel` ID
 * to send to GitLab's AI Gateway.
 *
 * Adding a new model is a one-line diff in the MODELS array.
 */

export type Backend = "anthropic" | "openai";

export interface ModelEntry {
  id: string;
  aliases: string[];
  backend: Backend;
  upstreamModel: string;
}

const MODELS: ModelEntry[] = [
  // Anthropic-backed
  {
    id: "claude-opus-4-5",
    aliases: ["claude-opus-4-5-20251101"],
    backend: "anthropic",
    upstreamModel: "claude-opus-4-5-20251101",
  },
  {
    id: "claude-sonnet-4-5",
    aliases: ["claude-sonnet-4-5-20250929"],
    backend: "anthropic",
    upstreamModel: "claude-sonnet-4-5-20250929",
  },
  {
    id: "claude-haiku-4-5",
    aliases: ["claude-haiku-4-5-20251001"],
    backend: "anthropic",
    upstreamModel: "claude-haiku-4-5-20251001",
  },
  // OpenAI-backed
  {
    id: "gpt-5.1",
    aliases: ["gpt-5.1-2025-11-13"],
    backend: "openai",
    upstreamModel: "gpt-5.1-2025-11-13",
  },
  {
    id: "gpt-5-mini",
    aliases: ["gpt-5-mini-2025-08-07"],
    backend: "openai",
    upstreamModel: "gpt-5-mini-2025-08-07",
  },
  {
    id: "gpt-5-codex",
    aliases: [],
    backend: "openai",
    upstreamModel: "gpt-5-codex",
  },
];

// Build an O(1) lookup index over primary ids and aliases at module load.
const MODEL_INDEX = new Map<string, ModelEntry>();
for (const entry of MODELS) {
  MODEL_INDEX.set(entry.id, entry);
  for (const alias of entry.aliases) {
    MODEL_INDEX.set(alias, entry);
  }
}

/** Look up a model by primary id or any alias. Returns undefined if not found. */
export function lookupModel(modelId: string): ModelEntry | undefined {
  return MODEL_INDEX.get(modelId);
}

/** All registered models (for /v1/models and dashboard). */
export function listModels(): ModelEntry[] {
  return MODELS;
}
