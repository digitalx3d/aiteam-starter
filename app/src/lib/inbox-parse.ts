export type InboxPriority = "low" | "medium" | "high";

export interface InboxEntry {
  id: string;
  from: string;
  to: string[];
  priority: InboxPriority;
  /** Header timestamp string as it appears in the file (no normalization). */
  timestamp: string;
  /**
   * Posting time the entry states about itself, taken from the `THHMM` part of
   * its id (`2026-08-15T1730-ethan-slug` -> `2026-08-15T17:30:00`), or failing
   * that from a time in its header (`2026-10-06 14:40`). Local time, no zone
   * suffix: agents write the owner's local wall-clock time. Null when the entry carries
   * only a date, which is the case for older entries.
   */
  statedAt: string | null;
  /**
   * Resolved posting time: `statedAt` when the entry states one, otherwise when
   * the server first saw the entry. Filled in by the inbox API, not the parser.
   */
  postedAt?: string | null;
  /** True when `postedAt` came from first-seen rather than from the entry. */
  postedAtApprox?: boolean;
  /** Agent name as shown in the header (e.g. "Indy", "CVB"). */
  agent: string;
  /**
   * Project the post is about. The parser fills it only from a `project:`
   * field on the id line; the inbox API also reads it out of the heading and
   * title (see inbox-project.ts).
   */
  project?: string;
  title: string;
  /** Body markdown after the metadata line, trimmed. */
  body: string;
  /**
   * Set when the post is not in the team's format and is shown as written
   * rather than dropped. Says what was missing. The id of such an entry is a
   * hash of its text (`unparsed-<hash>`), stable while the text is unchanged.
   */
  formatIssue?: string;
  /**
   * Ids an earlier, stricter version of this parser read for the same entry
   * (it kept separator slop like a trailing ` |` inside the id). The state
   * store moves read and first-seen marks from these onto `id`.
   */
  legacyIds?: string[];
}

/** Something in the file that was deliberately not turned into an entry. */
export interface InboxSkip {
  /** 1-based line in the file where the skipped text starts. */
  line: number;
  reason: "file-header" | "template" | "duplicate";
  /** First line of the skipped text, for a human to find it. */
  preview: string;
}

export interface InboxParseResult {
  entries: InboxEntry[];
  skipped: InboxSkip[];
}

const PRIORITY_VALUES = new Set<InboxPriority>(["low", "medium", "high"]);

/**
 * Parse the team's inbox-shared.md into structured entries.
 *
 * Entry schema (per the file's own header):
 *
 *     ## <timestamp> -- <agent>: <title>
 *     > **id:** <id> · **from:** <from> · **to:** <to> · **priority:** <pri>
 *
 *     <body>
 *
 * Entries are separated by a line containing only `---`.
 *
 * The rule this parser keeps: nothing that looks like a post is ever dropped
 * without a trace. Agents write this file by hand and get the format wrong in
 * every way you'd guess (a separator on line 1, pipes or an em dash in the
 * heading, mojibake'd dots, posts appended at the bottom with no separator at
 * all), so the parser reads what it can and shows the rest as written with
 * `formatIssue` set. The only things left out are listed in `skipped`: the
 * file's own `# Shared inbox` header, schema templates with `<...>` ids, and
 * literal reposts of an id already shown.
 */
export function parseInbox(markdown: string): InboxEntry[] {
  return parseInboxDetailed(markdown).entries;
}

export function parseInboxDetailed(markdown: string): InboxParseResult {
  const entries: InboxEntry[] = [];
  const skipped: InboxSkip[] = [];
  // Dedupe by id, keeping the first occurrence. The shared inbox occasionally
  // accumulates literal reposts (e.g., when a scheduled digest runs manually
  // after a failed scheduled run); rendering them all just inflates the unread
  // count and triggers React duplicate-key warnings. A repost means the same id
  // AND the same title; a reused id on a different post is a different post.
  const titleById = new Map<string, string>();

  for (const block of splitBlocks(markdown)) {
    const preview = (block.lines.find((l) => l.trim()) ?? "").trim().slice(0, 120);
    if (block.kind === "file-header") {
      skipped.push({ line: block.line, reason: "file-header", preview });
      continue;
    }
    // A stray code-fence marker left between a template and its fence is
    // not a post and has nothing in it to lose.
    if (block.kind === "orphan" && block.lines.every((l) => !l.trim() || FENCE_RE.test(l))) {
      continue;
    }
    const entry = blockToEntry(block);
    if (!entry) {
      // The file's header has carried a schema example with placeholder ids
      // like `<YYYY-MM-DDTHHMM>-<from>-<slug>`; real posts never contain them.
      skipped.push({ line: block.line, reason: "template", preview });
      continue;
    }
    const seenTitle = titleById.get(entry.id);
    if (seenTitle !== undefined) {
      if (seenTitle === entry.title) {
        skipped.push({ line: block.line, reason: "duplicate", preview });
        continue;
      }
      // Same id, different post: an agent reused an id. Both are real posts.
      let n = 2;
      while (titleById.has(`${entry.id}~${n}`)) n++;
      entry.id = `${entry.id}~${n}`;
    }
    titleById.set(entry.id, entry.title);
    entries.push(entry);
  }
  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// Splitting the file into blocks
// ---------------------------------------------------------------------------

interface Block {
  /** `post` starts at a heading or id line; `orphan` is text with neither. */
  kind: "post" | "orphan" | "file-header";
  /** 1-based line number of the block's first line. */
  line: number;
  lines: string[];
}

const SEPARATOR_RE = /^[ \t]*---+[ \t]*$/;
const H2_RE = /^##(?!#)/;
/** A heading that leads with a date (optionally after a `[HIGH]` tag) is a post. */
const DATED_H2_RE = /^##(?!#)\s*(?:\[[^\]]*\]\s*)?\d{4}-\d{2}-\d{2}/;
const FILE_HEADER_RE = /^#\s+Shared inbox\b/i;
const FENCE_RE = /^\s*(?:```|~~~)/;
const GLUED_SEPARATOR_RE = /^\s*---+\s*(##(?!#).*)$/;

/**
 * Walk the file line by line. A post starts at:
 *  - a `## ` heading at the top of the file or right after a `---` line,
 *  - a `## ` heading that leads with a date, or is followed by an id line,
 *    even with no `---` before it (posts appended without a separator), or
 *  - an id line right after a `---` (a post that lost its heading).
 * A `---` that is not followed by any of those is a horizontal rule inside
 * the current post's body and stays there.
 */
function splitBlocks(markdown: string): Block[] {
  // An agent that writes the separator without its newline leaves
  // `---## 2026-10-08 -- Indy: ...` on one line, which hid the post under it
  // inside the post above (2026-10-08). Split it back into two lines; `lineNo`
  // keeps the reported line numbers true to the file.
  const lines: string[] = [];
  const lineNo: number[] = [];
  markdown
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, idx) => {
      const glued = line.match(GLUED_SEPARATOR_RE);
      for (const part of glued ? ["---", glued[1]] : [line]) {
        lines.push(part);
        lineNo.push(idx + 1);
      }
    });
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let afterSeparator = true; // the start of the file counts as a boundary

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SEPARATOR_RE.test(line)) {
      if (cur?.kind === "file-header") {
        // The file header is a few lines; anything after its separator that
        // is not a post must not hide inside it.
        cur = null;
      } else if (cur) {
        // Blank lines around it so the previous paragraph is not read as a
        // setext heading. Trimmed off again if no body follows.
        cur.lines.push("", "---", "");
      }
      afterSeparator = true;
      continue;
    }
    if (!line.trim()) {
      cur?.lines.push(line);
      continue;
    }

    if (startsPost(lines, i, afterSeparator)) {
      cur = { kind: "post", line: lineNo[i], lines: [line] };
      blocks.push(cur);
    } else if (FILE_HEADER_RE.test(line)) {
      cur = { kind: "file-header", line: lineNo[i], lines: [line] };
      blocks.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      cur = { kind: "orphan", line: lineNo[i], lines: [line] };
      blocks.push(cur);
    }
    afterSeparator = false;
  }
  return blocks;
}

function startsPost(lines: string[], i: number, afterSeparator: boolean): boolean {
  const line = lines[i];
  if (H2_RE.test(line)) {
    if (afterSeparator || DATED_H2_RE.test(line)) return true;
    const next = nextContentLine(lines, i + 1);
    return next !== null && isMetaLine(next);
  }
  return afterSeparator && isMetaLine(line);
}

function nextContentLine(lines: string[], from: number): string | null {
  for (let j = from; j < lines.length && j < from + 3; j++) {
    if (lines[j].trim()) return lines[j];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turning a block into an entry
// ---------------------------------------------------------------------------

function blockToEntry(block: Block): InboxEntry | null {
  const [first, ...rest] = block.lines;
  const headingLine = H2_RE.test(first) ? first : null;
  const afterHeading = headingLine ? rest : block.lines;

  // The id line belongs right under the heading. Looking further down would
  // let a post with no id line borrow one quoted in its body.
  let metaIdx = -1;
  let contentSeen = 0;
  for (let j = 0; j < afterHeading.length && contentSeen < 3; j++) {
    if (!afterHeading[j].trim()) continue;
    if (isMetaLine(afterHeading[j])) {
      metaIdx = j;
      break;
    }
    contentSeen++;
  }
  const metaRaw = metaIdx === -1 ? null : afterHeading[metaIdx];
  const meta = metaRaw === null ? null : normalizeMeta(metaRaw);
  const id = meta ? matchField(meta, "id") : null;

  const heading = headingLine ? parseHeading(headingLine) : null;
  const metaFrom = meta ? matchField(meta, "from") : null;
  if (heading?.agentGuessed && metaFrom && heading.rest) {
    // "## 2026-10-07 -- weekly janitor report" with **from:** devin: the id
    // line says who posted, so the whole heading is the title.
    heading.agent = agentFromSlug(metaFrom);
    heading.title = heading.rest;
  }
  const headingText = headingLine ? cleanLine(headingLine).replace(/^##\s*/, "").trim() : "";
  if (id?.includes("<") || id?.includes(">")) return null;
  if (!id && /<[^>]+>/.test(headingText)) return null;

  const from = metaFrom || slugFromAgent(heading?.agent) || "";
  const agent = heading?.agent || agentFromSlug(from) || "Unknown";
  const priority =
    toPriority(meta ? matchField(meta, "priority") : null) ??
    heading?.tagPriority ??
    "medium";
  const timestamp =
    heading?.timestamp ?? (id?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "");
  const bodyLines = metaIdx === -1 ? afterHeading : afterHeading.slice(metaIdx + 1);
  const body = trimBody(bodyLines);

  const project = meta ? matchField(meta, "project") : null;

  if (id) {
    const legacy = metaRaw ? legacyId(metaRaw) : null;
    return {
      id,
      from,
      to: splitRecipients(meta ? matchField(meta, "to") : null),
      priority,
      timestamp,
      statedAt: statedAtFromId(id) ?? statedAtFromHeading(timestamp),
      agent,
      title: heading?.title || headingText || "(no title)",
      body,
      ...(project ? { project } : {}),
      ...(heading ? {} : { formatIssue: "heading is not in the team's format" }),
      ...(legacy && legacy !== id ? { legacyIds: [legacy] } : {}),
    };
  }

  // No readable id: show the post as written rather than lose it.
  const title =
    heading?.title ||
    headingText ||
    cleanLine(first).replace(/^[#>*_\s]+/, "").slice(0, 100) ||
    "(no title)";
  const rawBody = trimBody(headingLine ? rest : block.lines.slice(1)) || trimBody(block.lines);
  // Hashed from the heading and trimmed body only, so a separator or blank
  // lines added after the post later do not change its id (and its read mark).
  const fingerprint = [first, ...rawBody.split("\n")]
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return {
    id: `unparsed-${hash(fingerprint)}`,
    from,
    // No addressee to read. Left empty, not "all", so `isForOwner` can tell a
    // post nobody addressed from a real broadcast.
    to: [],
    priority,
    timestamp,
    statedAt: statedAtFromHeading(timestamp),
    agent,
    title,
    body: rawBody,
    formatIssue: headingLine
      ? "no id line under the heading"
      : "no heading and no id line",
  };
}

interface ParsedHeading {
  timestamp: string;
  agent: string;
  title: string;
  tagPriority: InboxPriority | null;
  /** True when the heading had no `agent:` and the first word was taken as the agent. */
  agentGuessed?: boolean;
  /** Everything after the timestamp, for when the guess is overruled. */
  rest?: string;
}

/**
 * Read `## <timestamp> -- <agent>: <title>` and the variants agents actually
 * write: an em or en dash or a single spaced hyphen instead of `--`, pipe
 * columns (`## 2026-10-06 | Casey | title`), no separator after the date, and
 * no colon after the agent. Returns null when there is no timestamp-like text
 * to anchor on.
 */
function parseHeading(line: string): ParsedHeading | null {
  const text = cleanLine(line).replace(/^##\s*/, "").trim();

  // The documented form first, exactly as the parser always read it, so a
  // title that happens to contain a pipe or a dash is not re-split.
  const strict = text.match(/^(.+?)\s+--\s+([^:]+):\s+(.+)$/);
  if (strict && !strict[1].includes("|")) {
    return heading(strict[1], strict[2], strict[3]);
  }

  // Pipe or dot columns: `## 2026-10-14 | Casey | title` or `2026-10-14 · Casey · title`.
  const cols = text.split(/\s+[|·]\s+/);
  if (cols.length >= 2 && /\d/.test(cols[0])) {
    if (cols.length >= 3) return heading(cols[0], cols[1], cols.slice(2).join(" | "));
    return headingFromRest(cols[0], cols[1]);
  }

  const dashed = text.match(/^(.+?)\s+(?:--|\u2014|\u2013|-)\s+(.+)$/);
  if (dashed && /\d/.test(dashed[1])) return headingFromRest(dashed[1], dashed[2]);

  const dated = text.match(
    /^((?:\[[^\]]*\]\s*)?\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)\s+(.+)$/
  );
  if (dated) return headingFromRest(dated[1], dated[2]);
  return null;
}

function headingFromRest(timestamp: string, rest: string): ParsedHeading {
  const m = rest.match(/^([^:]{1,40}):\s*(.+)$/);
  if (m && m[1].trim().split(/\s+/).length <= 3) return heading(timestamp, m[1], m[2]);
  // No colon: the first word is the agent, the rest is the title.
  const words = rest.trim().split(/\s+/);
  return {
    ...heading(timestamp, words[0], words.length > 1 ? words.slice(1).join(" ") : rest),
    agentGuessed: true,
    rest: rest.trim(),
  };
}

function heading(timestamp: string, agent: string, title: string): ParsedHeading {
  // The tag goes in front of the date, but agents also lead the title with it
  // ("Ethan: [HIGH] linking needs no consent").
  const tag = timestamp.match(/^\[([^\]]*)\]/) ?? title.trim().match(/^\[([^\]]*)\]/);
  return {
    timestamp: timestamp.trim(),
    agent: agent.trim(),
    title: title.trim(),
    tagPriority: tag ? toPriority(tag[1]) : null,
  };
}

/** Windows-1252 bytes 0x80-0x9F, keyed by the character they display as. */
const CP1252_BYTE: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};
// Any character Windows-1252 can produce above ASCII. The dash range is
// written wider than needed (0x2012-0x2015) only to keep the source ASCII.
const MOJIBAKE_RUN =
  /[\x80-\xff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2012-\u2015\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]{2,}/g;
let utf8: TextDecoder | null = null;

/**
 * Undo the mojibake the file collects when an agent round-trips it through
 * the wrong code page. The dot separator shows up as two characters, as four,
 * and on some August entries as a 200-character run that is the same dot
 * misread seven times over. Each pass reads a run of such characters back as
 * Windows-1252 bytes and decodes them as UTF-8; a run that does not decode
 * cleanly is left alone, so correct accented text survives. Applied to
 * headings and id lines only; bodies are shown as written.
 */
function cleanLine(line: string): string {
  let out = line;
  for (let pass = 0; pass < 10; pass++) {
    const next = out.replace(MOJIBAKE_RUN, (run) => {
      const bytes: number[] = [];
      for (const ch of run) {
        const code = ch.codePointAt(0) ?? 0;
        const byte = code <= 0xff ? code : CP1252_BYTE[code];
        if (byte === undefined) return run;
        bytes.push(byte);
      }
      try {
        utf8 ??= new TextDecoder("utf-8", { fatal: true });
        return utf8.decode(new Uint8Array(bytes));
      } catch {
        return run;
      }
    });
    if (next === out) break;
    out = next;
  }
  // Whatever would not decode: a run that ends in a dot is still a separator.
  return out
    .replace(/[\x80-\xff\u0192\u02c6\u2012-\u2022\u2026\u20ac\u2122]*[\xc2\xc3][^\s*]*\xb7/g, "\xb7")
    .replace(/\xa0/g, " ");
}

/**
 * One separator for every field delimiter agents use: the dot, a bullet, a
 * pipe, or a spaced hyphen or dash in front of the next field name.
 */
function normalizeMeta(line: string): string {
  return cleanLine(line)
    .replace(/[\u2022|]/g, "\u00b7")
    .replace(
      new RegExp(`\\s+[-\\u2012-\\u2015]\\s+(?=${BOLD}(?:${FIELD_NAMES})${BOLD}\\s*:)`, "gi"),
      " \u00b7 "
    );
}

const FIELD_NAMES = "id|from|to|priority|project";
const BOLD = "(?:\\*\\*|__)?";

/**
 * True for the metadata line: optional `>`, then one of the known fields,
 * bolded as `**id:**` or `**id**:` or not at all, and an id somewhere in it.
 */
function isMetaLine(line: string): boolean {
  const norm = normalizeMeta(line);
  const lead = new RegExp(`^\\s*(?:>\\s*)*${BOLD}\\s*(?:${FIELD_NAMES})\\s*${BOLD}\\s*:`, "i");
  return lead.test(norm) && matchField(norm, "id") !== null;
}

/**
 * Value of `field` on a normalized metadata line. The value runs to the next
 * `·`, the next bold marker, the next `name:` field, or the end of the line.
 */
function matchField(line: string, field: string): string | null {
  const re = new RegExp(
    `(?:^|[\\s>\u00b7*_])${BOLD}${field}${BOLD}\\s*:\\s*${BOLD}` +
      `(.+?)` +
      `(?=\\s*(?:\u00b7|\\*\\*|__|$)|\\s+${BOLD}(?:${FIELD_NAMES})${BOLD}\\s*:)`,
    "i"
  );
  const m = line.match(re);
  if (!m) return null;
  const value = m[1].replace(/^[\s*_`\u00b7]+|[\s*_`\u00b7]+$/g, "");
  return value || null;
}

/**
 * The id as the parser read it before 2026-10-08, which stopped only at `·`,
 * `Â` or `**`, so `| **from:**` left ` |` in the id and a mojibake dot left its first bytes.
 * Kept so read state recorded under those ids carries over.
 */
function legacyId(rawMetaLine: string): string | null {
  if (!rawMetaLine.startsWith(">") || !rawMetaLine.includes("**id:**")) return null;
  const m = rawMetaLine.match(/\*\*id:\*\*\s*([^\u00b7\u00c2*\n]+?)(?=\s*(?:[\u00b7\u00c2]|\*\*|$))/i);
  return m ? m[1].trim() : null;
}

function splitRecipients(raw: string | null): string[] {
  return (raw ?? "")
    .split(/[,;]|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toPriority(raw: string | null | undefined): InboxPriority | null {
  if (!raw) return null;
  const v = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (PRIORITY_VALUES.has(v as InboxPriority)) return v as InboxPriority;
  if (v === "med" || v === "normal") return "medium";
  if (v === "critical" || v === "urgent" || v === "blocker") return "high";
  return null;
}

function slugFromAgent(agent: string | undefined): string {
  return agent ? agent.toLowerCase() : "";
}

function agentFromSlug(slug: string): string {
  if (!slug) return "";
  if (slug.toLowerCase() === "cvb") return "CVB";
  const first = slug.split("-")[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Join body lines, dropping leading and trailing blanks and separators. */
function trimBody(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  const empty = (l: string) => !l.trim() || SEPARATOR_RE.test(l);
  while (start < end && empty(lines[start])) start++;
  while (end > start && empty(lines[end - 1])) end--;
  return lines.slice(start, end).join("\n").trim();
}

/** FNV-1a, 32-bit, as hex. Enough to give an unreadable post a stable id. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Pull the posting time out of an entry id.
 *
 * The schema is `<YYYY-MM-DDTHHMM>-<from>-<slug>`, but plenty of entries are
 * written as `<YYYY-MM-DD>T-<from>-<slug>` with the time omitted. Those return
 * null and the API falls back to when the server first saw the entry, so the
 * UI can always show something more precise than a bare date.
 *
 * Returned without a zone suffix on purpose: the team writes the owner's local wall-clock
 * time, and `new Date("2026-08-15T17:30:00")` reads that as local, which is what
 * the dashboard should render.
 */
export function statedAtFromId(id: string): string | null {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(?:\D|$)/);
  if (!m) return null;
  const [, date, hh, mm] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  return `${date}T${hh}:${mm}:00`;
}

/** Same as `statedAtFromId`, for a heading stamp like `2026-10-06 14:40`. */
export function statedAtFromHeading(stamp: string): string | null {
  const m = stamp.match(/(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const [, date, hh, mm] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  return `${date}T${hh.padStart(2, "0")}:${mm}:00`;
}

/** Recipient tokens that mean "everyone", the owner included. */
const BROADCAST = new Set(["all", "everyone", "team"]);

/**
 * Teammates who do work for CVB. Their task reports go to CVB, not the owner,
 * so a post from one of them that names no addressee is CVB's to read. CVB and
 * scheduled scripts are not on this list: when they post without an
 * addressee, it is for the owner. Add a teammate here when you add one who
 * reports to CVB.
 */
const WORKERS = new Set(["devin", "casey", "maya"]);

/**
 * The recipient tokens that mean the owner: always "owner", plus the owner's
 * first name and full name as configured in settings.json ownerName, so
 * `to: jane` and `to: jane-smith` both work. Lowercased.
 */
export function ownerTokens(ownerFullName: string): string[] {
  const full = ownerFullName.trim().toLowerCase();
  const out = new Set(["owner"]);
  if (full) {
    out.add(full.split(/\s+/)[0]);
    out.add(full.replace(/\s+/g, "-"));
    out.add(full.replace(/\s+/g, ""));
  }
  return [...out];
}

/**
 * True when the owner should see this post in the Inbox.
 *
 * - Addressed to the owner (see ownerTokens), or to everyone: yes.
 * - Addressed only to other teammates: no. That traffic is theirs.
 * - Addressed to nobody: yes from CVB or a script, no from a worker, unless
 *   the worker marked it urgent.
 */
export function isForOwner(entry: InboxEntry, owner: readonly string[] = ["owner"]): boolean {
  const to = entry.to.map((s) => s.toLowerCase());
  if (to.length > 0) return to.some((s) => owner.includes(s) || BROADCAST.has(s));
  if (entry.priority === "high") return true;
  const sender = (entry.from || entry.agent).toLowerCase().match(/[a-z]+/)?.[0] ?? "";
  return !WORKERS.has(sender);
}

/** Map every legacy id to the id it now reads as, for the state store. */
export function legacyIdRenames(entries: InboxEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) for (const old of e.legacyIds ?? []) out[old] = e.id;
  return out;
}
