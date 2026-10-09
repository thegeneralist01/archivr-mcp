import { describe, expect, test } from "bun:test";
import { listMyCredentials, revokeOtherSessions, revokeSession, revokeToken, updateProfile } from "../../src/tools/account";
import { createRole, deleteRole, renameRole } from "../../src/tools/admin-roles";
import { deleteCookieRule, serverInfo, updateInstanceSettings, updateYtdlp } from "../../src/tools/admin-settings";
import { adminList, assignRole, deleteUser, removeRole, revokeUserSessions, revokeUserToken, setUserStatus } from "../../src/tools/admin-users";
import { blobCleanupRun, blobCleanupScan } from "../../src/tools/maintenance";
import type { ToolDef } from "../../src/tools/registry";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

async function run(tool: ToolDef, args: Record<string, unknown>, api: MockApi) {
  return callTool(tool, args, directContext({ api }));
}

const token = { token_uid: "tok_1", name: "ci", created_at: "t", last_used_at: null, expires_at: "t2", scope: "read", token_hash: "HASHSECRET" };
const session = { session_handle: "0123456789abcdef", created_at: "t", last_seen_at: "t", expires_at: "t", user_agent: null, current: false, session_uid: "COOKIESECRET" };

describe("account tools", () => {
  test("list_my_credentials tokens / sessions whitelist fields", async () => {
    const api = new MockApi().on("GET", "/api/auth/tokens", { json: [token] }).on("GET", "/api/auth/sessions", { json: [session] });
    const t = textOf(await run(listMyCredentials, { what: "tokens" }, api));
    expect(t).not.toContain("HASHSECRET");
    expect(jsonOf(await run(listMyCredentials, { what: "tokens" }, api))).toMatchObject({ what: "tokens", total: 1, items: [{ token_uid: "tok_1", scope: "read" }] });
    const s = textOf(await run(listMyCredentials, { what: "sessions" }, api));
    expect(s).toContain("0123456789abcdef");
    expect(s).not.toContain("COOKIESECRET");
    expect(s).not.toContain("session_uid");
  });

  test("update_profile sends only provided fields and needs one", async () => {
    const api = new MockApi().on("PATCH", "/api/auth/me", { status: 204 });
    await run(updateProfile, { humanize_slugs: true }, api);
    expect(api.calls("PATCH", "/api/auth/me")[0]?.json).toEqual({ humanize_slugs: true });
    const empty = await run(updateProfile, {}, api);
    expect(empty.isError).toBe(true);
    expect(api.calls("PATCH", "/api/auth/me")).toHaveLength(1);
  });

  test("revoke_token / revoke_session / revoke_other_sessions request shapes", async () => {
    const api = new MockApi()
      .on("DELETE", "/api/auth/tokens/:uid", { status: 204 })
      .on("DELETE", "/api/auth/sessions/:h", { status: 204 })
      .on("DELETE", "/api/auth/sessions", { json: { revoked: 3 } });
    await run(revokeToken, { token_uid: "a/../b", confirm: true }, api);
    expect(api.requests[0]?.path).toBe("/api/auth/tokens/a%2F..%2Fb");
    await run(revokeSession, { handle: "abc", confirm: true }, api);
    expect(api.requests[1]?.path).toBe("/api/auth/sessions/abc");
    const out = await run(revokeOtherSessions, { confirm: true }, api);
    expect(jsonOf(out)).toEqual({ revoked: 3 });
  });

  test("confirm is required", async () => {
    const api = new MockApi();
    await expect(callTool(revokeToken, { token_uid: "x" }, directContext({ api }))).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
  });

  test("404 and 403 map to tool errors", async () => {
    const api = new MockApi()
      .on("DELETE", "/api/auth/sessions/:h", { status: 404, json: { error: "session not found" } })
      .on("DELETE", "/api/auth/tokens/:t", { status: 403, json: { error: "read-only token" } });
    const nf = await run(revokeSession, { handle: "zz", confirm: true }, api);
    expect(nf.isError).toBe(true);
    expect(textOf(nf)).toContain("Not found");
    const fb = await run(revokeToken, { token_uid: "zz", confirm: true }, api);
    expect(textOf(fb)).toContain("read-only token");
    expect(textOf(fb)).toContain("Forbidden");
  });
});

describe("admin user tools", () => {
  test("admin_list users, roles, user_tokens", async () => {
    const api = new MockApi()
      .on("GET", "/api/admin/users", { json: [{ user_uid: "u1", username: "a", email: null, status: "active", created_at: "t", role_slugs: ["user"], role_bits: 3 }] })
      .on("GET", "/api/admin/roles", { json: [{ role_uid: "r", slug: "user", name: "User", level: 1, bit_position: 1, is_builtin: true }] })
      .on("GET", "/api/admin/users/:uid/tokens", { json: [token] });
    expect(jsonOf(await run(adminList, { what: "users" }, api))).toMatchObject({ total: 1, items: [{ username: "a" }] });
    expect(jsonOf(await run(adminList, { what: "roles" }, api))).toMatchObject({ total: 1 });
    const tokens = await run(adminList, { what: "user_tokens", user_uid: "u1" }, api);
    expect(textOf(tokens)).not.toContain("HASHSECRET");
    expect(api.requests.at(-1)?.path).toBe("/api/admin/users/u1/tokens");
    const missing = await run(adminList, { what: "user_tokens" }, api);
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("user_uid");
  });

  test("set_user_status, assign_role, remove_role", async () => {
    const api = new MockApi()
      .on("PATCH", "/api/admin/users/:uid/status", { json: { user_uid: "u1", status: "disabled" } })
      .on("POST", "/api/admin/users/:uid/roles", { status: 200 })
      .on("DELETE", "/api/admin/users/:uid/roles/:slug", { status: 204 });
    await run(setUserStatus, { user_uid: "u1", status: "disabled" }, api);
    expect(api.requests[0]?.json).toEqual({ status: "disabled" });
    await run(assignRole, { user_uid: "u1", role_slug: "family" }, api);
    expect(api.requests[1]?.json).toEqual({ role_slug: "family" });
    await run(removeRole, { user_uid: "u1", role_slug: "family", confirm: true }, api);
    expect(api.requests[2]?.path).toBe("/api/admin/users/u1/roles/family");
    await expect(callTool(removeRole, { user_uid: "u1", role_slug: "x" }, directContext({ api }))).rejects.toThrow();
  });

  test("role guard errors reach the model: 403, 404, 409", async () => {
    const api = new MockApi()
      .on("POST", "/api/admin/users/:uid/roles", { status: 403, json: { error: "only an owner can manage this user" } })
      .on("DELETE", "/api/admin/users/:uid/roles/:slug", { status: 409, json: { error: "cannot remove the last owner" } })
      .on("DELETE", "/api/admin/users/:uid", { status: 404, json: { error: "user not found" } });
    expect(textOf(await run(assignRole, { user_uid: "u", role_slug: "owner" }, api))).toContain("only an owner");
    expect(textOf(await run(removeRole, { user_uid: "u", role_slug: "owner", confirm: true }, api))).toContain("last owner");
    expect(textOf(await run(deleteUser, { user_uid: "u", confirm: true }, api))).toContain("Not found");
  });

  test("delete_user, revoke_user_sessions, revoke_user_token", async () => {
    const api = new MockApi()
      .on("DELETE", "/api/admin/users/:uid", { status: 204 })
      .on("DELETE", "/api/admin/users/:uid/sessions", { json: { revoked: 2 } })
      .on("DELETE", "/api/admin/users/:uid/tokens/:tok", { status: 204 });
    await run(deleteUser, { user_uid: "u1", confirm: true }, api);
    expect(api.requests[0]).toMatchObject({ method: "DELETE", path: "/api/admin/users/u1" });
    expect(jsonOf(await run(revokeUserSessions, { user_uid: "u1", confirm: true }, api))).toMatchObject({ revoked: 2 });
    await run(revokeUserToken, { user_uid: "u1", token_uid: "tok_9", confirm: true }, api);
    expect(api.requests[2]?.path).toBe("/api/admin/users/u1/tokens/tok_9");
  });
});

describe("admin role tools", () => {
  const role = { role_uid: "r", slug: "family", name: "Family", level: 0, bit_position: 4, is_builtin: false };
  test("create / rename / delete", async () => {
    const api = new MockApi()
      .on("POST", "/api/admin/roles", { status: 201, json: role })
      .on("PATCH", "/api/admin/roles/:slug", { json: { ...role, name: "Fam" } })
      .on("DELETE", "/api/admin/roles/:slug", { json: { slug: "family", users_affected: 2, reorder_mask_cleared: true } });
    await run(createRole, { slug: "family", name: "Family" }, api);
    expect(api.requests[0]?.json).toEqual({ slug: "family", name: "Family" });
    expect(jsonOf(await run(renameRole, { slug: "family", name: "Fam" }, api))).toMatchObject({ name: "Fam" });
    expect(api.requests[1]?.json).toEqual({ name: "Fam" });
    expect(jsonOf(await run(deleteRole, { slug: "family", confirm: true }, api))).toEqual({
      deleted_role: "family", users_affected: 2, reorder_mask_cleared: true,
    });
  });

  test("delete_role is owner-only in the registry and annotated destructive", () => {
    expect(deleteRole.minRole).toBe("owner");
    expect(deleteRole.annotations.destructiveHint).toBe(true);
  });
});

const cookieRule = { rule_uid: "c1", url_pattern: "*.x.com", pattern_kind: "wildcard", cookies_json: JSON.stringify({ sid: "SUPERSECRETVALUE", a: "b" }), ordinal: 0, created_at: "t" };

describe("admin settings tools", () => {
  test("server_info cookie_rules never returns values", async () => {
    const api = new MockApi().on("GET", "/api/admin/cookie-rules", { json: [cookieRule] });
    const out = textOf(await run(serverInfo, { section: "cookie_rules" }, api));
    expect(out).not.toContain("SUPERSECRETVALUE");
    expect(out).not.toContain("cookies_json");
    expect(jsonOf(await run(serverInfo, { section: "cookie_rules" }, api))).toMatchObject({
      rules: [{ rule_uid: "c1", cookies: { count: 2, value_lengths: { sid: 16, a: 1 } } }],
    });
  });

  test("server_info cookie_rules tolerates unreadable cookies_json", async () => {
    const api = new MockApi().on("GET", "/api/admin/cookie-rules", { json: [{ ...cookieRule, cookies_json: "not json SECRETX" }] });
    const out = textOf(await run(serverInfo, { section: "cookie_rules" }, api));
    expect(out).not.toContain("SECRETX");
    expect(out).toContain("unreadable");
  });

  test("server_info effective_config passes through and drops secret values", async () => {
    const config = {
      server: { version: "1", bind: { value: "0.0.0.0:1", source: "default" }, archives: [{ id: "a", label: "A" }] },
      env_vars: [
        { name: "ARCHIVR_ANTHROPIC_API_KEY", group: "summaries", description: "d", secret: true, default: null, set: true, source: "env", value: "LEAKED-KEY" },
        { name: "ARCHIVR_BIND", group: "server", description: "d", secret: false, default: "x", set: false, source: "default", value: null },
      ],
      summary_providers: [{ kind: "anthropic_http", configured: true, model: "m", error: null, missing_env: [] }],
      title_models: { anthropic_http: { model: "m", source: "default", env_var: "E" } },
      transcription_engines: [{ kind: "w", enabled: true, configured: true, label: "W", english_only: false, languages: [], error: null }],
      extensions: { ublock: { available: false }, cookie_consent: { available: true } },
    };
    const api = new MockApi().on("GET", "/api/admin/effective-config", { json: config });
    const res = await run(serverInfo, { section: "effective_config" }, api);
    expect(textOf(res)).not.toContain("LEAKED-KEY");
    expect(jsonOf(res)).toMatchObject({ env_vars: [{ name: "ARCHIVR_ANTHROPIC_API_KEY", set: true, value: null }, { name: "ARCHIVR_BIND" }] });
  });

  test("server_info effective_config accepts the explicit nulls a real server sends for disabled engines", async () => {
    const config = {
      server: {},
      env_vars: [],
      summary_providers: [],
      title_models: {},
      transcription_engines: [{ kind: "whisper", enabled: false, configured: false, label: null, english_only: null, languages: null, error: null }],
      extensions: {},
    };
    const api = new MockApi().on("GET", "/api/admin/effective-config", { json: config });
    const res = await run(serverInfo, { section: "effective_config" }, api);
    expect(res.isError).toBeUndefined();
    expect(jsonOf(res)).toMatchObject({ transcription_engines: [{ kind: "whisper", label: null }] });
  });

  test("server_info archive_info uses the resolved archive; instance_settings and ytdlp hit their endpoints", async () => {
    const info = {
      archive_id: "main", label: "Main", name: "main", entry_count: 5, root_entry_count: 4, child_entry_count: 1, artifact_count: 9, blob_count: 8,
      blob_bytes: 100, tag_count: 1, collection_count: 1, run_count: 2, summary_count: 0, job_counts: { pending: 0, running: 0, completed: 3, failed: 1 }, db_bytes: 10,
    };
    const api = new MockApi().on("GET", "/api/archives/:id/info", { json: info });
    expect(jsonOf(await run(serverInfo, { section: "archive_info", archive: "main" }, api))).toMatchObject({ entry_count: 5 });
    expect(api.requests[0]?.path).toBe("/api/archives/main/info");
    // Section dispatch: wrong shapes become protocol errors rather than crashes.
    const bad = new MockApi().on("GET", "/api/admin/instance-settings", { json: { nope: 1 } });
    expect((await run(serverInfo, { section: "instance_settings" }, bad)).isError).toBe(true);
  });

  test("update_instance_settings sends only provided fields", async () => {
    const api = new MockApi().on("PATCH", "/api/admin/instance-settings", { status: 204 });
    const res = await run(updateInstanceSettings, { ublock_enabled: false, title_model_claude_cli: "  " }, api);
    expect(api.requests[0]?.json).toEqual({ ublock_enabled: false, title_model_claude_cli: "" });
    expect(jsonOf(res)).toEqual({ updated: ["ublock_enabled", "title_model_claude_cli"] });
  });

  test("update_instance_settings validates title models and needs a field", async () => {
    const api = new MockApi();
    await expect(callTool(updateInstanceSettings, { title_model_anthropic_http: "has space" }, directContext({ api }))).rejects.toThrow();
    await expect(callTool(updateInstanceSettings, { title_model_anthropic_http: "x".repeat(101) }, directContext({ api }))).rejects.toThrow();
    const empty = await run(updateInstanceSettings, {}, api);
    expect(empty.isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  test("update_instance_settings description flags inert settings and owner-only mask", () => {
    const d = updateInstanceSettings.description;
    for (const k of ["public_index_enabled", "public_entry_content_enabled", "open_registration_enabled", "INERT", "OWNER-only"]) expect(d).toContain(k);
  });

  test("update_instance_settings maps owner-only 403", async () => {
    const api = new MockApi().on("PATCH", "/api/admin/instance-settings", { status: 403, json: { error: "only the owner can change who may reorder child entries" } });
    expect(textOf(await run(updateInstanceSettings, { reorder_children_role_bits: 12 }, api))).toContain("only the owner");
  });

  test("update_ytdlp posts with a long timeout; 409 is friendly", async () => {
    const ok = new MockApi().on("POST", "/api/admin/yt-dlp/update", { json: { yt_dlp: { ok: true, message: "m" }, deno: { ok: true, message: "m" }, status: {} } });
    expect(jsonOf(await run(updateYtdlp, {}, ok))).toMatchObject({ yt_dlp: { ok: true } });
    expect(updateYtdlp.annotations.openWorldHint).toBe(true);
    const busy = new MockApi().on("POST", "/api/admin/yt-dlp/update", { status: 409, json: { error: "a yt-dlp update is already running" } });
    const res = await run(updateYtdlp, {}, busy);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("already running");
    expect(textOf(res)).not.toContain("Conflict (409)");
  });

  test("delete_cookie_rule", async () => {
    const api = new MockApi().on("DELETE", "/api/admin/cookie-rules/:uid", { status: 204 });
    await run(deleteCookieRule, { uid: "c1", confirm: true }, api);
    expect(api.requests[0]?.path).toBe("/api/admin/cookie-rules/c1");
    await expect(callTool(deleteCookieRule, { uid: "c1" }, directContext({ api }))).rejects.toThrow();
  });
});

describe("maintenance tools", () => {
  test("scan and run use the archive, cap errors and need confirm", async () => {
    const errors = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const api = new MockApi()
      .on("GET", "/api/archives/:id/blob-cleanup", { json: { orphaned_blob_rows: 1, deletable_files: 2, total_bytes: 3 } })
      .on("DELETE", "/api/archives/:id/blob-cleanup", { json: { deleted_blob_rows: 1, deleted_files: 2, freed_bytes: 3, errors } });
    expect(jsonOf(await run(blobCleanupScan, { archive: "main" }, api))).toMatchObject({ archive: "main", deletable_files: 2 });
    const res = jsonOf(await run(blobCleanupRun, { archive: "main", confirm: true }, api)) as { errors: string[]; error_count: number; errors_truncated: boolean };
    expect(res.errors).toHaveLength(20);
    expect(res.error_count).toBe(30);
    expect(res.errors_truncated).toBe(true);
    await expect(callTool(blobCleanupRun, { archive: "main" }, directContext({ api }))).rejects.toThrow();
  });

  test("409 while captures are active gives advice", async () => {
    const api = new MockApi()
      .on("GET", "/api/archives/:id/blob-cleanup", { status: 409, json: { error: "captures are in progress; wait" } })
      .on("DELETE", "/api/archives/:id/blob-cleanup", { status: 409, json: { error: "captures are in progress; wait" } });
    for (const [tool, args] of [[blobCleanupScan, { archive: "a" }], [blobCleanupRun, { archive: "a", confirm: true }]] as const) {
      const res = await run(tool, args, api);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("captures or subtitle fetches are still in progress");
    }
  });
});

describe("no leaks", () => {
  test("the API token never appears in error texts", async () => {
    const api = new MockApi().on("DELETE", "/api/admin/users/:uid", { status: 500, json: { error: `boom ${CANARY_TOKEN}` } });
    const res = await run(deleteUser, { user_uid: "u", confirm: true }, api);
    expect(textOf(res)).not.toContain(CANARY_TOKEN);
  });
});
