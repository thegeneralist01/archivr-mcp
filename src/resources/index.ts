import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BaseContext } from "../tools/context";

/**
 * Stub: MCP resources (archivr://me, archives, archives/{id}/tags, ...) are implemented
 * in the organize workstream. Keep this exported name and signature.
 */
export function registerResources(_server: McpServer, _ctx: BaseContext): void {}
