/**
 * Minimal HTML-to-text conversion for archived pages. Not a sanitizer for rendering:
 * the output is plain text handed to a model, which must treat it as untrusted data.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "--",
  hellip: "...",
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: "(c)",
};

const BLOCK_TAGS =
  "address|article|aside|blockquote|br|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul";

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Extract the `<title>` text, if any. */
export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match?.[1] === undefined ? "" : decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return title === "" ? undefined : title;
}

/** Strip scripts, styles and markup; keep paragraph structure as line breaks. */
export function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, "");
  const withBreaks = withoutHidden
    .replace(new RegExp(`<\\s*/?\\s*(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
