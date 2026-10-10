# archivr-mcp

An MCP server (stdio transport) that lets an MCP client such as Claude Code or Claude Desktop browse, capture, organise and administer an [Archivr](../archivr) instance through its REST API. Written in TypeScript for Bun. It keeps no state of its own: each tool call is a request to the Archivr server, which is the sole authority on what a token may do.

Contributing? See the [contributor guide](CONTRIBUTING.md) and its ecosystem change checklist.

## Requirements

- Bun 1.1.0 or newer.
- A running archivr-server that the MCP host can reach over HTTP or HTTPS.
- An API token from that server. Create the API token in the Archivr web UI (Settings, API tokens).
- For the admin, credential and job tools, the Archivr server must include the management API merged in archivr PR #40 (commit `3b748fb` on `master`) or later. Those tools fail against an older server build.

## Install and run

```sh
bun install
ARCHIVR_URL=http://127.0.0.1:8080 ARCHIVR_TOKEN=... bun run start
```

`bun run start` runs `bun src/index.ts`. `bun run dev` restarts on change. The server speaks MCP over stdin and stdout, so it is normally started by an MCP client rather than run by hand. stdout carries the protocol and all logs go to stderr.

At startup the server calls `/me` with the token. A 401 is fatal: the process exits and asks you to create a new token. Any other startup failure is not fatal, and the tools are still registered, so the error appears on the first call.

## Connect a client

Claude Code, in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "archivr": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/archivr-mcp/src/index.ts"],
      "env": {
        "ARCHIVR_URL": "http://127.0.0.1:8080",
        "ARCHIVR_TOKEN": "paste-an-archivr-api-token-here",
        "ARCHIVR_MCP_TOOLSETS": "core,capture,organize,account,admin",
        "ARCHIVR_MCP_READONLY": "false"
      }
    }
  }
}
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "archivr": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/archivr-mcp/src/index.ts"],
      "env": {
        "ARCHIVR_URL": "http://127.0.0.1:8080",
        "ARCHIVR_TOKEN": "paste-an-archivr-api-token-here"
      }
    }
  }
}
```

If Claude Desktop cannot find `bun` on its PATH, use the absolute path to the bun binary in `command`. `.mcp.json.example` in this repo has the same shape with every variable listed. Keep the real token out of version control.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHIVR_URL` | required | Base URL of the Archivr server. http or https only, no user:password, trailing slash removed |
| `ARCHIVR_TOKEN` | required | Bearer API token. Redacted from all output and logs |
| `ARCHIVR_ARCHIVE` | none | Default archive id for tools that take an archive. Optional when only one archive is mounted |
| `ARCHIVR_MCP_TOOLSETS` | `core,capture,organize,account,admin` | Comma list of toolsets to register. Add `credentials` to opt in |
| `ARCHIVR_MCP_READONLY` | `false` | Register only tools marked read-only. Accepts 1/0, true/false, yes/no, on/off |
| `ARCHIVR_MCP_MAX_OUTPUT_CHARS` | `40000` | Cap on the text returned from one tool call. Longer output is truncated |
| `ARCHIVR_MCP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout to the Archivr server |
| `ARCHIVR_MCP_UPLOAD_ROOTS` | none | Path-delimiter-separated directories that `capture_file` may read. `~` is expanded. Empty disables uploads |
| `ARCHIVR_MCP_MAX_UPLOAD_BYTES` | `2147483648` (2 GiB) | Largest file `capture_file` will upload, in bytes. Positive integer. Archivr itself accepts up to 10 GiB per upload |
| `ARCHIVR_MCP_DOWNLOAD_DIR` | `$TMPDIR/archivr-mcp-downloads` | Directory `download_artifact` writes into |
| `ARCHIVR_MCP_LOG` | `warn` | `off`, `error`, `warn`, `info` or `debug`. Stderr only |

## Toolsets and roles

The tools are grouped into six toolsets: `core` (read and manage entries), `capture` (archive URLs, text and files, and track jobs), `organize` (tags and collections), `account` (your own profile, tokens and sessions), `admin` (instance and user administration) and `credentials` (tools that handle secrets; off by default).

Each tool has a minimum role: guest, user, admin or owner. At startup the server reads the token's roles from `/me` and registers only the tools that role can use. The Role column in the catalogue below is that minimum. Custom roles (bit 16 and up) do not grant tool visibility. They affect only collection visibility and the reorder mask.

Hiding a tool is a convenience, not a security boundary. Every request is checked again by the Archivr server, which refuses calls the token is not allowed to make.

Two further restrictions apply:

- `ARCHIVR_MCP_READONLY=true` registers only tools marked read-only.
- A read-scope token can make only GET requests. Any other request gets 403 `read-only token`, so a read-scope token cannot write even if a write tool is registered. Some tools that look like reads use POST (`probe_playlist`, `generate_text_title`) and also fail with 403 under a read-scope token.

## Tool catalogue

There are 67 tools in total. 61 are registered by default and the 6 `credentials` tools are opt-in.

Columns: **Role** is the minimum role for the tool to be shown. The server still enforces it. **Class** is `read`, `write` or `destructive`. `open-world` means the tool makes outbound requests to arbitrary URLs or to a configured LLM provider. Destructive tools require a literal `confirm: true` argument and refuse the call without it.

### Core (12 tools, default on)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `whoami` | guest | read | Show the authenticated user, roles, default archive, and active toolsets and read-only mode. |
| `list_archives` | guest | read | List the archives mounted on the server (id and label). |
| `capture_options` | user | read | Show capture defaults and which helpers are available (ad-blocker, cookie-banner and modal-closer settings, browser extensions). |
| `list_entries` | user | read | List archived root entries as compact rows, newest first. |
| `search_entries` | user | read | Search entries with free text and prefix filters (`source:`, `type:`, `url:`, `title:`, `after:`, `before:`, `tag:`). |
| `get_entry` | user | read | Get one entry; `include` adds tags, collections, summary, metadata or artifacts. |
| `list_entry_children` | user | read | List a container entry's direct children (playlist videos, thread posts) in display order, paged. |
| `rename_entry` | user | write | Set an entry's title. |
| `reorder_children` | user | write | Set the display order of a parent entry's direct children. |
| `delete_entry` | user | destructive | Permanently delete an entry with its child entries and its tag and collection links. |
| `get_artifact` | user | read | Read an archived file by `entry_uid` and `artifact_index` (or blob sha256), with HTTP Range support. |
| `download_artifact` | user | write | Stream an archived file into `ARCHIVR_MCP_DOWNLOAD_DIR` (no size limit). |

### Capture (14 tools, default on)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `capture_url` | user | write, open-world | Archive a URL (web pages, tweets, YouTube, Reddit, Instagram, TikTok and more). |
| `capture_text` | user | write | Archive text as a new entry with the given title (max 2 MiB). |
| `capture_file` | user | write | Upload a file from the directories in `ARCHIVR_MCP_UPLOAD_ROOTS` and archive it. |
| `probe_url` | user | read, open-world | Run yt-dlp against a URL to list the video qualities before capturing. |
| `probe_playlist` | user | read, open-world | List the items of a YouTube playlist or channel, YouTube Music playlist, or Spotify album or playlist. |
| `generate_text_title` | user | read, open-world | Ask a server-configured LLM to suggest a title for a text body (max 2 MiB). |
| `rearchive_entry` | user | destructive, open-world | Re-fetch a tweet or tweet thread and replace the entry's archived artifacts on success; if the scrape fails the existing data is kept. |
| `list_capture_jobs` | user | read | List capture jobs in an archive, newest first, optionally filtered by status. |
| `get_capture_job` | user | read | Get one capture job: status, error, produced entries and per-item outcomes (items capped at 200). |
| `list_runs` | user | read | List capture runs (one per capture, including each playlist item), newest first. |
| `get_summary` | user | read | Read the latest completed summary of an entry and the latest generation attempt. |
| `summarize_entry` | user | write, open-world | Generate an LLM summary of an entry with a server-configured provider. |
| `generate_thread_title` | user | write, open-world | Name an X (Twitter) thread entry with an LLM and save it as the entry title (overwrites the current title). |
| `list_transcription_engines` | user | read | List the local speech-to-text engines enabled on the server. |

### Organize (14 tools, default on)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `list_tags` | user | read | List the archive's tag tree. |
| `create_tag` | user | write | Create a tag and any missing ancestors without attaching it to an entry. |
| `update_tag` | user | write | Rename a tag and/or move it, with its subtree, under a different parent. |
| `tag_entry` | user | write | Attach a tag to an entry, creating the tag path if needed. |
| `untag_entry` | user | write | Detach a tag from one entry. |
| `delete_tag` | user | destructive | Permanently delete a tag and all its descendant tags, detaching them from every entry. |
| `list_collections` | user | read | List the archive's collections with their default visibility and auth settings. |
| `get_collection` | user | read | Show one collection and a page of its entries. |
| `create_collection` | user | write | Create a collection. |
| `update_collection` | user | write | Change a collection's name, default visibility bits and/or `requires_auth`. |
| `add_to_collection` | user | write | Add an entry to a collection with per-entry visibility bits (no change if already a member). |
| `remove_from_collection` | user | write | Remove an entry from a collection. |
| `set_entry_visibility` | user | write | Change the visibility bits of an entry already in a collection. A non-admin cannot hide an entry from all of their own roles. |
| `delete_collection` | user | destructive | Permanently delete a collection and its memberships. |

### Account (5 tools, default on)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `list_my_credentials` | user | read | List your own API tokens (`what=tokens`) or browser sessions (`what=sessions`); never returns secrets. |
| `update_profile` | user | write | Update your display name and/or the humanize-slugs preference. |
| `revoke_token` | user | destructive | Revoke one of your API tokens by `token_uid`. |
| `revoke_session` | user | destructive | Sign out one of your browser sessions by `session_handle`. |
| `revoke_other_sessions` | user | destructive | Sign out all of your browser sessions except the current one. |

### Admin (16 tools, default on)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `admin_list` | admin | read | List users or roles (`what=users` or `what=roles`), or another user's API tokens (`what=user_tokens`). |
| `set_user_status` | admin | write | Set a user to `active` or `disabled` (you cannot disable yourself or the last owner). |
| `assign_role` | admin | write | Assign a role by slug (granting `owner` or `admin` needs the owner role). |
| `remove_role` | admin | destructive | Remove a role from a user (removing `owner` or `admin` needs the owner role). |
| `delete_user` | admin | destructive | Permanently delete a user account with their sessions, tokens and role assignments. |
| `revoke_user_sessions` | admin | destructive | Delete all login sessions of a user (API tokens are not affected). |
| `revoke_user_token` | admin | destructive | Revoke one API token of another user by `token_uid`. |
| `create_role` | admin | write | Create a custom role with a slug and display name. Custom roles carry no built-in privileges. |
| `rename_role` | admin | write | Change a custom role's display name (built-in roles cannot be renamed). |
| `delete_role` | owner | destructive | Permanently delete a custom role; holders are signed out and built-in roles are refused. |
| `server_info` | admin | read | Read-only server view: `instance_settings`, `effective_config`, `ytdlp`, `cookie_rules`, `archive_info`. |
| `update_instance_settings` | admin | write | Partially update instance settings. Some fields are inert (see Known limitations). |
| `update_ytdlp` | admin | write, open-world | Download and install the latest yt-dlp and deno on the server (can take minutes). |
| `delete_cookie_rule` | admin | destructive | Permanently delete a download cookie rule by `rule_uid`. |
| `blob_cleanup_scan` | admin | read | Dry run: count orphaned blobs and the bytes a cleanup would free. Changes nothing. |
| `blob_cleanup_run` | admin | destructive | Permanently delete orphaned blobs to free disk space (run the scan first). |

### Credentials (6 tools, opt-in: add `credentials` to `ARCHIVR_MCP_TOOLSETS`)

| Tool | Role | Class | Description |
| --- | --- | --- | --- |
| `create_api_token` | user | write | Create an API token; the raw value is returned once and enters the model context (default scope `full`). |
| `change_password` | user | write | Change your own password (needs the current one; other login sessions are signed out). |
| `create_user` | admin | write | Create a user with an initial password (the user has no roles until assigned). |
| `reset_user_password` | admin | write | Set another user's password; signs them out everywhere, optionally revoking their tokens. |
| `create_cookie_rule` | admin | write | Add a download cookie rule; cookie values are stored server-side and never echoed back. |
| `update_cookie_rule` | admin | write | Change a cookie rule; passing `cookies` replaces the whole cookie set. |

## Resources

Resources are read-only views that clients can load directly:

| URI | Contents |
| --- | --- |
| `archivr://me` | The authenticated user, roles and default archive |
| `archivr://archives` | The archives mounted on the server |
| `archivr://archives/{id}/tags` | The archive's tag tree |
| `archivr://archives/{id}/collections` | The archive's collections |
| `archivr://archives/{id}/entries/{uid}` | One entry, prefixed with the untrusted-content notice |
| `archivr://settings/instance` | Instance settings. Admin only |

## Async behaviour

Captures, summaries, re-archives and some admin operations run as server jobs. By default (`wait` is true) a tool polls the job until it finishes. The poll interval starts at 1 second, grows by 1.5x and is capped at 5 seconds.

Wait limits:

- Captures (`capture_url`, `capture_text`, `capture_file`, `rearchive_entry`): 120 seconds by default.
- Summaries (`summarize_entry`): 300 seconds.
- Any `wait_timeout_s` value: at most 900 seconds.
- Other operations: title generation and URL probes 3 minutes, upload 15 minutes, blob scan 2 minutes, blob cleanup 10 minutes, yt-dlp update 10 minutes.

When a wait runs out, the tool returns `{"status": "running", "job_uid": ...}`. That is not an error. The job keeps running on the server. Check it with `get_capture_job` or `list_capture_jobs`. Cancelling the MCP request stops only the polling, not the job. Pass `wait: false` to get the job back without waiting.

## Uploads and downloads

**Uploads (`capture_file`).** A file is accepted only if its real path (symlinks resolved) is inside one of the `ARCHIVR_MCP_UPLOAD_ROOTS` directories. Otherwise the call is refused. The file must be a regular file of at most `ARCHIVR_MCP_MAX_UPLOAD_BYTES` (default 2 GiB). These are refused by name, even inside a root:

- Directories: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.password-store`, `.config/gcloud`.
- Files: `.env*`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, SSH private keys (`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519` and their `.pub` files), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.kdbx`, `credentials` and `credentials.json`, `secret`/`secrets` files with `.json`, `.yaml` or `.toml`, and `creds.txt`.

The file is streamed from disk as a hand-built multipart body in 1 MiB chunks, so memory use does not grow with the file size (Bun's own `FormData` support would buffer the whole file). The request carries an exact `Content-Length`, and only the file's basename is sent as its filename, never the local path. The upload shares one 15-minute request timeout with the server's response, so very large files need a link that sustains roughly 2.5 MB/s or more for 2 GiB. If the file changes size while it is read, the upload fails.

A staged upload is deleted if the capture fails.

`capture_url` refuses `file:` locators. The Archivr server also refuses any `file://` locator that is not a staged upload, and any bare path locator, so local files can only reach an archive through `capture_file`.

**Downloads (`download_artifact`).** The file is written into `ARCHIVR_MCP_DOWNLOAD_DIR`. The name is reduced to a safe basename, and `dest_dir` must stay inside the download directory. The file is created exclusively, so an existing name gets a `-N` suffix unless `overwrite: true` is given. Files are created with mode 0600. There is no size limit.

**Reads (`get_artifact`).** Returns up to 64 KiB by default and at most 1 MiB per call, using HTTP Range. Images up to 1 MiB come back as images. Other binary content returns only its type and size. Use `download_artifact` for the whole file.

## Security model

- **Authority is the server.** Roles, ownership and last-owner protection are enforced by archivr-server on every request. Hiding tools and read-only mode only reduce what a client sees.
- **Tokens.** The bearer token is sent only to `ARCHIVR_URL`. Redirects are refused with an "unexpected redirect" error, so the token is not forwarded elsewhere.
- **Redaction.** The token, including escaped variants, is removed from every returned string and log line. `Bearer` values are replaced, and sensitive keys in JSON output are scrubbed.
- **Logging.** Log lines are fixed messages written to stderr. Stdout is never used for logs.
- **Destructive operations.** The 14 destructive tools require `confirm: true`.
- **Secrets in model context.** The `credentials` toolset is off by default for this reason. `create_api_token` returns the raw token once, and that value enters the model's context and transcript. `change_password`, `create_user`, `reset_user_password`, `create_cookie_rule` and `update_cookie_rule` also pass passwords or cookie values through the model's context. Cookie values are never echoed back by the server.
- **Untrusted archived content.** Archived pages, posts and text can contain instructions aimed at the model. Archived content is prefixed with an untrusted-content notice.
- **Output limits.** List tools return 25 rows by default and at most 100. Text output is capped at `ARCHIVR_MCP_MAX_OUTPUT_CHARS`.

## Known limitations

- `update_instance_settings` accepts `public_index_enabled`, `public_entry_content_enabled` and `open_registration_enabled`. Its own description marks them as having no effect at present. `reorder_children_role_bits` can be changed only by the owner.
- Cancelling a tool call stops only the local polling. The server job keeps running.
- Read-only mode is a registration filter in this server. The read-scope token rule on the Archivr side is what stops writes made with a read-scope token.
- Admin, credential and job tools need an Archivr server that includes PR #40 (see Requirements).
- The only transport is stdio. There is no HTTP transport.

## Development

```sh
bun test               # unit tests (mocked fetch, in-memory transport); e2e suites skip themselves
bun run test:e2e       # end-to-end tests against a built archivr-server (see test/e2e/README.md)
bun run typecheck      # tsc --noEmit
```

Source layout: `src/index.ts` (startup), `src/server.ts` (tool and resource registration), `src/config.ts`, `src/client/` (HTTP, errors, polling, schemas), `src/lib/` (files, HTML, logging, output, redaction, roles), `src/resources/`, `src/tools/` (one module per toolset) and `src/transport/stdio.ts`. Tests are in `test/unit`, `test/helpers` and `test/e2e`. The REST contract the tools are built against is in `docs/api-contract.md`.

## Troubleshooting

- **Exits at startup asking for a new token.** The server rejected the token as invalid, expired or revoked. Create a new API token in the Archivr web UI and update `ARCHIVR_TOKEN`.
- **503 `setup_required`.** The Archivr instance has not been set up yet. Finish setup in the web UI first.
- **403 `read-only token`.** The token has read scope, and the call is not a GET. Use a full-scope token for writes.
- **403 Forbidden on a tool.** The token's role is too low for that operation. Check the role in `whoami`.
- **404 from admin, credential or job tools.** The server is probably an older build without the PR #40 routes.
- **Tool missing from the client.** Check `ARCHIVR_MCP_TOOLSETS` (`credentials` is opt-in), the token's role, and `ARCHIVR_MCP_READONLY`. Set `ARCHIVR_MCP_LOG=info` and read stderr.
- **`capture_file` refused.** The path is outside `ARCHIVR_MCP_UPLOAD_ROOTS`, the name is on the denylist, or the file is not a regular file within `ARCHIVR_MCP_MAX_UPLOAD_BYTES`. Uploads are disabled when the variable is empty.
- **429.** The server is rate limiting. Wait a moment and retry.
- **502 from `probe_url`.** The probe was inconclusive. The URL may not be supported by yt-dlp.
- **A timeout error.** The operation may still be running on the server. Check it with `get_capture_job` or `list_capture_jobs` before retrying, so the same capture is not submitted twice.
