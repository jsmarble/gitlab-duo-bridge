/**
 * Tests for the leveled logger.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";

// We need to control config.logLevel for testing.
// We do this by directly mocking the config module's logLevel.

describe("logger level filtering", () => {
  // Spies on console methods
  let debugSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    infoSpy = spyOn(console, "info").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs at or above the configured level", async () => {
    // Dynamically import config and logger so we can manipulate config
    const configMod = await import("../src/config.ts");
    const originalLevel = configMod.config.logLevel;

    // Set level to "warn" — only warn and error should fire
    (configMod.config as { logLevel: string }).logLevel = "warn";

    // Re-import logger fresh (it reads config at call time, not import time)
    const { log } = await import("../src/logger.ts");

    log("debug", "debug message");
    log("info", "info message");
    log("warn", "warn message");
    log("error", "error message");

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("warn message");
    expect(errorSpy).toHaveBeenCalledWith("error message");

    // Restore
    (configMod.config as { logLevel: string }).logLevel = originalLevel;
  });

  it("suppresses info when level is error", async () => {
    const configMod = await import("../src/config.ts");
    const originalLevel = configMod.config.logLevel;

    (configMod.config as { logLevel: string }).logLevel = "error";

    const { log } = await import("../src/logger.ts");

    log("info", "should not appear");
    log("warn", "should not appear either");
    log("error", "should appear");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("should appear");

    (configMod.config as { logLevel: string }).logLevel = originalLevel;
  });

  it("logs everything when level is debug", async () => {
    const configMod = await import("../src/config.ts");
    const originalLevel = configMod.config.logLevel;

    (configMod.config as { logLevel: string }).logLevel = "debug";

    const { log } = await import("../src/logger.ts");

    log("debug", "debug msg");
    log("info", "info msg");
    log("warn", "warn msg");
    log("error", "error msg");

    expect(debugSpy).toHaveBeenCalledWith("debug msg");
    expect(infoSpy).toHaveBeenCalledWith("info msg");
    expect(warnSpy).toHaveBeenCalledWith("warn msg");
    expect(errorSpy).toHaveBeenCalledWith("error msg");

    (configMod.config as { logLevel: string }).logLevel = originalLevel;
  });
});
