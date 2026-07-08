// Minimal YAML frontmatter reader for vault notes.
//
// The vault's frontmatter contract (vault/README.md) only uses flat
// `key: value` scalars and inline `[a, b]` arrays, so a full YAML parser is
// unnecessary. This parser is deliberately forgiving: a malformed line is
// skipped, never fatal, because indexing must not choke on a hand-edited note.

/**
 * Split a markdown document into { fm, body, raw }.
 * fm is a plain object (values: string | string[]), body is everything after
 * the closing delimiter. Returns fm = {} when there is no frontmatter block.
 */
export function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  // Accept both \n and \r\n line endings without normalizing the document.
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) return { fm: {}, body: text };
  const close = text.indexOf("\n---", firstLineEnd);
  if (close === -1) return { fm: {}, body: text };
  const fmBlock = text.slice(firstLineEnd + 1, close);
  // Body starts after the closing "---" line.
  const afterClose = text.indexOf("\n", close + 1);
  const body = afterClose === -1 ? "" : text.slice(afterClose + 1);

  const fm = {};
  for (const rawLine of fmBlock.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key || /\s/.test(key)) continue; // nested/indented YAML: skip
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      fm[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body };
}

/** First markdown H1 in the body, as a title fallback. */
export function firstHeading(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}
