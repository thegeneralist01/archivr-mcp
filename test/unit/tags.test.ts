import { describe, expect, test } from "bun:test";
import { tagsTools } from "../../src/tools/tags";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { CANARY_PASSWORD, CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

const tools = Object.fromEntries(tagsTools().map((t) => [t.name, t]));
const tool = (name: string) => {
  const t = tools[name];
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
};
const setup = (api = new MockApi()) => ({ api, direct: directContext({ api, config: { archive: "main" } }) });
const TAG = { tag_uid: "tag_1", name: "Async", slug: "async", full_path: "/rust/async" };

describe("tag tools", () => {
  test("exports the six tools in organize/user with correct annotations", () => {
    expect(Object.keys(tools)).toEqual(["list_tags", "create_tag", "update_tag", "tag_entry", "untag_entry", "delete_tag"]);
    for (const t of Object.values(tools)) {
      expect(t.toolset).toBe("organize");
      expect(t.minRole).toBe("user");
    }
    expect(tool("list_tags").annotations.readOnlyHint).toBe(true);
    expect(tool("delete_tag").annotations.destructiveHint).toBe(true);
    expect(tool("untag_entry").annotations.destructiveHint).toBe(false);
  });

  test("list_tags returns the tree with a total", async () => {
    const { api, direct } = setup();
    const node = (tag: object, children: unknown[] = []) => ({ tag, entry_count: 1, subtree_count: 2, children });
    api.on("GET", "/api/archives/main/tags", {
      json: [node({ ...TAG, tag_uid: "a", full_path: "/rust" }, [node(TAG)])],
    });
    const result = await callTool(tool("list_tags"), {}, direct);
    const body = jsonOf(result) as { total_tags: number; tags: Array<{ children: unknown[] }> };
    expect(body.total_tags).toBe(2);
    expect(body.tags[0]?.children).toHaveLength(1);
  });

  test("create_tag POSTs the path and encodes the archive id", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/:archive/tags", { status: 201, json: TAG });
    const result = await callTool(tool("create_tag"), { archive: "my archive/x", path: "rust/async" }, direct);
    expect(result.isError).toBeFalsy();
    const [req] = api.requests;
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/api/archives/my%20archive%2Fx/tags");
    expect(req?.json).toEqual({ path: "rust/async" });
    expect(jsonOf(result)).toEqual({ created: TAG });
  });

  test("tag_entry POSTs tag_path and encodes the entry uid", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/main/entries/:uid/tags", { status: 201, json: TAG });
    const result = await callTool(tool("tag_entry"), { entry_uid: "../evil", tag_path: "rust/async" }, direct);
    expect(result.isError).toBeFalsy();
    expect(api.requests[0]?.path).toBe("/api/archives/main/entries/..%2Fevil/tags");
    expect(api.requests[0]?.json).toEqual({ tag_path: "rust/async" });
  });

  test("untag_entry DELETEs entry/tag path", async () => {
    const { api, direct } = setup();
    api.on("DELETE", "/api/archives/main/entries/:e/tags/:t", { status: 204 });
    const result = await callTool(tool("untag_entry"), { entry_uid: "e 1", tag_uid: "t/1" }, direct);
    expect(result.isError).toBeFalsy();
    expect(api.requests[0]?.path).toBe("/api/archives/main/entries/e%201/tags/t%2F1");
    expect(jsonOf(result)).toEqual({ entry_uid: "e 1", untagged: "t/1" });
  });

  test("delete_tag requires confirm: true", async () => {
    const { api, direct } = setup();
    api.on("DELETE", "/api/archives/main/tags/:t", { status: 204 });
    await expect(callTool(tool("delete_tag"), { tag_uid: "tag_1" }, direct)).rejects.toThrow();
    await expect(callTool(tool("delete_tag"), { tag_uid: "tag_1", confirm: false }, direct)).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
    const ok = await callTool(tool("delete_tag"), { tag_uid: "tag/1", confirm: true }, direct);
    expect(ok.isError).toBeFalsy();
    expect(api.requests[0]?.method).toBe("DELETE");
    expect(api.requests[0]?.path).toBe("/api/archives/main/tags/tag%2F1");
  });

  describe("update_tag", () => {
    test("rename only: single PATCH", async () => {
      const { api, direct } = setup();
      api.on("PATCH", "/api/archives/main/tags/:t", { json: TAG });
      const result = await callTool(tool("update_tag"), { tag_uid: "tag_1", name: "Async" }, direct);
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.json).toEqual({ name: "Async" });
      expect((jsonOf(result) as { applied: string[] }).applied).toEqual(["rename"]);
    });

    test("move only: parent_uid null and \"\" both move to root", async () => {
      for (const parent_uid of [null, ""]) {
        const { api, direct } = setup();
        api.on("POST", "/api/archives/main/tags/:t/move", { json: TAG });
        const result = await callTool(tool("update_tag"), { tag_uid: "tag_1", parent_uid }, direct);
        expect(api.requests).toHaveLength(1);
        expect(api.requests[0]?.json).toEqual({ parent_uid: null });
        expect((jsonOf(result) as { applied: string[] }).applied).toEqual(["move"]);
      }
    });

    test("both: rename first, then move, returns the final tag", async () => {
      const { api, direct } = setup();
      api.on("PATCH", "/api/archives/main/tags/:t", { json: { ...TAG, full_path: "/old/renamed" } });
      api.on("POST", "/api/archives/main/tags/:t/move", { json: { ...TAG, full_path: "/new/renamed" } });
      const result = await callTool(tool("update_tag"), { tag_uid: "tag_1", name: "Renamed", parent_uid: "tag_9" }, direct);
      expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "PATCH /api/archives/main/tags/tag_1",
        "POST /api/archives/main/tags/tag_1/move",
      ]);
      expect(api.requests[1]?.json).toEqual({ parent_uid: "tag_9" });
      const body = jsonOf(result) as { updated: { full_path: string }; applied: string[] };
      expect(body.updated.full_path).toBe("/new/renamed");
      expect(body.applied).toEqual(["rename", "move"]);
    });

    test("move failing after a rename reports the partial success", async () => {
      const { api, direct } = setup();
      api.on("PATCH", "/api/archives/main/tags/:t", { json: { ...TAG, full_path: "/old/renamed" } });
      api.on("POST", "/api/archives/main/tags/:t/move", { status: 500, json: { error: "cannot move a tag under itself" } });
      const result = await callTool(tool("update_tag"), { tag_uid: "tag_1", name: "Renamed", parent_uid: "tag_1" }, direct);
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("rename was applied");
      expect(text).toContain("/old/renamed");
      expect(text).toContain("cannot move a tag under itself");
    });

    test("failed rename throws through the normal error mapping and skips the move", async () => {
      const { api, direct } = setup();
      api.on("PATCH", "/api/archives/main/tags/:t", { status: 404, json: { error: "tag not found" } });
      const result = await callTool(tool("update_tag"), { tag_uid: "x", name: "N", parent_uid: "p" }, direct);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Not found (404)");
      expect(api.requests).toHaveLength(1);
    });

    test("requires name or parent_uid; rejects slashes in name", async () => {
      const { api, direct } = setup();
      const none = await callTool(tool("update_tag"), { tag_uid: "t" }, direct);
      expect(none.isError).toBe(true);
      expect(textOf(none)).toContain("name");
      const slash = await callTool(tool("update_tag"), { tag_uid: "t", name: "a/b" }, direct);
      expect(slash.isError).toBe(true);
      expect(api.requests).toHaveLength(0);
    });
  });

  test("server errors are mapped (403 for a read-scope token) without leaking the token", async () => {
    const { api, direct } = setup();
    api.on("POST", "/api/archives/main/tags", { status: 403, json: { error: `denied for ${CANARY_TOKEN}` } });
    const result = await callTool(tool("create_tag"), { path: `x/${CANARY_PASSWORD}` }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Forbidden (403)");
    expect(textOf(result)).not.toContain(CANARY_TOKEN);
  });
});
