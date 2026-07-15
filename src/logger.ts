/**
 * Tiny structured logger. Keeps output as single-line JSON so Render's log viewer
 * stays greppable. Intentionally minimal — no external logging dependency for a v1.
 */

type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => log("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("error", message, meta),
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.DEBUG) log("debug", message, meta);
  },
};
