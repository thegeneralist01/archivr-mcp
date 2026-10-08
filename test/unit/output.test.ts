import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  jsonResult,
  normalizePage,
  pageResult,
  paginate,
  truncateResult,
  truncateText,
  untrustedText,
  UNTRUSTED_NOTICE,
} from "../../src/lib/output";

const rows = Array.from({ length: 130 }, (_, i) => i);

describe("pagination", () => {
  test("defaults to 25 rows", () => {
    const page = paginate(rows);
    expect(page.items).toHaveLength(DEFAULT_LIMIT);
    expect(page).toMatchObject({ total: 130, offset: 0, limit: 25, hasMore: true, nextOffset: 25 });
  });

  test("clamps the limit to 100 and negative offsets to 0", () => {
    expect(normalizePage({ limit: 5000, offset: -3 })).toEqual({ limit: MAX_LIMIT, offset: 0 });
    expect(normalizePage({ limit: 0 }).limit).toBe(1);
    expect(paginate(rows, { limit: 1000 }).items).toHaveLength(100);
  });

  test("last page has no next offset", () => {
    const page = paginate(rows, { limit: 50, offset: 100 });
    expect(page.items).toHaveLength(30);
    expect(page).toMatchObject({ hasMore: false, nextOffset: null });
    expect(paginate(rows, { offset: 500 }).items).toEqual([]);
  });

  test("pageResult is compact JSON", () => {
    const result = pageResult(paginate([1, 2, 3], { limit: 2 }), { archive: "main" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe('{"archive":"main","total":3,"offset":0,"returned":2,"has_more":true,"next_offset":2,"items":[1,2]}');
  });
});

describe("results and truncation", () => {
  test("jsonResult has no whitespace", () => {
    expect((jsonResult({ a: [1, 2], b: "x y" }).content[0] as { text: string }).text).toBe('{"a":[1,2],"b":"x y"}');
  });

  test("short text is untouched", () => {
    expect(truncateText("hello", 100)).toEqual({ text: "hello", truncated: false, originalLength: 5 });
  });

  test("long text is cut within the budget and says so", () => {
    const cut = truncateText("x".repeat(10_000), 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(1000);
    expect(cut.text).toContain("output truncated");
    expect(cut.text).toContain("10000");
  });

  test("truncateResult shares one budget across text blocks and keeps images", () => {
    const result = truncateResult(
      {
        content: [
          { type: "text", text: "a".repeat(600) },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "b".repeat(600) },
        ],
      },
      1000,
    );
    const texts = result.content.filter((b) => b.type === "text") as Array<{ text: string }>;
    expect(texts.reduce((n, b) => n + b.text.length, 0)).toBeLessThanOrEqual(1000);
    expect(result.content[1]?.type).toBe("image");
    expect(texts[1]?.text).toContain("truncated");
  });

  test("untrustedText prefixes the notice", () => {
    expect(untrustedText("body")).toBe(`${UNTRUSTED_NOTICE}\nbody`);
  });
});
