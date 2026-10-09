import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  ArchivrAbortError,
  ArchivrApiError,
  ArchivrNetworkError,
  ArchivrProtocolError,
  ArchivrTimeoutError,
  ToolUserError,
  describeError,
} from "../../src/client/errors";
import { ArchivrClient, seg } from "../../src/client/http";
import { BASE_URL, CANARY_PASSWORD, CANARY_TOKEN, MockApi } from "../helpers/mockFetch";

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

describe("ArchivrClient", () => {
  test("sends a Bearer token and builds the URL with query params", async () => {
    const api = new MockApi().on("GET", "/api/archives/:id/entries/search", { json: [] });
    await api.client().request("GET", "/api/archives/main/entries/search", {
      query: { q: "hello world", tag: undefined, limit: 5, flag: false, none: null },
    });
    const [req] = api.requests;
    expect(req?.headers.get("authorization")).toBe(`Bearer ${CANARY_TOKEN}`);
    expect(req?.query).toEqual({ q: "hello world", limit: "5", flag: "false" });
    expect(req?.params["id"]).toBe("main");
  });

  test("honours a base URL path prefix", async () => {
    let seen = "";
    const client = new ArchivrClient({
      baseUrl: "https://example.com/archivr/",
      token: CANARY_TOKEN,
      timeoutMs: 1000,
      fetch: async (input) => {
        seen = String(input);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    await client.request("GET", "/api/archives");
    expect(seen).toBe("https://example.com/archivr/api/archives");
  });

  test("sends JSON bodies, form bodies and Range headers", async () => {
    const api = new MockApi().on("POST", "/api/x", { status: 201, json: { ok: true } }).on("POST", "/api/up", { json: {} }).on("GET", "/api/f", { status: 206, bytes: new Uint8Array([1, 2]) });
    const client = api.client();
    await client.request("POST", "/api/x", { json: { name: "n" } });
    expect(api.requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(api.requests[0]?.json).toEqual({ name: "n" });

    const form = new FormData();
    form.append("file", new Blob(["abc"]), "a.txt");
    await client.request("POST", "/api/up", { form });
    expect(api.requests[1]?.form?.get("file")).toBeInstanceOf(Blob);
    expect(api.requests[1]?.headers.get("content-type")).toBeNull(); // set by fetch with the boundary

    const ranged = await client.response("GET", "/api/f", { range: { start: 0, end: 65535 } });
    expect(api.requests[2]?.headers.get("range")).toBe("bytes=0-65535");
    expect(ranged.status).toBe(206);
    await client.request("GET", "/api/f", { range: { start: 100 } });
    expect(api.requests[3]?.headers.get("range")).toBe("bytes=100-");
  });

  test("sends a streaming body with the given Content-Type and Content-Length", async () => {
    let init: (RequestInit & { duplex?: string }) | undefined;
    const client = new ArchivrClient({
      baseUrl: "http://archivr.test",
      token: CANARY_TOKEN,
      timeoutMs: 1000,
      fetch: async (_input, i) => {
        init = i;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const stream = () => new Blob(["abc", "def"]).stream();
    await client.request("POST", "/api/up", { body: { stream: stream(), contentType: "multipart/form-data; boundary=B", contentLength: 6 } });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("multipart/form-data; boundary=B");
    expect(headers.get("content-length")).toBe("6");
    expect(headers.get("authorization")).toBe(`Bearer ${CANARY_TOKEN}`);
    expect(init?.body).toBeInstanceOf(ReadableStream);
    expect(init?.duplex).toBe("half");

    await client.request("POST", "/api/up", { body: { stream: stream(), contentType: "application/octet-stream" } });
    expect(new Headers(init?.headers).has("content-length")).toBe(false);
  });

  test("a streaming body cannot be combined with json or form", async () => {
    const client = new MockApi().client();
    const body = { stream: new Blob(["x"]).stream(), contentType: "text/plain" };
    await expect(client.request("POST", "/x", { body, json: {} })).rejects.toThrow("only one of");
    await expect(client.request("POST", "/x", { body, form: new FormData() })).rejects.toThrow("only one of");
  });

  test("decodes JSON, text, binary and empty bodies", async () => {
    const api = new MockApi()
      .on("GET", "/j", { json: { a: 1 } })
      .on("GET", "/t", { text: "hello" })
      .on("GET", "/b", { bytes: new Uint8Array([9, 8, 7]) })
      .on("DELETE", "/n", { status: 204 })
      .on("GET", "/forced", { text: "<p>x</p>", headers: { "content-type": "text/html" } });
    const client = api.client();
    expect((await client.request("GET", "/j")) as unknown).toEqual({ a: 1 });
    expect((await client.request("GET", "/t")) as unknown).toBe("hello");
    expect((await client.request("GET", "/b")) as unknown).toEqual(new Uint8Array([9, 8, 7]));
    expect(await client.request("DELETE", "/n")).toBeUndefined();
    expect(await client.request("GET", "/forced", { as: "binary" })).toBeInstanceOf(Uint8Array);
  });

  test("response() exposes status and headers (200 vs 202)", async () => {
    const api = new MockApi().on("POST", "/s", { status: 202, json: { status: "pending" }, headers: { "x-test": "1" } });
    const res = await api.client().response("POST", "/s", { json: {} });
    expect(res.status).toBe(202);
    expect(res.headers.get("x-test")).toBe("1");
  });

  test("validates against a schema and reports field paths only", async () => {
    const api = new MockApi().on("GET", "/me", { json: { name: 5, secret_value: "do-not-leak" } });
    const err = await caught(api.client().request("GET", "/me", { schema: z.object({ name: z.string() }) }));
    expect(err).toBeInstanceOf(ArchivrProtocolError);
    expect(String(err)).toContain("name");
    expect(String(err)).not.toContain("do-not-leak");
  });

  test("maps non-2xx to ArchivrApiError using the server's error text", async () => {
    const api = new MockApi()
      .on("GET", "/a", { status: 403, json: { error: "insufficient permissions" } })
      .on("GET", "/b", { status: 400, json: { message: "pattern_kind must be global" } })
      .on("GET", "/c", { status: 502, text: "<html>Bad gateway</html>" })
      .on("GET", "/d", { status: 500, text: "x".repeat(5000) })
      .on("GET", "/e", { status: 409 });
    const client = api.client();
    const a = (await caught(client.request("GET", "/a"))) as ArchivrApiError;
    expect(a).toBeInstanceOf(ArchivrApiError);
    expect([a.status, a.serverMessage, a.endpoint]).toEqual([403, "insufficient permissions", "GET /a"]);
    expect(((await caught(client.request("GET", "/b"))) as ArchivrApiError).serverMessage).toBe("pattern_kind must be global");
    expect(((await caught(client.request("GET", "/c"))) as ArchivrApiError).serverMessage).toContain("Bad gateway");
    expect(((await caught(client.request("GET", "/d"))) as ArchivrApiError).serverMessage.length).toBeLessThan(600);
    expect(((await caught(client.request("GET", "/e"))) as ArchivrApiError).serverMessage).toBe("");
  });

  test("treats redirects as errors instead of following them with credentials", async () => {
    const api = new MockApi().on("GET", "/r", { status: 301, headers: { location: "https://evil.example/" } });
    const err = (await caught(api.client().request("GET", "/r"))) as ArchivrApiError;
    expect(err).toBeInstanceOf(ArchivrApiError);
    expect(err.status).toBe(301);
  });

  test("a network failure becomes ArchivrNetworkError without the underlying message", async () => {
    const api = new MockApi().on("GET", "/x", new TypeError(`fetch failed: connect ECONNREFUSED ${BASE_URL}/x?q=${CANARY_PASSWORD}`));
    const err = await caught(api.client().request("GET", "/x", { query: { q: CANARY_PASSWORD } }));
    expect(err).toBeInstanceOf(ArchivrNetworkError);
    expect(String(err)).not.toContain(CANARY_PASSWORD);
    expect((err as Error).cause).toBeUndefined();
  });

  test("times out per request, with a per-call override", async () => {
    const api = new MockApi().on("GET", "/slow", (req) => new Promise((_, reject) => {
      req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const started = Date.now();
    const err = await caught(api.client({ timeoutMs: 30 }).request("GET", "/slow"));
    expect(err).toBeInstanceOf(ArchivrTimeoutError);
    expect((err as ArchivrTimeoutError).timeoutMs).toBe(30);
    expect(Date.now() - started).toBeLessThan(2000);
    const err2 = await caught(api.client({ timeoutMs: 60_000 }).request("GET", "/slow", { timeoutMs: 20 }));
    expect((err2 as ArchivrTimeoutError).timeoutMs).toBe(20);
  });

  test("caller aborts and withSignal bound signals produce ArchivrAbortError", async () => {
    const hang = (req: { signal: AbortSignal | undefined }) => new Promise<never>((_, reject) => {
      req.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const api = new MockApi().on("GET", "/slow", hang);
    const controller = new AbortController();
    const p1 = caught(api.client().request("GET", "/slow", { signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await p1).toBeInstanceOf(ArchivrAbortError);

    const bound = new AbortController();
    const p2 = caught(api.client().withSignal(bound.signal).request("GET", "/slow"));
    setTimeout(() => bound.abort(), 10);
    expect(await p2).toBeInstanceOf(ArchivrAbortError);

    const pre = new AbortController();
    pre.abort();
    expect(await caught(api.client().request("GET", "/slow", { signal: pre.signal }))).toBeInstanceOf(ArchivrAbortError);
  });

  test("rejects paths with embedded query strings and relative paths", async () => {
    const client = new MockApi().client();
    await expect(client.request("GET", "/a?x=1")).rejects.toThrow("options.query");
    await expect(client.request("GET", "a")).rejects.toThrow("must start with /");
  });

  test("seg() encodes path segments so ids cannot change the endpoint", () => {
    expect(seg("../../admin/users")).toBe("..%2F..%2Fadmin%2Fusers");
    expect(seg("a b")).toBe("a%20b");
    expect(seg(3)).toBe("3");
    expect(seg("...")).toBe("...");
  });

  test("seg() refuses dot segments, which the URL parser would resolve into a different endpoint", () => {
    // Demonstrates the hazard: percent-encoding does not protect against `.` / `..`.
    expect(new URL("http://h/api/admin/users/u/tokens/..").pathname).toBe("/api/admin/users/u/");
    expect(new URL("http://h/api/admin/users/u/tokens/%2e%2E").pathname).toBe("/api/admin/users/u/");
    for (const bad of [".", "..", "%2e", "%2E%2e", ".%2E"]) {
      expect(() => seg(bad), bad).toThrow(ToolUserError);
    }
  });

  test("request() refuses a path that contains a dot segment even if seg() was bypassed", async () => {
    const api = new MockApi();
    await expect(api.client().request("DELETE", "/api/admin/users/u/tokens/..")).rejects.toThrow("dot segments");
    await expect(api.client().request("GET", "/api/%2e%2e/x")).rejects.toThrow("dot segments");
    expect(api.requests).toHaveLength(0);
  });

  test("never leaks the token, bodies or query strings into error messages", async () => {
    const api = new MockApi()
      .on("POST", "/api/auth/tokens", { status: 400, json: { error: "token name is required" } })
      .on("GET", "/api/q", { status: 500, text: "internal" })
      .on("GET", "/api/net", new TypeError("fetch failed"))
      .on("GET", "/api/slow", (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("x")))));
    const client = api.client({ timeoutMs: 20 });
    const errors = await Promise.all([
      caught(client.request("POST", "/api/auth/tokens", { json: { name: "x", password: CANARY_PASSWORD } })),
      caught(client.request("GET", "/api/q", { query: { secret: CANARY_PASSWORD } })),
      caught(client.request("GET", "/api/net", { query: { secret: CANARY_PASSWORD } })),
      caught(client.request("GET", "/api/slow", { query: { secret: CANARY_PASSWORD } })),
    ]);
    for (const error of errors) {
      const everything = [String(error), (error as Error).stack ?? "", describeError(error), JSON.stringify(error)].join("\n");
      expect(everything).not.toContain(CANARY_TOKEN);
      expect(everything).not.toContain(CANARY_PASSWORD);
    }
  });
});
