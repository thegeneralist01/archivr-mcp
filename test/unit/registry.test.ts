import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ArchivrApiError, ToolUserError } from "../../src/client/errors";
import { DEFAULT_TOOLSETS, TOOLSETS, type Toolset } from "../../src/config";
import { jsonResult, textResult } from "../../src/lib/output";
import { toolModules, allTools } from "../../src/tools/index";
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  archiveInput,
  assertUniqueNames,
  confirmInput,
  defineTool,
  selectTools,
  type ToolDef,
} from "../../src/tools/registry";
import { callTool, directContext, textOf } from "../helpers/inMemory";
import { CANARY_PASSWORD, CANARY_TOKEN, MockApi, testConfig } from "../helpers/mockFetch";

function fake(name: string, toolset: Toolset, minRole: "guest" | "user" | "admin" | "owner", annotations = READ): ToolDef {
  return defineTool({
    name,
    title: name,
    description: `fake ${name}`,
    toolset,
    minRole,
    annotations,
    input: annotations.destructiveHint ? { ...confirmInput } : {},
    handler: () => textResult(name),
  });
}

const catalog: ToolDef[] = [
  fake("core_read", "core", "user"),
  fake("core_write", "core", "user", WRITE),
  fake("capture_read", "capture", "user"),
  fake("admin_read", "admin", "admin"),
  fake("admin_write", "admin", "admin", WRITE),
  fake("owner_destroy", "admin", "owner", DESTRUCTIVE),
  fake("cred_write", "credentials", "user", WRITE),
  fake("guest_read", "core", "guest"),
];

const names = (tools: ToolDef[]) => tools.map((t) => t.name).sort();
const toolsets = (...t: Toolset[]) => new Set<Toolset>(t);

describe("selectTools", () => {
  test("filters by enabled toolsets", () => {
    const selected = selectTools(catalog, { toolsets: toolsets("core"), readonly: false, me: { roleBits: 15 } });
    expect(names(selected)).toEqual(["core_read", "core_write", "guest_read"]);
  });

  test("credentials tools appear only when the toolset is enabled", () => {
    const on = selectTools(catalog, { toolsets: new Set(TOOLSETS), readonly: false, me: { roleBits: 15 } });
    const off = selectTools(catalog, { toolsets: new Set(DEFAULT_TOOLSETS), readonly: false, me: { roleBits: 15 } });
    expect(names(on)).toContain("cred_write");
    expect(names(off)).not.toContain("cred_write");
  });

  test("filters by role bits (guest / user / admin / owner)", () => {
    const all = new Set(TOOLSETS);
    const pick = (roleBits: number) => names(selectTools(catalog, { toolsets: all, readonly: false, me: { roleBits } }));
    expect(pick(1)).toEqual(["guest_read"]);
    expect(pick(3)).toEqual(["capture_read", "core_read", "core_write", "cred_write", "guest_read"]);
    expect(pick(7)).toContain("admin_read");
    expect(pick(7)).not.toContain("owner_destroy");
    expect(pick(15)).toContain("owner_destroy");
  });

  test("a role mask that lacks the exact bit is excluded (custom role bits grant nothing)", () => {
    const selected = selectTools(catalog, { toolsets: new Set(TOOLSETS), readonly: false, me: { roleBits: 1 | 16 } });
    expect(names(selected)).toEqual(["guest_read"]);
  });

  test("unknown roles (me = null) keeps everything the toolsets allow", () => {
    const selected = selectTools(catalog, { toolsets: new Set(DEFAULT_TOOLSETS), readonly: false, me: null });
    expect(names(selected)).toContain("owner_destroy");
    expect(names(selected)).not.toContain("cred_write");
  });

  test("read-only mode registers only readOnlyHint tools", () => {
    const selected = selectTools(catalog, { toolsets: new Set(TOOLSETS), readonly: true, me: { roleBits: 15 } });
    expect(selected.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect(names(selected)).toEqual(["admin_read", "capture_read", "core_read", "guest_read"]);
  });
});

describe("defineTool invariants", () => {
  const base = { title: "t", description: "d", toolset: "core" as const, minRole: "user" as const, input: {}, handler: () => textResult("x") };

  test("destructive tools must include the confirm input", () => {
    expect(() => defineTool({ ...base, name: "kill_it", annotations: DESTRUCTIVE })).toThrow("confirmInput");
    expect(() => defineTool({ ...base, name: "kill_it", annotations: DESTRUCTIVE, input: { ...confirmInput } })).not.toThrow();
  });

  test("confirm must be literally true", () => {
    expect(confirmInput.confirm.safeParse(true).success).toBe(true);
    expect(confirmInput.confirm.safeParse(false).success).toBe(false);
    expect(confirmInput.confirm.safeParse("yes").success).toBe(false);
    const result = z.object(confirmInput).safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects bad names, empty descriptions and read-only+destructive", () => {
    expect(() => defineTool({ ...base, name: "Bad-Name", annotations: READ })).toThrow("invalid tool name");
    expect(() => defineTool({ ...base, name: "ok_name", description: " ", annotations: READ })).toThrow("description");
    expect(() => defineTool({ ...base, name: "ok_name", annotations: { ...READ, destructiveHint: true }, input: { ...confirmInput } })).toThrow("both");
  });

  test("duplicate names are rejected", () => {
    expect(() => assertUniqueNames([fake("a_b", "core", "user"), fake("a_b", "core", "user")])).toThrow("duplicate");
  });

  test("archive input resolves with ctx.archive()", async () => {
    const api = new MockApi().on("GET", "/api/archives", { json: [{ id: "only", label: "Only" }] });
    const tool = defineTool({
      ...base,
      name: "which_archive",
      annotations: READ,
      input: { ...archiveInput },
      async handler(args, ctx) {
        return jsonResult({ archive: await ctx.archive(args) });
      },
    });
    const direct = directContext({ api });
    expect(JSON.parse(textOf(await callTool(tool, {}, direct)))).toEqual({ archive: "only" });
    expect(JSON.parse(textOf(await callTool(tool, { archive: "x" }, direct)))).toEqual({ archive: "x" });
    expect(api.calls("GET", "/api/archives")).toHaveLength(1); // listing is cached
  });
});

describe("ctx.archive resolution", () => {
  const tool = defineTool({
    name: "which_archive",
    title: "t",
    description: "d",
    toolset: "core",
    minRole: "user",
    annotations: READ,
    input: { ...archiveInput },
    async handler(args, ctx) {
      return jsonResult({ archive: await ctx.archive(args) });
    },
  });

  test("falls back to ARCHIVR_ARCHIVE without listing archives", async () => {
    const api = new MockApi();
    const direct = directContext({ api, config: { archive: "configured" } });
    expect(JSON.parse(textOf(await callTool(tool, {}, direct)))).toEqual({ archive: "configured" });
    expect(api.requests).toHaveLength(0);
  });

  test("errors, naming the ids, when several archives are mounted", async () => {
    const api = new MockApi().on("GET", "/api/archives", { json: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const result = await callTool(tool, {}, directContext({ api }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("a, b");
  });

  test("errors when no archive is mounted", async () => {
    const api = new MockApi().on("GET", "/api/archives", { json: [] });
    expect(textOf(await callTool(tool, {}, directContext({ api })))).toContain("no archives");
  });
});

describe("runTool", () => {
  const leaky = defineTool({
    name: "leaky",
    title: "t",
    description: "d",
    toolset: "credentials",
    minRole: "user",
    annotations: WRITE,
    input: { password: z.string() },
    handler: (args) =>
      textResult(`server echoed ${args.password} and the token ${CANARY_TOKEN} and Bearer ${CANARY_TOKEN}`),
  });

  test("redacts the token and password arguments from output", async () => {
    const out = textOf(await callTool(leaky, { password: CANARY_PASSWORD }));
    expect(out).not.toContain(CANARY_TOKEN);
    expect(out).not.toContain(CANARY_PASSWORD);
    expect(out).toContain("[REDACTED]");
  });

  test("redacts secrets in thrown errors too", async () => {
    const boom = defineTool({
      name: "boom",
      title: "t",
      description: "d",
      toolset: "core",
      minRole: "user",
      annotations: READ,
      input: {},
      handler: () => {
        throw new Error(`failed with ${CANARY_TOKEN}`);
      },
    });
    const result = await callTool(boom, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(CANARY_TOKEN);
  });

  test("maps ArchivrApiError / ToolUserError thrown by handlers to tool errors", async () => {
    const make = (error: Error) =>
      defineTool({ name: "thrower", title: "t", description: "d", toolset: "core", minRole: "user", annotations: READ, input: {}, handler: () => { throw error; } });
    const forbidden = await callTool(make(new ArchivrApiError(403, "insufficient permissions")), {});
    expect(forbidden.isError).toBe(true);
    expect(textOf(forbidden)).toContain("Forbidden");
    expect(textOf(await callTool(make(new ToolUserError("nope")), {}))).toBe("nope");
  });

  test("truncates oversized output to MAX_OUTPUT_CHARS", async () => {
    const big = defineTool({ name: "big", title: "t", description: "d", toolset: "core", minRole: "user", annotations: READ, input: {}, handler: () => textResult("y".repeat(5000)) });
    const text = textOf(await callTool(big, {}, directContext({ config: { maxOutputChars: 500 } })));
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain("truncated");
  });

  test("tool args are typed from the zod shape", async () => {
    const typed = defineTool({
      name: "typed",
      title: "t",
      description: "d",
      toolset: "core",
      minRole: "user",
      annotations: READ,
      input: { n: z.number().int().default(3), s: z.string().optional() },
      handler: (args) => {
        const n: number = args.n;
        const s: string | undefined = args.s;
        return jsonResult({ n, s });
      },
    });
    expect(JSON.parse(textOf(await callTool(typed, {})))).toEqual({ n: 3 });
  });
});

describe("tool modules", () => {
  test("every module is wired, names are unique and conform to the invariants", () => {
    expect(Object.keys(toolModules).sort()).toEqual(
      ["account", "admin-roles", "admin-settings", "admin-users", "artifacts", "capture", "collections", "credentials", "entries", "jobs", "maintenance", "meta", "summaries", "tags"].sort(),
    );
    const tools = allTools();
    expect(() => assertUniqueNames(tools)).not.toThrow();
    for (const tool of tools) {
      if (tool.annotations.destructiveHint) expect("confirm" in tool.input).toBe(true);
      expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint).toBe(false);
    }
    expect(tools.map((t) => t.name)).toContain("whoami");
  });

  test("test config helper keeps the default toolsets", () => {
    expect(testConfig().toolsets.has("core")).toBe(true);
  });
});
