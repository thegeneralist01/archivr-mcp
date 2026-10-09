import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ARCHIVE_ID, bootstrapCast, E2E_DISABLED, Fixture, McpSession, obj, restPoll } from "./harness";
import { assertNoLeaks } from "./leaks";

const ANTHROPIC_CANARY = "sekret-e2e-canary";
const OPENAI_CANARY = "openai-e2e-canary";
const URL_PW_CANARY = "urlpw-e2e-canary";
const URL_QUERY_CANARY = "urlquery-e2e-canary";

describe.skipIf(E2E_DISABLED)("e2e: instance settings, effective config, archive info, jobs and runs", () => {
  let fx: Fixture;
  beforeAll(async () => {
    fx = await Fixture.create();
  });
  afterAll(async () => {
    await fx.teardown();
  });

  // ── 7. instance settings and info ─────────────────────────────────────────

  test("update_instance_settings is a partial PATCH and server_info reflects it", async () => {
    const admin = await fx.mcp(fx.cast.admin.token);
    const before = obj(await admin.call("server_info", { section: "instance_settings" }));
    expect(before["ublock_enabled"]).toBe(true);

    const res = obj(await admin.call("update_instance_settings", { ublock_enabled: false, title_model_claude_cli: "haiku-e2e" }));
    expect(res["updated"]).toEqual(["ublock_enabled", "title_model_claude_cli"]);
    const after = obj(await admin.call("server_info", { section: "instance_settings" }));
    expect(after["ublock_enabled"]).toBe(false);
    expect(after["title_model_claude_cli"]).toBe("haiku-e2e");
    // Untouched fields are untouched.
    for (const key of ["public_index_enabled", "cookie_ext_enabled", "modal_closer_enabled", "default_entry_visibility", "reorder_children_role_bits"]) {
      expect(after[key], key).toEqual(before[key]);
    }

    // Empty string clears a title model; an empty call is refused client-side.
    await admin.call("update_instance_settings", { title_model_claude_cli: "" });
    expect(obj(await admin.call("server_info", { section: "instance_settings" }))["title_model_claude_cli"]).toBeNull();
    expect((await admin.call("update_instance_settings", {})).isError).toBe(true);
    await admin.call("update_instance_settings", { ublock_enabled: true });
    expect(obj(await admin.call("server_info", { section: "instance_settings" }))["ublock_enabled"]).toBe(true);

    // A plain user can neither see the tool nor change settings over REST.
    const patch = await fx.server.rest("PATCH", "/api/admin/instance-settings", { token: fx.cast.user.token, body: { ublock_enabled: false } });
    expect(patch.status).toBe(403);
  });

  test("archive_info counts follow reality; blob_cleanup_scan and run have the documented shape", async () => {
    const user = await fx.mcp(fx.cast.user.token);
    const admin = await fx.mcp(fx.cast.admin.token);
    const before = obj(await admin.call("server_info", { section: "archive_info" }));
    expect(before).toMatchObject({ archive_id: ARCHIVE_ID, label: "E2E Archive" });

    await user.call("capture_text", { title: "Info A", body: "a", wait: true });
    await user.call("capture_text", { title: "Info B", body: "b", wait: true });
    await user.call("create_tag", { path: "info/tag" });
    const after = obj(await admin.call("server_info", { section: "archive_info" }));
    expect(after["entry_count"]).toBe(before["entry_count"] + 2);
    expect(after["artifact_count"]).toBe(before["artifact_count"] + 2);
    expect(after["run_count"]).toBe(before["run_count"] + 2);
    expect(after["tag_count"]).toBeGreaterThan(before["tag_count"]);
    expect(after["job_counts"]["completed"]).toBe(before["job_counts"]["completed"] + 2);
    expect(after["blob_bytes"]).toBeGreaterThan(before["blob_bytes"]);
    // Counts and sizes only: no filesystem paths.
    expect(JSON.stringify(after)).not.toContain(fx.server.dir);
    expect(after["entry_count"]).toBe(obj(await admin.call("list_entries", {}))["total"]);

    const scan = obj(await admin.call("blob_cleanup_scan", {}));
    expect(scan).toMatchObject({ archive: ARCHIVE_ID, orphaned_blob_rows: 0, deletable_files: 0 });
    const run = await admin.call("blob_cleanup_run", { confirm: true });
    expect(run.isError).toBe(false);
    expect(obj(run)).toMatchObject({ error_count: 0 });

    // Info is admin-only.
    expect((await fx.server.rest("GET", `/api/archives/${ARCHIVE_ID}/info`, { token: fx.cast.user.token })).status).toBe(403);
  });

  test("effective_config redacts secrets: canaries never reach the MCP output, stderr, REST or the server log", async () => {
    const secrets = [ANTHROPIC_CANARY, OPENAI_CANARY, URL_PW_CANARY, URL_QUERY_CANARY];
    for (const s of secrets) fx.evidence.secret(`canary:${s}`, s);
    const server2 = await fx.extraServer({
      ARCHIVR_ANTHROPIC_API_KEY: ANTHROPIC_CANARY,
      ARCHIVR_OPENAI_API_KEY: OPENAI_CANARY,
      ARCHIVR_OPENAI_URL: `https://user:${URL_PW_CANARY}@example.test/v1?key=${URL_QUERY_CANARY}`,
    });
    const cast2 = await bootstrapCast(server2, fx.evidence);
    const admin = await McpSession.start({ server: server2, token: cast2.admin.token, evidence: fx.evidence });
    fx.sessions.push(admin);

    const out = await admin.call("server_info", { section: "effective_config" });
    expect(out.isError).toBe(false);
    const vars: Array<Record<string, unknown>> = obj(out)["env_vars"];
    const key = vars.find((v) => v["name"] === "ARCHIVR_ANTHROPIC_API_KEY")!;
    expect(key).toMatchObject({ secret: true, set: true, value: null });
    expect(vars.find((v) => v["name"] === "ARCHIVR_OPENAI_API_KEY")).toMatchObject({ secret: true, set: true, value: null });
    // Every secret-flagged variable has a null value, whatever its state.
    for (const v of vars.filter((x) => x["secret"] === true)) expect(v["value"], String(v["name"])).toBeNull();
    // URL-valued variables lose userinfo and query.
    expect(vars.find((v) => v["name"] === "ARCHIVR_OPENAI_URL")).toMatchObject({ set: true, value: "https://example.test/v1" });
    // The key's presence is visible through summary_providers, still without a value.
    const providers: Array<Record<string, unknown>> = obj(out)["summary_providers"];
    expect(providers.find((p) => p["kind"] === "anthropic_http")).toMatchObject({ configured: true });
    expect(out.text).not.toMatch(/canary/);

    // The server without the env var reports it unset.
    const plain = await fx.mcp(fx.cast.admin.token);
    const plainKey = obj(await plain.call("server_info", { section: "effective_config" }))["env_vars"].find(
      (v: Record<string, unknown>) => v["name"] === "ARCHIVR_ANTHROPIC_API_KEY",
    );
    expect(plainKey).toMatchObject({ secret: true, set: false, value: null });

    // The raw REST view is clean too, for every role that may call it.
    const raw = await server2.rest("GET", "/api/admin/effective-config", { token: cast2.owner.token });
    expect(raw.status).toBe(200);
    for (const s of secrets) {
      expect(raw.text).not.toContain(s);
      expect(server2.log()).not.toContain(s);
    }
    expect((await server2.rest("GET", "/api/admin/effective-config", { token: cast2.user.token })).status).toBe(403);
    expect((await server2.rest("GET", "/api/admin/effective-config")).status).toBe(401);

    // Other tools on this server do not leak it either.
    for (const call of [
      admin.call("server_info", { section: "instance_settings" }),
      admin.call("server_info", { section: "ytdlp" }),
      admin.call("whoami"),
    ]) {
      expect((await call).text).not.toMatch(/canary/);
    }
    // The summary error on this server mentions OpenAI's variable only if it were missing; the key never appears.
    const user2 = await McpSession.start({ server: server2, token: cast2.user.token, evidence: fx.evidence });
    fx.sessions.push(user2);
    const entry = obj(await user2.call("capture_text", { title: "t", body: "b", wait: true }))["entry_uids"][0];
    const summarize = await user2.call("summarize_entry", { entry_uid: entry, provider: "claude_cli" });
    expect(summarize.text).not.toMatch(/canary/);
  });

  // ── 9. jobs and runs ──────────────────────────────────────────────────────

  test("capture jobs are private to their creator; admin sees all; ownerless rows are admin-only", async () => {
    const a = await fx.mcp(fx.cast.user.token);
    const b = await fx.mcp(fx.cast.user2.token);
    const admin = await fx.mcp(fx.cast.admin.token);

    const jobA = obj(await a.call("capture_text", { title: "Job A", body: "a", wait: true }));
    const jobB = obj(await b.call("capture_text", { title: "Job B", body: "b", wait: true }));
    expect(jobA["created_by"]).toBe(fx.cast.user.uid);
    expect(jobB["created_by"]).toBe(fx.cast.user2.uid);

    const uids = async (s: McpSession, args: Record<string, unknown> = {}) =>
      obj(await s.call("list_capture_jobs", { limit: 100, ...args }))["items"].map((j: { job_uid: string }) => j.job_uid);
    const seenByA = await uids(a);
    const seenByB = await uids(b);
    expect(seenByA).toContain(jobA["job_uid"]);
    expect(seenByA).not.toContain(jobB["job_uid"]);
    expect(seenByB).toContain(jobB["job_uid"]);
    expect(seenByB).not.toContain(jobA["job_uid"]);
    expect(await uids(admin)).toEqual(expect.arrayContaining([jobA["job_uid"], jobB["job_uid"]]));
    expect(await uids(admin, { created_by: fx.cast.user.uid })).not.toContain(jobB["job_uid"]);

    // B cannot read A's job: 404 (existence is not disclosed), nor filter by A's uid (403).
    const peek = await b.call("get_capture_job", { job_uid: jobA["job_uid"] });
    expect(peek.isError).toBe(true);
    expect(peek.text).toContain("404");
    const filter = await b.call("list_capture_jobs", { created_by: fx.cast.user.uid });
    expect(filter.isError).toBe(true);
    expect(filter.text).toContain("403");
    expect((await b.call("get_capture_job", { job_uid: "job_does_not_exist" })).text).toContain("404");
    // The same via raw REST with B's token.
    const raw = await fx.server.rest("GET", `/api/archives/${ARCHIVE_ID}/capture_jobs/${jobA["job_uid"]}`, { token: fx.cast.user2.token });
    expect(raw.status).toBe(404);
    // Admin may read it.
    expect((await admin.call("get_capture_job", { job_uid: jobA["job_uid"] })).isError).toBe(false);

    // A job with no owner (created before the migration / by the CLI) is admin-only.
    const archiveDb = new Database(join(fx.server.archivePath, "archivr.sqlite"));
    const legacyUid = "job_legacy_e2e";
    try {
      archiveDb.exec("PRAGMA busy_timeout = 5000");
      archiveDb
        .query("INSERT INTO capture_jobs (job_uid, archive_id, status, created_at, updated_at, created_by) VALUES (?, ?, 'completed', ?, ?, NULL)")
        .run(legacyUid, ARCHIVE_ID, "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00");
    } finally {
      archiveDb.close();
    }
    expect(await uids(a)).not.toContain(legacyUid);
    expect(await uids(b)).not.toContain(legacyUid);
    expect(await uids(admin)).toContain(legacyUid);
    expect((await a.call("get_capture_job", { job_uid: legacyUid })).text).toContain("404");
    expect((await admin.call("get_capture_job", { job_uid: legacyUid })).isError).toBe(false);

    // The job result is complete: items carry the produced entry.
    const detail = await restPoll(fx.server, `/api/archives/${ARCHIVE_ID}/capture_jobs/${jobA["job_uid"]}`, { token: fx.cast.user.token }, (j) => j.status === "completed");
    expect(detail.entry_uids).toEqual(jobA["entry_uids"]);
    expect(detail.items[0]).toMatchObject({ entry_uid: jobA["entry_uids"][0], status: "completed" });
  });

  test("runs follow access: a run is hidden once its entry is hidden from a user; creators and admins keep seeing it", async () => {
    const a = await fx.mcp(fx.cast.user.token);
    const b = await fx.mcp(fx.cast.user2.token);
    const admin = await fx.mcp(fx.cast.admin.token);
    const job = obj(await a.call("capture_text", { title: "Run vis", body: "run", wait: true }));
    const runUid: string = job["run_uid"];
    const entryUid: string = job["entry_uids"][0];

    const runs = async (s: McpSession) => obj(await s.call("list_runs", { limit: 100 }))["items"].map((r: { run_uid: string }) => r.run_uid);
    // Visible entry in the default collection: everyone with access to the entry sees its run.
    expect(await runs(a)).toContain(runUid);
    expect(await runs(b)).toContain(runUid);

    // Restrict the entry to admins: B loses the entry and the run, A (the creator) and admins keep the run.
    expect((await a.call("set_entry_visibility", { collection_uid: "coll_default", entry_uid: entryUid, visibility_bits: 4 })).isError).toBe(false);
    expect(obj(await b.call("list_entries", {}))["items"].map((e: { entry_uid: string }) => e.entry_uid)).not.toContain(entryUid);
    expect(await runs(b)).not.toContain(runUid);
    expect(await runs(a)).toContain(runUid);
    expect(await runs(admin)).toContain(runUid);
    // Anonymous callers have no run list at all.
    expect((await fx.server.rest("GET", `/api/archives/${ARCHIVE_ID}/runs`)).status).toBe(401);
  });

  test("isolation: no canary, session_uid or hash in any response or MCP stdout/stderr", () => {
    assertNoLeaks(fx);
  });
});
