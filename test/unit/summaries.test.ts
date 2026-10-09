import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toToolContext } from "../../src/tools/context";
import { generateThreadTitle, getSummary, listTranscriptionEngines, summarizeEntry } from "../../src/tools/summaries";
import { callTool, directContext, textOf } from "../helpers/inMemory";
import { installFakeClock, sequence, type FakeClock } from "../helpers/fakeClock";
import { CANARY_PASSWORD, CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

const A = "main";
const SUMMARY = `/api/archives/${A}/entries/ent_1/summary`;

const record = (status: string, extra: Record<string, unknown> = {}) => ({
  summary_uid: "sum_1",
  entry_uid: "ent_1",
  provider_kind: "anthropic_http",
  resolved_model: "model-x",
  provider_model: null,
  prompt_version: "v1",
  input_sha256: "abc",
  status,
  summary_text: status === "completed" ? "A short summary." : null,
  error_text: null,
  created_at: "t0",
  updated_at: "t1",
  completed_at: status === "completed" ? "t2" : null,
  ...extra,
});

/** Parse the JSON after the untrusted-data notice line. */
const parse = (result: unknown): Record<string, unknown> => {
  const text = textOf(result);
  expect(text).toStartWith("[untrusted archived data");
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>;
};

let clock: FakeClock;
beforeEach(() => {
  clock = installFakeClock();
});
afterEach(() => clock.restore());

const setup = () => {
  const api = new MockApi();
  return { api, direct: directContext({ api, config: { archive: A } }) };
};

const ARGS = { entry_uid: "ent_1", provider: "anthropic_http" } as const;

describe("get_summary", () => {
  test("returns summary and attempt, marked as untrusted", async () => {
    const { api, direct } = setup();
    api.on("GET", SUMMARY, { json: { entry_uid: "ent_1", summary: record("completed"), attempt: record("failed", { summary_uid: "sum_2", error_text: "provider down" }) } });
    const body = parse(await callTool(getSummary, { entry_uid: "ent_1" }, direct));
    expect(body["summary"]).toMatchObject({ summary_uid: "sum_1", summary_text: "A short summary." });
    expect(body["attempt"]).toMatchObject({ status: "failed", error_text: "provider down" });
  });

  test("no summary yet", async () => {
    const { api, direct } = setup();
    api.on("GET", SUMMARY, { json: { entry_uid: "ent_1", summary: null, attempt: null } });
    expect(parse(await callTool(getSummary, { entry_uid: "ent_1" }, direct))["summary"]).toBeNull();
  });
});

describe("summarize_entry", () => {
  test("200 returns the cached summary without polling", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 200, json: record("completed") });
    const body = parse(await callTool(summarizeEntry, ARGS, direct));
    expect(body).toMatchObject({ cached: true, status: "completed", summary_text: "A short summary." });
    expect(api.calls("GET", SUMMARY)).toHaveLength(0);
    expect(api.calls("POST", SUMMARY)[0]?.json).toEqual({ provider: "anthropic_http", force: false, include_images: false });
  });

  test("202 polls the attempt until it completes", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_1", status: "pending", entry_uid: "ent_1" } });
    api.on(
      "GET",
      SUMMARY,
      sequence([
        { json: { entry_uid: "ent_1", summary: null, attempt: record("pending") } },
        { json: { entry_uid: "ent_1", summary: record("completed"), attempt: record("completed") } },
      ]),
    );
    const result = await callTool(
      summarizeEntry,
      { ...ARGS, force: true, include_images: true, transcribe_engine: "whisper" },
      direct,
    );
    expect(result.isError).toBeUndefined();
    expect(parse(result)).toMatchObject({ status: "completed", summary_text: "A short summary." });
    expect(api.calls("POST", SUMMARY)[0]?.json).toEqual({
      provider: "anthropic_http",
      force: true,
      include_images: true,
      transcribe_engine: "whisper",
    });
    expect(api.calls("GET", SUMMARY)).toHaveLength(2);
  });

  test("ignores an older completed summary and a different attempt until ours finishes", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_new", status: "pending", entry_uid: "ent_1" } });
    api.on(
      "GET",
      SUMMARY,
      sequence([
        { json: { entry_uid: "ent_1", summary: record("completed"), attempt: record("pending", { summary_uid: "sum_new" }) } },
        { json: { entry_uid: "ent_1", summary: record("completed"), attempt: record("completed", { summary_uid: "sum_new", summary_text: "fresh" }) } },
      ]),
    );
    const body = parse(await callTool(summarizeEntry, { ...ARGS, force: true }, direct));
    expect(body).toMatchObject({ summary_uid: "sum_new", summary_text: "fresh" });
  });

  test("a failed attempt is an error result with the server's error_text", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_1", status: "pending", entry_uid: "ent_1" } });
    api.on("GET", SUMMARY, { json: { entry_uid: "ent_1", summary: null, attempt: record("failed", { error_text: "provider returned 500" }) } });
    const result = await callTool(summarizeEntry, ARGS, direct);
    expect(result.isError).toBe(true);
    expect(parse(result)["error_text"]).toBe("provider returned 500");
  });

  test("timeout is a non-error running result (default 300s, params override)", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_1", status: "pending", entry_uid: "ent_1" } });
    api.on("GET", SUMMARY, { json: { entry_uid: "ent_1", summary: null, attempt: record("pending") } });
    const result = await callTool(summarizeEntry, ARGS, direct);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "running", summary_uid: "sum_1" });
    expect(clock.elapsed()).toBe(300_000);
    const quick = await callTool(summarizeEntry, { ...ARGS, wait_timeout_s: 3 }, direct);
    expect(JSON.parse(textOf(quick)).status).toBe("running");
  });

  test("wait=false returns the pending handle immediately", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_1", status: "pending", entry_uid: "ent_1" } });
    const result = await callTool(summarizeEntry, { ...ARGS, wait: false }, direct);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "pending", summary_uid: "sum_1" });
    expect(api.calls("GET", SUMMARY)).toHaveLength(0);
  });

  test("abort stops polling only and says generation continues", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 202, json: { summary_uid: "sum_1", status: "pending", entry_uid: "ent_1" } });
    api.on("GET", SUMMARY, { json: { entry_uid: "ent_1", summary: null, attempt: record("pending") } });
    const controller = new AbortController();
    clock.abortOnSleep(controller);
    const ctx = toToolContext(direct.base, { signal: controller.signal });
    const result = await summarizeEntry.execute({ ...ARGS, force: false, include_images: false, wait: true, wait_timeout_s: 60 }, ctx);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "aborted" });
    expect(textOf(result)).toContain("continues on the server");
  });

  test("400 names the missing environment variable", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 400, json: { error: "missing required environment variable: ARCHIVR_ANTHROPIC_API_KEY" } });
    const result = await callTool(summarizeEntry, ARGS, direct);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ARCHIVR_ANTHROPIC_API_KEY");
    expect(api.calls("GET", SUMMARY)).toHaveLength(0);
  });

  test("rejects an unknown provider via the schema", async () => {
    const { direct } = setup();
    await expect(callTool(summarizeEntry, { entry_uid: "ent_1", provider: "gpt" }, direct)).rejects.toThrow();
  });

  test("canary token and password are redacted from errors", async () => {
    const { api, direct } = setup();
    api.on("POST", SUMMARY, { status: 500, json: { error: `leak ${CANARY_TOKEN} ${CANARY_PASSWORD}` } });
    const result = await callTool(summarizeEntry, ARGS, direct);
    expect(textOf(result)).not.toContain(CANARY_TOKEN);
  });
});

describe("generate_thread_title and transcription engines", () => {
  test("generate_thread_title posts the provider and returns the saved title", async () => {
    const { api, direct } = setup();
    api.on("POST", `/api/archives/${A}/entries/ent_1/thread-title`, { json: { entry_uid: "ent_1", title: "A Thread" } });
    const result = await callTool(generateThreadTitle, ARGS, direct);
    expect(JSON.parse(textOf(result))).toEqual({ entry_uid: "ent_1", title: "A Thread" });
    expect(api.requests[0]?.json).toEqual({ provider: "anthropic_http" });
    expect(generateThreadTitle.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  test("generate_thread_title uses a long request timeout", async () => {
    const { api, direct } = setup();
    let signalSeen = false;
    api.on("POST", `/api/archives/${A}/entries/ent_1/thread-title`, (req) => {
      signalSeen = req.signal !== undefined;
      return { json: { entry_uid: "ent_1", title: "T" } };
    });
    await callTool(generateThreadTitle, ARGS, direct);
    expect(signalSeen).toBe(true);
  });

  test("generate_thread_title surfaces a missing-env 400", async () => {
    const { api, direct } = setup();
    api.on("POST", `/api/archives/${A}/entries/ent_1/thread-title`, { status: 400, json: { error: "missing required environment variable: ARCHIVR_OPENAI_API_KEY" } });
    const result = await callTool(generateThreadTitle, { entry_uid: "ent_1", provider: "openai_compatible" }, direct);
    expect(textOf(result)).toContain("ARCHIVR_OPENAI_API_KEY");
  });

  test("list_transcription_engines", async () => {
    const { api, direct } = setup();
    api.on("GET", "/api/summary/transcription-engines", { json: [{ kind: "whisper", label: "Whisper", english_only: false, languages: ["en"] }] });
    const result = await callTool(listTranscriptionEngines, {}, direct);
    expect(JSON.parse(textOf(result))).toEqual({ engines: [{ kind: "whisper", label: "Whisper", english_only: false, languages: ["en"] }] });
  });
});
