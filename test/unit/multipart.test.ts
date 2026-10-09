import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchivrAbortError, ArchivrTimeoutError, ToolUserError } from "../../src/client/errors";
import { ArchivrClient } from "../../src/client/http";
import { escapeDispositionValue, openMultipartFile, wireFileName } from "../../src/lib/multipart";
import { CANARY_TOKEN } from "../helpers/mockFetch";

interface Seen {
  headers: Headers;
  body: Uint8Array;
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "archivr-multipart-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A sink that records the headers and the complete raw request body. */
function sink() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push({ headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      return Response.json({ ok: true });
    },
  });
  const client = (timeoutMs = 30_000) =>
    new ArchivrClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: CANARY_TOKEN, timeoutMs });
  return { seen, server, client };
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

async function upload(client: ArchivrClient, mp: Awaited<ReturnType<typeof openMultipartFile>>, withLength = true) {
  return client.request("POST", "/up", {
    body: { stream: mp.stream, contentType: mp.contentType, ...(withLength ? { contentLength: mp.contentLength } : {}) },
  });
}

describe("wire format", () => {
  test("boundary, part headers, file bytes and closing boundary are exact", async () => {
    const path = join(dir, "hello.txt");
    await writeFile(path, "hello\r\nworld");
    const { seen, server, client } = sink();
    try {
      const mp = await openMultipartFile({ path, size: 12, boundary: "XBOUNDARYX", contentType: "text/plain" });
      expect(mp.contentType).toBe("multipart/form-data; boundary=XBOUNDARYX");
      await upload(client(), mp);
      const expected =
        '--XBOUNDARYX\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\n" +
        "hello\r\nworld" +
        "\r\n--XBOUNDARYX--\r\n";
      expect(text(seen[0]?.body)).toBe(expected);
      expect(mp.contentLength).toBe(expected.length);
      expect(seen[0]?.headers.get("content-type")).toBe("multipart/form-data; boundary=XBOUNDARYX");
      expect(seen[0]?.headers.get("content-length")).toBe(String(expected.length));
      expect(seen[0]?.headers.get("transfer-encoding")).toBeNull();
      expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${CANARY_TOKEN}`);
    } finally {
      await server.stop(true);
    }
  });

  test("without a content length the body goes out chunked and is still byte-exact", async () => {
    const path = join(dir, "chunked.bin");
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    await writeFile(path, data);
    const { seen, server, client } = sink();
    try {
      const mp = await openMultipartFile({ path, size: data.length, chunkBytes: 1000 });
      await upload(client(), mp, false);
      expect(seen[0]?.headers.get("transfer-encoding")).toBe("chunked");
      expect(seen[0]?.headers.get("content-length")).toBeNull();
      expect(seen[0]?.body.byteLength).toBe(mp.contentLength);
    } finally {
      await server.stop(true);
    }
  });

  test("the default part type is application/octet-stream and the form is parseable", async () => {
    const path = join(dir, "plain.bin");
    await writeFile(path, Buffer.from([0, 1, 2, 255, 254]));
    const { seen, server, client } = sink();
    try {
      await upload(client(), await openMultipartFile({ path, size: 5 }));
      const body = seen[0]!;
      expect(text(body.body)).toContain("Content-Type: application/octet-stream\r\n\r\n");
      const form = await new Response(body.body, { headers: { "content-type": body.headers.get("content-type")! } }).formData();
      const file = form.get("file") as File;
      expect(file.name).toBe("plain.bin");
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 2, 255, 254]);
    } finally {
      await server.stop(true);
    }
  });

  test("an empty file is a valid multipart body", async () => {
    const path = join(dir, "empty.txt");
    await writeFile(path, "");
    const { seen, server, client } = sink();
    try {
      await upload(client(), await openMultipartFile({ path, size: 0 }));
      const body = seen[0]!;
      const form = await new Response(body.body, { headers: { "content-type": body.headers.get("content-type")! } }).formData();
      expect((form.get("file") as File).size).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("a 24 MB file arrives byte-exact (sha256 of the full body)", async () => {
    const size = 24 * 1024 * 1024 + 123; // not a multiple of the chunk size
    const data = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) data[i] = (i * 31 + (i >> 8)) & 0xff;
    const path = join(dir, "large.bin");
    await writeFile(path, data);
    const hashes: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const hash = createHash("sha256");
        for await (const chunk of req.body as ReadableStream<Uint8Array>) hash.update(chunk);
        hashes.push(hash.digest("hex"));
        return Response.json({ ok: true });
      },
    });
    try {
      const client = new ArchivrClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: CANARY_TOKEN, timeoutMs: 60_000 });
      const mp = await openMultipartFile({ path, size, boundary: "BIG", contentType: "application/octet-stream" });
      await upload(client, mp);
      const head = Buffer.from(
        '--BIG\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
      );
      const tail = Buffer.from("\r\n--BIG--\r\n");
      expect(mp.contentLength).toBe(head.length + size + tail.length);
      expect(hashes[0]).toBe(createHash("sha256").update(head).update(data).update(tail).digest("hex"));
    } finally {
      await server.stop(true);
    }
  });
});

describe("filename on the wire", () => {
  test("only the basename is sent, never the local path", async () => {
    const nested = join(dir, "secret-user-dir", "deeper");
    await mkdir(nested, { recursive: true });
    const path = join(nested, "report.pdf");
    await writeFile(path, "pdf");
    const { seen, server, client } = sink();
    try {
      await upload(client(), await openMultipartFile({ path, size: 3 }));
      const wire = text(seen[0]?.body);
      expect(wire).toContain('filename="report.pdf"');
      expect(wire).not.toContain("secret-user-dir");
      expect(wire).not.toContain(dir);
    } finally {
      await server.stop(true);
    }
  });

  test("an explicit fileName is reduced to its basename too", async () => {
    const path = join(dir, "real.txt");
    await writeFile(path, "x");
    const mp = await openMultipartFile({ path, size: 1, fileName: "/etc/passwd/../evil/name.txt" });
    expect((await new Response(mp.stream).text())).toContain('filename="name.txt"');
  });

  test("escapeDispositionValue encodes quotes and CR/LF and replaces backslashes and control characters", () => {
    expect(escapeDispositionValue('a"b')).toBe("a%22b");
    expect(escapeDispositionValue("a\r\nb")).toBe("a%0D%0Ab");
    expect(escapeDispositionValue("a\\b\u0000c\u007fd\te")).toBe("a_b_c_d_e");
    expect(escapeDispositionValue("plain ünïcode.txt")).toBe("plain ünïcode.txt");
  });

  test("wireFileName never returns an empty or dot name", () => {
    expect(wireFileName("/a/b/c.txt")).toBe("c.txt");
    expect(wireFileName("/a/b/")).toBe("b");
    expect(wireFileName("/")).toBe("upload");
    expect(wireFileName("..")).toBe("upload");
  });

  test("a filename with quotes and CR/LF cannot break out of the header", async () => {
    const nasty = 'we"ird\r\nContent-Type: text/evil\r\n\r\nname.txt';
    const path = join(dir, nasty.replace(/\//g, "_"));
    await writeFile(path, "payload");
    const { seen, server, client } = sink();
    try {
      await upload(client(), await openMultipartFile({ path, size: 7, boundary: "NB" }));
      const wire = text(seen[0]?.body);
      // Exactly one header block: the injected CRLFs are percent-encoded.
      expect(wire.split("\r\n\r\n")).toHaveLength(2);
      expect(wire).not.toContain("text_evil\r\n");
      expect(wire).toContain('filename="we%22ird%0D%0AContent-Type: text_evil%0D%0A%0D%0Aname.txt"');
      const form = await new Response(seen[0]?.body, { headers: { "content-type": "multipart/form-data; boundary=NB" } }).formData();
      expect(await (form.get("file") as File).text()).toBe("payload");
    } finally {
      await server.stop(true);
    }
  });
});

describe("failure modes", () => {
  /** Count of open file descriptors of this process. */
  const openFds = (): number => readdirSync("/dev/fd").length;

  test("rejects when the file no longer has the checked size, and does not leak the handle", async () => {
    const path = join(dir, "resized.txt");
    await writeFile(path, "12345");
    const before = openFds();
    await expect(openMultipartFile({ path, size: 99 })).rejects.toBeInstanceOf(ToolUserError);
    await expect(openMultipartFile({ path: dir, size: 0 })).rejects.toBeInstanceOf(ToolUserError);
    await expect(openMultipartFile({ path: join(dir, "missing"), size: 0 })).rejects.toThrow();
    expect(openFds()).toBe(before);
  });

  test("a file that shrinks mid-upload fails the request and reports the real cause", async () => {
    const path = join(dir, "shrinks.bin");
    await writeFile(path, Buffer.alloc(300_000, 1));
    const { server, client } = sink();
    try {
      const mp = await openMultipartFile({ path, size: 300_000, chunkBytes: 50_000 });
      await truncate(path, 100_000);
      await expect(upload(client(), mp)).rejects.toBeDefined();
      expect(mp.failure()).toBeInstanceOf(ToolUserError);
      expect(mp.failure()?.message).toContain("shorter");
    } finally {
      await server.stop(true);
    }
  });

  test("a file that grows mid-upload still sends exactly the checked size", async () => {
    const path = join(dir, "grows.bin");
    await writeFile(path, Buffer.alloc(1000, 2));
    const { seen, server, client } = sink();
    try {
      const mp = await openMultipartFile({ path, size: 1000, chunkBytes: 100 });
      await writeFile(path, Buffer.alloc(5000, 2));
      await upload(client(), mp);
      expect(seen[0]?.body.byteLength).toBe(mp.contentLength);
    } finally {
      await server.stop(true);
    }
  });

  test("aborting mid-upload throws ArchivrAbortError and is not reported as a read failure", async () => {
    const path = join(dir, "abort.bin");
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 3));
    const gotBytes = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const reader = (req.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        gotBytes.resolve();
        // Keep the upload in flight until the client goes away.
        await new Promise((resolve) => req.signal.addEventListener("abort", resolve, { once: true }));
        return new Response("aborted");
      },
    });
    try {
      const controller = new AbortController();
      const client = new ArchivrClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: CANARY_TOKEN, timeoutMs: 30_000 });
      const mp = await openMultipartFile({ path, size: 8 * 1024 * 1024, chunkBytes: 64 * 1024 });
      const pending = client.request("POST", "/up", {
        signal: controller.signal,
        body: { stream: mp.stream, contentType: mp.contentType, contentLength: mp.contentLength },
      });
      const outcome = pending.then(() => undefined, (e: unknown) => e);
      await gotBytes.promise;
      controller.abort();
      expect(await outcome).toBeInstanceOf(ArchivrAbortError);
      await mp.dispose();
      expect(mp.failure()).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("an already aborted signal fails before anything is sent", async () => {
    const path = join(dir, "preaborted.txt");
    await writeFile(path, "x");
    const { seen, server, client } = sink();
    try {
      const mp = await openMultipartFile({ path, size: 1 });
      const controller = new AbortController();
      controller.abort();
      await expect(
        client().request("POST", "/up", {
          signal: controller.signal,
          body: { stream: mp.stream, contentType: mp.contentType, contentLength: mp.contentLength },
        }),
      ).rejects.toBeInstanceOf(ArchivrAbortError);
      await mp.dispose();
      expect(seen).toHaveLength(0);
    } finally {
      await server.stop(true);
    }
  });

  test("the request timeout covers a stalled upload (ArchivrTimeoutError)", async () => {
    const path = join(dir, "stall.bin");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 4));
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise(() => undefined);
        return new Response("unreachable");
      },
    });
    try {
      const client = new ArchivrClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: CANARY_TOKEN, timeoutMs: 150 });
      const mp = await openMultipartFile({ path, size: 2 * 1024 * 1024 });
      await expect(upload(client, mp)).rejects.toBeInstanceOf(ArchivrTimeoutError);
      await mp.dispose();
    } finally {
      await server.stop(true);
    }
  });

  test("cancelling the stream (what fetch does on abort) closes the file, even mid-read", async () => {
    const path = join(dir, "cancel.bin");
    await writeFile(path, Buffer.alloc(1024 * 1024, 5));
    const before = openFds();
    const mp = await openMultipartFile({ path, size: 1024 * 1024, chunkBytes: 4096 });
    expect(openFds()).toBe(before + 1);
    const reader = mp.stream.getReader();
    await reader.read(); // head
    await reader.read(); // first file chunk
    await reader.cancel();
    expect(openFds()).toBe(before);
    expect(mp.failure()).toBeUndefined();
  });

  test("dispose is idempotent and closes an unconsumed body", async () => {
    const path = join(dir, "dispose.txt");
    await writeFile(path, "abc");
    const before = openFds();
    const mp = await openMultipartFile({ path, size: 3 });
    expect(openFds()).toBe(before + 1);
    await mp.dispose();
    await mp.dispose();
    expect(openFds()).toBe(before);
  });
});
