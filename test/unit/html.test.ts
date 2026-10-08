import { describe, expect, test } from "bun:test";
import { htmlTitle, htmlToText } from "../../src/lib/html";

describe("htmlToText", () => {
  test("strips scripts, styles, comments and tags; keeps block structure", () => {
    const html = `<html><head><title>T</title><style>p{color:red}</style></head><body>
      <!-- hidden --><script>alert("x")</script>
      <h1>Heading</h1><p>First <b>bold</b> para.</p><p>Second&nbsp;para &amp; more &#39;quoted&#39; &#x41;</p>
      <ul><li>one</li><li>two</li></ul></body></html>`;
    expect(htmlToText(html)).toBe("Heading\nFirst bold para.\nSecond para & more 'quoted' A\none\ntwo");
  });

  test("handles unknown and malformed entities safely", () => {
    expect(htmlToText("a &unknown; b &#99999999; c")).toBe("a &unknown; b c");
  });

  test("htmlTitle", () => {
    expect(htmlTitle("<head><title> A &amp; B </title></head>")).toBe("A & B");
    expect(htmlTitle("<p>none</p>")).toBeUndefined();
  });
});
