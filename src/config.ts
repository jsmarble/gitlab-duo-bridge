/**
 * Environment variable loading and validation.
 * All config is read once at startup; missing required vars throw immediately.
 */

export interface Config {
  port: number;
  proxyApiKey: string;
  dataDir: string;
  logLevel: "debug" | "info" | "warn" | "error";
  version: string;
}

function loadConfig(): Config {
  const proxyApiKey = process.env.PROXY_API_KEY ?? "";
  // Empty PROXY_API_KEY is allowed at startup (dashboard can still be used),
  // but every proxy request will be rejected (fail-closed). We do NOT throw here
  // so the server can start and show the admin dashboard.

  const portStr = process.env.PORT ?? "3000";
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${portStr}`);
  }

  const logLevelRaw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const validLevels = ["debug", "info", "warn", "error"] as const;
  if (!validLevels.includes(logLevelRaw as (typeof validLevels)[number])) {
    throw new Error(`Invalid LOG_LEVEL: ${logLevelRaw}`);
  }
  const logLevel = logLevelRaw as Config["logLevel"];

  return {
    port,
    proxyApiKey,
    dataDir: process.env.DATA_DIR ?? "/data",
    logLevel,
    version: process.env.APP_VERSION ?? "0.0.0-dev",
  };
}

export const config: Config = loadConfig();
