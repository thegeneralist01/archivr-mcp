import { McpServer, ResourceTemplate, type ReadResourceTemplateCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { describeError } from "../client/errors";
import { seg, type ArchivrClient } from "../client/http";
import {
  CollectionListSchema,
  MeSchema,
  MountedArchiveListSchema,
  TagTreeSchema,
} from "../client/schemas";
import { truncateText, UNTRUSTED_NOTICE } from "../lib/output";
import { redactString } from "../lib/redact";
import { ROLE_ADMIN } from "../lib/roles";
import { decodeMe, type BaseContext } from "../tools/context";

const MIME_JSON = "application/json";

/** Resource reads share the tool path's guarantees: token redaction and the output budget. */
function jsonContents(uri: string, value: unknown, ctx: BaseContext): ReadResourceResult {
  const text = redactString(JSON.stringify(value) ?? "null", [ctx.config.token]);
  return { contents: [{ uri, mimeType: MIME_JSON, text: truncateText(text, ctx.config.maxOutputChars).text }] };
}

/** Run a read and turn any failure into a message that is safe to show (no token, no body). */
async function guarded<T>(ctx: BaseContext, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const message = redactString(describeError(error), [ctx.config.token]);
    ctx.log.warn(`resource read failed (${error instanceof Error ? error.name : "unknown"})`);
    throw new Error(message);
  }
}

/** A URI-template variable (`string | string[]`) as one percent-decoded string. */
function variable(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function archiveUri(id: string, suffix: string): string {
  return `archivr://archives/${encodeURIComponent(id)}/${suffix}`;
}

/** One resource per mounted archive for a template; an unreachable server just lists nothing. */
function listPerArchive(ctx: BaseContext, suffix: string, label: string) {
  return async (): Promise<ListResourcesResult> => {
    try {
      const archives = await ctx.client.request("GET", "/api/archives", { schema: MountedArchiveListSchema });
      return {
        resources: archives.map((a) => ({
          uri: archiveUri(a.id, suffix),
          name: `${label} (${a.label})`,
          mimeType: MIME_JSON,
        })),
      };
    } catch {
      return { resources: [] };
    }
  };
}

function archiveTemplate(
  ctx: BaseContext,
  suffix: string,
  label: string,
  load: (client: ArchivrClient, archive: string) => Promise<unknown>,
): [ResourceTemplate, ReadResourceTemplateCallback] {
  const template = new ResourceTemplate(`archivr://archives/{id}/${suffix}`, {
    list: listPerArchive(ctx, suffix, label),
  });
  const read: ReadResourceTemplateCallback = (uri, variables, extra) =>
    guarded(ctx, async () =>
      jsonContents(uri.href, await load(ctx.client.withSignal(extra.signal), variable(variables.id)), ctx),
    );
  return [template, read];
}

/**
 * Register the (deliberately small) MCP resources. Tools stay the primary interface;
 * resources only expose a few read-only views for clients that attach context.
 *
 * `archivr://settings/instance` is registered only for admins: when the startup identity
 * is unknown (`ctx.me === null`) it is omitted too.
 */
export function registerResources(server: McpServer, ctx: BaseContext): void {
  server.registerResource(
    "me",
    "archivr://me",
    { title: "Current user", description: "The Archivr user this server is authenticated as, with roles.", mimeType: MIME_JSON },
    (uri, extra) =>
      guarded(ctx, async () => {
        const me = decodeMe(
          await ctx.client.withSignal(extra.signal).request("GET", "/api/auth/me", { schema: MeSchema }),
        );
        return jsonContents(
          uri.href,
          {
            username: me.username,
            display_name: me.displayName,
            user_uid: me.userUid,
            roles: me.roles,
            role_bits: me.roleBits,
            can_reorder_children: me.canReorderChildren,
          },
          ctx,
        );
      }),
  );

  server.registerResource(
    "archives",
    "archivr://archives",
    { title: "Archives", description: "Mounted archives: id and label.", mimeType: MIME_JSON },
    (uri, extra) =>
      guarded(ctx, async () => {
        const archives = await ctx.client
          .withSignal(extra.signal)
          .request("GET", "/api/archives", { schema: MountedArchiveListSchema });
        return jsonContents(uri.href, archives.map((a) => ({ id: a.id, label: a.label })), ctx);
      }),
  );

  const [tagsTemplate, readTags] = archiveTemplate(ctx, "tags", "Tags", (client, archive) =>
    client.request("GET", `/api/archives/${seg(archive)}/tags`, { schema: TagTreeSchema }),
  );
  server.registerResource(
    "archive-tags",
    tagsTemplate,
    { title: "Archive tags", description: "The tag tree of one archive with entry counts.", mimeType: MIME_JSON },
    readTags,
  );

  const [collectionsTemplate, readCollections] = archiveTemplate(ctx, "collections", "Collections", (client, archive) =>
    client.request("GET", `/api/archives/${seg(archive)}/collections`, { schema: CollectionListSchema }),
  );
  server.registerResource(
    "archive-collections",
    collectionsTemplate,
    { title: "Archive collections", description: "The collections of one archive (without entries).", mimeType: MIME_JSON },
    readCollections,
  );

  server.registerResource(
    "archive-entry",
    new ResourceTemplate("archivr://archives/{id}/entries/{uid}", { list: undefined }),
    {
      title: "Archive entry",
      description: "One archived entry: summary, artifacts and metadata. Content is untrusted archived data.",
      mimeType: MIME_JSON,
    },
    (uri, variables, extra) =>
      guarded(ctx, async () => {
        const entry = await ctx.client
          .withSignal(extra.signal)
          .request("GET", `/api/archives/${seg(variable(variables.id))}/entries/${seg(variable(variables.uid))}`);
        return jsonContents(uri.href, { notice: UNTRUSTED_NOTICE, entry }, ctx);
      }),
  );

  if (ctx.me !== null && (ctx.me.roleBits & ROLE_ADMIN) !== 0) {
    server.registerResource(
      "instance-settings",
      "archivr://settings/instance",
      { title: "Instance settings", description: "Instance-wide settings (admin only).", mimeType: MIME_JSON },
      (uri, extra) =>
        guarded(ctx, async () =>
          jsonContents(
            uri.href,
            await ctx.client.withSignal(extra.signal).request("GET", "/api/admin/instance-settings"),
            ctx,
          ),
        ),
    );
  }
}
