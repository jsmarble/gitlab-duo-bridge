# GitLab Duo Bridge

A standalone Bun/TypeScript HTTP microservice that bridges [GitLab Duo AI Gateway](https://docs.gitlab.com/ee/user/gitlab_duo/) access to a plain OpenAI/Anthropic-compatible API. Designed to run in docker-compose next to another service (e.g. "Manifest").

## Why This Exists

GitLab Duo requires a **two-hop authentication flow** that no standard AI client library supports out of the box:

1. **Exchange a GitLab Personal Access Token (PAT)** for a short-lived "direct access" token via `POST /api/v4/ai/third_party_agents/direct_access`.
2. **Use that direct-access token** to call GitLab's AI Gateway proxy at `cloud.gitlab.com/ai/v1/proxy/...`.

This bridge handles the token exchange, caching, and refresh transparently, then exposes a standard Anthropic Messages API (`/v1/messages`) and OpenAI Chat Completions API (`/v1/chat/completions`) that any compatible client can use.

## Quick Start

### Docker (single container)

```bash
# Generate a strong client key (save it — clients present it as a Bearer token)
export PROXY_API_KEY="$(openssl rand -hex 32)"

docker run -d --name gitlab-duo-bridge \
  -p 127.0.0.1:3000:3000 \
  -e PROXY_API_KEY="$PROXY_API_KEY" \
  -v duo_bridge_data:/data \
  ghcr.io/jsmarble/gitlab-duo-bridge:latest

# Open the admin dashboard to configure your GitLab PAT
open http://localhost:3000/admin
```

The `-v duo_bridge_data:/data` volume persists the stored GitLab PAT across restarts. The port is bound to `127.0.0.1` so the (unauthenticated) admin dashboard is not exposed publicly.

### Docker Compose

```bash
# 1. Copy and edit the env file
cp .env.example .env
# Edit .env: set PROXY_API_KEY to a strong random value

# 2. Copy the example compose file (it pulls ghcr.io/jsmarble/gitlab-duo-bridge)
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml: fill in your manifest service image

# 3. Start
docker compose up -d

# 4. Open the admin dashboard to configure your GitLab PAT
open http://localhost:3000/admin
```

> **Note:** GHCR packages default to **private**. To pull the image, either make the
> package public (repo → Packages → package settings), or authenticate first:
> `echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin`.
> To build locally instead of pulling, use `docker build -t gitlab-duo-bridge .`
> and set `build: .` in the compose file.

### Local Development

```bash
bun install
cp .env.example .env
# Edit .env

bun dev
# Dashboard: http://localhost:3000/admin
```

## Pointing Manifest at the Bridge

**Anthropic-compatible mode** (for Claude models):
```
Base URL: http://gitlab-duo-bridge:3000
API Key:  <PROXY_API_KEY>
Endpoint: POST /v1/messages
```

**OpenAI-compatible mode** (for GPT models, or Claude via translation):
```
Base URL: http://gitlab-duo-bridge:3000/v1
API Key:  <PROXY_API_KEY>
Endpoint: POST /v1/chat/completions
```

## Supported Models

| Client Model ID | Backend | Upstream Model |
|---|---|---|
| `claude-opus-4-8` | Anthropic | `claude-opus-4-8` |
| `claude-opus-4-7` | Anthropic | `claude-opus-4-7` |
| `claude-opus-4-6` | Anthropic | `claude-opus-4-6` |
| `claude-opus-4-5` | Anthropic | `claude-opus-4-5-20251101` |
| `claude-sonnet-5` | Anthropic | `claude-sonnet-5` |
| `claude-sonnet-4-6` | Anthropic | `claude-sonnet-4-6` |
| `claude-sonnet-4-5` | Anthropic | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` |
| `gpt-5.5` | OpenAI | `gpt-5.5-2026-04-23` |
| `gpt-5.4` | OpenAI | `gpt-5.4-2026-03-05` |
| `gpt-5.2` | OpenAI | `gpt-5.2-2025-12-11` |
| `gpt-5.1` | OpenAI | `gpt-5.1-2025-11-13` |
| `gpt-5.4-mini` | OpenAI | `gpt-5.4-mini` |
| `gpt-5.4-nano` | OpenAI | `gpt-5.4-nano` |

Dated upstream IDs are also accepted directly as aliases (e.g. `gpt-5.4-2026-03-05`).

This list mirrors the proxy-routable models in GitLab's model-selection manifest.
It's a curated snapshot for discovery — **routing is not limited to it**: any
`claude*` id routes to the Anthropic backend and any `gpt*`/`o*` id to the OpenAI
backend and is passed through as-is, so a model GitLab ships after this build works
by exact id even before it's listed here. To refresh the list from GitLab's
manifest, load the `rebuild-model-registry` skill (`.opencode/skills/`).

> **GPT-5 note:** the OpenAI-backed models are reasoning models. Reasoning
> tokens count against the completion budget, so a very small limit can be
> consumed entirely by reasoning and return empty content. Give them adequate
> room (e.g. a few hundred tokens). Clients may send either `max_tokens` or
> `max_completion_tokens`; the bridge forwards it as `max_completion_tokens`,
> which GitLab's GPT-5 proxy requires.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXY_API_KEY` | **Yes** | — | Bearer token clients must present. Missing = all proxy requests rejected. |
| `PORT` | No | `3000` | HTTP port to listen on. |
| `DATA_DIR` | No | `/data` | Directory for `state.json` (stores GitLab PAT). |
| `LOG_LEVEL` | No | `info` | Log verbosity: `debug`, `info`, `warn`, `error`. |

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Health check |
| `GET` | `/v1/models` | Bearer | List registered models |
| `POST` | `/v1/messages` | Bearer | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | Bearer | OpenAI Chat Completions API |
| `GET` | `/admin` | None | Admin dashboard |
| `GET/POST/DELETE` | `/admin/api/*` | None | Dashboard API |

## Container Images

Multi-arch (`linux/amd64`, `linux/arm64`) images are published to GitHub Container Registry on every push to the default branch:

```bash
docker pull ghcr.io/jsmarble/gitlab-duo-bridge:latest
# or pin a specific version / minor line / commit:
docker pull ghcr.io/jsmarble/gitlab-duo-bridge:1.4.2
docker pull ghcr.io/jsmarble/gitlab-duo-bridge:1.4
docker pull ghcr.io/jsmarble/gitlab-duo-bridge:sha-abc1234
```

Available tags:

| Tag | Meaning |
|---|---|
| `latest` | Most recent default-branch build |
| `X.Y.Z` | Exact semantic version (immutable) |
| `X.Y` | Latest patch on that minor line |
| `sha-<short>` | Exact commit, for precise pinning |

The running image self-reports its version (baked in at build time via the `APP_VERSION` build arg) in the `User-Agent` it sends to GitLab's AI Gateway.

## Versioning

Versions are derived automatically on every build from [Conventional Commits](https://www.conventionalcommits.org/) since the last release tag — no manual version bumping:

| Commit prefix | Bump | Example |
|---|---|---|
| `fix:`, `chore:`, `docs:`, `refactor:`, … | patch | `1.4.2` → `1.4.3` |
| `feat:` | minor | `1.4.2` → `1.5.0` |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` in body | major | `1.4.2` → `2.0.0` |

Each default-branch build computes the next version, publishes the image with the tags above, and creates a matching git tag + GitHub Release (with auto-generated notes). Pull requests build both architectures for validation but do not push or release.

## Security Notes

### PAT Storage
The GitLab PAT is stored in `state.json` in the `DATA_DIR` volume. **Restrict volume access** to the container — do not mount it to a world-readable path. The file is created with mode `0600`.

### PROXY_API_KEY
This is the **only thing gating proxy access**. Use a strong random value (e.g. `openssl rand -hex 32`). It is never logged or displayed in the dashboard.

Clients may present it in either style — the bridge accepts both because it exposes both API surfaces:
- `Authorization: Bearer <key>` (OpenAI-style)
- `x-api-key: <key>` (Anthropic-style)

### Admin Dashboard
The `/admin` routes have **no authentication** — they rely entirely on network isolation. **Do not expose port 3000 publicly.** In the example compose file, the port is bound to `127.0.0.1` only. In production, consider putting the admin dashboard behind a VPN or SSH tunnel.

### Token Caching
The direct-access token is cached **in memory only** and never persisted to disk. It is automatically refreshed 5 minutes before expiry. On restart, the first request triggers a fresh token fetch.

## Architecture

```
Client Request
    │
    ▼
Bearer Auth Check (PROXY_API_KEY)
    │
    ▼
Model Registry Lookup
    │
    ├─ anthropic backend ──► Translate request (if needed)
    │                         │
    │                         ▼
    │                    GitLab Direct Access Token (cached, single-flight)
    │                         │
    │                         ▼
    │                    POST cloud.gitlab.com/ai/v1/proxy/anthropic/v1/messages
    │                         │
    │                         ▼
    │                    Decode Anthropic SSE → Internal Events
    │
    └─ openai backend ──► Translate request (if needed)
                          │
                          ▼
                     GitLab Direct Access Token (cached, single-flight)
                          │
                          ▼
                     POST cloud.gitlab.com/ai/v1/proxy/openai/v1/chat/completions
                          │
                          ▼
                     Decode OpenAI Chat Completions SSE → Internal Events

Internal Events → Re-encode to client's expected format (Anthropic or OpenAI Chat)
```

The bridge uses a **normalized internal event model** (`InternalEvent` union) as the common currency between all upstream decoders and downstream encoders. This means:

- `/v1/messages` with a Claude model → Anthropic Messages upstream → Anthropic SSE decoder → re-encode as Anthropic Messages response
- `/v1/messages` with a GPT model → OpenAI Chat Completions upstream → Chat Completions decoder → re-encode as Anthropic Messages response
- `/v1/chat/completions` with a Claude model → Anthropic Messages upstream → Anthropic SSE decoder → re-encode as Chat Completions response
- `/v1/chat/completions` with a GPT model → OpenAI Chat Completions upstream → Chat Completions decoder → re-encode as Chat Completions response

## Development

```bash
bun test          # Run tests
bun run typecheck # Type-check (tsc --noEmit)
bun dev           # Dev server with hot reload
bun run build:docker  # Build Docker image
```
