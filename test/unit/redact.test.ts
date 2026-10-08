import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/lib/log";
import { REDACTED, collectSecretArgs, redactString, redactValue, scrubSensitiveKeys } from "../../src/lib/redact";

describe("redact", () => {
  test("replaces every occurrence of each secret", () => {
    expect(redactString("a SECRET-1234 b SECRET-1234", ["SECRET-1234"])).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  test("also redacts the JSON-escaped form of a secret", () => {
    const secret = 'pa"ss\\word99';
    const json = JSON.stringify({ echoed: secret });
    expect(json).not.toContain(secret);
    expect(redactString(json, [secret])).not.toContain("pa\\\"ss");
  });

  test("ignores very short secrets and redacts Bearer values", () => {
    expect(redactString("abc and abc", ["abc"])).toBe("abc and abc");
    expect(redactString("Authorization: Bearer abcdefghijklmnop", [])).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  test("handles overlapping secrets longest first", () => {
    expect(redactString("xx hunter2-extra yy", ["hunter2", "hunter2-extra"])).toBe(`xx ${REDACTED} yy`);
  });

  test("redactValue walks nested structures", () => {
    const out = redactValue({ a: ["tok-123456", { b: "see tok-123456" }], n: 1 }, ["tok-123456"]);
    expect(JSON.stringify(out)).not.toContain("tok-123456");
    expect(out.n).toBe(1);
  });

  test("collectSecretArgs picks password-like keys but not identifiers", () => {
    const found = collectSecretArgs({
      username: "bob",
      password: "pw-111111",
      new_password: "pw-222222",
      current_password: "pw-333333",
      token_uid: "tok_abc",
      raw_token: "raw-444444",
      cookies_json: '{"a":"b"}',
      nested: { password: "pw-555555" },
    });
    expect(found.sort()).toEqual(['{"a":"b"}', "pw-111111", "pw-222222", "pw-333333", "pw-555555", "raw-444444"].sort());
  });

  test("scrubSensitiveKeys masks values by key", () => {
    expect(scrubSensitiveKeys({ username: "u", password: "p", deep: { new_password: "x" } })).toEqual({
      username: "u",
      password: REDACTED,
      deep: { new_password: REDACTED },
    });
  });
});

describe("logger", () => {
  test("filters by level and redacts known secrets", () => {
    const lines: string[] = [];
    const log = createLogger("warn", ["TOKEN-SECRET-VALUE"], (l) => lines.push(l));
    log.debug("hidden");
    log.info("hidden");
    log.warn("visible TOKEN-SECRET-VALUE");
    log.error("also visible");
    expect(lines).toEqual([`archivr-mcp warn: visible ${REDACTED}`, "archivr-mcp error: also visible"]);
  });

  test("off logs nothing", () => {
    const lines: string[] = [];
    createLogger("off", [], (l) => lines.push(l)).error("x");
    expect(lines).toEqual([]);
  });
});
