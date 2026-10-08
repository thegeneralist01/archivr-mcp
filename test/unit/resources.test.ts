import { afterEach, describe, expect, test } from "bun:test";
import { connectInMemory, type Connected } from "../helpers/inMemory";
import { CANARY_TOKEN, ME, MockApi } from "../helpers/mockFetch";

let connected: Connected | undefined;
afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const ARCHIVES = [
  { id: "main", label: "Main", archive_path: "/srv/secret/path" },
  { id: "second arch", label: "Second" },
];

function mockApi(): MockApi {
  return new MockApi()
    .on("GET", "/api/archives", { json: ARCHIVES })
    .on("GET", "/api/archives/:id/tags", { json: [{ tag: { tag_uid: "t", name: "A", slug: "a", full_path: "/a" }, entry_count: 1, subtree_count: 1, children: [] }] })
    .on("GET", "/api/archives/:id/collections", { json: [] })
    .on("GET", "/api/archives/:id/entries/:uid", (r) => ({
      json: { summary: { entry_uid: r.params.uid, title: "Hello" }, source_metadata_json: `{"leak":"${CANARY_TOKEN}"}` },
    }))
    .on("GET", "/api/admin/instance-settings", { json: { public_index_enabled: false, reorder_children_role_bits: 4 } });
}

const textOfRead = (r: { contents: object[] }): string => String((r.contents[0] as { text?: unknown } | undefined)?.text);

describe("resources", () => {
  test("static resources and templates are listed for an owner (incl. admin settings)", async () => {
    connected = await connectInMemory({ api: mockApi(), me: ME.owner });
    const { resources } = await connected.client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    expect(uris).toEqual(
      [
        "archivr://archives",
        "archivr://archives/main/collections",
        "archivr://archives/main/tags",
        "archivr://archives/second%20arch/collections",
        "archivr://archives/second%20arch/tags",
        "archivr://me",
        "archivr://settings/instance",
      ].sort(),
    );
    const { resourceTemplates } = await connected.client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("archivr://archives/{id}/entries/{uid}");
  });

  test("admin-only resource is hidden for a USER and unreadable", async () => {
    connected = await connectInMemory({ api: mockApi(), me: ME.user });
    const { resources } = await connected.client.listResources();
    expect(resources.map((r) => r.uri)).not.toContain("archivr://settings/instance");
    await expect(connected.client.readResource({ uri: "archivr://settings/instance" })).rejects.toThrow();
  });

  test("admin settings are hidden when the identity is unknown, shown for ADMIN", async () => {
    connected = await connectInMemory({ api: mockApi(), me: new Error("down") });
    expect((await connected.client.listResources()).resources.map((r) => r.uri)).not.toContain("archivr://settings/instance");
    await connected.close();
    connected = await connectInMemory({ api: mockApi(), me: ME.admin });
    const read = await connected.client.readResource({ uri: "archivr://settings/instance" });
    expect(JSON.parse(textOfRead(read))).toMatchObject({ reorder_children_role_bits: 4 });
  });

  test("archivr://me", async () => {
    const api = mockApi();
    connected = await connectInMemory({ api, me: ME.owner });
    const read = await connected.client.readResource({ uri: "archivr://me" });
    expect(read.contents[0]?.mimeType).toBe("application/json");
    expect(JSON.parse(textOfRead(read))).toMatchObject({ username: "root", role_bits: 15, roles: ["user", "admin", "owner"] });
  });

  test("archivr://archives omits archive_path", async () => {
    connected = await connectInMemory({ api: mockApi(), me: ME.owner });
    const text = textOfRead(await connected.client.readResource({ uri: "archivr://archives" }));
    expect(JSON.parse(text)).toEqual([
      { id: "main", label: "Main" },
      { id: "second arch", label: "Second" },
    ]);
    expect(text).not.toContain("/srv/secret");
  });

  test("tags and collections templates decode the archive id", async () => {
    const api = mockApi();
    connected = await connectInMemory({ api, me: ME.owner });
    const tags = await connected.client.readResource({ uri: "archivr://archives/second%20arch/tags" });
    expect(JSON.parse(textOfRead(tags))).toHaveLength(1);
    await connected.client.readResource({ uri: "archivr://archives/main/collections" });
    const paths = api.requests.map((r) => r.path);
    expect(paths).toContain("/api/archives/second%20arch/tags");
    expect(paths).toContain("/api/archives/main/collections");
  });

  test("entry template reads entry JSON, prefixes the untrusted notice, and redacts the token", async () => {
    connected = await connectInMemory({ api: mockApi(), me: ME.owner });
    const read = await connected.client.readResource({ uri: "archivr://archives/main/entries/ent%2F1" });
    const text = textOfRead(read);
    expect(text).toContain("untrusted archived data");
    expect(text).toContain("ent/1");
    expect(text).not.toContain(CANARY_TOKEN);
    expect(text).toContain("[REDACTED]");
  });

  test("reads are truncated to the output budget", async () => {
    const api = mockApi().on("GET", "/api/archives/:id/entries/:uid", { json: { blob: "x".repeat(5000) } });
    connected = await connectInMemory({ api, me: ME.owner, config: { maxOutputChars: 500 } });
    const text = textOfRead(await connected.client.readResource({ uri: "archivr://archives/main/entries/e1" }));
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain("output truncated");
  });

  test("errors surface as mapped messages without the token", async () => {
    const api = mockApi().on("GET", "/api/archives/:id/entries/:uid", { status: 404, json: { error: `no ${CANARY_TOKEN}` } });
    connected = await connectInMemory({ api, me: ME.owner });
    let message = "";
    try {
      await connected.client.readResource({ uri: "archivr://archives/main/entries/nope" });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("Not found (404)");
    expect(message).not.toContain(CANARY_TOKEN);
  });

  test("tools and resources register together over MCP", async () => {
    connected = await connectInMemory({ api: mockApi(), me: ME.owner });
    const { tools } = await connected.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["list_tags", "delete_tag", "get_collection", "delete_collection"]) expect(names).toContain(n);
  });
});
