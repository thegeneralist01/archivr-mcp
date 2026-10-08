import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadArtifact, getArtifact } from "../../src/tools/artifacts";
import { UNTRUSTED_NOTICE } from "../../src/lib/output";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { CANARY_TOKEN, MockApi, type RecordedRequest, type ReplySpec } from "../helpers/mockFetch";

const PATH = "/api/archives/main/entries/e1/artifacts/0";

function base(): MockApi {
  return new MockApi().on("GET", "/api/archives", { json: [{ id: "main", label: "Main" }] });
}

/** Serve `data`, honoring the Range header like ServeFile does. */
function serve(api: MockApi, path: string, data: Uint8Array, contentType: string, route = "GET"): void {
  api.on(route, path, (req: RecordedRequest): ReplySpec => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (m === null) return { bytes: data, headers: { "content-type": contentType, "content-length": String(data.length) } };
    const start = Number(m[1]);
    const end = Math.min(m[2] === "" ? data.length - 1 : Number(m[2]), data.length - 1);
    return {
      status: 206,
      bytes: data.slice(start, end + 1),
      headers: { "content-type": contentType, "content-range": `bytes ${start}-${end}/${data.length}` },
    };
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("get_artifact", () => {
  test("sends a Range header for max_bytes and flags truncation", async () => {
    const api = base();
    serve(api, PATH, enc("x".repeat(200)), "text/plain; charset=utf-8");
    const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0, max_bytes: 50 }, directContext({ api }));
    const call = api.calls("GET", PATH)[0]!;
    expect(call.headers.get("range")).toBe("bytes=0-49");
    expect(jsonOf(r)).toMatchObject({ size: 200, returned_bytes: 50, truncated: true, content_type: "text/plain" });
    const body = (r.content[1] as { text: string }).text;
    expect(body.startsWith(UNTRUSTED_NOTICE)).toBe(true);
    expect(body).toContain("x".repeat(50));
  });

  test("default window is 64 KiB and small files are not truncated", async () => {
    const api = base();
    serve(api, PATH, enc("hello"), "text/markdown");
    const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0 }, directContext({ api }));
    expect(api.calls("GET", PATH)[0]?.headers.get("range")).toBe("bytes=0-65535");
    expect(jsonOf(r)).toMatchObject({ size: 5, truncated: false });
    expect((r.content[1] as { text: string }).text).toContain("hello");
  });

  test("a server that ignores Range (200) is still cut at max_bytes", async () => {
    const api = base().on("GET", PATH, { bytes: enc("y".repeat(500)), headers: { "content-type": "application/json", "content-length": "500" } });
    const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0, max_bytes: 100 }, directContext({ api }));
    expect(jsonOf(r)).toMatchObject({ size: 500, returned_bytes: 100, truncated: true });
  });

  test("max_bytes above the cap is rejected", async () => {
    await expect(callTool(getArtifact, { entry_uid: "e1", artifact_index: 0, max_bytes: 2_000_000 }, directContext({ api: base() }))).rejects.toThrow();
  });

  test("HTML is stripped to text unless raw", async () => {
    const html = "<html><head><title>T</title><script>evil()</script></head><body><p>Hello <b>world</b></p></body></html>";
    const api = base();
    serve(api, PATH, enc(html), "text/html");
    const d = directContext({ api });
    const stripped = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0 }, d);
    const text = (stripped.content[1] as { text: string }).text;
    expect(text).toContain("Hello world");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("evil()");
    expect(jsonOf(stripped)).toMatchObject({ html_stripped: true });
    const raw = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0, raw: true }, d);
    expect((raw.content[1] as { text: string }).text).toContain("<p>Hello <b>world</b></p>");
  });

  test("images up to 1 MiB come back as image content, refetching a short first window", async () => {
    const png = new Uint8Array(70_000).fill(7); // larger than the default 64 KiB window
    const api = base();
    serve(api, PATH, png, "image/png");
    const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0 }, directContext({ api }));
    const image = r.content.find((b) => b.type === "image") as { data: string; mimeType: string };
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").length).toBe(70_000);
    expect(api.calls("GET", PATH)).toHaveLength(2);
    expect((r.content[0] as { text: string }).text.startsWith(UNTRUSTED_NOTICE)).toBe(true);
  });

  test("images over 1 MiB and other binaries get a hint, not bytes", async () => {
    const api = base();
    serve(api, PATH, new Uint8Array(1_100_000), "image/jpeg");
    serve(api, "/api/archives/main/entries/e1/artifacts/1", new Uint8Array(300), "video/mp4");
    const d = directContext({ api });
    for (const index of [0, 1]) {
      const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: index }, d);
      expect(r.content.every((b) => b.type === "text")).toBe(true);
      const out = jsonOf(r) as Record<string, unknown>;
      expect(out["binary"]).toBe(true);
      expect(String(out["hint"])).toContain("download_artifact");
      expect(out["content_type"]).toBe(index === 0 ? "image/jpeg" : "video/mp4");
    }
    expect(textOf(await callTool(getArtifact, { entry_uid: "e1", artifact_index: 1 }, d))).toContain('"size":300');
  });

  test("an empty file (416) yields an empty text result", async () => {
    const api = base().on("GET", PATH, { status: 416, json: { error: "range" } });
    const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0 }, directContext({ api }));
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ size: 0 });
  });

  test("sha256 addresses the blob endpoint; selectors are validated", async () => {
    const sha = "a".repeat(64);
    const api = base();
    serve(api, `/api/archives/main/blobs/${sha}`, enc("blob"), "text/plain");
    const d = directContext({ api });
    const r = await callTool(getArtifact, { sha256: sha.toUpperCase() }, d);
    expect(jsonOf(r)).toMatchObject({ sha256: sha });
    const neither = await callTool(getArtifact, {}, d);
    expect(neither.isError).toBe(true);
    const both = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0, sha256: sha }, d);
    expect(both.isError).toBe(true);
    await expect(callTool(getArtifact, { sha256: "nope" }, d)).rejects.toThrow();
  });

  test("404 and 403 are mapped; the token never leaks", async () => {
    for (const status of [404, 403]) {
      const api = base().on("GET", PATH, { status, json: { error: `denied ${CANARY_TOKEN}` } });
      const r = await callTool(getArtifact, { entry_uid: "e1", artifact_index: 0 }, directContext({ api }));
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(String(status));
      expect(JSON.stringify(r)).not.toContain(CANARY_TOKEN);
    }
  });

  test("entry uid is encoded as a single path segment", async () => {
    const api = base().on("GET", "/api/archives/main/entries/:uid/artifacts/0", { status: 404, json: { error: "x" } });
    await callTool(getArtifact, { entry_uid: "a/../b", artifact_index: 0 }, directContext({ api }));
    expect(api.requests.at(-1)?.path).toBe("/api/archives/main/entries/a%2F..%2Fb/artifacts/0");
  });
});

describe("download_artifact", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archivr-dl-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const detail = {
    summary: { entry_uid: "e1", archived_at: "t", source_kind: "web", entity_kind: "page", title: null, visibility: "public", original_url: null,
      artifact_count: 1, total_artifact_bytes: 4, parent_entry_uid: null, has_favicon: false, cached_bytes: 0, child_count: 0, cacheable_bytes: 0 },
    structured_root_relpath: "r", source_metadata_json: "{}", display_metadata_json: null,
    artifacts: [{ artifact_role: "media", storage_area: "raw", relpath: "store/ab/video.mp4", byte_size: 4 }],
    latest_summary: null, summary_attempt: null,
  };
  function setup(data = new Uint8Array([1, 2, 3, 4])) {
    const api = base().on("GET", "/api/archives/main/entries/e1", { json: detail });
    api.on("GET", PATH, { bytes: data, headers: { "content-type": "video/mp4" } });
    return directContext({ api, config: { downloadDir: dir } });
  }

  test("streams the artifact into the download dir under its relpath name", async () => {
    const d = setup();
    const r = await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0 }, d);
    const out = jsonOf(r) as { saved_to: string; bytes: number };
    expect(out.saved_to).toBe(join(dir, "video.mp4"));
    expect(out.bytes).toBe(4);
    expect([...(await readFile(out.saved_to))]).toEqual([1, 2, 3, 4]);
  });

  test("works into a sub directory and by sha256", async () => {
    const d = setup();
    const sha = "b".repeat(64);
    d.api.on("GET", `/api/archives/main/blobs/${sha}`, { bytes: enc("blobdata") });
    const r = await callTool(downloadArtifact, { sha256: sha, dest_dir: "sub/dir" }, d);
    const out = jsonOf(r) as { saved_to: string };
    expect(out.saved_to).toBe(join(dir, "sub", "dir", sha));
    expect(await readFile(out.saved_to, "utf8")).toBe("blobdata");
  });

  test("never overwrites without the flag (numbered name) and replaces with it", async () => {
    await writeFile(join(dir, "video.mp4"), "ORIGINAL");
    const d = setup();
    const kept = jsonOf(await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0 }, d)) as { saved_to: string };
    expect(kept.saved_to).toBe(join(dir, "video-1.mp4"));
    expect(await readFile(join(dir, "video.mp4"), "utf8")).toBe("ORIGINAL");
    const replaced = jsonOf(await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0, overwrite: true }, d)) as { saved_to: string };
    expect(replaced.saved_to).toBe(join(dir, "video.mp4"));
    expect([...(await readFile(join(dir, "video.mp4")))]).toEqual([1, 2, 3, 4]);
  });

  test("rejects dest_dir traversal, outside absolute paths and symlink escapes", async () => {
    const d = setup();
    const outside = await mkdtemp(join(tmpdir(), "archivr-outside-"));
    try {
      await symlink(outside, join(dir, "link"));
      for (const dest of ["../escape", "/etc", outside, "a/../../escape", "link", "link/deeper"]) {
        const r = await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0, dest_dir: dest }, d);
        expect(r.isError).toBe(true);
        expect(textOf(r)).toContain("download directory");
      }
      expect(await readdir(outside)).toEqual([]);
      expect(d.api.calls("GET", PATH)).toHaveLength(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("out-of-range index and missing artifact are errors", async () => {
    const d = setup();
    const r = await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 5 }, d);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("out of range");
    d.api.on("GET", PATH, { status: 404, json: { error: "artifact file missing" } });
    const missing = await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0 }, d);
    expect(missing.isError).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  test("a failed body leaves no partial file", async () => {
    const api = base().on("GET", "/api/archives/main/entries/e1", { json: detail });
    api.on("GET", PATH, () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const r = await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0 }, directContext({ api, config: { downloadDir: dir } }));
    expect(r.isError).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  test("the download dir is created when missing", async () => {
    const fresh = join(dir, "not", "yet");
    const d = setup();
    const withFresh = directContext({ api: d.api, config: { downloadDir: fresh } });
    await mkdir(dir, { recursive: true });
    const out = jsonOf(await callTool(downloadArtifact, { entry_uid: "e1", artifact_index: 0 }, withFresh)) as { saved_to: string };
    expect(out.saved_to).toBe(join(fresh, "video.mp4"));
  });
});
