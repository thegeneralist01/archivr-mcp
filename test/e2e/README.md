# End-to-end tests

Placeholder. The e2e harness (M5) starts a real `archivr-server` in a temp directory
(`archivr init`, TOML registry, free port, clean env), creates an owner and a normal-user
API token, and drives the MCP server over real stdio. Only text and local-file captures are
used: no network captures.

Run with `bun run test:e2e`. Tests here must skip themselves (not fail) unless the e2e
environment (a built `archivr-server` binary) is available, so a plain `bun test` stays green.
