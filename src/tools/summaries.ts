import { z } from "zod";
import { seg } from "../client/http";
import {
  EntrySummaryRecordSchema,
  EntrySummaryResponseSchema,
  ThreadTitleResponseSchema,
  TranscriptionEngineListSchema,
  type EntrySummaryRecord,
} from "../client/schemas";
import { jsonResult, untrustedText } from "../lib/output";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context";
import { providerInput } from "./capture";
import { MAX_WAIT_S, SUMMARY_WAIT_S, waitFor, waitInput } from "./jobs";
import { archiveInput, defineTool, openWorld, READ, WRITE, type ToolModule } from "./registry";

/** Generation of a thread title is synchronous server-side (one LLM call). */
const TITLE_TIMEOUT_MS = 3 * 60 * 1000;

const summaryPath = (archive: string, entryUid: string): string =>
  `/api/archives/${seg(archive)}/entries/${seg(entryUid)}/summary`;

function summaryView(record: EntrySummaryRecord): Record<string, unknown> {
  return {
    summary_uid: record.summary_uid,
    status: record.status,
    provider_kind: record.provider_kind,
    resolved_model: record.resolved_model,
    summary_text: record.summary_text,
    error_text: record.error_text,
    created_at: record.created_at,
    completed_at: record.completed_at,
  };
}

/** Summary text is model output derived from archived content: mark it untrusted. */
function summaryResult(body: Record<string, unknown>, isError = false): CallToolResult {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: untrustedText(JSON.stringify(body)) }] };
}

export const getSummary = defineTool({
  name: "get_summary",
  title: "Get entry summary",
  description:
    "Read the latest completed summary of an entry (summary: null if none was generated yet) and the latest generation attempt " +
    "(pending, completed or failed, with error_text). Summaries are only created by summarize_entry.",
  toolset: "capture",
  minRole: "user",
  annotations: READ,
  input: { ...archiveInput, entry_uid: z.string().min(1).describe("Entry uid") },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const res = await ctx.client.request("GET", summaryPath(archive, args.entry_uid), {
      schema: EntrySummaryResponseSchema,
    });
    return summaryResult({
      entry_uid: res.entry_uid,
      summary: res.summary ? summaryView(res.summary) : null,
      attempt: res.attempt ? summaryView(res.attempt) : null,
    });
  },
});

async function waitForSummary(
  ctx: ToolContext,
  archive: string,
  entryUid: string,
  summaryUid: string,
  timeoutS: number,
): Promise<CallToolResult> {
  const finalRecord = (res: z.output<typeof EntrySummaryResponseSchema>): EntrySummaryRecord | undefined => {
    if (res.attempt?.summary_uid === summaryUid && res.attempt.status !== "pending") return res.attempt;
    if (res.summary?.summary_uid === summaryUid && res.summary.status === "completed") return res.summary;
    return undefined;
  };
  const outcome = await waitFor(
    ctx,
    timeoutS,
    (signal) =>
      ctx.client.request("GET", summaryPath(archive, entryUid), { schema: EntrySummaryResponseSchema, signal }),
    (res) => finalRecord(res) !== undefined,
    () => "summary pending",
  );
  if (outcome.kind === "done") {
    const record = finalRecord(outcome.value);
    if (record === undefined) return jsonResult({ status: "pending", summary_uid: summaryUid }); // unreachable
    return summaryResult({ entry_uid: entryUid, ...summaryView(record) }, record.status === "failed");
  }
  if (outcome.kind === "aborted") {
    return jsonResult({
      status: "aborted",
      entry_uid: entryUid,
      summary_uid: summaryUid,
      hint: "Polling was cancelled. Generation is NOT cancelled: it continues on the server. Check it with get_summary.",
    });
  }
  return jsonResult({
    status: "running",
    entry_uid: entryUid,
    summary_uid: summaryUid,
    hint: `Still generating after ${timeoutS}s; it continues on the server. Call get_summary for this entry_uid later.`,
  });
}

export const summarizeEntry = defineTool({
  name: "summarize_entry",
  title: "Summarize entry",
  description:
    "Generate an LLM summary of an entry with a provider configured on the Archivr server. Returns a cached completed summary " +
    "immediately when the same content/provider was already summarized (unless force=true); otherwise generation runs in the " +
    "background and, with wait=true (default), this polls until it completes or fails. A timeout returns {status:'running'} " +
    "(not an error): use get_summary later. A 400 error names the missing server environment variable or the unsupported content. " +
    "YouTube videos without subtitles can be transcribed locally with transcribe_engine (see list_transcription_engines).",
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(WRITE),
  input: {
    ...archiveInput,
    entry_uid: z.string().min(1).describe("Entry uid"),
    provider: providerInput,
    force: z.boolean().default(false).describe("Regenerate even if an identical summary is cached"),
    include_images: z.boolean().default(false).describe("Attach the entry's images (HTTP providers and codex_cli; not claude_cli)"),
    transcribe_engine: z
      .string()
      .min(1)
      .optional()
      .describe("Local transcription engine kind from list_transcription_engines; used only for YouTube videos without subtitles"),
    ...waitInput(SUMMARY_WAIT_S),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const response = await ctx.client.response("POST", summaryPath(archive, args.entry_uid), {
      json: {
        provider: args.provider,
        force: args.force,
        include_images: args.include_images,
        ...(args.transcribe_engine === undefined ? {} : { transcribe_engine: args.transcribe_engine }),
      },
      schema: z.looseObject({ summary_uid: z.string(), status: z.string() }),
    });
    if (response.status === 200) {
      const record = EntrySummaryRecordSchema.safeParse(response.body);
      return summaryResult({
        entry_uid: args.entry_uid,
        cached: true,
        ...(record.success ? summaryView(record.data) : { summary_uid: response.body.summary_uid, status: response.body.status }),
      });
    }
    const summaryUid = response.body.summary_uid;
    if (!args.wait) {
      return jsonResult({
        status: "pending",
        entry_uid: args.entry_uid,
        summary_uid: summaryUid,
        hint: "Generation started. Call get_summary for this entry_uid to read the result.",
      });
    }
    return waitForSummary(ctx, archive, args.entry_uid, summaryUid, Math.min(args.wait_timeout_s, MAX_WAIT_S));
  },
});

export const generateThreadTitle = defineTool({
  name: "generate_thread_title",
  title: "Generate thread title",
  description:
    "Name an X (Twitter) thread entry with a cheap LLM from a server-configured provider and SAVE the result as the entry title " +
    "(overwrites the current title). Synchronous; may take up to a minute. A 400 names the missing server environment variable; " +
    "non-thread entries are rejected.",
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(WRITE),
  input: { ...archiveInput, entry_uid: z.string().min(1).describe("Thread entry uid"), provider: providerInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const result = await ctx.client.request(
      "POST",
      `/api/archives/${seg(archive)}/entries/${seg(args.entry_uid)}/thread-title`,
      { json: { provider: args.provider }, schema: ThreadTitleResponseSchema, timeoutMs: TITLE_TIMEOUT_MS },
    );
    return jsonResult({ entry_uid: result.entry_uid, title: result.title });
  },
});

export const listTranscriptionEngines = defineTool({
  name: "list_transcription_engines",
  title: "List transcription engines",
  description:
    "List the local speech-to-text engines enabled on the Archivr server (kind, label, languages). An empty list means " +
    "transcription is off. Pass a kind as summarize_entry transcribe_engine.",
  toolset: "capture",
  minRole: "user",
  annotations: READ,
  input: {},
  async handler(_args, ctx) {
    const engines = await ctx.client.request("GET", "/api/summary/transcription-engines", {
      schema: TranscriptionEngineListSchema,
    });
    return jsonResult({ engines });
  },
});

export const summariesTools: ToolModule = () => [
  getSummary,
  summarizeEntry,
  generateThreadTitle,
  listTranscriptionEngines,
];
