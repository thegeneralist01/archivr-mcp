/**
 * The isolation checklist from the plan (Part D, "V"), one named assertion group per item.
 * The server is the sole authority: every check is made against the REAL archivr-server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ARCHIVE_ID, E2E_DISABLED, Fixture, obj, PASSWORD, SERVER_BIN, type Auth, type TestUser } from "./harness";
import { assertNoLeaks } from "./leaks";

type Route = { method: string; path: string; body?: unknown };

const UID = "usr_dummy";
const ROLE = "dummy-role";

/**
 * Every `/api/admin/*` route registered by archivr-server, with a method and dummy body per
 * verb. The dummy ids never exist: if a role check were missing, the request would 404 (and fail
 * the 403 assertion) instead of touching real data.
 */
const ADMIN_ROUTES: Route[] = [
  { method: "GET", path: "/api/admin/users" },
  { method: "POST", path: "/api/admin/users", body: { username: "nobody", password: "nobody-pass-1" } },
  { method: "DELETE", path: `/api/admin/users/${UID}` },
  { method: "PATCH", path: `/api/admin/users/${UID}/status`, body: { status: "disabled" } },
  { method: "POST", path: `/api/admin/users/${UID}/roles`, body: { role_slug: "user" } },
  { method: "DELETE", path: `/api/admin/users/${UID}/roles/user` },
  { method: "POST", path: `/api/admin/users/${UID}/password`, body: { new_password: "password-123" } },
  { method: "DELETE", path: `/api/admin/users/${UID}/sessions` },
  { method: "GET", path: `/api/admin/users/${UID}/tokens` },
  { method: "DELETE", path: `/api/admin/users/${UID}/tokens/tok_dummy` },
  { method: "GET", path: "/api/admin/roles" },
  { method: "POST", path: "/api/admin/roles", body: { slug: "nope", name: "Nope" } },
  { method: "PATCH", path: `/api/admin/roles/${ROLE}`, body: { name: "Nope" } },
  { method: "DELETE", path: `/api/admin/roles/${ROLE}` },
  { method: "GET", path: "/api/admin/instance-settings" },
  { method: "PATCH", path: "/api/admin/instance-settings", body: { ublock_enabled: false } },
  { method: "GET", path: "/api/admin/yt-dlp" },
  { method: "POST", path: "/api/admin/yt-dlp/update" },
  { method: "GET", path: "/api/admin/cookie-rules" },
  { method: "POST", path: "/api/admin/cookie-rules", body: { pattern_kind: "domain", url_pattern: "x.test", cookies_json: "{}" } },
  { method: "PATCH", path: "/api/admin/cookie-rules/rule_dummy", body: { ordinal: 1 } },
  { method: "DELETE", path: "/api/admin/cookie-rules/rule_dummy" },
  { method: "GET", path: "/api/admin/effective-config" },
  // Admin-gated routes that live outside /api/admin.
  { method: "GET", path: `/api/archives/${ARCHIVE_ID}/info` },
  { method: "GET", path: `/api/archives/${ARCHIVE_ID}/blob-cleanup` },
  { method: "DELETE", path: `/api/archives/${ARCHIVE_ID}/blob-cleanup` },
];

/** `/api/admin/users/:uid/status` -> `/api/admin/users/{}/status` (also maps our dummy ids). */
const DUMMY_SEGMENTS = new Set([UID, "tok_dummy", ROLE, "rule_dummy", "user", ARCHIVE_ID]);
const template = (p: string) =>
  p
    .split("/")
    .map((seg) => (seg.startsWith(":") || DUMMY_SEGMENTS.has(seg) ? "{}" : seg))
    .join("/");

/** Route templates declared in the Rust sources, when the source tree sits next to the binary. */
function adminRoutesInSource(): string[] | null {
  if (!SERVER_BIN) return null;
  // <repo>/target/debug/archivr-server -> <repo>/crates/archivr-server/src
  const src = resolve(dirname(SERVER_BIN), "..", "..", "crates", "archivr-server", "src");
  if (!existsSync(src) || !statSync(src).isDirectory()) return null;
  const found = new Set<string>();
  for (const file of readdirSync(src).filter((f) => f.endsWith(".rs"))) {
    const text = readFileSync(join(src, file), "utf8");
    for (const m of text.matchAll(/\.route\(\s*"(\/api\/(?:admin\/[^"]*|archives\/:archive_id\/(?:info|blob-cleanup)))"/g)) {
      found.add(template(m[1]!));
    }
  }
  return [...found].sort();
}

describe.skipIf(E2E_DISABLED)("e2e isolation checklist", () => {
  let fx: Fixture;
  const rest = (method: string, path: string, auth: Auth = {}, body?: unknown) =>
    fx.server.rest(method, path, { ...auth, ...(body === undefined ? {} : { body }) });
  const tok = (u: TestUser): Auth => ({ token: u.token });

  /** Create a user through the owner's API and return it with a token. */
  async function makeUser(username: string, roles: string[] = []): Promise<TestUser> {
    const res = await rest("POST", "/api/admin/users", tok(fx.cast.owner), { username, password: PASSWORD });
    expect(res.status, res.text).toBe(201);
    const uid = (res.json as { user_uid: string }).user_uid;
    for (const role_slug of roles) {
      expect((await rest("POST", `/api/admin/users/${uid}/roles`, tok(fx.cast.owner), { role_slug })).status).toBe(200);
    }
    const cookie = await fx.server.login(username, PASSWORD);
    const { token, uid: tokenUid } = await fx.server.mintToken(cookie, `iso-${username}`);
    return { username, password: PASSWORD, uid, cookie, token, tokenUid };
  }

  beforeAll(async () => {
    fx = await Fixture.create();
  });
  afterAll(async () => {
    await fx.teardown();
  });

  // ── a USER token gets 403 on every /api/admin/* route ─────────────────────

  test("isolation: the admin route table covers every /api/admin/* route in the server source", () => {
    const declared = adminRoutesInSource();
    if (declared === null) {
      console.warn("server source not found next to ARCHIVR_SERVER_BIN: route coverage cross-check skipped");
      return;
    }
    const covered = [...new Set(ADMIN_ROUTES.map((r) => template(r.path)))].sort();
    expect(covered).toEqual(declared);
  });

  test("isolation: USER token gets 403 on every /api/admin/* route (and guest 403, anonymous 401)", async () => {
    for (const { method, path, body } of ADMIN_ROUTES) {
      const label = `${method} ${path}`;
      const asUser = await rest(method, path, tok(fx.cast.user), body);
      expect(asUser.status, `user token: ${label}`).toBe(403);
      expect(asUser.json, label).toEqual({ error: expect.any(String) });
      expect((await rest(method, path, tok(fx.cast.guest), body)).status, `guest token: ${label}`).toBe(403);
      expect((await rest(method, path, { cookie: fx.cast.user.cookie }, body)).status, `user cookie: ${label}`).toBe(403);
      expect((await rest(method, path, {}, body)).status, `anonymous: ${label}`).toBe(401);
    }
  });

  test("isolation: the same admin routes are reachable by an ADMIN (the 403s above are role checks, not dead routes)", async () => {
    for (const path of ["/api/admin/users", "/api/admin/roles", "/api/admin/instance-settings", "/api/admin/cookie-rules", "/api/admin/effective-config", `/api/archives/${ARCHIVE_ID}/info`]) {
      expect((await rest("GET", path, tok(fx.cast.admin))).status, path).toBe(200);
    }
    // And an unknown id on an admin route is 404 for an admin, so the user 403 above came first.
    expect((await rest("GET", `/api/admin/users/${UID}/tokens`, tok(fx.cast.admin))).status).toBe(404);
  });

  // ── ADMIN cannot touch OWNER or another ADMIN; OWNER can ──────────────────

  test("isolation: ADMIN cannot delete, disable, reset, revoke or role-change an OWNER or another ADMIN (403); nothing changes", async () => {
    const admin = tok(fx.cast.admin);
    for (const target of [fx.cast.owner, fx.cast.admin2]) {
      const t = `/api/admin/users/${target.uid}`;
      const attempts: Array<[string, string, unknown?]> = [
        ["DELETE", t],
        ["PATCH", `${t}/status`, { status: "disabled" }],
        ["POST", `${t}/password`, { new_password: "hijacked-pass-1" }],
        ["DELETE", `${t}/sessions`],
        ["GET", `${t}/tokens`],
        ["DELETE", `${t}/tokens/${target.tokenUid}`],
        ["POST", `${t}/roles`, { role_slug: "user" }],
        ["DELETE", `${t}/roles/user`],
      ];
      for (const [method, path, body] of attempts) {
        const res = await rest(method, path, admin, body);
        expect(res.status, `${target.username}: ${method} ${path} -> ${res.text}`).toBe(403);
      }
      // The target is untouched: password, session, token and account all still work.
      expect((await rest("GET", "/api/auth/me", { cookie: target.cookie })).status).toBe(200);
      expect((await rest("GET", "/api/auth/me", tok(target))).status).toBe(200);
      expect((await fx.server.loginRaw(target.username, PASSWORD)).status).toBe(200);
    }
    // Through the MCP too: the server's refusal is surfaced as a tool error.
    const mcp = await fx.mcp(fx.cast.admin.token, { toolsets: "core,admin,credentials" });
    const del = await mcp.call("delete_user", { user_uid: fx.cast.owner.uid, confirm: true });
    expect(del.isError).toBe(true);
    expect(del.text).toContain("403");
    const reset = await mcp.call("reset_user_password", { user_uid: fx.cast.admin2.uid, new_password: "hijacked-pass-1" });
    expect(reset.isError).toBe(true);
    expect(reset.text).toContain("403");
  });

  test("isolation: ADMIN cannot act on themselves (409)", async () => {
    const admin = tok(fx.cast.admin);
    const me = `/api/admin/users/${fx.cast.admin.uid}`;
    expect((await rest("DELETE", me, admin)).status).toBe(409);
    expect((await rest("PATCH", `${me}/status`, admin, { status: "disabled" })).status).toBe(409);
    expect((await rest("POST", `${me}/password`, admin, { new_password: "another-pass-1" })).status).toBe(409);
    expect((await rest("DELETE", `${me}/sessions`, admin)).status).toBe(409);
  });

  test("isolation: ADMIN may manage plain users; OWNER may manage admins and other owners", async () => {
    const admin = tok(fx.cast.admin);
    const owner = tok(fx.cast.owner);
    const plain = await makeUser("plain");
    expect((await rest("PATCH", `/api/admin/users/${plain.uid}/status`, admin, { status: "disabled" })).status).toBe(200);
    expect((await rest("PATCH", `/api/admin/users/${plain.uid}/status`, admin, { status: "active" })).status).toBe(200);
    expect((await rest("POST", `/api/admin/users/${plain.uid}/password`, admin, { new_password: "reset-by-admin-1" })).status).toBe(200);
    expect((await rest("DELETE", `/api/admin/users/${plain.uid}`, admin)).status).toBe(204);

    const victimAdmin = await makeUser("victim-admin", ["admin"]);
    const t = `/api/admin/users/${victimAdmin.uid}`;
    expect((await rest("PATCH", `${t}/status`, owner, { status: "disabled" })).status).toBe(200);
    expect((await rest("GET", "/api/auth/me", tok(victimAdmin))).status).toBe(401); // disabled: token dead
    expect((await rest("PATCH", `${t}/status`, owner, { status: "active" })).status).toBe(200);
    expect((await rest("POST", `${t}/password`, owner, { new_password: "reset-by-owner-1" })).status).toBe(200);
    expect((await rest("DELETE", `${t}/sessions`, owner)).status).toBe(200);
    expect((await rest("GET", `${t}/tokens`, owner)).status).toBe(200);
    expect((await rest("DELETE", `${t}/roles/admin`, owner)).status).toBe(204);
    expect((await rest("DELETE", t, owner)).status).toBe(204);

    const victimOwner = await makeUser("victim-owner", ["owner"]);
    expect((await rest("DELETE", `/api/admin/users/${victimOwner.uid}`, admin)).status).toBe(403);
    expect((await rest("DELETE", `/api/admin/users/${victimOwner.uid}`, owner)).status).toBe(204); // two owners: allowed
  });

  // ── last owner ────────────────────────────────────────────────────────────

  test("isolation: the last active owner cannot be deleted, disabled or demoted (409)", async () => {
    const owner = tok(fx.cast.owner);
    const self = `/api/admin/users/${fx.cast.owner.uid}`;
    expect((await rest("DELETE", self, owner)).status).toBe(409);
    expect((await rest("PATCH", `${self}/status`, owner, { status: "disabled" })).status).toBe(409);
    const demote = await rest("DELETE", `${self}/roles/owner`, owner);
    expect(demote.status).toBe(409);
    expect(demote.text).toContain("last active owner");

    // A second owner that is *disabled* does not count: the guard counts active owners only.
    const second = await makeUser("owner-two", ["owner"]);
    expect((await rest("PATCH", `/api/admin/users/${second.uid}/status`, owner, { status: "disabled" })).status).toBe(200);
    expect((await rest("DELETE", `${self}/roles/owner`, owner)).status).toBe(409);
    expect((await rest("PATCH", `/api/admin/users/${second.uid}/status`, owner, { status: "active" })).status).toBe(200);

    // With two active owners, demoting one is fine; the survivor is then protected again.
    expect((await rest("DELETE", `/api/admin/users/${second.uid}/roles/owner`, owner)).status).toBe(204);
    expect((await rest("DELETE", `${self}/roles/owner`, owner)).status).toBe(409);
    expect((await rest("DELETE", `/api/admin/users/${second.uid}`, owner)).status).toBe(204);

    // Still the owner afterwards.
    expect(obj({ isError: false, text: "", json: (await rest("GET", "/api/auth/me", owner)).json }).roles).toContain("owner");
  });

  // ── role grants ───────────────────────────────────────────────────────────

  test("isolation: ADMIN cannot grant or remove the owner/admin roles (403); OWNER can; unknown role is 404", async () => {
    const admin = tok(fx.cast.admin);
    const owner = tok(fx.cast.owner);
    const grantee = await makeUser("grantee");
    const g = `/api/admin/users/${grantee.uid}`;

    for (const role_slug of ["admin", "owner"]) {
      const res = await rest("POST", `${g}/roles`, admin, { role_slug });
      expect(res.status, role_slug).toBe(403);
    }
    expect((await rest("GET", "/api/auth/me", tok(grantee))).json).toMatchObject({ roles: ["user"] });

    // OWNER grants admin; from then on only an owner can remove it.
    expect((await rest("POST", `${g}/roles`, owner, { role_slug: "admin" })).status).toBe(200);
    expect((await rest("DELETE", `${g}/roles/admin`, admin)).status).toBe(403);
    expect((await rest("DELETE", `${g}/roles/admin`, owner)).status).toBe(204);

    // Custom roles are within an admin's reach; unknown slugs are 404 (not 500).
    expect((await rest("POST", "/api/admin/roles", admin, { slug: "iso-role", name: "Iso" })).status).toBe(201);
    expect((await rest("POST", `${g}/roles`, admin, { role_slug: "iso-role" })).status).toBe(200);
    expect((await rest("POST", `${g}/roles`, admin, { role_slug: "no-such-role" })).status).toBe(404);
    expect((await rest("PATCH", "/api/admin/roles/iso-role", admin, { name: "Iso 2" })).status).toBe(200);
    expect((await rest("PATCH", "/api/admin/roles/admin", admin, { name: "Renamed" })).status).toBe(400); // built-in
  });

  test("isolation: deleting a role is OWNER-only (admin 403, owner 200)", async () => {
    // `iso-role` was created and assigned above.
    expect((await rest("DELETE", "/api/admin/roles/iso-role", tok(fx.cast.admin))).status).toBe(403);
    expect((await rest("DELETE", "/api/admin/roles/iso-role", tok(fx.cast.user))).status).toBe(403);
    const del = await rest("DELETE", "/api/admin/roles/iso-role", tok(fx.cast.owner));
    expect(del.status).toBe(200);
    expect(del.json).toMatchObject({ slug: "iso-role", users_affected: 1 });
    expect((await rest("DELETE", "/api/admin/roles/owner", tok(fx.cast.owner))).status).toBe(400); // built-in

    // The MCP hides delete_role from admins; an owner has it.
    const adminMcp = await fx.mcp(fx.cast.admin.token);
    expect(adminMcp.toolNames).not.toContain("delete_role");
    const ownerMcp = await fx.mcp(fx.cast.owner.token);
    expect(ownerMcp.toolNames).toContain("delete_role");
  });

  // ── GET /api/archives omits archive_path for non-admins ───────────────────

  test("isolation: GET /api/archives omits archive_path for anonymous/guest/user and shows it to admin/owner", async () => {
    for (const [label, auth] of [
      ["anonymous", {}],
      ["guest", tok(fx.cast.guest)],
      ["user", tok(fx.cast.user)],
      ["user cookie", { cookie: fx.cast.user.cookie }],
    ] as Array<[string, Auth]>) {
      const res = await rest("GET", "/api/archives", auth);
      expect(res.status, label).toBe(200);
      expect(res.json, label).toEqual([{ id: ARCHIVE_ID, label: "E2E Archive" }]);
      expect(res.text, label).not.toContain("archive_path");
      expect(res.text, label).not.toContain(fx.server.dir);
    }
    for (const u of [fx.cast.admin, fx.cast.owner]) {
      const res = await rest("GET", "/api/archives", tok(u));
      expect((res.json as Array<{ archive_path?: string }>)[0]?.archive_path).toBe(fx.server.archivePath);
    }
    // And through the MCP, a user never sees it.
    const mcp = await fx.mcp(fx.cast.user.token);
    const out = await mcp.call("list_archives");
    expect(out.text).not.toContain("archive_path");
    expect(out.text).not.toContain(fx.server.dir);
  });

  // ── session_uid and secrets never leave the server ────────────────────────

  test("isolation: session endpoints return handles, never the cookie value", async () => {
    const cookie = await fx.server.login("user", PASSWORD);
    const res = await rest("GET", "/api/auth/sessions", { cookie });
    expect(res.status).toBe(200);
    const rows = res.json as Array<Record<string, unknown>>;
    expect(rows.some((r) => r["current"] === true)).toBe(true);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "current", "expires_at", "last_seen_at", "session_handle", "user_agent"]);
      expect(String(r["session_handle"])).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(res.text).not.toContain(cookie);
    expect(JSON.stringify((await rest("GET", "/api/auth/me", { cookie })).json)).not.toContain(cookie);
    expect((await rest("GET", "/api/auth/tokens", { cookie })).text).not.toContain(cookie);
  });

  test("isolation: passwords never come back from tool errors or echoes", async () => {
    const mcp = await fx.mcp(fx.cast.user.token, { toolsets: "core,account,credentials" });
    const wrong = "definitely-wrong-password";
    const fresh = "brand-new-password-7";
    fx.evidence.secret("wrong pw", wrong);
    fx.evidence.secret("new pw", fresh);
    const bad = await mcp.call("change_password", { current_password: wrong, new_password: fresh });
    expect(bad.isError).toBe(true);
    expect(bad.text).not.toContain(wrong);
    expect(bad.text).not.toContain(fresh);
    const short = await mcp.call("change_password", { current_password: PASSWORD, new_password: "short" });
    expect(short.isError).toBe(true);
    expect(short.text).not.toContain(PASSWORD);

    const admin = await fx.mcp(fx.cast.admin.token, { toolsets: "core,admin,credentials" });
    const dup = await admin.call("create_user", { username: "user", password: "dup-user-password-1" });
    fx.evidence.secret("dup pw", "dup-user-password-1");
    expect(dup.isError).toBe(true);
    expect(dup.text).not.toContain("dup-user-password-1");
  });

  // ── known gaps (server), documented rather than patched ───────────────────

  // BUG (archivr-server, reported, not patched here): once an entry is hidden from a user's role
  // (collection visibility), list/search/runs hide it, but fetching it BY UID still succeeds:
  // GET entries/:uid, .../artifacts/:index and /blobs/:sha256 return 200 with the content. The plan
  // lists artifact and blob endpoints as a known gap; the entry-detail endpoint has it too.
  test.skip("KNOWN SERVER GAP: a hidden entry is still readable by uid (expected 404/403 for user2)", async () => {
    const a = await fx.mcp(fx.cast.user.token);
    const entry: string = obj(await a.call("capture_text", { title: "Hidden", body: "private", wait: true })).entry_uids[0];
    await a.call("set_entry_visibility", { collection_uid: "coll_default", entry_uid: entry, visibility_bits: 4 });
    const base = `/api/archives/${ARCHIVE_ID}/entries/${entry}`;
    expect([403, 404]).toContain((await rest("GET", base, tok(fx.cast.user2))).status);
    expect([403, 404]).toContain((await rest("GET", `${base}/artifacts/0`, tok(fx.cast.user2))).status);
  });
  test.todo("server: enforce collection visibility on GET entry, artifact and blob by uid/sha", () => {});

  // ── last: nothing leaked across the whole run ─────────────────────────────

  test("isolation: session_uid never appears in any REST or MCP response of this run; no secret in MCP stdout/stderr", () => {
    assertNoLeaks(fx);
    // Belt and braces for the headline claim: every cookie value this run ever held.
    const everything = fx.evidence.all();
    for (const u of Object.values(fx.cast)) expect(everything).not.toContain(u.cookie);
    // MCP stdout carries JSON-RPC only; stderr stays free of tokens and passwords.
    const stderr = fx.evidence.mcpStderr.join("");
    for (const u of Object.values(fx.cast)) {
      expect(stderr).not.toContain(u.token);
      expect(stderr).not.toContain(u.password);
    }
  });
});
