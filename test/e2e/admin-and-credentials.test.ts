import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ARCHIVE_ID, E2E_DISABLED, Fixture, obj, type McpSession } from "./harness";
import { assertNoLeaks } from "./leaks";

const CREDS = "core,capture,organize,account,admin,credentials";

describe.skipIf(E2E_DISABLED)("e2e: user lifecycle, tokens and sessions", () => {
  let fx: Fixture;
  let admin: McpSession;
  const mintedViaMcp: string[] = [];
  let readTokenUid = "";

  beforeAll(async () => {
    fx = await Fixture.create();
    admin = await fx.mcp(fx.cast.admin.token, { toolsets: CREDS });
  });
  afterAll(async () => {
    await fx.teardown();
  });

  // ── 5. user lifecycle via admin tools ─────────────────────────────────────

  test("create_user, assign a custom role, status toggle, reset password, revoke sessions, delete", async () => {
    const pw1 = "bob-first-password-1";
    const pw2 = "bob-second-password-2";
    fx.evidence.secret("bob pw1", pw1);
    fx.evidence.secret("bob pw2", pw2);

    const created = obj(await admin.call("create_user", { username: "bob", password: pw1 }));
    const bobUid: string = created["user_uid"];
    expect(created["username"]).toBe("bob");

    // Bob logs in and mints a token; both survive until we say otherwise.
    const bobCookie = await fx.server.login("bob", pw1);
    const bobToken = (await fx.server.mintToken(bobCookie, "bob-token")).token;
    expect((await fx.server.rest("GET", "/api/auth/me", { token: bobToken })).status).toBe(200);

    const role = obj(await admin.call("create_role", { slug: "editor", name: "Editor" }));
    expect(role["is_builtin"]).toBe(false);
    expect(obj(await admin.call("assign_role", { user_uid: bobUid, role_slug: "editor" }))["assigned_role"]).toBe("editor");
    const listed = obj(await admin.call("admin_list", { what: "users" }));
    const bobRow = listed["items"].find((u: { user_uid: string }) => u.user_uid === bobUid);
    expect(bobRow["role_slugs"]).toContain("editor");
    expect(obj(await admin.call("rename_role", { slug: "editor", name: "Chief Editor" }))["name"]).toBe("Chief Editor");
    expect((await admin.call("remove_role", { user_uid: bobUid, role_slug: "editor", confirm: true })).isError).toBe(false);
    expect(
      obj(await admin.call("admin_list", { what: "users" }))["items"].find((u: { user_uid: string }) => u.user_uid === bobUid)["role_slugs"],
    ).not.toContain("editor");

    // Disable: logins and the existing token stop working; re-enable restores logins.
    expect(obj(await admin.call("set_user_status", { user_uid: bobUid, status: "disabled" }))["status"]).toBe("disabled");
    expect((await fx.server.loginRaw("bob", pw1)).status).toBeGreaterThanOrEqual(400);
    expect((await fx.server.rest("GET", "/api/auth/me", { token: bobToken })).status).toBe(401);
    expect(obj(await admin.call("set_user_status", { user_uid: bobUid, status: "active" }))["status"]).toBe("active");
    expect((await fx.server.loginRaw("bob", pw1)).status).toBe(200);

    // Reset password: the old password is dead, the new one works, old sessions are gone.
    const reset = obj(await admin.call("reset_user_password", { user_uid: bobUid, new_password: pw2 }));
    expect(reset).toMatchObject({ user_uid: bobUid, tokens_revoked: 0 });
    expect(reset["sessions_revoked"]).toBeGreaterThanOrEqual(1);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: bobCookie })).status).toBe(401);
    expect((await fx.server.loginRaw("bob", pw1)).status).toBe(401);
    expect((await fx.server.loginRaw("bob", pw2)).status).toBe(200);
    // Tokens survive a reset unless revoke_tokens is set.
    expect((await fx.server.rest("GET", "/api/auth/me", { token: bobToken })).status).toBe(200);

    // admin_list user_tokens never exposes the raw token or its hash; revoke_user_token kills it.
    const tokens = obj(await admin.call("admin_list", { what: "user_tokens", user_uid: bobUid }));
    expect(tokens["items"].length).toBeGreaterThanOrEqual(1);
    for (const row of tokens["items"]) {
      expect(Object.keys(row).sort()).toEqual(["created_at", "expires_at", "last_used_at", "name", "scope", "token_uid"]);
    }
    const tokenUid: string = tokens["items"].find((t: { name: string }) => t.name === "bob-token")["token_uid"];
    expect((await admin.call("revoke_user_token", { user_uid: bobUid, token_uid: tokenUid, confirm: true })).isError).toBe(false);
    expect((await fx.server.rest("GET", "/api/auth/me", { token: bobToken })).status).toBe(401);

    // revoke_user_sessions: a fresh session dies.
    const fresh = await fx.server.login("bob", pw2);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: fresh })).status).toBe(200);
    const revoked = obj(await admin.call("revoke_user_sessions", { user_uid: bobUid, confirm: true }));
    expect(revoked["revoked"]).toBeGreaterThanOrEqual(1);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: fresh })).status).toBe(401);

    // reset with revoke_tokens kills tokens too.
    const t2 = (await fx.server.mintToken(await fx.server.login("bob", pw2), "bob-token-2")).token;
    const reset2 = obj(await admin.call("reset_user_password", { user_uid: bobUid, new_password: pw2, revoke_tokens: true }));
    expect(reset2["tokens_revoked"]).toBeGreaterThanOrEqual(1);
    expect((await fx.server.rest("GET", "/api/auth/me", { token: t2 })).status).toBe(401);

    // Delete (confirm required): the account is gone, nothing dangles.
    const cookie3 = await fx.server.login("bob", pw2);
    expect((await admin.call("delete_user", { user_uid: bobUid, confirm: true })).isError).toBe(false);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: cookie3 })).status).toBe(401);
    expect((await fx.server.loginRaw("bob", pw2)).status).toBe(401);
    const after = obj(await admin.call("admin_list", { what: "users" }));
    expect(after["items"].map((u: { user_uid: string }) => u.user_uid)).not.toContain(bobUid);
    const db = fx.server.authDb();
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM users WHERE user_uid = ?").get(bobUid)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("delete_user works after the deleted user was granted roles by another admin (FK on assigned_by)", async () => {
    const owner = await fx.mcp(fx.cast.owner.token, { toolsets: CREDS });
    const grantor = obj(await owner.call("create_user", { username: "grantor", password: "grantor-pass-1" }));
    // Owner makes `grantor` an admin; grantor then assigns a role to someone else, so it appears in assigned_by.
    expect((await owner.call("assign_role", { user_uid: grantor["user_uid"], role_slug: "admin" })).isError).toBe(false);
    const gToken = (await fx.server.mintToken(await fx.server.login("grantor", "grantor-pass-1"), "g")).token;
    const grantee = obj(await owner.call("create_user", { username: "grantee", password: "grantee-pass-1" }));
    const asGrantor = await fx.mcp(gToken, { toolsets: CREDS });
    expect((await asGrantor.call("create_role", { slug: "temp-role", name: "Temp" })).isError).toBe(false);
    expect((await asGrantor.call("assign_role", { user_uid: grantee["user_uid"], role_slug: "temp-role" })).isError).toBe(false);
    const del = await owner.call("delete_user", { user_uid: grantor["user_uid"], confirm: true });
    expect(del.isError, del.text).toBe(false);
    expect((await owner.call("delete_user", { user_uid: grantee["user_uid"], confirm: true })).isError).toBe(false);
  });

  // ── 6. tokens and sessions ────────────────────────────────────────────────

  test("create_api_token with expires_in_days and scope=read; validation errors", async () => {
    const user = await fx.mcp(fx.cast.user.token, { toolsets: CREDS });
    const out = obj(await user.call("create_api_token", { name: "read-only-e2e", expires_in_days: 7, scope: "read" }));
    expect(out).toMatchObject({ name: "read-only-e2e", scope: "read" });
    expect(out["raw_token"]).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const days = (Date.parse(out["expires_at"]) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    mintedViaMcp.push(out["raw_token"]);
    readTokenUid = out["token_uid"];

    for (const bad of [0, 4000]) {
      const res = await user.call("create_api_token", { name: "bad", expires_in_days: bad });
      expect(res.isError, String(bad)).toBe(true);
    }
    expect((await user.call("create_api_token", { name: "  " })).isError).toBe(true);
    expect((await fx.server.rest("POST", "/api/auth/tokens", { token: fx.cast.user.token, body: { name: "x", scope: "bogus" } })).status).toBe(400);
  });

  test("a read-scope token cannot mutate (REST 403 'read-only token') but can read", async () => {
    const readToken = mintedViaMcp[0]!;
    const base = `/api/archives/${ARCHIVE_ID}`;

    for (const [method, path, body] of [
      ["POST", `${base}/captures/text`, { title: "nope", body: "nope" }],
      ["POST", `${base}/tags`, { path: "nope" }],
      ["POST", `${base}/collections`, { name: "n", slug: "n" }],
      ["PATCH", "/api/auth/me", { display_name: "x" }],
      ["POST", "/api/auth/tokens", { name: "escalate" }],
      ["DELETE", "/api/auth/sessions", undefined],
    ] as const) {
      const res = await fx.server.rest(method, path, { token: readToken, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json).toEqual({ error: "read-only token" });
    }
    for (const path of ["/api/auth/me", `${base}/entries`, `${base}/tags`, "/api/auth/tokens"]) {
      expect((await fx.server.rest("GET", path, { token: readToken })).status, path).toBe(200);
    }
    // The same call with a full token works.
    const ok = await fx.server.rest("POST", `${base}/captures/text`, { token: fx.cast.user.token, body: { title: "full ok", body: "x" } });
    expect(ok.status).toBeLessThan(300);
  });

  test("MCP over a read-scope token: reads work, mutating tools return the 403 error", async () => {
    const readToken = mintedViaMcp[0]!;
    const mcp = await fx.mcp(readToken);
    expect(obj(await mcp.call("whoami"))["username"]).toBe("user");
    expect((await mcp.call("list_entries", {})).isError).toBe(false);
    const res = await mcp.call("capture_text", { title: "blocked", body: "blocked" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("403");
    expect(res.text).toContain("read-only token");
    const tag = await mcp.call("create_tag", { path: "blocked" });
    expect(tag.isError).toBe(true);
    expect(tag.text).toContain("read-only token");

    // ARCHIVR_MCP_READONLY hides the mutating tools for a full token too.
    const ro = await fx.mcp(fx.cast.user.token, { readonly: true });
    expect(ro.toolNames).not.toContain("capture_text");
    expect(ro.toolNames).toContain("list_entries");
  });

  test("last_used_at is set after a Bearer call; list_my_credentials never shows session_uid or hashes", async () => {
    const user = await fx.mcp(fx.cast.user.token, { toolsets: CREDS });
    const tokens = obj(await user.call("list_my_credentials", { what: "tokens" }));
    const readRow = tokens["items"].find((t: { name: string }) => t.name === "read-only-e2e");
    expect(readRow["last_used_at"]).not.toBeNull(); // used above
    expect(readRow).toMatchObject({ scope: "read" });
    for (const row of tokens["items"]) {
      expect(Object.keys(row).sort()).toEqual(["created_at", "expires_at", "last_used_at", "name", "scope", "token_uid"]);
    }

    const sessions = obj(await user.call("list_my_credentials", { what: "sessions" }));
    expect(sessions["items"].length).toBeGreaterThanOrEqual(1);
    for (const row of sessions["items"]) {
      expect(Object.keys(row).sort()).toEqual(["created_at", "current", "expires_at", "last_seen_at", "session_handle", "user_agent"]);
      expect(row["session_handle"]).toMatch(/^[0-9a-f]{16}$/);
      expect(row["current"]).toBe(false); // Bearer request: never the cookie session
    }
    const db = fx.server.authDb();
    try {
      const ids = db.query<{ v: string }, []>("SELECT session_uid AS v FROM sessions").all().map((r) => r.v);
      const hashes = db.query<{ v: string }, []>("SELECT token_hash AS v FROM api_tokens").all().map((r) => r.v);
      const text = tokens["items"].length ? JSON.stringify(tokens) + JSON.stringify(sessions) : "";
      for (const v of [...ids, ...hashes]) expect(text).not.toContain(v);
    } finally {
      db.close();
    }
  });

  test("revoke_session and revoke_other_sessions act on the caller's own sessions only", async () => {
    const cookieA = await fx.server.login("user", "e2e-password-1234");
    const cookieB = await fx.server.login("user", "e2e-password-1234");
    const other = await fx.server.login("user2", "e2e-password-1234");
    const user = await fx.mcp(fx.cast.user.token, { toolsets: CREDS });
    const sessions = obj(await user.call("list_my_credentials", { what: "sessions" }))["items"];
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    const otherSessions = await fx.server.rest("GET", "/api/auth/sessions", { cookie: other });
    const foreignHandle: string = (otherSessions.json as Array<{ session_handle: string }>)[0]!.session_handle;
    const refused = await user.call("revoke_session", { handle: foreignHandle, confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("404");
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: other })).status).toBe(200);

    const res = obj(await user.call("revoke_other_sessions", { confirm: true }));
    expect(res["revoked"]).toBeGreaterThanOrEqual(2);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: cookieA })).status).toBe(401);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: cookieB })).status).toBe(401);
    expect((await fx.server.rest("GET", "/api/auth/me", { cookie: other })).status).toBe(200);
    // Our cast cookie was revoked too: refresh it for later tests.
    fx.cast.user.cookie = await fx.server.login("user", "e2e-password-1234");
  });

  test("a back-dated expires_at makes the next call 401 (REST and MCP)", async () => {
    const readToken = mintedViaMcp[0]!;
    const mcp = await fx.mcp(readToken);
    expect((await mcp.call("list_entries", {})).isError).toBe(false);

    const db = fx.server.authDb();
    try {
      const changed = db.query("UPDATE api_tokens SET expires_at = ? WHERE token_uid = ?").run("2020-01-01T00:00:00.000000+00:00", readTokenUid);
      expect(changed.changes).toBe(1);
    } finally {
      db.close();
    }
    expect((await fx.server.rest("GET", "/api/auth/me", { token: readToken })).status).toBe(401);
    const res = await mcp.call("list_entries", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("401");
    // A fresh MCP cannot even start with the expired token.
    await expect(fx.mcp(readToken)).rejects.toThrow();
  });

  test("a revoked token dies immediately (revoke_token)", async () => {
    const user = await fx.mcp(fx.cast.user.token, { toolsets: CREDS });
    const t = obj(await user.call("create_api_token", { name: "revoke-me" }));
    expect((await fx.server.rest("GET", "/api/auth/me", { token: t["raw_token"] })).status).toBe(200);
    expect((await user.call("revoke_token", { token_uid: t["token_uid"], confirm: true })).isError).toBe(false);
    expect((await fx.server.rest("GET", "/api/auth/me", { token: t["raw_token"] })).status).toBe(401);
    mintedViaMcp.push(t["raw_token"]);
  });

  test("isolation: no secret, hash or session_uid leaked; raw tokens only where designed", () => {
    assertNoLeaks(fx, { allowedInMcp: mintedViaMcp });
  });
});
