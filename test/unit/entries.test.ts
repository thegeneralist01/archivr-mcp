import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportEntries } from "../../src/tools/entries";
import { selectTools } from "../../src/tools/registry";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { MockApi } from "../helpers/mockFetch";

const EXPORT_PATH = "/api/archives/main/export";

function base(): MockApi {
  return new MockApi().on("GET", "/api/archives", { json: [{ id: "main", label: "Main" }] });
}

describe("export_entries", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archivr-export-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("downloads the export ZIP and returns saved_to", async () => {
    const data = new Uint8Array([80, 75, 3, 4]); // PK magic bytes
    const api = base().on("GET", EXPORT_PATH, {
      bytes: data,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="export-1-entries-2026-10-12.zip"',
      },
    });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-abc"] }, ctx);
    expect(result.isError).toBeFalsy();
    const out = jsonOf(result) as { saved_to: string; bytes: number; format: string; entry_count: number };
    expect(out.saved_to).toBe(join(dir, "export-1-entries-2026-10-12.zip"));
    expect(out.bytes).toBe(4);
    expect(out.format).toBe("html");
    expect(out.entry_count).toBe(1);
    expect([...(await readFile(out.saved_to))]).toEqual([80, 75, 3, 4]);
  });

  test("passes entries as comma-joined query param and forwards format/layout/credit", async () => {
    const api = base().on("GET", EXPORT_PATH, {
      bytes: new Uint8Array([1]),
      headers: { "content-disposition": 'attachment; filename="out.zip"' },
    });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    await callTool(exportEntries, { entries: ["a", "b", "c"], format: "markdown", layout: "separate", credit: false }, ctx);
    const req = api.calls("GET", EXPORT_PATH)[0]!;
    expect(req.query["entries"]).toBe("a,b,c");
    expect(req.query["format"]).toBe("markdown");
    expect(req.query["layout"]).toBe("separate");
    expect(req.query["credit"]).toBe("false");
  });

  test("maps the combined layout to the server's together value", async () => {
    const api = base().on("GET", EXPORT_PATH, (request) =>
      request.query["layout"] === "together"
        ? { bytes: new Uint8Array([80, 75, 3, 4]) }
        : { status: 400, json: { error: "layout must be together or separate" } },
    );
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"], layout: "combined" }, ctx);
    expect(result.isError).toBeFalsy();
    expect(api.calls("GET", EXPORT_PATH)[0]?.query["layout"]).toBe("together");
  });

  test("allows the server's 100-entry limit and rejects 101", async () => {
    const api = base().on("GET", EXPORT_PATH, { bytes: new Uint8Array([80, 75, 3, 4]) });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const entries = Array.from({ length: 100 }, (_, i) => `uid-${i}`);
    const result = await callTool(exportEntries, { entries }, ctx);
    expect(result.isError).toBeFalsy();
    expect(api.calls("GET", EXPORT_PATH)[0]?.query["entries"]?.split(",")).toHaveLength(100);
    await expect(callTool(exportEntries, { entries: [...entries, "uid-100"] }, ctx)).rejects.toThrow();
  });

  test("is hidden by MCP read-only mode because it writes a local file", () => {
    const selected = selectTools([exportEntries], {
      toolsets: new Set(["core"]),
      readonly: true,
      me: { roleBits: 3 },
    });
    expect(selected).toEqual([]);
  });

  test("lets export generation outlast the default request timeout", async () => {
    const api = base().on("GET", EXPORT_PATH, async (request) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
      return { bytes: new Uint8Array([80, 75, 3, 4]) };
    });
    const ctx = directContext({ api, config: { archive: "main", downloadDir: dir, timeoutMs: 10 } });
    ctx.base.client = api.client({ timeoutMs: 10 });
    const result = await callTool(exportEntries, { entries: ["uid-x"] }, ctx);
    expect(result.isError).toBeFalsy();
  });

  test("falls back to a generic filename when Content-Disposition is absent", async () => {
    const api = base().on("GET", EXPORT_PATH, { bytes: new Uint8Array([1]) });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"], format: "html" }, ctx);
    const out = jsonOf(result) as { saved_to: string };
    expect(out.saved_to).toBe(join(dir, "export.zip"));
  });

  test("Markdown fallback is also a ZIP", async () => {
    const api = base().on("GET", EXPORT_PATH, { bytes: new Uint8Array([80, 75, 3, 4]) });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"], format: "markdown" }, ctx);
    const out = jsonOf(result) as { saved_to: string };
    expect(out.saved_to).toBe(join(dir, "export.zip"));
    expect(exportEntries.description).toContain("Markdown ZIP");
  });

  test("output_filename overrides the server name", async () => {
    const api = base().on("GET", EXPORT_PATH, {
      bytes: new Uint8Array([1]),
      headers: { "content-disposition": 'attachment; filename="server-name.zip"' },
    });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"], output_filename: "my-export.zip" }, ctx);
    const out = jsonOf(result) as { saved_to: string };
    expect(out.saved_to).toBe(join(dir, "my-export.zip"));
  });

  test("empty entries array is rejected by input validation", async () => {
    const ctx = directContext({ api: base(), config: { downloadDir: dir } });
    await expect(callTool(exportEntries, { entries: [] }, ctx)).rejects.toThrow();
  });
  test("server 401 propagates as a tool error", async () => {
    const api = base().on("GET", EXPORT_PATH, { status: 401, json: { error: "login required" } });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"] }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/401|unauthorized|login/i);
  });

  test("server 400 propagates as a tool error", async () => {
    const api = base().on("GET", EXPORT_PATH, { status: 400, json: { error: "format must be html or markdown" } });
    const ctx = directContext({ api, config: { downloadDir: dir } });
    const result = await callTool(exportEntries, { entries: ["uid-x"], format: "html" }, ctx);
    expect(result.isError).toBe(true);
  });
});
