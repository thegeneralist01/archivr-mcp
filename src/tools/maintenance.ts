import { ArchivrApiError, ToolUserError } from "../client/errors";
import { seg } from "../client/http";
import { BlobCleanupResultSchema, BlobCleanupScanSchema } from "../client/schemas";
import { jsonResult } from "../lib/output";
import { archiveInput, confirmInput, defineTool, DESTRUCTIVE, READ, type ToolModule } from "./registry";

/** Scanning and deleting walk the blob store on disk. */
const SCAN_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 600_000;
const MAX_REPORTED_ERRORS = 20;

/** 409 means captures or subtitle fetches are active; turn it into advice rather than a bare conflict. */
function busyMessage(error: ArchivrApiError, action: string): ToolUserError {
  const detail = error.serverMessage === "" ? "" : ` Server said: ${error.serverMessage}.`;
  return new ToolUserError(
    `Cannot ${action} right now: captures or subtitle fetches are still in progress.${detail} ` +
      "Wait for them to finish (list_capture_jobs) and try again.",
  );
}

export const blobCleanupScan = defineTool({
  name: "blob_cleanup_scan",
  title: "Scan for orphaned blobs",
  description:
    "Admin. Dry run: count orphaned blob rows and unreferenced files in an archive's blob store and the bytes cleanup would free. " +
    "Changes nothing. Refused (with advice) while captures are running. Run blob_cleanup_run to delete.",
  toolset: "admin",
  minRole: "admin",
  annotations: READ,
  input: { ...archiveInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    try {
      const scan = await ctx.client.request("GET", `/api/archives/${seg(archive)}/blob-cleanup`, {
        schema: BlobCleanupScanSchema,
        timeoutMs: SCAN_TIMEOUT_MS,
      });
      return jsonResult({ archive, ...scan });
    } catch (error) {
      if (error instanceof ArchivrApiError && error.status === 409) throw busyMessage(error, "scan for orphaned blobs");
      throw error;
    }
  },
});

export const blobCleanupRun = defineTool({
  name: "blob_cleanup_run",
  title: "Delete orphaned blobs",
  description:
    "Admin. Permanently delete orphaned blob rows and unreferenced files from an archive's blob store to free disk space. Run blob_cleanup_scan " +
    "first. Refused (409) while captures or subtitle fetches are running. Can take minutes on large archives. Irreversible.",
  toolset: "admin",
  minRole: "admin",
  annotations: DESTRUCTIVE,
  input: { ...archiveInput, ...confirmInput },
  async handler(args, ctx) {
    const archive = await ctx.archive(args);
    try {
      const result = await ctx.client.request("DELETE", `/api/archives/${seg(archive)}/blob-cleanup`, {
        schema: BlobCleanupResultSchema,
        timeoutMs: CLEANUP_TIMEOUT_MS,
      });
      const { errors, ...counts } = result;
      return jsonResult({
        archive,
        ...counts,
        error_count: errors.length,
        errors: errors.slice(0, MAX_REPORTED_ERRORS),
        ...(errors.length > MAX_REPORTED_ERRORS ? { errors_truncated: true } : {}),
      });
    } catch (error) {
      if (error instanceof ArchivrApiError && error.status === 409) throw busyMessage(error, "clean up blobs");
      throw error;
    }
  },
});

export const maintenanceTools: ToolModule = () => [blobCleanupScan, blobCleanupRun];
