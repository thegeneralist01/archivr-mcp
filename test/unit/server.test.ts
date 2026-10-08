import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ArchivrApiError } from "../../src/client/errors";
import { createServer } from "../../src/server";
import { jsonResult, textResult } from "../../src/lib/output";
import { TOOLSETS } from "../../src/config";
import { DESTRUCTIVE, READ, WRITE, confirmInput, defineTool, type ToolDef } from "../../src/tools/registry";
import { connectInMemory, jsonOf, textOf, toolNames, type Connected } from "../helpers/inMemory";
import { CANARY_PASSWORD, CANARY_TOKEN, ME, MockApi, testConfig } from "../helpers/mockFetch";

let connected: Connected | undefined;
afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const t = (name: string, toolset: ToolDef["toolset"], minRole: ToolDef["minRole"], annotations = READ) =>
  defineTool({
    name,
    title: name,
    description: name,
    toolset,
    minRole,
    annotations,
    input: annotations.destructiveHint ? { ...confirmInput } : {},
    handler: () => textResult(name),
  });

describe("MCP smoke test over InMemoryTransport", () => {
  test("lists tools and calls the real whoami end to end", async () => {
    connected = await connectInMemory();
    const { tools } = await connected.client.listTools();
    expect(toolNames(tools)).toContain("whoami");
    const whoami = tools.find((x) => x.name === "whoami");
    expect(whoami?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(whoami?.title).toBe("Who am I");

    const result = await connected.client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({
      username: "root",
      display_name: "The Owner",
      user_uid: "usr_owner",
      roles: ["user", "admin", "owner"],
      role_bits: 15,
      can_reorder_children: true,
      enabled_toolsets: ["core", "capture", "organize", "account", "admin"],
      readonly: false,
    });
    // /me was called once at startup with the Bearer token.
    expect(connected.api.calls("GET", "/api/auth/me")).toHaveLength(1);
    expect(connected.api.requests[0]?.headers.get("authorization")).toBe(`Bearer ${CANARY_TOKEN}`);
  });

  test("whoami output never contains the token", async () => {
    connected = await connectInMemory();
    const result = await connected.client.callTool({ name: "whoami", arguments: {} });
    expect(textOf(result)).not.toContain(CANARY_TOKEN);
  });

  test("role-based visibility: a USER token does not see admin tools", async () => {
    const tools = [t("user_tool", "core", "user"), t("admin_tool", "admin", "admin"), t("owner_tool", "admin", "owner", DESTRUCTIVE)];
    connected = await connectInMemory({ me: ME.user, tools });
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["user_tool"]);
    await connected.close();

    connected = await connectInMemory({ me: ME.admin, tools });
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["admin_tool", "user_tool"]);
    await connected.close();

    connected = await connectInMemory({ me: ME.owner, tools });
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["admin_tool", "owner_tool", "user_tool"]);
  });

  test("toolset and read-only filters apply", async () => {
    const tools = [t("read_core", "core", "user"), t("write_core", "core", "user", WRITE), t("read_cap", "capture", "user"), t("cred", "credentials", "user", WRITE)];
    connected = await connectInMemory({ tools, config: { toolsets: new Set(["core", "credentials"]) } });
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["cred", "read_core", "write_core"]);
    await connected.close();

    connected = await connectInMemory({ tools, config: { readonly: true, toolsets: new Set(TOOLSETS) } });
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["read_cap", "read_core"]);
  });

  test("an unreachable server at startup registers every enabled toolset", async () => {
    const tools = [t("user_tool", "core", "user"), t("admin_tool", "admin", "admin")];
    connected = await connectInMemory({ me: new TypeError("fetch failed"), tools });
    expect(connected.mcp.me).toBeNull();
    expect(toolNames((await connected.client.listTools()).tools)).toEqual(["admin_tool", "user_tool"]);
  });

  test("whoami warns when roles are unknown", async () => {
    connected = await connectInMemory({ me: new TypeError("fetch failed") });
    const out = jsonOf(await connected.client.callTool({ name: "whoami", arguments: {} })) as Record<string, unknown>;
    expect(out["username"]).toBeNull();
    expect(String(out["warning"])).toContain("unreachable");
  });

  test("a 401 from /api/auth/me rejects createServer (index.ts exits nonzero)", async () => {
    const api = new MockApi().on("GET", "/api/auth/me", { status: 401, json: { error: "login required" } });
    const err = await createServer(testConfig(), api.client()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchivrApiError);
    expect((err as ArchivrApiError).status).toBe(401);
  });

  test("other /me failures (e.g. 500) do not block startup", async () => {
    const api = new MockApi().on("GET", "/api/auth/me", { status: 500, text: "oops" });
    const mcp = await createServer(testConfig(), api.client());
    expect(mcp.me).toBeNull();
    expect(mcp.toolNames).toContain("whoami");
  });

  test("tool input is validated by the SDK; bad args return an error result", async () => {
    const strict = defineTool({
      name: "needs_n", title: "t", description: "d", toolset: "core", minRole: "user", annotations: READ,
      input: { n: z.number().int() },
      handler: (args) => jsonResult({ n: args.n }),
    });
    connected = await connectInMemory({ tools: [strict] });
    const bad = await connected.client.callTool({ name: "needs_n", arguments: { n: "x" } });
    expect(bad.isError).toBe(true);
    const good = await connected.client.callTool({ name: "needs_n", arguments: { n: 4 } });
    expect(jsonOf(good)).toEqual({ n: 4 });
  });

  test("destructive tools are refused without confirm: true", async () => {
    let ran = false;
    const del = defineTool({
      name: "delete_x", title: "t", description: "d", toolset: "core", minRole: "user", annotations: DESTRUCTIVE,
      input: { id: z.string(), ...confirmInput },
      handler: () => { ran = true; return textResult("deleted"); },
    });
    connected = await connectInMemory({ tools: [del] });
    expect((await connected.client.callTool({ name: "delete_x", arguments: { id: "a" } })).isError).toBe(true);
    expect((await connected.client.callTool({ name: "delete_x", arguments: { id: "a", confirm: false } })).isError).toBe(true);
    expect(ran).toBe(false);
    expect((await connected.client.callTool({ name: "delete_x", arguments: { id: "a", confirm: true } })).isError).toBeFalsy();
    expect(ran).toBe(true);
  });

  test("password arguments and the token are redacted from results end to end", async () => {
    const echo = defineTool({
      name: "echo_secret", title: "t", description: "d", toolset: "core", minRole: "user", annotations: WRITE,
      input: { password: z.string() },
      handler: (args, ctx) => textResult(`got ${args.password} via ${ctx.config.token}`),
    });
    connected = await connectInMemory({ tools: [echo] });
    const out = textOf(await connected.client.callTool({ name: "echo_secret", arguments: { password: CANARY_PASSWORD } }));
    expect(out).not.toContain(CANARY_PASSWORD);
    expect(out).not.toContain(CANARY_TOKEN);
  });

  test("progress notifications are sent only when the client asks for them", async () => {
    const slow = defineTool({
      name: "slow_job", title: "t", description: "d", toolset: "core", minRole: "user", annotations: READ,
      input: {},
      async handler(_args, ctx) {
        await ctx.progress({ progress: 1, total: 2, message: "half" });
        return textResult("done");
      },
    });
    connected = await connectInMemory({ tools: [slow] });
    const seen: Array<{ progress: number; total?: number | undefined; message?: string | undefined }> = [];
    await connected.client.callTool({ name: "slow_job", arguments: {} }, undefined, { onprogress: (p) => seen.push(p) });
    expect(seen).toEqual([{ progress: 1, total: 2, message: "half" }]);
    seen.length = 0;
    await connected.client.callTool({ name: "slow_job", arguments: {} });
    expect(seen).toEqual([]);
  });
});
