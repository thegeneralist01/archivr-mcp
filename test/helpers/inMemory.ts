import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../../src/config";
import { createServer, type ArchivrMcp } from "../../src/server";
import { createBaseContext, decodeMe, toToolContext, type BaseContext, type Me, type ToolContext } from "../../src/tools/context";
import { MeSchema } from "../../src/client/schemas";
import { runTool, type ToolDef } from "../../src/tools/registry";
import { silentLogger } from "../../src/lib/log";
import { ME, MockApi, testConfig } from "./mockFetch";

export interface Connected {
  /** A real MCP client connected to the server over InMemoryTransport. */
  client: Client;
  mcp: ArchivrMcp;
  api: MockApi;
  close(): Promise<void>;
}

export interface ConnectOptions {
  api?: MockApi;
  config?: Partial<Config>;
  /** `/api/auth/me` body; default is the owner. Pass an Error to simulate an unreachable server. */
  me?: (typeof ME)[keyof typeof ME] | Error;
  /** Replace the tool set (default: every real module). */
  tools?: readonly ToolDef[];
}

/**
 * Start `createServer` against a mocked Archivr API and connect a real MCP client to it.
 * `GET /api/auth/me` is pre-registered unless the caller's `api` already handles it.
 */
export async function connectInMemory(options: ConnectOptions = {}): Promise<Connected> {
  const api = options.api ?? new MockApi();
  // Register the default identity unless the caller brought their own api and handles /me itself.
  if (options.api === undefined || options.me !== undefined) {
    const meReply = options.me ?? ME.owner;
    api.on("GET", "/api/auth/me", meReply instanceof Error ? meReply : { json: meReply });
  }

  const mcp = await createServer(testConfig(options.config), api.client(), {
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    log: silentLogger,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([mcp.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    mcp,
    api,
    close: async () => {
      await client.close();
      await mcp.server.close();
    },
  };
}

/** First text block of a tool result. */
export function textOf(result: unknown): string {
  const blocks = (result as { content: Array<{ type: string; text?: string }> }).content;
  const block = blocks.find((b) => b.type === "text");
  if (block?.text === undefined) throw new Error("result has no text block");
  return block.text;
}

/** Parse the first text block as JSON. */
export function jsonOf(result: unknown): unknown {
  return JSON.parse(textOf(result)) as unknown;
}

export function toolNames(tools: Array<{ name: string }>): string[] {
  return tools.map((t) => t.name).sort();
}

// ── Direct handler testing (no MCP transport) ───────────────────────────────

export interface DirectContext {
  base: BaseContext;
  ctx: ToolContext;
  api: MockApi;
}

/** Build a ToolContext over a MockApi for unit-testing a tool handler directly. */
export function directContext(
  options: { api?: MockApi; config?: Partial<Config>; me?: Me | null; meBody?: (typeof ME)[keyof typeof ME] } = {},
): DirectContext {
  const api = options.api ?? new MockApi();
  const config = testConfig(options.config);
  const me = options.me !== undefined ? options.me : decodeMe(MeSchema.parse(options.meBody ?? ME.owner));
  const base = createBaseContext({ client: api.client(), config, me, log: silentLogger });
  return { base, ctx: toToolContext(base, { signal: new AbortController().signal }), api };
}

/**
 * Validate `rawArgs` against the tool's input schema (as the SDK would) and run it through
 * the full execution path: error mapping, redaction and truncation.
 */
export async function callTool(
  tool: ToolDef,
  rawArgs: Record<string, unknown>,
  direct: DirectContext = directContext(),
): Promise<CallToolResult> {
  const parsed: unknown = z.object(tool.input).parse(rawArgs);
  return runTool(tool, parsed, direct.base, {
    signal: new AbortController().signal,
    sendNotification: async () => {},
  });
}
