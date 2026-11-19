import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseInboxDetailed, legacyIdRenames, isForOwner, ownerTokens } from "@/lib/inbox-parse";
import { syncInboxState, isRealSighting } from "@/lib/inbox-state";
import { getConfig, getOwnerName } from "@/lib/config";
import { resolveProject } from "@/lib/inbox-project";
import { PROJECT_ALIASES } from "@/lib/project-mention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const inboxPath = path.join(getConfig().aiteamDir, "inbox-shared.md");
  try {
    const text = await readFile(inboxPath, "utf8");
    const parsed = parseInboxDetailed(text);
    const { skipped } = parsed;

    // Records first-seen for anything new and prunes state for archived ids.
    // The watcher started in instrumentation.ts normally gets there first; this
    // is the backstop for entries written while the watcher was down. Synced
    // over every post, not just the owner's, so hidden posts keep their state.
    const state = await syncInboxState(
      parsed.entries.map((e) => e.id),
      legacyIdRenames(parsed.entries)
    );

    // The Inbox is the owner's. Posts between teammates (worker reports to CVB
    // and the like) stay in the file for the agents and are not shown or counted.
    const owner = ownerTokens(getOwnerName().full);
    const entries = parsed.entries.filter((e) => isForOwner(e, owner));

    // Give every post its project as a field of its own, named by folder.
    const projectNames = await projectFolderNames();
    for (const entry of entries) Object.assign(entry, resolveProject(entry, projectNames, PROJECT_ALIASES));

    // Every entry gets a posting time where one can be had honestly: the time
    // the entry states, or the moment we first saw it. Marked approximate in
    // the second case so the UI can say so rather than present a guess as fact.
    for (const entry of entries) {
      if (entry.statedAt) {
        entry.postedAt = entry.statedAt;
        entry.postedAtApprox = false;
        continue;
      }
      const seen = state.seen[entry.id];
      // First-seen is only meaningful for entries that appeared while the
      // server was watching. Entries present on the first run carry a marker
      // instead of a stamp, and even a real sighting is only trusted when it
      // lands on the entry's own date (a restart after downtime can stamp an
      // older entry with the moment the server came back). Anything else
      // leaves the time unknown and the UI shows the date alone.
      const usable = isRealSighting(seen) && localDate(seen) === entryDate(entry);
      entry.postedAt = usable ? seen : null;
      entry.postedAtApprox = usable;
    }
    for (const entry of entries) delete entry.legacyIds;

    // Newest day first. The file is meant to be newest-at-top, but agents also
    // append at the bottom, and file order alone left October posts under
    // August ones. Stable sort, so the file's order holds within a day.
    const day = (e: (typeof entries)[number]) =>
      (e.postedAt ?? e.statedAt ?? entryDate(e) ?? "").slice(0, 10);
    entries.sort((a, b) => day(b).localeCompare(day(a)));

    // `skipped` lists what was deliberately left out (the file's own header,
    // schema templates, literal reposts) so nothing disappears without a trace.
    // Posts in an unreadable format are not in it: they are entries, flagged
    // with `formatIssue`.
    return new Response(
      JSON.stringify({ entries, skipped, read: Object.keys(state.read), path: inboxPath }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        entries: [],
        skipped: [],
        read: [],
        path: inboxPath,
        error: (err as Error).message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Folder names under the projects root, aiTeam included (the Projects page
 * hides it, but posts are often about it). Names only, no stat calls: the
 * sidebar badge polls this route every 30 seconds.
 */
async function projectFolderNames(): Promise<string[]> {
  try {
    const dirents = await readdir(getConfig().projectsRoot, { withFileTypes: true });
    return dirents
      .filter((d) => d.isDirectory() && !/^[.$]/.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Calendar date of an ISO stamp in the server's own timezone, "YYYY-MM-DD". */
function localDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The date the entry claims for itself, from its id, else from its header. */
function entryDate(entry: { id: string; timestamp: string }): string | null {
  const fromId = entry.id.match(/^(\d{4}-\d{2}-\d{2})/);
  if (fromId) return fromId[1];
  const fromHeader = entry.timestamp.match(/(\d{4}-\d{2}-\d{2})/);
  return fromHeader ? fromHeader[1] : null;
}
