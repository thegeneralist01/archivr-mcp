import { z } from "zod";

/**
 * Response schemas for the Archivr REST API.
 *
 * Existing endpoints are derived from the server's serde structs (Rust `Option<T>` is
 * always serialized, so those fields are `.nullable()`). Fields added by the MCP API
 * extensions (docs/api-contract.md, superseded by the precise spec in the archivr repo
 * at docs/superpowers/specs/2026-10-08-mcp-api-extensions.md) are `.optional()` so the
 * client keeps working against a server that predates them.
 *
 * All objects are loose: unknown extra fields pass through untouched.
 */

const looseObject = z.looseObject;
const nullableString = z.string().nullable();
const uidList = z.array(z.string());

// ── Archives ────────────────────────────────────────────────────────────────

/** GET /api/archives. `archive_path` is redacted for non-admins (A: hardening), so optional. */
export const MountedArchiveSchema = looseObject({
  id: z.string(),
  label: z.string(),
  archive_path: z.string().optional(),
});
export const MountedArchiveListSchema = z.array(MountedArchiveSchema);

/** GET /api/archives/:id/info (I1, ADMIN): counts and sizes only. Exact fields per the R0 spec. */
export const ArchiveInfoSchema = looseObject({
  entry_count: z.number().optional(),
  artifact_count: z.number().optional(),
  blob_count: z.number().optional(),
  total_bytes: z.number().optional(),
});

// ── Entries ─────────────────────────────────────────────────────────────────

export const EntrySummarySchema = looseObject({
  entry_uid: z.string(),
  archived_at: z.string(),
  source_kind: z.string(),
  entity_kind: z.string(),
  title: nullableString,
  visibility: z.string(),
  original_url: nullableString,
  artifact_count: z.number(),
  total_artifact_bytes: z.number(),
  parent_entry_uid: nullableString,
  has_favicon: z.boolean(),
  cached_bytes: z.number(),
  child_count: z.number(),
  cacheable_bytes: z.number(),
});
export const EntrySummaryListSchema = z.array(EntrySummarySchema);

export const EntryArtifactSummarySchema = looseObject({
  artifact_role: z.string(),
  storage_area: z.string(),
  relpath: z.string(),
  byte_size: z.number().nullable(),
});

export const SummaryStatusSchema = z.string(); // "pending" | "completed" | "failed" (server-defined)

export const EntrySummaryRecordSchema = looseObject({
  summary_uid: z.string(),
  entry_uid: z.string(),
  provider_kind: z.string(),
  resolved_model: nullableString,
  provider_model: nullableString,
  prompt_version: z.string(),
  input_sha256: z.string(),
  status: SummaryStatusSchema,
  summary_text: nullableString,
  error_text: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: nullableString,
});

/** GET /api/archives/:id/entries/:uid */
export const EntryDetailSchema = looseObject({
  summary: EntrySummarySchema,
  structured_root_relpath: z.string(),
  source_metadata_json: z.string(),
  display_metadata_json: nullableString,
  artifacts: z.array(EntryArtifactSummarySchema),
  latest_summary: EntrySummaryRecordSchema.nullable(),
  summary_attempt: EntrySummaryRecordSchema.nullable(),
});

/** GET .../entries/:uid/summary. `attempt` is omitted for guests. */
export const EntrySummaryResponseSchema = looseObject({
  entry_uid: z.string(),
  summary: EntrySummaryRecordSchema.nullable(),
  attempt: EntrySummaryRecordSchema.nullable().optional(),
});

/** POST .../entries/:uid/summary: 200 (cached completed row) or 202 (pending row). */
export const RequestSummaryResponseSchema = EntrySummaryRecordSchema;

export const TranscriptionEngineSchema = looseObject({
  kind: z.string(),
  label: z.string(),
  english_only: z.boolean().optional(),
  languages: z.array(z.string()).optional(),
});
export const TranscriptionEngineListSchema = z.array(TranscriptionEngineSchema);

export const ThreadTitleResponseSchema = looseObject({ entry_uid: z.string(), title: z.string() });
export const TextTitleResponseSchema = looseObject({ title: z.string() });
export const MediaTokenResponseSchema = looseObject({ url: z.string(), expires_in_secs: z.number() });

// ── Tags ────────────────────────────────────────────────────────────────────

export const TagSchema = looseObject({
  tag_uid: z.string(),
  name: z.string(),
  slug: z.string(),
  full_path: z.string(),
});
export const TagListSchema = z.array(TagSchema);

export interface TagNode {
  tag: z.infer<typeof TagSchema>;
  entry_count: number;
  subtree_count: number;
  children: TagNode[];
  [key: string]: unknown;
}
export const TagNodeSchema: z.ZodType<TagNode> = z.lazy(() =>
  looseObject({
    tag: TagSchema,
    entry_count: z.number(),
    subtree_count: z.number(),
    children: z.array(TagNodeSchema),
  }),
);
export const TagTreeSchema = z.array(TagNodeSchema);

// ── Collections ─────────────────────────────────────────────────────────────

export const CollectionSummarySchema = looseObject({
  collection_uid: z.string(),
  name: z.string(),
  slug: z.string(),
  default_visibility_bits: z.number(),
  requires_auth: z.boolean(),
  created_at: z.string(),
});
export const CollectionListSchema = z.array(CollectionSummarySchema);

export const CollectionEntrySchema = looseObject({
  entry_uid: z.string(),
  title: nullableString,
  source_kind: z.string(),
  archived_at: z.string(),
  original_url: nullableString,
  collection_visibility_bits: z.number(),
});
export const CollectionDetailSchema = CollectionSummarySchema.extend({
  entries: z.array(CollectionEntrySchema),
});

export const EntryCollectionMembershipSchema = looseObject({
  collection_uid: z.string(),
  name: z.string(),
  visibility_bits: z.number(),
});
export const EntryCollectionMembershipListSchema = z.array(EntryCollectionMembershipSchema);

// ── Captures, jobs, runs, uploads ───────────────────────────────────────────

/** 202 from POST captures / captures/text / rearchive. */
export const CaptureAcceptedSchema = looseObject({ job_uid: z.string(), status: z.string() });

export const UploadResultSchema = looseObject({
  /** `file://` locator of the staged upload; the only `file:` locator capture accepts. */
  locator: z.string(),
  filename: z.string(),
  size: z.number(),
});

/** One produced item of a capture job (J2: from archive_run_items.produced_entry_id). */
export const CaptureJobItemSchema = looseObject({
  entry_uid: nullableString.optional(),
  status: z.string().optional(),
  locator: nullableString.optional(),
  title: nullableString.optional(),
  error_text: nullableString.optional(),
});

/** GET .../capture_jobs/:uid (J2 adds `entry_uids` and `items`; J1 adds `created_by`). */
export const CaptureJobSchema = looseObject({
  job_uid: z.string(),
  archive_id: z.string(),
  run_uid: nullableString,
  status: z.string(),
  error_text: nullableString,
  /** JSON string with progress/partial-playlist notes. */
  notes_json: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
  created_by: nullableString.optional(),
  entry_uids: uidList.optional(),
  items: z.array(CaptureJobItemSchema).optional(),
});
/** GET .../capture_jobs (J1). Row shape may omit `entry_uids`/`items`. */
export const CaptureJobListSchema = z.array(CaptureJobSchema);

export const RunSummarySchema = looseObject({
  run_uid: z.string(),
  started_at: z.string(),
  finished_at: nullableString,
  status: z.string(),
  requested_count: z.number(),
  discovered_count: z.number(),
  completed_count: z.number(),
  failed_count: z.number(),
  error_summary: nullableString,
});
export const RunSummaryListSchema = z.array(RunSummarySchema);

/** GET .../captures/probe */
export const ProbeResultSchema = looseObject({
  has_video: z.boolean(),
  has_audio: z.boolean().optional(),
  qualities: z.array(z.string()),
});

export const PlaylistItemProbeSchema = looseObject({
  id: z.string(),
  url: z.string(),
  title: nullableString,
  qualities: z.array(z.string()),
  has_audio: z.boolean(),
});
export const PlaylistProbeResultSchema = looseObject({
  playlist_id: z.string(),
  title: nullableString,
  uploader: nullableString,
  items: z.array(PlaylistItemProbeSchema),
});

export const CaptureOptionsSchema = looseObject({
  ublock_enabled: z.boolean(),
  cookie_ext_enabled: z.boolean(),
  modal_closer_enabled: z.boolean(),
  ublock_ext_available: z.boolean(),
  cookie_ext_available: z.boolean(),
  reader_mode: z.boolean(),
  via_freedium: z.boolean(),
  download_subtitles: z.boolean(),
  title_providers: z.array(looseObject({ kind: z.string(), label: z.string() })),
});

// ── Account ─────────────────────────────────────────────────────────────────

/** A role as returned inside `roles[]` of /api/auth/me (M1). Slugs or {slug,name} objects are both accepted. */
export const MeRoleSchema = z.union([
  z.string(),
  looseObject({ slug: z.string(), name: z.string().optional() }),
]);

/** GET /api/auth/me. `user_uid` and `roles` are additive (M1). */
export const MeSchema = looseObject({
  role_bits: z.number(),
  username: z.string(),
  display_name: nullableString,
  humanize_slugs: z.boolean(),
  can_reorder_children: z.boolean(),
  user_uid: z.string().optional(),
  roles: z.array(MeRoleSchema).optional(),
});

export const TokenScopeSchema = z.enum(["full", "read"]);

/** GET /api/auth/tokens (T2 adds expires_at, scope; last_used_at is now actually maintained). */
export const ApiTokenRecordSchema = looseObject({
  token_uid: z.string(),
  name: z.string(),
  created_at: z.string(),
  last_used_at: nullableString,
  expires_at: nullableString.optional(),
  scope: TokenScopeSchema.optional(),
});
export const ApiTokenListSchema = z.array(ApiTokenRecordSchema);

/** POST /api/auth/tokens (201). `raw_token` is shown once. */
export const TokenCreatedSchema = looseObject({
  token_uid: z.string(),
  raw_token: z.string(),
  name: z.string(),
  expires_at: nullableString.optional(),
  scope: TokenScopeSchema.optional(),
});

/** GET /api/auth/sessions (S1). `session_handle` is the first 16 hex of hash_token(session_uid); the session id itself is never returned. */
export const SessionRecordSchema = looseObject({
  session_handle: z.string(),
  created_at: z.string().optional(),
  last_seen_at: nullableString.optional(),
  expires_at: z.string().optional(),
  user_agent: nullableString.optional(),
  current: z.boolean().optional(),
});
export const SessionListSchema = z.array(SessionRecordSchema);

// ── Admin: users, roles, tokens ─────────────────────────────────────────────

export const UserSummarySchema = looseObject({
  user_uid: z.string(),
  username: z.string(),
  email: nullableString,
  status: z.string(),
  created_at: z.string(),
  role_slugs: z.array(z.string()),
  role_bits: z.number(),
});
export const UserSummaryListSchema = z.array(UserSummarySchema);

export const UserCreatedSchema = looseObject({ user_uid: z.string(), username: z.string() });

export const RoleRecordSchema = looseObject({
  role_uid: z.string(),
  slug: z.string(),
  name: z.string(),
  level: z.number(),
  bit_position: z.number(),
  is_builtin: z.boolean(),
});
export const RoleRecordListSchema = z.array(RoleRecordSchema);

/** GET /api/admin/users/:uid/tokens (U4). */
export const UserTokenListSchema = ApiTokenListSchema;

// ── Admin: settings, tooling, cookie rules, effective config ────────────────

const TitleModelInfoSchema = looseObject({
  model: z.string().nullable().optional(),
  source: z.string().optional(),
  fallback_model: z.string().nullable().optional(),
  fallback_source: z.string().optional(),
  env_var: z.string().optional(),
});

/** GET /api/admin/instance-settings */
export const InstanceSettingsSchema = looseObject({
  public_index_enabled: z.boolean(),
  public_entry_content_enabled: z.boolean(),
  open_registration_enabled: z.boolean(),
  default_entry_visibility: z.number(),
  ublock_enabled: z.boolean(),
  cookie_ext_enabled: z.boolean(),
  modal_closer_enabled: z.boolean(),
  reorder_children_role_bits: z.number(),
  title_model_anthropic_http: nullableString,
  title_model_openai_compatible: nullableString,
  title_model_claude_cli: nullableString,
  title_model_codex_cli: nullableString,
  ublock_ext_available: z.boolean().optional(),
  cookie_ext_available: z.boolean().optional(),
  title_models: z.record(z.string(), TitleModelInfoSchema).optional(),
});

const ToolCandidateSchema = looseObject({
  role: z.string(),
  label: z.string(),
  path: nullableString,
  version: nullableString,
  chosen: z.boolean(),
  invalid: nullableString,
});
const ChosenToolSchema = looseObject({
  role: nullableString,
  kind: nullableString.optional(),
  path: nullableString,
  version: nullableString,
});

/** GET /api/admin/yt-dlp. Contains filesystem paths: admin-only, passed through as the server sends it. */
export const YtDlpStatusSchema = looseObject({
  yt_dlp: z.array(ToolCandidateSchema),
  yt_dlp_chosen: ChosenToolSchema,
  js_runtime: z.array(ToolCandidateSchema),
  js_runtime_chosen: ChosenToolSchema.nullable(),
  state_dir: nullableString,
  yt_dlp_target: nullableString,
  yt_dlp_installed: z.boolean(),
  deno_target: nullableString,
  deno_installed: z.boolean(),
  update_running: z.boolean().optional(),
  js_runtime_in_use: looseObject({ kind: z.string(), path: nullableString }).nullable().optional(),
});

const ComponentOutcomeSchema = looseObject({ ok: z.boolean(), message: z.string() });
/** POST /api/admin/yt-dlp/update (can take minutes). */
export const YtDlpUpdateResultSchema = looseObject({
  yt_dlp: ComponentOutcomeSchema,
  deno: ComponentOutcomeSchema,
  status: YtDlpStatusSchema,
});

/** GET /api/admin/cookie-rules. `cookies_json` holds secrets: the MCP never returns its values. */
export const CookieRuleSchema = looseObject({
  rule_uid: z.string(),
  url_pattern: nullableString,
  pattern_kind: z.string(),
  cookies_json: z.string(),
  ordinal: z.number(),
  created_at: z.string(),
});
export const CookieRuleListSchema = z.array(CookieRuleSchema);

/** One row of GET /api/admin/effective-config (I2). Secrets expose only `set`. Exact fields per the R0 spec. */
export const EffectiveConfigVarSchema = looseObject({
  name: z.string(),
  group: z.string().optional(),
  description: z.string().optional(),
  secret: z.boolean().optional(),
  default: nullableString.optional(),
  set: z.boolean().optional(),
  value: nullableString.optional(),
});
export const EffectiveConfigSchema = looseObject({
  vars: z.array(EffectiveConfigVarSchema).optional(),
});

// ── Maintenance ─────────────────────────────────────────────────────────────

export const BlobCleanupScanSchema = looseObject({
  orphaned_blob_rows: z.number(),
  deletable_files: z.number(),
  total_bytes: z.number(),
});
export const BlobCleanupResultSchema = looseObject({
  deleted_blob_rows: z.number(),
  deleted_files: z.number(),
  freed_bytes: z.number(),
  errors: z.array(z.string()),
});

// ── Error body ──────────────────────────────────────────────────────────────

export const ApiErrorBodySchema = looseObject({ error: z.string() });

// ── Inferred types ──────────────────────────────────────────────────────────

export type MountedArchive = z.infer<typeof MountedArchiveSchema>;
export type EntrySummary = z.infer<typeof EntrySummarySchema>;
export type EntryDetail = z.infer<typeof EntryDetailSchema>;
export type EntrySummaryRecord = z.infer<typeof EntrySummaryRecordSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type CollectionSummary = z.infer<typeof CollectionSummarySchema>;
export type CollectionDetail = z.infer<typeof CollectionDetailSchema>;
export type CaptureJob = z.infer<typeof CaptureJobSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type MeResponse = z.infer<typeof MeSchema>;
export type ApiTokenRecord = z.infer<typeof ApiTokenRecordSchema>;
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
export type UserSummary = z.infer<typeof UserSummarySchema>;
export type RoleRecord = z.infer<typeof RoleRecordSchema>;
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;
export type CookieRule = z.infer<typeof CookieRuleSchema>;
