import { expect } from "bun:test";
import type { Fixture } from "./harness";

function occurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Grep every response body and every MCP stdout/stderr byte recorded during the run for
 * values that must never leave the server:
 *  - session_uid (the cookie value), token hashes and password hashes (read from the auth DB)
 *  - registered secrets (passwords, cookies, canaries)
 *  - raw API tokens: each REST-minted token may appear once (its own mint response) and never
 *    in MCP output, except tokens listed in `allowedInMcp` (create_api_token is designed to return one).
 */
export function assertNoLeaks(fx: Fixture, opts: { allowedInMcp?: string[] } = {}): void {
  const { evidence } = fx;
  const everything = evidence.all();
  const mcpOut = [...evidence.mcpStdout, ...evidence.mcpStderr].join("\n");
  const allowed = new Set(opts.allowedInMcp ?? []);

  for (const server of [fx.server, ...fx.extraServers]) {
    const db = server.authDb();
    try {
      const sessions = db.query<{ v: string }, []>("SELECT session_uid AS v FROM sessions").all();
      const hashes = db.query<{ v: string }, []>("SELECT token_hash AS v FROM api_tokens").all();
      const pwHashes = db.query<{ v: string }, []>("SELECT password_hash AS v FROM users").all();
      expect(sessions.length).toBeGreaterThan(0);
      for (const { v } of [...sessions, ...hashes, ...pwHashes]) {
        expect(v.length).toBeGreaterThan(8);
        expect(occurrences(everything, v), "session_uid / token hash / password hash leaked").toBe(0);
      }
    } finally {
      db.close();
    }
  }

  for (const [label, value] of evidence.secrets) {
    expect(occurrences(everything, value), `secret '${label}' leaked`).toBe(0);
  }

  const users = Object.values(fx.cast);
  for (const u of users) {
    if (!allowed.has(u.token)) expect(occurrences(mcpOut, u.token), `${u.username} token in MCP output`).toBe(0);
    // Appears at most in its own REST mint response.
    expect(occurrences(evidence.rest.join("\n"), u.token)).toBeLessThanOrEqual(1);
  }
}
