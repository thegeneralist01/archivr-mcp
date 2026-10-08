import { z } from "zod";
import { seg } from "../client/http";
import { RoleDeletedSchema, RoleRecordSchema } from "../client/schemas";
import { jsonResult } from "../lib/output";
import { confirmInput, defineTool, DESTRUCTIVE, WRITE, type ToolModule } from "./registry";

export const createRole = defineTool({
  name: "create_role",
  title: "Create a custom role",
  description:
    "Create a custom role with a slug (immutable id) and a display name. Custom roles carry no built-in privileges (they only matter for " +
    "collection visibility and the reorder-children mask). Assign it with assign_role.",
  toolset: "admin",
  minRole: "admin",
  annotations: WRITE,
  input: {
    slug: z.string().trim().min(1).max(64).describe("Unique slug, e.g. 'family'. Cannot be changed later."),
    name: z.string().trim().min(1).max(100).describe("Display name"),
  },
  async handler(args, ctx) {
    const role = await ctx.client.request("POST", "/api/admin/roles", {
      json: { slug: args.slug, name: args.name },
      schema: RoleRecordSchema,
    });
    return jsonResult(role);
  },
});

export const renameRole = defineTool({
  name: "rename_role",
  title: "Rename a custom role",
  description: "Change the display name of a custom role. The slug is immutable and built-in roles (guest/user/admin/owner) cannot be renamed (400).",
  toolset: "admin",
  minRole: "admin",
  annotations: WRITE,
  input: {
    slug: z.string().trim().min(1).describe("Slug of the custom role"),
    name: z.string().trim().min(1).max(100).describe("New display name"),
  },
  async handler(args, ctx) {
    const role = await ctx.client.request("PATCH", `/api/admin/roles/${seg(args.slug)}`, {
      json: { name: args.name },
      schema: RoleRecordSchema,
    });
    return jsonResult(role);
  },
});

export const deleteRole = defineTool({
  name: "delete_role",
  title: "Delete a custom role",
  description:
    "Owner only. Permanently delete a custom role: it is removed from every holder, their sessions are invalidated (they must log in again) " +
    "and its bit is cleared from the reorder-children mask. Built-in roles cannot be deleted (400). Returns how many users were affected.",
  toolset: "admin",
  minRole: "owner",
  annotations: DESTRUCTIVE,
  input: { slug: z.string().trim().min(1).describe("Slug of the custom role"), ...confirmInput },
  async handler(args, ctx) {
    const result = await ctx.client.request("DELETE", `/api/admin/roles/${seg(args.slug)}`, { schema: RoleDeletedSchema });
    return jsonResult({
      deleted_role: result.slug,
      users_affected: result.users_affected,
      reorder_mask_cleared: result.reorder_mask_cleared,
    });
  },
});

export const adminRolesTools: ToolModule = () => [createRole, renameRole, deleteRole];
