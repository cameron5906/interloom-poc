/**
 * stderr-only logging (pinned-interfaces Global Constraints — stdout is
 * reserved for the future stdio MCP transport, Task 8). Every call site in
 * this package must pass only the fields it needs to log, never a raw
 * `FrontierLinkPayload`/credential entry — API keys and agent private keys
 * must never reach a log line (CONTRACTS §14 key custody).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
  process.stderr.write(`[frontier-mcp] ${level} ${message}${suffix}\n`);
}

export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
