import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolUserError } from "../client/errors";
import { seg } from "../client/http";
import {
  CaptureAcceptedSchema,
  PlaylistProbeResultSchema,
  ProbeResultSchema,
  TextTitleResponseSchema,
  UploadResultSchema,
} from "../client/schemas";
import { resolveUploadFile } from "../lib/files";
import { openMultipartFile } from "../lib/multipart";
import { jsonResult } from "../lib/output";
import type { ToolContext } from "./context";
import {
  CAPTURE_WAIT_S,
  jobOutcomeResult,
  waitForJob,
  waitInput,
} from "./jobs";
import { archiveInput, confirmInput, defineTool, DESTRUCTIVE, openWorld, READ, WRITE, type ToolModule } from "./registry";

// ── Shared pieces ───────────────────────────────────────────────────────────

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Uploads can be large; the request timeout covers the whole transfer. */
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** yt-dlp metadata probes can take a while. */
const PROBE_TIMEOUT_MS = 3 * 60 * 1000;

export const PROVIDERS = ["anthropic_http", "openai_compatible", "claude_cli", "codex_cli"] as const;
export const providerInput = z
  .enum(PROVIDERS)
  .describe("LLM provider configured on the Archivr server (its API key / CLI must be set in the server environment).");

const qualityValue = z
  .string()
  .regex(/^(best|audio|\d+p)$/, { error: 'must be "best", "audio" or a height like "1080p"' });

const fileOptionInputs = {
  quality: qualityValue.optional().describe('Video quality cap: "best" (default), "audio", or a height such as "1080p"'),
  ublock_enabled: z.boolean().optional().describe("Override the instance uBlock setting for this capture (web pages)"),
  reader_mode: z.boolean().optional().describe("Distil web pages to article content (Readability) before archiving"),
  cookie_ext_enabled: z.boolean().optional().describe("Override the cookie-consent extension setting for this capture"),
  modal_closer_enabled: z.boolean().optional().describe("Override the modal-closer setting for this capture"),
};

const urlOptionInputs = {
  ...fileOptionInputs,
  via_freedium: z.boolean().optional().describe("Route web pages through the Freedium mirror (server default: on)"),
  download_subtitles: z.boolean().optional().describe("Download YouTube subtitles (server default: on)"),
  per_item_quality: z
    .record(z.string(), qualityValue)
    .optional()
    .describe(
      "Playlist captures only: map of yt-dlp video id -> quality. A NON-EMPTY map acts as an INCLUDE-LIST: only the " +
        "listed videos are downloaded and all others are skipped. Omit (or pass {}) to download every item using `quality` as a cap.",
    ),
  sync: z
    .boolean()
    .optional()
    .describe("Playlist captures only: skip items already archived under an existing container (retry only the missing ones)"),
};

const BODY_KEYS = [
  "quality",
  "ublock_enabled",
  "reader_mode",
  "cookie_ext_enabled",
  "modal_closer_enabled",
  "via_freedium",
  "download_subtitles",
  "per_item_quality",
  "sync",
] as const;

/** Copy the defined capture options into a request body. */
function captureBody(locator: string, args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { locator };
  for (const key of BODY_KEYS) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

const FILE_LOCATOR = /^\s*file:/i;

const capturesPath = (archive: string): string => `/api/archives/${seg(archive)}/captures`;

async function postCapture(ctx: ToolContext, path: string, body: unknown) {
  return ctx.client.request("POST", path, { json: body, schema: CaptureAcceptedSchema });
}

/** After a 202: return the job_uid immediately, or poll until the job finishes. */
async function finishCapture(
  ctx: ToolContext,
  archive: string,
  accepted: { job_uid: string; status: string },
  args: { wait: boolean; wait_timeout_s: number },
  extra: Record<string, unknown> = {},
): Promise<CallToolResult> {
  if (!args.wait) {
    return jsonResult({
      status: accepted.status,
      job_uid: accepted.job_uid,
      ...extra,
      hint: "Capture accepted. Call get_capture_job with this job_uid (wait=true to wait) to get the result.",
    });
  }
  const outcome = await waitForJob(ctx, archive, accepted.job_uid, args.wait_timeout_s);
  return jobOutcomeResult(outcome, accepted.job_uid, {
    waitedS: args.wait_timeout_s,
    failedAsError: true,
    extra,
  });
}

function checkTextBody(body: string, field = "body"): void {
  if (body.trim() === "") throw new ToolUserError(`${field} must not be empty.`);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_TEXT_BYTES) {
    throw new ToolUserError(`${field} is ${bytes} bytes, over the 2 MiB (${MAX_TEXT_BYTES} byte) limit.`);
  }
}

const WAIT_NOTE =
  "With wait=true (default) this polls the server job and returns the final result, including entry_uids and per-item outcomes; " +
  "on timeout it returns {status:'running', job_uid} (not an error) and the job keeps running. Cancelling the MCP request only stops polling.";

// ── Capture tools ───────────────────────────────────────────────────────────

export const captureUrl = defineTool({
  name: "capture_url",
  title: "Capture a URL",
  description:
    "Archive a URL (web page, tweet, YouTube video/playlist/channel, Reddit, Instagram, TikTok, ...) into an archive. " +
    "Playlists archive each video as a child entry; a playlist where some videos fail ends 'completed' with partial=true. " +
    "`file:` locators are rejected here: use capture_file for local files. " +
    WAIT_NOTE,
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(WRITE),
  input: {
    ...archiveInput,
    locator: z.string().min(1).describe("The URL (or supported shorthand) to archive"),
    ...urlOptionInputs,
    ...waitInput(CAPTURE_WAIT_S),
  },
  async handler(args, ctx) {
    if (FILE_LOCATOR.test(args.locator)) {
      throw new ToolUserError("file: locators are not accepted by capture_url. Use capture_file to archive a local file.");
    }
    const archive = await ctx.archive(args);
    const accepted = await postCapture(ctx, capturesPath(archive), captureBody(args.locator.trim(), args));
    return finishCapture(ctx, archive, accepted, args);
  },
});

export const captureText = defineTool({
  name: "capture_text",
  title: "Capture text",
  description:
    "Archive a piece of text (a note, article body, snippet) as a new entry with the given title. Body is at most 2 MiB. " +
    WAIT_NOTE,
  toolset: "capture",
  minRole: "user",
  annotations: WRITE,
  input: {
    ...archiveInput,
    title: z.string().min(1).describe("Entry title"),
    body: z.string().min(1).describe("The text to archive (max 2 MiB)"),
    mime: z.enum(["text/plain", "text/markdown"]).default("text/markdown").describe("Text format (default text/markdown)"),
    ...waitInput(CAPTURE_WAIT_S),
  },
  async handler(args, ctx) {
    if (args.title.trim() === "") throw new ToolUserError("title must not be empty.");
    checkTextBody(args.body);
    const archive = await ctx.archive(args);
    const accepted = await postCapture(ctx, `${capturesPath(archive)}/text`, {
      title: args.title,
      body: args.body,
      mime: args.mime,
    });
    return finishCapture(ctx, archive, accepted, args);
  },
});

export const captureFile = defineTool({
  name: "capture_file",
  title: "Capture a local file",
  description:
    "Upload a file from the machine running this MCP server and archive it. The path must be absolute, inside " +
    "ARCHIVR_MCP_UPLOAD_ROOTS, not on the sensitive-file denylist (keys, .env, credentials) and within the configured size limit " +
    "(ARCHIVR_MCP_MAX_UPLOAD_BYTES, default 2 GiB). The file is streamed, not loaded into memory. " +
    "The file is uploaded to Archivr as a staged upload, then captured; if the capture request fails the staged upload is deleted. " +
    WAIT_NOTE,
  toolset: "capture",
  minRole: "user",
  annotations: WRITE,
  input: {
    ...archiveInput,
    path: z.string().min(1).describe("Absolute path of the file to archive"),
    ...fileOptionInputs,
    ...waitInput(CAPTURE_WAIT_S),
  },
  async handler(args, ctx) {
    const file = await resolveUploadFile(args.path, { roots: ctx.config.uploadRoots, maxBytes: ctx.config.maxUploadBytes });
    const archive = await ctx.archive(args);
    // Hand-built multipart body streamed from disk (see lib/multipart.ts): Bun would buffer a
    // FormData file part entirely in memory. Only the basename is sent as the filename.
    const multipart = await openMultipartFile({
      path: file.realPath,
      size: file.size,
      fileName: file.name,
      contentType: Bun.file(file.realPath).type,
    });
    const uploadsPath = `/api/archives/${seg(archive)}/uploads`;
    let upload;
    try {
      upload = await ctx.client.request("POST", uploadsPath, {
        body: {
          stream: multipart.stream,
          contentType: multipart.contentType,
          contentLength: multipart.contentLength,
        },
        schema: UploadResultSchema,
        timeoutMs: UPLOAD_TIMEOUT_MS,
      });
    } catch (error) {
      // A read failure mid-upload surfaces from fetch as a generic network error; report the real cause.
      throw multipart.failure() ?? error;
    } finally {
      await multipart.dispose();
    }
    let accepted;
    try {
      accepted = await postCapture(ctx, capturesPath(archive), captureBody(upload.locator, args));
    } catch (error) {
      try {
        await ctx.client.request("DELETE", uploadsPath, { json: { locator: upload.locator } });
      } catch {
        // Best effort: the server also prunes stale staged uploads.
      }
      throw error;
    }
    return finishCapture(ctx, archive, accepted, args, { uploaded: { filename: upload.filename, size: upload.size } });
  },
});

export const rearchiveEntry = defineTool({
  name: "rearchive_entry",
  title: "Re-archive an entry",
  description:
    "DESTRUCTIVE: re-fetch an existing tweet or tweet-thread entry from the network and, on success, replace the entry's archived " +
    "artifacts (the raw tweet JSON files and their media) with the freshly scraped ones; the previous versions are no longer attached " +
    "to the entry. Its uid, title, archived time, tags and collections stay. If the scraper fails (tweet deleted or private) the existing archived data is preserved unchanged. " +
    "Only tweet entries are supported (other kinds end as a failed job). Requires confirm: true. " +
    WAIT_NOTE,
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(DESTRUCTIVE),
  input: {
    ...archiveInput,
    entry_uid: z.string().min(1).describe("Tweet or tweet_thread entry to refresh"),
    ...confirmInput,
    ...waitInput(CAPTURE_WAIT_S),
  },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const accepted = await postCapture(
      ctx,
      `/api/archives/${seg(archive)}/entries/${seg(args.entry_uid)}/rearchive`,
      undefined,
    );
    return finishCapture(ctx, archive, accepted, args, { entry_uid: args.entry_uid });
  },
});

// ── Probes and titles ───────────────────────────────────────────────────────

export const probeUrl = defineTool({
  name: "probe_url",
  title: "Probe a URL for video qualities",
  description:
    "Run yt-dlp against a URL to list the video qualities available before capturing (use values with capture_url quality). " +
    "Returns {has_video:false} for non-video locators. A 502 means the probe was inconclusive, not that there is no video.",
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(READ),
  input: { ...archiveInput, locator: z.string().min(1).describe("URL to probe") },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const result = await ctx.client.request("GET", `${capturesPath(archive)}/probe`, {
      query: { locator: args.locator },
      schema: ProbeResultSchema,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return jsonResult(result);
  },
});

export const probePlaylist = defineTool({
  name: "probe_playlist",
  title: "Probe a playlist",
  description:
    "List the items (id, url, title, qualities) of a YouTube playlist/channel, YouTube Music playlist or Spotify album/playlist " +
    "before capturing. Use the item ids as keys of capture_url per_item_quality to archive only some of them. " +
    "Makes no changes (but it is a POST, so read-scope API tokens are refused with 403).",
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(READ),
  input: { ...archiveInput, locator: z.string().min(1).describe("Playlist, channel or album URL") },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    const result = await ctx.client.request("POST", `${capturesPath(archive)}/probe-playlist`, {
      json: { locator: args.locator },
      schema: PlaylistProbeResultSchema,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return jsonResult(result);
  },
});

export const generateTextTitle = defineTool({
  name: "generate_text_title",
  title: "Suggest a title for text",
  description:
    "Ask an LLM provider configured on the Archivr server to suggest a title for a text body (max 2 MiB). Nothing is saved: " +
    "pass the title to capture_text. A 400 names the missing server environment variable. (POST: refused for read-scope tokens.)",
  toolset: "capture",
  minRole: "user",
  annotations: openWorld(READ),
  input: {
    ...archiveInput,
    body: z.string().min(1).describe("The text to title (max 2 MiB)"),
    provider: providerInput,
  },
  async handler(args, ctx) {
    checkTextBody(args.body);
    const archive = await ctx.archive(args);
    const result = await ctx.client.request("POST", `${capturesPath(archive)}/text/title`, {
      json: { body: args.body, provider: args.provider },
      schema: TextTitleResponseSchema,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return jsonResult({ title: result.title });
  },
});

export const captureTools: ToolModule = () => [
  captureUrl,
  captureText,
  captureFile,
  probeUrl,
  probePlaylist,
  generateTextTitle,
  rearchiveEntry,
];
