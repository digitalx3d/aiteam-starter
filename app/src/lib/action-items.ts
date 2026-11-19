import { discoverProjects } from "./projects";
import { listTasks, type Task } from "./tasks";
import { getOwnerName } from "./config";

/**
 * The owner's action items: every task, on any project board, assigned to the
 * owner. This is a live view, not a copy, so ticking one off here and ticking
 * it off on the board are the same write and the two can never disagree.
 *
 * CVB fills it by creating owner-assigned tasks on the relevant board whenever
 * the owner is handed something to do, in a chat or in a teammate's report (see the
 * "Action items for the owner" rule in vault/team/operating-rules.md).
 */

export interface ActionItem extends Task {
  /** Project folder the task lives in; the slug for the tasks API. */
  project: string;
  /** Other project folders carrying a copy of the same task id. */
  alsoIn: string[];
}

/** aiTeam is hidden from the project list but its board is where Bridge items go. */
const BRIDGE_PROJECT = "aiTeam";

const CACHE_MS = 10_000;
let cache: { items: ActionItem[]; at: number } | null = null;

function isOwner(assignee: string | null): boolean {
  if (!assignee) return false;
  const a = assignee.trim().toLowerCase();
  const owner = getOwnerName();
  return (
    a === owner.first.toLowerCase() ||
    a === owner.full.toLowerCase() ||
    a === owner.full.toLowerCase().replace(/\s+/g, "-")
  );
}

export function invalidateActionItems(): void {
  cache = null;
}

export async function listActionItems(): Promise<ActionItem[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.items;

  const projects = (await discoverProjects()).map((p) => p.slug);
  if (!projects.includes(BRIDGE_PROJECT)) projects.unshift(BRIDGE_PROJECT);

  const perProject = await Promise.all(
    projects.map(async (slug) => {
      const tasks = await listTasks(slug).catch(() => [] as Task[]);
      return tasks
        .filter((t) => isOwner(t.assignee))
        .map((t) => ({ ...t, project: slug, alsoIn: [] as string[] }));
    })
  );

  // Copied project folders (BakerySite, BakerySite-1.3, ...) carry the same
  // task file, so the same id turns up more than once. Show it once, from the
  // copy touched most recently; ties go to the shortest folder name, which is
  // the original rather than a versioned copy.
  const byId = new Map<string, ActionItem[]>();
  for (const item of perProject.flat()) {
    const list = byId.get(item.id) ?? [];
    list.push(item);
    byId.set(item.id, list);
  }
  const items: ActionItem[] = [];
  for (const copies of byId.values()) {
    copies.sort(
      (a, b) =>
        b.updated.localeCompare(a.updated) ||
        a.project.length - b.project.length
    );
    const [primary, ...rest] = copies;
    primary.alsoIn = rest.map((c) => c.project);
    items.push(primary);
  }

  cache = { items, at: Date.now() };
  return items;
}
