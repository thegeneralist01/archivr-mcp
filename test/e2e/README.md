# End-to-end tests

These tests start a REAL `archivr-server` in a temp directory and drive the MCP server over real
stdio (`StdioClientTransport`, command `bun run src/index.ts`). Only text and local-file captures
are used: there are no network captures.

```sh
export ARCHIVR_SERVER_BIN=/path/to/archivr/target/debug/archivr-server
export ARCHIVR_CLI_BIN=/path/to/archivr/target/debug/archivr
bun run test:e2e        # fails fast if either variable is unset
```

The binaries must come from Archivr `master` at or after PR #40 (`3b748fb`). Without
`ARCHIVR_SERVER_BIN` (and `ARCHIVR_CLI_BIN`) every e2e suite skips itself, so a plain `bun test`
stays green.

What the harness (`harness.ts`) does per suite: `archivr init` an archive, write a TOML registry,
pick a free port, spawn the server with a clean environment (only `PATH`, `HOME`, `ARCHIVR_BIND`,
`ARCHIVR_STATE_DIR`; server output goes to a log file in the temp dir), poll `/health`, run
`/api/auth/setup`, create admin/admin2/user/user2/guest accounts (the guest has only the `guest`
role) and mint a Bearer token for each. Logins use a spoofed `X-Forwarded-For` per call so the
per-IP login rate limit never trips. Teardown is SIGTERM plus removal of the temp dir.

`Evidence` records every REST body and everything the MCP servers print; `assertNoLeaks`
(`leaks.ts`) greps it for `session_uid` cookie values, token and password hashes read from the
auth sqlite, and registered secrets.

Suites: `tools-and-entries` (tool lists per role, capture, file guards, tags, collections, summaries),
`admin-and-credentials` (user lifecycle, tokens, sessions, expiry), `settings-and-jobs` (settings,
effective-config redaction, archive info, jobs and runs scoping), `isolation` (the checklist).
