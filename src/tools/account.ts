import { z } from "zod";
import { seg } from "../client/http";
import {
  ApiTokenListSchema,
  RevokedCountSchema,
  SessionListSchema,
  type ApiTokenRecord,
  type SessionRecord,
} from "../client/schemas";
import { ToolUserError } from "../client/errors";
import { jsonResult, paginate, paginationInput, pageResult } from "../lib/output";
import { confirmInput, defineTool, DESTRUCTIVE, READ, WRITE, type ToolModule } from "./registry";

/** Whitelist the token fields: never pass through anything the server did not document (no hashes). */
export function tokenView(token: ApiTokenRecord): Record<string, unknown> {
  return {
    token_uid: token.token_uid,
    name: token.name,
    created_at: token.created_at,
    last_used_at: token.last_used_at,
    expires_at: token.expires_at ?? null,
    scope: token.scope ?? "full",
  };
}

/** Whitelist the session fields: the session id (cookie value) is never exposed, only the opaque handle. */
function sessionView(session: SessionRecord): Record<string, unknown> {
  return {
    session_handle: session.session_handle,
    created_at: session.created_at,
    last_seen_at: session.last_seen_at,
    expires_at: session.expires_at,
    user_agent: session.user_agent,
    current: session.current,
  };
}

export const listMyCredentials = defineTool({
  name: "list_my_credentials",
  title: "List my tokens or sessions",
  description:
    "List the calling user's own API tokens (what=tokens: uid, name, created/last-used/expiry, scope full|read) or " +
    "browser login sessions (what=sessions: opaque session_handle, created/last-seen/expiry, user agent, whether it is the " +
    "current one). Never returns secrets; raw token values are only shown once, when a token is created. " +
    "Pass a token_uid to revoke_token or a session_handle to revoke_session.",
  toolset: "account",
  minRole: "user",
  annotations: READ,
  input: {
    what: z.enum(["tokens", "sessions"]).describe("Which credentials to list"),
    ...paginationInput,
  },
  async handler(args, ctx) {
    if (args.what === "tokens") {
      const tokens = await ctx.client.request("GET", "/api/auth/tokens", { schema: ApiTokenListSchema });
      return pageResult(paginate(tokens.map(tokenView), args), { what: "tokens" });
    }
    const sessions = await ctx.client.request("GET", "/api/auth/sessions", { schema: SessionListSchema });
    return pageResult(paginate(sessions.map(sessionView), args), { what: "sessions" });
  },
});

export const updateProfile = defineTool({
  name: "update_profile",
  title: "Update my profile",
  description:
    "Update the calling user's display name and/or the 'humanize slugs' display preference. Provide at least one field. " +
    "An empty display_name clears it. Passwords are not handled here (see change_password in the opt-in credentials toolset).",
  toolset: "account",
  minRole: "user",
  annotations: WRITE,
  input: {
    display_name: z.string().max(200).optional().describe("New display name; empty string clears it"),
    humanize_slugs: z.boolean().optional().describe("Show tag/collection slugs in a human-friendly form"),
  },
  async handler(args, ctx) {
    const body: Record<string, unknown> = {};
    if (args.display_name !== undefined) body["display_name"] = args.display_name;
    if (args.humanize_slugs !== undefined) body["humanize_slugs"] = args.humanize_slugs;
    if (Object.keys(body).length === 0) {
      throw new ToolUserError("Nothing to update: pass display_name and/or humanize_slugs.");
    }
    await ctx.client.request("PATCH", "/api/auth/me", { json: body });
    return jsonResult({ updated: Object.keys(body) });
  },
});

export const revokeToken = defineTool({
  name: "revoke_token",
  title: "Revoke one of my API tokens",
  description:
    "Permanently revoke one of the calling user's API tokens by token_uid (see list_my_credentials). " +
    "Anything using that token stops working immediately; revoking the token this MCP server is using cuts off this server.",
  toolset: "account",
  minRole: "user",
  annotations: DESTRUCTIVE,
  input: { token_uid: z.string().min(1).describe("uid of the token to revoke"), ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/auth/tokens/${seg(args.token_uid)}`);
    return jsonResult({ revoked_token_uid: args.token_uid });
  },
});

export const revokeSession = defineTool({
  name: "revoke_session",
  title: "Revoke one of my login sessions",
  description:
    "Sign out one of the calling user's browser sessions by its session_handle (see list_my_credentials what=sessions). " +
    "Revoking the current session logs that browser out.",
  toolset: "account",
  minRole: "user",
  annotations: DESTRUCTIVE,
  input: { handle: z.string().min(1).describe("session_handle from list_my_credentials"), ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/auth/sessions/${seg(args.handle)}`);
    return jsonResult({ revoked_session_handle: args.handle });
  },
});

export const revokeOtherSessions = defineTool({
  name: "revoke_other_sessions",
  title: "Revoke all my other login sessions",
  description:
    "Sign out all of the calling user's browser sessions except the current one. Because this MCP server authenticates " +
    "with an API token (not a browser session), every session is revoked. API tokens are not affected.",
  toolset: "account",
  minRole: "user",
  annotations: DESTRUCTIVE,
  input: { ...confirmInput },
  async handler(_args, ctx) {
    const result = await ctx.client.request("DELETE", "/api/auth/sessions", { schema: RevokedCountSchema });
    return jsonResult({ revoked: result.revoked });
  },
});

export const accountTools: ToolModule = () => [
  listMyCredentials,
  updateProfile,
  revokeToken,
  revokeSession,
  revokeOtherSessions,
];
