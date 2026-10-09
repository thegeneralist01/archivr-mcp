# AGENTS.md: archivr-mcp

MCP server (stdio) that manages an [Archivr](../archivr) instance over its REST API. Bun + TypeScript (strict), `@modelcontextprotocol/sdk` 1.32.1 (pinned), `zod` 4. It is a thin client: **the Archivr server is the only authority** for roles, visibility and validation. Hiding a tool is a convenience, never a security boundary.

## Commands

```sh
bun install
bun test                 # unit tests (mocked fetch, InMemoryTransport); e2e suites skip themselves
bun run typecheck        # tsc --noEmit
bun run test:e2e         # real archivr-server + real stdio MCP (needs the built binaries, see below)
bun run start            # needs ARCHIVR_URL and ARCHIVR_TOKEN
```

E2E needs `ARCHIVR_SERVER_BIN` and `ARCHIVR_CLI_BIN`, pointing at an `archivr-server` and `archivr` built from the `mcp-api-extensions` branch of the Archivr repo (`cargo build -p archivr-server -p archivr-cli`). `bun run test:e2e` fails fast if either is unset. Rebuild after any Archivr server change, or e2e tests the old server.

## Layout

- `src/index.ts` startup; `src/server.ts` `createServer(config, client)` (transport-agnostic); `src/transport/stdio.ts` is the only file that imports the stdio transport.
- `src/config.ts` zod-validated env (`ARCHIVR_URL`, `ARCHIVR_TOKEN`, `ARCHIVR_ARCHIVE`, `ARCHIVR_MCP_*`, including `ARCHIVR_MCP_MAX_UPLOAD_BYTES`, default 2 GiB, the `capture_file` size cap). Errors name variables, never values.
- `src/client/` `ArchivrClient` (injectable `fetch`, timeouts, Bearer auth), `errors.ts` (status → tool error mapping), `polling.ts` (`pollUntil`), `schemas.ts` (zod shapes of REST responses).
- `src/tools/` one module per group, each exporting a `() => ToolDef[]`, composed in `index.ts`. `registry.ts` has `defineTool`, filtering, redaction and truncation; `context.ts` has `ToolContext`.
- `src/lib/` `files.ts` (upload/download path safety), `multipart.ts` (streaming multipart upload body), `html.ts`, `output.ts`, `redact.ts`, `roles.ts` (GUEST=1 USER=2 ADMIN=4 OWNER=8), `log.ts`.
- `src/resources/index.ts` MCP resources (tools stay primary).
- `docs/api-contract.md` REST contract summary. The authoritative spec is `docs/superpowers/specs/2026-10-08-mcp-api-extensions.md` in the Archivr repo.

## Adding or changing a tool

1. Put it in the module for its group; choose `toolset` (`core | capture | organize | account | admin | credentials`) and `minRole`.
2. Use `defineTool`; always pass an `input` shape (even `{}`). Annotations: `READ`, `WRITE`, `DESTRUCTIVE`, `openWorld(...)`. A destructive tool must include `...confirmInput` (`confirm: z.literal(true)`).
3. Wrap every id/uid/slug in `seg()` when building a path. Never concatenate raw input into a URL.
4. Return `jsonResult(...)`. List tools use `paginationInput` and `paginate` (default 25, max 100). Archived content goes through `untrustedText(...)`.
5. Add the response schema to `src/client/schemas.ts` if it is new. Rust `Option<T>` fields are `.nullable()`; fields older servers lack are `.optional()`.
6. Add unit tests (`MockApi` + `directContext`/`callTool` for handlers, `connectInMemory` for visibility, confirm and redaction), and an e2e scenario if the tool crosses a role boundary.
7. Update the tool tables in `README.md`. They are hand-maintained and must match the code.

## Invariants (do not break)

- **No secrets out.** Never log or echo request bodies, headers, query strings, the token, passwords or cookie values. `redact.ts` strips the configured token and values of password/token/cookie-like args from every outgoing string. Tools that take or return secrets live in the opt-in `credentials` toolset.
- **Stdout is the protocol.** Log to stderr only, via `lib/log.ts`.
- **Cookie rule values are never returned**, only key names and value lengths.
- **Uploads:** `capture_file` goes through `resolveUploadFile` (realpath, allowed roots, denylist, size cap). `capture_url` rejects `file:` locators. The server separately refuses non-staged `file://` and bare-path locators.
- **Downloads** stay inside `ARCHIVR_MCP_DOWNLOAD_DIR`; reject traversal and symlink escapes.
- **Async work:** `wait` timeouts return a non-error `{status:"running", job_uid}`. Abort stops polling only; the server job continues, and the result says so.
- **Read-only mode** registers only `readOnlyHint` tools. The server-enforced guarantee needs a `scope: read` token.

## Quirks worth knowing

- SDK `registerTool` calls the handler as `(extra)` instead of `(args, extra)` when `inputSchema` is undefined, hence the rule above.
- Bun buffers `FormData` file parts (a 200 MB `Bun.file()` grew RSS by about 425 MB), so `capture_file` does not use `FormData`. `lib/multipart.ts` builds the multipart envelope by hand and streams the file in 1 MiB pull-based chunks through `ArchivrClient`'s `body: {stream, contentType, contentLength}` option (RSS growth for a 300 MB upload is about 50 MB, independent of file size). With an explicit `Content-Length` Bun sends an identity body, without it chunked; `duplex: "half"` is passed for spec-compliant fetches. A stream body can be read once, so such requests are never retried. The wire filename is the basename only, with `"`, CR and LF percent-encoded. The cap is `ARCHIVR_MCP_MAX_UPLOAD_BYTES` (default 2 GiB).
- `search_entries` `tag` filters on the full path (`/dev/rust`); the tool adds the leading slash.
- Archivr's login rate limit is 5 per IP per 15 min. The e2e harness sends a unique `X-Forwarded-For` per login (trusted from loopback).
- Poll timing is injected in tests through the `pollHooks` export in `src/tools/jobs.ts` (`ToolContext` has no sleep hook).
- `GET /api/archives` only returns `archive_path` to admins; the MCP never forwards it.

## Out of scope by decision

Archive creation, the TOML registry and env vars are Nix-managed in Archivr. Env-derived config is read-only through `server_info effective_config`. There is no job-cancel tool: the server cannot abort a running capture. `public_index_enabled`, `public_entry_content_enabled` and `open_registration_enabled` are stored but inert in Archivr today; tool descriptions say so.
