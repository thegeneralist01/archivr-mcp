import { z } from "zod";
import { describeError, errorResult, ToolUserError } from "../client/errors";
import { seg } from "../client/http";
import { TagSchema, TagTreeSchema, type Tag, type TagNode } from "../client/schemas";
import { jsonResult } from "../lib/output";
import { archiveInput, confirmInput, defineTool, DESTRUCTIVE, READ, WRITE, type ToolModule } from "./registry";

const TAG_PATH_HELP =
  'Slash-separated path such as "projects/rust/async". Missing ancestors are created. ' +
  "Each segment is slugified (lower-cased, spaces become dashes) and shown with a humanized name.";

function countTags(nodes: readonly TagNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countTags(node.children), 0);
}

export const listTags = defineTool({
  name: "list_tags",
  title: "List tags",
  description:
    "List the archive's tag tree. Each node has the tag ({tag_uid, name, slug, full_path}), `entry_count` (entries tagged " +
    "directly with it), `subtree_count` (entries tagged with it or any descendant) and `children`. Use the tag_uid values " +
    "with update_tag, untag_entry and delete_tag.",
  toolset: "organize",
  minRole: "user",
  annotations: READ,
  input: { ...archiveInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const tree = await ctx.client.request("GET", `/api/archives/${seg(archive)}/tags`, { schema: TagTreeSchema });
    return jsonResult({ total_tags: countTags(tree), tags: tree });
  },
});

export const createTag = defineTool({
  name: "create_tag",
  title: "Create tag",
  description:
    `Create a tag (and any missing ancestors) without attaching it to an entry. Path format: ${TAG_PATH_HELP} ` +
    "Creating a path that already exists returns the existing tag. Returns the leaf tag.",
  toolset: "organize",
  minRole: "user",
  annotations: WRITE,
  input: {
    ...archiveInput,
    path: z.string().trim().min(1).describe('Tag path, e.g. "reading/papers/ml"'),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const tag = await ctx.client.request("POST", `/api/archives/${seg(archive)}/tags`, {
      json: { path: args.path },
      schema: TagSchema,
    });
    return jsonResult({ created: tag });
  },
});

export const updateTag = defineTool({
  name: "update_tag",
  title: "Rename or move tag",
  description:
    "Rename a tag and/or move it (with its whole subtree) under a different parent. Give `name` (the new last path segment, " +
    "slugified by the server), `parent_uid` (the new parent's tag_uid; null or \"\" moves the tag to the root), or both. " +
    "When both are given, two requests are made in this order: first the rename (PATCH), then the move (POST .../move). " +
    "If the rename succeeds but the move fails, the rename stays applied and the error result says so, so you can retry " +
    "only the move. A failed rename means nothing was changed. The server rejects name collisions, moving a tag under " +
    "itself or its descendants, and unknown parents. Returns the updated tag (new full_path).",
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    tag_uid: z.string().min(1).describe("tag_uid from list_tags"),
    name: z.string().trim().min(1).optional().describe("New name for the tag (last path segment only, no slashes)"),
    parent_uid: z
      .string()
      .nullable()
      .optional()
      .describe("tag_uid of the new parent. null or \"\" moves the tag to the root. Omit to keep the current parent."),
  },
  async handler(args, ctx) {
    const wantsRename = args.name !== undefined;
    const wantsMove = args.parent_uid !== undefined;
    if (!wantsRename && !wantsMove) throw new ToolUserError("Pass `name`, `parent_uid`, or both.");
    if (args.name?.includes("/")) {
      throw new ToolUserError("`name` is a single segment and must not contain '/'; use parent_uid to move the tag.");
    }
    const base = `/api/archives/${seg(await ctx.archive(args))}/tags/${seg(args.tag_uid)}`;

    let tag: Tag | undefined;
    const applied: string[] = [];
    if (args.name !== undefined) {
      tag = await ctx.client.request("PATCH", base, { json: { name: args.name }, schema: TagSchema });
      applied.push("rename");
    }
    if (args.parent_uid !== undefined) {
      const parentUid = args.parent_uid === "" ? null : args.parent_uid;
      try {
        tag = await ctx.client.request("POST", `${base}/move`, { json: { parent_uid: parentUid }, schema: TagSchema });
        applied.push("move");
      } catch (error) {
        if (applied.length === 0) throw error;
        return errorResult(
          `Partial failure: the rename was applied (tag is now "${tag?.full_path ?? "?"}") but the move failed. ` +
            `${describeError(error)} Retry only the move with parent_uid.`,
        );
      }
    }
    return jsonResult({ updated: tag, applied });
  },
});

export const tagEntry = defineTool({
  name: "tag_entry",
  title: "Tag entry",
  description:
    `Attach a tag to an entry, creating the tag path if it does not exist. Path format: ${TAG_PATH_HELP} ` +
    "Returns the tag that is now attached.",
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    entry_uid: z.string().min(1).describe("Entry uid"),
    tag_path: z.string().trim().min(1).describe('Tag path, e.g. "reading/papers/ml"'),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const tag = await ctx.client.request("POST", `/api/archives/${seg(archive)}/entries/${seg(args.entry_uid)}/tags`, {
      json: { tag_path: args.tag_path },
      schema: TagSchema,
    });
    return jsonResult({ entry_uid: args.entry_uid, tagged: tag });
  },
});

export const untagEntry = defineTool({
  name: "untag_entry",
  title: "Untag entry",
  description:
    "Detach a tag from one entry. The tag itself stays (use delete_tag to remove it). " +
    "The server answers 404 if the entry or the tag is unknown, or the tag is not attached.",
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    entry_uid: z.string().min(1).describe("Entry uid"),
    tag_uid: z.string().min(1).describe("tag_uid to detach (see list_tags)"),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request(
      "DELETE",
      `/api/archives/${seg(archive)}/entries/${seg(args.entry_uid)}/tags/${seg(args.tag_uid)}`,
    );
    return jsonResult({ entry_uid: args.entry_uid, untagged: args.tag_uid });
  },
});

export const deleteTag = defineTool({
  name: "delete_tag",
  title: "Delete tag",
  description:
    "Permanently delete a tag AND ALL OF ITS DESCENDANT TAGS, detaching them from every entry. Entries themselves are not " +
    "deleted. Check list_tags (subtree_count) first. Requires confirm: true.",
  toolset: "organize",
  minRole: "user",
  annotations: DESTRUCTIVE,
  input: {
    ...archiveInput,
    tag_uid: z.string().min(1).describe("tag_uid to delete (see list_tags)"),
    ...confirmInput,
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request("DELETE", `/api/archives/${seg(archive)}/tags/${seg(args.tag_uid)}`);
    return jsonResult({ deleted: args.tag_uid });
  },
});

export const tagsTools: ToolModule = () => [listTags, createTag, updateTag, tagEntry, untagEntry, deleteTag];
