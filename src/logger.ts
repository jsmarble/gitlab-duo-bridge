/**
 * Minimal leveled logger.
 *
 * Compares the call's level against config.logLevel and only logs if
 * the call's level is >= the configured minimum level.
 *
 * Level order: debug < info < warn < error
 */

import { config } from "./config.ts";

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function log(
  level: "debug" | "info" | "warn" | "error",
  ...args: unknown[]
): void {
  const configuredLevel = config.logLevel;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) {
    return;
  }
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}
