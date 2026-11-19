import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { assigneeLookup, canonicalAssignee } from "./tasks";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface ProjectTask {
  id: string;
  /** Per-project sequence number (#0042), or null for pre-numbering tasks. */
  num: number | null;
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

/**
 * Parsed task files, reused until the file's modified time or size changes.
 *
 * The Projects page and The Bridge both list every board, ~3,000 files. Inside
 * the pm2-run dashboard each file read costs several times what it does from a
 * console, and reading them all one at a time per request made /projects take
 * ~2s (measured 2026-10-16). Now a request costs one stat per file, run in
 * parallel, and only changed files are read.
 */
const taskCache = new Map<string, { mtimeMs: number; size: number; task: ProjectTask }>();

async function readOneTask(filePath: string): Promise<ProjectTask | null> {
  try {
    const st = await stat(filePath);
    const hit = taskCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.task;
    const task = parseTask(filePath, await readFile(filePath, "utf8"), st.mtimeMs);
    taskCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, task });
    return task;
  } catch {
    taskCache.delete(filePath);
    return null;
  }
}

function parseTask(filePath: string, text: string, mtimeMs: number): ProjectTask {
  const { meta, body } = parseFrontmatter(text);
  const id = meta.id || path.basename(filePath, ".md");
  const title = meta.title || path.basename(filePath, ".md");
  const status: TaskStatus = VALID_STATUSES.has(meta.status as TaskStatus)
    ? (meta.status as TaskStatus)
    : "todo";
  const priority: TaskPriority = VALID_PRIORITIES.has(meta.priority as TaskPriority)
    ? (meta.priority as TaskPriority)
    : "medium";
  const parsedNum = Number.parseInt(meta.num ?? "", 10);
  return {
    id,
    num: Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : null,
    title,
    assignee: meta.assignee || null,
    status,
    priority,
    due: meta.due || null,
    createdMs: toMs(meta.created, mtimeMs),
    updatedMs: toMs(meta.updated, mtimeMs),
    description: body.trim(),
    path: filePath,
  };
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
  const lookup = await assigneeLookup();
  const read = await Promise.all(
    names
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .map((n) => readOneTask(path.join(dir, n)))
  );
  // Copies, so a caller editing a task can't change what the cache holds.
  // Agents write "devin"; the team roster says "Devin".
  return read
    .filter((t): t is ProjectTask => t !== null)
    .map((t) => ({ ...t, assignee: canonicalAssignee(t.assignee, lookup) }));
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
