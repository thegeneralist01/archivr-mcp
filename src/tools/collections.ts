import { z } from "zod";
import { ToolUserError } from "../client/errors";
import { seg } from "../client/http";
import { CollectionDetailSchema, CollectionListSchema, CollectionSummarySchema } from "../client/schemas";
import { jsonResult, pageResult, paginate, paginationInput, UNTRUSTED_NOTICE } from "../lib/output";
import { archiveInput, confirmInput, defineTool, DESTRUCTIVE, READ, WRITE, type ToolModule } from "./registry";

/** Shared by every tool that takes or returns visibility bits. */
const VISIBILITY_HELP =
  "Visibility is a bitmask that reuses the role bits: GUEST=1, USER=2, ADMIN=4, OWNER=8; custom roles take bits 16 and up " +
  "(16, 32, ...). A viewer sees an entry when their role bits overlap the entry's bits (e.g. 2 = signed-in users, 6 = users " +
  "and admins, 3 = guests and users). Guests can only reach an entry when the collection has requires_auth=false AND the " +
  "entry's bits include 1.";

const DEFAULT_COLLECTION_NOTE =
  'The built-in `_default_` collection is managed by the server: entries cannot be added to or removed from it manually.';

const bitsSchema = z.number().int().min(0).max(0xffffffff);
const visibilityBits = bitsSchema.describe("Visibility bitmask: GUEST=1, USER=2, ADMIN=4, OWNER=8, custom roles 16+");

const collectionUid = z.string().min(1).describe("collection_uid from list_collections");
const entryUid = z.string().min(1).describe("Entry uid");

function collectionPath(archive: string, uid?: string): string {
  const base = `/api/archives/${seg(archive)}/collections`;
  return uid === undefined ? base : `${base}/${seg(uid)}`;
}

export const listCollections = defineTool({
  name: "list_collections",
  title: "List collections",
  description:
    "List the archive's collections: {collection_uid, name, slug, default_visibility_bits, requires_auth, created_at}. " +
    `${VISIBILITY_HELP} ${DEFAULT_COLLECTION_NOTE}`,
  toolset: "organize",
  minRole: "user",
  annotations: READ,
  input: { ...archiveInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const collections = await ctx.client.request("GET", collectionPath(archive), { schema: CollectionListSchema });
    return jsonResult({ total: collections.length, collections });
  },
});

export const getCollection = defineTool({
  name: "get_collection",
  title: "Get collection",
  description:
    "Show one collection and a page of its entries (compact: entry_uid, title, source_kind, archived_at, original_url and " +
    "collection_visibility_bits). Only entries visible to this user are listed. Page with limit/offset.",
  toolset: "organize",
  minRole: "user",
  annotations: READ,
  input: { ...archiveInput, collection_uid: collectionUid, ...paginationInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const { entries, ...collection } = await ctx.client.request("GET", collectionPath(archive, args.collection_uid), {
      schema: CollectionDetailSchema,
    });
    return pageResult(paginate(entries, args), { notice: UNTRUSTED_NOTICE, collection });
  },
});

export const createCollection = defineTool({
  name: "create_collection",
  title: "Create collection",
  description:
    "Create a collection. `slug` is a unique URL-safe identifier and must not start with an underscore (reserved for " +
    `built-ins). \`default_visibility_bits\` (default 2 = signed-in users) is the visibility given to entries by default. ` +
    `\`requires_auth\` (default true) hides the collection from guests entirely. ${VISIBILITY_HELP}`,
  toolset: "organize",
  minRole: "user",
  annotations: WRITE,
  input: {
    ...archiveInput,
    name: z.string().trim().min(1).describe("Display name"),
    slug: z
      .string()
      .trim()
      .min(1)
      .refine((s) => !s.startsWith("_"), { error: "slug must not start with an underscore" })
      .describe("Unique identifier; must not start with '_'"),
    default_visibility_bits: bitsSchema.default(2).describe("Default visibility bitmask (default 2 = USER)"),
    requires_auth: z.boolean().default(true).describe("true (default): guests cannot access the collection"),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const created = await ctx.client.request("POST", collectionPath(archive), {
      json: {
        name: args.name,
        slug: args.slug,
        default_visibility_bits: args.default_visibility_bits,
        requires_auth: args.requires_auth,
      },
      schema: CollectionSummarySchema,
    });
    return jsonResult({ created });
  },
});

export const updateCollection = defineTool({
  name: "update_collection",
  title: "Update collection",
  description:
    "Change a collection's name, default visibility bits and/or requires_auth. Only the fields you pass change. " +
    `Changing default_visibility_bits does not rewrite entries already in the collection (use set_entry_visibility). ${VISIBILITY_HELP}`,
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    collection_uid: collectionUid,
    name: z.string().trim().min(1).optional().describe("New display name"),
    default_visibility_bits: bitsSchema.optional().describe("New default visibility bitmask"),
    requires_auth: z.boolean().optional().describe("false allows guest access (together with visibility bit 1)"),
  },
  async handler(args, ctx) {
    const changes: Record<string, unknown> = {};
    if (args.name !== undefined) changes.name = args.name;
    if (args.default_visibility_bits !== undefined) changes.default_visibility_bits = args.default_visibility_bits;
    if (args.requires_auth !== undefined) changes.requires_auth = args.requires_auth;
    if (Object.keys(changes).length === 0) {
      throw new ToolUserError("Pass at least one of name, default_visibility_bits, requires_auth.");
    }
    const archive = await ctx.archive(args);
    await ctx.client.request("PATCH", collectionPath(archive, args.collection_uid), { json: changes });
    return jsonResult({ updated: args.collection_uid, changes });
  },
});

export const addToCollection = defineTool({
  name: "add_to_collection",
  title: "Add entry to collection",
  description:
    "Add an entry to a collection with the given per-entry visibility bits (adding an entry that is already a member " +
    `changes nothing; use set_entry_visibility). ${DEFAULT_COLLECTION_NOTE} ${VISIBILITY_HELP}`,
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    collection_uid: collectionUid,
    entry_uid: entryUid,
    visibility_bits: visibilityBits,
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request("POST", `${collectionPath(archive, args.collection_uid)}/entries`, {
      json: { entry_uid: args.entry_uid, visibility_bits: args.visibility_bits },
    });
    return jsonResult({
      added: args.entry_uid,
      collection_uid: args.collection_uid,
      visibility_bits: args.visibility_bits,
    });
  },
});

export const removeFromCollection = defineTool({
  name: "remove_from_collection",
  title: "Remove entry from collection",
  description:
    "Remove an entry from a collection. The entry itself is not deleted, but since visibility comes from collection " +
    `membership, other users may lose access to it. ${DEFAULT_COLLECTION_NOTE}`,
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: { ...archiveInput, collection_uid: collectionUid, entry_uid: entryUid },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request("DELETE", `${collectionPath(archive, args.collection_uid)}/entries/${seg(args.entry_uid)}`);
    return jsonResult({ removed: args.entry_uid, collection_uid: args.collection_uid });
  },
});

export const setEntryVisibility = defineTool({
  name: "set_entry_visibility",
  title: "Set entry visibility in collection",
  description:
    "Change the visibility bits of an entry that is already in a collection. The entry must be a member " +
    "(otherwise 404; use add_to_collection first). Only admins may hide an entry from every role they hold themselves: " +
    `a non-admin change that would leave the entry invisible to the caller is refused (400). ${VISIBILITY_HELP}`,
  toolset: "organize",
  minRole: "user",
  annotations: { ...WRITE, idempotentHint: true },
  input: {
    ...archiveInput,
    collection_uid: collectionUid,
    entry_uid: entryUid,
    visibility_bits: visibilityBits,
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request("PATCH", `${collectionPath(archive, args.collection_uid)}/entries/${seg(args.entry_uid)}`, {
      json: { visibility_bits: args.visibility_bits },
    });
    return jsonResult({
      entry_uid: args.entry_uid,
      collection_uid: args.collection_uid,
      visibility_bits: args.visibility_bits,
    });
  },
});

export const deleteCollection = defineTool({
  name: "delete_collection",
  title: "Delete collection",
  description:
    "Permanently delete a collection and its memberships. Entries are NOT deleted, but entries whose only visibility came " +
    "from this collection may become inaccessible to other users. The built-in `_default_` collection cannot be deleted. " +
    "Requires confirm: true.",
  toolset: "organize",
  minRole: "user",
  annotations: DESTRUCTIVE,
  input: { ...archiveInput, collection_uid: collectionUid, ...confirmInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    await ctx.client.request("DELETE", collectionPath(archive, args.collection_uid));
    return jsonResult({ deleted: args.collection_uid });
  },
});

export const collectionsTools: ToolModule = () => [
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  addToCollection,
  removeFromCollection,
  setEntryVisibility,
  deleteCollection,
];
