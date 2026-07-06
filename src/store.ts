/**
 * JSON file persistence for application state.
 *
 * Stores: gitlabPat (nullable), gitlabPatSetAt (nullable ISO string).
 * The ephemeral direct-access token is NOT persisted here — it lives only
 * in memory in gitlab-direct-access.ts.
 *
 * Write strategy: temp file + atomic rename to avoid corruption on crash.
 * File permissions: 0600.
 */

import { mkdir, writeFile, readFile, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { log } from "./logger.ts";

export interface AppState {
  gitlabPat: string | null;
  gitlabPatSetAt: string | null;
}

const DEFAULT_STATE: AppState = {
  gitlabPat: null,
  gitlabPatSetAt: null,
};

// In-memory cache
let _state: AppState = { ...DEFAULT_STATE };
// Simple mutex: a promise chain for serializing writes
let _writeLock: Promise<void> = Promise.resolve();

function statePath(): string {
  return join(config.dataDir, "state.json");
}

function tempPath(): string {
  return join(config.dataDir, `state.${process.pid}.tmp`);
}

/** Load state from disk. Called once at startup. */
export async function loadState(): Promise<void> {
  const path = statePath();
  if (!existsSync(path)) {
    _state = { ...DEFAULT_STATE };
    return;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    _state = {
      gitlabPat: typeof parsed.gitlabPat === "string" ? parsed.gitlabPat : null,
      gitlabPatSetAt:
        typeof parsed.gitlabPatSetAt === "string"
          ? parsed.gitlabPatSetAt
          : null,
    };
  } catch (err) {
    log("warn", "[store] Failed to load state.json, using defaults:", err instanceof Error ? err.message : String(err));
    _state = { ...DEFAULT_STATE };
  }
}

/** Get a snapshot of the current in-memory state. */
export function getState(): Readonly<AppState> {
  return _state;
}

async function persistState(next: AppState): Promise<void> {
  const dir = config.dataDir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = tempPath();
  const data = JSON.stringify(next, null, 2);
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, statePath());
  // Ensure permissions on the final file (rename may inherit umask on some systems)
  try {
    await chmod(statePath(), 0o600);
  } catch {
    // Non-fatal: best effort
  }
}

/** Set the GitLab PAT. Serializes concurrent writes. */
export async function setGitlabPat(pat: string): Promise<void> {
  _writeLock = _writeLock.then(async () => {
    const next: AppState = {
      ..._state,
      gitlabPat: pat,
      gitlabPatSetAt: new Date().toISOString(),
    };
    await persistState(next);
    _state = next;
  });
  await _writeLock;
}

/** Clear the GitLab PAT. */
export async function clearGitlabPat(): Promise<void> {
  _writeLock = _writeLock.then(async () => {
    const next: AppState = {
      ..._state,
      gitlabPat: null,
      gitlabPatSetAt: null,
    };
    await persistState(next);
    _state = next;
  });
  await _writeLock;
}
