# GitLab Duo Bridge

A standalone Bun/TypeScript HTTP microservice that bridges [GitLab Duo AI Gateway](https://docs.gitlab.com/ee/user/gitlab_duo/) access to a plain OpenAI/Anthropic-compatible API. Designed to run in docker-compose next to another service (e.g. "Manifest").

## Why This Exists

GitLab Duo requires a **two-hop authentication flow** that no standard AI client library supports out of the box:

1. **Exchange a GitLab Personal Access Token (PAT)** for a short-lived "direct access" token via `POST /api/v4/ai/third_party_agents/direct_access`.
2. **Use that direct-access token** to call GitLab's AI Gateway proxy at `cloud.gitlab.com/ai/v1/proxy/...`.

This bridge handles the token exchange, caching, and refresh transparently, then exposes a standard Anthropic Messages API (`/v1/messages`) and OpenAI Chat Completions API (`/v1/chat/completions`) that any compatible client can use.

## Quick Start

### With Docker Compose

```bash
# 1. Copy and edit the env file
cp .env.example .env
# Edit .env: set PROXY_API_KEY to a strong random value

# 2. Copy the example compose file
cp docker-compose.example.yml docker-compose.yml
# Edit docker-compose.yml: fill in your manifest service image

# 3. Start
docker compose up -d

# 4. Open the admin dashboard to configure your GitLab PAT
open http://localhost:3000/admin
```

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
| `claude-opus-4-5` | Anthropic | `claude-opus-4-5-20251101` |
| `claude-sonnet-4-5` | Anthropic | `claude-sonnet-4-5-20250929` |
| `claude-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` |
| `gpt-5.1` | OpenAI | `gpt-5.1-2025-11-13` |
| `gpt-5-mini` | OpenAI | `gpt-5-mini-2025-08-07` |
| `gpt-5-codex` | OpenAI | `gpt-5-codex` |

Upstream model IDs are also accepted directly as aliases.

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

## Security Notes

### PAT Storage
The GitLab PAT is stored in `state.json` in the `DATA_DIR` volume. **Restrict volume access** to the container — do not mount it to a world-readable path. The file is created with mode `0600`.

### PROXY_API_KEY
This is the **only thing gating proxy access**. Use a strong random value (e.g. `openssl rand -hex 32`). It is never logged or displayed in the dashboard.

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
                     POST cloud.gitlab.com/ai/v1/proxy/openai/v1/responses
                          │
                          ▼
                     Decode OpenAI Responses SSE → Internal Events

Internal Events → Re-encode to client's expected format (Anthropic or OpenAI Chat)
```

## Development

```bash
bun test          # Run tests
bun run typecheck # Type-check (tsc --noEmit)
bun dev           # Dev server with hot reload
bun run build:docker  # Build Docker image
```
