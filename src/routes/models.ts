/**
 * GET /v1/models
 * Returns the list of registered models in OpenAI-compatible format.
 */

import { listModels } from "../models.ts";

export function handleModels(): Response {
  const models = listModels();
  const data = models.map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: "gitlab-duo-bridge",
    // Extra metadata for visibility
    backend: m.backend,
    upstream_model: m.upstreamModel,
    aliases: m.aliases,
  }));

  return Response.json({
    object: "list",
    data,
  });
}
