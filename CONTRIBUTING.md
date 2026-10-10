# Contributing to archivr-mcp

The [README](README.md) covers setup and tools; [AGENTS.md](AGENTS.md) describes the code layout and tool conventions. Archivr's server API is the authority for validation and access. Keep changes focused, document new or changed tools in the README catalogue, and report the checks actually run.

Before starting and before finishing a user-facing or API change, use Archivr's [ecosystem change checklist](https://github.com/thegeneralist01/archivr/blob/master/docs/ecosystem-change-checklist.md). Record whether Archivr and the Chrome extension need companion changes, why a project is not applicable, and a named follow-up for applicable work that remains open. This applies to direct commits and agent tasks as well as PRs.

Run `bun run typecheck` and relevant `bun test` suites. Changes that cross a role boundary or depend on a new server contract also need a real-server e2e scenario; see [the e2e guide](test/e2e/README.md) for prerequisites. If you open a PR, use its template and link related PRs or commits across repositories. A PR is not required to use the checklist.
