import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE_ID, E2E_DISABLED, Fixture, obj } from "./harness";
import { assertNoLeaks } from "./leaks";

// Every tool, by the lowest role that sees it (credentials toolset included).
const USER_TOOLS = [
  "add_to_collection", "capture_file", "capture_options", "capture_text", "capture_url", "change_password",
  "create_api_token", "create_collection", "create_tag", "delete_collection", "delete_entry", "delete_tag",
  "download_artifact", "generate_text_title", "generate_thread_title", "get_artifact", "get_capture_job",
  "get_collection", "get_entry", "get_summary", "list_archives", "list_capture_jobs", "list_collections",
  "list_entries", "list_entry_children", "list_my_credentials", "list_runs", "list_tags",
  "list_transcription_engines", "probe_playlist", "probe_url", "rearchive_entry", "remove_from_collection",
  "rename_entry", "reorder_children", "revoke_other_sessions", "revoke_session", "revoke_token",
  "search_entries", "set_entry_visibility", "summarize_entry", "tag_entry", "untag_entry", "update_collection",
  "update_profile", "update_tag", "whoami",
];
const ADMIN_ONLY_TOOLS = [
  "admin_list", "assign_role", "blob_cleanup_run", "blob_cleanup_scan", "create_cookie_rule", "create_role",
  "create_user", "delete_cookie_rule", "delete_user", "remove_role", "rename_role", "reset_user_password",
  "revoke_user_sessions", "revoke_user_token", "server_info", "set_user_status", "update_cookie_rule",
  "update_instance_settings", "update_ytdlp",
];
const OWNER_ONLY_TOOLS = ["delete_role"];
const CREDENTIAL_TOOLS = [
  "change_password", "create_api_token", "create_cookie_rule", "create_user", "reset_user_password", "update_cookie_rule",
];
const ALL_TOOLSETS = "core,capture,organize,account,admin,credentials";

/** A tool that is not registered is refused by the MCP SDK: either a protocol error or an error result. */
async function expectRefused(call: Promise<{ isError: boolean; text: string }>): Promise<void> {
  const outcome = await call.then(
    (r) => (r.isError ? "refused" : "ran"),
    () => "refused",
  );
  expect(outcome).toBe("refused");
}

describe.skipIf(E2E_DISABLED)("e2e: tools, entries, capture, tags, collections", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await Fixture.create();
  });
  afterAll(async () => {
    await fx.teardown();
  });

  // ── 1. whoami and tool lists per role ─────────────────────────────────────

  test("whoami reports the token's identity over real stdio", async () => {
    const owner = await fx.mcp(fx.cast.owner.token);
    const me = obj(await owner.call("whoami"));
    expect(me).toMatchObject({ username: "owner", roles: ["user", "admin", "owner"], default_archive: ARCHIVE_ID, readonly: false });
    expect(me["user_uid"]).toBe(fx.cast.owner.uid);
    // Credential tools are opt-in.
    expect(me["enabled_toolsets"]).toEqual(["core", "capture", "organize", "account", "admin"]);
  });

  test("tool names per role (snapshot guards against tool-count creep)", async () => {
    const byRole = {
      owner: await fx.mcp(fx.cast.owner.token, { toolsets: ALL_TOOLSETS }),
      admin: await fx.mcp(fx.cast.admin.token, { toolsets: ALL_TOOLSETS }),
      user: await fx.mcp(fx.cast.user.token, { toolsets: ALL_TOOLSETS }),
      guest: await fx.mcp(fx.cast.guest.token, { toolsets: ALL_TOOLSETS }),
    };
    expect(byRole.user.toolNames).toEqual([...USER_TOOLS].sort());
    expect(byRole.admin.toolNames).toEqual([...USER_TOOLS, ...ADMIN_ONLY_TOOLS].sort());
    expect(byRole.owner.toolNames).toEqual([...USER_TOOLS, ...ADMIN_ONLY_TOOLS, ...OWNER_ONLY_TOOLS].sort());
    expect(byRole.guest.toolNames).toEqual(["list_archives", "whoami"]);
    expect([byRole.owner, byRole.admin, byRole.user].map((s) => s.toolNames.length)).toEqual([67, 66, 47]);
  });

  test("admin tools are hidden from a user and a call is refused by the MCP server", async () => {
    const user = await fx.mcp(fx.cast.user.token, { toolsets: ALL_TOOLSETS });
    for (const name of ["admin_list", "server_info", "delete_user", "create_user", "blob_cleanup_run"]) {
      expect(user.toolNames).not.toContain(name);
    }
    await expectRefused(user.call("admin_list", { what: "users" }));
  });

  test("default toolsets leave out the credentials tools; read-only mode registers only read-only tools", async () => {
    const dflt = await fx.mcp(fx.cast.owner.token);
    for (const name of CREDENTIAL_TOOLS) expect(dflt.toolNames).not.toContain(name);
    expect(dflt.toolNames.length).toBe(61);

    const ro = await fx.mcp(fx.cast.owner.token, { toolsets: ALL_TOOLSETS, readonly: true });
    const listed = await ro.client.listTools();
    expect(listed.tools.length).toBe(23);
    for (const tool of listed.tools) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    expect(ro.toolNames).not.toContain("capture_text");
    await expectRefused(ro.call("capture_text", { title: "x", body: "y" }));
  });

  // ── 2. capture_text round trip ────────────────────────────────────────────

  test("capture_text (wait) -> entry_uids -> get_entry / search_entries / get_artifact / rename / delete", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const captured = obj(await user.call("capture_text", { title: "Round trip note", body: "# Hello\n\nunique-needle-body", wait: true }));
    expect(captured["status"]).toBe("completed");
    expect(captured["created_by"]).toBe(fx.cast.user.uid);
    const entryUid: string = captured["entry_uids"][0];
    expect(entryUid).toMatch(/^entry_/);

    const entry = obj(await user.call("get_entry", { entry_uid: entryUid }));
    expect(entry).toMatchObject({ entry_uid: entryUid, title: "Round trip note", source_kind: "text", artifact_count: 1 });

    const found = obj(await user.call("search_entries", { q: "Round trip" }));
    expect(found["items"].map((i: { entry_uid: string }) => i.entry_uid)).toContain(entryUid);
    const listed = obj(await user.call("list_entries", {}));
    expect(listed["items"].map((i: { entry_uid: string }) => i.entry_uid)).toContain(entryUid);

    const artifact = await user.call("get_artifact", { entry_uid: entryUid, artifact_index: 0 });
    expect(artifact.isError).toBe(false);
    expect(artifact.text).toContain("untrusted archived data");
    expect(artifact.text).toContain("unique-needle-body");

    const renamed = obj(await user.call("rename_entry", { entry_uid: entryUid, title: "Renamed note" }));
    expect(renamed["title"]).toBe("Renamed note");
    expect(obj(await user.call("get_entry", { entry_uid: entryUid }))["title"]).toBe("Renamed note");

    // confirm is mandatory (rejected by the tool's input schema before any request is made).
    const refused = await user.client.callTool({ name: "delete_entry", arguments: { entry_uid: entryUid } }).catch((e: unknown) => e);
    const refusedText = JSON.stringify(refused);
    expect(refusedText).toMatch(/confirm/);
    expect(obj(await user.call("get_entry", { entry_uid: entryUid }))["entry_uid"]).toBe(entryUid);

    const deleted = await user.call("delete_entry", { entry_uid: entryUid, confirm: true });
    expect(deleted.isError).toBe(false);
    const gone = await user.call("get_entry", { entry_uid: entryUid });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("404");
  });

  // ── 3. capture_file and the file:// guards ────────────────────────────────

  test("capture_file inside the upload roots archives the file; the path leaves no trace on the server", async () => {
    const root = join(fx.workDir, "uploads");
    mkdirSync(root, { recursive: true });
    const file = join(root, "note.txt");
    writeFileSync(file, "local file body e2e");
    const user = await fx.mcp(fx.cast.user.token, { uploadRoots: [root] });
    const out = obj(await user.call("capture_file", { path: file, wait: true }));
    expect(out["status"]).toBe("completed");
    expect(out["uploaded"]).toMatchObject({ size: 19 });
    // Regression: the wire filename is the basename, not the local absolute path.
    expect(out["uploaded"]["filename"]).not.toContain(fx.workDir);
    const entryUid: string = out["entry_uids"][0];
    const entry = obj(await user.call("get_entry", { entry_uid: entryUid }));
    expect(entry["source_kind"]).toBe("local");
    const artifact = await user.call("get_artifact", { entry_uid: entryUid, artifact_index: 0 });
    expect(artifact.text).toContain("local file body e2e");
  });

  test("capture_file rejects denylisted, outside-root and symlink-escape paths; no roots disables uploads", async () => {
    const root = join(fx.workDir, "uploads2");
    mkdirSync(join(root, ".ssh"), { recursive: true });
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, ".ssh", "id_rsa"), "key");
    const outside = join(fx.workDir, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(root, "link.txt"));
    const user = await fx.mcp(fx.cast.user.token, { uploadRoots: [root] });

    const before = obj(await user.call("list_entries", {}))["total"];
    for (const path of [join(root, ".env"), join(root, ".ssh", "id_rsa"), outside, join(root, "link.txt"), "/etc/hosts", "relative.txt"]) {
      const res = await user.call("capture_file", { path });
      expect(res.isError, path).toBe(true);
    }
    expect(obj(await user.call("list_entries", {}))["total"]).toBe(before);

    const noRoots = await fx.mcp(fx.cast.user.token);
    expect((await noRoots.call("capture_file", { path: outside })).isError).toBe(true);
  });

  test("file:// is rejected by capture_url client-side AND by the server (raw REST 400)", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const res = await user.call("capture_url", { locator: "file:///etc/hosts" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/file:/);

    for (const token of [fx.cast.user.token, fx.cast.owner.token]) {
      for (const locator of ["file:///etc/hosts", "file://localhost/etc/hosts", "file:///etc/../etc/hosts"]) {
        const raw = await fx.server.rest("POST", `/api/archives/${ARCHIVE_ID}/captures`, { token, body: { locator } });
        expect(raw.status, locator).toBe(400);
        expect(JSON.stringify(raw.json)).toContain("staged upload");
      }
    }
    // Nothing was created.
    const jobs = obj(await user.call("list_capture_jobs", {}));
    expect(JSON.stringify(jobs)).not.toContain("/etc/hosts");
  });

  // Regression: core classifies any existing path as a local file, so the server must refuse
  // bare paths as well as non-staged file:// URIs, otherwise a USER could archive and read back
  // any file the server process can read. (Mixed-case `FILE://` and `file:/path` are accepted
  // with 202 but their jobs fail later with "not yet implemented", so they read nothing.)
  test("a bare absolute-path locator is rejected like a non-staged file:// one", async () => {
    const secret = join(fx.workDir, "server-side-secret.txt");
    writeFileSync(secret, "TOP-SECRET-CONTENT");
    const raw = await fx.server.rest("POST", `/api/archives/${ARCHIVE_ID}/captures`, {
      token: fx.cast.user.token,
      body: { locator: secret },
    });
    expect(raw.status).toBe(400);
    expect(raw.text).not.toContain("TOP-SECRET-CONTENT");
  });

  // ── 4. tags and collections ───────────────────────────────────────────────

  test("tags lifecycle: create, tag_entry, list, untag, delete (confirm)", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const entryUid: string = obj(await user.call("capture_text", { title: "Tag target", body: "tag me", wait: true }))["entry_uids"][0];

    const created = obj(await user.call("create_tag", { path: "e2e/projects" }));
    const tagUid: string = created["created"]["tag_uid"];
    expect(created["created"]["full_path"]).toBe("/e2e/projects");

    const tagged = obj(await user.call("tag_entry", { entry_uid: entryUid, tag_path: "e2e/projects" }));
    expect(tagged["tagged"]["tag_uid"]).toBe(tagUid);

    const tree = JSON.stringify(obj(await user.call("list_tags", {})));
    expect(tree).toContain(tagUid);
    // The server filters on the full path ("/e2e/projects"); the MCP adds the leading slash.
    const bySearch = obj(await user.call("search_entries", { q: "Tag target", tag: "e2e/projects" }));
    expect(bySearch["items"].map((i: { entry_uid: string }) => i.entry_uid)).toContain(entryUid);

    expect((await user.call("untag_entry", { entry_uid: entryUid, tag_uid: tagUid })).isError).toBe(false);
    expect((await user.call("delete_tag", { tag_uid: tagUid, confirm: true })).isError).toBe(false);
    expect(JSON.stringify(obj(await user.call("list_tags", {})))).not.toContain(tagUid);
  });

  test("collections lifecycle: create, add, visibility, get, remove, delete (confirm)", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const other = await fx.mcp(fx.cast.user2.token);
    const entryUid: string = obj(await user.call("capture_text", { title: "Coll entry", body: "x", wait: true }))["entry_uids"][0];

    const coll = obj(await user.call("create_collection", { name: "E2E Coll", slug: "e2e-coll" }))["created"];
    const collUid: string = coll["collection_uid"];
    expect(coll["slug"]).toBe("e2e-coll");

    const added = await user.call("add_to_collection", { collection_uid: collUid, entry_uid: entryUid, visibility_bits: 2 });
    expect(added.isError).toBe(false);
    const got = obj(await user.call("get_collection", { collection_uid: collUid }));
    expect(JSON.stringify(got)).toContain(entryUid);

    // Hide the entry from plain users in the default collection and in this one: user2 stops seeing it.
    expect((await user.call("set_entry_visibility", { collection_uid: "coll_default", entry_uid: entryUid, visibility_bits: 4 })).isError).toBe(false);
    expect((await user.call("set_entry_visibility", { collection_uid: collUid, entry_uid: entryUid, visibility_bits: 4 })).isError).toBe(false);
    const hidden = obj(await other.call("list_entries", {}));
    expect(hidden["items"].map((i: { entry_uid: string }) => i.entry_uid)).not.toContain(entryUid);
    expect((await user.call("set_entry_visibility", { collection_uid: "coll_default", entry_uid: entryUid, visibility_bits: 2 })).isError).toBe(false);
    const shown = obj(await other.call("list_entries", {}));
    expect(shown["items"].map((i: { entry_uid: string }) => i.entry_uid)).toContain(entryUid);

    expect((await user.call("remove_from_collection", { collection_uid: collUid, entry_uid: entryUid })).isError).toBe(false);
    expect((await user.call("delete_collection", { collection_uid: collUid, confirm: true })).isError).toBe(false);
    expect(JSON.stringify(obj(await user.call("list_collections", {})))).not.toContain(collUid);
  });

  // ── 8. summarize without a provider ───────────────────────────────────────

  test("summarize_entry without provider env returns a tool error naming the missing variable", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const entryUid: string = obj(await user.call("capture_text", { title: "Summarize me", body: "text", wait: true }))["entry_uids"][0];
    const res = await user.call("summarize_entry", { entry_uid: entryUid, provider: "anthropic_http" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("400");
    expect(res.text).toContain("ARCHIVR_ANTHROPIC_API_KEY");
    const other = await user.call("summarize_entry", { entry_uid: entryUid, provider: "openai_compatible" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("ARCHIVR_OPENAI_API_KEY");
  });

  test("isolation: no session_uid, hash or secret in any response or MCP stdout/stderr", () => {
    assertNoLeaks(fx);
  });
});
