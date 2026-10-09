import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolUserError } from "../client/errors";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../config";


/** Directory names that never get uploaded, wherever they appear in the path. */
const DENIED_DIRS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".config/gcloud",
]);

/** File names (or patterns) that never get uploaded. */
const DENIED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|kdbx)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?(\.(json|ya?ml|toml))?$/i,
  /^creds(\.txt)?$/i,
];

export interface UploadCheck {
  roots: readonly string[];
  maxBytes?: number;
}

export interface UploadFile {
  /** Fully resolved real path (symlinks followed). */
  realPath: string;
  size: number;
  name: string;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True if `path` has a denied directory segment or a denied file name. */
export function isDeniedUploadPath(path: string): boolean {
  const normalized = path.split(sep).join("/");
  const segments = normalized.split("/").filter((s) => s !== "");
  const name = segments[segments.length - 1] ?? "";
  if (DENIED_FILE_PATTERNS.some((p) => p.test(name))) return true;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] ?? "";
    if (DENIED_DIRS.has(segment)) return true;
    const pair = `${segment}/${segments[i + 1] ?? ""}`;
    if (DENIED_DIRS.has(pair)) return true;
  }
  return false;
}

/**
 * Validate a local file for upload: realpath, inside an allowed root, not on the
 * denylist, a regular file, within the size cap. Every rejection is a ToolUserError.
 */
export async function resolveUploadFile(inputPath: string, check: UploadCheck): Promise<UploadFile> {
  if (check.roots.length === 0) {
    throw new ToolUserError(
      "File uploads are disabled: set ARCHIVR_MCP_UPLOAD_ROOTS to the directories the server may read from.",
    );
  }
  if (!isAbsolute(inputPath)) throw new ToolUserError("path must be absolute.");

  let real: string;
  try {
    real = await realpath(resolve(inputPath));
  } catch {
    throw new ToolUserError("File not found or not readable.");
  }

  const realRoots: string[] = [];
  for (const root of check.roots) {
    try {
      realRoots.push(await realpath(root));
    } catch {
      // A configured root that does not exist simply allows nothing.
    }
  }
  if (!realRoots.some((root) => isInside(root, real))) {
    throw new ToolUserError("Path is outside the allowed upload roots (ARCHIVR_MCP_UPLOAD_ROOTS).");
  }
  if (isDeniedUploadPath(real)) {
    throw new ToolUserError("Path is on the sensitive-file denylist (keys, credentials, .env files, ...) and cannot be uploaded.");
  }

  const info = await stat(real);
  if (!info.isFile()) throw new ToolUserError("Path is not a regular file.");
  const maxBytes = check.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (info.size > maxBytes) {
    throw new ToolUserError(`File is ${info.size} bytes, over the ${maxBytes} byte upload limit.`);
  }
  return { realPath: real, size: info.size, name: basename(real) };
}

/** Reduce a server-provided or model-provided name to a safe single path component. */
export function sanitizeFileName(name: string, fallback = "download"): string {
  const cleaned = basename(name.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 200);
  return cleaned === "" ? fallback : cleaned;
}

/**
 * Pick a non-clobbering destination file inside `downloadDir` (created if missing) and
 * return its path plus an open exclusive-create handle. The caller writes then closes it.
 */
export async function openDownloadTarget(
  downloadDir: string,
  desiredName: string,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  const dir = resolve(downloadDir);
  await mkdir(dir, { recursive: true });
  const name = sanitizeFileName(desiredName);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 0; n < 1000; n += 1) {
    const candidate = join(dir, n === 0 ? name : `${stem}-${n}${ext}`);
    if (!isInside(dir, candidate)) throw new ToolUserError("Invalid download file name.");
    try {
      const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      return { path: candidate, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new ToolUserError("Could not find a free file name in the download directory.");
}
