export type InboxPriority = "low" | "medium" | "high";

export interface InboxEntry {
  id: string;
  from: string;
  to: string[];
  priority: InboxPriority;
  /** Header timestamp string as it appears in the file (no normalization). */
  timestamp: string;
  /** Agent name as shown in the header (e.g. "Indy", "CVB"). */
  agent: string;
  title: string;
  /** Body markdown after the metadata line, trimmed. */
  body: string;
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
 * Entries are separated by a line containing only `---`. Legacy entries
 * without an `id` field are skipped per the file's own rules.
 *
 * The separator dot may appear as `·` or as the mojibake'd `Â·` (the file
 * has both forms in the wild); the field regex tolerates either.
 */
export function parseInbox(markdown: string): InboxEntry[] {
  const chunks = markdown.split(/\r?\n---\r?\n/);
  const entries: InboxEntry[] = [];
  // Dedupe by id, keeping the first occurrence. The shared inbox occasionally
  // accumulates literal reposts (e.g., when a scheduled digest runs manually
  // after a failed scheduled run); rendering them all just inflates the unread
  // count and triggers React duplicate-key warnings.
  const seenIds = new Set<string>();
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\r?\n/);
    const headerLine = lines[0] ?? "";
    const headerMatch = headerLine.match(/^##\s+(.+?)\s+--\s+([^:]+):\s+(.+)$/);
    if (!headerMatch) continue;
    const [, timestamp, agent, title] = headerMatch;

    const metaIdx = lines.findIndex(
      (l) => l.startsWith(">") && l.includes("**id:**")
    );
    if (metaIdx === -1) continue;
    const metaLine = lines[metaIdx];

    const id = matchField(metaLine, "id");
    if (!id) continue;
    // The file's header includes a schema example with placeholder ids like
    // `<YYYY-MM-DDTHHMM>-<from>-<slug>` inside a code fence. The fence doesn't
    // protect against our `---` splitter, so we skip anything that still has
    // template angle brackets — real ids never contain them.
    if (id.includes("<") || id.includes(">")) continue;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const from = matchField(metaLine, "from") ?? "";
    const toRaw = matchField(metaLine, "to") ?? "";
    const priorityRaw = (matchField(metaLine, "priority") ?? "medium").toLowerCase();
    const priority: InboxPriority = (PRIORITY_VALUES.has(priorityRaw as InboxPriority)
      ? priorityRaw
      : "medium") as InboxPriority;

    const body = lines
      .slice(metaIdx + 1)
      .join("\n")
      .trim();

    entries.push({
      id,
      from,
      to: toRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      priority,
      timestamp: timestamp.trim(),
      agent: agent.trim(),
      title: title.trim(),
      body,
    });
  }
  return entries;
}

function matchField(line: string, field: string): string | null {
  // Match `**field:** value`, stopping at:
  //   - a dot separator (`·` U+00B7 or its mojibake'd form `Â·`),
  //   - the start of the next bold field marker (`**`), so entries that used
  //     double-space separators instead of dots still parse, or
  //   - end-of-line.
  const re = new RegExp(
    `\\*\\*${field}:\\*\\*\\s*([^·Â*\\n]+?)(?=\\s*(?:[·Â]|\\*\\*|$))`,
    "i"
  );
  const m = line.match(re);
  return m ? m[1].trim() : null;
}
