/**
 * Find where a worker's full write-up lives, given the text of its report.
 *
 * Why this exists: the chat bubble caps a report at 600 characters, and agents
 * routinely put "details in <path>" at the END. The cap ate exactly that line,
 * which is how a report could tell the owner to go read something without telling them
 * where it was. Measured on the stored tickets: 177 of 498 summaries reference a
 * report, review or findings and contain no path at all.
 *
 * So the path is pulled from the WHOLE report before capping, and carried on the
 * ticket separately from the summary text.
 *
 * Ranked rather than first-match, because a report mentions many paths and only
 * some of them are the write-up: a review file beats a task file beats a source
 * file, and logs, JSON and build output lose outright.
 *
 * No imports on purpose — this is the fiddly bit, so it stays testable alone.
 */

const PATH_RE =
  /(?:[A-Za-z]:[\\/][^\s"'`)<>|]+|(?:\.{0,2}\/)?(?:[\w.-]+[\\/]){1,}[\w.-]+\.[A-Za-z0-9]{1,5})/g;

export function pathScore(p: string): number {
  const l = p.toLowerCase().replace(/\\/g, "/");
  let s = 0;
  if (/(review|report|findings|audit|write-?up|summary)/.test(l)) s += 5;
  if (/\.(md|txt)$/.test(l)) s += 3;
  if (/\/\.aiteam\/tasks\//.test(l)) s += 3;
  if (/\/agents\//.test(l)) s += 2;
  if (/\.(log|jsonl|json|lock|png|jpg|jpeg|webp|svg|map)$/.test(l)) s -= 4;
  // Source files are what the work was ON, not the write-up ABOUT it — a file
  // called "reports.js" should never beat an actual review document.
  if (/\.(js|mjs|cjs|ts|tsx|jsx|css|scss|html|py|ps1|sh|java|rb|go|rs)$/.test(l)) s -= 3;
  if (/node_modules|\/\.next\/|\/dist\/|\/build\//.test(l)) s -= 6;
  return s;
}

/** The most write-up-looking path mentioned in a report, or null if none earns it. */
export function extractReportPath(text: string | null): string | null {
  if (!text) return null;
  const hits = Array.from(new Set(text.match(PATH_RE) ?? []))
    // Trailing punctuation from prose ("see foo.md.") is not part of the path.
    .map((h) => h.replace(/[.,;:)\]]+$/, ""))
    .filter((h) => h.length >= 10);
  if (hits.length === 0) return null;
  const best = hits.sort((a, b) => pathScore(b) - pathScore(a))[0];
  return pathScore(best) > 0 ? best : null;
}
