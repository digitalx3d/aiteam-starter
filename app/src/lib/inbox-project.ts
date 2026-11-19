import type { InboxEntry } from "./inbox-parse";

/**
 * Which project an inbox post is about, as its own field.
 *
 * Agents put the project wherever they like: after their name in the heading
 * ("Devin BakerySite: menu page"), in front of the title ("BakerySite: menu
 * page"), as a brand at the start of the title ("Bakery-Site 1.2 shipped"), or
 * on the id line (`**project:** BakerySite`). This reads all four and names
 * the project the way the Projects page does, by its folder name, so one
 * project never shows up under two spellings.
 *
 * Pure: the caller passes the project folder names and the nickname table
 * (PROJECT_ALIASES in project-mention.ts), so tests can run it without the app.
 */

/** Team members who sign posts. A heading agent of "<member> <word>" carries a project. */
const TEAM = new Set([
  "cvb", "devin", "casey", "maya",
]);

/** Lowercase letters and digits only: "Bakery-Site" and "bakerysite" are the same term. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Term -> folder name, from the folder names and the alias table. */
function termMap(
  projectNames: string[],
  aliases: Record<string, string[]>
): Map<string, string> {
  const map = new Map<string, string>();
  const folders = new Set(projectNames);
  for (const name of projectNames) {
    const key = norm(name);
    // A release worktree ("BakerySite-1.3") is the same project as its repo.
    const base = name.match(/^(.+)-\d[\d.]*$/)?.[1];
    // Too short to tell apart from an ordinary word.
    if (key.length >= 4) map.set(key, base && folders.has(base) ? base : name);
    for (const alias of aliases[name.toLowerCase()] ?? []) {
      const a = norm(alias);
      if (a.length >= 4 && !map.has(a)) map.set(a, name);
    }
  }
  return map;
}

/**
 * The project the first one to three words of `text` name, if they name one.
 * `rest` is the text after it, with a separating colon or comma dropped.
 */
function leadingProject(
  text: string,
  terms: Map<string, string>
): { project: string; rest: string; separated: boolean } | null {
  const words = text.trim().split(/\s+/);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const head = words.slice(0, n).join(" ");
    const sep = /[:,]$/.test(head);
    const project = terms.get(norm(head));
    if (!project) continue;
    return { project, rest: words.slice(n).join(" "), separated: sep };
  }
  return null;
}

export function resolveProject(
  entry: InboxEntry,
  projectNames: string[],
  aliases: Record<string, string[]> = {}
): Pick<InboxEntry, "project" | "agent" | "title"> {
  const terms = termMap(projectNames, aliases);
  const named = (raw: string) => terms.get(norm(raw)) ?? raw.trim();
  let { agent, title } = entry;
  let project = entry.project ? named(entry.project) : undefined;

  // "Devin BakerySite" -> Devin, BakerySite.
  const agentWords = agent.trim().split(/\s+/);
  if (agentWords.length > 1 && TEAM.has(agentWords[0].toLowerCase())) {
    project ??= named(agentWords.slice(1).join(" "));
    agent = agentWords[0];
  }

  // A script signs with its own name ("aiTeam config backup"); the name can
  // say which project it belongs to, and stays the sender.
  if (!project && !TEAM.has(agentWords[0].toLowerCase())) {
    project = leadingProject(agent, terms)?.project;
  }

  // "[HIGH] BakerySite, checkout ...": the tag is already the Urgent badge.
  title = title.replace(/^\[[^\]]*\]\s*/, "") || title;

  // "BakerySite: menu page" -> BakerySite, "menu page". A project name that
  // starts a sentence ("Bakery-Site 1.2 shipped") labels the post but stays in
  // the title, which would not read without it.
  const lead = leadingProject(title, terms);
  if (lead) {
    if (!project) project = lead.project;
    if (lead.separated && lead.project === project && lead.rest) title = lead.rest;
  }

  // "Opening-hours email (BakerySite)".
  const tail = title.match(/^(.+?)\s*\(([^()]+)\)$/);
  if (tail) {
    const named = terms.get(norm(tail[2]));
    if (named && (!project || named === project)) {
      project = named;
      title = tail[1];
    }
  }

  return { project, agent, title };
}
