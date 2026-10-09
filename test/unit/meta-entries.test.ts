import { afterEach, describe, expect, test } from "bun:test";
import { listArchives, captureOptions } from "../../src/tools/meta";
import {
  deleteEntry,
  getEntry,
  listEntries,
  listEntryChildren,
  renameEntry,
  reorderChildren,
  searchEntries,
} from "../../src/tools/entries";
import { callTool, connectInMemory, directContext, jsonOf, textOf, toolNames, type Connected } from "../helpers/inMemory";
import { CANARY_TOKEN, ME, MockApi } from "../helpers/mockFetch";

const entry = (n: number, extra: Record<string, unknown> = {}) => ({
  entry_uid: `e${n}`,
  archived_at: "2026-01-01T00:00:00Z",
  source_kind: "web",
  entity_kind: "page",
  title: n % 2 === 0 ? null : `Title ${n}`,
  visibility: "public",
  original_url: `https://example.com/${n}`,
  artifact_count: 2,
  total_artifact_bytes: 10,
  parent_entry_uid: null,
  has_favicon: false,
  cached_bytes: 0,
  child_count: 0,
  cacheable_bytes: 10,
  ...extra,
});

const api1 = () => new MockApi().on("GET", "/api/archives", { json: [{ id: "main", label: "Main", archive_path: "/secret/path" }] });

describe("list_archives / capture_options", () => {
  test("list_archives strips filesystem paths", async () => {
    const d = directContext({ api: api1() });
    const out = jsonOf(await callTool(listArchives, {}, d)) as { archives: unknown[] };
    expect(out.archives).toEqual([{ id: "main", label: "Main" }]);
    expect(textOf(await callTool(listArchives, {}, d))).not.toContain("/secret/path");
  });

  test("capture_options passes the server body through", async () => {
    const body = {
      ublock_enabled: true, cookie_ext_enabled: false, modal_closer_enabled: false, ublock_ext_available: false,
      cookie_ext_available: false, reader_mode: false, via_freedium: true, download_subtitles: true, title_providers: [],
    };
    const api = new MockApi().on("GET", "/api/captures/options", { json: body });
    expect(jsonOf(await callTool(captureOptions, {}, directContext({ api })))).toMatchObject(body);
  });

  test("capture_options maps 403", async () => {
    const api = new MockApi().on("GET", "/api/captures/options", { status: 403, json: { error: "forbidden" } });
    const r = await callTool(captureOptions, {}, directContext({ api }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("403");
  });
});

describe("list_entries / search_entries", () => {
  test("slices client-side and returns compact rows", async () => {
    const api = api1().on("GET", "/api/archives/main/entries", { json: Array.from({ length: 30 }, (_, i) => entry(i)) });
    const d = directContext({ api });
    const first = jsonOf(await callTool(listEntries, { limit: 10 }, d)) as Record<string, any>;
    expect(first).toMatchObject({ total: 30, returned: 10, has_more: true, next_offset: 10 });
    expect(first.items[1]).toEqual({
      entry_uid: "e1", title: "Title 1", source_kind: "web", entity_kind: "page", url: "https://example.com/1",
      archived_at: "2026-01-01T00:00:00Z", child_count: 0, artifact_count: 2,
    });
    const last = jsonOf(await callTool(listEntries, { limit: 10, offset: 25 }, d)) as Record<string, any>;
    expect(last).toMatchObject({ returned: 5, has_more: false, next_offset: null });
    expect(last.items[0].entry_uid).toBe("e25");
  });

  test("passes the collection filter", async () => {
    const api = api1().on("GET", "/api/archives/main/entries", { json: [] });
    await callTool(listEntries, { collection: "c1" }, directContext({ api }));
    expect(api.calls("GET", "/api/archives/main/entries")[0]?.query).toEqual({ collection: "c1" });
  });

  test("search sends q, tag and collection", async () => {
    const api = api1().on("GET", "/api/archives/main/entries/search", { json: [entry(1)] });
    const out = jsonOf(await callTool(searchEntries, { q: "rust source:youtube", tag: "dev/rust", collection: "c9" }, directContext({ api }))) as any;
    expect(out.total).toBe(1);
    expect(api.calls("GET", "/api/archives/main/entries/search")[0]?.query).toEqual({
      q: "rust source:youtube", tag: "/dev/rust", collection: "c9",
    });
    // An already-slashed path is not doubled.
    await callTool(searchEntries, { q: "x", tag: "/dev/rust" }, directContext({ api }));
    expect(api.calls("GET", "/api/archives/main/entries/search")[1]?.query).toMatchObject({ tag: "/dev/rust" });
    expect(searchEntries.description).toContain("source:");
    expect(searchEntries.description).toContain("before:");
  });

  test("search maps a 400 unknown prefix", async () => {
    const api = api1().on("GET", "/api/archives/main/entries/search", { status: 400, json: { error: "unknown search prefix: foo" } });
    const r = await callTool(searchEntries, { q: "foo:bar" }, directContext({ api }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unknown search prefix: foo");
  });
});

describe("get_entry", () => {
  const detail = {
    summary: entry(1, { child_count: 2 }),
    structured_root_relpath: "x",
    source_metadata_json: '{"author":"a"}',
    display_metadata_json: null,
    artifacts: [{ artifact_role: "main", storage_area: "raw", relpath: "a/page.html", byte_size: 5 }],
    latest_summary: {
      summary_uid: "s", entry_uid: "e1", provider_kind: "p", resolved_model: "m", provider_model: null, prompt_version: "1",
      input_sha256: "x", status: "completed", summary_text: "A summary", error_text: null, created_at: "t", updated_at: "t", completed_at: "t",
    },
    summary_attempt: null,
  };
  const api = () =>
    api1()
      .on("GET", "/api/archives/main/entries/e1", { json: detail })
      .on("GET", "/api/archives/main/entries/e1/tags", { json: [{ tag_uid: "t1", name: "rust", slug: "rust", full_path: "dev/rust" }] })
      .on("GET", "/api/archives/main/entries/e1/collections", { json: [{ collection_uid: "c1", name: "Main", visibility_bits: 3 }] });

  test("compact by default: one request only", async () => {
    const a = api();
    const out = jsonOf(await callTool(getEntry, { entry_uid: "e1" }, directContext({ api: a }))) as Record<string, any>;
    expect(out).toMatchObject({ entry_uid: "e1", title: "Title 1", child_count: 2, total_artifact_bytes: 10 });
    expect(out.tags).toBeUndefined();
    expect(out.artifacts).toBeUndefined();
    expect(out.metadata).toBeUndefined();
    expect(a.requests.filter((r) => r.path.startsWith("/api/archives/main/entries"))).toHaveLength(1);
  });

  test("include fans out to tags and collections and adds sections", async () => {
    const a = api();
    const out = jsonOf(
      await callTool(getEntry, { entry_uid: "e1", include: ["tags", "collections", "summary", "metadata", "artifacts"] }, directContext({ api: a })),
    ) as Record<string, any>;
    expect(out.tags).toEqual([{ tag_uid: "t1", name: "rust", full_path: "dev/rust" }]);
    expect(out.collections).toEqual([{ collection_uid: "c1", name: "Main" }]);
    expect(out.summary).toMatchObject({ available: true, text: "A summary" });
    expect(out.metadata).toEqual({ source: { author: "a" }, display: null });
    expect(out.artifacts[0]).toMatchObject({ index: 0, role: "main", relpath: "a/page.html" });
    expect(a.calls("GET", "/api/archives/main/entries/e1/tags")).toHaveLength(1);
  });

  test("wraps the uid in a path segment", async () => {
    const a = api1().on("GET", "/api/archives/main/entries/:uid", { status: 404, json: { error: "entry not found" } });
    const r = await callTool(getEntry, { entry_uid: "../admin" }, directContext({ api: a }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("404");
    expect(a.requests.at(-1)?.path).toBe("/api/archives/main/entries/..%2Fadmin");
  });
});

describe("list_entry_children / rename / reorder / delete", () => {
  test("children are paged", async () => {
    const a = api1().on("GET", "/api/archives/main/entries/p/children", { json: [entry(1), entry(2), entry(3)] });
    const out = jsonOf(await callTool(listEntryChildren, { entry_uid: "p", limit: 2 }, directContext({ api: a }))) as any;
    expect(out).toMatchObject({ total: 3, returned: 2, has_more: true, entry_uid: "p" });
  });

  test("rename trims and sends null for blank", async () => {
    const a = api1().on("PATCH", "/api/archives/main/entries/e1", { status: 204 });
    const d = directContext({ api: a });
    await callTool(renameEntry, { entry_uid: "e1", title: "  New  " }, d);
    await callTool(renameEntry, { entry_uid: "e1", title: "   " }, d);
    const bodies = a.calls("PATCH", "/api/archives/main/entries/e1").map((r) => r.json);
    expect(bodies).toEqual([{ title: "New" }, { title: null }]);
  });

  test("reorder PUTs child_uids; 403 and 400 are mapped", async () => {
    const a = api1().on("PUT", "/api/archives/main/entries/p/children/order", { status: 204 });
    const d = directContext({ api: a });
    const ok = await callTool(reorderChildren, { entry_uid: "p", child_uids: ["b", "a"] }, d);
    expect(ok.isError).toBeFalsy();
    expect(a.calls("PUT", "/api/archives/main/entries/p/children/order")[0]?.json).toEqual({ child_uids: ["b", "a"] });
    a.on("PUT", "/api/archives/main/entries/p/children/order", { status: 403, json: { error: "your role is not allowed to reorder child entries" } });
    const denied = await callTool(reorderChildren, { entry_uid: "p", child_uids: ["a"] }, d);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("403");
  });

  test("delete issues DELETE; 404 mapped", async () => {
    const a = api1().on("DELETE", "/api/archives/main/entries/e1", { status: 204 });
    const d = directContext({ api: a });
    expect(jsonOf(await callTool(deleteEntry, { entry_uid: "e1", confirm: true }, d))).toEqual({ deleted: "e1" });
    a.on("DELETE", "/api/archives/main/entries/e1", { status: 404, json: { error: "entry not found" } });
    const r = await callTool(deleteEntry, { entry_uid: "e1", confirm: true }, d);
    expect(r.isError).toBe(true);
  });
});

describe("over MCP", () => {
  let c: Connected | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
  });
  const names = ["list_archives", "capture_options", "list_entries", "search_entries", "get_entry", "list_entry_children", "get_artifact", "download_artifact", "rename_entry", "reorder_children", "delete_entry"];

  test("delete_entry requires confirm: true", async () => {
    const api = api1().on("DELETE", "/api/archives/main/entries/e1", { status: 204 });
    c = await connectInMemory({ api });
    expect((await c.client.callTool({ name: "delete_entry", arguments: { entry_uid: "e1" } })).isError).toBe(true);
    expect((await c.client.callTool({ name: "delete_entry", arguments: { entry_uid: "e1", confirm: false } })).isError).toBe(true);
    expect(api.calls("DELETE", "/api/archives/main/entries/e1")).toHaveLength(0);
    expect((await c.client.callTool({ name: "delete_entry", arguments: { entry_uid: "e1", confirm: true } })).isError).toBeFalsy();
    const { tools } = await c.client.listTools();
    expect(tools.find((t) => t.name === "delete_entry")?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === "get_entry")?.annotations).toMatchObject({ readOnlyHint: true });
  });

  test("tools are present for a user", async () => {
    c = await connectInMemory({ me: ME.user });
    expect(toolNames((await c.client.listTools()).tools)).toEqual(expect.arrayContaining(names));
  });

  test("guests only see list_archives of these tools", async () => {
    c = await connectInMemory({ me: ME.guest });
    const listed = toolNames((await c.client.listTools()).tools);
    expect(listed).toContain("list_archives");
    for (const n of names.filter((x) => x !== "list_archives")) expect(listed).not.toContain(n);
  });

  test("read-only mode hides the writers", async () => {
    c = await connectInMemory({ config: { readonly: true } });
    const listed = toolNames((await c.client.listTools()).tools);
    expect(listed).toContain("get_artifact");
    for (const n of ["rename_entry", "reorder_children", "delete_entry", "download_artifact"]) expect(listed).not.toContain(n);
  });

  test("the token never appears in an error", async () => {
    const api = api1().on("GET", "/api/archives/main/entries", { status: 500, text: `boom ${CANARY_TOKEN}` });
    const r = await callTool(listEntries, {}, directContext({ api }));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CANARY_TOKEN);
  });
});
