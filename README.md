# archivr-mcp

MCP server (stdio) that manages an [Archivr](../archivr) instance through its REST API. Written in
TypeScript for Bun. The full README (tool catalog, security model, setup) arrives with milestone M5.

## Quick start

```sh
bun install
ARCHIVR_URL=http://127.0.0.1:8080 ARCHIVR_TOKEN=... bun run start
```

Create the API token in the Archivr web UI (Settings, API tokens). See `.mcp.json.example` for a
Claude Code configuration.

## Configuration (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCHIVR_URL` | required | Base URL of the Archivr server |
| `ARCHIVR_TOKEN` | required | Bearer API token (never printed or logged) |
| `ARCHIVR_ARCHIVE` | auto | Default archive id; auto-selected when only one is mounted |
| `ARCHIVR_MCP_TOOLSETS` | `core,capture,organize,account,admin` | Comma list; add `credentials` to opt in to secret-handling tools |
| `ARCHIVR_MCP_READONLY` | `false` | Register only read-only tools |
| `ARCHIVR_MCP_MAX_OUTPUT_CHARS` | `40000` | Cap on text returned per tool call |
| `ARCHIVR_MCP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout |
| `ARCHIVR_MCP_UPLOAD_ROOTS` | none | Directories `capture_file` may read (path-delimiter separated); empty disables uploads |
| `ARCHIVR_MCP_DOWNLOAD_DIR` | `$TMPDIR/archivr-mcp-downloads` | Where `download_artifact` writes |
| `ARCHIVR_MCP_LOG` | `warn` | `off`, `error`, `warn`, `info` or `debug` (stderr only) |

## Development

```sh
bun test            # unit tests (mocked fetch, InMemoryTransport); e2e suites skip themselves
bun run test:e2e    # e2e against a real archivr-server (see test/e2e/README.md)
bun run typecheck
```

Layout and design: `docs/api-contract.md` (REST contract the tools are built against) and the plan.
