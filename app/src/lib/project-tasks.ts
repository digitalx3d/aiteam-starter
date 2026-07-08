import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface ProjectTask {
  id: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  createdMs: number;
  updatedMs: number;
  /** Body markdown after the frontmatter. */
  description: string;
  /** Absolute path to the task file. */
  path: string;
}

const VALID_STATUSES = new Set<TaskStatus>(["todo", "in-progress", "blocked", "done"]);
const VALID_PRIORITIES = new Set<TaskPriority>(["low", "medium", "high"]);
const PRIORITY_RANK: Record<TaskPriority, number> = { high: 3, medium: 2, low: 1 };

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === "null" || val === "~") val = "";
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    meta[kv[1]] = val;
  }
  return { meta, body: m[2] };
}

function toMs(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : fallback;
}

async function readOneTask(filePath: string): Promise<ProjectTask | null> {
  try {
    const [text, st] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const { meta, body } = parseFrontmatter(text);
    const id = meta.id || path.basename(filePath, ".md");
    const title = meta.title || path.basename(filePath, ".md");
    const status: TaskStatus = VALID_STATUSES.has(meta.status as TaskStatus)
      ? (meta.status as TaskStatus)
      : "todo";
    const priority: TaskPriority = VALID_PRIORITIES.has(meta.priority as TaskPriority)
      ? (meta.priority as TaskPriority)
      : "medium";
    return {
      id,
      title,
      assignee: meta.assignee || null,
      status,
      priority,
      due: meta.due || null,
      createdMs: toMs(meta.created, st.mtimeMs),
      updatedMs: toMs(meta.updated, st.mtimeMs),
      description: body.trim(),
      path: filePath,
    };
  } catch {
    return null;
  }
}

/** List all task files in a project's .aiteam/tasks directory. */
export async function listProjectTasks(projectRoot: string): Promise<ProjectTask[]> {
  const dir = path.join(projectRoot, ".aiteam", "tasks");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const tasks: ProjectTask[] = [];
  for (const n of names) {
    if (!n.toLowerCase().endsWith(".md")) continue;
    const t = await readOneTask(path.join(dir, n));
    if (t) tasks.push(t);
  }
  return tasks;
}

/**
 * Return the most important *open* tasks for a project.
 * Important = not done, sorted high → medium → low priority, ties broken
 * by most-recently-updated.
 */
export function pickTopTasks(tasks: ProjectTask[], limit: number): ProjectTask[] {
  return tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => {
      const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (p !== 0) return p;
      return b.updatedMs - a.updatedMs;
    })
    .slice(0, limit);
}

/** Latest task mtime in a project, or 0 if no tasks. */
export function latestTaskMtime(tasks: ProjectTask[]): number {
  let max = 0;
  for (const t of tasks) {
    if (t.updatedMs > max) max = t.updatedMs;
  }
  return max;
}
