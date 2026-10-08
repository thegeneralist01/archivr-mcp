import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolUserError } from "../../src/client/errors";
import { isDeniedUploadPath, openDownloadTarget, resolveUploadFile, sanitizeFileName } from "../../src/lib/files";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "archivr-mcp-files-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "archivr-mcp-outside-")));
  await writeFile(join(root, "note.txt"), "hello");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, ".env.local"), "SECRET=1");
  await mkdir(join(root, ".ssh"));
  await writeFile(join(root, ".ssh", "config"), "x");
  await writeFile(join(root, "server.pem"), "x");
  await writeFile(join(outside, "secret.txt"), "top secret");
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await mkdir(join(root, "dir"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const reject = async (path: string, roots: string[] = [root], maxBytes?: number): Promise<string> => {
  try {
    await resolveUploadFile(path, { roots, ...(maxBytes === undefined ? {} : { maxBytes }) });
  } catch (error) {
    expect(error).toBeInstanceOf(ToolUserError);
    return (error as Error).message;
  }
  throw new Error("expected rejection");
};

describe("resolveUploadFile", () => {
  test("accepts a regular file inside a root", async () => {
    const file = await resolveUploadFile(join(root, "note.txt"), { roots: [root] });
    expect(file).toEqual({ realPath: join(root, "note.txt"), size: 5, name: "note.txt" });
  });

  test("is disabled when no roots are configured", async () => {
    expect(await reject(join(root, "note.txt"), [])).toContain("ARCHIVR_MCP_UPLOAD_ROOTS");
  });

  test("rejects relative paths, missing files and directories", async () => {
    expect(await reject("note.txt")).toContain("absolute");
    expect(await reject(join(root, "nope.txt"))).toContain("not found");
    expect(await reject(join(root, "dir"))).toContain("regular file");
  });

  test("rejects paths outside the roots, including ../ traversal and symlink escapes", async () => {
    expect(await reject(join(outside, "secret.txt"))).toContain("outside");
    expect(await reject(join(root, "..", outside.split("/").pop() ?? "", "secret.txt"))).toContain("outside");
    expect(await reject(join(root, "link.txt"))).toContain("outside");
  });

  test("rejects the sensitive-file denylist", async () => {
    expect(await reject(join(root, ".env"))).toContain("denylist");
    expect(await reject(join(root, ".env.local"))).toContain("denylist");
    expect(await reject(join(root, ".ssh", "config"))).toContain("denylist");
    expect(await reject(join(root, "server.pem"))).toContain("denylist");
  });

  test("enforces the size cap", async () => {
    expect(await reject(join(root, "note.txt"), [root], 3)).toContain("upload limit");
  });

  test("isDeniedUploadPath", () => {
    for (const p of ["/home/u/.ssh/id_rsa", "/x/.env", "/x/.env.production", "/x/id_ed25519", "/x/a.key", "/home/u/.config/gcloud/creds.db", "/x/.aws/credentials"]) {
      expect(isDeniedUploadPath(p)).toBe(true);
    }
    for (const p of ["/x/notes.txt", "/x/environment.md", "/x/keyboard.png", "/x/.config/app/settings.json"]) {
      expect(isDeniedUploadPath(p)).toBe(false);
    }
  });
});

describe("downloads", () => {
  test("sanitizeFileName strips directories and control characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\evil\\a.exe")).toBe("a.exe");
    expect(sanitizeFileName(".hidden")).toBe("_hidden");
    expect(sanitizeFileName("a<b>c|d?.txt")).toBe("a_b_c_d_.txt");
    expect(sanitizeFileName("   ")).toBe("download");
    expect(sanitizeFileName("")).toBe("download");
  });

  test("openDownloadTarget never overwrites and stays inside the directory", async () => {
    const dir = join(root, "downloads");
    const a = await openDownloadTarget(dir, "video.mp4");
    await a.handle.writeFile("one");
    await a.handle.close();
    const b = await openDownloadTarget(dir, "video.mp4");
    await b.handle.close();
    const evil = await openDownloadTarget(dir, "../../escape.txt");
    await evil.handle.close();
    expect(a.path).toBe(join(dir, "video.mp4"));
    expect(b.path).toBe(join(dir, "video-1.mp4"));
    expect(evil.path).toBe(join(dir, "escape.txt"));
    expect(await readFile(a.path, "utf8")).toBe("one");
  });
});
