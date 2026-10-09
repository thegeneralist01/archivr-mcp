import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCaptureJob, listCaptureJobs, listRuns } from "../../src/tools/jobs";
import { toToolContext } from "../../src/tools/context";
import { connectInMemory, callTool, directContext, jsonOf, textOf } from "../helpers/inMemory";
import { installFakeClock, sequence, type FakeClock } from "../helpers/fakeClock";
import { CANARY_PASSWORD, CANARY_TOKEN, ME, MockApi } from "../helpers/mockFetch";

const A = "main";
const JOBS = `/api/archives/${A}/capture_jobs`;
const JOB = `${JOBS}/:job_uid`;
const RUNS = `/api/archives/${A}/runs`;

const job = (uid: string, status = "completed", extra: Record<string, unknown> = {}) => ({
  job_uid: uid,
  archive_id: A,
  run_uid: "run_1",
  status,
  error_text: null,
  notes_json: null,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:05Z",
  created_by: "usr_user",
  ...extra,
});
const run = (uid: string) => ({
  run_uid: uid,
  started_at: "t",
  finished_at: null,
  status: "completed",
  requested_count: 1,
  discovered_count: 1,
  completed_count: 1,
  failed_count: 0,
  error_summary: null,
});

let clock: FakeClock;
beforeEach(() => {
  clock = installFakeClock();
});
afterEach(() => clock.restore());

const setup = () => {
  const api = new MockApi();
  return { api, direct: directContext({ api, config: { archive: A } }) };
};

describe("list_capture_jobs", () => {
  test("passes filters to the server and returns summary rows", async () => {
    const { api, direct } = setup();
    api.on("GET", JOBS, { json: [job("job_2", "running"), job("job_1")] });
    const result = await callTool(listCaptureJobs, { status: "running", created_by: "me", limit: 10 }, direct);
    const body = jsonOf(result) as { items: Array<Record<string, unknown>>; has_more: boolean; returned: number };
    expect(body.returned).toBe(2);
    expect(body.has_more).toBe(false);
    expect(body.items[0]).toMatchObject({ job_uid: "job_2", status: "running", created_by: "usr_user" });
    expect(body.items[0]).not.toHaveProperty("items");
    expect(api.calls("GET", JOBS)[0]?.query).toEqual({ status: "running", created_by: "me", limit: "11", offset: "0" });
  });

  test("pagination: requests limit+1 to detect more rows and reports next_offset", async () => {
    const { api, direct } = setup();
    api.on("GET", JOBS, (req) => {
      const limit = Number(req.query["limit"]);
      const offset = Number(req.query["offset"]);
      const all = Array.from({ length: 5 }, (_, i) => job(`job_${i}`));
      return { json: all.slice(offset, offset + limit) };
    });
    const first = jsonOf(await callTool(listCaptureJobs, { limit: 2 }, direct)) as Record<string, unknown>;
    expect(first).toMatchObject({ returned: 2, has_more: true, next_offset: 2, offset: 0 });
    const last = jsonOf(await callTool(listCaptureJobs, { limit: 2, offset: 4 }, direct)) as Record<string, unknown>;
    expect(last).toMatchObject({ returned: 1, has_more: false, next_offset: null });
  });

  test("slices client-side if the server ignored limit/offset", async () => {
    const { api, direct } = setup();
    api.on("GET", JOBS, { json: Array.from({ length: 10 }, (_, i) => job(`job_${i}`)) });
    const body = jsonOf(await callTool(listCaptureJobs, { limit: 3, offset: 2 }, direct)) as {
      items: Array<{ job_uid: string }>;
      has_more: boolean;
    };
    expect(body.items.map((j) => j.job_uid)).toEqual(["job_2", "job_3", "job_4"]);
    expect(body.has_more).toBe(true);
  });

  test("role scoping errors from the server are surfaced (non-admin asking for another user -> 403)", async () => {
    const { api, direct } = setup();
    api.on("GET", JOBS, { status: 403, json: { error: "cannot list other users' jobs" } });
    const result = await callTool(listCaptureJobs, { created_by: "usr_other" }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("403");
    expect(textOf(result)).toContain("other users' jobs");
  });

  test("an invalid status is rejected by the schema", async () => {
    const { direct } = setup();
    await expect(callTool(listCaptureJobs, { status: "weird" }, direct)).rejects.toThrow();
  });
});

describe("get_capture_job", () => {
  test("returns entry_uids, items and flags a partial playlist", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, {
      json: job("job_1", "completed", {
        entry_uids: ["ent_a"],
        items: [
          { requested_locator: "v1", status: "completed", error_text: null, entry_uid: "ent_a" },
          { requested_locator: "v2", status: "failed", error_text: "private video", entry_uid: null },
        ],
        items_truncated: false,
      }),
    });
    const body = jsonOf(await callTool(getCaptureJob, { job_uid: "job_1" }, direct)) as Record<string, unknown>;
    expect(body).toMatchObject({ job_uid: "job_1", entry_uids: ["ent_a"], partial: true, failed_items: 1 });
    expect((body["items"] as unknown[]).length).toBe(2);
    expect(api.calls("GET", `${JOBS}/job_1`)).toHaveLength(1);
  });

  test("a failed job read without wait is data, not an error", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, { json: job("job_1", "failed", { error_text: "nope" }) });
    const result = await callTool(getCaptureJob, { job_uid: "job_1" }, direct);
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toMatchObject({ status: "failed", error_text: "nope" });
  });

  test("wait=true polls until terminal", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, sequence([{ json: job("job_1", "running") }, { json: job("job_1", "running") }, { json: job("job_1", "completed", { entry_uids: ["e"] }) }]));
    const result = await callTool(getCaptureJob, { job_uid: "job_1", wait: true }, direct);
    expect(jsonOf(result)).toMatchObject({ status: "completed", entry_uids: ["e"] });
    expect(api.calls("GET", `${JOBS}/job_1`).length).toBeGreaterThanOrEqual(3);
  });

  test("wait=true times out into a non-error running result; backoff stays within bounds", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, { json: job("job_1", "running") });
    const result = await callTool(getCaptureJob, { job_uid: "job_1", wait: true, wait_timeout_s: 10 }, direct);
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toMatchObject({ status: "running", job_uid: "job_1" });
    expect(clock.elapsed()).toBe(10_000);
  });

  test("abort during the wait says the job continues", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, { json: job("job_1", "running") });
    const controller = new AbortController();
    clock.abortOnSleep(controller);
    const ctx = toToolContext(direct.base, { signal: controller.signal });
    const result = await getCaptureJob.execute({ job_uid: "job_1", wait: true, wait_timeout_s: 60 }, ctx);
    expect(jsonOf(result)).toMatchObject({ status: "aborted" });
    expect(textOf(result)).toContain("continues on the server");
  });

  test("404 for someone else's job is explained", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, { status: 404, json: { error: "job not found" } });
    const result = await callTool(getCaptureJob, { job_uid: "job_x" }, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("404");
  });

  test("job_uid is encoded as a single path segment", async () => {
    const { api, direct } = setup();
    api.on("GET", JOB, (req) => ({ json: job(req.params["job_uid"] ?? "") }));
    await callTool(getCaptureJob, { job_uid: "../admin" }, direct);
    expect(api.requests[0]?.path).toBe(`${JOBS}/..%2Fadmin`);
  });
});

describe("list_runs", () => {
  test("paginates via limit/offset and documents the in-progress caveat", async () => {
    const { api, direct } = setup();
    api.on("GET", RUNS, (req) => {
      const limit = Number(req.query["limit"]);
      const offset = Number(req.query["offset"]);
      return { json: Array.from({ length: 4 }, (_, i) => run(`run_${i}`)).slice(offset, offset + limit) };
    });
    const body = jsonOf(await callTool(listRuns, { limit: 3 }, direct)) as Record<string, unknown>;
    expect(body).toMatchObject({ returned: 3, has_more: true, next_offset: 3 });
    expect(listRuns.description).toContain("in-progress run");
  });
});

describe("via the MCP server", () => {
  test("tools are registered under the capture toolset for users, with the right annotations", async () => {
    const c = await connectInMemory({ me: ME.user });
    try {
      const { tools } = await c.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      for (const name of ["list_capture_jobs", "get_capture_job", "list_runs"]) {
        expect(byName[name]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
      expect(byName["capture_url"]?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      expect(byName["capture_file"]).toBeDefined();
      expect(byName["summarize_entry"]).toBeDefined();
    } finally {
      await c.close();
    }
  });

  test("canary token and password never appear in a job error", async () => {
    const api = new MockApi();
    api.on("GET", JOB, { status: 500, json: { error: `boom ${CANARY_TOKEN} ${CANARY_PASSWORD}` } });
    const c = await connectInMemory({ api, config: { archive: A } });
    try {
      const result = await c.client.callTool({ name: "get_capture_job", arguments: { job_uid: "job_1" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain(CANARY_TOKEN);
    } finally {
      await c.close();
    }
  });
});
