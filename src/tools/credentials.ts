import { z } from "zod";
import { ArchivrApiError, ToolUserError } from "../client/errors";
import { seg } from "../client/http";
import { CookieRuleSchema, PasswordResetResultSchema, TokenCreatedSchema, UserCreatedSchema } from "../client/schemas";
import { jsonResult } from "../lib/output";
import { redactString } from "../lib/redact";
import { describeCookieRule } from "./admin-settings";
import { defineTool, WRITE, type ToolModule } from "./registry";

const password = (describe: string) => z.string().min(8).max(1024).describe(describe);

const cookiesInput = z
  .record(z.string().min(1), z.string())
  .refine((cookies) => Object.keys(cookies).length > 0, { error: "cookies must contain at least one cookie" })
  .describe("Cookie name -> value map. Values are stored on the server and never returned.");

const patternKind = z.enum(["global", "wildcard", "regex"]).describe("global: applies to every URL; wildcard/regex: matched against url_pattern");

/**
 * The registry only scrubs known-sensitive argument names; `cookies` is not one, so if the server
 * echoes a cookie value in an error, scrub the supplied values here.
 */
async function scrubbingCookies<T>(cookies: Record<string, string> | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArchivrApiError && cookies !== undefined) {
      throw new ArchivrApiError(error.status, redactString(error.serverMessage, Object.values(cookies)), error.endpoint);
    }
    throw error;
  }
}

export const createApiToken = defineTool({
  name: "create_api_token",
  title: "Create an API token",
  description:
    "Create a new API token for the calling user. The raw token is returned ONCE in this result and cannot be retrieved later; note that it " +
    "therefore enters the model context, so prefer `scope: read` (can only read, cannot modify anything) and a short `expires_in_days`. " +
    "Default scope is full. A read-scope MCP token cannot create tokens (403).",
  toolset: "credentials",
  minRole: "user",
  annotations: WRITE,
  input: {
    name: z.string().trim().min(1).max(100).describe("Label for the token"),
    expires_in_days: z.number().int().min(1).max(3650).optional().describe("Days until expiry (1-3650); omitted = never expires"),
    scope: z.enum(["full", "read"]).optional().describe("read = GET-only; full (default) = everything the user can do"),
  },
  async handler(args, ctx) {
    const body: Record<string, unknown> = { name: args.name };
    if (args.expires_in_days !== undefined) body["expires_in_days"] = args.expires_in_days;
    if (args.scope !== undefined) body["scope"] = args.scope;
    const created = await ctx.client.request("POST", "/api/auth/tokens", { json: body, schema: TokenCreatedSchema });
    return jsonResult({
      token_uid: created.token_uid,
      name: created.name,
      raw_token: created.raw_token,
      expires_at: created.expires_at ?? null,
      scope: created.scope ?? "full",
      note: "raw_token is shown only once. Store it securely; it is now also in this conversation's context.",
    });
  },
});

export const changePassword = defineTool({
  name: "change_password",
  title: "Change my password",
  description:
    "Change the calling user's own password (needs the current one; new password at least 8 characters). The user's other login sessions are " +
    "signed out. The passwords pass through the model context, so only use this when the user explicitly asks.",
  toolset: "credentials",
  minRole: "user",
  annotations: WRITE,
  input: {
    current_password: z.string().min(1).max(1024).describe("The current password"),
    new_password: password("The new password (at least 8 characters)"),
  },
  async handler(args, ctx) {
    try {
      await ctx.client.request("PATCH", "/api/auth/me", {
        json: { current_password: args.current_password, new_password: args.new_password },
      });
    } catch (error) {
      if (error instanceof ArchivrApiError && error.status === 401 && /password/i.test(error.serverMessage)) {
        throw new ToolUserError("The current password is incorrect; the password was not changed.");
      }
      throw error;
    }
    return jsonResult({ changed: true, note: "Other login sessions were signed out. API tokens are unaffected." });
  },
});

export const createUser = defineTool({
  name: "create_user",
  title: "Create a user",
  description:
    "Admin. Create a user account with an initial password (at least 8 characters; it passes through the model context). " +
    "The new user has no roles yet: assign them with assign_role.",
  toolset: "credentials",
  minRole: "admin",
  annotations: WRITE,
  input: {
    username: z.string().trim().min(1).max(100).describe("Unique username"),
    password: password("Initial password (at least 8 characters)"),
    email: z.string().trim().min(3).max(320).optional().describe("Optional email address"),
  },
  async handler(args, ctx) {
    const body: Record<string, unknown> = { username: args.username, password: args.password };
    if (args.email !== undefined) body["email"] = args.email;
    const created = await ctx.client.request("POST", "/api/admin/users", { json: body, schema: UserCreatedSchema });
    return jsonResult({ user_uid: created.user_uid, username: created.username });
  },
});

export const resetUserPassword = defineTool({
  name: "reset_user_password",
  title: "Reset a user's password",
  description:
    "Admin. Set a new password (at least 8 characters; it passes through the model context) for another user. Always signs the user out " +
    "everywhere; with revoke_tokens also revokes all their API tokens. Not for yourself (409: use change_password). Admin/owner targets need an owner (403).",
  toolset: "credentials",
  minRole: "admin",
  annotations: WRITE,
  input: {
    user_uid: z.string().min(1).describe("user_uid of the target user"),
    new_password: password("New password (at least 8 characters)"),
    revoke_tokens: z.boolean().optional().describe("Also revoke all the user's API tokens (default false)"),
  },
  async handler(args, ctx) {
    const body: Record<string, unknown> = { new_password: args.new_password };
    if (args.revoke_tokens !== undefined) body["revoke_tokens"] = args.revoke_tokens;
    const result = await ctx.client.request("POST", `/api/admin/users/${seg(args.user_uid)}/password`, {
      json: body,
      schema: PasswordResetResultSchema,
    });
    return jsonResult(result);
  },
});

export const createCookieRule = defineTool({
  name: "create_cookie_rule",
  title: "Create a cookie rule",
  description:
    "Admin. Add a download cookie rule: cookies (name -> value) sent when capturing URLs that match url_pattern. The cookie values are secrets: " +
    "they are stored on the server and never echoed back (results show cookie names and value lengths only). url_pattern is required unless " +
    "pattern_kind is 'global'; regex patterns are validated.",
  toolset: "credentials",
  minRole: "admin",
  annotations: WRITE,
  input: {
    url_pattern: z.string().trim().min(1).optional().describe("URL pattern (wildcard or regex); omit for global rules"),
    pattern_kind: patternKind,
    cookies: cookiesInput,
  },
  async handler(args, ctx) {
    const rule = await scrubbingCookies(args.cookies, () =>
      ctx.client.request("POST", "/api/admin/cookie-rules", {
        json: {
          url_pattern: args.url_pattern ?? null,
          pattern_kind: args.pattern_kind,
          cookies_json: JSON.stringify(args.cookies),
        },
        schema: CookieRuleSchema,
      }),
    );
    return jsonResult(describeCookieRule(rule));
  },
});

export const updateCookieRule = defineTool({
  name: "update_cookie_rule",
  title: "Update a cookie rule",
  description:
    "Admin. Change a cookie rule; only the fields you pass change. Passing `cookies` replaces the whole cookie set (values are never echoed back). " +
    "url_pattern: null clears it (only valid for global rules). `ordinal` sets the evaluation order.",
  toolset: "credentials",
  minRole: "admin",
  annotations: WRITE,
  input: {
    uid: z.string().min(1).describe("rule_uid (see server_info section=cookie_rules)"),
    url_pattern: z.string().trim().nullable().optional().describe("New URL pattern; null or empty clears it"),
    pattern_kind: patternKind.optional(),
    cookies: cookiesInput.optional(),
    ordinal: z.number().int().optional().describe("Evaluation order"),
  },
  async handler(args, ctx) {
    const body: Record<string, unknown> = {};
    if (args.url_pattern !== undefined) body["url_pattern"] = args.url_pattern;
    if (args.pattern_kind !== undefined) body["pattern_kind"] = args.pattern_kind;
    if (args.cookies !== undefined) body["cookies_json"] = JSON.stringify(args.cookies);
    if (args.ordinal !== undefined) body["ordinal"] = args.ordinal;
    if (Object.keys(body).length === 0) throw new ToolUserError("Nothing to update: pass at least one field.");
    await scrubbingCookies(args.cookies, () =>
      ctx.client.request("PATCH", `/api/admin/cookie-rules/${seg(args.uid)}`, { json: body }),
    );
    return jsonResult({
      updated_rule_uid: args.uid,
      updated: Object.keys(body).map((k) => (k === "cookies_json" ? "cookies" : k)),
    });
  },
});

export const credentialsTools: ToolModule = () => [
  createApiToken,
  changePassword,
  createUser,
  resetUserPassword,
  createCookieRule,
  updateCookieRule,
];
