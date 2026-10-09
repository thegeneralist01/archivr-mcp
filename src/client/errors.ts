import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

/**
 * Error types raised by the HTTP client and tools, plus the single mapping from any
 * thrown value to a model-facing tool error.
 *
 * None of these carry the token, request bodies or query strings.
 */

/** The server answered with a non-2xx status. */
export class ArchivrApiError extends Error {
  readonly status: number;
  /** The server's `{"error": "..."}` text (or a short plain-text body), trimmed and length-capped. */
  readonly serverMessage: string;
  /** `METHOD /path` without the query string. */
  readonly endpoint: string;

  constructor(status: number, serverMessage: string, endpoint = "") {
    super(serverMessage === "" ? `HTTP ${status}` : `HTTP ${status}: ${serverMessage}`);
    this.name = "ArchivrApiError";
    this.status = status;
    this.serverMessage = serverMessage;
    this.endpoint = endpoint;
  }
}

/** The request never produced an HTTP response (DNS failure, connection refused, reset, ...). */
export class ArchivrNetworkError extends Error {
  constructor() {
    super("network error");
    this.name = "ArchivrNetworkError";
  }
}

/** The per-request timeout elapsed. The server may still be processing the request. */
export class ArchivrTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = "ArchivrTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's AbortSignal fired. */
export class ArchivrAbortError extends Error {
  constructor() {
    super("request aborted");
    this.name = "ArchivrAbortError";
  }
}

/** The response did not match the expected shape (names the endpoint and field paths, never values). */
export class ArchivrProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivrProtocolError";
  }
}

/**
 * A problem the model can fix by changing its call (missing archive, path outside the
 * upload roots, ...). Its message is shown to the model verbatim, so keep it free of secrets.
 */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUserError";
  }
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function withServerMessage(prefix: string, serverMessage: string): string {
  return serverMessage === "" ? prefix : `${prefix} Server said: ${serverMessage}`;
}

/** The exact body Archivr sends when a read-scope token attempts a non-GET request. */
const READ_ONLY_TOKEN_MESSAGE = "read-only token";

/** Text for an HTTP status. The mapping table from the design (Part B6). */
export function describeApiError(status: number, serverMessage: string): string {
  if (status === 503 && serverMessage === "setup_required") {
    return "Archivr has not been set up yet (no owner account exists). Complete first-run setup in the Archivr web UI, then create an API token.";
  }
  switch (status) {
    case 400:
      return withServerMessage("Invalid request (400).", serverMessage);
    case 401:
      return "Not authenticated (401): the Archivr API token was rejected, is expired or was revoked. Create a new token and update ARCHIVR_TOKEN.";
    case 403:
      if (serverMessage === READ_ONLY_TOKEN_MESSAGE) {
        return "Forbidden (403): this API token has read scope and cannot modify anything. Use a full-scope token (create one in the Archivr web UI) for write operations.";
      }
      return withServerMessage(
        "Forbidden (403): this token's role is not permitted to perform this operation.",
        serverMessage,
      );
    case 404:
      return withServerMessage("Not found (404): the archive, entry, job or other resource does not exist or is not visible to this user.", serverMessage);
    case 409:
      return withServerMessage("Conflict (409): the resource is in a state that does not allow this action.", serverMessage);
    case 413:
      return withServerMessage("Payload too large (413).", serverMessage);
    case 429:
      return withServerMessage("Rate limited (429): wait a moment and retry.", serverMessage);
    case 502:
      return withServerMessage("Upstream failure (502): Archivr could not complete a call to an external service.", serverMessage);
    case 503:
      return withServerMessage("Archivr is temporarily unavailable (503).", serverMessage);
    default:
      if (status >= 500) return withServerMessage(`Archivr server error (${status}).`, serverMessage);
      return withServerMessage(`Unexpected HTTP ${status} from Archivr.`, serverMessage);
  }
}

/** Map any thrown value to a tool error result (`isError: true`). */
export function toToolError(error: unknown): CallToolResult {
  return errorResult(describeError(error));
}

export function describeError(error: unknown): string {
  if (error instanceof ArchivrApiError) return describeApiError(error.status, error.serverMessage);
  if (error instanceof ArchivrTimeoutError) {
    return `Request to Archivr timed out after ${error.timeoutMs} ms. The operation may still be running on the server; check before retrying a non-idempotent action.`;
  }
  if (error instanceof ArchivrNetworkError) {
    return "Could not reach the Archivr server. Check that ARCHIVR_URL is correct and the server is running.";
  }
  if (error instanceof ArchivrAbortError) return "The request was cancelled.";
  if (error instanceof ArchivrProtocolError) return `Unexpected response from Archivr: ${error.message}`;
  if (error instanceof ToolUserError) return error.message;
  if (error instanceof ZodError) {
    const where = error.issues.map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)")).join(", ");
    return `Invalid arguments (${where}).`;
  }
  if (error instanceof Error) return `Internal error: ${error.message}`;
  return "Internal error.";
}
