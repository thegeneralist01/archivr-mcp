import { describe, expect, test } from "bun:test";
import {
  changePassword, createApiToken, createCookieRule, createUser, resetUserPassword, updateCookieRule,
} from "../../src/tools/credentials";
import type { ToolDef } from "../../src/tools/registry";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { CANARY_PASSWORD, CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

const run = (tool: ToolDef, args: Record<string, unknown>, api: MockApi) => callTool(tool, args, directContext({ api }));

describe("credentials tools", () => {
  test("create_api_token sends the new fields and returns the raw token once", async () => {
    const api = new MockApi().on("POST", "/api/auth/tokens", {
      status: 201,
      json: { token_uid: "tok_1", raw_token: "arch_RAWTOKEN_12345678", name: "mcp", expires_at: "2027-01-01T00:00:00+00:00", scope: "read" },
    });
    const res = await run(createApiToken, { name: "mcp", expires_in_days: 30, scope: "read" }, api);
    expect(api.requests[0]?.json).toEqual({ name: "mcp", expires_in_days: 30, scope: "read" });
    expect(jsonOf(res)).toMatchObject({ token_uid: "tok_1", raw_token: "arch_RAWTOKEN_12345678", scope: "read" });
    expect(createApiToken.description).toContain("ONCE");
    expect(createApiToken.description).toContain("scope: read");
    await run(createApiToken, { name: "plain" }, api);
    expect(api.requests[1]?.json).toEqual({ name: "plain" });
  });

  test("create_api_token validates range and scope", async () => {
    const api = new MockApi();
    await expect(callTool(createApiToken, { name: "x", expires_in_days: 0 }, directContext({ api }))).rejects.toThrow();
    await expect(callTool(createApiToken, { name: "x", expires_in_days: 3651 }, directContext({ api }))).rejects.toThrow();
    await expect(callTool(createApiToken, { name: "x", scope: "admin" }, directContext({ api }))).rejects.toThrow();
  });

  test("change_password: request shape, no echo, friendly wrong-password message", async () => {
    const api = new MockApi().on("PATCH", "/api/auth/me", { status: 204 });
    const res = await run(changePassword, { current_password: "old-" + CANARY_PASSWORD, new_password: CANARY_PASSWORD }, api);
    expect(api.requests[0]?.json).toEqual({ current_password: "old-" + CANARY_PASSWORD, new_password: CANARY_PASSWORD });
    expect(textOf(res)).not.toContain(CANARY_PASSWORD);

    const wrong = new MockApi().on("PATCH", "/api/auth/me", { status: 401, json: { error: "current password is incorrect" } });
    const bad = await run(changePassword, { current_password: "whatever1", new_password: CANARY_PASSWORD }, wrong);
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("current password is incorrect");
    expect(textOf(bad)).not.toContain("token was rejected");
  });

  test("change_password: server echoing the password is redacted; short passwords rejected", async () => {
    const api = new MockApi().on("PATCH", "/api/auth/me", { status: 400, json: { error: `bad ${CANARY_PASSWORD}` } });
    const res = await run(changePassword, { current_password: "currentpw1", new_password: CANARY_PASSWORD }, api);
    expect(textOf(res)).not.toContain(CANARY_PASSWORD);
    await expect(callTool(changePassword, { current_password: "a", new_password: "short" }, directContext({ api }))).rejects.toThrow();
  });

  test("create_user", async () => {
    const api = new MockApi().on("POST", "/api/admin/users", { status: 201, json: { user_uid: "usr_9", username: "bob" } });
    const res = await run(createUser, { username: "bob", password: CANARY_PASSWORD, email: "b@x.io" }, api);
    expect(api.requests[0]?.json).toEqual({ username: "bob", password: CANARY_PASSWORD, email: "b@x.io" });
    expect(jsonOf(res)).toEqual({ user_uid: "usr_9", username: "bob" });
    await run(createUser, { username: "al", password: CANARY_PASSWORD }, api);
    expect(api.requests[1]?.json).toEqual({ username: "al", password: CANARY_PASSWORD });
  });

  test("reset_user_password: shape, results, 409 self, canary not leaked", async () => {
    const api = new MockApi().on("POST", "/api/admin/users/:uid/password", { json: { user_uid: "u1", sessions_revoked: 2, tokens_revoked: 1 } });
    const res = await run(resetUserPassword, { user_uid: "u1", new_password: CANARY_PASSWORD, revoke_tokens: true }, api);
    expect(api.requests[0]?.json).toEqual({ new_password: CANARY_PASSWORD, revoke_tokens: true });
    expect(jsonOf(res)).toMatchObject({ sessions_revoked: 2, tokens_revoked: 1 });
    expect(textOf(res)).not.toContain(CANARY_PASSWORD);
    const self = new MockApi().on("POST", "/api/admin/users/:uid/password", { status: 409, json: { error: `use PATCH /api/auth/me ${CANARY_PASSWORD}` } });
    const err = await run(resetUserPassword, { user_uid: "me", new_password: CANARY_PASSWORD }, self);
    expect(err.isError).toBe(true);
    expect(textOf(err)).toContain("Conflict");
    expect(textOf(err)).not.toContain(CANARY_PASSWORD);
  });

  const rule = { rule_uid: "c1", url_pattern: "*.x.com", pattern_kind: "wildcard", cookies_json: JSON.stringify({ sid: "COOKIEVALUE123" }), ordinal: 0, created_at: "t" };

  test("create_cookie_rule serializes cookies and never echoes values", async () => {
    const api = new MockApi().on("POST", "/api/admin/cookie-rules", { status: 201, json: rule });
    const res = await run(createCookieRule, { url_pattern: "*.x.com", pattern_kind: "wildcard", cookies: { sid: "COOKIEVALUE123" } }, api);
    expect(api.requests[0]?.json).toEqual({ url_pattern: "*.x.com", pattern_kind: "wildcard", cookies_json: '{"sid":"COOKIEVALUE123"}' });
    expect(textOf(res)).not.toContain("COOKIEVALUE123");
    expect(jsonOf(res)).toMatchObject({ rule_uid: "c1", cookies: { count: 1, value_lengths: { sid: 14 } } });
    await run(createCookieRule, { pattern_kind: "global", cookies: { a: "b" } }, api);
    expect((api.requests[1]?.json as { url_pattern: unknown }).url_pattern).toBeNull();
    await expect(callTool(createCookieRule, { pattern_kind: "global", cookies: {} }, directContext({ api }))).rejects.toThrow();
    await expect(callTool(createCookieRule, { pattern_kind: "other", cookies: { a: "b" } }, directContext({ api }))).rejects.toThrow();
  });

  test("update_cookie_rule sends only provided fields; a server echo of the value is not returned", async () => {
    const api = new MockApi().on("PATCH", "/api/admin/cookie-rules/:uid", { status: 400, json: { error: "bad regex COOKIEVALUE123" } });
    const res = await run(updateCookieRule, { uid: "c1", cookies: { sid: "COOKIEVALUE123" } }, api);
    expect(api.requests[0]?.json).toEqual({ cookies_json: '{"sid":"COOKIEVALUE123"}' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("COOKIEVALUE123");
    const ok = new MockApi().on("PATCH", "/api/admin/cookie-rules/:uid", { status: 204 });
    const out = await run(updateCookieRule, { uid: "c1", url_pattern: null, ordinal: 3 }, ok);
    expect(ok.requests[0]?.json).toEqual({ url_pattern: null, ordinal: 3 });
    expect(jsonOf(out)).toEqual({ updated_rule_uid: "c1", updated: ["url_pattern", "ordinal"] });
    expect((await run(updateCookieRule, { uid: "c1" }, ok)).isError).toBe(true);
  });

  test("token is redacted from errors", async () => {
    const api = new MockApi().on("POST", "/api/auth/tokens", { status: 500, json: { error: CANARY_TOKEN } });
    expect(textOf(await run(createApiToken, { name: "x" }, api))).not.toContain(CANARY_TOKEN);
  });
});
