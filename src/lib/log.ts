import { redactString } from "./redact";

export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const RANK: Record<LogLevel, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/**
 * stderr-only logger (stdout belongs to the MCP protocol). Callers must pass short
 * static messages: never request/response bodies, headers, query strings, tokens or
 * passwords. Known secrets are redacted as a last line of defence.
 */
export function createLogger(
  level: LogLevel,
  secrets: readonly string[] = [],
  write: (line: string) => void = (line) => {
    process.stderr.write(line + "\n");
  },
): Logger {
  const emit = (at: Exclude<LogLevel, "off">, message: string): void => {
    if (RANK[level] < RANK[at]) return;
    write(`archivr-mcp ${at}: ${redactString(message, secrets)}`);
  };
  return {
    error: (m) => emit("error", m),
    warn: (m) => emit("warn", m),
    info: (m) => emit("info", m),
    debug: (m) => emit("debug", m),
  };
}

export const silentLogger: Logger = createLogger("off");
