import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import type { LogLevel } from "./lib/log";

export const TOOLSETS = ["core", "capture", "organize", "account", "admin", "credentials"] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Toolsets enabled when ARCHIVR_MCP_TOOLSETS is unset. `credentials` is opt-in. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ["core", "capture", "organize", "account", "admin"];

export const DEFAULT_MAX_OUTPUT_CHARS = 40_000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface Config {
  /** Base URL of the Archivr server, no trailing slash, no credentials. */
  readonly url: string;
  /** Bearer API token. Never print, log or return this. */
  readonly token: string;
  /** Default archive id; when absent the only mounted archive is auto-selected. */
  readonly archive: string | undefined;
  readonly toolsets: ReadonlySet<Toolset>;
  readonly readonly: boolean;
  readonly maxOutputChars: number;
  readonly timeoutMs: number;
  /** Directories `capture_file` may read from. Empty = file uploads disabled. */
  readonly uploadRoots: readonly string[];
  readonly downloadDir: string;
  readonly logLevel: LogLevel;
}

/** Thrown for invalid configuration. Messages name variables, never their values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const flag = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(
    z.enum(["", "0", "false", "no", "off", "1", "true", "yes", "on"], {
      error: "must be one of 1/0, true/false, yes/no, on/off",
    }),
  )
  .transform((v) => ["1", "true", "yes", "on"].includes(v));

const positiveInt = (name: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, { error: `${name} must be a positive integer` })
    .transform(Number)
    .pipe(z.number().int().positive({ error: `${name} must be a positive integer` }));

const urlSchema = z
  .string()
  .trim()
  .min(1, { error: "ARCHIVR_URL is required" })
  .transform((raw, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      ctx.addIssue({ code: "custom", message: "ARCHIVR_URL must be an absolute http(s) URL" });
      return z.NEVER;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "ARCHIVR_URL must use http or https" });
      return z.NEVER;
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({ code: "custom", message: "ARCHIVR_URL must not contain credentials; use ARCHIVR_TOKEN" });
      return z.NEVER;
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  });

const tokenSchema = z
  .string()
  .trim()
  .min(1, { error: "ARCHIVR_TOKEN is required (create one in Archivr under Settings > API tokens)" });

const LOG_LEVELS = ["off", "error", "warn", "info", "debug"] as const;

function parseToolsets(raw: string | undefined): Set<Toolset> | string {
  if (raw === undefined || raw.trim() === "") return new Set(DEFAULT_TOOLSETS);
  const out = new Set<Toolset>();
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") continue;
    if (!(TOOLSETS as readonly string[]).includes(name)) {
      return `ARCHIVR_MCP_TOOLSETS contains an unknown toolset (valid: ${TOOLSETS.join(", ")})`;
    }
    out.add(name as Toolset);
  }
  return out.size > 0 ? out : "ARCHIVR_MCP_TOOLSETS must list at least one toolset";
}

/** Validate environment variables into a Config. Throws ConfigError listing every problem. */
export function loadConfig(env: Env = process.env): Config {
  const issues: string[] = [];

  const field = <T>(schema: z.ZodType<T>, name: string, raw: string | undefined, fallback?: T): T | undefined => {
    if (raw === undefined || (raw.trim() === "" && fallback !== undefined)) return fallback;
    const result = schema.safeParse(raw);
    if (result.success) return result.data;
    // Zod issue messages here are all authored above and never echo the input value.
    for (const issue of result.error.issues) {
      issues.push(issue.message.includes(name) ? issue.message : `${name}: ${issue.message}`);
    }
    return undefined;
  };

  const url = field(urlSchema, "ARCHIVR_URL", env["ARCHIVR_URL"] ?? "");
  const token = field(tokenSchema, "ARCHIVR_TOKEN", env["ARCHIVR_TOKEN"] ?? "");
  const archiveRaw = env["ARCHIVR_ARCHIVE"]?.trim();
  const archive = archiveRaw === undefined || archiveRaw === "" ? undefined : archiveRaw;

  const toolsets = parseToolsets(env["ARCHIVR_MCP_TOOLSETS"]);
  if (typeof toolsets === "string") issues.push(toolsets);

  const readonly = field(flag, "ARCHIVR_MCP_READONLY", env["ARCHIVR_MCP_READONLY"], false);
  const maxOutputChars = field(
    positiveInt("ARCHIVR_MCP_MAX_OUTPUT_CHARS"),
    "ARCHIVR_MCP_MAX_OUTPUT_CHARS",
    env["ARCHIVR_MCP_MAX_OUTPUT_CHARS"],
    DEFAULT_MAX_OUTPUT_CHARS,
  );
  const timeoutMs = field(
    positiveInt("ARCHIVR_MCP_TIMEOUT_MS"),
    "ARCHIVR_MCP_TIMEOUT_MS",
    env["ARCHIVR_MCP_TIMEOUT_MS"],
    DEFAULT_TIMEOUT_MS,
  );
  const logLevel = field(
    z.string().trim().toLowerCase().pipe(z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(", ")}` })),
    "ARCHIVR_MCP_LOG",
    env["ARCHIVR_MCP_LOG"],
    "warn" as LogLevel,
  );

  const uploadRoots = (env["ARCHIVR_MCP_UPLOAD_ROOTS"] ?? "")
    .split(delimiter)
    .map((p) => expandHome(p.trim()))
    .filter((p) => p !== "");
  const downloadDirRaw = env["ARCHIVR_MCP_DOWNLOAD_DIR"]?.trim();
  const downloadDir =
    downloadDirRaw !== undefined && downloadDirRaw !== ""
      ? expandHome(downloadDirRaw)
      : join(tmpdir(), "archivr-mcp-downloads");

  if (issues.length > 0 || url === undefined || token === undefined || typeof toolsets === "string") {
    throw new ConfigError(issues);
  }

  return {
    url,
    token,
    archive,
    toolsets,
    readonly: readonly ?? false,
    maxOutputChars: maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    uploadRoots,
    downloadDir,
    logLevel: logLevel ?? "warn",
  };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}
