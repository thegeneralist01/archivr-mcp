import type { z } from "zod";
import {
  ArchivrAbortError,
  ArchivrApiError,
  ArchivrNetworkError,
  ArchivrProtocolError,
  ArchivrTimeoutError,
} from "./errors";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | undefined | null;

/** How to decode a successful response body. `auto` picks by Content-Type. */
export type ResponseKind = "auto" | "json" | "text" | "binary";

/**
 * A request body that is read lazily and never held in memory as a whole (large uploads).
 * The stream can be consumed only once, so a request with it is never retried.
 */
export interface StreamingBody {
  stream: ReadableStream<Uint8Array>;
  /** Sent as the Content-Type header (e.g. `multipart/form-data; boundary=...`). */
  contentType: string;
  /** Exact body length. Sent as Content-Length; when omitted the body goes out chunked. */
  contentLength?: number;
}

export interface RequestOptions<T = unknown> {
  /** Query parameters; undefined/null values are skipped. */
  query?: Record<string, QueryValue>;
  /** JSON request body. */
  json?: unknown;
  /** Multipart request body (uploads). Content-Type is set by fetch. */
  form?: FormData;
  /** Streaming request body (large uploads). Mutually exclusive with `json` and `form`. */
  body?: StreamingBody;
  /** Sends `Range: bytes=start-end` (end optional = to EOF). */
  range?: { start: number; end?: number };
  signal?: AbortSignal;
  /** Overrides the client's default per-request timeout (long-running admin calls). */
  timeoutMs?: number;
  /** Default `auto`. */
  as?: ResponseKind;
  /** Validate and type the decoded JSON body. A mismatch throws ArchivrProtocolError. */
  schema?: z.ZodType<T>;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  /** Parsed JSON, text, or bytes; `undefined` for 204/empty bodies. */
  body: T;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetch?: FetchLike;
  userAgent?: string;
  /** Signal combined into every request (see withSignal). */
  signal?: AbortSignal;
}

const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * Encode a model- or user-supplied value for use as one URL path segment. Always use
 * this for ids/uids/slugs so `../` or `/` in an argument cannot change the endpoint.
 */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/**
 * Thin HTTP client for the Archivr REST API.
 *
 * Errors never contain the token, request bodies or query strings; only status, the
 * server's own error message and the `METHOD /path` endpoint.
 */
export class ArchivrClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #signal: AbortSignal | undefined;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#userAgent = options.userAgent ?? "archivr-mcp";
    this.#signal = options.signal;
  }

  /** A client that shares this one's configuration and aborts all its requests when `signal` fires. */
  withSignal(signal: AbortSignal): ArchivrClient {
    return new ArchivrClient({
      baseUrl: this.#baseUrl,
      token: this.#token,
      timeoutMs: this.#timeoutMs,
      fetch: this.#fetch,
      userAgent: this.#userAgent,
      signal: this.#signal === undefined ? signal : AbortSignal.any([this.#signal, signal]),
    });
  }

  /** Perform a request and return the decoded body. Throws on non-2xx. */
  async request<T = unknown>(method: string, path: string, options: RequestOptions<T> = {}): Promise<T> {
    return (await this.response<T>(method, path, options)).body;
  }

  /** Like `request` but also returns status and headers (e.g. 200 vs 202, Content-Range). */
  async response<T = unknown>(method: string, path: string, options: RequestOptions<T> = {}): Promise<ApiResponse<T>> {
    const endpoint = `${method.toUpperCase()} ${path}`;
    const { response, finish } = await this.#send(method, path, options, endpoint, true);
    const body = await finish(() => decodeBody(response, options.as ?? "auto"));
    const checked = options.schema === undefined ? (body as T) : validate(options.schema, body, endpoint);
    return { status: response.status, headers: response.headers, body: checked };
  }

  /**
   * Perform a request and return the raw `Response` for the caller to stream (large
   * downloads). The timeout applies until response headers arrive; the caller owns the
   * body. Throws ArchivrApiError on non-2xx.
   */
  async stream(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const endpoint = `${method.toUpperCase()} ${path}`;
    const { response } = await this.#send(method, path, options, endpoint, false);
    return response;
  }

  async #send(
    method: string,
    path: string,
    options: RequestOptions<unknown>,
    endpoint: string,
    timeoutCoversBody: boolean,
  ): Promise<{ response: Response; finish: <R>(read: () => Promise<R>) => Promise<R> }> {
    if (!path.startsWith("/")) throw new Error("request path must start with /");
    if (path.includes("?") || path.includes("#")) throw new Error("pass query parameters via options.query");
    const url = new URL(this.#baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
      "User-Agent": this.#userAgent,
    });
    const bodyKinds = [options.json, options.form, options.body].filter((b) => b !== undefined).length;
    if (bodyKinds > 1) throw new Error("pass only one of json, form and body");
    let body: string | FormData | ReadableStream<Uint8Array> | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", options.body.contentType);
      if (options.body.contentLength !== undefined) headers.set("Content-Length", String(options.body.contentLength));
      body = options.body.stream;
    } else if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      body = options.form;
    }
    if (options.range !== undefined) {
      const { start, end } = options.range;
      headers.set("Range", `bytes=${start}-${end ?? ""}`);
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = [this.#signal, options.signal].filter((s): s is AbortSignal => s !== undefined);
    const onAbort = (): void => controller.abort();
    for (const s of external) {
      if (s.aborted) controller.abort();
      else s.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const s of external) s.removeEventListener("abort", onAbort);
    };
    const classify = (error: unknown): Error => {
      if (error instanceof ArchivrApiError || error instanceof ArchivrProtocolError) return error;
      if (timedOut) return new ArchivrTimeoutError(timeoutMs);
      if (external.some((s) => s.aborted)) return new ArchivrAbortError();
      return new ArchivrNetworkError();
    };

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: method.toUpperCase(),
        headers,
        ...(body === undefined ? {} : { body }),
        // Required by spec (and by Node's fetch) for a stream body; Bun sends it without.
        ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      cleanup();
      throw classify(error);
    }

    try {
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        throw new ArchivrApiError(response.status, "unexpected redirect; check that ARCHIVR_URL uses the final scheme and host", endpoint);
      }
      if (!response.ok && response.status !== 206) {
        throw new ArchivrApiError(response.status, await readErrorMessage(response), endpoint);
      }
    } catch (error) {
      cleanup();
      throw classify(error);
    }

    if (!timeoutCoversBody) cleanup();
    return {
      response,
      finish: async (read) => {
        try {
          return await read();
        } catch (error) {
          throw classify(error);
        } finally {
          cleanup();
        }
      },
    };
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = (await response.text()).trim();
  } catch {
    return "";
  }
  if (text === "") return "";
  let message = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      // Most handlers answer {"error": ...}; a few older ones use {"message": ...}.
      const candidate = record["error"] ?? record["message"];
      if (typeof candidate === "string") message = candidate.trim();
    }
  } catch {
    // Non-JSON body (e.g. a proxy error page): use the text as is.
  }
  return message.length > MAX_ERROR_MESSAGE_CHARS ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}...` : message;
}

async function decodeBody(response: Response, kind: ResponseKind): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const effective: Exclude<ResponseKind, "auto"> =
    kind !== "auto"
      ? kind
      : contentType.includes("json")
        ? "json"
        : contentType.startsWith("text/")
          ? "text"
          : "binary";
  if (effective === "binary") return new Uint8Array(await response.arrayBuffer());
  const text = await response.text();
  if (effective === "text") return text;
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArchivrProtocolError("response was not valid JSON");
  }
}

function validate<T>(schema: z.ZodType<T>, body: unknown, endpoint: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)")))];
  throw new ArchivrProtocolError(`${endpoint} returned an unexpected shape (check fields: ${fields.slice(0, 8).join(", ")})`);
}
