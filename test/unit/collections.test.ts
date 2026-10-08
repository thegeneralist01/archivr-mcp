import { describe, expect, test } from "bun:test";
import { collectionsTools } from "../../src/tools/collections";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

const tools = Object.fromEntries(collectionsTools().map((t) => [t.name, t]));
const tool = (name: string) => {
  const t = tools[name];
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const setup = () => {
  const api = new MockApi();
  return { api, direct: directContext({ api, config: { archive: "main" } }) };
};
const COLL = {
  collection_uid: "col_1",
  name: "Reading",
  slug: "reading",
  default_visibility_bits: 2,
  requires_auth: true,
  created_at: "2026-01-01T00:00:00Z",
};
const entry = (n: number) => ({
  entry_uid: `ent_${n}`,
  title: `Entry ${n}`,
  source_kind: "web",
  archived_at: "2026-01-01T00:00:00Z",
  original_url: null,
  collection_visibility_bits: 2,
});

describe("collection tools", () => {
  test("registers eight organize/user tools; destructive only on delete", () => {
    expect(Object.keys(tools)).toEqual([
      "list_collections",
      "get_collection",
      "create_collection",
      "update_collection",
      "add_to_collection",
      "remove_from_collection",
      "set_entry_visibility",
      "delete_collection",
    ]);
    for (const t of Object.values(tools)) {
      expect(t.toolset).toBe("organize");
      expect(t.minRole).toBe("user");
      expect(t.annotations.destructiveHint).toBe(t.name === "delete_collection");
    }
    expect(tool("list_collections").annotations.readOnlyHint).toBe(true);
    expect(tool("get_collection").annotations.readOnlyHint).toBe(true);
  });

  test("descriptions document visibility bits and the default collection", () => {
    expect(tool("create_collection").description).toContain("GUEST=1");
    expect(tool("create_collection").description).toContain("requires_auth=false AND");
    expect(tool("add_to_collection").description).toContain("_default_");
    expect(tool("remove_from_collection").description).toContain("_default_");
  });

  test("list_collections", async () => {
    const { api, direct } = setup();
    api.on("GET", "/api/archives/main/collections", { json: [COLL] });
    const result = await callTool(tool("list_collections"), {}, direct);
    expect(jsonOf(result)).toEqual({ total: 1, collections: [COLL] });
  });

  test("get_collection paginates entries and encodes the uid", async () => {
    const { api, direct } = setup();
    api.on("GET", "/api/archives/main/collections/:c", { json: { ...COLL, entries: [1, 2, 3, 4, 5].map(entry) } });
    const first = jsonOf(await callTool(tool("get_collection"), { collection_uid: "col/1", limit: 2 }, direct)) as {
      total: number;
      has_more: boolean;
      next_offset: number;
      items: Array<{ entry_uid: string }>;
      collection: { slug: string; entries?: unknown };
    };
    expect(api.requests[0]?.path).toBe("/api/archives/main/collections/col%2F1");
    expect(first.total).toBe(5);
    expect(first.items.map((i) => i.entry_uid)).toEqual(["ent_1", "ent_2"]);
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(2);
    expect(first.collection.slug).toBe("reading");
    expect(first.collection.entries).toBeUndefined();

    const last = jsonOf(await callTool(tool("get_collection"), { collection_uid: "col_1", limit: 2, offset: 4 }, direct)) as {
      items: unknown[];
      has_more: boolean;
      next_offset: number | null;
    };
    expect(last.items).toHaveLength(1);
    expect(last.has_more).toBe(false);
    expect(last.next_offset).toBeNull();
  });

  test("create_collection sends defaults (bits 2, requires_auth true)", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/main/collections", { status: 201, json: COLL });
    const result = await callTool(tool("create_collection"), { name: "Reading", slug: "reading" }, direct);
    expect(result.isError).toBeFalsy();
    expect(api.requests[0]?.json).toEqual({
      name: "Reading",
      slug: "reading",
      default_visibility_bits: 2,
      requires_auth: true,
    });
  });

  test("create_collection rejects slugs starting with _ and sends explicit values", async () => {
    const { api, direct } = setup();
    await expect(callTool(tool("create_collection"), { name: "X", slug: "_hidden" }, direct)).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
    api.on("POST", "/api/archives/main/collections", { status: 201, json: COLL });
    await callTool(
      tool("create_collection"),
      { name: "Public", slug: "public", default_visibility_bits: 3, requires_auth: false },
      direct,
    );
    expect(api.requests[0]?.json).toMatchObject({ default_visibility_bits: 3, requires_auth: false });
  });

  test("update_collection PATCHes only provided fields; needs at least one", async () => {
    const { api, direct } = setup();
    api.on("PATCH", "/api/archives/main/collections/:c", { status: 204 });
    const result = await callTool(
      tool("update_collection"),
      { collection_uid: "col_1", requires_auth: false, default_visibility_bits: 3 },
      direct,
    );
    expect(result.isError).toBeFalsy();
    expect(api.requests[0]?.method).toBe("PATCH");
    expect(api.requests[0]?.json).toEqual({ default_visibility_bits: 3, requires_auth: false });
    const none = await callTool(tool("update_collection"), { collection_uid: "col_1" }, direct);
    expect(none.isError).toBe(true);
    expect(api.requests).toHaveLength(1);
  });

  test("add_to_collection POSTs entry_uid and visibility_bits", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/main/collections/:c/entries", { status: 204 });
    const result = await callTool(
      tool("add_to_collection"),
      { collection_uid: "c 1", entry_uid: "e1", visibility_bits: 6 },
      direct,
    );
    expect(result.isError).toBeFalsy();
    expect(api.requests[0]?.path).toBe("/api/archives/main/collections/c%201/entries");
    expect(api.requests[0]?.json).toEqual({ entry_uid: "e1", visibility_bits: 6 });
  });

  test("remove_from_collection and set_entry_visibility use the entry path", async () => {
    const { api, direct } = setup();
    api.on("DELETE", "/api/archives/main/collections/:c/entries/:e", { status: 204 });
    api.on("PATCH", "/api/archives/main/collections/:c/entries/:e", { status: 204 });
    await callTool(tool("remove_from_collection"), { collection_uid: "c1", entry_uid: "e/1" }, direct);
    await callTool(tool("set_entry_visibility"), { collection_uid: "c1", entry_uid: "e/1", visibility_bits: 1 }, direct);
    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /api/archives/main/collections/c1/entries/e%2F1",
      "PATCH /api/archives/main/collections/c1/entries/e%2F1",
    ]);
    expect(api.requests[1]?.json).toEqual({ visibility_bits: 1 });
  });

  test("visibility bits are validated as u32", async () => {
    const { direct } = setup();
    for (const bad of [-1, 1.5, 2 ** 32]) {
      await expect(
        callTool(tool("set_entry_visibility"), { collection_uid: "c", entry_uid: "e", visibility_bits: bad }, direct),
      ).rejects.toThrow();
    }
  });

  test("delete_collection requires confirm: true", async () => {
    const { api, direct } = setup();
    api.on("DELETE", "/api/archives/main/collections/:c", { status: 204 });
    await expect(callTool(tool("delete_collection"), { collection_uid: "c1" }, direct)).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
    const ok = await callTool(tool("delete_collection"), { collection_uid: "c/1", confirm: true }, direct);
    expect(ok.isError).toBeFalsy();
    expect(api.requests[0]?.path).toBe("/api/archives/main/collections/c%2F1");
  });

  test("errors are mapped: 400 default collection, 404, 403", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/main/collections/:c/entries", {
      status: 400,
      json: { error: "cannot manually add entries to the default collection" },
    });
    const bad = await callTool(tool("add_to_collection"), { collection_uid: "d", entry_uid: "e", visibility_bits: 2 }, direct);
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("Invalid request (400)");
    expect(textOf(bad)).toContain("default collection");

    api.on("DELETE", "/api/archives/main/collections/:c", { status: 403, json: { error: `no ${CANARY_TOKEN}` } });
    const denied = await callTool(tool("delete_collection"), { collection_uid: "c", confirm: true }, direct);
    expect(textOf(denied)).toContain("Forbidden (403)");
    expect(textOf(denied)).not.toContain(CANARY_TOKEN);
  });
});
