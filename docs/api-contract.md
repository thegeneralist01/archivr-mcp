> **Status: Contract.** The authoritative copy is `archivr/docs/superpowers/specs/2026-10-08-mcp-api-extensions.md`
> (status "Contract", exact JSON field names, status codes and limits). This file is the working copy the MCP tool
> modules are built against. Where the two disagree, the archivr spec wins; update `src/client/schemas.ts` to match it.
>
> Response shapes the client must parse, as implemented in archivr PR #40 (merged as `3b748fb`).
> Where the implementation differs from the spec, the client parses these shapes:
>
> - `DELETE /api/admin/roles/:slug` returns 200 with a body `{"slug","users_affected","reorder_mask_cleared"}`, not an empty body.
> - Effective config is flat: `env_vars`, `summary_providers`, `title_models`, `transcription_engines`, `extensions`, `server`.
> - Archive info (`GET /api/archives/:id/info`) also returns `name`, `child_entry_count` and `db_bytes`, beyond the fields listed in the archivr spec.
> - Read-scope requests that are not GET, HEAD or OPTIONS get 403 with the body text `read-only token`.

# Archivr API extensions (the contract)

Errors `{"error": msg}`; 401 unauth, 403 role/ownership, 404 missing, 409 state conflict, 400 validation.

**Shared guards** (new `archivr-server/src/guards.rs`):
- `ensure_can_manage`: OWNER bit required if target has OWNER **or ADMIN** (strict rule).
- `ensure_not_self`.
- `ensure_not_last_owner`: counts *active* owners.

| # | Endpoint | Role | Notes |
|---|---|---|---|
| U1 | `DELETE /api/admin/users/:uid` | ADMIN + guards | tx: NULL `user_roles.assigned_by_user_id` first (FK has no ON DELETE), then delete; rest cascades |
| U2 | `POST /api/admin/users/:uid/password` `{new_password>=8, revoke_tokens?}` | ADMIN + guards | always invalidates sessions |
| U3 | `DELETE /api/admin/users/:uid/sessions` | ADMIN + guards | |
| U4/U5 | `GET /api/admin/users/:uid/tokens`, `DELETE …/tokens/:token_uid` | ADMIN + guards | |
| R1 | `PATCH /api/admin/roles/:slug` `{name}` | ADMIN | custom roles only; slug immutable |
| R2 | `DELETE /api/admin/roles/:slug` | OWNER | tx: delete `user_roles`, invalidate holders' sessions, clear bit from `reorder_children_role_bits` |
| S1-S3 | `GET /api/auth/sessions`, `DELETE …/sessions/:handle`, `DELETE …/sessions` | own | `session_handle` = first 16 hex of `hash_token(session_uid)`. **`session_uid` is the cookie value and is never returned** |
| T1/T2 | extend `POST/GET /api/auth/tokens` | own | adds `expires_in_days`, `scope: full\|read`; returns `expires_at`, `last_used_at`, `scope` |
| M1 | `GET /api/auth/me` | any | additive: `user_uid`, `roles[]` |
| J1 | `GET /api/archives/:id/capture_jobs?status&limit&offset&created_by` | USER | own jobs only; ADMIN all; NULL-owner rows admin-only |
| J2 | extend `GET …/capture_jobs/:uid` | USER | adds `entry_uids`, `items[]` (from `archive_run_items.produced_entry_id`); non-owner non-admin gets 404 |
| J3 | `GET …/runs` | auth | **filter by access**: visible if admin, or caller created the job, or caller can see ≥1 produced entry (reuse the existing entry-visibility/collection filter). Pre-migration runs follow entry access |
| I1 | `GET /api/archives/:id/info` | ADMIN | counts and sizes only, no filesystem paths |
| I2 | `GET /api/admin/effective-config` | ADMIN | new `effective_config.rs` with static `ENV_VARS` table (name, group, description, secret, default). Secrets show `set` only; URLs lose userinfo/query. Reuses `thread_title::resolve_title_model`, `summarizer::provider_from_env`. Drift unit test greps `ARCHIVR_*` literals across crates |

**Hardening of existing endpoints** (found during design):
- `PATCH …/users/:uid/status`: guards; cannot disable self or last owner.
- `POST/DELETE …/users/:uid/roles`: granting `owner` or `admin` needs OWNER; unknown slug → 404 (currently 500); last-owner removal → 409 (currently 500).
- `capture_handler` accepts any `file://` locator, so a USER can capture `/etc/passwd` and read it back. Fix: `file://` allowed only for staged uploads (400 otherwise). CLI unaffected.
- Bearer auth never calls `touch_token`, so `last_used_at` is always NULL. Call it, throttled to 60 s.
- `patch_me`: enforce min password length 8, invalidate other sessions.
- `GET /api/archives` is unauthenticated and returns `archive_path`. Redact it for non-admins (check the frontend doesn't depend on it).
- **Read-scope tokens**: `api_tokens.scope` column + `token_scope.rs` middleware, so Bearer requests from `read` tokens get 403 on non-GET/HEAD.

**Migrations** follow the existing convention (no version table): `let _ = ALTER TABLE … ADD COLUMN` inside `initialize_schema` / `initialize_auth_schema`.
- `capture_jobs.created_by TEXT` (auth `user_uid`, plus index).
- `api_tokens.scope TEXT NOT NULL DEFAULT 'full'`.
- Add a migration test per column (legacy table, init twice).

**Not proposed (YAGNI):** entry metadata edit beyond title (`visibility` column is vestigial; real visibility is collection membership), job cancel, server-side entry pagination, frontend/UI updates, admin edit of email/display name.

**Tests** (follow the `oneshot` style in `routes.rs` `mod tests`; new helpers in `test_support.rs`): for every endpoint test guest 401, USER 403, ADMIN OK, ADMIN-vs-OWNER and ADMIN-vs-ADMIN 403, self 409, last-owner 409. Plus regressions: user delete after assigning roles, `session_uid` never in a response, secret canary absent from effective-config, back-dated `expires_at` → 401, read-scope token 403 on POST, job and run scoping, `file:///etc/hosts` → 400.
