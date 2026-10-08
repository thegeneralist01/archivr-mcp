import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * The only module that imports the stdio transport, so another transport can replace
 * it without touching the server. stdout carries the protocol: never write to it.
 */
export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);

  await server.connect(transport);
}
