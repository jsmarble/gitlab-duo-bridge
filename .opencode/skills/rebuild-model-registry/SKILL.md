---
name: rebuild-model-registry
description: >
  Rebuild or refresh the GitLab Duo model list in this bridge (src/models.ts and
  /v1/models) from GitLab's official model-selection manifest. Use when the model
  registry is stale or incomplete, when /v1/models returns old model versions,
  when a client (e.g. Manifest) reports a model is missing or unavailable, or when
  GitLab ships new Duo models (new Claude Opus/Sonnet/Haiku or GPT-5.x releases)
  that should be selectable through the bridge. Explains the authoritative source
  (models.yml), how to fetch and filter it, and exactly how to map it into the
  bridge's ModelEntry registry.
---

# Rebuild the model registry from GitLab's manifest

The bridge's model list in `src/models.ts` is a curated snapshot. GitLab ships new
Duo models roughly monthly, so the list drifts. This skill rebuilds it from the
authoritative source.

## Authoritative source of truth

GitLab publishes the model-selection manifest in the AI Gateway repo:

```
https://gitlab.com/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/raw/main/ai_gateway/model_selection/models.yml
```

This is THE list GitLab's AI Gateway uses. Each entry has `name`,
`gitlab_identifier`, a `params.model` (the real provider model id), optional
`deprecation`, and — critically — an optional **`proxy_provider`** field.

## The one rule that matters: `proxy_provider`

This bridge talks to GitLab's **proxy** endpoints
(`/ai/v1/proxy/anthropic/...` and `/ai/v1/proxy/openai/v1/chat/completions`).
Only manifest entries with a **`proxy_provider:`** of `anthropic` or `openai`
are reachable that way. Entries without `proxy_provider` (Vertex/Bedrock
duplicates, Fireworks/Mistral/Gemini/self-hosted, embeddings) are NOT
proxy-routable — **ignore them**.

- `proxy_provider: anthropic` → bridge `backend: "anthropic"`
- `proxy_provider: openai`    → bridge `backend: "openai"`
- `upstreamModel`             → that entry's `params.model` value (verbatim,
  including dated suffixes like `claude-sonnet-4-5-20250929` when present)

## Fetch + extract the candidates

With `yq` (preferred):

```bash
URL="https://gitlab.com/gitlab-org/modelops/applied-ml/code-suggestions/ai-assist/-/raw/main/ai_gateway/model_selection/models.yml"
curl -fsSL "$URL" | yq -r '
  .models[]
  | select(.proxy_provider == "anthropic" or .proxy_provider == "openai")
  | [.proxy_provider, .params.model, (.deprecation.removal_version // ""), .name] | @tsv
'
```

Without `yq`, fetch the file and read it directly — it is plain, regular YAML;
scan for blocks containing a `proxy_provider:` line and read the sibling
`params: model:` value. (This is exactly how the list was last built.)

## Map into `src/models.ts`

Each surviving candidate becomes a `ModelEntry`:

```ts
{ id: "<friendly-id>", aliases: ["<dated-upstream-id?>"], backend: "<anthropic|openai>", upstreamModel: "<params.model>" }
```

Conventions used in this repo (match them):

- **Friendly `id`**: the marketing version, dot-style for GPT
  (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`) and dash-style for Claude
  (`claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`).
- **`upstreamModel`**: the manifest `params.model` exactly. This is what gets
  sent to the proxy; GitLab only accepts the ids in its manifest.
- **`aliases`**: when `params.model` is a dated id (e.g.
  `claude-sonnet-4-5-20250929`, `gpt-5.4-2026-03-05`), add it as an alias so
  clients can request either the friendly id or the exact dated id. When the
  friendly id and `params.model` are identical (e.g. `claude-opus-4-6`), leave
  `aliases: []`.
- **Ordering**: newest first within each backend (helps clients that pick the
  top entry). Anthropic block first, then OpenAI, matching the current file.

### Deprecation handling

Prefer NOT to feature models whose `deprecation.deprecation_date` is already in
the past (they're on the way out — e.g. `gpt-5-mini`, `gpt-5-codex`,
`gpt-5.1-codex`, `gpt-5.2-codex` were past-dated at last rebuild). They still
work while live, and the prefix fallback (below) will still route them if a
client asks explicitly — they just don't need to clutter `/v1/models`. Keep the
current non-deprecated codex (`gpt-5.3-codex`) as the representative codex entry.

### You do NOT need to be exhaustive

`lookupModel()` has a **prefix fallback**: any id starting with `claude` routes
to the Anthropic backend and any `gpt`/`chatgpt`/`o1`/`o3`/`o4` routes to OpenAI,
passing the id straight through as `upstreamModel`. So a model GitLab adds after
this rebuild still *works* when requested by exact id — it just won't appear in
`/v1/models` until the curated list is refreshed. The curated list is for
discovery UX; routing is resilient without it. Do not remove the fallback.

## Files to update

1. `src/models.ts` — the `MODELS` array (the only real change).
2. `test/models.test.ts` — update the per-model assertions if you added/removed
   models; keep the fallback + `listModels`-excludes-fallback tests.
3. `README.md` — the "Supported Models" table.
4. Dashboard (`src/routes/admin.ts`) and `/v1/models` need no change — both read
   from `listModels()` automatically.

## Verify

```bash
bun run typecheck && bun test
```

Then, against a running bridge (all docker work runs on the `docker3` context),
confirm the list and that a newly-added model actually round-trips end-to-end:

```bash
B=http://10.2.2.4:3003 ; K=<PROXY_API_KEY>
curl -s -H "Authorization: Bearer $K" $B/v1/models | jq '.data[].id'
# pick a newly added id and send a tiny completion (GPT-5 reasoning models
# need a few hundred max_completion_tokens or content comes back empty):
curl -s -H "Authorization: Bearer $K" -X POST $B/v1/chat/completions \
  -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"reply: ok"}]}' | jq .
```

A `400` with `no valid model` (or similar) means GitLab doesn't actually expose
that `params.model` on this instance/subscription — drop it from the curated list.

## Future improvement (not yet implemented)

The manifest could be fetched and parsed at runtime (cached, with the current
static list as offline fallback) so `/v1/models` never goes stale. Deferred
because it adds a network dependency + YAML parsing; the prefix fallback already
guarantees routing works for unlisted models. Revisit if keeping the discovery
list current by hand becomes a burden.
