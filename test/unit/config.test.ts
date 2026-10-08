import { describe, expect, test } from "bun:test";
import { ConfigError, DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS, DEFAULT_TOOLSETS, loadConfig } from "../../src/config";

const base = { ARCHIVR_URL: "http://127.0.0.1:8080", ARCHIVR_TOKEN: "tok_secret_value" };

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error("expected loadConfig to throw");
}

describe("loadConfig", () => {
  test("applies defaults", () => {
    const config = loadConfig(base);
    expect(config.url).toBe("http://127.0.0.1:8080");
    expect(config.token).toBe("tok_secret_value");
    expect(config.archive).toBeUndefined();
    expect([...config.toolsets].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
    expect(config.toolsets.has("credentials")).toBe(false);
    expect(config.readonly).toBe(false);
    expect(config.maxOutputChars).toBe(DEFAULT_MAX_OUTPUT_CHARS);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.uploadRoots).toEqual([]);
    expect(config.logLevel).toBe("warn");
  });

  test("requires ARCHIVR_URL and ARCHIVR_TOKEN", () => {
    const issues = issuesOf({});
    expect(issues.some((i) => i.includes("ARCHIVR_URL"))).toBe(true);
    expect(issues.some((i) => i.includes("ARCHIVR_TOKEN"))).toBe(true);
  });

  test("normalizes the URL (trailing slash, query, hash) and keeps a path prefix", () => {
    expect(loadConfig({ ...base, ARCHIVR_URL: "https://example.com/archivr/?x=1#y" }).url).toBe("https://example.com/archivr");
    expect(loadConfig({ ...base, ARCHIVR_URL: "http://localhost:8080/" }).url).toBe("http://localhost:8080");
  });

  test("rejects non-http URLs and URLs with credentials without echoing them", () => {
    expect(issuesOf({ ...base, ARCHIVR_URL: "ftp://example.com" }).join()).toContain("http or https");
    const issues = issuesOf({ ...base, ARCHIVR_URL: "http://user:pw-CANARY@example.com" });
    expect(issues.join()).toContain("credentials");
    expect(issues.join()).not.toContain("pw-CANARY");
    expect(issuesOf({ ...base, ARCHIVR_URL: "not a url" }).join()).toContain("absolute");
  });

  test("parses toolsets, case-insensitively, and opts into credentials", () => {
    const config = loadConfig({ ...base, ARCHIVR_MCP_TOOLSETS: "Core, credentials" });
    expect([...config.toolsets].sort()).toEqual(["core", "credentials"]);
  });

  test("rejects unknown or empty toolset lists", () => {
    expect(issuesOf({ ...base, ARCHIVR_MCP_TOOLSETS: "core,bogus" }).join()).toContain("unknown toolset");
    expect(issuesOf({ ...base, ARCHIVR_MCP_TOOLSETS: " , " }).join()).toContain("at least one");
  });

  test("parses boolean flags and numbers", () => {
    const config = loadConfig({
      ...base,
      ARCHIVR_MCP_READONLY: "true",
      ARCHIVR_MCP_MAX_OUTPUT_CHARS: "1000",
      ARCHIVR_MCP_TIMEOUT_MS: "5000",
      ARCHIVR_MCP_LOG: "DEBUG",
      ARCHIVR_ARCHIVE: " main ",
    });
    expect(config.readonly).toBe(true);
    expect(config.maxOutputChars).toBe(1000);
    expect(config.timeoutMs).toBe(5000);
    expect(config.logLevel).toBe("debug");
    expect(config.archive).toBe("main");
    expect(loadConfig({ ...base, ARCHIVR_MCP_READONLY: "0" }).readonly).toBe(false);
    expect(loadConfig({ ...base, ARCHIVR_MCP_READONLY: "" }).readonly).toBe(false);
  });

  test("rejects invalid flags and numbers", () => {
    expect(issuesOf({ ...base, ARCHIVR_MCP_READONLY: "maybe" }).join()).toContain("ARCHIVR_MCP_READONLY");
    expect(issuesOf({ ...base, ARCHIVR_MCP_TIMEOUT_MS: "-5" }).join()).toContain("ARCHIVR_MCP_TIMEOUT_MS");
    expect(issuesOf({ ...base, ARCHIVR_MCP_MAX_OUTPUT_CHARS: "0" }).join()).toContain("ARCHIVR_MCP_MAX_OUTPUT_CHARS");
    expect(issuesOf({ ...base, ARCHIVR_MCP_LOG: "loud" }).join()).toContain("ARCHIVR_MCP_LOG");
  });

  test("splits upload roots on the path delimiter", () => {
    const config = loadConfig({ ...base, ARCHIVR_MCP_UPLOAD_ROOTS: "/data/a:/data/b" });
    if (process.platform !== "win32") expect(config.uploadRoots).toEqual(["/data/a", "/data/b"]);
  });

  test("never includes the token value in error text", () => {
    const issues = issuesOf({ ARCHIVR_URL: "nope", ARCHIVR_TOKEN: "tok-CANARY-xyz", ARCHIVR_MCP_TOOLSETS: "bad" });
    expect(issues.join("\n")).not.toContain("tok-CANARY-xyz");
    try {
      loadConfig({ ARCHIVR_URL: "nope", ARCHIVR_TOKEN: "tok-CANARY-xyz" });
    } catch (error) {
      expect(String(error)).not.toContain("tok-CANARY-xyz");
    }
  });
});
