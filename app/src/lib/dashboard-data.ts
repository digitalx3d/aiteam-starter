import { stat } from "node:fs/promises";
import path from "node:path";
import { discoverProjects } from "./projects";
import { getConfig } from "./config";
import { readChatState } from "./chat-state";
import {
  listProjectTasks,
  pickTopTasks,
  latestTaskMtime,
  type ProjectTask,
  type TaskPriority,
} from "./project-tasks";
import {
  readBig3ActiveByRoot,
  big3MtimeByRoot,
  type Big3Item,
} from "./big3";
import { readProjectHistoryItems, type HistoryItem } from "./project-history";

/** Where a dashboard card item came from. Drives its little leading marker. */
export type CardItemSource = "big3" | "history" | "task";

export interface CardItem {
  text: string;
  source: CardItemSource;
  /** Task-only metadata (undefined for big3/history items). */
  priority?: TaskPriority;
  assignee?: string | null;
  inProgress?: boolean;
  blocked?: boolean;
}

export interface TopProjectCard {
  slug: string;
  name: string;
  /** Best signal of how recently John was active here. */
  activityMs: number;
  /** Plain-language items: Big 3 first, then recent discussion, tasks last. */
  items: CardItem[];
  /** Count of open tasks on the board (for a subtle "more on the board" hint). */
  openTaskCount: number;
}

const CARD_ITEM_LIMIT = 4;

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Agent task titles are often "Lead clause: jargon, jargon, jargon"
 * (e.g. "Harden config: bound values, clamp grants, sign config.json").
 * On the dashboard we want plain language, so keep just the lead clause when a
 * colon-delimited tail is clearly the technical detail.
 */
function plainifyTaskTitle(title: string): string {
  const t = title.trim();
  const colon = t.indexOf(":");
  if (colon >= 6 && colon <= 48) return t.slice(0, colon).trim();
  return t;
}

/**
 * Assemble a card's items from the three sources in priority order, de-duping
 * by normalized text and capping the total. Big 3 (John's own notes) win ties;
 * the task board is the last resort because its titles are agent-specific.
 */
function buildCardItems(
  big3Active: Big3Item[],
  history: HistoryItem[],
  tasks: ProjectTask[],
  limit: number
): CardItem[] {
  const items: CardItem[] = [];
  const seen = new Set<string>();

  const tryPush = (text: string, make: () => CardItem) => {
    if (items.length >= limit) return;
    const key = normKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(make());
  };

  for (const it of big3Active) {
    tryPush(it.text, () => ({ text: it.text, source: "big3" }));
  }
  for (const h of history) {
    tryPush(h.text, () => ({ text: h.text, source: "history" }));
  }
  for (const t of pickTopTasks(tasks, limit)) {
    const text = plainifyTaskTitle(t.title);
    tryPush(text, () => ({
      text,
      source: "task",
      priority: t.priority,
      assignee: t.assignee,
      inProgress: t.status === "in-progress",
      blocked: t.status === "blocked",
    }));
  }

  return items;
}

/** Find the session jsonl for a project's dashboard chat and return its mtime. */
async function sessionMtimeMs(projectRoot: string, slug: string): Promise<number> {
  const state = await readChatState(slug);
  if (!state) return 0;
  const encoded = projectRoot.replace(/[:\\/]/g, "-");
  const jsonl = path.join(
    getConfig().claudeProjectsDir,
    encoded,
    `${state.sessionId}.jsonl`
  );
  try {
    const s = await stat(jsonl);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Return the top-N most-active projects, each with its top open tasks.
 * Activity score = max(latest chat-session jsonl mtime, latest task file mtime).
 * aiTeam itself is included even though /projects hides it — the dashboard is
 * where its tasks belong.
 */
export async function getTopActiveProjects(
  limit: number,
  itemsPerProject: number = CARD_ITEM_LIMIT
): Promise<TopProjectCard[]> {
  const discovered = await discoverProjects();

  // Re-add aiTeam — discoverProjects() hides it because the /projects page
  // shouldn't list the dashboard's own repo, but the dashboard cards should.
  const aiteamRoot = getConfig().aiteamDir;
  let aiteamMtime = 0;
  try {
    aiteamMtime = (await stat(aiteamRoot)).mtimeMs;
  } catch {
    /* repo not at expected path; skip */
  }
  const all = aiteamMtime > 0
    ? [
        {
          slug: "aiTeam",
          name: "aiTeam",
          path: aiteamRoot,
          modifiedMs: aiteamMtime,
          hasGit: true,
          hasClaude: true,
          hasPackageJson: false,
          hasAiteam: true,
          hidden: false,
        },
        ...discovered,
      ]
    : discovered;

  const scored = await Promise.all(
    all.map(async (p) => {
      const [tasks, big3Active, big3Mtime, history] = await Promise.all([
        listProjectTasks(p.path),
        readBig3ActiveByRoot(p.path),
        big3MtimeByRoot(p.path),
        readProjectHistoryItems(p.slug),
      ]);
      const chatMtime = await sessionMtimeMs(p.path, p.slug);
      // Editing the Big 3 is real activity too, so a project John just jotted a
      // reminder into surfaces even without chat/task churn.
      const activityMs = Math.max(
        latestTaskMtime(tasks),
        chatMtime,
        big3Mtime
      );
      return { project: p, tasks, big3Active, history, activityMs };
    })
  );

  // Sort by activity desc. Projects with zero activity (no chat history, no
  // tasks, no Big 3) sink to the bottom; we'll truncate before showing them.
  scored.sort((a, b) => b.activityMs - a.activityMs);

  return scored
    .filter((s) => s.activityMs > 0)
    .slice(0, limit)
    .map((s) => ({
      slug: s.project.slug,
      name: s.project.name,
      activityMs: s.activityMs,
      items: buildCardItems(
        s.big3Active,
        s.history,
        s.tasks,
        itemsPerProject
      ),
      openTaskCount: s.tasks.filter((t) => t.status !== "done").length,
    }));
}
