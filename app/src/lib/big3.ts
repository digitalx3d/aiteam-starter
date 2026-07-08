import path from "node:path";
import { promises as fsp } from "node:fs";
import { resolveExistingProjectCwd } from "@/lib/projects";

export const BIG3_SLOT_COUNT = 3;

export interface Big3Item {
  text: string;
  done: boolean;
}

export interface Big3CompletedItem {
  text: string;
  /** ISO date string, e.g. "2026-05-27" */
  completedAt: string;
}

export interface Big3Data {
  active: Big3Item[];
  completed: Big3CompletedItem[];
}

const TASK_LINE = /^\s*-\s+\[([ xX])\]\s+(.+?)\s*$/;
const COMPLETED_LINE = /^\s*-\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)\s*$/;

export function parseBig3(md: string): Big3Data {
  const active: Big3Item[] = [];
  const completed: Big3CompletedItem[] = [];
  if (!md) return { active, completed };
  for (const line of md.split("\n")) {
    const t = line.match(TASK_LINE);
    if (t) {
      active.push({
        done: t[1].toLowerCase() === "x",
        text: t[2].trim(),
      });
      continue;
    }
    const c = line.match(COMPLETED_LINE);
    if (c) {
      completed.push({
        completedAt: c[1],
        text: c[2].trim(),
      });
    }
  }
  return { active, completed };
}

export function serializeBig3(data: Big3Data): string {
  let out =
    "# Big 3\n\n" +
    "Top-of-mind for this project (up to 3). Editable from the project page in the aiTeam dashboard. Items here are reminders / ideas — promote to a real task in `.aiteam/tasks/` when ready.\n\n";

  const activeLines = data.active
    .filter((it) => it.text.trim().length > 0)
    .map((it) => `- [${it.done ? "x" : " "}] ${it.text.trim()}`);
  if (activeLines.length > 0) {
    out += activeLines.join("\n") + "\n";
  }

  const validCompleted = data.completed.filter(
    (c) =>
      c.text.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(c.completedAt)
  );
  if (validCompleted.length > 0) {
    const sorted = [...validCompleted].sort((a, b) =>
      b.completedAt.localeCompare(a.completedAt)
    );
    out += "\n## Recently completed\n\n";
    out +=
      sorted.map((c) => `- ${c.completedAt} · ${c.text.trim()}`).join("\n") +
      "\n";
  }

  return out;
}

/** Resolve the on-disk path for a project's big3.md. Null if the slug doesn't resolve. */
export async function big3PathFor(slug: string): Promise<string | null> {
  const cwd = await resolveExistingProjectCwd(slug);
  if (!cwd) return null;
  return path.join(cwd, ".aiteam", "big3.md");
}

/**
 * Read just the active (incomplete) Big-3 items for a project by its root path.
 * Used by the dashboard, which already has the project's filesystem path and
 * shouldn't round-trip through slug resolution.
 */
export async function readBig3ActiveByRoot(
  projectRoot: string
): Promise<Big3Item[]> {
  const filePath = path.join(projectRoot, ".aiteam", "big3.md");
  let raw = "";
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parseBig3(raw).active.filter(
    (it) => !it.done && it.text.trim().length > 0
  );
}

/** mtime (ms) of a project's big3.md, or 0 if it doesn't exist. */
export async function big3MtimeByRoot(projectRoot: string): Promise<number> {
  try {
    const s = await fsp.stat(path.join(projectRoot, ".aiteam", "big3.md"));
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

export async function readBig3(slug: string): Promise<Big3Data | null> {
  const filePath = await big3PathFor(slug);
  if (!filePath) return null;
  let raw = "";
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    /* file missing — return empty data, not null (slug is valid) */
  }
  return parseBig3(raw);
}

export async function writeBig3(
  slug: string,
  data: Big3Data
): Promise<boolean> {
  const filePath = await big3PathFor(slug);
  if (!filePath) return false;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, serializeBig3(data), "utf8");
  return true;
}
