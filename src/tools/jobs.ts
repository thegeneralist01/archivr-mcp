import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { seg } from "../client/http";
import { pollUntil, type Sleep } from "../client/polling";
import {
  CaptureJobListSchema,
  CaptureJobSchema,
  RunSummaryListSchema,
  type CaptureJob,
} from "../client/schemas";
import { jsonResult, paginate, paginationInput } from "../lib/output";
import type { ToolContext } from "./context";
import { archiveInput, defineTool, READ, type ToolModule } from "./registry";

// ── Shared wait/poll machinery (also used by capture.ts and summaries.ts) ───

/**
 * Test seam: when set, `sleep`/`now` are passed to every `pollUntil` call made by the
 * capture, jobs and summaries tools so tests run instantly. Production code never sets it.
 */
export const pollHooks: { sleep?: Sleep; now?: () => number } = {};

export const MAX_WAIT_S = 900;
export const CAPTURE_WAIT_S = 120;
export const SUMMARY_WAIT_S = 300;

/** Spread into the input of a tool that can wait for an async job. */
export function waitInput(defaultTimeoutS: number, defaultWait = true) {
  return {
    wait: z
      .boolean()
      .default(defaultWait)
      .describe(
        `If true, poll until the server job finishes (or wait_timeout_s elapses) and return the final result. ` +
          `If false, return the job_uid immediately. A timeout is NOT an error: the job keeps running on the server.`,
      ),
    wait_timeout_s: z
      .number()
      .int()
      .min(1)
      .max(MAX_WAIT_S)
      .default(defaultTimeoutS)
      .describe(`Seconds to wait when wait is true (default ${defaultTimeoutS}, max ${MAX_WAIT_S}).`),
  };
}

export type WaitOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "timeout"; last: T | undefined }
  | { kind: "aborted"; last: T | undefined };

/** Poll `fn` until `isDone`, reporting each tick as an MCP progress notification. */
export async function waitFor<T>(
  ctx: ToolContext,
  timeoutS: number,
  fn: (signal: AbortSignal | undefined) => Promise<T>,
  isDone: (value: T) => boolean,
  describe: (value: T) => string,
): Promise<WaitOutcome<T>> {
  const result = await pollUntil(fn, {
    isDone,
    intervalMs: 1000,
    backoff: 1.5,
    maxIntervalMs: 5000,
    timeoutMs: timeoutS * 1000,
    signal: ctx.signal,
    onTick: (value, tick) => ctx.progress({ progress: tick.attempt, message: describe(value) }),
    ...pollHooks,
  });
  if (result.status === "done") return { kind: "done", value: result.value };
  return { kind: result.status, last: result.last };
}

// ── Capture jobs ────────────────────────────────────────────────────────────

const TERMINAL_JOB = new Set(["completed", "failed"]);

export const isTerminalJob = (job: CaptureJob): boolean => TERMINAL_JOB.has(job.status);

export const jobPath = (archive: string, jobUid: string): string =>
  `/api/archives/${seg(archive)}/capture_jobs/${seg(jobUid)}`;

/** Wait for a capture job to reach `completed` or `failed`. */
export function waitForJob(ctx: ToolContext, archive: string, jobUid: string, timeoutS: number) {
  return waitFor(
    ctx,
    timeoutS,
    (signal) => ctx.client.request("GET", jobPath(archive, jobUid), { schema: CaptureJobSchema, signal }),
    isTerminalJob,
    (job) => {
      const items = job.items ?? [];
      const done = items.filter((i) => i.status === "completed" || i.status === "failed").length;
      return items.length > 0 ? `job ${job.status}: ${done}/${items.length} items finished` : `job ${job.status}`;
    },
  );
}

function parseNotes(notesJson: string | null): unknown {
  if (notesJson === null || notesJson === "") return undefined;
  try {
    return JSON.parse(notesJson) as unknown;
  } catch {
    return undefined; // notes are advisory; never fail a tool over them
  }
}

/** Model-facing view of a job: ids, status, produced entries, per-item outcomes, partial-playlist flag. */
export function describeJob(job: CaptureJob): Record<string, unknown> {
  const items = job.items ?? [];
  const failedItems = items.filter((i) => i.status === "failed").length;
  const notes = parseNotes(job.notes_json);
  const partial = job.status === "completed" && failedItems > 0;
  return {
    job_uid: job.job_uid,
    status: job.status,
    run_uid: job.run_uid,
    error_text: job.error_text,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.created_by === undefined ? {} : { created_by: job.created_by }),
    entry_uids: job.entry_uids ?? [],
    items,
    ...(job.items_truncated === true ? { items_truncated: true } : {}),
    ...(notes === undefined ? {} : { notes }),
    ...(partial
      ? {
          partial: true,
          failed_items: failedItems,
          hint:
            `Partial playlist: the job completed but ${failedItems} of ${items.length} item(s) failed. ` +
            "entry_uids lists only the items that were archived; see items[].error_text. " +
            "Re-capture the playlist with sync=true to retry the missing items without duplicating archived ones.",
        }
      : {}),
  };
}

/**
 * Turn the outcome of waiting for a job into a tool result. A failed job is an error
 * result when `failedAsError` (capture tools); a timeout or abort is a normal result.
 */
export function jobOutcomeResult(
  outcome: WaitOutcome<CaptureJob>,
  jobUid: string,
  options: { waitedS: number; failedAsError: boolean; extra?: Record<string, unknown> },
): CallToolResult {
  const extra = options.extra ?? {};
  if (outcome.kind === "done") {
    const body = { ...describeJob(outcome.value), ...extra };
    return options.failedAsError && outcome.value.status === "failed"
      ? { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] }
      : jsonResult(body);
  }
  const serverStatus = outcome.last?.status;
  if (outcome.kind === "aborted") {
    return jsonResult({
      status: "aborted",
      job_uid: jobUid,
      ...(serverStatus === undefined ? {} : { server_status: serverStatus }),
      ...extra,
      hint: "Polling was cancelled. The job is NOT cancelled: it continues on the server. Check it with get_capture_job.",
    });
  }
  return jsonResult({
    status: "running",
    job_uid: jobUid,
    ...(serverStatus === undefined ? {} : { server_status: serverStatus }),
    ...extra,
    hint:
      `Still running after ${options.waitedS}s; the job continues on the server. ` +
      "Call get_capture_job with this job_uid (wait=true to wait longer) to get the result.",
  });
}

/** Build a page result from rows fetched with `limit + 1` and the caller's offset. */
function serverPageResult<T>(rows: readonly T[], limit: number, offset: number): CallToolResult {
  // A server that ignored limit/offset returns everything: slice client-side instead.
  const page = rows.length > limit + 1 ? paginate(rows, { limit, offset }) : undefined;
  const items = page ? page.items : rows.slice(0, limit);
  const hasMore = page ? page.hasMore : rows.length > limit;
  return jsonResult({
    offset,
    returned: items.length,
    has_more: hasMore,
    next_offset: hasMore ? offset + items.length : null,
    items,
  });
}

export const listCaptureJobs = defineTool({
  name: "list_capture_jobs",
  title: "List capture jobs",
  description:
    "List capture jobs in an archive, newest first (status pending|running|completed|failed). " +
    "Role scoping is enforced by the server: normal users see only the jobs they created; admins see all jobs " +
    "(jobs created by the CLI or before job ownership existed are admin-only). `created_by` takes a user_uid or 'me'; " +
    "a non-admin asking for another user's jobs gets 403. Rows are summaries: use get_capture_job for entry_uids and per-item outcomes.",
  toolset: "capture",
  minRole: "user",
  annotations: READ,
  input: {
    ...archiveInput,
    status: z.enum(["pending", "running", "completed", "failed"]).optional().describe("Only jobs in this state"),
    created_by: z.string().min(1).optional().describe("Creator user_uid or 'me' (admins may pass any user_uid)"),
    ...paginationInput,
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const rows = await ctx.client.request("GET", `/api/archives/${seg(archive)}/capture_jobs`, {
      query: { status: args.status, created_by: args.created_by, limit: args.limit + 1, offset: args.offset },
      schema: CaptureJobListSchema,
    });
    return serverPageResult(
      rows.map((job) => ({ ...describeJobRow(job) })),
      args.limit,
      args.offset,
    );
  },
});

/** A list row: no items/entries (the list endpoint does not return them). */
function describeJobRow(job: CaptureJob): Record<string, unknown> {
  return {
    job_uid: job.job_uid,
    status: job.status,
    run_uid: job.run_uid,
    error_text: job.error_text,
    created_at: job.created_at,
    updated_at: job.updated_at,
    created_by: job.created_by ?? null,
  };
}

export const getCaptureJob = defineTool({
  name: "get_capture_job",
  title: "Get capture job",
  description:
    "Get one capture job: status, error_text, produced entry_uids and per-item outcomes (items[], capped at 200; a " +
    "completed job with failed items is a partial playlist). With wait=true, poll until the job finishes or " +
    "wait_timeout_s elapses; a timeout returns {status:'running'} (not an error). Another user's job returns 404.",
  toolset: "capture",
  minRole: "user",
  annotations: READ,
  input: {
    ...archiveInput,
    job_uid: z.string().min(1).describe("job_uid returned by a capture tool"),
    ...waitInput(CAPTURE_WAIT_S, false),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const job = await ctx.client.request("GET", jobPath(archive, args.job_uid), { schema: CaptureJobSchema });
    if (!args.wait || isTerminalJob(job)) return jsonResult(describeJob(job));
    const outcome = await waitForJob(ctx, archive, args.job_uid, args.wait_timeout_s);
    return jobOutcomeResult(outcome, args.job_uid, { waitedS: args.wait_timeout_s, failedAsError: false });
  },
});

export const listRuns = defineTool({
  name: "list_runs",
  title: "List archive runs",
  description:
    "List capture runs (one run per capture, including each item of a playlist), newest first. Visibility follows access: " +
    "admins see all runs; others see runs from jobs they created or that produced an entry they can see. " +
    "A run is linked to its job only once the job finishes, so a creator will not see their in-progress run here until it completes " +
    "(use list_capture_jobs / get_capture_job for in-progress work).",
  toolset: "capture",
  minRole: "user",
  annotations: READ,
  input: { ...archiveInput, ...paginationInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const rows = await ctx.client.request("GET", `/api/archives/${seg(archive)}/runs`, {
      query: { limit: args.limit + 1, offset: args.offset },
      schema: RunSummaryListSchema,
    });
    return serverPageResult(rows, args.limit, args.offset);
  },
});

export const jobsTools: ToolModule = () => [listCaptureJobs, getCaptureJob, listRuns];
