import { z } from "zod";
import { seg } from "../client/http";
import { ToolUserError } from "../client/errors";
import {
  RevokedCountSchema,
  RoleRecordListSchema,
  UserSummaryListSchema,
  UserTokenListSchema,
} from "../client/schemas";
import { jsonResult, paginate, paginationInput, pageResult } from "../lib/output";
import { tokenView } from "./account";
import { confirmInput, defineTool, DESTRUCTIVE, READ, WRITE, type ToolModule } from "./registry";

const userUid = z.string().min(1).describe("user_uid of the target user (see admin_list what=users)");

export const adminList = defineTool({
  name: "admin_list",
  title: "List users, roles or a user's tokens",
  description:
    "Admin listing. what=users: all accounts with status and roles. what=roles: all roles (built-in and custom) with slug and bit position. " +
    "what=user_tokens: another user's API tokens (needs user_uid); never contains token values or hashes.",
  toolset: "admin",
  minRole: "admin",
  annotations: READ,
  input: {
    what: z.enum(["users", "roles", "user_tokens"]).describe("Which listing"),
    user_uid: z.string().min(1).optional().describe("Required for what=user_tokens"),
    ...paginationInput,
  },
  async handler(args, ctx) {
    switch (args.what) {
      case "users": {
        const users = await ctx.client.request("GET", "/api/admin/users", { schema: UserSummaryListSchema });
        return pageResult(paginate(users, args), { what: "users" });
      }
      case "roles": {
        const roles = await ctx.client.request("GET", "/api/admin/roles", { schema: RoleRecordListSchema });
        return pageResult(paginate(roles, args), { what: "roles" });
      }
      case "user_tokens": {
        if (args.user_uid === undefined) throw new ToolUserError("user_uid is required when what=user_tokens.");
        const tokens = await ctx.client.request("GET", `/api/admin/users/${seg(args.user_uid)}/tokens`, {
          schema: UserTokenListSchema,
        });
        return pageResult(paginate(tokens.map(tokenView), args), { what: "user_tokens", user_uid: args.user_uid });
      }
    }
  },
});

export const setUserStatus = defineTool({
  name: "set_user_status",
  title: "Enable or disable a user",
  description:
    "Set a user's status to 'active' or 'disabled'. Disabled users cannot log in or use tokens. You cannot disable yourself or the last " +
    "active owner (409); only an owner can change an admin or owner account (403).",
  toolset: "admin",
  minRole: "admin",
  annotations: WRITE,
  input: { user_uid: userUid, status: z.enum(["active", "disabled"]) },
  async handler(args, ctx) {
    await ctx.client.request("PATCH", `/api/admin/users/${seg(args.user_uid)}/status`, { json: { status: args.status } });
    return jsonResult({ user_uid: args.user_uid, status: args.status });
  },
});

export const assignRole = defineTool({
  name: "assign_role",
  title: "Give a user a role",
  description:
    "Assign a role (by slug, see admin_list what=roles) to a user. Granting 'owner' or 'admin' requires the caller to be an owner (403 otherwise). " +
    "An unknown slug is a 404.",
  toolset: "admin",
  minRole: "admin",
  annotations: WRITE,
  input: { user_uid: userUid, role_slug: z.string().min(1).describe("Role slug, e.g. 'user', 'admin', or a custom role") },
  async handler(args, ctx) {
    await ctx.client.request("POST", `/api/admin/users/${seg(args.user_uid)}/roles`, { json: { role_slug: args.role_slug } });
    return jsonResult({ user_uid: args.user_uid, assigned_role: args.role_slug });
  },
});

export const removeRole = defineTool({
  name: "remove_role",
  title: "Remove a role from a user",
  description:
    "Remove a role (by slug) from a user. Removing 'owner' or 'admin' requires the caller to be an owner; removing the last active owner's " +
    "owner role is refused (409).",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { user_uid: userUid, role_slug: z.string().min(1).describe("Role slug to remove"), ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/admin/users/${seg(args.user_uid)}/roles/${seg(args.role_slug)}`);
    return jsonResult({ user_uid: args.user_uid, removed_role: args.role_slug });
  },
});

export const deleteUser = defineTool({
  name: "delete_user",
  title: "Delete a user",
  description:
    "Permanently delete a user account together with their sessions, tokens and role assignments. Entries they captured are kept. " +
    "Refused for yourself and for the last active owner (409); deleting an admin or owner requires the caller to be an owner (403). Irreversible.",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { user_uid: userUid, ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/admin/users/${seg(args.user_uid)}`);
    return jsonResult({ deleted_user_uid: args.user_uid });
  },
});

export const revokeUserSessions = defineTool({
  name: "revoke_user_sessions",
  title: "Sign a user out everywhere",
  description:
    "Delete all login sessions of a user (forces re-login). API tokens are not affected; use revoke_user_token for those. " +
    "Same target restrictions as delete_user (not yourself; admin/owner targets need an owner).",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { user_uid: userUid, ...confirmInput },
  async handler(args, ctx) {
    const result = await ctx.client.request("DELETE", `/api/admin/users/${seg(args.user_uid)}/sessions`, {
      schema: RevokedCountSchema,
    });
    return jsonResult({ user_uid: args.user_uid, revoked: result.revoked });
  },
});

export const revokeUserToken = defineTool({
  name: "revoke_user_token",
  title: "Revoke a user's API token",
  description:
    "Revoke one API token of another user (token_uid from admin_list what=user_tokens). 404 if the token does not belong to that user. " +
    "Admin/owner targets need an owner.",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { user_uid: userUid, token_uid: z.string().min(1).describe("token_uid to revoke"), ...confirmInput },
  async handler(args, ctx) {
    await ctx.client.request("DELETE", `/api/admin/users/${seg(args.user_uid)}/tokens/${seg(args.token_uid)}`);
    return jsonResult({ user_uid: args.user_uid, revoked_token_uid: args.token_uid });
  },
});

export const adminUsersTools: ToolModule = () => [
  adminList,
  setUserStatus,
  assignRole,
  removeRole,
  deleteUser,
  revokeUserSessions,
  revokeUserToken,
];
