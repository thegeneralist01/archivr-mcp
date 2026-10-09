import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { ToolUserError } from "../client/errors";

/**
 * Hand-built, streaming `multipart/form-data` body for one file.
 *
 * Bun's `fetch` buffers `FormData` file parts in memory (a 200 MB `Bun.file()` grew RSS by
 * about 425 MB), so uploads instead send a `ReadableStream` that reads the file in fixed-size
 * chunks on demand. Memory use is independent of the file size.
 *
 * Wire layout (the byte count is exact, so the caller can send a Content-Length header):
 *
 *     --B CRLF
 *     Content-Disposition: form-data; name="file"; filename="<basename>" CRLF
 *     Content-Type: <type> CRLF CRLF
 *     <file bytes>
 *     CRLF --B-- CRLF
 */

const CHUNK_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export interface MultipartFileOptions {
  /** File to send. Only its basename ever reaches the wire. */
  path: string;
  /** Size in bytes the caller validated (`stat`). The body is exactly this long or the upload fails. */
  size: number;
  /** Form field name (default `file`). */
  fieldName?: string;
  /** Overrides the filename derived from `path` (its basename is used). */
  fileName?: string;
  /** Part Content-Type (default `application/octet-stream`). */
  contentType?: string;
  /** Test hook. Must not occur in the file. Default: random. */
  boundary?: string;
  /** Read granularity (default 1 MiB). */
  chunkBytes?: number;
}

export interface MultipartFileBody {
  /** Pull-based body; give it to `fetch` / `ArchivrClient`. Reads the file lazily. */
  readonly stream: ReadableStream<Uint8Array>;
  /** `multipart/form-data; boundary=...` for the request's Content-Type header. */
  readonly contentType: string;
  /** Exact byte length of the whole body. */
  readonly contentLength: number;
  readonly boundary: string;
  /** Set when reading the file failed mid-stream (file changed or became unreadable). */
  failure(): Error | undefined;
  /** Close the file handle. Idempotent; call it in a `finally` in case the stream was never consumed. */
  dispose(): Promise<void>;
}

/**
 * Escape a value for a quoted `Content-Disposition` parameter the way browsers and the
 * WHATWG FormData encoder do: `"`, CR and LF are percent-encoded, so the header cannot be
 * closed early or split. A backslash is replaced because servers disagree on whether it
 * escapes the closing quote; other control characters are replaced too.
 */
export function escapeDispositionValue(value: string): string {
  return value
    .replace(/"/g, "%22")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/[\\\u0000-\u001f\u007f]/g, "_");
}

/** The filename sent on the wire for `source`: its basename only, escaped, never empty. */
export function wireFileName(source: string): string {
  const name = escapeDispositionValue(basename(source));
  return name === "" || name === "." || name === ".." ? "upload" : name;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/**
 * Open `path` and build the streaming multipart body for it. Rejects (ToolUserError) if the
 * file is no longer a regular file of `size` bytes; otherwise the returned body must be
 * consumed or `dispose()`d.
 */
export async function openMultipartFile(options: MultipartFileOptions): Promise<MultipartFileBody> {
  const { path, size } = options;
  const boundary = options.boundary ?? `archivr-mcp-${randomUUID().replace(/-/g, "")}`;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const fieldName = escapeDispositionValue(options.fieldName ?? "file");
  const partType = safeHeaderValue(options.contentType ?? "") || "application/octet-stream";

  const handle = await open(path, "r");
  let closed = false;
  const dispose = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };

  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== size) {
      throw new ToolUserError("The file changed after it was checked. Try again.");
    }
  } catch (error) {
    await dispose();
    throw error;
  }

  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${wireFileName(options.fileName ?? path)}"\r\n` +
      `Content-Type: ${partType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);

  let failure: Error | undefined;
  let cancelled = false;
  // The read currently in flight, if any: cancel waits for it so the descriptor is never closed under a pread.
  let inflight: Promise<unknown> = Promise.resolve();
  let phase: "head" | "file" | "tail" = "head";
  let remaining = size;
  let position = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (phase === "head") {
          controller.enqueue(head);
          phase = remaining > 0 ? "file" : "tail";
        } else if (phase === "file") {
          const buffer = new Uint8Array(Math.min(chunkBytes, remaining));
          const read = handle.read(buffer, 0, buffer.length, position);
          inflight = read.catch(() => undefined);
          const { bytesRead } = await read;
          if (cancelled) return;
          if (bytesRead === 0) throw new ToolUserError("The file became shorter while it was being uploaded. Try again.");
          position += bytesRead;
          remaining -= bytesRead;
          controller.enqueue(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
          if (remaining === 0) {
            phase = "tail";
            await dispose();
          }
        } else {
          controller.enqueue(tail);
          controller.close();
        }
      } catch (error) {
        if (cancelled) return;
        failure = error instanceof ToolUserError ? error : new ToolUserError("The file could not be read while uploading.");
        await dispose();
        controller.error(failure);
      }
    },
    async cancel() {
      cancelled = true;
      await inflight;
      await dispose();
    },
  });

  return {
    stream,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: head.byteLength + size + tail.byteLength,
    boundary,
    failure: () => failure,
    dispose,
  };
}
