import { MountedArchiveListSchema, CaptureOptionsSchema } from "../client/schemas";
import { jsonResult } from "../lib/output";
import { defineTool, READ, type ToolModule } from "./registry";

export const whoami = defineTool({
  name: "whoami",
  title: "Who am I",
  description:
    "Show the Archivr user this MCP server is authenticated as: username, roles, whether child reordering is allowed, " +
    "the default archive, and which toolsets and read-only mode are active. Use it to find out what you are permitted to do.",
  toolset: "core",
  minRole: "guest",
  annotations: READ,
  input: {},
  async handler(_args, ctx) {
    const { me, config } = ctx;
    return jsonResult({
      username: me?.username ?? null,
      display_name: me?.displayName ?? null,
      user_uid: me?.userUid ?? null,
      roles: me?.roles ?? null,
      role_bits: me?.roleBits ?? null,
      can_reorder_children: me?.canReorderChildren ?? null,
      default_archive: config.archive ?? null,
      enabled_toolsets: [...config.toolsets],
      readonly: config.readonly,
      ...(me === null ? { warning: "Could not verify the token at startup (Archivr was unreachable); roles are unknown." } : {}),
    });
  },
});

export const listArchives = defineTool({
  name: "list_archives",
  title: "List archives",
  description:
    "List the archives mounted on the Archivr server (id and label). Pass an id as the `archive` argument of other tools; " +
    "it can be omitted when only one archive is mounted or ARCHIVR_ARCHIVE is set.",
  toolset: "core",
  minRole: "guest",
  annotations: READ,
  input: {},
  async handler(_args, ctx) {
    const archives = await ctx.client.request("GET", "/api/archives", { schema: MountedArchiveListSchema });
    // Filesystem paths (admin-only on the server) are deliberately not forwarded.
    return jsonResult({
      archives: archives.map((a) => ({ id: a.id, label: a.label })),
      default_archive: ctx.config.archive ?? null,
    });
  },
});

export const captureOptions = defineTool({
  name: "capture_options",
  title: "Capture options",
  description:
    "Show the server's capture defaults and what is available: ad-blocker / cookie-banner / modal-closer settings, whether those " +
    "browser extensions are installed, reader mode, Freedium, subtitle download defaults and the LLM providers usable for titles.",
  toolset: "core",
  minRole: "user",
  annotations: READ,
  input: {},
  async handler(_args, ctx) {
    return jsonResult(await ctx.client.request("GET", "/api/captures/options", { schema: CaptureOptionsSchema }));
  },
});

export const metaTools: ToolModule = () => [whoami, listArchives, captureOptions];
