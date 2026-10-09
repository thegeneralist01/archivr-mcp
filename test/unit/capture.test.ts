import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchivrClient } from "../../src/client/http";
import { toToolContext } from "../../src/tools/context";
import {
  captureFile,
  captureText,
  captureUrl,
  generateTextTitle,
  probePlaylist,
  probeUrl,
  rearchiveEntry,
} from "../../src/tools/capture";
import { DESTRUCTIVE } from "../../src/tools/registry";
import { callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { installFakeClock, sequence, type FakeClock } from "../helpers/fakeClock";
import { CANARY_TOKEN, MockApi, type RecordedRequest } from "../helpers/mockFetch";

const ARCHIVE = "main";
const JOBS = `/api/archives/${ARCHIVE}/capture_jobs/:job_uid`;
const CAPTURES = `/api/archives/${ARCHIVE}/captures`;

const job = (status: string, extra: Record<string, unknown> = {}) => ({
  job_uid: "job_1",
  archive_id: ARCHIVE,
  run_uid: status === "pending" ? null : "run_1",
  status,
  error_text: null,
  notes_json: null,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:01Z",
  created_by: "usr_user",
  ...extra,
});

let clock: FakeClock;
beforeEach(() => {
  clock = installFakeClock();
});
afterEach(() => clock.restore());

function setup(config: Parameters<typeof directContext>[0] = {}) {
  const api = new MockApi();
  return { api, direct: directContext({ api, config: { archive: ARCHIVE, ...(config.config ?? {}) } }) };
}

describe("capture_url", () => {
  test("202 then polls pending -> running -> completed and returns entries and items", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on(
      "GET",
      JOBS,
      sequence([
        { json: job("pending") },
        { json: job("running") },
        {
          json: job("completed", {
            entry_uids: ["ent_a"],
            items: [{ requested_locator: "https://example.com", status: "completed", error_text: null, entry_uid: "ent_a" }],
            notes_json: '{"ublock_skipped":true}',
          }),
        },
      ]),
    );
    const result = await callTool(captureUrl, { locator: " https://example.com ", quality: "720p", sync: true }, direct);
    expect(result.isError).toBeUndefined();
    const body = jsonOf(result) as Record<string, unknown>;
    expect(body["status"]).toBe("completed");
    expect(body["entry_uids"]).toEqual(["ent_a"]);
    expect(body["notes"]).toEqual({ ublock_skipped: true });
    expect(body["partial"]).toBeUndefined();
    expect(api.calls("GET", `/api/archives/${ARCHIVE}/capture_jobs/job_1`)).toHaveLength(3);
    expect(api.calls("POST", CAPTURES)[0]?.json).toEqual({ locator: "https://example.com", quality: "720p", sync: true });
  });

  test("sends per_item_quality and the other options through", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    const result = await callTool(
      captureUrl,
      { locator: "https://youtube.com/playlist?list=x", per_item_quality: { abc: "audio" }, reader_mode: false, wait: false },
      direct,
    );
    expect(jsonOf(result)).toMatchObject({ status: "pending", job_uid: "job_1" });
    expect(api.calls("POST", CAPTURES)[0]?.json).toEqual({
      locator: "https://youtube.com/playlist?list=x",
      per_item_quality: { abc: "audio" },
      reader_mode: false,
    });
    expect(api.calls("GET", `/api/archives/${ARCHIVE}/capture_jobs/job_1`)).toHaveLength(0);
  });

  test("reports progress while polling", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, sequence([{ json: job("pending") }, { json: job("running") }, { json: job("completed") }]));
    const updates: Array<{ progress: number; message?: string | undefined }> = [];
    const ctx = { ...direct.ctx, progress: async (u: { progress: number; message?: string }) => void updates.push(u) };
    await captureUrl.execute(captureUrl.input.locator ? { locator: "https://e.com", wait: true, wait_timeout_s: 120 } : {}, ctx);
    expect(updates.map((u) => u.progress)).toEqual([1, 2]);
    expect(updates[0]?.message).toContain("pending");
  });

  test("timeout returns a NON-error running result with the job_uid", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("running") });
    const result = await callTool(captureUrl, { locator: "https://example.com", wait_timeout_s: 5 }, direct);
    expect(result.isError).toBeUndefined();
    const body = jsonOf(result) as Record<string, string>;
    expect(body["status"]).toBe("running");
    expect(body["job_uid"]).toBe("job_1");
    expect(body["hint"]).toContain("get_capture_job");
    expect(clock.elapsed()).toBeGreaterThanOrEqual(5000);
  });

  test("a completed job with failed items is flagged as a partial playlist", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, {
      json: job("completed", {
        entry_uids: ["ent_a"],
        items: [
          { requested_locator: "v1", status: "completed", error_text: null, entry_uid: "ent_a" },
          { requested_locator: "v2", status: "failed", error_text: "video unavailable", entry_uid: null },
        ],
      }),
    });
    const result = await callTool(captureUrl, { locator: "https://youtube.com/playlist?list=x" }, direct);
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toMatchObject({ status: "completed", partial: true, failed_items: 1 });
  });

  test("a failed job is an error result carrying the server's error_text", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("failed", { error_text: "yt-dlp exploded" }) });
    const result = await callTool(captureUrl, { locator: "https://example.com" }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("yt-dlp exploded");
  });

  test("rejects file: locators client-side and points to capture_file", async () => {
    const { api, direct } = setup();
    for (const locator of ["file:///etc/passwd", "FILE:///etc/passwd", "  file://x"]) {
      const result = await callTool(captureUrl, { locator }, direct);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("capture_file");
    }
    expect(api.requests).toHaveLength(0);
  });

  test("abort stops polling only and says the job continues", async () => {
    const api = new MockApi();
    const direct = directContext({ api, config: { archive: ARCHIVE } });
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("running") });
    const controller = new AbortController();
    clock.abortOnSleep(controller);
    const ctx = toToolContext(direct.base, { signal: controller.signal });
    const result = await captureUrl.execute({ locator: "https://e.com", wait: true, wait_timeout_s: 60 }, ctx);
    expect(result.isError).toBeUndefined();
    const body = jsonOf(result) as Record<string, string>;
    expect(body["status"]).toBe("aborted");
    expect(body["job_uid"]).toBe("job_1");
    expect(body["hint"]).toContain("continues on the server");
    expect(api.calls("DELETE", `/api/archives/${ARCHIVE}/capture_jobs/job_1`)).toHaveLength(0);
  });

  test("server 400 text is surfaced and the token never appears", async () => {
    const { api, direct } = setup();
    api.on("POST", CAPTURES, { status: 400, json: { error: `bad locator; token ${CANARY_TOKEN}` } });
    const result = await callTool(captureUrl, { locator: "https://example.com" }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("bad locator");
    expect(textOf(result)).not.toContain(CANARY_TOKEN);
  });

  test("invalid quality is rejected by the schema", async () => {
    const { direct } = setup();
    await expect(callTool(captureUrl, { locator: "https://e.com", quality: "ultra" }, direct)).rejects.toThrow();
  });
});

describe("capture_text", () => {
  test("posts title/body/mime and returns the finished job", async () => {
    const { api, direct } = setup();
    api.on("POST", `${CAPTURES}/text`, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("completed", { entry_uids: ["ent_t"], items: [] }) });
    const result = await callTool(captureText, { title: "Note", body: "# hi" }, direct);
    expect(jsonOf(result)).toMatchObject({ status: "completed", entry_uids: ["ent_t"] });
    expect(api.calls("POST", `${CAPTURES}/text`)[0]?.json).toEqual({ title: "Note", body: "# hi", mime: "text/markdown" });
  });

  test("rejects bodies over 2 MiB (by bytes) without calling the server", async () => {
    const { api, direct } = setup();
    const atLimit = "a".repeat(2 * 1024 * 1024);
    api.on("POST", `${CAPTURES}/text`, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    const ok = await callTool(captureText, { title: "t", body: atLimit, wait: false }, direct);
    expect(ok.isError).toBeUndefined();
    api.requests.length = 0;
    // 2 MiB / 2 two-byte characters + 1 => over the limit in bytes though under it in characters.
    const over = await callTool(captureText, { title: "t", body: "é".repeat(1024 * 1024 + 1), wait: false }, direct);
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("2 MiB");
    expect(api.requests).toHaveLength(0);
  });

  test("rejects a blank body or title", async () => {
    const { api, direct } = setup();
    expect((await callTool(captureText, { title: "t", body: "   " }, direct)).isError).toBe(true);
    expect((await callTool(captureText, { title: "  ", body: "x" }, direct)).isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });
});

describe("capture_file", () => {
  let root: string;
  let outside: string;
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "archivr-m2-root-")));
    outside = await realpath(await mkdtemp(join(tmpdir(), "archivr-m2-out-")));
    await writeFile(join(root, "note.txt"), "hello upload");
    await writeFile(join(root, ".env"), "SECRET=1");
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "config"), "x");
    await writeFile(join(outside, "x.txt"), "x");
    await writeFile(join(root, "big.bin"), Buffer.alloc(2048));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const UPLOADS = `/api/archives/${ARCHIVE}/uploads`;
  const LOCATOR = "file:///data/temp/uploads/abc/note.txt";
  const stage = (api: MockApi) =>
    api.on("POST", UPLOADS, { json: { locator: LOCATOR, filename: "note.txt", size: 12 } });

  test("uploads as multipart field `file`, then captures with the returned locator", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    let uploaded: RecordedRequest | undefined;
    api.on("POST", UPLOADS, (req) => {
      uploaded = req;
      return { json: { locator: LOCATOR, filename: "note.txt", size: 12 } };
    });
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("completed", { entry_uids: ["ent_f"], items: [] }) });

    const result = await callTool(captureFile, { path: join(root, "note.txt"), quality: "best" }, direct);
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toMatchObject({ status: "completed", entry_uids: ["ent_f"], uploaded: { filename: "note.txt", size: 12 } });

    // The body is a hand-built stream, not FormData; parse it back as multipart.
    expect(uploaded?.form).toBeUndefined();
    const contentType = uploaded?.headers.get("content-type") ?? "";
    expect(contentType).toStartWith("multipart/form-data; boundary=");
    expect(uploaded?.headers.get("content-length")).toBe(String(uploaded?.bodyBytes?.byteLength));
    const form = await new Response(uploaded?.bodyBytes, { headers: { "content-type": contentType } }).formData();
    expect([...form.keys()]).toEqual(["file"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("note.txt"); // the basename, never the local path
    expect(await file.text()).toBe("hello upload");
    expect(new TextDecoder().decode(uploaded?.bodyBytes)).not.toContain(root);
    expect(api.calls("POST", CAPTURES)[0]?.json).toEqual({ locator: LOCATOR, quality: "best" });
    expect(api.calls("DELETE", UPLOADS)).toHaveLength(0);
  });

  test("deletes the staged upload when the capture POST fails, and still reports the failure", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    stage(api);
    api.on("POST", CAPTURES, { status: 400, json: { error: "file:// locators must reference a staged upload" } });
    api.on("DELETE", UPLOADS, { status: 204 });
    const result = await callTool(captureFile, { path: join(root, "note.txt") }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("staged upload");
    const deletes = api.calls("DELETE", UPLOADS);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.json).toEqual({ locator: LOCATOR });
  });

  test("cleanup failure does not mask the capture error", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    stage(api);
    api.on("POST", CAPTURES, { status: 403, json: { error: "nope" } });
    api.on("DELETE", UPLOADS, new Error("boom"));
    const result = await callTool(captureFile, { path: join(root, "note.txt") }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Forbidden");
  });

  test("does not delete the staged upload when polling times out (the job still needs it)", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    stage(api);
    api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("running") });
    const result = await callTool(captureFile, { path: join(root, "note.txt"), wait_timeout_s: 2 }, direct);
    expect(jsonOf(result)).toMatchObject({ status: "running" });
    expect(api.calls("DELETE", UPLOADS)).toHaveLength(0);
  });

  test("the size cap comes from config (ARCHIVR_MCP_MAX_UPLOAD_BYTES), not a constant", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root], maxUploadBytes: 1024 } });
    const over = await callTool(captureFile, { path: join(root, "big.bin") }, direct);
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain("2048 bytes, over the 1024 byte upload limit");
    expect(api.requests).toHaveLength(0);

    const roomy = setup({ config: { uploadRoots: [root], maxUploadBytes: 2048 } });
    stage(roomy.api);
    roomy.api.on("POST", CAPTURES, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    const ok = await callTool(captureFile, { path: join(root, "big.bin"), wait: false }, roomy.direct);
    expect(ok.isError).toBeUndefined();
    expect(roomy.api.calls("POST", UPLOADS)[0]?.bodyBytes?.byteLength).toBeGreaterThan(2048);
  });

  test("rejections never reach the network: outside roots, denylist, size cap, disabled", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    const cases: Array<[string, string]> = [
      [join(outside, "x.txt"), "outside"],
      [join(root, ".env"), "denylist"],
      [join(root, ".ssh", "config"), "denylist"],
      [join(root, "missing.txt"), "not found"],
      ["relative.txt", "absolute"],
    ];
    for (const [path, needle] of cases) {
      const result = await callTool(captureFile, { path }, direct);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(needle);
    }
    const none = setup({ config: { uploadRoots: [] } });
    const disabled = await callTool(captureFile, { path: join(root, "note.txt") }, none.direct);
    expect(textOf(disabled)).toContain("ARCHIVR_MCP_UPLOAD_ROOTS");
    expect(api.requests).toHaveLength(0);
    expect(none.api.requests).toHaveLength(0);
  });

  test("streams a 24 MB file through a real fetch as byte-exact multipart", async () => {
    const size = 24 * 1024 * 1024 + 17;
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) data[i] = (i * 7 + (i >> 10)) & 0xff;
    const path = join(root, "large.bin");
    await writeFile(path, data);
    let contentType = "";
    let contentLength: string | null = null;
    let fileName = "";
    let fileHash = "";
    let fileSize = -1;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname.endsWith("/uploads")) {
          contentType = req.headers.get("content-type") ?? "";
          contentLength = req.headers.get("content-length");
          const form = await req.formData();
          const file = form.get("file") as File;
          fileName = file.name;
          fileSize = file.size;
          fileHash = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");
          return Response.json({ locator: LOCATOR, filename: "large.bin", size });
        }
        if (req.method === "POST") return Response.json({ job_uid: "job_1", status: "pending" }, { status: 202 });
        return Response.json({});
      },
    });
    try {
      const client = new ArchivrClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: CANARY_TOKEN, timeoutMs: 30_000 });
      const base = directContext({ config: { archive: ARCHIVE, uploadRoots: [root] } }).base;
      const ctx = toToolContext({ ...base, client }, { signal: new AbortController().signal });
      const result = await captureFile.execute({ path, wait: false, wait_timeout_s: 1 }, ctx);
      expect(jsonOf(result)).toMatchObject({ status: "pending", job_uid: "job_1" });
      expect(contentType).toStartWith("multipart/form-data; boundary=");
      expect(Number(contentLength)).toBeGreaterThan(size);
      expect(Number(contentLength)).toBeLessThan(size + 1024);
      expect(fileName).toBe("large.bin");
      expect(fileSize).toBe(size);
      expect(fileHash).toBe(createHash("sha256").update(data).digest("hex"));
    } finally {
      await server.stop(true);
    }
  });

  test("an upload failure is reported and no capture is attempted", async () => {
    const { api, direct } = setup({ config: { uploadRoots: [root] } });
    api.on("POST", UPLOADS, { status: 413, json: { error: "too large" } });
    const result = await callTool(captureFile, { path: join(root, "note.txt") }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Payload too large");
    expect(api.calls("POST", CAPTURES)).toHaveLength(0);
    expect(api.calls("DELETE", UPLOADS)).toHaveLength(0);
  });
});

describe("probes, titles and re-archive", () => {
  test("probe_url sends the locator as a query parameter", async () => {
    const { api, direct } = setup();
    api.on("GET", `${CAPTURES}/probe`, { json: { has_video: true, has_audio: true, qualities: ["1080p", "720p"] } });
    const result = await callTool(probeUrl, { locator: "https://youtu.be/x?y=1&z=2" }, direct);
    expect(jsonOf(result)).toEqual({ has_video: true, has_audio: true, qualities: ["1080p", "720p"] });
    expect(api.calls("GET", `${CAPTURES}/probe`)[0]?.query).toEqual({ locator: "https://youtu.be/x?y=1&z=2" });
    expect(probeUrl.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  test("probe_playlist posts the locator", async () => {
    const { api, direct } = setup();
    const playlist = {
      playlist_id: "PL1",
      title: "T",
      uploader: null,
      items: [{ id: "v1", url: "https://y/v1", title: "One", qualities: ["720p"], has_audio: true }],
    };
    api.on("POST", `${CAPTURES}/probe-playlist`, { json: playlist });
    const result = await callTool(probePlaylist, { locator: "https://youtube.com/playlist?list=PL1" }, direct);
    expect(jsonOf(result)).toMatchObject({ playlist_id: "PL1" });
    expect(api.calls("POST", `${CAPTURES}/probe-playlist`)[0]?.json).toEqual({ locator: "https://youtube.com/playlist?list=PL1" });
  });

  test("probe 502 is explained as upstream failure", async () => {
    const { api, direct } = setup();
    api.on("GET", `${CAPTURES}/probe`, { status: 502, json: { error: "yt-dlp metadata fetch failed" } });
    const result = await callTool(probeUrl, { locator: "https://x" }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Upstream failure");
  });

  test("generate_text_title forwards body and provider; missing env var 400 is surfaced", async () => {
    const { api, direct } = setup();
    api.on("POST", `${CAPTURES}/text/title`, { json: { title: "A Title" } });
    const ok = await callTool(generateTextTitle, { body: "some text", provider: "anthropic_http" }, direct);
    expect(jsonOf(ok)).toEqual({ title: "A Title" });
    expect(api.calls("POST", `${CAPTURES}/text/title`)[0]?.json).toEqual({ body: "some text", provider: "anthropic_http" });
    api.on("POST", `${CAPTURES}/text/title`, { status: 400, json: { error: "missing required environment variable: ARCHIVR_ANTHROPIC_API_KEY" } });
    const bad = await callTool(generateTextTitle, { body: "some text", provider: "anthropic_http" }, direct);
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("ARCHIVR_ANTHROPIC_API_KEY");
  });

  test("rearchive_entry posts to the entry and waits for the job", async () => {
    const { api, direct } = setup();
    api.on("POST", `/api/archives/${ARCHIVE}/entries/ent_t/rearchive`, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, sequence([{ json: job("running") }, { json: job("completed") }]));
    const result = await callTool(rearchiveEntry, { entry_uid: "ent_t", confirm: true }, direct);
    expect(jsonOf(result)).toMatchObject({ status: "completed", entry_uid: "ent_t" });
    expect(api.calls("POST", `/api/archives/${ARCHIVE}/entries/ent_t/rearchive`)).toHaveLength(1);
  });

  test("rearchive_entry is a destructive open-world tool and requires confirm: true", async () => {
    expect(rearchiveEntry.annotations).toEqual({ ...DESTRUCTIVE, openWorldHint: true });
    expect(rearchiveEntry.description).toContain("replace");
    expect(rearchiveEntry.description).toContain("preserved");
    const { api, direct } = setup();
    await expect(callTool(rearchiveEntry, { entry_uid: "ent_t" }, direct)).rejects.toThrow();
    await expect(callTool(rearchiveEntry, { entry_uid: "ent_t", confirm: false } as never, direct)).rejects.toThrow();
    expect(api.requests).toHaveLength(0);
  });

  test("rearchive of a non-tweet surfaces the failed job as an error", async () => {
    const { api, direct } = setup();
    api.on("POST", `/api/archives/${ARCHIVE}/entries/ent_w/rearchive`, { status: 202, json: { job_uid: "job_1", status: "pending" } });
    api.on("GET", JOBS, { json: job("failed", { error_text: "entry is not a tweet" }) });
    const result = await callTool(rearchiveEntry, { entry_uid: "ent_w", confirm: true }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a tweet");
  });
});
