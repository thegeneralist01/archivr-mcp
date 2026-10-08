import { z } from "zod";
import { seg } from "../client/http";
import { ArchivrApiError, ToolUserError } from "../client/errors";
import {
  ArchiveInfoSchema,
  CookieRuleListSchema,
  EffectiveConfigSchema,
  InstanceSettingsSchema,
  YtDlpStatusSchema,
  type CookieRule,
  type EffectiveConfig,
} from "../client/schemas";
import { jsonResult } from "../lib/output";
import { archiveInput, confirmInput, defineTool, DESTRUCTIVE, openWorld, READ, WRITE, type ToolModule } from "./registry";

// ── Cookie rules (shared with credentials.ts) ───────────────────────────────

/**
 * Cookie rule without its secrets: cookie names and value lengths only. The server stores
 * and returns `cookies_json` with real session cookies; those values never reach the model.
 */
export function describeCookieRule(rule: CookieRule): Record<string, unknown> {
  let cookies: Record<string, unknown> | { unreadable: true };
  try {
    const parsed: unknown = JSON.parse(rule.cookies_json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lengths: Record<string, number> = {};
      for (const [name, value] of Object.entries(parsed)) lengths[name] = typeof value === "string" ? value.length : 0;
      cookies = { count: Object.keys(lengths).length, value_lengths: lengths };
    } else {
      cookies = { unreadable: true };
    }
  } catch {
    cookies = { unreadable: true };
  }
  return {
    rule_uid: rule.rule_uid,
    url_pattern: rule.url_pattern,
    pattern_kind: rule.pattern_kind,
    ordinal: rule.ordinal,
    created_at: rule.created_at,
    cookies,
  };
}

/** Defense in depth: the server already omits secret env values; drop `value` for secret rows regardless. */
function scrubEffectiveConfig(config: EffectiveConfig): EffectiveConfig {
  return {
    ...config,
    env_vars: config.env_vars.map((v) => (v.secret ? { ...v, value: null } : v)),
  };
}

// ── server_info ─────────────────────────────────────────────────────────────

export const serverInfo = defineTool({
  name: "server_info",
  title: "Server settings and status",
  description:
    "Admin, read-only view of the Archivr server. section=instance_settings: the editable instance settings (including title models). " +
    "effective_config: env-derived configuration (read-only; secrets only show whether they are set), summary providers, transcription engines. " +
    "ytdlp: yt-dlp/deno tool status. cookie_rules: download cookie rules with cookie NAMES and value lengths only, never values. " +
    "archive_info: entry/artifact/blob/job counts and sizes of one archive.",
  toolset: "admin",
  minRole: "admin",
  annotations: READ,
  input: {
    section: z.enum(["instance_settings", "effective_config", "ytdlp", "cookie_rules", "archive_info"]).describe("What to show"),
    ...archiveInput,
  },
  async handler(args, ctx) {
    switch (args.section) {
      case "instance_settings":
        return jsonResult(await ctx.client.request("GET", "/api/admin/instance-settings", { schema: InstanceSettingsSchema }));
      case "effective_config": {
        const config = await ctx.client.request("GET", "/api/admin/effective-config", { schema: EffectiveConfigSchema });
        return jsonResult(scrubEffectiveConfig(config));
      }
      case "ytdlp":
        return jsonResult(await ctx.client.request("GET", "/api/admin/yt-dlp", { schema: YtDlpStatusSchema }));
      case "cookie_rules": {
        const rules = await ctx.client.request("GET", "/api/admin/cookie-rules", { schema: CookieRuleListSchema });
        return jsonResult({ count: rules.length, rules: rules.map(describeCookieRule) });
      }
      case "archive_info": {
        const archive = await ctx.archive(args);
        return jsonResult(await ctx.client.request("GET", `/api/archives/${seg(archive)}/info`, { schema: ArchiveInfoSchema }));
      }
    }
  },
});

// ── update_instance_settings ────────────────────────────────────────────────

const titleModel = z
  .string()
  .trim()
  .max(100)
  .regex(/^\S*$/, { error: "must not contain whitespace" })
  .optional();

const SETTINGS_INPUT = {
  public_index_enabled: z.boolean().optional().describe("INERT: currently has no effect"),
  public_entry_content_enabled: z.boolean().optional().describe("INERT: currently has no effect"),
  open_registration_enabled: z.boolean().optional().describe("INERT: currently has no effect"),
  default_entry_visibility: z.number().int().min(0).optional().describe("Default visibility role bitmask for new entries"),
  ublock_enabled: z.boolean().optional().describe("Use the uBlock extension for page captures"),
  cookie_ext_enabled: z.boolean().optional().describe("Use the cookie-consent extension for page captures"),
  modal_closer_enabled: z.boolean().optional().describe("Auto-close modals during page captures"),
  reorder_children_role_bits: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("OWNER only: role bitmask allowed to reorder children; must be a subset of existing non-guest role bits"),
  title_model_anthropic_http: titleModel.describe("Title model for anthropic_http (<=100 chars, no whitespace; empty clears)"),
  title_model_openai_compatible: titleModel.describe("Title model for openai_compatible (<=100 chars, no whitespace; empty clears)"),
  title_model_claude_cli: titleModel.describe("Title model for claude_cli (<=100 chars, no whitespace; empty clears)"),
  title_model_codex_cli: titleModel.describe("Title model for codex_cli (<=100 chars, no whitespace; empty clears)"),
};

export const updateInstanceSettings = defineTool({
  name: "update_instance_settings",
  title: "Update instance settings",
  description:
    "Admin. Partially update instance settings: only the fields you pass are sent and changed. " +
    "NOTE: `public_index_enabled`, `public_entry_content_enabled` and `open_registration_enabled` are currently INERT (stored, but they have no effect). " +
    "`reorder_children_role_bits` is OWNER-only and must be a subset of the existing non-guest role bits (400 otherwise). " +
    "Title model fields are at most 100 characters with no whitespace; an empty string clears the override. " +
    "Use server_info section=instance_settings to read the current values.",
  toolset: "admin",
  minRole: "admin",
  annotations: WRITE,
  input: SETTINGS_INPUT,
  async handler(args, ctx) {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) if (value !== undefined) body[key] = value;
    if (Object.keys(body).length === 0) throw new ToolUserError("Nothing to update: pass at least one setting.");
    await ctx.client.request("PATCH", "/api/admin/instance-settings", { json: body });
    return jsonResult({ updated: Object.keys(body) });
  },
});

// ── update_ytdlp ────────────────────────────────────────────────────────────

/** The yt-dlp + deno download can take minutes. */
export const YTDLP_UPDATE_TIMEOUT_MS = 600_000;

export const updateYtdlp = defineTool({
  name: "update_ytdlp",
  title: "Update yt-dlp and deno",
  description:
    "Admin. Download and install the latest yt-dlp and deno on the server (same as `archivr yt-dlp update`). Contacts the internet and can " +
    "take several minutes. Only one update can run at a time; if one is already running this reports it (check server_info section=ytdlp, update_running).",
  toolset: "admin",
  minRole: "admin",
  annotations: openWorld(WRITE),
  input: {},
  async handler(_args, ctx) {
    try {
      const result = await ctx.client.request("POST", "/api/admin/yt-dlp/update", { timeoutMs: YTDLP_UPDATE_TIMEOUT_MS });
      return jsonResult(result);
    } catch (error) {
      if (error instanceof ArchivrApiError && error.status === 409) {
        throw new ToolUserError(
          "A yt-dlp update is already running on the server. Wait for it to finish (server_info section=ytdlp shows update_running) and check the result before retrying.",
        );
      }
      throw error;
    }
  },
});

// ── delete_cookie_rule ──────────────────────────────────────────────────────

export const deleteCookieRule = defineTool({
  name: "delete_cookie_rule",
  title: "Delete a cookie rule",
  description:
    "Admin. Permanently delete a download cookie rule by rule_uid (see server_info section=cookie_rules). Captures matching it will no longer send those cookies.",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { uid: z.string().min(1).describe("rule_uid of the cookie rule"), ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/admin/cookie-rules/${seg(args.uid)}`);
    return jsonResult({ deleted_rule_uid: args.uid });
  },
});

export const adminSettingsTools: ToolModule = () => [serverInfo, updateInstanceSettings, updateYtdlp, deleteCookieRule];
