/**
 * End-to-end harness: a REAL archivr-server in a temp dir plus the MCP server over REAL stdio.
 *
 * Everything runs with a clean environment (no inherited ARCHIVR_* variables), a free port and
 * a throwaway archive created by the real CLI. Only text and local-file captures are used.
 *
 * Enable with `ARCHIVR_SERVER_BIN` (and `ARCHIVR_CLI_BIN`); see `bun run test:e2e`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SERVER_BIN = process.env["ARCHIVR_SERVER_BIN"];
export const CLI_BIN = process.env["ARCHIVR_CLI_BIN"];
/** Use as `describe.skipIf(E2E_DISABLED)`: e2e is opt-in so a plain `bun test` stays green. */
export const E2E_DISABLED = SERVER_BIN === undefined || SERVER_BIN === "" || CLI_BIN === undefined || CLI_BIN === "";

export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const ARCHIVE_ID = "main";
const POLL_TIMEOUT_MS = 20_000;

// ── Evidence ────────────────────────────────────────────────────────────────

/** Everything the run observed, so leak checks can grep all of it. */
export class Evidence {
  /** Raw REST response bodies (any status). */
  readonly rest: string[] = [];
  /** Raw JSON-RPC lines received from MCP servers (their entire stdout). */
  readonly mcpStdout: string[] = [];
  /** Everything MCP servers wrote to stderr. */
  readonly mcpStderr: string[] = [];
  /** Values that must never appear in any response body (cookie values, passwords, canaries). */
  readonly secrets = new Map<string, string>();

  secret(label: string, value: string): void {
    this.secrets.set(label, value);
  }
  all(): string {
    return [...this.rest, ...this.mcpStdout, ...this.mcpStderr].join("\n");
  }
}

// ── Ports, processes ────────────────────────────────────────────────────────

/** Ask the OS for a free port, then release it. */
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  void probe.stop(true);
  if (port === undefined) throw new Error("could not allocate a port");
  return port;
}

async function pollUntil<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = POLL_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function run(cmd: string[], env: Record<string, string>, cwd: string): string {
  const proc = Bun.spawnSync({ cmd, env, cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

// ── REST client ─────────────────────────────────────────────────────────────

export interface RestResult {
  status: number;
  /** Parsed JSON body, or null when empty/not JSON. */
  json: unknown;
  text: string;
  headers: Headers;
}

export interface Auth {
  token?: string;
  cookie?: string;
}

export interface RestOptions extends Auth {
  body?: unknown;
  /** Raw body (e.g. FormData); wins over `body`. */
  raw?: FormData | string;
  headers?: Record<string, string>;
}

export class ArchivrServer {
  readonly baseUrl: string;
  constructor(
    readonly port: number,
    readonly dir: string,
    readonly archivePath: string,
    readonly authDbPath: string,
    readonly logPath: string,
    private readonly proc: Bun.Subprocess,
    private readonly evidence: Evidence,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async rest(method: string, path: string, opts: RestOptions = {}): Promise<RestResult> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
    if (opts.cookie !== undefined) headers["cookie"] = `session=${opts.cookie}`;
    let body: FormData | string | undefined = opts.raw;
    if (body === undefined && opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await res.text();
    this.evidence.rest.push(text);
    let json: unknown = null;
    try {
      json = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Log in over REST; returns the session cookie value (a secret: registered as evidence). */
  async login(username: string, password: string): Promise<string> {
    const res = await this.loginRaw(username, password);
    if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.text}`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const m = /(?:^|[;,\s])session=([^;,\s]+)/.exec(setCookie);
    if (!m?.[1]) throw new Error("login did not set a session cookie");
    this.evidence.secret(`session:${username}:${m[1].slice(0, 6)}`, m[1]);
    return m[1];
  }

  /**
   * POST /api/auth/login with a fresh spoofed client IP. The server rate-limits logins per IP
   * and (for loopback peers) trusts the last X-Forwarded-For entry, so each call gets its own bucket.
   */
  loginRaw(username: string, password: string): Promise<RestResult> {
    this.loginSeq += 1;
    const ip = `10.${(this.loginSeq >> 16) & 255}.${(this.loginSeq >> 8) & 255}.${this.loginSeq & 255}`;
    return this.rest("POST", "/api/auth/login", { body: { username, password }, headers: { "x-forwarded-for": ip } });
  }
  private loginSeq = 0;

  /** Mint an API token for the logged-in session. */
  async mintToken(cookie: string, name: string, extra: Record<string, unknown> = {}): Promise<{ token: string; uid: string }> {
    const res = await this.rest("POST", "/api/auth/tokens", { cookie, body: { name, ...extra } });
    if (res.status !== 201) throw new Error(`mint token failed: ${res.status} ${res.text}`);
    const j = res.json as { raw_token: string; token_uid: string };
    return { token: j.raw_token, uid: j.token_uid };
  }

  /** Read-write handle on the auth sqlite (for back-dating, role surgery). */
  authDb(): Database {
    return new Database(this.authDbPath);
  }

  log(): string {
    try {
      return readFileSync(this.logPath, "utf8");
    } catch {
      return "";
    }
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!exited) this.proc.kill("SIGKILL");
      await this.proc.exited;
    }
  }
}

export interface StartOptions {
  /** Extra environment for the server (e.g. a secret canary). */
  env?: Record<string, string>;
  evidence: Evidence;
  /** Reuse an existing temp dir (default: a fresh one). */
  dir?: string;
}

/** `archivr init`, registry TOML, spawn the server with a clean env, wait for /health. */
export async function startArchivrServer(opts: StartOptions): Promise<ArchivrServer> {
  if (!SERVER_BIN || !CLI_BIN) throw new Error("ARCHIVR_SERVER_BIN / ARCHIVR_CLI_BIN not set");
  const dir = opts.dir ?? realpathSync(mkdtempSync(join(tmpdir(), "archivr-e2e-")));
  const home = join(dir, "home");
  const state = join(dir, "state");
  const archiveRoot = join(dir, "archive");
  const store = join(dir, "store");
  for (const d of [home, state, archiveRoot]) mkdirSync(d, { recursive: true });

  const cleanEnv = { PATH: "/usr/bin:/bin", HOME: home, ARCHIVR_STATE_DIR: state };
  run([CLI_BIN, "init", archiveRoot, store, "--name", "E2E Archive"], cleanEnv, dir);

  const port = freePort();
  const archivePath = join(archiveRoot, ".archivr");
  const authDbPath = join(dir, "auth.sqlite");
  const configPath = join(dir, "archivr-server.toml");
  writeFileSync(
    configPath,
    [
      `bind = "127.0.0.1:${port}"`,
      `auth_db_path = "${authDbPath}"`,
      "",
      "[[archives]]",
      `id = "${ARCHIVE_ID}"`,
      `label = "E2E Archive"`,
      `archive_path = "${archivePath}"`,
      "",
    ].join("\n"),
  );

  const logPath = join(dir, "server.log");
  writeFileSync(logPath, "");
  const proc = Bun.spawn({
    cmd: [SERVER_BIN, configPath],
    cwd: dir,
    env: { ...cleanEnv, ARCHIVR_BIND: `127.0.0.1:${port}`, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
  });
  const server = new ArchivrServer(port, dir, archivePath, authDbPath, logPath, proc, opts.evidence);
  try {
    await pollUntil("archivr-server /health", async () => {
      if (proc.exitCode !== null) throw new Error(`archivr-server exited early: ${server.log()}`);
      const res = await fetch(`${server.baseUrl}/health`);
      return res.ok ? true : undefined;
    });
  } catch (error) {
    await server.stop();
    throw error;
  }
  return server;
}

// ── Users ───────────────────────────────────────────────────────────────────

export interface TestUser {
  username: string;
  password: string;
  uid: string;
  cookie: string;
  token: string;
  tokenUid: string;
}

export const PASSWORD = "e2e-password-1234";

export interface Cast {
  owner: TestUser;
  admin: TestUser;
  admin2: TestUser;
  user: TestUser;
  user2: TestUser;
  /** Holds only the `guest` role (the `user` role removed after creation). */
  guest: TestUser;
}

async function userFrom(server: ArchivrServer, username: string, password: string, uid: string): Promise<TestUser> {
  const cookie = await server.login(username, password);
  const { token, uid: tokenUid } = await server.mintToken(cookie, `e2e-${username}`);
  return { username, password, uid, cookie, token, tokenUid };
}

/** Setup the owner, then create admin/admin2/user/user2 through the admin API. */
export async function bootstrapCast(server: ArchivrServer, evidence: Evidence): Promise<Cast> {
  const setup = await server.rest("POST", "/api/auth/setup", { body: { username: "owner", password: PASSWORD } });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status} ${setup.text}`);
  evidence.secret("password", PASSWORD);
  const ownerUid = (setup.json as { user_uid: string }).user_uid;
  const owner = await userFrom(server, "owner", PASSWORD, ownerUid);

  const create = async (username: string, roles: string[]): Promise<TestUser> => {
    const res = await server.rest("POST", "/api/admin/users", { cookie: owner.cookie, body: { username, password: PASSWORD } });
    if (res.status !== 201) throw new Error(`create ${username} failed: ${res.status} ${res.text}`);
    const uid = (res.json as { user_uid: string }).user_uid;
    for (const role_slug of roles) {
      const r = await server.rest("POST", `/api/admin/users/${uid}/roles`, { cookie: owner.cookie, body: { role_slug } });
      if (r.status >= 300) throw new Error(`assign ${role_slug} failed: ${r.status} ${r.text}`);
    }
    return userFrom(server, username, PASSWORD, uid);
  };
  const admin = await create("admin", ["admin"]);
  const admin2 = await create("admin2", ["admin"]);
  const user = await create("user", []);
  const user2 = await create("user2", []);
  const guestRes = await server.rest("POST", "/api/admin/users", {
    cookie: owner.cookie,
    body: { username: "guest", password: PASSWORD },
  });
  if (guestRes.status !== 201) throw new Error(`create guest failed: ${guestRes.status} ${guestRes.text}`);
  const guestUid = (guestRes.json as { user_uid: string }).user_uid;
  // `create_user` always grants `user`; swap it for `guest` to get a guest-only account.
  for (const [method, path, body] of [
    ["POST", `/api/admin/users/${guestUid}/roles`, { role_slug: "guest" }],
    ["DELETE", `/api/admin/users/${guestUid}/roles/user`, undefined],
  ] as const) {
    const r = await server.rest(method, path, { cookie: owner.cookie, ...(body ? { body } : {}) });
    if (r.status >= 300) throw new Error(`guest role setup failed: ${r.status} ${r.text}`);
  }
  const guest = await userFrom(server, "guest", PASSWORD, guestUid);
  return { owner, admin, admin2, user, user2, guest };
}

// ── MCP over real stdio ─────────────────────────────────────────────────────

export interface McpOptions {
  server: ArchivrServer;
  token: string;
  evidence: Evidence;
  toolsets?: string;
  readonly?: boolean;
  uploadRoots?: string[];
  downloadDir?: string;
  archive?: string | null;
  extraEnv?: Record<string, string>;
}

export class McpSession {
  readonly toolNames: string[] = [];
  private constructor(
    readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async start(opts: McpOptions): Promise<McpSession> {
    const env: Record<string, string> = {
      ARCHIVR_URL: opts.server.baseUrl,
      ARCHIVR_TOKEN: opts.token,
      ARCHIVR_MCP_TOOLSETS: opts.toolsets ?? "core,capture,organize,account,admin",
      ...(opts.archive === null ? {} : { ARCHIVR_ARCHIVE: opts.archive ?? ARCHIVE_ID }),
      ...(opts.readonly ? { ARCHIVR_MCP_READONLY: "1" } : {}),
      ...(opts.uploadRoots ? { ARCHIVR_MCP_UPLOAD_ROOTS: opts.uploadRoots.join(":") } : {}),
      ...(opts.downloadDir ? { ARCHIVR_MCP_DOWNLOAD_DIR: opts.downloadDir } : {}),
      ...(opts.extraEnv ?? {}),
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(REPO_ROOT, "src", "index.ts")],
      cwd: REPO_ROOT,
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => opts.evidence.mcpStderr.push(chunk.toString("utf8")));
    const client = new Client({ name: "e2e-client", version: "0.0.0" });
    const session = new McpSession(client, transport);
    await client.connect(transport);
    // Record every JSON-RPC message the MCP server wrote to stdout.
    const original = transport.onmessage;
    transport.onmessage = (message) => {
      opts.evidence.mcpStdout.push(JSON.stringify(message));
      original?.(message);
    };
    const listed = await client.listTools();
    session.toolNames.push(...listed.tools.map((t) => t.name).sort());
    return session;
  }

  /** Call a tool; returns the structured outcome. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const result = (await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as CallToolResult;
    const text = result.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    let json: unknown = null;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
    return { isError: result.isError === true, text, json };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
    await this.transport.close().catch(() => {});
  }
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** First text block parsed as JSON (null when it is not JSON). */
  json: unknown;
}

/** `json` typed as an object (test convenience). */
export function obj(outcome: ToolOutcome): Record<string, any> {
  if (outcome.json === null || typeof outcome.json !== "object") {
    throw new Error(`tool output is not a JSON object: ${outcome.text.slice(0, 300)}`);
  }
  return outcome.json as Record<string, any>;
}

// ── Fixture ─────────────────────────────────────────────────────────────────

export class Fixture {
  readonly sessions: McpSession[] = [];
  readonly extraServers: ArchivrServer[] = [];
  private constructor(
    readonly evidence: Evidence,
    readonly server: ArchivrServer,
    readonly cast: Cast,
    readonly workDir: string,
  ) {}

  static async create(): Promise<Fixture> {
    const evidence = new Evidence();
    const server = await startArchivrServer({ evidence });
    try {
      const cast = await bootstrapCast(server, evidence);
      const workDir = join(server.dir, "work");
      mkdirSync(workDir, { recursive: true });
      return new Fixture(evidence, server, cast, realpathSync(workDir));
    } catch (error) {
      await server.stop();
      rmSync(server.dir, { recursive: true, force: true });
      throw error;
    }
  }

  async mcp(token: string, extra: Partial<Omit<McpOptions, "server" | "token" | "evidence">> = {}): Promise<McpSession> {
    const session = await McpSession.start({ server: this.server, token, evidence: this.evidence, ...extra });
    this.sessions.push(session);
    return session;
  }

  /** Start another server (own temp dir, own evidence handled by the caller's Evidence). */
  async extraServer(env: Record<string, string>): Promise<ArchivrServer> {
    const s = await startArchivrServer({ evidence: this.evidence, env });
    this.extraServers.push(s);
    return s;
  }

  async teardown(): Promise<void> {
    for (const s of this.sessions) await s.close();
    for (const s of this.extraServers) {
      await s.stop();
      rmSync(s.dir, { recursive: true, force: true });
    }
    await this.server.stop();
    rmSync(this.server.dir, { recursive: true, force: true });
  }
}

/** Poll a REST endpoint until `done(json)` is true. */
export async function restPoll(
  server: ArchivrServer,
  path: string,
  auth: Auth,
  done: (json: any) => boolean,
): Promise<any> {
  return pollUntil(`GET ${path}`, async () => {
    const res = await server.rest("GET", path, auth);
    return done(res.json) ? res.json : undefined;
  });
}
