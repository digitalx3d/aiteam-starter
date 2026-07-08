import path from "node:path";
import { promises as fsp } from "node:fs";
import { getConfig } from "./config";

/**
 * "Recent discussion" items mined from a project's rolling primer
 * (vault/agents/claude/summaries/<scope>.md). The primer is CVB's own
 * plain-language hand-off to the next session, so its bullets read like things
 * a person would say — exactly what belongs on the dashboard, unlike raw agent
 * task titles. We pull from the action-oriented sections only.
 */

export interface HistoryItem {
  text: string;
  /** Which primer section it came from — used only for ordering/labeling. */
  section: string;
}

// Sections worth surfacing, in display-priority order. "Decided" and "Context"
// are deliberately excluded: they're history/background, not open items.
const MINE_SECTIONS = ["Open threads", "In flight", "Blocked"];
const MAX_LEN = 140;

/** The dashboard's own chat (the aiTeam card) runs in the "default" scope. */
function scopeForSlug(slug: string): string {
  return slug === "aiTeam" ? "default" : `project:${slug}`;
}

function safeScope(scope: string): string {
  return scope.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function cleanBullet(raw: string): string {
  let s = raw
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[\[([^\]]+)\]\]/g, "$1") // wikilinks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // markdown links
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN - 1).trimEnd() + "…";
  return s;
}

export function parsePrimerItems(md: string): HistoryItem[] {
  const bySection = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#{2,3}\s+(.+?)\s*$/);
    if (h) {
      current = h[1].trim();
      continue;
    }
    if (!current || !MINE_SECTIONS.includes(current)) continue;
    // Top-level bullets only (tolerate a single leading space).
    const b = line.match(/^ ?[-*]\s+(.+)$/);
    if (!b) continue;
    const text = cleanBullet(b[1]);
    if (!text) continue;
    const arr = bySection.get(current) ?? [];
    arr.push(text);
    bySection.set(current, arr);
  }

  const items: HistoryItem[] = [];
  for (const section of MINE_SECTIONS) {
    for (const text of bySection.get(section) ?? []) {
      items.push({ text, section });
    }
  }
  return items;
}

export async function readProjectHistoryItems(
  slug: string
): Promise<HistoryItem[]> {
  const file = path.join(
    getConfig().vaultDir,
    "agents",
    "claude",
    "summaries",
    `${safeScope(scopeForSlug(slug))}.md`
  );
  let raw = "";
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  return parsePrimerItems(raw);
}
