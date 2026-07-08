import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveProjectCwd } from "./projects";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  created: string;
  updated: string;
}

const VALID_STATUSES: TaskStatus[] = [
  "todo",
  "in-progress",
  "blocked",
  "done",
];
const VALID_PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

function tasksDirFor(projectCwd: string): string {
  return path.join(projectCwd, ".aiteam", "tasks");
}

async function ensureTasksDir(projectCwd: string): Promise<string> {
  const dir = tasksDirFor(projectCwd);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function isoDate(d: Date = new Date()): string {
  return d.toISOString();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return base.slice(0, 60) || "task";
}

/** Trivial flat-key YAML parser. Strings (quoted or bare), `null`, dates. */
function parseFrontmatter(raw: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value === "" || value === "null" || value === "~") {
      out[key] = null;
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Emit a flat-key YAML block. Quotes strings that contain `:` or start with special chars. */
function stringifyFrontmatter(data: Record<string, string | null>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
      continue;
    }
    const needsQuote =
      /[:#&*?{}\[\]|>!%@`,]/.test(v) ||
      /^\s|\s$/.test(v) ||
      /^(true|false|null|yes|no|~)$/i.test(v);
    if (needsQuote) {
      lines.push(`${k}: "${v.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n");
}

function splitFrontmatter(content: string): {
  meta: Record<string, string | null>;
  body: string;
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  return { meta: parseFrontmatter(m[1]), body: m[2].trimStart() };
}

function buildTaskFile(task: Task): string {
  const meta: Record<string, string | null> = {
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    priority: task.priority,
    due: task.due,
    created: task.created,
    updated: task.updated,
  };
  return `---\n${stringifyFrontmatter(meta)}\n---\n\n${task.description ?? ""}\n`;
}

function normalizeStatus(s: string | null | undefined): TaskStatus {
  if (s && (VALID_STATUSES as string[]).includes(s)) return s as TaskStatus;
  return "todo";
}

function normalizePriority(p: string | null | undefined): TaskPriority {
  if (p && (VALID_PRIORITIES as string[]).includes(p)) return p as TaskPriority;
  return "medium";
}

function normalizeDue(d: string | null | undefined): string | null {
  if (!d) return null;
  // Accept YYYY-MM-DD only.
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function parseTaskFile(content: string, fallbackId: string): Task {
  const { meta, body } = splitFrontmatter(content);
  const created = meta.created ?? isoDate();
  return {
    id: meta.id ?? fallbackId,
    title: meta.title ?? "(untitled)",
    description: body.trim(),
    assignee: meta.assignee ?? null,
    status: normalizeStatus(meta.status),
    priority: normalizePriority(meta.priority),
    due: normalizeDue(meta.due),
    created,
    updated: meta.updated ?? created,
  };
}

async function pathForId(
  projectCwd: string,
  id: string
): Promise<string | null> {
  const dir = tasksDirFor(projectCwd);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf8");
      const { meta } = splitFrontmatter(raw);
      if (meta.id === id) return full;
    } catch {
      /* skip */
    }
  }
  return null;
}

async function uniqueFilename(
  projectCwd: string,
  baseSlug: string
): Promise<string> {
  const dir = tasksDirFor(projectCwd);
  let candidate = `${baseSlug}.md`;
  let n = 1;
  while (true) {
    try {
      await fsp.access(path.join(dir, candidate));
      n += 1;
      candidate = `${baseSlug}-${n}.md`;
    } catch {
      return candidate;
    }
  }
}

export async function listTasks(slug: string): Promise<Task[]> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return [];
  const dir = tasksDirFor(cwd);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf8");
      tasks.push(parseTaskFile(raw, name.replace(/\.md$/, "")));
    } catch {
      /* skip unreadable */
    }
  }
  // Sort: open work first (todo > in-progress > blocked > done), then priority high>low, then due asc, then created desc.
  const statusOrder: Record<TaskStatus, number> = {
    todo: 0,
    "in-progress": 1,
    blocked: 2,
    done: 3,
  };
  const priorityOrder: Record<TaskPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  tasks.sort((a, b) => {
    const s = statusOrder[a.status] - statusOrder[b.status];
    if (s !== 0) return s;
    const p = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (p !== 0) return p;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return b.created.localeCompare(a.created);
  });
  return tasks;
}

export async function getTask(
  slug: string,
  id: string
): Promise<Task | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  const file = await pathForId(cwd, id);
  if (!file) return null;
  try {
    const raw = await fsp.readFile(file, "utf8");
    return parseTaskFile(raw, id);
  } catch {
    return null;
  }
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignee?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due?: string | null;
}

export async function createTask(
  slug: string,
  input: CreateTaskInput
): Promise<Task | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  await ensureTasksDir(cwd);

  const now = isoDate();
  const id = `t-${randomUUID().slice(0, 8)}`;
  const task: Task = {
    id,
    title: input.title.trim() || "(untitled)",
    description: (input.description ?? "").trim(),
    assignee: input.assignee?.trim() || null,
    status: normalizeStatus(input.status),
    priority: normalizePriority(input.priority),
    due: normalizeDue(input.due ?? null),
    created: now,
    updated: now,
  };

  const filename = await uniqueFilename(cwd, slugifyTitle(task.title));
  const full = path.join(tasksDirFor(cwd), filename);
  await fsp.writeFile(full, buildTaskFile(task), "utf8");
  return task;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  assignee?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due?: string | null;
}

export async function updateTask(
  slug: string,
  id: string,
  input: UpdateTaskInput
): Promise<Task | null> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return null;
  const file = await pathForId(cwd, id);
  if (!file) return null;

  const raw = await fsp.readFile(file, "utf8");
  const existing = parseTaskFile(raw, id);
  const next: Task = {
    ...existing,
    title:
      input.title !== undefined ? input.title.trim() || existing.title : existing.title,
    description:
      input.description !== undefined
        ? input.description.trim()
        : existing.description,
    assignee:
      input.assignee !== undefined
        ? input.assignee?.trim() || null
        : existing.assignee,
    status:
      input.status !== undefined ? normalizeStatus(input.status) : existing.status,
    priority:
      input.priority !== undefined
        ? normalizePriority(input.priority)
        : existing.priority,
    due:
      input.due !== undefined ? normalizeDue(input.due) : existing.due,
    updated: isoDate(),
  };
  await fsp.writeFile(file, buildTaskFile(next), "utf8");
  return next;
}

export async function deleteTask(slug: string, id: string): Promise<boolean> {
  const cwd = resolveProjectCwd(slug);
  if (!cwd) return false;
  const file = await pathForId(cwd, id);
  if (!file) return false;
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

export const TASK_STATUSES = VALID_STATUSES;
export const TASK_PRIORITIES = VALID_PRIORITIES;
export { todayIso };
