/**
 * GET /health
 * Returns service health status without exposing secrets.
 */

import { getState } from "../store.ts";

export function handleHealth(): Response {
  const state = getState();
  const hasGitlabPat = state.gitlabPat !== null;

  return Response.json({
    status: "ok",
    gitlabPatConfigured: hasGitlabPat,
    timestamp: new Date().toISOString(),
  });
}
