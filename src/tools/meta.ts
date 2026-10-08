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

// list_archives and capture_options are implemented by M1 in this file.
export const metaTools: ToolModule = () => [whoami];
