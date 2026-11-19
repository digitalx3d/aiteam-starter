import path from "node:path";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveProjectCwd } from "./projects";
import { agentDisplayNames } from "./agents";

export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  /**
   * Human-facing per-project sequence number, displayed as #0042.
   * Null for "legacy" tasks that predate numbering (see ensureCounter).
   */
  num: number | null;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  created: string;
  updated: string;
  /** ISO timestamp of when status last became "done", else null. */
  completed: string | null;
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

/* ------------------------------------------------------------------ *
 * Assignee spelling
 *
 * Agents write task files by hand and normally use the lowercase slug
 * ("assignee: devin"), while the dashboard's dropdown is built from
 * capitalized display names ("Devin"). The row badge printed the raw
 * value so the task looked assigned, but the dropdown found no matching
 * option and fell back to "Unassigned", and the filter missed it too.
 * Reconcile case-insensitively on the way in and out.
 * ------------------------------------------------------------------ */

let displayNameCache: { map: Map<string, string>; at: number } | null = null;

export async function assigneeLookup(): Promise<Map<string, string>> {
  const now = Date.now();
  if (displayNameCache && now - displayNameCache.at < 30_000) {
    return displayNameCache.map;
  }
  const map = new Map<string, string>();
  try {
    for (const name of await agentDisplayNames()) {
      map.set(name.toLowerCase(), name);
    }
  } catch {
    /* roster unreadable: fall back to raw spellings */
  }
  displayNameCache = { map, at: now };
  return map;
}

/** Map a stored assignee onto its canonical display name. Unknown names pass through. */
export function canonicalAssignee(
  raw: string | null,
  lookup: Map<string, string>
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // "devin-mcclane" and "Devin" are the same person.
  const slug = trimmed.split("-")[0].toLowerCase();
  return lookup.get(trimmed.toLowerCase()) ?? lookup.get(slug) ?? trimmed;
}

/* ------------------------------------------------------------------ *
 * Per-project task numbering
 *
 * Every project gets its own counter starting at 1, rendered as #0001.
 * Tasks that already existed when numbering was switched on are recorded
 * as "legacy" by filename and deliberately never numbered, so history
 * isn't rewritten. Numbers are assigned on read as well as on create,
 * because agents write task files directly with plain file tools and
 * never touch this API.
 * ------------------------------------------------------------------ */

const COUNTER_FILE = ".task-counter.json";

interface TaskCounter {
  /** Next number to hand out. */
  next: number;
  /** Filenames present at switch-on. Never numbered. */
  legacy: string[];
  initialized: string;
}

/**
 * Serialize per-project counter access. Node is single-threaded but the
 * read-modify-write below spans awaits, so two concurrent requests could
 * otherwise hand out the same number.
 */
const counterLocks = new Map<string, Promise<unknown>>();

function withCounterLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = counterLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  counterLocks.set(
    key,
    run.catch(() => {})
  );
  return run;
}

async function taskFilenames(projectCwd: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(tasksDirFor(projectCwd));
    return entries.filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
}

async function readCounter(projectCwd: string): Promise<TaskCounter | null> {
  try {
    const raw = await fsp.readFile(
      path.join(tasksDirFor(projectCwd), COUNTER_FILE),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<TaskCounter>;
    if (typeof parsed.next !== "number" || !Number.isFinite(parsed.next)) {
      return null;
    }
    return {
      next: Math.max(1, Math.floor(parsed.next)),
      legacy: Array.isArray(parsed.legacy) ? parsed.legacy.filter((n) => typeof n === "string") : [],
      initialized: typeof parsed.initialized === "string" ? parsed.initialized : isoDate(),
    };
  } catch {
    return null;
  }
}

async function writeCounter(
  projectCwd: string,
  counter: TaskCounter
): Promise<void> {
  await ensureTasksDir(projectCwd);
  await fsp.writeFile(
    path.join(tasksDirFor(projectCwd), COUNTER_FILE),
    `${JSON.stringify(counter, null, 2)}\n`,
    "utf8"
  );
}

/**
 * Load the counter, creating it on first use. On creation every task file
 * already on disk is recorded as legacy, so a project's first *new* task is
 * #0001 and nothing already finished gets retroactively numbered.
 */
async function ensureCounter(projectCwd: string): Promise<TaskCounter> {
  const existing = await readCounter(projectCwd);
  if (existing) return existing;
  const counter: TaskCounter = {
    next: 1,
    legacy: await taskFilenames(projectCwd),
    initialized: isoDate(),
  };
  await writeCounter(projectCwd, counter);
  return counter;
}

/**
 * Splice a `num:` line into existing frontmatter without touching anything
 * else. Agents hand-write these files, so a surgical insert beats a full
 * rewrite that would drop any extra keys they added.
 */
function insertNumIntoFrontmatter(raw: string, num: number): string | null {
  const m = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return null;
  const existing = m[2].match(/^num\s*:\s*(.*)$/m);
  if (existing) {
    const value = existing[1].trim();
    // An explicit `num: null` is a placeholder we're allowed to fill in.
    if (value !== "" && value !== "null" && value !== "~") return null;
    const body = m[2].replace(/^num\s*:.*$/m, `num: ${num}`);
    return `${m[1]}${body}${m[3]}${raw.slice(m[0].length)}`;
  }
  return `${m[1]}num: ${num}\n${m[2]}${m[3]}${raw.slice(m[0].length)}`;
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
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // A title with no letters or digits ("---") must not become `-.md`.
  return base.slice(0, 60).replace(/-$/, "") || "task";
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
    num: task.num === null ? null : String(task.num),
    id: task.id,
    title: task.title,
    assignee: task.assignee,
    status: task.status,
    priority: task.priority,
    due: task.due,
    created: task.created,
    updated: task.updated,
    completed: task.completed,
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

function normalizeNum(n: string | null | undefined): number | null {
  if (!n) return null;
  const parsed = Number.parseInt(n, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseTaskFile(content: string, fallbackId: string): Task {
  const { meta, body } = splitFrontmatter(content);
  const created = meta.created ?? isoDate();
  const status = normalizeStatus(meta.status);
  return {
    id: meta.id ?? fallbackId,
    num: normalizeNum(meta.num),
    title: meta.title ?? "(untitled)",
    description: body.trim(),
    assignee: meta.assignee ?? null,
    status,
    priority: normalizePriority(meta.priority),
    due: normalizeDue(meta.due),
    created,
    updated: meta.updated ?? created,
    // Tasks an agent marked done by hand won't carry a completion stamp;
    // fall back to last-touched so date sorting still behaves.
    completed: meta.completed ?? (status === "done" ? meta.updated ?? created : null),
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

/**
 * Give a number to any task file that doesn't have one yet, skipping the
 * legacy set. Runs on every list so tasks written straight to disk by an
 * agent pick up a number the first time the board is read.
 */
async function assignMissingNumbers(
  projectCwd: string,
  pending: { name: string; full: string; task: Task }[]
): Promise<void> {
  if (pending.length === 0) return;
  await withCounterLock(projectCwd, async () => {
    const counter = await ensureCounter(projectCwd);
    const legacy = new Set(counter.legacy);
    // Oldest first, so numbers run in the order the work was created.
    const queue = pending
      .filter((p) => !legacy.has(p.name))
      .sort((a, b) => a.task.created.localeCompare(b.task.created));
    let changed = false;
    for (const item of queue) {
      try {
        // Re-read: the file may have changed since the caller parsed it.
        const raw = await fsp.readFile(item.full, "utf8");
        const patched = insertNumIntoFrontmatter(raw, counter.next);
        if (!patched) continue;
        await fsp.writeFile(item.full, patched, "utf8");
        item.task.num = counter.next;
        counter.next += 1;
        changed = true;
      } catch {
        /* skip unwritable */
      }
    }
    if (changed) await writeCounter(projectCwd, counter);
  });
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
  const lookup = await assigneeLookup();
  const tasks: Task[] = [];
  const unnumbered: { name: string; full: string; task: Task }[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    try {
      const raw = await fsp.readFile(full, "utf8");
      const task = parseTaskFile(raw, name.replace(/\.md$/, ""));
      task.assignee = canonicalAssignee(task.assignee, lookup);
      tasks.push(task);
      if (task.num === null) unnumbered.push({ name, full, task });
    } catch {
      /* skip unreadable */
    }
  }
  await assignMissingNumbers(cwd, unnumbered);
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
    const task = parseTaskFile(raw, id);
    task.assignee = canonicalAssignee(task.assignee, await assigneeLookup());
    return task;
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
  const num = await withCounterLock(cwd, async () => {
    const counter = await ensureCounter(cwd);
    const assigned = counter.next;
    counter.next += 1;
    await writeCounter(cwd, counter);
    return assigned;
  });
  const status = normalizeStatus(input.status);
  const lookup = await assigneeLookup();
  const task: Task = {
    id,
    num,
    title: input.title.trim() || "(untitled)",
    description: (input.description ?? "").trim(),
    assignee: canonicalAssignee(input.assignee ?? null, lookup),
    status,
    priority: normalizePriority(input.priority),
    due: normalizeDue(input.due ?? null),
    created: now,
    updated: now,
    completed: status === "done" ? now : null,
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
  const nextStatus =
    input.status !== undefined ? normalizeStatus(input.status) : existing.status;
  const now = isoDate();
  // Stamp a completion time on the transition into done; clear it on the way out.
  let completed = existing.completed;
  if (nextStatus === "done" && existing.status !== "done") completed = now;
  else if (nextStatus !== "done") completed = null;
  const next: Task = {
    ...existing,
    title:
      input.title !== undefined ? input.title.trim() || existing.title : existing.title,
    description:
      input.description !== undefined
        ? input.description.trim()
        : existing.description,
    assignee: canonicalAssignee(
      input.assignee !== undefined ? input.assignee : existing.assignee,
      await assigneeLookup()
    ),
    status: nextStatus,
    priority:
      input.priority !== undefined
        ? normalizePriority(input.priority)
        : existing.priority,
    due:
      input.due !== undefined ? normalizeDue(input.due) : existing.due,
    updated: now,
    completed,
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
