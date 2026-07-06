/**
 * Main entry point — Bun.serve router.
 *
 * Routes:
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/messages           (bearer auth required)
 *   POST /v1/chat/completions   (bearer auth required)
 *   GET  /admin                 (no auth — network isolation)
 *   *    /admin/*               (no auth)
 */

import { config } from "./config.ts";
import { loadState } from "./store.ts";
import { checkBearerAuth } from "./auth.ts";
import { logActivity } from "./activity-log.ts";
import { handleHealth } from "./routes/health.ts";
import { handleModels } from "./routes/models.ts";
import { handleMessages } from "./routes/messages.ts";
import { handleChatCompletions } from "./routes/chat-completions.ts";
import { handleAdmin } from "./routes/admin.ts";
import { log } from "./logger.ts";

// Load persisted state before accepting requests
await loadState();

function openAIError(message: string, status: number): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", param: null, code: null } },
    { status }
  );
}

function anthropicError(message: string, status: number): Response {
  return Response.json(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status }
  );
}

const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: 10 * 1024 * 1024, // 10MB limit

  async fetch(req: Request): Promise<Response> {
    const start = Date.now();
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    let response: Response;
    let model: string | undefined;

    try {
      // Admin routes — no bearer auth
      if (path === "/admin" || path.startsWith("/admin/")) {
        response = await handleAdmin(req);
      }
      // Health — no bearer auth
      else if (path === "/health" && method === "GET") {
        response = handleHealth();
      }
      // Proxy routes — bearer auth required
      else if (
        path === "/v1/models" ||
        path === "/v1/messages" ||
        path === "/v1/chat/completions"
      ) {
        const authResult = checkBearerAuth(req.headers.get("Authorization"));
        if (!authResult.ok) {
          if (path === "/v1/messages") {
            response = anthropicError(
              authResult.error ?? "Unauthorized",
              401
            );
          } else {
            response = openAIError(authResult.error ?? "Unauthorized", 401);
          }
        } else if (path === "/v1/models" && method === "GET") {
          response = handleModels();
        } else if (path === "/v1/messages" && method === "POST") {
          // Peek at model for activity log (best-effort, don't fail on parse error)
          try {
            const cloned = req.clone();
            const body = (await cloned.json()) as { model?: string };
            model = body.model;
          } catch {
            // ignore
          }
          response = await handleMessages(req);
        } else if (path === "/v1/chat/completions" && method === "POST") {
          try {
            const cloned = req.clone();
            const body = (await cloned.json()) as { model?: string };
            model = body.model;
          } catch {
            // ignore
          }
          response = await handleChatCompletions(req);
        } else {
          response = openAIError("Method not allowed", 405);
        }
      } else {
        response = Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (err) {
      log("error", "[server] Unhandled error:", err instanceof Error ? err.message : String(err));
      response = Response.json(
        { error: { message: "Internal server error", type: "api_error" } },
        { status: 500 }
      );
    }

    const durationMs = Date.now() - start;
    logActivity({
      timestamp: new Date().toISOString(),
      method,
      path,
      model,
      statusCode: response.status,
      durationMs,
    });

    return response;
  },
});

log("info", `[gitlab-duo-bridge] Listening on port ${server.port}`);
log("info", `[gitlab-duo-bridge] Admin dashboard: http://localhost:${server.port}/admin`);
