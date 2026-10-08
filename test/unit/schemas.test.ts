import { describe, expect, test } from "bun:test";
import * as S from "../../src/client/schemas";

const entry = {
  entry_uid: "ent_1", archived_at: "2026-01-01T00:00:00Z", source_kind: "web_page", entity_kind: "page",
  title: null, visibility: "private", original_url: "https://example.com", artifact_count: 2,
  total_artifact_bytes: 10, parent_entry_uid: null, has_favicon: true, cached_bytes: 0, child_count: 0, cacheable_bytes: 10,
};
const summaryRecord = {
  summary_uid: "sum_1", entry_uid: "ent_1", provider_kind: "anthropic_http", resolved_model: null, provider_model: null,
  prompt_version: "v1", input_sha256: "abc", status: "completed", summary_text: "text", error_text: null,
  created_at: "t", updated_at: "t", completed_at: "t",
};

describe("response schemas parse the shapes the server sends", () => {
  test("archives (archive_path redacted for non-admins)", () => {
    expect(S.MountedArchiveListSchema.parse([{ id: "main", label: "Main" }])).toHaveLength(1);
    expect(S.MountedArchiveListSchema.parse([{ id: "main", label: "Main", archive_path: "/srv/a" }])[0]?.archive_path).toBe("/srv/a");
  });

  test("entries, detail, summary", () => {
    expect(S.EntrySummaryListSchema.parse([entry])).toHaveLength(1);
    const detail = S.EntryDetailSchema.parse({
      summary: entry, structured_root_relpath: "x", source_metadata_json: "{}", display_metadata_json: null,
      artifacts: [{ artifact_role: "primary", storage_area: "raw", relpath: "a/b", byte_size: null }],
      latest_summary: summaryRecord, summary_attempt: null,
    });
    expect(detail.artifacts[0]?.byte_size).toBeNull();
    expect(S.EntrySummaryResponseSchema.parse({ entry_uid: "e", summary: null }).attempt).toBeUndefined();
    expect(S.EntrySummaryResponseSchema.parse({ entry_uid: "e", summary: summaryRecord, attempt: null }).attempt).toBeNull();
    expect(S.RequestSummaryResponseSchema.parse({ ...summaryRecord, status: "pending" }).status).toBe("pending");
  });

  test("tag tree is recursive", () => {
    const tag = (n: string) => ({ tag_uid: n, name: n, slug: n, full_path: n });
    const tree = S.TagTreeSchema.parse([{ tag: tag("a"), entry_count: 1, subtree_count: 2, children: [{ tag: tag("b"), entry_count: 1, subtree_count: 1, children: [] }] }]);
    expect(tree[0]?.children[0]?.tag.name).toBe("b");
  });

  test("collections", () => {
    const c = { collection_uid: "c", name: "N", slug: "n", default_visibility_bits: 2, requires_auth: true, created_at: "t" };
    expect(S.CollectionListSchema.parse([c])).toHaveLength(1);
    expect(S.CollectionDetailSchema.parse({ ...c, entries: [{ entry_uid: "e", title: null, source_kind: "k", archived_at: "t", original_url: null, collection_visibility_bits: 2 }] }).entries).toHaveLength(1);
    expect(S.EntryCollectionMembershipListSchema.parse([{ collection_uid: "c", name: "N", visibility_bits: 3 }])).toHaveLength(1);
  });

  test("capture jobs: legacy shape and the J2 extension", () => {
    const legacy = { job_uid: "j", archive_id: "main", run_uid: null, status: "pending", error_text: null, notes_json: null, created_at: "t", updated_at: "t" };
    expect(S.CaptureJobSchema.parse(legacy).entry_uids).toBeUndefined();
    const extended = S.CaptureJobSchema.parse({ ...legacy, created_by: "usr_1", entry_uids: ["e1"], items: [{ entry_uid: "e1", status: "completed" }] });
    expect(extended.entry_uids).toEqual(["e1"]);
    expect(S.CaptureAcceptedSchema.parse({ job_uid: "j", status: "pending" }).job_uid).toBe("j");
    expect(S.UploadResultSchema.parse({ locator: "file:///x/y.txt", filename: "y.txt", size: 3 }).size).toBe(3);
  });

  test("runs, probes, capture options", () => {
    expect(S.RunSummaryListSchema.parse([{ run_uid: "r", started_at: "t", finished_at: null, status: "ok", requested_count: 1, discovered_count: 1, completed_count: 1, failed_count: 0, error_summary: null }])).toHaveLength(1);
    expect(S.ProbeResultSchema.parse({ has_video: false, has_audio: false, qualities: [] }).has_video).toBe(false);
    expect(S.PlaylistProbeResultSchema.parse({ playlist_id: "p", title: null, uploader: null, items: [{ id: "v", url: "u", title: null, qualities: ["1080p"], has_audio: true }] }).items).toHaveLength(1);
    expect(S.CaptureOptionsSchema.parse({
      ublock_enabled: true, cookie_ext_enabled: false, modal_closer_enabled: false, ublock_ext_available: false, cookie_ext_available: false,
      reader_mode: false, via_freedium: true, download_subtitles: true, title_providers: [{ kind: "anthropic_http", label: "Anthropic" }],
    }).title_providers).toHaveLength(1);
  });

  test("me: before and after the M1 extension; roles as slugs or objects", () => {
    const old = { role_bits: 7, username: "u", display_name: null, humanize_slugs: false, can_reorder_children: true };
    expect(S.MeSchema.parse(old).user_uid).toBeUndefined();
    const next = S.MeSchema.parse({ ...old, user_uid: "usr_1", roles: ["user", { slug: "admin", name: "Admin" }] });
    expect(next.roles).toHaveLength(2);
  });

  test("tokens and sessions: legacy and extended; session_uid is not part of the schema", () => {
    expect(S.ApiTokenListSchema.parse([{ token_uid: "t", name: "n", created_at: "t", last_used_at: null }])).toHaveLength(1);
    const ext = S.ApiTokenListSchema.parse([{ token_uid: "t", name: "n", created_at: "t", last_used_at: "x", expires_at: null, scope: "read" }]);
    expect(ext[0]?.scope).toBe("read");
    expect(S.TokenCreatedSchema.parse({ token_uid: "t", raw_token: "r", name: "n", expires_at: "x", scope: "full" }).raw_token).toBe("r");
    expect(S.SessionListSchema.parse([{ session_handle: "0123456789abcdef", created_at: "t", last_seen_at: "t", expires_at: "t", user_agent: null, current: true }])).toHaveLength(1);
    expect(S.ApiTokenRecordSchema.safeParse({ token_uid: "t", name: "n", created_at: "t", last_used_at: null, scope: "admin" }).success).toBe(false);
  });

  test("admin: users, roles, settings, yt-dlp, cookie rules", () => {
    expect(S.UserSummaryListSchema.parse([{ user_uid: "u", username: "n", email: null, status: "active", created_at: "t", role_slugs: ["user"], role_bits: 3 }])).toHaveLength(1);
    expect(S.UserCreatedSchema.parse({ user_uid: "u", username: "n" }).username).toBe("n");
    expect(S.RoleRecordListSchema.parse([{ role_uid: "r", slug: "user", name: "User", level: 1, bit_position: 1, is_builtin: true }])).toHaveLength(1);
    const settings = S.InstanceSettingsSchema.parse({
      public_index_enabled: false, public_entry_content_enabled: false, open_registration_enabled: false, default_entry_visibility: 2,
      ublock_enabled: true, cookie_ext_enabled: false, modal_closer_enabled: false, reorder_children_role_bits: 12,
      title_model_anthropic_http: null, title_model_openai_compatible: null, title_model_claude_cli: null, title_model_codex_cli: null,
      ublock_ext_available: false, cookie_ext_available: false,
      title_models: { anthropic_http: { model: "m", source: "default", fallback_model: "m", fallback_source: "default", env_var: "ARCHIVR_X" } },
    });
    expect(settings.reorder_children_role_bits).toBe(12);
    const candidate = { role: "path", label: "PATH", path: null, version: null, chosen: false, invalid: null };
    const status = {
      yt_dlp: [candidate], yt_dlp_chosen: { role: null, kind: null, path: null, version: null }, js_runtime: [candidate], js_runtime_chosen: null,
      state_dir: null, yt_dlp_target: null, yt_dlp_installed: false, deno_target: null, deno_installed: false, update_running: false, js_runtime_in_use: null,
    };
    expect(S.YtDlpStatusSchema.parse(status).update_running).toBe(false);
    expect(S.YtDlpUpdateResultSchema.parse({ yt_dlp: { ok: true, message: "m" }, deno: { ok: false, message: "m" }, status }).deno.ok).toBe(false);
    expect(S.CookieRuleListSchema.parse([{ rule_uid: "c", url_pattern: null, pattern_kind: "global", cookies_json: "{}", ordinal: 0, created_at: "t" }])).toHaveLength(1);
  });

  test("maintenance and misc", () => {
    expect(S.BlobCleanupScanSchema.parse({ orphaned_blob_rows: 1, deletable_files: 2, total_bytes: 3 }).total_bytes).toBe(3);
    expect(S.BlobCleanupResultSchema.parse({ deleted_blob_rows: 1, deleted_files: 1, freed_bytes: 1, errors: [] }).errors).toEqual([]);
    expect(S.TranscriptionEngineListSchema.parse([{ kind: "whisper", label: "Whisper", english_only: false, languages: ["en"] }])).toHaveLength(1);
    expect(S.ThreadTitleResponseSchema.parse({ entry_uid: "e", title: "T" }).title).toBe("T");
    expect(S.MediaTokenResponseSchema.parse({ url: "/x", expires_in_secs: 7200 }).expires_in_secs).toBe(7200);
  });

  test("objects are loose: unknown fields pass through", () => {
    const parsed = S.ThreadTitleResponseSchema.parse({ entry_uid: "e", title: "T", extra: 1 }) as Record<string, unknown>;
    expect(parsed["extra"]).toBe(1);
  });
});
