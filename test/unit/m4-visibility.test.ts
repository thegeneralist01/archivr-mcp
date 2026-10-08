import { afterEach, describe, expect, test } from "bun:test";
import { TOOLSETS } from "../../src/config";
import { collectSecretArgs } from "../../src/lib/redact";
import { accountTools } from "../../src/tools/account";
import { adminRolesTools } from "../../src/tools/admin-roles";
import { adminSettingsTools } from "../../src/tools/admin-settings";
import { adminUsersTools } from "../../src/tools/admin-users";
import { credentialsTools } from "../../src/tools/credentials";
import { maintenanceTools } from "../../src/tools/maintenance";
import { connectInMemory, toolNames, type Connected } from "../helpers/inMemory";
import { ME, testConfig } from "../helpers/mockFetch";

let connected: Connected | undefined;
afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const ACCOUNT = ["list_my_credentials", "update_profile", "revoke_token", "revoke_session", "revoke_other_sessions"];
const ADMIN = [
  "admin_list", "server_info", "set_user_status", "assign_role", "remove_role", "create_role", "rename_role",
  "delete_user", "revoke_user_sessions", "revoke_user_token", "update_instance_settings", "update_ytdlp",
  "delete_cookie_rule", "blob_cleanup_scan", "blob_cleanup_run",
];
const OWNER_ONLY = ["delete_role"];
const CREDENTIALS = ["create_api_token", "change_password", "create_user", "reset_user_password", "create_cookie_rule", "update_cookie_rule"];

async function visible(me: (typeof ME)[keyof typeof ME], toolsets?: Set<(typeof TOOLSETS)[number]>) {
  connected = await connectInMemory({ me, ...(toolsets ? { config: testConfig({ toolsets }) } : {}) });
  const { tools } = await connected.client.listTools();
  const names = new Set(toolNames(tools));
  await connected.close();
  connected = undefined;
  return names;
}

describe("M4 tool visibility", () => {
  test("module contents", () => {
    const all = [accountTools, adminUsersTools, adminRolesTools, adminSettingsTools, maintenanceTools, credentialsTools].flatMap((m) => m());
    expect(all.map((t) => t.name).sort()).toEqual([...ACCOUNT, ...ADMIN, ...OWNER_ONLY, ...CREDENTIALS].sort());
  });

  test("guest sees none of them", async () => {
    const names = await visible(ME.guest, new Set(TOOLSETS));
    for (const n of [...ACCOUNT, ...ADMIN, ...OWNER_ONLY, ...CREDENTIALS]) expect(names.has(n)).toBe(false);
  });

  test("user sees account tools only (credentials off by default)", async () => {
    const names = await visible(ME.user);
    for (const n of ACCOUNT) expect(names.has(n)).toBe(true);
    for (const n of [...ADMIN, ...OWNER_ONLY, ...CREDENTIALS]) expect(names.has(n)).toBe(false);
  });

  test("admin sees admin tools but not delete_role", async () => {
    const names = await visible(ME.admin);
    for (const n of [...ACCOUNT, ...ADMIN]) expect(names.has(n)).toBe(true);
    expect(names.has("delete_role")).toBe(false);
    for (const n of CREDENTIALS) expect(names.has(n)).toBe(false);
  });

  test("owner sees delete_role", async () => {
    const names = await visible(ME.owner);
    expect(names.has("delete_role")).toBe(true);
  });

  test("credentials toolset appears only when enabled; admin-only credential tools hidden from users", async () => {
    const owner = await visible(ME.owner, new Set(TOOLSETS));
    for (const n of CREDENTIALS) expect(owner.has(n)).toBe(true);
    const user = await visible(ME.user, new Set(TOOLSETS));
    expect(user.has("create_api_token")).toBe(true);
    expect(user.has("change_password")).toBe(true);
    for (const n of ["create_user", "reset_user_password", "create_cookie_rule", "update_cookie_rule"]) expect(user.has(n)).toBe(false);
  });

  test("password-like argument names are covered by redaction", () => {
    const found = collectSecretArgs({
      password: "pw-aaaa", new_password: "pw-bbbb", current_password: "pw-cccc", cookies_json: "{}x12", raw_token: "tok-dddd",
    });
    expect(found).toEqual(["pw-aaaa", "pw-bbbb", "pw-cccc", "{}x12", "tok-dddd"]);
  });

  test("destructive tools require confirm over MCP", async () => {
    connected = await connectInMemory({ config: testConfig({ toolsets: new Set(TOOLSETS) }) });
    for (const [name, args] of [
      ["delete_user", { user_uid: "u" }],
      ["delete_role", { slug: "x" }],
      ["revoke_session", { handle: "h" }],
      ["blob_cleanup_run", { archive: "a" }],
    ] as const) {
      const result = await connected.client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(connected.api.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });
});
