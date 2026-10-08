import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ArchivrAbortError,
  ArchivrApiError,
  ArchivrNetworkError,
  ArchivrProtocolError,
  ArchivrTimeoutError,
  ToolUserError,
  describeApiError,
  toToolError,
} from "../../src/client/errors";

function textOf(error: unknown): string {
  const result = toToolError(error);
  expect(result.isError).toBe(true);
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text block");
  return block.text;
}

describe("toToolError mapping table", () => {
  const cases: Array<[string, unknown, string[]]> = [
    ["401", new ArchivrApiError(401, "login required"), ["Not authenticated", "ARCHIVR_TOKEN"]],
    ["403", new ArchivrApiError(403, "insufficient permissions"), ["Forbidden", "insufficient permissions"]],
    ["404", new ArchivrApiError(404, "entry not found"), ["Not found", "entry not found"]],
    ["409", new ArchivrApiError(409, "cannot remove the last owner"), ["Conflict", "cannot remove the last owner"]],
    ["400", new ArchivrApiError(400, "missing required environment variable: ARCHIVR_ANTHROPIC_API_KEY"), ["Invalid request", "ARCHIVR_ANTHROPIC_API_KEY"]],
    ["503 setup_required", new ArchivrApiError(503, "setup_required"), ["not been set up", "first-run setup"]],
    ["503 other", new ArchivrApiError(503, "busy"), ["temporarily unavailable", "busy"]],
    ["502", new ArchivrApiError(502, "yt-dlp metadata fetch failed"), ["Upstream", "yt-dlp metadata fetch failed"]],
    ["500", new ArchivrApiError(500, "boom"), ["server error (500)", "boom"]],
    ["network", new ArchivrNetworkError(), ["Could not reach", "ARCHIVR_URL"]],
    ["timeout", new ArchivrTimeoutError(1234), ["timed out after 1234 ms", "may still be running"]],
    ["abort", new ArchivrAbortError(), ["cancelled"]],
    ["protocol", new ArchivrProtocolError("GET /x returned an unexpected shape"), ["Unexpected response", "unexpected shape"]],
    ["user error", new ToolUserError("Several archives are mounted (a, b)."), ["Several archives are mounted"]],
    ["zod", (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })(), ["Invalid arguments", "a"]],
    ["unknown error", new Error("kaput"), ["Internal error", "kaput"]],
    ["non-error", "weird", ["Internal error"]],
  ];
  for (const [name, error, fragments] of cases) {
    test(name, () => {
      const text = textOf(error);
      for (const fragment of fragments) expect(text).toContain(fragment);
    });
  }

  test("an empty server message is not rendered as 'Server said:'", () => {
    expect(describeApiError(404, "")).not.toContain("Server said");
  });
});
