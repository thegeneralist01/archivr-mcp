import { ArchivrClient, type FetchLike } from "../../src/client/http";
import { DEFAULT_MAX_OUTPUT_CHARS, DEFAULT_TIMEOUT_MS, DEFAULT_TOOLSETS, type Config } from "../../src/config";

/** A distinctive token used by tests: it must never appear in any error, log or result. */
export const CANARY_TOKEN = "arch_CANARY_token_0123456789abcdef";
/** A distinctive password argument: it must never appear in any tool output. */
export const CANARY_PASSWORD = "hunter2-CANARY-passw0rd";
export const BASE_URL = "http://archivr.test";

export interface RecordedRequest {
  method: string;
  /** Path without query string. */
  path: string;
  query: Record<string, string>;
  headers: Headers;
  /** Raw text body for JSON requests. */
  bodyText: string | undefined;
  /** Parsed JSON body, if any. */
  json: unknown;
  form: FormData | undefined;
  /** `:name` captures from the matched route pattern. */
  params: Record<string, string>;
  signal: AbortSignal | undefined;
}

export interface ReplySpec {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}
export type Reply = ReplySpec | Response | Error;
export type ReplyFn = (request: RecordedRequest) => Reply | Promise<Reply>;

interface Route {
  method: string;
  segments: string[];
  reply: Reply | ReplyFn;
}

function toResponse(spec: ReplySpec | Response): Response {
  if (spec instanceof Response) return spec;
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers);
  let body: ConstructorParameters<typeof Response>[0] = null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  } else if (spec.text !== undefined) {
    body = spec.text;
    if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  } else if (spec.bytes !== undefined) {
    body = spec.bytes;
    if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  }
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : body, { status, headers });
}

/**
 * Route-table mock for the Archivr REST API. Register replies with `on(...)`, pass
 * `api.fetch` to an ArchivrClient, and inspect `api.requests` afterwards.
 *
 * ```ts
 * const api = new MockApi().on("GET", "/api/archives", { json: [{ id: "main", label: "Main" }] });
 * const client = api.client();
 * ```
 */
export class MockApi {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: Route[] = [];

  /** `pattern` may contain `:param` segments. Later registrations win over earlier ones. */
  on(method: string, pattern: string, reply: Reply | ReplyFn): this {
    this.#routes.unshift({ method: method.toUpperCase(), segments: pattern.split("/"), reply });
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    const bodyText = typeof body === "string" ? body : undefined;
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: new Headers(init?.headers),
      bodyText,
      json: bodyText === undefined ? undefined : (JSON.parse(bodyText) as unknown),
      form: body instanceof FormData ? body : undefined,
      params: {},
      signal: init?.signal ?? undefined,
    };

    const pathSegments = url.pathname.split("/");
    let reply: Reply | ReplyFn = {
      status: 404,
      json: { error: `mock: no route for ${method} ${url.pathname}` },
    };
    for (const route of this.#routes) {
      if (route.method !== method || route.segments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      const matches = route.segments.every((segment, i) => {
        const actual = pathSegments[i] ?? "";
        if (segment.startsWith(":")) {
          params[segment.slice(1)] = decodeURIComponent(actual);
          return true;
        }
        return segment === actual;
      });
      if (matches) {
        request.params = params;
        reply = route.reply;
        break;
      }
    }
    this.requests.push(request);

    const resolved = typeof reply === "function" ? await reply(request) : reply;
    if (resolved instanceof Error) throw resolved;
    return toResponse(resolved);
  };

  /** Requests recorded for `METHOD path` (exact path). */
  calls(method: string, path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.method === method.toUpperCase() && r.path === path);
  }

  client(overrides: { timeoutMs?: number; token?: string } = {}): ArchivrClient {
    return new ArchivrClient({
      baseUrl: BASE_URL,
      token: overrides.token ?? CANARY_TOKEN,
      timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetch: this.fetch,
    });
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: BASE_URL,
    token: CANARY_TOKEN,
    archive: undefined,
    toolsets: new Set(DEFAULT_TOOLSETS),
    readonly: false,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    uploadRoots: [],
    downloadDir: "/tmp/archivr-mcp-test-downloads",
    logLevel: "off",
    ...overrides,
  };
}

/** `/api/auth/me` bodies for the built-in roles. */
export const ME = {
  owner: { role_bits: 15, username: "root", display_name: "The Owner", humanize_slugs: false, can_reorder_children: true, user_uid: "usr_owner", roles: ["user", "admin", "owner"] },
  admin: { role_bits: 7, username: "ada", display_name: null, humanize_slugs: false, can_reorder_children: true, user_uid: "usr_admin", roles: ["user", "admin"] },
  user: { role_bits: 3, username: "ugo", display_name: null, humanize_slugs: false, can_reorder_children: false, user_uid: "usr_user", roles: ["user"] },
  guest: { role_bits: 1, username: "gus", display_name: null, humanize_slugs: false, can_reorder_children: false },
} as const;
