import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../types.js";

export function consoleLogger(tag: string): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...(data ?? {}) });
    process.stderr.write(line + "\n");
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}

export function fileLogger(path: string, tag: string): Logger {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, msg, ...(data ?? {}) }) + "\n";
    // Fire-and-forget; callers should not await logging.
    mkdir(dirname(path), { recursive: true }).then(() => appendFile(path, line, "utf8")).catch(() => {});
  };
  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
  };
}

export function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
