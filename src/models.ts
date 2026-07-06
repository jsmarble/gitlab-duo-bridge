/**
 * Model registry.
 *
 * Each entry has a primary `id` (client-facing), optional `aliases` (also
 * accepted as the `model` field), a `backend`, and the `upstreamModel` ID
 * sent to GitLab's AI Gateway proxy.
 *
 * Source of truth: GitLab's model-selection manifest (models.yml). Only models
 * marked `proxy_provider: anthropic|openai` there are reachable via the AI
 * Gateway proxy this bridge uses. `upstreamModel` mirrors that model's
 * `params.model` value (dated IDs where GitLab requires them).
 *
 * NOTE: This curated list drives `/v1/models` (discovery). Routing itself is
 * NOT limited to it — `lookupModel` falls back to prefix-based inference so a
 * newly-shipped GitLab model works immediately without a code change.
 */

export type Backend = "anthropic" | "openai";

export interface ModelEntry {
  id: string;
  aliases: string[];
  backend: Backend;
  upstreamModel: string;
}

const MODELS: ModelEntry[] = [
  // ---- Anthropic (GitLab Anthropic proxy) ----
  { id: "claude-opus-4-8", aliases: [], backend: "anthropic", upstreamModel: "claude-opus-4-8" },
  { id: "claude-opus-4-7", aliases: [], backend: "anthropic", upstreamModel: "claude-opus-4-7" },
  { id: "claude-opus-4-6", aliases: [], backend: "anthropic", upstreamModel: "claude-opus-4-6" },
  {
    id: "claude-opus-4-5",
    aliases: ["claude-opus-4-5-20251101"],
    backend: "anthropic",
    upstreamModel: "claude-opus-4-5-20251101",
  },
  { id: "claude-sonnet-5", aliases: [], backend: "anthropic", upstreamModel: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6", aliases: [], backend: "anthropic", upstreamModel: "claude-sonnet-4-6" },
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
  // ---- OpenAI (GitLab OpenAI proxy, Chat Completions) ----
  { id: "gpt-5.5", aliases: ["gpt-5.5-2026-04-23"], backend: "openai", upstreamModel: "gpt-5.5-2026-04-23" },
  { id: "gpt-5.4", aliases: ["gpt-5.4-2026-03-05"], backend: "openai", upstreamModel: "gpt-5.4-2026-03-05" },
  { id: "gpt-5.2", aliases: ["gpt-5.2-2025-12-11"], backend: "openai", upstreamModel: "gpt-5.2-2025-12-11" },
  { id: "gpt-5.1", aliases: ["gpt-5.1-2025-11-13"], backend: "openai", upstreamModel: "gpt-5.1-2025-11-13" },
  { id: "gpt-5.4-mini", aliases: [], backend: "openai", upstreamModel: "gpt-5.4-mini" },
  { id: "gpt-5.4-nano", aliases: [], backend: "openai", upstreamModel: "gpt-5.4-nano" },
];

// Build an O(1) lookup index over primary ids and aliases at module load.
const MODEL_INDEX = new Map<string, ModelEntry>();
for (const entry of MODELS) {
  MODEL_INDEX.set(entry.id, entry);
  for (const alias of entry.aliases) {
    MODEL_INDEX.set(alias, entry);
  }
}

/**
 * Infer a backend from a model ID prefix, for models not in the curated list.
 * Returns undefined if the prefix matches no known provider family.
 */
function inferBackend(modelId: string): Backend | undefined {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (
    lower.startsWith("gpt") ||
    lower.startsWith("chatgpt") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  ) {
    return "openai";
  }
  return undefined;
}

/**
 * Look up a model by primary id or alias. Falls back to prefix-based inference
 * (passing the model ID through unchanged as the upstream model) so models
 * GitLab adds after this build still route correctly. Returns undefined only
 * when the provider family can't be inferred.
 */
export function lookupModel(modelId: string): ModelEntry | undefined {
  const hit = MODEL_INDEX.get(modelId);
  if (hit) return hit;

  if (!modelId) return undefined;

  const backend = inferBackend(modelId);
  if (!backend) return undefined;

  // Not in the curated list, but the prefix identifies the provider — pass the
  // model ID straight through to GitLab's proxy (it gates what's actually allowed).
  return { id: modelId, aliases: [], backend, upstreamModel: modelId };
}

/** All registered models (for /v1/models and dashboard). */
export function listModels(): ModelEntry[] {
  return MODELS;
}
