import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toToolError } from "../client/errors";
import type { Toolset } from "../config";
import { truncateResult } from "../lib/output";
import { collectSecretArgs, redactString } from "../lib/redact";
import { hasRole, type MinRole } from "../lib/roles";
import {
  toToolContext,
  type BaseContext,
  type Me,
  type ProgressUpdate,
  type ToolContext,
} from "./context";

// ── Annotations ─────────────────────────────────────────────────────────────

/** All four MCP hints are mandatory so every tool states its safety class explicitly. */
export interface ToolAnnotationSet {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Reads only; no side effects. */
export const READ: ToolAnnotationSet = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
/** Creates or updates data; nothing is lost. */
export const WRITE: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Deletes or irreversibly changes data. `defineTool` then requires the `confirm` input. */
export const DESTRUCTIVE: ToolAnnotationSet = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
/** Marks a tool that reaches outside Archivr (fetches URLs, calls an LLM provider). */
export function openWorld(annotations: ToolAnnotationSet): ToolAnnotationSet {
  return { ...annotations, openWorldHint: true };
}

// ── Shared input fragments ──────────────────────────────────────────────────

/** Spread into a tool's `input` for archive-scoped tools; resolve with `ctx.archive(args)`. */
export const archiveInput = {
  archive: z
    .string()
    .min(1)
    .optional()
    .describe("Archive id. Optional when only one archive is mounted or ARCHIVR_ARCHIVE is set."),
};

/** Spread into every destructive tool's `input`; callers must pass `confirm: true`. */
export const confirmInput = {
  confirm: z
    .literal(true, { error: "This action is destructive: pass confirm: true to proceed." })
    .describe("Must be true. Confirms that this destructive action is intended."),
};

// ── Tool definitions ────────────────────────────────────────────────────────

export interface ToolSpec<Shape extends z.ZodRawShape> {
  /** snake_case, unique across all modules. */
  name: string;
  title: string;
  description: string;
  toolset: Toolset;
  /** Lowest role that can use the tool; hides it from lower-privileged tokens (server still enforces). */
  minRole: MinRole;
  annotations: ToolAnnotationSet;
  /** Zod raw shape of the arguments (`{}` for none). */
  input: Shape;
  handler: (args: z.output<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<CallToolResult> | CallToolResult;
}

/** A registered-shape-erased tool, so tools with different argument types share one list. */
export interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly toolset: Toolset;
  readonly minRole: MinRole;
  readonly annotations: ToolAnnotationSet;
  readonly input: z.ZodRawShape;
  /** Run the handler with ALREADY VALIDATED args (the MCP SDK validates against `input`). */
  execute(args: unknown, ctx: ToolContext): Promise<CallToolResult>;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Define a tool. Enforces invariants at definition time: name format, a description, and
 * a `confirm` input on every destructive tool.
 *
 * ```ts
 * export const deleteThing = defineTool({
 *   name: "delete_thing", title: "Delete thing", description: "...",
 *   toolset: "organize", minRole: "user", annotations: DESTRUCTIVE,
 *   input: { ...archiveInput, thing_uid: z.string(), ...confirmInput },
 *   async handler(args, ctx) {
 *     const archive = await ctx.archive(args);
 *     await ctx.client.request("DELETE", `/api/archives/${seg(archive)}/things/${seg(args.thing_uid)}`);
 *     return jsonResult({ deleted: args.thing_uid });
 *   },
 * });
 * ```
 */
export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDef {
  if (!NAME_PATTERN.test(spec.name)) throw new Error(`invalid tool name: ${spec.name}`);
  if (spec.description.trim() === "") throw new Error(`tool ${spec.name} needs a description`);
  const { annotations } = spec;
  if (annotations.readOnlyHint && annotations.destructiveHint) {
    throw new Error(`tool ${spec.name} cannot be both read-only and destructive`);
  }
  if (annotations.destructiveHint && !("confirm" in spec.input)) {
    throw new Error(`destructive tool ${spec.name} must include confirmInput in its input`);
  }
  const { handler, input, ...meta } = spec;
  return {
    ...meta,
    input,
    // The single place arguments are narrowed: the SDK has parsed them against `input`.
    execute: async (args, ctx) => handler(args as z.output<z.ZodObject<Shape>>, ctx),
  };
}

/** A tool module: a pure function returning its tools (uniform signature across `src/tools/*.ts`). */
export type ToolModule = () => ToolDef[];

// ── Filtering ───────────────────────────────────────────────────────────────

export interface ToolFilter {
  toolsets: ReadonlySet<Toolset>;
  readonly: boolean;
  /** `null` = roles unknown (startup /me failed): keep every tool the toolsets allow. */
  me: Pick<Me, "roleBits"> | null;
}

export function assertUniqueNames(tools: readonly ToolDef[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
}

/** Tools visible for a toolset selection, read-only mode and the caller's roles. */
export function selectTools(tools: readonly ToolDef[], filter: ToolFilter): ToolDef[] {
  return tools.filter((tool) => {
    if (!filter.toolsets.has(tool.toolset)) return false;
    if (filter.readonly && !tool.annotations.readOnlyHint) return false;
    if (filter.me !== null && !hasRole(filter.me.roleBits, tool.minRole)) return false;
    return true;
  });
}

// ── Execution ───────────────────────────────────────────────────────────────

/** The parts of the SDK's request extra that tool execution uses. */
export interface CallExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

function progressSender(extra: CallExtra): ToolContext["progress"] {
  const token = extra._meta?.progressToken;
  if (token === undefined) return async () => {};
  return async (update: ProgressUpdate) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: update.progress,
          ...(update.total === undefined ? {} : { total: update.total }),
          ...(update.message === undefined ? {} : { message: update.message }),
        },
      });
    } catch {
      // Progress is best effort.
    }
  };
}

/** Remove the token and any password-like argument values from every text block. */
export function redactResult(result: CallToolResult, secrets: readonly string[]): CallToolResult {
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text" ? { ...block, text: redactString(block.text, secrets) } : block,
    ),
  };
}

/**
 * Run one tool call: bind the context, map thrown errors to tool errors, then redact
 * secrets and truncate to the output budget. This is the only path to a tool result.
 */
export async function runTool(
  tool: ToolDef,
  args: unknown,
  base: BaseContext,
  extra: CallExtra,
): Promise<CallToolResult> {
  const ctx = toToolContext(base, { signal: extra.signal, progress: progressSender(extra) });
  let result: CallToolResult;
  try {
    result = await tool.execute(args, ctx);
  } catch (error) {
    base.log.warn(`tool ${tool.name} failed (${error instanceof Error ? error.name : "unknown"})`);
    result = toToolError(error);
  }
  const secrets = [base.config.token, ...collectSecretArgs(args)];
  return truncateResult(redactResult(result, secrets), base.config.maxOutputChars);
}

/** Register tools on an MCP server. Filtering is the caller's job (see `selectTools`). */
export function registerTools(server: McpServer, tools: readonly ToolDef[], base: BaseContext): void {
  assertUniqueNames(tools);
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args: unknown, extra) => runTool(tool, args, base, extra),
    );
  }
}
